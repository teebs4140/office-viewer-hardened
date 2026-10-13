# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub: on this repository's **Security** tab,
choose **Report a vulnerability**. Please don't open a public issue for a security problem.

Include the affected version, what an attacker would need to control (usually a crafted file), and
what you observed. A sample file that reproduces the issue is the most useful thing to send.

If the issue is also present upstream, please report it to
https://github.com/cweijan/vscode-office as well.

## Threat model

The files this extension opens may come from outside your organisation, so **file content is
untrusted input**. This includes cell values, sheet names, hyperlinks, document text and fields,
and anything inside a PDF. The extension is designed so that a crafted file cannot:

- **Run script in the viewer.** Every viewer page has a Content Security Policy with
  `default-src 'none'`. Scripts load only from the extension's own files: no `unsafe-eval`, no
  inline script. Spreadsheet and document text is inserted as text, never as HTML.
- **Make network requests.** The policy allows no remote origin. The Word renderer's Google Fonts
  loading is turned off, and the extension has no telemetry.
- **Change files.** The extension is a viewer. The host side contains no file-write calls, and
  editing features are disabled.
- **Reach VS Code beyond what each viewer needs.** The extension host accepts only an allowlist of
  messages from each viewer: `init`, `openExternal`, and, for CSV/TSV, `editInVSCode`, which reopens
  the same file in the text editor. `openExternal` opens only `http:`, `https:` and `mailto:`
  URLs. The viewers cannot run VS Code commands.
- **Launch programs.** The extension contains no `child_process` usage.

### pdf.js

The PDF viewer is still a customised build of **pdf.js 3.1.81**. It has not been upgraded.
CVE-2024-4367 is **mitigated by configuration**:

- `isEvalSupported` is forced to `false` everywhere pdf.js reads it.
- `enableScripting` and `enableXfa` are off.
- The Content Security Policy has no `unsafe-eval`.

Each of these blocks the CVE's code path on its own. The viewer can't load URLs or other files,
download, open attachments, or print automatically. External links go through `openExternal`.

## What is still trusted

- The npm packages bundled into the extension, pinned in `package-lock.json` (see `NOTICE.md`),
  and the vendored pdf.js and x-spreadsheet code.
- VS Code's webview isolation, and its enforcement of the Content Security Policy and
  `localResourceRoots`.

`localResourceRoots` includes the folder of the file being viewed, which is how the viewer reads
the file. A page could therefore read other files in that folder. With no script execution and no
network origin, nothing could be sent anywhere. Narrowing this further is a possible future change.

## Verifying what you installed

Each release is a `.vsix` with its SHA-256 in the release notes:

```bash
sha256sum office-viewer-hardened-<version>.vsix
```

To go further, rebuild from the tagged source (`npm ci --ignore-scripts`,
`npx vite build --mode=production`, `npx @vscode/vsce package --no-dependencies`) and compare the
package contents.
