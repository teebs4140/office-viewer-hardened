import * as vscode from 'vscode';
import { basename, join, parse } from 'path';
import { Handler } from "@/common/handler";
import { isUriReadOnly } from '@/common/fileReadOnly';
import { Uri, workspace } from 'vscode';
import { emitFileOfficeOpen, emitVirtualOfficeOpen, isVirtualUri } from '@/provider/handlers/officeContent';
import { VIEW_TYPE } from '@/common/constants';

const fileSaveTimes: Record<string, number> = {};
const INTERNAL_SAVE_CHANGE_WINDOW_MS = 1500;

export function shouldSkipFileChange(uri: Uri): boolean {
    const lastSaveTime = fileSaveTimes[uri.toString()];
    return !!(lastSaveTime && Date.now() - lastSaveTime < INTERNAL_SAVE_CHANGE_WINDOW_MS);
}

function setDirty(handler: Handler, uri: Uri, dirty: boolean) {
    const panel = handler.panel;
    const fileName = basename(uri.fsPath);
    panel.title = dirty ? `${fileName}*` : fileName;
    if (dirty) {
        void vscode.commands.executeCommand('workbench.action.keepEditor');
    }
}

export function handleCommonEvent(uri: Uri, handler: Handler) {
    let readOnly = false;
    const send = async () => {
        if (shouldSkipFileChange(uri)) {
            return;
        }
        readOnly = await isUriReadOnly(uri);
        if (isVirtualUri(uri)) {
            void emitVirtualOfficeOpen(handler, uri);
            return;
        }
        await emitFileOfficeOpen(handler, uri, handler.panel.webview);
    }
    const events = handler
        .on("editInVSCode", (full: boolean) => {
            const side = full ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
            vscode.commands.executeCommand('vscode.openWith', uri, "default", side);
        })
    events.on("init", () => { void send(); }).on("fileChange", () => { void send(); })
    events
        .on("change", () => {
            setDirty(handler, uri, true);
        })
        .on("save", async (content) => {
            const res = Array.isArray(content) ? new Uint8Array(content) : new TextEncoder().encode(content)
            if (readOnly) {
                handler.emit('saveAs', { content: [...res] });
                return;
            }
            fileSaveTimes[uri.toString()] = Date.now();
            await workspace.fs.writeFile(uri, res)
            fileSaveTimes[uri.toString()] = Date.now();
            setDirty(handler, uri, false);
            handler.emit("saveDone")
        })
        .on("saveAs", async (payload: { content: number[], ext?: string }) => {
            const res = new Uint8Array(payload.content);
            const ext = (payload.ext ?? 'xlsx').toLowerCase();
            const { dir, name } = parse(uri.fsPath);
            const defaultFileName = `${name}.${ext}`;
            const defaultUri = uri.scheme === 'file'
                ? Uri.file(join(dir, defaultFileName))
                : Uri.joinPath(uri, '..', defaultFileName);
            const filterMap: Record<string, { label: string; exts: string[] }> = {
                xlsx: { label: 'Excel Workbook', exts: ['xlsx'] },
                xlsm: { label: 'Excel Macro-Enabled Workbook', exts: ['xlsm'] },
                csv: { label: 'CSV (Comma delimited)', exts: ['csv'] },
                docx: { label: 'Word Document', exts: ['docx'] },
                dotx: { label: 'Word Template', exts: ['dotx'] },
            };
            const info = filterMap[ext] ?? { label: ext.toUpperCase(), exts: [ext] };
            const target = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { [info.label]: info.exts },
            });
            if (!target) return;
            fileSaveTimes[target.toString()] = Date.now();
            await workspace.fs.writeFile(target, res);
            fileSaveTimes[target.toString()] = Date.now();
            setDirty(handler, uri, false);
            handler.emit("saveDone");
            await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
        })
        .on('developerTool', () => vscode.commands.executeCommand('workbench.action.toggleDevTools'))
        .on('openExternal', (url: string) => {
            if (url) {
                vscode.env.openExternal(vscode.Uri.parse(url));
            }
        })
        .on('dispose', () => {
            delete fileSaveTimes[uri.toString()];
        })
}
