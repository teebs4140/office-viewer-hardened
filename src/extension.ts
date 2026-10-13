import * as vscode from 'vscode';
import { OfficeViewerProvider } from './provider/officeViewerProvider';
import { ReactApp } from './common/reactApp';

export function activate(context: vscode.ExtensionContext) {
	ReactApp.init(context);
	const viewOption = { webviewOptions: { retainContextWhenHidden: true } };
	const viewerInstance = new OfficeViewerProvider(context);
	context.subscriptions.push(viewerInstance.bindCustomEditor(viewOption));
}

export function deactivate() { }
