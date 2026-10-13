import * as vscode from 'vscode';
import { Handler } from "@/common/handler";
import { Output } from '@/common/Output';
import { EXTERNAL_LINK_SCHEMES } from '@/common/constants';
import { Uri } from 'vscode';
import { emitFileOfficeOpen, emitVirtualOfficeOpen, isVirtualUri } from '@/provider/handlers/officeContent';

/**
 * Host side of the viewer bridge. The fork is a read-only viewer: there are no save,
 * saveAs, change or developerTool handlers, and nothing here writes to the file system.
 * Which of these events a page may actually send is decided by the allowlist passed
 * to Handler.bind.
 */
export function handleCommonEvent(uri: Uri, handler: Handler) {
    const send = async () => {
        if (isVirtualUri(uri)) {
            await emitVirtualOfficeOpen(handler, uri);
            return;
        }
        await emitFileOfficeOpen(handler, uri, handler.panel.webview);
    }
    handler
        .on("init", () => { void send(); })
        .on("fileChange", () => { void send(); })
        .on("editInVSCode", (full: unknown) => {
            const side = full === true ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
            void vscode.commands.executeCommand('vscode.openWith', uri, "default", side);
        })
        .on('openExternal', (url: unknown) => {
            const target = parseExternalLink(url);
            if (target) {
                void vscode.env.openExternal(target);
            }
        })
}

/** Returns a URI only for http:, https: and mailto: links; anything else is logged and dropped. */
function parseExternalLink(url: unknown): Uri | undefined {
    if (typeof url !== 'string' || url.length === 0 || url.length > 8192) {
        Output.debug('Rejected openExternal request: link is not a non-empty string');
        return undefined;
    }
    let parsed: Uri;
    try {
        parsed = Uri.parse(url, true);
    } catch {
        Output.debug('Rejected openExternal request: link is not a valid URI');
        return undefined;
    }
    const scheme = parsed.scheme.toLowerCase();
    if (!EXTERNAL_LINK_SCHEMES.has(scheme)) {
        Output.debug(`Rejected openExternal request for scheme ${JSON.stringify(scheme.slice(0, 32))}`);
        return undefined;
    }
    return parsed;
}
