import * as vscode from 'vscode';
import { extensionResource, getExtensionUri, readExtensionText } from './extensionResource';

interface ViewOption {
    route: string;
}

export class ReactApp {

    private static context: vscode.ExtensionContext;
    private static webviewUri: vscode.Uri;

    public static init(context: vscode.ExtensionContext) {
        this.context = context;
        this.webviewUri = extensionResource(context, 'out', 'webview');
    }

    public static async view(webview: vscode.Webview, option: ViewOption) {
        const html = await readExtensionText(this.context, 'out', 'webview', 'index.html');
        const configs = ReactApp.serializeConfigs({
            ...option,
            language: vscode.env.language,
        });
        // Function replacers: string replacements would interpret `$&`, `$1`, ... in the inserted text.
        webview.html = this.buildPath(html, webview)
            .split('{{cspSource}}').join(webview.cspSource)
            .replace('{{configs}}', () => configs);
    }

    /**
     * The configs land inside <script type="application/json">, which the CSP never executes.
     * Escaping `<` (and the JS line separators) keeps the JSON from closing the script element.
     */
    private static serializeConfigs(configs: object): string {
        return JSON.stringify(configs)
            .replace(/</g, '\\u003c')
            .replace(/>/g, '\\u003e')
            .replace(/&/g, '\\u0026')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    }

    private static buildPath(data: string, webview: vscode.Webview): string {
        const baseUrl = webview.asWebviewUri(this.webviewUri).toString();
        return data.replace('<base href="/">', () => `<base href="${baseUrl}/">`);
    }

    public static getExtensionUri(): vscode.Uri {
        return getExtensionUri(this.context);
    }

}
