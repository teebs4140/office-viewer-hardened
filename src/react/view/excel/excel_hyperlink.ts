import type * as ExcelJS from '@cweijan/exceljs';

export interface SpreadsheetHyperlink {
    link: string;
    tooltip?: string;
}

export type HyperlinkMap = Record<string, SpreadsheetHyperlink>;

export function hyperlinkKey(ri: number, ci: number): string {
    return `${ri}_${ci}`;
}

export function parseHyperlinkKey(key: string): { ri: number; ci: number } | null {
    const parts = key.split('_');
    if (parts.length !== 2) return null;
    const ri = Number(parts[0]);
    const ci = Number(parts[1]);
    if (Number.isNaN(ri) || Number.isNaN(ci)) return null;
    return { ri, ci };
}

export function readCellHyperlink(cell: ExcelJS.Cell, ri: number, ci: number): HyperlinkMap {
    const value = cell.value;
    let link = '';
    let tooltip: string | undefined;
    if (value && typeof value === 'object' && 'hyperlink' in value) {
        const hv = value as ExcelJS.CellHyperlinkValue;
        link = hv.hyperlink ?? '';
        tooltip = hv.tooltip;
    } else if (cell.isHyperlink && cell.hyperlink) {
        link = cell.hyperlink;
    }
    if (!link) return {};
    return { [hyperlinkKey(ri, ci)]: { link, tooltip } };
}

export function mergeHyperlinkMaps(...maps: HyperlinkMap[]): HyperlinkMap {
    const out: HyperlinkMap = {};
    for (let i = 0; i < maps.length; i += 1) {
        const map = maps[i];
        for (const key of Object.keys(map)) {
            out[key] = map[key];
        }
    }
    return out;
}

export type ParsedLink =
    | { type: 'external'; url: string }
    | { type: 'internal'; sheetName: string; ref: string }
    | { type: 'unsupported' };

export function parseSpreadsheetLink(link: string): ParsedLink {
    const trimmed = link.trim();
    if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) {
        return { type: 'external', url: trimmed };
    }
    const quoted = trimmed.match(/^#?'([^']+)'!([A-Za-z]+\d+)$/);
    if (quoted) {
        return { type: 'internal', sheetName: quoted[1], ref: quoted[2].toUpperCase() };
    }
    const plain = trimmed.match(/^#?([^!]+)!([A-Za-z]+\d+)$/);
    if (plain) {
        return { type: 'internal', sheetName: plain[1], ref: plain[2].toUpperCase() };
    }
    // Hyperlink targets come from the workbook: anything that is not http(s)/mailto or an
    // in-workbook reference (javascript:, data:, file:, vscode:, command:, UNC paths, ...) is not opened.
    return { type: 'unsupported' };
}
