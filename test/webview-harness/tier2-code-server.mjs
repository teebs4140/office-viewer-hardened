// Tier 2 (optional): installs the packaged VSIX into a throwaway code-server instance and opens
// each fixture with the officeViewerHardened.viewer editor in headless Chromium. This runs the
// real extension host and the real VS Code webview (with its own resource origin and CSP),
// which the Tier 1 harness only emulates.
//
// Usage: node tier2-code-server.mjs <path to .vsix>
// Env:   CODE_SERVER=<code-server binary> (default: `code-server` on PATH)
//        OVH_CHROMIUM=<Chromium binary> (same lookup as run.mjs)
//        OVH_TIER2_DIR=<scratch directory> (default: a new folder under the OS temp dir)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const FIXTURES = join(REPO, 'test', 'fixtures');
const vsix = process.argv[2] && resolve(process.argv[2]);
if (!vsix || !existsSync(vsix)) {
    console.error('usage: node tier2-code-server.mjs <path to .vsix>');
    process.exit(2);
}
const CODE_SERVER = process.env.CODE_SERVER || 'code-server';
const scratch = process.env.OVH_TIER2_DIR ? resolve(process.env.OVH_TIER2_DIR) : mkdtempSync(join(tmpdir(), 'ovh-tier2-'));
const dirs = Object.fromEntries(['user-data', 'extensions', 'xdg-config', 'xdg-data', 'workspace'].map((d) => [d, join(scratch, d)]));
Object.values(dirs).forEach((d) => mkdirSync(d, { recursive: true }));
const configFile = join(scratch, 'config.yaml');
writeFileSync(configFile, 'auth: none\ncert: false\n');
// Keep code-server's own config/data out of the user's home directory.
const env = { ...process.env, XDG_CONFIG_HOME: dirs['xdg-config'], XDG_DATA_HOME: dirs['xdg-data'] };
// Inside a VS Code terminal, code-server would otherwise hand the folder to that running VS Code
// instance (VSCODE_IPC_HOOK_CLI) instead of starting its own server.
for (const k of Object.keys(env)) {
    if (k.startsWith('VSCODE_')) delete env[k];
}
const common = ['--config', configFile, '--user-data-dir', dirs['user-data'], '--extensions-dir', dirs.extensions];

// User settings: no telemetry, no welcome page, trust the workspace.
mkdirSync(join(dirs['user-data'], 'User'), { recursive: true });
writeFileSync(join(dirs['user-data'], 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off',
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'workbench.enableExperiments': false,
}, null, 2));

const FIXTURE_CHECKS = {
    'benign.csv': { selector: '.x-spreadsheet-bottombar li' },
    'benign.tsv': { selector: '.x-spreadsheet-bottombar li' },
    'benign.xlsx': { selector: '.x-spreadsheet-bottombar li' },
    'hostile.csv': { selector: '.x-spreadsheet-bottombar li' },
    'hostile.xlsx': { selector: '.x-spreadsheet-bottombar li' },
    'links.docx': { text: 'Table 14.1 Demographics' },
    'benign.pdf': { selector: '.textLayer span' },
    'links.pdf': { selector: '.textLayer span' },
};

function findChromium() {
    if (process.env.OVH_CHROMIUM) return process.env.OVH_CHROMIUM;
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
    if (!existsSync(root)) return undefined;
    for (const [prefix, bin] of [['chromium_headless_shell-', 'chrome-headless-shell-linux64/chrome-headless-shell'], ['chromium-', 'chrome-linux64/chrome']]) {
        const d = readdirSync(root).filter((x) => x.startsWith(prefix) && /^\d+$/.test(x.slice(prefix.length)))
            .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)))
            .map((x) => join(root, x, bin)).find(existsSync);
        if (d) return d;
    }
    return undefined;
}

function freePort() {
    return new Promise((res) => {
        const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const install = spawnSync(CODE_SERVER, [...common, '--install-extension', vsix, '--force'], { env, encoding: 'utf8' });
    console.log(`install: exit ${install.status} ${(install.stdout + install.stderr).trim().split('\n').slice(-2).join(' | ')}`);
    if (install.status !== 0) process.exit(1);

    // Copy the fixtures into a scratch workspace so nothing is written next to the repo.
    for (const f of Object.keys(FIXTURE_CHECKS)) {
        writeFileSync(join(dirs.workspace, f), readFileSync(join(FIXTURES, f)));
    }

    const port = await freePort();
    const log = [];
    const server = spawn(CODE_SERVER, [...common, '--bind-addr', `127.0.0.1:${port}`, '--disable-telemetry',
        '--disable-update-check', '--disable-workspace-trust', '--disable-getting-started-override', dirs.workspace], { env });
    server.stdout.on('data', (d) => log.push(String(d)));
    server.stderr.on('data', (d) => log.push(String(d)));
    const origin = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
        try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch { }
        await sleep(500);
    }

    const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] });
    const results = [];
    try {
        for (const [file, check] of Object.entries(FIXTURE_CHECKS)) {
            const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
            const page = await context.newPage();
            const csp = [];
            const errors = [];
            const external = new Set();
            page.on('request', (r) => {
                const u = new URL(r.url());
                if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return;
                // *.vscode-resource.vscode-cdn.net is the webview resource origin; VS Code's service
                // worker answers it from the extension host, it never leaves the machine.
                if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && !u.hostname.endsWith('.vscode-resource.vscode-cdn.net')) external.add(u.origin);
            });
            page.on('console', (m) => {
                if (m.type() === 'error') errors.push(m.text().slice(0, 300));
                if (/Content Security Policy|Refused to/.test(m.text())) csp.push(m.text().slice(0, 300));
            });
            await page.goto(`${origin}/?folder=${encodeURIComponent(dirs.workspace)}`, { waitUntil: 'domcontentloaded' });
            await page.locator('.monaco-workbench').waitFor({ timeout: 60000 });
            await sleep(3000);
            // Quick Open the fixture; the custom editor has priority "default" for these patterns.
            await page.keyboard.press('Control+p');
            await page.locator('.quick-input-widget input[type=text]').waitFor({ timeout: 10000 });
            await page.keyboard.type(file);
            await sleep(800);
            await page.keyboard.press('Enter');
            let rendered = false;
            let detail = '';
            const deadline = Date.now() + 45000;
            while (Date.now() < deadline && !rendered) {
                for (const frame of page.frames()) {
                    try {
                        if (check.selector && await frame.locator(check.selector).count() > 0) {
                            rendered = true;
                            detail = (await frame.locator(check.selector).first().textContent())?.trim().slice(0, 40) ?? '';
                        } else if (check.text && await frame.evaluate((t) => document.body?.innerText.includes(t), check.text)) {
                            rendered = true;
                            detail = check.text;
                        }
                    } catch { }
                    if (rendered) break;
                }
                if (!rendered) await sleep(500);
            }
            const tabLabel = await page.locator('.tab.active .label-name').first().textContent().catch(() => '');
            const titleXss = await Promise.all(page.frames().map((f) => f.evaluate(() => document.title).catch(() => ''))).then((ts) => ts.filter((t) => /XSS/.test(t)));
            results.push({ file, rendered, detail, tab: tabLabel, csp: csp.length, cspSample: csp.slice(0, 2), errors: errors.filter((e) => !/favicon|manifest|Failed to load resource: the server responded with a status of 404/.test(e)).slice(0, 3), external: [...external], xss: titleXss.length > 0 });
            await page.screenshot({ path: join(scratch, `${file}.png`) });
            await context.close();
        }
    } finally {
        await browser.close();
        server.kill();
    }

    let ok = true;
    for (const r of results) {
        const pass = r.rendered && r.csp === 0 && !r.xss && r.external.length === 0;
        ok &&= pass;
        console.log(`${pass ? 'PASS' : 'FAIL'}  ${r.file.padEnd(14)} rendered=${r.rendered} (${r.detail}) tab=${r.tab} csp=${r.csp} xss=${r.xss} external=${JSON.stringify(r.external)}${r.errors.length ? ` errors=${JSON.stringify(r.errors)}` : ''}${r.cspSample.length ? ` csp=${JSON.stringify(r.cspSample)}` : ''}`);
    }
    // Extension host logs: the extension must activate on onCustomEditor and log no errors of its own.
    const hostLogs = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/exthost\.log$/.test(e.name)) hostLogs.push(p); } };
    if (existsSync(join(dirs['user-data'], 'logs'))) walk(join(dirs['user-data'], 'logs'));
    const hostText = hostLogs.map((p) => readFileSync(p, 'utf8')).join('\n') + log.join('');
    const activations = hostText.split('\n').filter((l) => /_doActivateExtension dcri-biostats\.office-viewer-hardened/.test(l));
    const blocks = hostText.split(/\n(?=\d{4}-\d\d-\d\d )/);
    const hostErrors = blocks.filter((b) => /\[error\]/.test(b) && /office-viewer-hardened|officeViewerHardened/i.test(b));
    console.log(`activation: ${activations.length ? activations[0].replace(/^.*_doActivateExtension /, '') : 'NOT FOUND'}`);
    console.log(`extension-host errors attributable to the extension: ${hostErrors.length}`);
    hostErrors.slice(0, 10).forEach((l) => console.log(`   ${l.slice(0, 300)}`));
    if (!activations.length) ok = false;
    console.log(`screenshots and logs: ${scratch}`);
    writeFileSync(join(scratch, 'code-server.log'), log.join(''));
    if (!ok || hostErrors.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
