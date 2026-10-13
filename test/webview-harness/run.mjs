// Webview harness for Office Viewer (Hardened).
//
// Loads the built viewer pages in headless Chromium the way the extension host does:
// the React page (out/webview/index.html) is prepared like src/common/reactApp.ts and the
// PDF page (resource/pdf/viewer.html) like OfficeViewerProvider.loadPdfViewer. A stub
// acquireVsCodeApi() records every message the page posts and answers 'init' with the same
// 'open' payload the host sends (src/provider/handlers/officeContent.ts).
//
// The page and its resources are served from two loopback origins, as in VS Code where the
// page origin (vscode-webview://...) differs from webview.cspSource. Only the folders that
// localResourceRoots allows are served. The CSP meta tag is enforced by Chromium.
//
// Usage: node run.mjs [--only <fixture-substring>] [--verbose]
// Env:   OVH_CHROMIUM=<path to a Chromium / chrome-headless-shell binary>
import http from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const FIXTURES = join(REPO, 'test', 'fixtures');
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

// Same lists as src/common/constants.ts (WEBVIEW_MESSAGE_ALLOWLIST); checked against the source below.
const ALLOWLIST = {
    excel: ['init', 'editInVSCode', 'openExternal'],
    word: ['init', 'openExternal'],
    pdf: ['init', 'openExternal'],
};

// Folders the extension host lists in localResourceRoots: <ext>/out/webview, <ext>/resource
// and (for file: URIs) the opened file's folder.
const SERVED_ROOTS = ['out/webview', 'resource', 'test/fixtures'];

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.gif': 'image/gif', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.pfb': 'application/octet-stream',
    '.bcmap': 'application/octet-stream', '.properties': 'text/plain; charset=utf-8', '.ftl': 'text/plain; charset=utf-8',
    '.pdf': 'application/pdf', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// Console output that is known, expected noise (matched against the message text).
const CONSOLE_NOISE = [
    /^Blocked link with unsupported scheme$/,              // src/react/util/vscode.ts, expected for javascript: links
    /antd: compatible\]? antd v5 support React is 16 ~ 18/, // antd 5 on React 19
    /\[antd: [^\]]+\] `[^`]+` is deprecated/,             // antd deprecation notices
    /^Warning: Setting up fake worker\.$/,                 // pdf.js: worker runs on the main thread by design
    /^PDF [0-9a-f]{32} \[/,                                  // pdf.js document info line
    /^Warning: TT: /,                                       // pdf.js font warnings
];

// ---------------------------------------------------------------------------------------------
// Chromium

function findChromium() {
    const fromEnv = process.env.OVH_CHROMIUM || process.env.CHROMIUM_PATH;
    if (fromEnv) {
        if (!existsSync(fromEnv)) throw new Error(`OVH_CHROMIUM does not exist: ${fromEnv}`);
        return fromEnv;
    }
    const cacheRoots = [
        process.env.PLAYWRIGHT_BROWSERS_PATH,
        join(homedir(), '.cache', 'ms-playwright'),
        join(homedir(), 'Library', 'Caches', 'ms-playwright'),
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright'),
    ].filter(Boolean);
    const layouts = [
        ['chromium_headless_shell-', ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell',
            'chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell',
            'chrome-headless-shell-win64/chrome-headless-shell.exe']],
        ['chromium-', ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win/chrome.exe', 'chrome-win64/chrome.exe']],
    ];
    for (const root of cacheRoots) {
        if (!existsSync(root)) continue;
        for (const [prefix, bins] of layouts) {
            const dirs = readdirSync(root)
                .filter((d) => d.startsWith(prefix) && /^\d+$/.test(d.slice(prefix.length)))
                .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
            for (const d of dirs) {
                for (const bin of bins) {
                    const p = join(root, d, bin);
                    if (existsSync(p)) return p;
                }
            }
        }
    }
    return undefined; // let playwright-core try its own default location
}

// ---------------------------------------------------------------------------------------------
// HTTP: one server for the page origin, one for the resource origin (= {{cspSource}})

function listen(handler) {
    return new Promise((res) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => res(server));
    });
}

const resourceLog = [];

function serveResource(req, res) {
    const url = new URL(req.url, 'http://x');
    let rel;
    try {
        rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
        res.writeHead(400).end();
        return;
    }
    const full = resolve(REPO, rel);
    const allowed = SERVED_ROOTS.some((r) => full.startsWith(resolve(REPO, r) + sep));
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...headers, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET' }).end();
        return;
    }
    if (!allowed || !existsSync(full) || !statSync(full).isFile()) {
        resourceLog.push({ status: 404, path: url.pathname });
        res.writeHead(404, headers).end('not found');
        return;
    }
    resourceLog.push({ status: 200, path: url.pathname });
    res.writeHead(200, { ...headers, 'Content-Type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream' });
    res.end(readFileSync(full));
}

const pages = new Map();
function servePage(req, res) {
    const url = new URL(req.url, 'http://x');
    const html = pages.get(url.pathname);
    if (!html) {
        res.writeHead(404).end('not found');
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
}

// ---------------------------------------------------------------------------------------------
// Page preparation (mirrors the host)

function replaceAll(value, token, replacement) {
    return value.split(token).join(replacement);
}

function requireToken(html, token, file) {
    if (!html.includes(token)) throw new Error(`${file} does not contain ${token}; the host replacement would silently do nothing`);
}

// src/common/reactApp.ts serializeConfigs
function serializeConfigs(configs) {
    return JSON.stringify(configs)
        .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function stripCsp(html) {
    return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '');
}

// src/common/reactApp.ts ReactApp.view
function buildReactPage(cspSource, route, { csp = true } = {}) {
    const file = 'out/webview/index.html';
    let html = readFileSync(join(REPO, file), 'utf8');
    for (const t of ['<base href="/">', '{{cspSource}}', '{{configs}}']) requireToken(html, t, file);
    const baseUrl = `${cspSource}/out/webview`; // webview.asWebviewUri(<ext>/out/webview)
    html = html.replace('<base href="/">', () => `<base href="${baseUrl}/">`);
    html = replaceAll(html, '{{cspSource}}', cspSource);
    html = html.replace('{{configs}}', () => serializeConfigs({ route, language: 'en' }));
    if (/\{\{\w+\}\}/.test(html)) throw new Error(`${file}: placeholder left after host replacement`);
    return csp ? html : stripCsp(html);
}

// src/provider/officeViewerProvider.ts loadPdfViewer
function buildPdfPage(cspSource, { csp = true } = {}) {
    const file = 'resource/pdf/viewer.html';
    let html = readFileSync(join(REPO, file), 'utf8');
    for (const t of ['{{baseUrl}}', '{{cspSource}}']) requireToken(html, t, file);
    html = replaceAll(replaceAll(html, '{{baseUrl}}', `${cspSource}/resource/pdf`), '{{cspSource}}', cspSource);
    if (/\{\{\w+\}\}/.test(html)) throw new Error(`${file}: placeholder left after host replacement`);
    return csp ? html : stripCsp(html);
}

function cspOf(html) {
    return html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i)?.[1] ?? null;
}

// src/provider/handlers/officeContent.ts emitFileOfficeOpen / emitVirtualOfficeOpen
function openPayload(cspSource, fixture, mode) {
    const ext = extname(fixture);
    if (mode === 'virtual') {
        const uri = `vscode-vfs://github/example/repo/${fixture}`;
        return {
            ext, path: uri, fileName: fixture, scheme: 'vscode-vfs', documentCacheId: `vscode-vfs:${uri}`,
            readOnly: true, nonce: Date.now(), buffer: Array.from(readFileSync(join(FIXTURES, fixture))),
        };
    }
    return {
        ext,
        path: `${cspSource}/test/fixtures/${encodeURIComponent(fixture)}`, // webview.asWebviewUri(uri)
        fileName: fixture,
        documentCacheId: `file:file:///fixtures/${fixture}`,
        readOnly: true,
    };
}

// ---------------------------------------------------------------------------------------------
// Init script: runs in the page before any app script.

function initScript(cfg) {
    if (window.top !== window) return;
    const rec = {
        messages: [], csp: [], titleWrites: [], injected: [], canvasText: [], canvasTextSet: new Set(),
    };
    Object.defineProperty(window, '__ovh', { value: rec });

    document.addEventListener('securitypolicyviolation', (e) => {
        rec.csp.push({
            directive: e.violatedDirective, effective: e.effectiveDirective, blocked: e.blockedURI,
            source: e.sourceFile, line: e.lineNumber, sample: e.sample, disposition: e.disposition,
        });
    }, true);

    // Record every title write (an executed XSS payload sets document.title = 'XSS-...').
    const titleDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
    Object.defineProperty(Document.prototype, 'title', {
        configurable: true,
        get() { return titleDesc.get.call(this); },
        set(v) { rec.titleWrites.push(String(v)); titleDesc.set.call(this, v); },
    });

    // Text drawn on canvases (x-spreadsheet draws cells on a canvas).
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
        const s = String(text);
        if (!rec.canvasTextSet.has(s) && rec.canvasTextSet.size < 5000) {
            rec.canvasTextSet.add(s);
            rec.canvasText.push(s);
        }
        return fillText.call(this, text, ...rest);
    };

    // Elements that only appear when document content is parsed as HTML.
    const suspicious = (el) => {
        if (!(el instanceof Element) || el.id === 'ovh-guard-probe') return null;
        const tag = el.localName;
        if (['iframe', 'object', 'embed', 'frame'].includes(tag)) return tag;
        if (tag === 'script' && !el.src && el.type !== 'application/json') return 'inline script';
        for (const a of el.attributes) {
            if (/^on/i.test(a.name)) return `${tag}[${a.name}]`;
            if (/^\s*javascript:/i.test(a.value) && ['href', 'src', 'action', 'formaction', 'xlink:href'].includes(a.name)) {
                return `${tag}[${a.name}=javascript:]`;
            }
        }
        if (tag === 'img' && el.getAttribute('src') === 'x') return 'img[src=x]';
        return null;
    };
    new MutationObserver((list) => {
        for (const m of list) {
            const nodes = m.type === 'attributes' ? [m.target] : [...m.addedNodes];
            for (const n of nodes) {
                const all = n instanceof Element ? [n, ...n.querySelectorAll('*')] : [];
                for (const el of all) {
                    const why = suspicious(el);
                    if (why) rec.injected.push({ why, html: el.outerHTML.slice(0, 200) });
                }
            }
        }
    }).observe(document, { childList: true, subtree: true, attributes: true });

    // Stub VS Code webview API: VS Code allows a single acquireVsCodeApi() call per page.
    let state;
    let acquired = false;
    const api = Object.freeze({
        postMessage(message) {
            let clone;
            try { clone = JSON.parse(JSON.stringify(message ?? null)); } catch { clone = { unserializable: String(message) }; }
            rec.messages.push(clone);
            if (clone && clone.type === 'init') {
                setTimeout(() => window.postMessage({ type: 'open', content: cfg.openPayload }, '*'), 0);
            }
        },
        getState() { return state; },
        setState(s) { state = s; return s; },
    });
    window.acquireVsCodeApi = () => {
        if (acquired) throw new Error('An instance of the VS Code API has already been acquired');
        acquired = true;
        return api;
    };
}

// ---------------------------------------------------------------------------------------------
// Test cases

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, fn, arg, { timeout = 20000, what = 'condition' } = {}) {
    try {
        await page.waitForFunction(fn, arg, { timeout, polling: 100 });
    } catch (e) {
        throw new Error(`timed out waiting for ${what}`);
    }
}

async function excelReady(page, t) {
    await waitFor(page, () => !!document.querySelector('.x-spreadsheet-bottombar') && !document.querySelector('.ant-spin-spinning'),
        null, { what: 'spreadsheet to render' });
    const loadError = await page.evaluate(() => document.querySelector('.excel-load-error')?.textContent ?? null);
    t.check('no load error', loadError === null, loadError);
}

// x-spreadsheet truncates text that does not fit its cell to '<prefix>...'; accept that form too.
function drawnMatches(drawn, expected) {
    return drawn.some((d) => d === expected || (d.endsWith('...') && d.length >= 4 && expected.startsWith(d.slice(0, -3))));
}

async function canvasHas(page, t, strings) {
    const deadline = Date.now() + 10000;
    let drawn = [];
    while (Date.now() < deadline) {
        drawn = await page.evaluate(() => window.__ovh.canvasText);
        if (strings.every((s) => drawnMatches(drawn, s))) break;
        await sleep(200);
    }
    const missing = strings.filter((s) => !drawnMatches(drawn, s));
    t.check(`cells drawn as text: ${strings.join(' | ')}`, missing.length === 0,
        missing.length ? `missing ${JSON.stringify(missing)}; drawn: ${JSON.stringify(drawn.filter((d) => d.length > 2).slice(0, 30))}` : '');
}

async function overlayCellCenter(page, ri, ci) {
    // Default x-spreadsheet geometry used by Excel.tsx: index column 60px, header row and rows 30px, cols 100px.
    const box = await page.locator('.x-spreadsheet-overlayer').boundingBox();
    return { x: box.x + 60 + ci * 100 + 50, y: box.y + 30 + ri * 30 + 15 };
}

async function excelFind(page, t, query) {
    await page.locator('.x-spreadsheet-overlayer').click({ position: { x: 5, y: 5 } }).catch(() => { });
    await page.keyboard.press('Control+f');
    const input = page.locator('.frp-panel .frp-input').first();
    await input.waitFor({ timeout: 5000 });
    await input.fill(query);
    await input.press('Enter');
    await sleep(300);
    const status = await page.locator('.frp-status').first().textContent().catch(() => null);
    t.check(`find "${query}" reports a match`, !!status && !/not found|no match/i.test(status), status);
    await page.keyboard.press('Escape');
}

async function testExcelBenign(page, t, fx) {
    await excelReady(page, t);
    await canvasHas(page, t, fx.expect);
    const tab = (await page.locator('.x-spreadsheet-bottombar li').first().textContent().catch(() => '')).trim();
    t.check('sheet tab rendered', tab === fx.sheet, tab);
    // Auto-fit columns (view-only feature, Ctrl+Alt+0) redraws the grid without truncation.
    await page.locator('.x-spreadsheet-overlayer').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Alt+Digit0');
    await sleep(300);
    const fitToast = await page.locator('.ant-message-notice').count();
    t.check('auto-fit columns runs', fitToast > 0);
    t.info('toolbar items', await page.locator('.x-spreadsheet-toolbar .x-spreadsheet-toolbar-btn').count());
    await excelFind(page, t, fx.find);
    // Copy works in read mode; it writes the system clipboard only.
    const c = await overlayCellCenter(page, 1, 1);
    await page.mouse.click(c.x, c.y, { button: 'right' });
    await sleep(200);
    const menu = await page.locator('.x-spreadsheet-sheet > .x-spreadsheet-contextmenu, .x-spreadsheet-contextmenu').first().evaluate((el) =>
        getComputedStyle(el).display === 'none' ? ['(menu hidden)'] : [...el.children].filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.textContent.trim()).filter(Boolean)).catch((e) => [String(e)]);
    t.check('context menu shows only Copy', menu.length >= 1 && menu.every((m) => /^copy/i.test(m)), JSON.stringify(menu));
    await page.keyboard.press('Escape');
    // Ctrl+wheel zoom / wheel scroll must not throw.
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, 300);
}

async function testExcelHostile(page, t, fx) {
    await excelReady(page, t);
    await canvasHas(page, t, fx.expect);
    if (fx.sheetName) {
        const tabText = (await page.locator('.x-spreadsheet-bottombar li').first().textContent()).trim();
        t.check('hostile sheet name shown as literal text', tabText === fx.sheetName, tabText);
        t.check('no <b onclick> element from sheet name', await page.locator('b[onclick]').count() === 0);
    }
    // Simulate starting an edit on the hostile cells: click, double-click, F2, typing, Enter.
    for (const [ri, ci] of [[1, 1], [2, 1]]) {
        const c = await overlayCellCenter(page, ri, ci);
        await page.mouse.click(c.x, c.y);
        await page.mouse.dblclick(c.x, c.y);
        await sleep(100);
        await page.keyboard.press('F2');
        await page.keyboard.type('zz');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
        await page.mouse.move(c.x + 5, c.y + 3); // hover (tooltips)
        await sleep(150);
    }
    const editorVisible = await page.locator('.x-spreadsheet-editor').evaluate((el) => getComputedStyle(el).display !== 'none').catch(() => false);
    t.check('cell editor never opens (read mode)', !editorVisible);
    t.check('typing did not change cells', !(await page.evaluate(() => window.__ovh.canvasTextSet.has('zz'))));
    // Keyboard path to the cell as well: A1 -> B2, F2.
    const a1 = await overlayCellCenter(page, 0, 0);
    await page.mouse.click(a1.x, a1.y);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('F2');
    await page.keyboard.press('Escape');
    if (fx.jsLinkCell) {
        const [ri, ci] = fx.jsLinkCell;
        const c = await overlayCellCenter(page, ri, ci);
        await page.mouse.click(c.x, c.y);
        let toast = null;
        try {
            await page.locator('.ant-message-notice').filter({ hasText: 'Link not opened' }).first().waitFor({ timeout: 3000 });
            toast = await page.locator('.ant-message-notice').first().textContent();
        } catch { }
        t.check('javascript: hyperlink click shows "link blocked" toast', !!toast, toast ?? 'no toast (click missed the link?)');
    }
    await excelFind(page, t, fx.find);
}

async function testWord(page, t, fx) {
    await waitFor(page, (s) => document.body.innerText.includes(s), fx.expect[0], { what: 'docx text' });
    for (const s of fx.expect) {
        t.check(`docx text "${s}" in DOM`, await page.evaluate((x) => document.body.innerText.includes(x), s));
    }
    t.check('document rendered in the top frame (no iframes)', page.frames().length === 1, `${page.frames().length} frames`);
    const anchors = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href'), target: a.getAttribute('target') })));
    t.info('anchors', JSON.stringify(anchors));

    // Zoom control (own control; readOnly hides the editor toolbar).
    const zoomBefore = (await page.locator('.word-zoom-value').textContent().catch(() => null))?.trim();
    await page.locator('.word-zoom-control button[aria-label="Zoom in"]').click().catch(() => { });
    await sleep(200);
    const zoomAfter = (await page.locator('.word-zoom-value').textContent().catch(() => null))?.trim();
    t.check('zoom in changes zoom', !!zoomBefore && zoomBefore !== zoomAfter, `${zoomBefore} -> ${zoomAfter}`);
    await page.locator('.word-zoom-value').click().catch(() => { });

    // Typing must not alter the document (read-only).
    const target = page.getByText(fx.expect[0]).first();
    await target.click();
    await page.keyboard.type('QQZZ');
    await sleep(200);
    t.check('typing does not change the document', !(await page.evaluate(() => document.body.innerText.includes('QQZZ'))));

    const urlBefore = page.url();
    for (const link of fx.links) {
        const before = await page.evaluate(() => window.__ovh.messages.length);
        const loc = page.locator('a[href]').filter({ hasText: new RegExp(`^${link.text}$`) }).filter({ visible: true }).first();
        await loc.scrollIntoViewIfNeeded();
        await loc.click();
        await sleep(400);
        await loc.click({ button: 'middle' }).catch(() => { });
        await sleep(300);
        // Close a hyperlink popup if the editor opened one.
        await page.keyboard.press('Escape');
        const sent = await page.evaluate((n) => window.__ovh.messages.slice(n), before);
        const ext = sent.filter((m) => m?.type === 'openExternal').map((m) => m.content);
        if (link.expectExternal) {
            t.check(`click "${link.text}" -> openExternal ${link.expectExternal}`, ext.length >= 1 && ext.every((u) => u === link.expectExternal), JSON.stringify(ext));
        } else {
            t.check(`click "${link.text}" -> no openExternal`, ext.length === 0, JSON.stringify(ext));
        }
    }
    // The docx renderer already blanks javascript: hrefs, so also exercise the webview's own click
    // guard (src/react/util/vscode.ts) with anchors placed directly in the page.
    for (const href of [`javascript:document.title='XSS-ANCHOR'`, 'vscode:extension/example.example', 'file:///etc/hosts']) {
        const before = await page.evaluate(() => window.__ovh.messages.length);
        await page.evaluate((h) => {
            const a = document.createElement('a');
            a.id = 'ovh-guard-probe';
            a.textContent = 'probe';
            a.setAttribute('href', h);
            a.style.cssText = 'position:fixed;left:10px;top:10px;z-index:99999;background:#fff';
            document.body.append(a);
        }, href);
        await page.locator('#ovh-guard-probe').click();
        await page.locator('#ovh-guard-probe').click({ button: 'middle' });
        await sleep(200);
        await page.evaluate(() => document.getElementById('ovh-guard-probe')?.remove());
        const ext = (await page.evaluate((n) => window.__ovh.messages.slice(n), before)).filter((m) => m?.type === 'openExternal');
        t.check(`click guard blocks ${href.split(':')[0]}: link`, ext.length === 0, JSON.stringify(ext));
    }
    t.check('page never navigated', page.url() === urlBefore, page.url());
}

async function testPdf(page, t, fx) {
    await waitFor(page, () => window.PDFViewerApplication?.pdfDocument?.numPages > 0, null, { what: 'PDF document' });
    const info = await page.evaluate(() => {
        const o = window.PDFViewerApplicationOptions;
        return {
            numPages: PDFViewerApplication.pdfDocument.numPages,
            isEvalSupported: o.get('isEvalSupported'),
            enableScripting: o.get('enableScripting'),
            enableXfa: o.get('enableXfa'),
            // Effective getDocument parameters (pdf.js 3.1.81 keeps them on the worker transport).
            transportParams: (() => {
                const p = PDFViewerApplication.pdfDocument._transport?._params;
                return p ? { isEvalSupported: p.isEvalSupported, enableXfa: p.enableXfa } : null;
            })(),
        };
    });
    t.check(`page count ${fx.pages}`, info.numPages === fx.pages, info.numPages);
    t.check('AppOptions isEvalSupported=false', info.isEvalSupported === false, info.isEvalSupported);
    t.check('AppOptions enableScripting=false', info.enableScripting === false, info.enableScripting);
    t.check('AppOptions enableXfa=false', info.enableXfa === false, info.enableXfa);
    t.check('effective getDocument isEvalSupported=false', info.transportParams?.isEvalSupported === false, JSON.stringify(info.transportParams));
    t.check('effective getDocument enableXfa=false', info.transportParams?.enableXfa === false, JSON.stringify(info.transportParams));
    await waitFor(page, () => document.querySelectorAll('.textLayer span').length > 0, null, { what: 'text layer' });
    const text = await page.evaluate(() => [...document.querySelectorAll('.page[data-page-number="1"] .textLayer')].map((l) => l.textContent).join(' '));
    t.check('text layer has page text', fx.expect.every((s) => text.includes(s)), text.slice(0, 120));

    // Search
    await page.keyboard.press('Control+f');
    await page.locator('#findInput').fill(fx.find);
    await page.locator('#findInput').press('Enter');
    await sleep(800);
    const results = (await page.locator('#findResultsCount').textContent().catch(() => '')).trim();
    const highlighted = await page.locator('.textLayer .highlight').count();
    t.check(`search "${fx.find}" finds matches`, highlighted > 0, `${results} / ${highlighted} highlights`);
    await page.keyboard.press('Escape');

    // Zoom
    const scale0 = await page.evaluate(() => PDFViewerApplication.pdfViewer.currentScale);
    await page.locator('#zoomIn').click();
    await sleep(300);
    const scale1 = await page.evaluate(() => PDFViewerApplication.pdfViewer.currentScale);
    t.check('zoom in increases scale', scale1 > scale0, `${scale0} -> ${scale1}`);

    // Thumbnails
    await page.evaluate(() => PDFViewerApplication.pdfSidebar.open());
    try {
        await waitFor(page, () => document.querySelectorAll('#thumbnailView img.thumbnailImage').length > 0, null, { what: 'thumbnails', timeout: 8000 });
        const src = await page.locator('#thumbnailView img.thumbnailImage').first().getAttribute('src');
        t.check('thumbnails render', /^(data|blob):/.test(src ?? ''), (src ?? '').slice(0, 30));
    } catch {
        t.check('thumbnails render', false);
    }

    if (fx.links) {
        await page.evaluate(() => { PDFViewerApplication.pdfViewer.currentScaleValue = 'page-width'; PDFViewerApplication.page = 1; });
        await sleep(500);
        await waitFor(page, () => document.querySelectorAll('.page[data-page-number="1"] .annotationLayer section').length > 0, null, { what: 'annotation layer' });
        const annots = await page.evaluate(() => [...document.querySelectorAll('.page[data-page-number="1"] .annotationLayer section')].map((s) => {
            const a = s.querySelector('a');
            return { href: a?.getAttribute('href') ?? null, onclick: !!a?.onclick, title: a?.title ?? '' };
        }));
        t.info('annotation links', JSON.stringify(annots));
        const urlBefore = page.url();
        for (const link of fx.links) {
            const before = await page.evaluate(() => window.__ovh.messages.length);
            const sections = page.locator('.page[data-page-number="1"] .annotationLayer section');
            const sec = sections.nth(link.index);
            await sec.scrollIntoViewIfNeeded();
            const anchor = sec.locator('a');
            if (await anchor.count()) await anchor.click({ force: true });
            else await sec.click({ force: true });
            await sleep(500);
            const sent = await page.evaluate((n) => window.__ovh.messages.slice(n), before);
            const ext = sent.filter((m) => m?.type === 'openExternal').map((m) => m.content);
            if (link.expectExternal) {
                t.check(`${link.name} -> one openExternal ${link.expectExternal}`, ext.length === 1 && ext[0] === link.expectExternal, JSON.stringify(ext));
            } else {
                t.check(`${link.name} -> no openExternal`, ext.length === 0, JSON.stringify(ext));
            }
            if (link.expectPage) {
                const pageNo = await page.evaluate(() => PDFViewerApplication.page);
                t.check(`${link.name} -> goes to page ${link.expectPage}`, pageNo === link.expectPage, pageNo);
                await page.evaluate(() => { PDFViewerApplication.page = 1; });
                await sleep(300);
            }
        }
        t.check('page never navigated', page.url() === urlBefore, page.url());
    }
}

// Detector self-test: deliberately injects markup, a script handler and a remote fetch into a
// rendered page, so the run shows that the XSS, CSP and network checks above do fire.
async function selfTestInject(page, t) {
    await excelReady(page, t);
    await page.evaluate(() => {
        document.body.insertAdjacentHTML('beforeend', `<img src=x onerror="document.title='XSS-SELFTEST'">`);
        fetch('https://example.com/ovh-selftest').catch(() => { });
    });
    await sleep(800);
}

const SELF_TEST = { file: 'benign.csv', route: 'excel', kind: 'benign', test: selfTestInject };
const SELF_TEST_EXPECT = {
    csp: ['no HTML injected from document content', 'zero CSP violations'],
    'no-csp': ['no HTML injected from document content', 'no XSS: title never contained "XSS"', 'no requests outside the harness origins'],
};

const FIXTURE_CASES = [
    { file: 'benign.csv', route: 'excel', kind: 'benign', test: testExcelBenign, expect: ['USUBJID', 'Placebo', '01-001', 'Drug A', '71.2'], find: 'Placebo', sheet: 'Sheet1' },
    { file: 'benign.tsv', route: 'excel', kind: 'benign', test: testExcelBenign, expect: ['USUBJID', 'Placebo', '01-001', 'Drug A', '71.2'], find: 'Placebo', sheet: 'Sheet1' },
    { file: 'benign.xlsx', route: 'excel', kind: 'benign', test: testExcelBenign, expect: ['USUBJID', 'Placebo', '01-001', 'Drug A', '71.2'], find: 'Placebo', sheet: 'Sheet1' },
    {
        file: 'hostile.csv', route: 'excel', kind: 'hostile', test: testExcelHostile,
        expect: ['NOTE', `<img src=x onerror="document.title='XSS-CSV'">`], find: 'iframe',
    },
    {
        file: 'hostile.xlsx', route: 'excel', kind: 'hostile', test: testExcelHostile,
        expect: ['NOTE', `<img src=x onerror="document.title='XSS-CSV'">`], find: 'iframe', sheetName: '<b onclick=x>S', jsLinkCell: [1, 2],
    },
    {
        file: 'links.docx', route: 'word', kind: 'hostile', test: testWord,
        expect: ['Table 14.1 Demographics', 'Benign test document.', 'example.org'],
        links: [{ text: 'example.org', expectExternal: 'https://example.org/' }, { text: 'click', expectExternal: null }],
    },
    { file: 'benign.pdf', route: 'pdf', kind: 'benign', test: testPdf, pages: 2, expect: [], find: 'a' },
    {
        file: 'links.pdf', route: 'pdf', kind: 'hostile', test: testPdf, pages: 2, expect: ['Link test page one'], find: 'link',
        links: [
            { index: 0, name: 'https link', expectExternal: 'https://example.org/' },
            { index: 1, name: 'javascript: URI link', expectExternal: null },
            { index: 2, name: 'JavaScript action link', expectExternal: null },
            { index: 3, name: 'GoTo link', expectExternal: null, expectPage: 2 },
        ],
    },
];

// ---------------------------------------------------------------------------------------------
// Runner

class TestRecord {
    constructor(name) { this.name = name; this.checks = []; this.infos = []; }
    check(label, ok, detail) { this.checks.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); }
    info(label, detail) { this.infos.push({ label, detail: String(detail) }); }
    get ok() { return this.checks.every((c) => c.ok); }
}

function checkAllowlistMatchesSource() {
    const src = readFileSync(join(REPO, 'src', 'common', 'constants.ts'), 'utf8');
    const problems = [];
    for (const [route, types] of Object.entries(ALLOWLIST)) {
        const m = src.match(new RegExp(`${route}:\\s*new Set\\(\\[([^\\]]*)\\]\\)`));
        const fromSrc = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : null;
        if (!fromSrc || fromSrc.join() !== [...types].sort().join()) {
            problems.push(`${route}: harness ${JSON.stringify(types)} vs constants.ts ${JSON.stringify(fromSrc)}`);
        }
    }
    return problems;
}

async function runCase(browser, origins, fx, variant) {
    const name = `${fx.file} [${variant.label}]`;
    const t = new TestRecord(name);
    const { pageOrigin, cspSource } = origins;
    const html = fx.route === 'pdf' ? buildPdfPage(cspSource, { csp: variant.csp }) : buildReactPage(cspSource, fx.route, { csp: variant.csp });
    const path = `/${fx.route}-${variant.label}-${fx.file}.html`;
    pages.set(path, html);
    if (variant.csp) {
        const csp = cspOf(html);
        t.check('CSP meta present', !!csp);
        t.check("CSP has no 'unsafe-eval' / script 'unsafe-inline' / remote origins",
            !!csp && !/unsafe-eval/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp)
            && (csp.match(/https?:\/\/[^\s;]+/g) ?? []).every((o) => o === cspSource), csp);
    }

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    const external = [];
    const requests = [];
    const popups = [];
    const dialogs = [];
    const consoleMsgs = [];
    const pageErrors = [];
    const navigations = [];
    await context.route('**/*', (route) => {
        const u = route.request().url();
        let origin = null;
        try { origin = new URL(u).origin; } catch { }
        if (origin === pageOrigin || origin === cspSource) return route.continue();
        external.push(u);
        return route.abort('blockedbyclient');
    });
    context.on('page', (p) => popups.push(p.url()));
    const page = await context.newPage();
    popups.length = 0; // the page itself
    context.on('page', () => { });
    page.on('request', (r) => requests.push(r.url()));
    page.on('dialog', (d) => { dialogs.push(`${d.type()}: ${d.message()}`); d.dismiss().catch(() => { }); });
    page.on('console', (m) => consoleMsgs.push({ type: m.type(), text: m.text() }));
    page.on('pageerror', (e) => pageErrors.push(String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ')));
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
    page.on('popup', (p) => popups.push(p.url()));
    await page.addInitScript(initScript, { openPayload: openPayload(cspSource, fx.file, variant.mode) });

    try {
        await page.goto(pageOrigin + path, { waitUntil: 'load' });
        await fx.test(page, t, fx);
        await sleep(500);
    } catch (e) {
        t.check('test steps completed', false, e.message.split('\n')[0]);
    }

    const rec = await page.evaluate(() => ({
        messages: window.__ovh.messages, csp: window.__ovh.csp, titleWrites: window.__ovh.titleWrites,
        injected: window.__ovh.injected, title: document.title, frames: window.frames.length,
    })).catch((e) => ({ error: e.message }));
    await context.close();

    if (rec.error) {
        t.check('page state readable at end', false, rec.error);
        return { t, rec: {}, external, consoleMsgs, pageErrors };
    }
    const allowed = new Set(ALLOWLIST[fx.route]);
    const types = rec.messages.map((m) => m?.type);
    t.check('posted messages are allowlisted', types.every((x) => allowed.has(x)), JSON.stringify(types));
    t.check("'init' sent exactly once", types.filter((x) => x === 'init').length === 1, types.filter((x) => x === 'init').length);
    t.check('no XSS: title never contained "XSS"', !rec.titleWrites.some((x) => /XSS/.test(x)) && !/XSS/.test(rec.title), JSON.stringify(rec.titleWrites));
    t.check('no HTML injected from document content', rec.injected.length === 0, JSON.stringify(rec.injected.slice(0, 3)));
    t.check('no dialogs (alert/print/confirm)', dialogs.length === 0, JSON.stringify(dialogs));
    t.check('no popups', popups.length === 0, JSON.stringify(popups));
    // pdf.js updates location.hash (same-document); anything else would be a real navigation.
    const pageUrl = pageOrigin + path;
    const realNavs = navigations.filter((u) => u.split('#')[0] !== pageUrl);
    t.check('page never navigated away', realNavs.length === 0 && navigations.length >= 1, JSON.stringify(realNavs));
    t.check('no requests outside the harness origins', external.length === 0, JSON.stringify(external.slice(0, 5)));
    const missing = resourceLog.filter((r) => r.status === 404);
    t.check('no 404s for webview resources', missing.length === 0, JSON.stringify(missing.slice(0, 5)));
    resourceLog.length = 0;
    if (variant.csp) {
        if (fx.kind === 'benign') {
            t.check('zero CSP violations', rec.csp.length === 0, JSON.stringify(rec.csp.slice(0, 5)));
        } else {
            // A hostile fixture may legitimately trigger a violation only if the CSP blocked document content
            // (e.g. an external image). Any script/eval violation means something tried to run.
            const scriptish = rec.csp.filter((v) => /script|eval|worker|frame|object/.test(v.effective || v.directive));
            t.check('no script/eval/frame CSP violations', scriptish.length === 0, JSON.stringify(scriptish.slice(0, 5)));
            t.check('zero CSP violations', rec.csp.length === 0, JSON.stringify(rec.csp.slice(0, 5)));
        }
    }
    t.check('no uncaught page errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
    const unexpectedErrors = consoleMsgs.filter((m) => m.type === 'error' && !CONSOLE_NOISE.some((r) => r.test(m.text)));
    t.check('no unexpected console errors', unexpectedErrors.length === 0, JSON.stringify(unexpectedErrors.slice(0, 3).map((m) => m.text.slice(0, 200))));
    const warnings = consoleMsgs.filter((m) => m.type === 'warning' && !CONSOLE_NOISE.some((r) => r.test(m.text)));
    if (warnings.length) t.info('console warnings', JSON.stringify(warnings.slice(0, 5).map((m) => m.text.slice(0, 160))));
    t.summary = {
        messages: types, csp: rec.csp.length, external: external.length, xss: rec.titleWrites.some((x) => /XSS/.test(x)) || rec.injected.length > 0,
        requests: requests.length,
    };
    return { t };
}

async function main() {
    const allowProblems = checkAllowlistMatchesSource();
    if (allowProblems.length) {
        console.error('Harness allowlist differs from src/common/constants.ts:\n  ' + allowProblems.join('\n  '));
        process.exitCode = 1;
    }
    for (const f of ['out/webview/index.html', 'resource/pdf/viewer.html']) {
        if (!existsSync(join(REPO, f))) {
            console.error(`${f} missing: run "npx vite build --mode=production" in the repo root first.`);
            process.exit(2);
        }
    }
    const pageServer = await listen(servePage);
    const resourceServer = await listen(serveResource);
    const origins = {
        pageOrigin: `http://127.0.0.1:${pageServer.address().port}`,
        cspSource: `http://127.0.0.1:${resourceServer.address().port}`,
    };
    const executablePath = findChromium();
    console.log(`chromium: ${executablePath ?? '(playwright-core default)'}`);
    console.log(`page origin ${origins.pageOrigin}, resource origin / cspSource ${origins.cspSource}`);
    const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });

    let selfTestOk = true;
    if (!ONLY) {
        for (const v of [{ label: 'selftest', mode: 'file', csp: true, key: 'csp' }, { label: 'selftest-no-csp', mode: 'file', csp: false, key: 'no-csp' }]) {
            const { t } = await runCase(browser, origins, SELF_TEST, v);
            const failed = new Set(t.checks.filter((c) => !c.ok).map((c) => c.label));
            const missed = SELF_TEST_EXPECT[v.key].filter((l) => !failed.has(l));
            selfTestOk &&= missed.length === 0;
            console.log(`${missed.length ? 'FAIL' : 'PASS'}  detector self-test [${v.key}]: ${missed.length ? `detectors did not fire: ${missed.join('; ')}` : `fired: ${SELF_TEST_EXPECT[v.key].join('; ')}`}`);
        }
    }

    const results = [];
    for (const fx of FIXTURE_CASES) {
        if (ONLY && !fx.file.includes(ONLY)) continue;
        const variants = [{ label: 'file', mode: 'file', csp: true }, { label: 'virtual', mode: 'virtual', csp: true }];
        // Without the CSP, the hostile fixtures check that the viewer code itself never turns
        // document content into markup or script (defence in depth).
        if (fx.kind === 'hostile') variants.push({ label: 'no-csp', mode: 'file', csp: false });
        for (const v of variants) {
            const { t } = await runCase(browser, origins, fx, v);
            results.push(t);
            console.log(`\n${t.ok ? 'PASS' : 'FAIL'}  ${t.name}`);
            for (const c of t.checks) {
                if (!c.ok || VERBOSE) console.log(`   ${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.detail ? ` :: ${c.detail.slice(0, 400)}` : ''}`);
            }
            if (VERBOSE) for (const i of t.infos) console.log(`   info ${i.label} :: ${i.detail.slice(0, 400)}`);
        }
    }
    await browser.close();
    pageServer.close();
    resourceServer.close();

    console.log('\nSummary');
    console.log('fixture [variant]'.padEnd(34) + 'result  checks  csp-viol  external  xss  messages');
    for (const t of results) {
        const s = t.summary ?? {};
        console.log(`${t.name.padEnd(34)}${(t.ok ? 'PASS' : 'FAIL').padEnd(8)}${`${t.checks.filter((c) => c.ok).length}/${t.checks.length}`.padEnd(8)}${String(s.csp ?? '?').padEnd(10)}${String(s.external ?? '?').padEnd(10)}${String(s.xss ?? '?').padEnd(5)}${JSON.stringify(s.messages ?? [])}`);
    }
    const failed = results.filter((t) => !t.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed${ONLY ? '' : `; detector self-test ${selfTestOk ? 'passed' : 'FAILED'}`}`);
    if (failed || !selfTestOk) process.exitCode = 1;
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
