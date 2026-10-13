# Office Viewer for VS Code (Hardened Fork)

> **This is a security-hardened, cut-down fork** of [Office Viewer](https://github.com/cweijan/vscode-office)
> by Weijan Chen, forked from upstream 4.2.0. All credit for the original work belongs to the upstream
> author. This fork is not affiliated with or endorsed by them.
>
> It keeps only the viewers for **CSV/TSV, Excel (.xlsx, .xlsm), Word (.docx, .dotx) and PDF**, and
> hardens them for opening files that come from outside your organisation:
>
> - **No network access from the viewers.** Every page has a strict Content Security Policy with no
>   remote origins. The extension has no telemetry.
> - **Document content can't run script.** pdf.js eval and scripting are off, which mitigates
>   CVE-2024-4367. Spreadsheet and document text is rendered as text, never as HTML.
> - **Read-only.** The extension never writes to the file you open, or to any other file.
> - **A narrow bridge to VS Code.** Each viewer may send only the few messages it needs. Links open
>   only if they are `http:`, `https:` or `mailto:`.
>
> See [`CHANGELOG.md`](CHANGELOG.md) for the changes, [`SECURITY.md`](SECURITY.md) for the threat
> model and how to verify a download, and [`NOTICE.md`](NOTICE.md) for attribution.

## Installation

See **[INSTALL.md](INSTALL.md)**. In short: download the `.vsix` from
[Releases](https://github.com/teebs4140/office-viewer-hardened/releases), check its SHA-256 against
the release notes, then use **Extensions → `...` → Install from VSIX...**.

The extension ID is `dcri-biostats.office-viewer-hardened` and the editor ID is
`officeViewerHardened.viewer`. Neither collides with upstream, so the two can be installed side by
side. If you do that, pick the default viewer with `workbench.editorAssociations` (see INSTALL.md).

## What it does

| File | Viewer |
|---|---|
| `.csv`, `.tsv` | Spreadsheet grid with find, column auto-fit and copy |
| `.xlsx`, `.xlsm` | The same grid, with sheet tabs and cell formatting |
| `.docx`, `.dotx` | Read-only Word rendering with zoom |
| `.pdf` | pdf.js viewer with thumbnails, search and zoom |

Not supported: `.xls`/`.ods` (save as `.xlsx`), RTF, legacy `.doc`, editing, and all the other
upstream features (Markdown editor, archive viewer, Git history, REST client, PowerPoint and more).

## Building from source

```bash
npm ci --ignore-scripts
npx vite build --mode=production
npx @vscode/vsce package --no-dependencies
sha256sum office-viewer-hardened-*.vsix
```

The headless webview test harness is in [`test/webview-harness/`](test/webview-harness/README.md).

## License

MIT, unchanged from upstream. See [`LICENSE`](LICENSE).
