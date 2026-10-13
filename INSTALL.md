# Installing Office Viewer (Hardened Fork)

View CSV/TSV, Excel (.xlsx, .xlsm), Word (.docx, .dotx) and PDF files inside VS Code. It's a
viewer only: it never changes the file you open.

It takes about two minutes.

---

## Step 1: Get the file

Download **`office-viewer-hardened-<version>.vsix`** from the
[Releases page](https://github.com/teebs4140/office-viewer-hardened/releases).

## Step 2: Check you got the right file (optional, 10 seconds)

This confirms nobody tampered with the file in transit. Open a terminal where you saved it:

**macOS / Linux**
```bash
shasum -a 256 office-viewer-hardened-<version>.vsix
```

**Windows (PowerShell)**
```powershell
Get-FileHash office-viewer-hardened-<version>.vsix -Algorithm SHA256
```

The result should match the SHA-256 in the release notes. If it doesn't, don't install it.

## Step 3: Install it

**Using the Extensions panel:**

1. Open VS Code.
2. Click the **Extensions** icon in the left sidebar (or press `Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Click the **`...`** menu at the top of the Extensions panel.
4. Choose **Install from VSIX...**
5. Select the `.vsix` file you downloaded.
6. Reload VS Code if prompted.

**Using a terminal:**

```bash
code --install-extension office-viewer-hardened-<version>.vsix
```

If you work over Remote-SSH, install it while connected to the remote host. VS Code then installs
it on the remote side, where your files are.

## Step 4: Open a file

Double-click a `.csv`, `.tsv`, `.xlsx`, `.xlsm`, `.docx`, `.dotx` or `.pdf` file in VS Code's
file explorer. It opens in the viewer.

To see a CSV as plain text instead, right-click it and choose **Open With...** → **Text Editor**.

---

## If another viewer extension is installed

Other extensions, such as the original Office Viewer or Syncfusion Document Viewer, may also claim
these file types. Add this to your VS Code `settings.json` to make this viewer the default:

```jsonc
"workbench.editorAssociations": {
  "*.csv": "officeViewerHardened.viewer",
  "*.tsv": "officeViewerHardened.viewer",
  "*.xlsx": "officeViewerHardened.viewer",
  "*.xlsm": "officeViewerHardened.viewer",
  "*.docx": "officeViewerHardened.viewer",
  "*.dotx": "officeViewerHardened.viewer",
  "*.pdf": "officeViewerHardened.viewer"
}
```

This only sets the default. Any installed viewer can still be picked with **Reopen Editor
With...**. If you installed this fork to avoid another viewer's security problems, uninstall that
viewer.

---

## What's not supported

- **.xls and .ods**: save as .xlsx instead. In SAS, use `ods excel` or `proc export ... dbms=xlsx`.
- **RTF and legacy .doc**: not supported.
- **Editing**: this is a viewer. To change a CSV, reopen it in the text editor.
- **PowerPoint, Markdown, archives and the other upstream viewers**: removed in this fork.

---

## Why this is a fork

This is a security-hardened build of the community
[Office Viewer](https://github.com/cweijan/vscode-office) extension. Details are in
[`CHANGELOG.md`](CHANGELOG.md), [`SECURITY.md`](SECURITY.md) and [`NOTICE.md`](NOTICE.md).

**Your files stay on your machine.** The viewer makes no network requests and collects no
telemetry.
