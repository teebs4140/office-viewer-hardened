// Message bridge between the PDF viewer webview and the extension host.
// Office Viewer (Hardened): the page only sends what resource/pdf/main.js emits
// ('init' and 'openExternal'); there is no developer-tools shortcut.
const vscode = typeof (acquireVsCodeApi) != "undefined" ? acquireVsCodeApi() : null;
const postMessage = (message) => { if (vscode) { vscode.postMessage(message) } }

let events = {}
function receive({ data }) {
    if (!data)
        return;
    if (Object.prototype.hasOwnProperty.call(events, data.type)) {
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
        on(event, data) {
            events[event] = data
            return this;
        },
        emit(event, data) {
            postMessage({ type: event, content: data })
        }
    }
}

window.vscodeEvent = getVscodeEvent();

function isCompose(e) {
    return e.metaKey || e.ctrlKey;
}

window.addEventListener('keydown', e => {
    if (isCompose(e) && e.code == 'KeyV') {
        e.preventDefault()  // VS Code pastes into the webview itself; without this some keyboard layouts (e.g. Hebrew) paste twice
    }
})
