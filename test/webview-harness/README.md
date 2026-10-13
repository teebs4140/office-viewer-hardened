# Webview harness

Headless Chromium checks for the Office Viewer (Hardened) webview pages. The harness is not part
of the extension: it has its own `package.json`, its only dependency is `playwright-core`, and
`.vscodeignore` keeps `test/**` out of the VSIX.

## Tier 1: emulated webview (`run.mjs`)

`run.mjs` loads the **built** pages the same way the extension host does:

- React page (`out/webview/index.html`, Excel and Word): `<base href>`, `{{cspSource}}` and
  `{{configs}}` are replaced as in `src/common/reactApp.ts`.
- PDF page (`resource/pdf/viewer.html`): `{{baseUrl}}` and `{{cspSource}}` are replaced as in
  `OfficeViewerProvider.loadPdfViewer`.
- The page is served from one loopback origin and its resources from another, which plays the
  role of `webview.cspSource`. This matches VS Code, where the page origin differs from the
  resource origin. Only `out/webview/`, `resource/` and `test/fixtures/` are served, mirroring
  `localResourceRoots`.
- A stub `acquireVsCodeApi()` (installed with `page.addInitScript`) records every posted message.
  It answers `init` with the host's `open` payload: the fixture as a webview URL (file mode), or
  as a byte array (virtual mode, like `git:` / `vscode-vfs:` documents).
- The CSP meta tag is enforced by Chromium; `bypassCSP` is not used.

For each fixture in `test/fixtures/` the harness checks that:

- the document rendered (cell text drawn on the x-spreadsheet canvas, docx text in the DOM,
  PDF page count and text layer);
- there are no `securitypolicyviolation` events;
- `document.title` never contains `XSS`, and no element with an `on*` attribute, `iframe`,
  inline script or `javascript:` URL is inserted;
- no request goes anywhere except the two harness origins, and no dialog, popup or navigation
  happens;
- every posted message type is in the route's allowlist (`src/common/constants.ts`).

It also exercises the features users rely on: find, auto-fit and the context menu in Excel;
zoom and links in Word; search, zoom, thumbnails and links in PDF. For PDF it checks that
`isEvalSupported`, `enableScripting` and `enableXfa` are all `false`, both in `AppOptions` and in
the parameters actually passed to `getDocument`.

Hostile fixtures are also run with the CSP meta tag removed (`no-csp`). That shows the viewer
code itself never turns document content into markup, without relying on the CSP. Before the
fixtures, a detector self-test injects markup, an inline handler and a remote `fetch` into a
rendered page and confirms that the checks catch each one.

### Run

```sh
# from the repository root: build the extension first
npx vite build --mode=production

cd test/webview-harness
npm ci --ignore-scripts
node run.mjs                 # all fixtures
node run.mjs --only pdf      # fixtures whose file name contains "pdf"
node run.mjs --verbose       # print every check, not only failures
```

The exit code is non-zero if any check fails.

### Chromium

`playwright-core` does not download browsers. The harness uses, in order:

1. `OVH_CHROMIUM` (or `CHROMIUM_PATH`): the path to a Chromium or `chrome-headless-shell` binary.
2. The newest `chromium_headless_shell-*` and then `chromium-*` under `PLAYWRIGHT_BROWSERS_PATH`
   or the default Playwright cache (`~/.cache/ms-playwright`, `~/Library/Caches/ms-playwright`,
   `%LOCALAPPDATA%\ms-playwright`).
3. `playwright-core`'s own default location.

To fetch a matching browser into the cache, run `npx playwright-core@1.61.1 install chromium-headless-shell`.
The pinned `playwright-core` 1.61.1 expects Chromium revision 1228.

## Tier 2: real VS Code webview (`tier2-code-server.mjs`, optional)

`@vscode/test-electron` needs to download VS Code from `update.code.visualstudio.com`. If you
cannot reach it but have [code-server](https://github.com/coder/code-server) installed, this
script does a comparable check:

1. Installs the VSIX into a throwaway code-server (its own user-data, extensions and XDG dirs).
2. Opens each fixture through Quick Open, so the custom editor is chosen the normal way.
3. Checks that the webview rendered and that there were no CSP console errors, no `XSS` titles
   and no requests to non-local origins.
4. Checks that the extension activated through `onCustomEditor:officeViewerHardened.viewer`
   and that the extension host logged no errors attributable to it.

```sh
npx @vscode/vsce package --no-dependencies --out /some/dir/   # from the repository root
node test/webview-harness/tier2-code-server.mjs /some/dir/office-viewer-hardened-1.0.0.vsix
```

Environment: `CODE_SERVER` sets the binary (default `code-server` on `PATH`), `OVH_CHROMIUM` works
as in Tier 1, and `OVH_TIER2_DIR` sets the scratch directory (default: a new temp folder). The
scratch directory keeps the screenshots and logs. The script removes `VSCODE_*` variables from
code-server's environment. Without that, code-server started inside a VS Code terminal hands the
folder to the running VS Code instead of starting its own server.

## Fixtures

| File | Content |
| --- | --- |
| `benign.csv`, `benign.tsv`, `benign.xlsx` | A small demographics table |
| `hostile.csv` | `<img onerror>` and `<iframe srcdoc>` markup in cells |
| `hostile.xlsx` | Same cells, the sheet name `<b onclick=x>S`, and a `javascript:` hyperlink in C2 |
| `links.docx` | An `https://example.org/` hyperlink and a `javascript:` hyperlink |
| `benign.pdf` | Two pages of text |
| `links.pdf` | An https link, a `javascript:` URI link, a JavaScript-action link, an internal GoTo link and a JavaScript `/OpenAction`. Generated by `make-links-pdf.mjs` |

Each hostile payload would set `document.title` to an `XSS-*` string if it ran.
