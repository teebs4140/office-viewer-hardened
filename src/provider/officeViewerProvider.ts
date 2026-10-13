import { ReactApp } from '@/common/reactApp';
import { getFileSuffix } from '@/common/fileSuffix';
import * as vscode from 'vscode';
import { Handler } from '../common/handler';
import { VIEW_TYPE } from '../common/constants';
import { handleCommonEvent } from './handlers/commonHandler';
import { extensionResource, getExtensionResourceRoots, readExtensionText } from '@/common/extensionResource';

/**
 * Custom editor for CSV/TSV, Excel (.xlsx/.xlsm), Word (.docx/.dotx) and PDF files.
 */
export class OfficeViewerProvider implements vscode.CustomReadonlyEditorProvider {

	constructor(private context: vscode.ExtensionContext) { }

	bindCustomEditor(viewOption: { webviewOptions: vscode.WebviewPanelOptions }) {
		return vscode.window.registerCustomEditorProvider(VIEW_TYPE, this, viewOption);
	}

	public openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext, token: vscode.CancellationToken): vscode.CustomDocument | Thenable<vscode.CustomDocument> {
		return { uri, dispose: (): void => { } };
	}

	public resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): void | Thenable<void> {
		const uri = document.uri;
		const webview = webviewPanel.webview;
		const folderPath = vscode.Uri.joinPath(uri, '..');
		webview.options = {
			enableScripts: true,
			localResourceRoots: [...getExtensionResourceRoots(this.context), folderPath],
		};

		let route: string | undefined;
		const suffix = getFileSuffix(uri.fsPath);
		switch (suffix) {
			case '.xlsx':
			case '.xlsm':
			case '.csv':
			case '.tsv':
				route = 'excel';
				break;
			case '.docx':
			case '.dotx':
				route = 'word';
				break;
			case '.pdf':
				break;
			default: {
				const message = `Office Viewer (Hardened) does not support "${suffix || 'this'}" files.`;
				webview.options = { enableScripts: false, localResourceRoots: [] };
				webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';"></head><body><p>${escapeHtml(message)}</p></body></html>`;
				void vscode.window.showErrorMessage(message);
				return;
			}
		}

		const handler = Handler.bind(webviewPanel, uri);
		handleCommonEvent(uri, handler);
		if (route) {
			return ReactApp.view(webview, { route });
		}
		return this.loadPdfViewer(webview);
	}

	private async loadPdfViewer(webview: vscode.Webview) {
		const html = await readExtensionText(this.context, 'resource', 'pdf', 'viewer.html');
		webview.html = html.replace('{{baseUrl}}', this.getBaseUrl(webview, 'pdf'));
	}

	private getBaseUrl(webview: vscode.Webview, path: string) {
		const baseUrl = webview.asWebviewUri(extensionResource(this.context, 'resource', path))
			.toString().replace(/\?.+$/, '').replace('https://git', 'https://file');
		return baseUrl;
	}

}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}
