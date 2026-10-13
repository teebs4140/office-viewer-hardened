# Changelog

## 1.0.0

First release of the hardened fork, based on upstream Office Viewer **4.2.0** (commit `09df4e7`).
The full diff from upstream is `git diff upstream-4.2.0..main`.

### Scope

- Kept viewers: CSV/TSV, Excel `.xlsx`/`.xlsm`, Word `.docx`/`.dotx`, PDF.
- Removed:
  - the Markdown editor, preview and export (including the bundled Chrome/puppeteer export path
    and the PlantUML calls);
  - the archive, PowerPoint, EPUB, XMind, PSD, font, image, SVG, HTML, Parquet and Java `.class`
    viewers;
  - Git History, the REST client, the YAML/XML providers and the clipboard image paste scripts;
  - themes, icon themes and snippets;
  - the web (vscode.dev) build;
  - telemetry and the sponsor UI.
- Removed `.xls`/`.ods` support. These formats were parsed by SheetJS 0.18.5 (CVE-2023-30533,
  CVE-2024-22363). Save as `.xlsx` instead.
- New identity, so the fork can be installed alongside upstream:
  - extension `dcri-biostats.office-viewer-hardened`
  - editor `officeViewerHardened.viewer`
  - no settings or commands
- Activates only when one of its files is opened, instead of at every VS Code startup.
- Declares support for Restricted Mode (untrusted workspaces) and virtual workspaces.

### Security

- **Content Security Policy** on every webview: `default-src 'none'`, scripts only from the
  extension, no `unsafe-eval`, no inline script, no remote origins. Upstream had none.
- **PDF (pdf.js 3.1.81):**
  - `isEvalSupported` is forced off at every sink, including the font glyph compiler
    (CVE-2024-4367) and the PostScript function compiler.
  - `enableScripting` and `enableXfa` are off.
  - Disabled:
    - URL, `?file=` and drag-and-drop loading;
    - debug hash parameters;
    - stored preferences;
    - downloads and attachment opening;
    - document-triggered printing.
  - Links are rendered only for `http:`, `https:` and `mailto:`, and opened through the extension
    host.
- **Spreadsheets:** cell text in the editor overlay, sheet names, tooltips, menus and filter lists
  are inserted as text, not HTML. Upstream inserted raw cell text with `innerHTML`.
- **Read-only:**
  - Removed the host handlers that wrote webview-supplied bytes over the opened file (`save`,
    `saveAs`) and marked documents dirty (`change`).
  - Excel always opens in read mode; Word opens read-only.
- **Host bridge:**
  - Each viewer has a fixed message allowlist, and internal events can no longer be triggered from
    a page.
  - `openExternal` accepts only `http:`, `https:` and `mailto:`. Upstream passed any URI to
    `env.openExternal`.
  - The F12 developer-tools message is removed.
- **No process launches:** the Windows `git` subprocess for `git:` URIs is removed. Virtual
  documents are read through VS Code's file system API.
- **Configuration** is passed to the page as inert JSON with `<` escaped, instead of inside an
  HTML attribute.
- **Word viewer:** Google Fonts loading is disabled.

### Fixes

- The PDF viewer could fail with `Cannot read properties of null (reading 'setPagesCount')` when
  the document arrived before the viewer finished initialising. This bug was also in upstream.
- PDF link annotations threw because the viewer's link service lacked methods pdf.js 3.1.81 calls.
  Links now work.
- PDF links that pdf.js clones for annotations with several highlight areas had no click
  handler, so clicking them made the browser follow the fragment against `<base>` and leave the
  viewer. Every link click is now cancelled, and cloned internal links are navigated explicitly.
  Middle-clicking an internal link no longer opens a new window.
- Copy from a filtered spreadsheet included the rows the filter hid, in both the plain-text and
  HTML clipboard formats. It now copies only visible rows, and a merged block is copied with its
  value even when its first row is hidden.
- `git:` and other virtual versions of `.pdf`, `.xlsx`, `.xlsm`, `.docx` and `.dotx` files are
  checked for the right file signature. VS Code's git provider can return text-converted content
  (`git show --textconv`), and the viewer now says so instead of failing to parse it.

### Build

- `package-lock.json` is committed, and builds use `npm ci --ignore-scripts`. Upstream ignored its
  lockfile.
- CI builds, type-checks and packages with lifecycle scripts disabled.
- `THIRD_PARTY_NOTICES.md` ships the licence text of every bundled component, including the
  vendored pdf.js (Apache-2.0) and x-spreadsheet (MIT).
- Added a headless-Chromium webview test harness with benign and hostile fixtures in
  `test/webview-harness/` and `test/fixtures/`. It is not shipped in the VSIX.
