// Writes test/fixtures/links.pdf: a two-page PDF with an https link, a javascript: URI link,
// a JavaScript link action, an internal GoTo link, two internal links whose /QuadPoints describe
// two separate areas each (pdf.js renders the second area with a cloned <a> that has no onclick
// handler), and a JavaScript /OpenAction.
// No dependencies; run with `node make-links-pdf.mjs`.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'links.pdf');

const page1Text = [
    'BT /F1 18 Tf 72 740 Td (Link test page one) Tj ET',
    'BT /F1 12 Tf 72 705 Td (https link to example.org) Tj ET',
    'BT /F1 12 Tf 72 665 Td (javascript URI link) Tj ET',
    'BT /F1 12 Tf 72 625 Td (JavaScript action link) Tj ET',
    'BT /F1 12 Tf 72 585 Td (Go to page two) Tj ET',
    'BT /F1 12 Tf 72 545 Td (Quad link part one) Tj 150 0 Td (part two) Tj ET',
    'BT /F1 12 Tf 72 505 Td (Named quad link part one) Tj 150 0 Td (part two) Tj ET',
].join('\n');
const page2Text = 'BT /F1 18 Tf 72 740 Td (Second page target) Tj ET';

const objects = [];
const add = (body) => { objects.push(body); return objects.length; };

const catalog = add(null);
const pages = add(null);
const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
const content1 = add(`<< /Length ${Buffer.byteLength(page1Text)} >>\nstream\n${page1Text}\nendstream`);
const content2 = add(`<< /Length ${Buffer.byteLength(page2Text)} >>\nstream\n${page2Text}\nendstream`);
const page2 = add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content2} 0 R >>`);
const linkHttps = add('<< /Type /Annot /Subtype /Link /Rect [70 700 300 720] /Border [0 0 0] /A << /S /URI /URI (https://example.org/) >> >>');
const linkJsUri = add("<< /Type /Annot /Subtype /Link /Rect [70 660 300 680] /Border [0 0 0] /A << /S /URI /URI (javascript:document.title='XSS-PDF-URI') >> >>");
const linkJsAction = add("<< /Type /Annot /Subtype /Link /Rect [70 620 300 640] /Border [0 0 0] /A << /S /JavaScript /JS (document.title='XSS-PDF-JSACTION'; app.alert\\('XSS-PDF-JSACTION'\\);) >> >>");
const linkGoTo = add(`<< /Type /Annot /Subtype /Link /Rect [70 580 300 600] /Border [0 0 0] /Dest [${page2} 0 R /Fit] >>`);
// Two separate areas inside one /Rect (pdf.js drops /QuadPoints that fall outside the /Rect).
// Explicit destination: href "#[{num..},{name:Fit}]"; named destination: href "#chapter2".
const linkGoToQuads = add(`<< /Type /Annot /Subtype /Link /Rect [70 540 300 560] /QuadPoints [70 560 150 560 70 540 150 540 220 560 300 560 220 540 300 540] /Border [0 0 0] /Dest [${page2} 0 R /Fit] >>`);
const linkNamedQuads = add('<< /Type /Annot /Subtype /Link /Rect [70 500 300 520] /QuadPoints [70 520 150 520 70 500 150 500 220 520 300 520 220 500 300 500] /Border [0 0 0] /Dest (chapter2) >>');
// Annotations are appended so the harness can address them by position (section index 0..7).
const page1 = add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content1} 0 R /Annots [${linkHttps} 0 R ${linkJsUri} 0 R ${linkJsAction} 0 R ${linkGoTo} 0 R ${linkGoToQuads} 0 R ${linkNamedQuads} 0 R] >>`);
objects[pages - 1] = `<< /Type /Pages /Kids [${page1} 0 R ${page2} 0 R] /Count 2 >>`;
objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R /Dests << /chapter2 [${page2} 0 R /Fit] >> /OpenAction << /S /JavaScript /JS (app.alert\\('XSS-PDF-OPEN'\\); this.print\\(\\);) >> >>`;

let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
const offsets = [];
objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(out, Buffer.from(pdf, 'latin1'));
console.log(`wrote ${out}`);
