import { basename, extname } from 'path';
import { Uri, window, workspace, type Webview } from 'vscode';
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
    const data = await workspace.fs.readFile(uri);
    checkBinarySignature(uri, data);
    return data;
}

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04": xlsx, xlsm, docx, dotx
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

function startsWith(data: Uint8Array, signature: number[], offset = 0): boolean {
    return data.length >= offset + signature.length && signature.every((byte, i) => data[offset + i] === byte);
}

/** pdf.js accepts a PDF header anywhere in the first 1024 bytes, so allow the same here. */
function hasPdfHeader(data: Uint8Array): boolean {
    const limit = Math.min(1024, data.length - PDF_SIGNATURE.length);
    for (let offset = 0; offset <= limit; offset++) {
        if (startsWith(data, PDF_SIGNATURE, offset)) return true;
    }
    return false;
}

/**
 * VS Code's git file system provider reads history with `git show --textconv`, so a repository
 * with a text-conversion driver for these formats hands back converted text instead of the file.
 * Report that plainly rather than letting the viewer fail on unparseable bytes.
 */
function checkBinarySignature(uri: Uri, data: Uint8Array): void {
    const ext = extname(uri.path).toLowerCase();
    const ok = ext === '.pdf' ? hasPdfHeader(data)
        : ['.xlsx', '.xlsm', '.docx', '.dotx'].includes(ext) ? startsWith(data, ZIP_SIGNATURE)
            : true;
    if (!ok) {
        throw new Error(`This ${uri.scheme}: version of ${basename(uri.path)} did not arrive as a ${ext} file `
            + '(a git text-conversion driver may have converted it). Open the file from disk instead.');
    }
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
        const message = error instanceof Error ? error.message : 'Failed to read file';
        void window.showErrorMessage(`Office Viewer (Hardened): ${message}`);
        handler.emit('open', {
            ext,
            path: getPayloadPath(uri),
            fileName: basename(uri.fsPath),
            scheme: uri.scheme,
            documentCacheId: buildDocumentCacheId(uri),
            readOnly: READ_ONLY,
            error: message,
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
