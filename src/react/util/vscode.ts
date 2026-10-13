const vscode = window['acquireVsCodeApi']?.();
export { vscode as vscodeApi };
const postMessage = (message) => { if (vscode) { vscode.postMessage(message) } }

const DARK_MODE_KEY = 'office-dark-mode';

export function loadDarkMode(): boolean {
    const state = vscode?.getState?.() as { darkMode?: boolean } | undefined;
    if (state?.darkMode !== undefined) {
        return state.darkMode;
    }
    try {
        return localStorage.getItem(DARK_MODE_KEY) === '1';
    } catch {
        return false;
    }
}

export function saveDarkMode(dark: boolean) {
    try {
        localStorage.setItem(DARK_MODE_KEY, dark ? '1' : '0');
    } catch { }
    if (vscode?.setState) {
        const prev = (vscode.getState?.() ?? {}) as Record<string, unknown>;
        vscode.setState({ ...prev, darkMode: dark });
    }
}

export function applyDarkMode(dark: boolean) {
    document.body.classList.toggle('office-dark', dark);
    saveDarkMode(dark);
}

const events = {}
function receive({ data }) {
    if (!data)
        return;
    if (events[data.type]) {
        events[data.type](data.content);
    }
}
window.addEventListener('message', receive)
const isMac = navigator.userAgent.includes('Mac OS');
window.addEventListener('keydown', e => {
    if (isMac && isCompose(e) && (e.altKey || e.code == 'KeyW')) {
        e.preventDefault()
    }
}, isMac ? true : undefined)

const getVscodeEvent = () => {
    return {
        on(event: string, data) {
            events[event] = data
            return this;
        },
        emit(event: string, data?: any) {
            postMessage({ type: event, content: data })
        }
    }
}
export const handler = getVscodeEvent();

export function isCompose(e) {
    return e.metaKey || e.ctrlKey;
}

window.addEventListener('keydown', e => {
    if ((isCompose(e) && e.code == 'KeyV')) e.preventDefault()  // vscode的bug, hebrew(希伯来语)键盘会粘贴两次
})

const EXTERNAL_LINK_PATTERN = /^(https?:\/\/|mailto:)/i;

/**
 * Returns the trimmed link when it may leave the webview (http, https, mailto), otherwise null.
 * Links come from document content (xlsx/docx hyperlinks), so javascript:, data:, file:,
 * vscode:, command: and anything else are refused here; the host checks the scheme again.
 */
export function toSafeExternalLink(link: unknown): string | null {
    if (typeof link !== 'string') return null;
    const trimmed = link.trim();
    if (!EXTERNAL_LINK_PATTERN.test(trimmed)) return null;
    return trimmed;
}

/** The only way the webview opens a document link: ask the host, which opens it outside VS Code. */
export function openExternalLink(link: unknown): boolean {
    const safe = toSafeExternalLink(link);
    if (!safe) {
        console.warn('Blocked link with unsupported scheme');
        return false;
    }
    handler.emit('openExternal', safe);
    return true;
}

// Document links must never navigate the webview or reach VS Code's own link handler
// (which also accepts vscode: and other URIs): window.open is replaced, and clicks on
// <a href> are intercepted in the capture phase before any other listener sees them.
window.open = ((url?: string | URL) => {
    const link = url instanceof URL ? url.href : url;
    if (link) openExternalLink(link);
    return null;
}) as typeof window.open;

function interceptLinkClick(e: MouseEvent) {
    if (e.type === 'auxclick' && e.button !== 1) return;
    for (const node of e.composedPath()) {
        if (!(node instanceof Element)) continue;
        if (node.localName !== 'a') continue;
        const href = node.getAttribute('href') ?? node.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        if (href === null) continue;
        if (href.startsWith('#')) {
            // In-document anchors (docx bookmarks) are handled by the viewer itself.
            if (href === '#') e.preventDefault();
            return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        openExternalLink(href);
        return;
    }
}
window.addEventListener('click', interceptLinkClick, true);
window.addEventListener('auxclick', interceptLinkClick, true);