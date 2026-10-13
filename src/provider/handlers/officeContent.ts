import { basename, extname } from 'path';
import { Uri, workspace, type Webview } from 'vscode';
import { Handler } from '@/common/handler';

/** The fork is a read-only viewer, so every document is opened read-only in the webview. */
const READ_ONLY = true;

export function isVirtualUri(uri: Uri): boolean {
    return uri.scheme !== 'file';
}

function getPayloadPath(uri: Uri): string {
    return uri.toString();
}

/** Same key as markdown documentCacheId; used as the webview localStorage key prefix */
export function buildDocumentCacheId(uri: Uri): string {
    return `${uri.scheme}:${uri.toString()}`;
}

/**
 * Virtual URIs (git:, vscode-vfs:, ...) are read only through the VS Code file system API;
 * the host never starts a child process to read them.
 */
export async function readUriBytes(uri: Uri): Promise<Uint8Array> {
    return workspace.fs.readFile(uri);
}

export function bytesToPayloadBuffer(data: Uint8Array): number[] {
    const buffer: number[] = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
        buffer[i] = data[i];
    }
    return buffer;
}

export async function emitVirtualOfficeOpen(handler: Handler, uri: Uri): Promise<void> {
    const now = Date.now();
    const ext = extname(uri.fsPath);
    try {
        const data = await readUriBytes(uri);
        const payload: Record<string, unknown> = {
            ext,
            path: getPayloadPath(uri),
            fileName: basename(uri.fsPath),
            scheme: uri.scheme,
            documentCacheId: buildDocumentCacheId(uri),
            readOnly: READ_ONLY,
            nonce: now,
        };
        payload.buffer = bytesToPayloadBuffer(data);
        handler.emit('open', payload);
    } catch (error) {
        handler.emit('open', {
            ext,
            path: getPayloadPath(uri),
            fileName: basename(uri.fsPath),
            scheme: uri.scheme,
            documentCacheId: buildDocumentCacheId(uri),
            readOnly: READ_ONLY,
            error: error instanceof Error ? error.message : 'Failed to read file',
            nonce: now,
        });
    }
}

export async function emitFileOfficeOpen(handler: Handler, uri: Uri, webview: Webview): Promise<void> {
    handler.emit('open', {
        ext: extname(uri.fsPath),
        path: webview.asWebviewUri(uri).toString(),
        fileName: basename(uri.fsPath),
        documentCacheId: buildDocumentCacheId(uri),
        readOnly: READ_ONLY,
    });
}
