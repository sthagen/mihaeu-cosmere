import * as fs from "fs";
import ConfluenceRenderer from "./ConfluenceRenderer";
import * as path from "path";
import { Config } from "./types/Config";
import { Page } from "./types/Page";
import { ConfluenceAPI } from "./api/ConfluenceAPI";
import signale from "signale";
import { Picture } from "./Picture";
import marked = require("marked");
import { Attachment } from "./api/Attachment";

type ConfluencePage = {
    title: string;
    body: {
        storage: {
            value: string;
            representation: "storage";
        };
    };
    version: {
        number: string;
    };
};

function mkdir(cachePath: string) {
    if (process.version.match(/^v\d\d\./)) {
        fs.mkdirSync(cachePath, { recursive: true });
    } else {
        if (fs.existsSync(path.dirname(cachePath))) {
            fs.mkdirSync(fs.existsSync(path.dirname(cachePath)) ? cachePath : path.dirname(cachePath));
        } else {
            mkdir(path.dirname(cachePath));
            fs.mkdirSync(cachePath);
        }
    }
}

function getCachePath(config: Config) {
    return path.isAbsolute(config.cachePath)
        ? config.cachePath
        : path.resolve(path.dirname(config.configPath!) + "/" + config.cachePath);
}

function removeDynamicIds(s: string): string {
    return s.replace(/ (ac:macro-)?id="[^"]+"/g, "");
}

function isRemoteUpdateRequired(newContent: string, confluencePage: any): boolean {
    const local = removeDynamicIds(newContent)
        .trim()
        .replace(/&#39;/g, "'");
    const remote = removeDynamicIds(confluencePage.body.storage.value).trim();
    return local !== remote;
}

function extractAttachmentsFromPage(pageData: Page, newContent: string): Picture[] {
    return (newContent.match(/<ri:attachment ri:filename="(.+?)" *\/>/g) || [])
        .map((attachment: string) => attachment.replace(/.*"(.+)".*/, "$1"))
        .filter((attachment: string) => !attachment.startsWith("http"))
        .filter((attachment: string) => {
            if (!fs.existsSync(path.resolve(path.dirname(pageData.file), attachment))) {
                signale.error(`Attachment "${attachment}" not found.`);
                return false;
            }
            return true;
        })
        .map(attachment => {
            const originalAbsolutePath = path.resolve(path.dirname(pageData.file), attachment);
            return {
                originalPath: attachment,
                originalAbsolutePath,
                originalSize: fs.statSync(originalAbsolutePath).size,
                remoteFileName: attachment.replace(/(\.\.|\/)/g, "_"),
            };
        });
}

function extractTitle(fileData: string) {
    const h1MarkdownRegex = /^# ?(?<title>[^\n\r]+)/;
    const matches = fileData.match(h1MarkdownRegex);
    if (!matches || !matches.groups) {
        throw new Error("Missing title property in config and no title found in markdown.");
    }
    return [matches.groups.title, fileData.replace(h1MarkdownRegex, "")];
}

function convertToWikiFormat(pageData: Page) {
    let fileData = fs.readFileSync(pageData.file, { encoding: "utf8" }).replace(/\|[ ]*\|/g, "|&nbsp;|");
    if (!pageData.title) {
        [pageData.title, fileData] = extractTitle(fileData);
    }

    return marked(fileData, {
        renderer: new ConfluenceRenderer(),
        xhtml: true,
    });
}

function mapLocalToRemoteAttachments(attachment: Picture, remoteAttachments: Attachment[]) {
    const remoteAttachment = remoteAttachments.find(
        remoteAttachment =>
            remoteAttachment.title === attachment.remoteFileName &&
            remoteAttachment.extensions.fileSize === attachment.originalSize,
    );
    if (remoteAttachment) {
        attachment.remoteAttachmentId = remoteAttachment.id;
    }
    return attachment;
}

async function updateAttachments(mdWikiData: string, pageData: Page, cachePath: string, confluenceAPI: ConfluenceAPI) {
    const remoteAttachments = (await confluenceAPI.getAttachments(pageData.pageId)).results;
    let attachments = extractAttachmentsFromPage(pageData, mdWikiData).map(attachment =>
        mapLocalToRemoteAttachments(attachment, remoteAttachments),
    );
    if (!attachments) {
        return mdWikiData;
    }

    const upToDateAttachmentIds = attachments.map(attachment => attachment.remoteAttachmentId);
    const outOfDateAttachments = remoteAttachments.filter(
        remoteAttachment => !upToDateAttachmentIds.includes(remoteAttachment.id),
    );
    for (const outOfDateAttachment of outOfDateAttachments) {
        await confluenceAPI.deleteAttachment(outOfDateAttachment);
    }
    for (const attachment of attachments.filter(attachment => !attachment.remoteAttachmentId)) {
        fs.copyFileSync(attachment.originalAbsolutePath, attachment.remoteFileName);

        signale.await(`Uploading attachment "${attachment.remoteFileName}" for "${pageData.title}" ...`);
        await confluenceAPI.uploadAttachment(attachment.remoteFileName, pageData.pageId);
    }
    mdWikiData = mdWikiData.replace(/<ri:attachment ri:filename=".+?"/g, (s: string) => s.replace(/(\.\.|\/)/g, "_"));
    return mdWikiData;
}

function increaseVersionNumber(versionNumber: string) {
    return (parseInt(versionNumber, 10) + 1).toString();
}

async function sendChangedPage(
    confluencePage: ConfluencePage,
    pageData: Page,
    mdWikiData: string | void | any,
    confluenceAPI: ConfluenceAPI,
) {
    confluencePage.title = pageData.title ?? confluencePage.title;
    confluencePage.body = {
        storage: {
            value: mdWikiData,
            representation: "storage",
        },
    };
    confluencePage.version.number = increaseVersionNumber(confluencePage.version.number);
    signale.await(`Update page "${pageData.title}" ...`);
    await confluenceAPI.updateConfluencePage(pageData.pageId, confluencePage);
}

function addPrefix(config: Config, mdWikiData: string) {
    return config.prefix
        ? `<ac:structured-macro ac:name="info" ac:schema-version="1"><ac:rich-text-body>
<p>${config.prefix}</p>
</ac:rich-text-body></ac:structured-macro>

${mdWikiData}`
        : mdWikiData;
}

export async function updatePage(confluenceAPI: ConfluenceAPI, pageData: Page, config: Config, force: boolean) {
    signale.start(`Starting to render "${pageData.file}"`);
    let mdWikiData = convertToWikiFormat(pageData);
    mdWikiData = addPrefix(config, mdWikiData);

    const cachePath = getCachePath(config);
    if (!fs.existsSync(cachePath)) {
        mkdir(cachePath);
    }
    const tempFile = `${cachePath}/${pageData.pageId}`;

    let needsContentUpdate = true;
    if (fs.existsSync(tempFile)) {
        const fileContent = fs.readFileSync(tempFile, "utf-8");

        if (fileContent === mdWikiData) {
            needsContentUpdate = false;
        }
    }

    if (!force && !needsContentUpdate) {
        signale.success(`Local cache for "${pageData.file}" is up to date, no update necessary`);
        return;
    }

    mdWikiData = await updateAttachments(mdWikiData, pageData, cachePath, confluenceAPI);
    signale.await(`Fetch current page for "${pageData.title}" ...`);
    const confluencePage = (await confluenceAPI.currentPage(pageData.pageId)).data;
    if (!force && !isRemoteUpdateRequired(mdWikiData, confluencePage)) {
        signale.success(`No change in remote version for "${pageData.file}" detected, no update necessary`);
        return;
    }

    await sendChangedPage(confluencePage, pageData, mdWikiData, confluenceAPI);

    fs.writeFileSync(tempFile, mdWikiData, "utf-8");
    const confluenceUrl = config.baseUrl.replace("rest/api", "").replace(/\/$/, "");
    signale.success(
        `"${confluencePage.title}" saved in confluence (${confluenceUrl}/pages/viewpage.action?pageId=${pageData.pageId}).`,
    );
}
