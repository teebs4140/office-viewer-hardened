import * as vscode from 'vscode';
import { SimpleEventEmitter } from "./simpleEventEmitter";
import { WebviewPanel } from "vscode";
import { Output } from "./Output";

export class Handler {

    private isEnd: boolean;
    constructor(public panel: WebviewPanel, private eventEmitter: SimpleEventEmitter) { }

    on(event: string, callback: (content: any) => any | Promise<any>): this {
        if (event != 'init') {
            const listens = this.eventEmitter.listeners(event)
            if (listens.length >= 1) {
                this.eventEmitter.removeListener(event, listens[0])
            }
        }
        this.eventEmitter.on(event, async (content: any) => {
            try {
                await callback(content)
            } catch (error) {
                Output.debug(error)
                vscode.window.showErrorMessage(error.message)
            }
        })
        return this;
    }

    emit(event: string, content?: any) {
        if (this.isEnd) return this;
        this.panel.webview.postMessage({ type: event, content })
        return this;
    }

    /**
     * Binds a webview panel to a host-side event emitter.
     * Only message types in `allowedTypes` are forwarded from the webview; host-internal
     * events (fileChange, dispose) are emitted by the host alone and can never be triggered
     * by the page.
     */
    public static bind(panel: WebviewPanel, uri: vscode.Uri, allowedTypes: ReadonlySet<string>): Handler {
        const eventEmitter = new SimpleEventEmitter();

        const fileWatcher = Handler.createFileWatcher(uri);
        fileWatcher?.onDidChange(() => {
            eventEmitter.emit("fileChange")
        })

        const handle = new Handler(panel, eventEmitter)
        panel.onDidDispose(() => {
            handle.isEnd = true;
            fileWatcher?.dispose()
            eventEmitter.emit("dispose")
        });

        // bind from webview: explicit allowlist only
        const loggedRejections = new Set<string>();
        panel.webview.onDidReceiveMessage((message: unknown) => {
            const type = (message && typeof message === 'object') ? (message as { type?: unknown }).type : undefined;
            if (typeof type !== 'string' || !allowedTypes.has(type)) {
                const label = typeof type === 'string' ? JSON.stringify(type.slice(0, 64)) : typeof type;
                if (!loggedRejections.has(label) && loggedRejections.size < 32) {
                    loggedRejections.add(label);
                    Output.debug(`Ignored webview message of type ${label}`)
                }
                return;
            }
            eventEmitter.emit(type, (message as { content?: unknown }).content)
        })
        return handle;
    }

    private static createFileWatcher(uri: vscode.Uri): vscode.FileSystemWatcher | undefined {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (folder) {
            const relativePath = vscode.workspace.asRelativePath(uri, false);
            return vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(folder, relativePath)
            );
        }
        if (uri.scheme === 'file') {
            return vscode.workspace.createFileSystemWatcher(uri.fsPath);
        }
        return undefined;
    }

}
