// Unit tests for the spreadsheet copy matrix (src/react/view/excel/x-spreadsheet/core/clipboard_html.js).
// Run from the repository root: node --test test/unit/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectedCellMatrix, textRowsFromMatrix, formatHtmlClipboard,
} from '../../src/react/view/excel/x-spreadsheet/core/clipboard_html.js';

// Minimal stand-in for DataProxy: cells keyed by data row, a display->data row map for sorting,
// hidden display rows for filtering, and merges in data coordinates.
function fakeData(cells, { merges = [], sortedRowMap = new Map(), exceptRowSet = new Set() } = {}) {
  const dataRow = ri => (sortedRowMap.has(ri) ? sortedRowMap.get(ri) : ri);
  return {
    exceptRowSet,
    sortedRowMap,
    merges: {
      getFirstIncludes(ri, ci) {
        return merges.find(m => ri >= m.sri && ri <= m.eri && ci >= m.sci && ci <= m.eci) || null;
      },
    },
    getCellTextOrDefault: (ri, ci) => (cells[dataRow(ri)] || [])[ci] || '',
    getCellStyleOrDefault: () => ({}),
    defaultStyle: () => ({}),
  };
}
const range = (sri, sci, eri, eci) => ({ sri, sci, eri, eci });
const htmlRows = html => [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(c => c[1]));

test('filtered rows are left out of both formats', () => {
  const data = fakeData([['ID', 'ARM'], ['1', 'P'], ['2', 'D'], ['3', 'P']], { exceptRowSet: new Set([2]) });
  const m = selectedCellMatrix(data, range(0, 0, 3, 1));
  assert.deepEqual(textRowsFromMatrix(m), [['ID', 'ARM'], ['1', 'P'], ['3', 'P']]);
  assert.deepEqual(htmlRows(formatHtmlClipboard(data, range(0, 0, 3, 1), m)), [['ID', 'ARM'], ['1', 'P'], ['3', 'P']]);
});

test('sorted rows with a merge: no value is lost and both formats agree', () => {
  // Data row 1 is merged A2:B2; display order swaps rows 1 and 2.
  const data = fakeData([['H1', 'H2'], ['MERGED', ''], ['OTHER-A', 'OTHER-B']], {
    merges: [{ sri: 1, eri: 1, sci: 0, eci: 1 }],
    sortedRowMap: new Map([[1, 2], [2, 1]]),
  });
  const m = selectedCellMatrix(data, range(1, 0, 2, 1));
  const text = textRowsFromMatrix(m);
  assert.deepEqual(text, [['OTHER-A', 'OTHER-B'], ['MERGED', '']]);
  assert.deepEqual(htmlRows(formatHtmlClipboard(data, range(1, 0, 2, 1), m)), text);
});

test('unsorted, unfiltered merge keeps its span and value', () => {
  const data = fakeData([['A', ''], ['', ''], ['x', 'y']], { merges: [{ sri: 0, eri: 1, sci: 0, eci: 1 }] });
  const r = range(0, 0, 2, 1);
  const html = formatHtmlClipboard(data, r);
  assert.match(html, /<td rowspan="2" colspan="2"[^>]*>A<\/td>/);
  assert.deepEqual(textRowsFromMatrix(selectedCellMatrix(data, r)), [['A', ''], ['', ''], ['x', 'y']]);
});

test('selection clipped inside a merge carries the merge value in both formats', () => {
  const data = fakeData([['TOP', '', ''], ['', '', ''], ['p', 'q', 'r']], { merges: [{ sri: 0, eri: 1, sci: 0, eci: 2 }] });
  const r = range(1, 1, 2, 2);
  const m = selectedCellMatrix(data, r);
  assert.deepEqual(textRowsFromMatrix(m), [['TOP', ''], ['q', 'r']]);
  assert.match(formatHtmlClipboard(data, r, m), /<td colspan="2"[^>]*>TOP<\/td>/);
});

test('hidden merge owner row: formats agree (merges are not reproduced under a filter)', () => {
  const data = fakeData([['LABEL', 'b'], ['', 'c'], ['x', 'y']], {
    merges: [{ sri: 0, eri: 1, sci: 0, eci: 0 }], exceptRowSet: new Set([0]),
  });
  const r = range(0, 0, 2, 1);
  const m = selectedCellMatrix(data, r);
  const text = textRowsFromMatrix(m);
  assert.deepEqual(text, [['', 'c'], ['x', 'y']]);
  assert.deepEqual(htmlRows(formatHtmlClipboard(data, r, m)), text);
});

test('cell text is HTML-escaped', () => {
  const data = fakeData([['<img src=x onerror=alert(1)>']]);
  assert.doesNotMatch(formatHtmlClipboard(data, range(0, 0, 0, 0)), /<img/);
});
