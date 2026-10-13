export const VIEW_TYPE = 'officeViewerHardened.viewer';

/**
 * Message types each viewer page may send to the extension host. Anything else
 * (including the host's internal events such as fileChange or dispose) is dropped
 * by Handler.bind before it reaches the event emitter.
 */
export const WEBVIEW_MESSAGE_ALLOWLIST: Readonly<Record<'excel' | 'word' | 'pdf', ReadonlySet<string>>> = {
    excel: new Set(['init', 'editInVSCode', 'openExternal']),
    word: new Set(['init', 'openExternal']),
    pdf: new Set(['init', 'openExternal']),
};

/** URI schemes the webview may ask the host to open externally (compared lower-case, no trailing colon). */
export const EXTERNAL_LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);
