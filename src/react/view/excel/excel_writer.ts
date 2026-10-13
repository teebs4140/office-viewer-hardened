import ExcelJS from '@cweijan/exceljs';
import JSZip from 'jszip';
import { handler } from "../../util/vscode";
import Spreadsheet from './x-spreadsheet/index';
import type { RowData, SheetData } from './x-spreadsheet/index';
import { CsvEncoding, encodeCsvText } from './csvEncoding';
import { DEFAULT_ROW_HEIGHT_PX, freezeExprToExcelView, pxToExcelRowHeight } from './excel_meta';
import { patchWorksheetSortStateXml } from './excel_sort_state';
import { applySpreadsheetStyle } from './excel_styles';
import { hyperlinkKey, writeCellHyperlink, type SpreadsheetHyperlink } from './excel_hyperlink';
import { writeWorksheetValidations } from './excel_validation';
import { writeWorksheetProtection } from './excel_protection';
import { writeWorksheetImages } from './excel_images';

const DEFAULT_COL_WIDTH = 100;

export { buildFormattingSnapshot, hasFormattingChanged } from './excel_meta';

export interface ExportOptions {
    /** 通过另存为对话框保存，而非覆盖当前文件 */
    saveAs?: boolean;
    /** saveAs 时指定目标格式 */
    saveAsExt?: string;
}

function isRowData(row: RowData | number | undefined): row is RowData {
    return row != null && typeof row === 'object';
}

function getColWidth(cols: SheetData['cols'], ci: number) {
    const col = cols?.[ci];
    if (col && typeof col === 'object' && col.width != null) return col.width;
    return DEFAULT_COL_WIDTH;
}

function pxToExcelColWidth(px: number) {
    return Math.max((px - 5) / 7, 0);
}

function setCellValue(cell: ExcelJS.Cell, text: string) {
    if (!text) {
        cell.value = null;
        return;
    }
    if (text.startsWith('=')) {
        cell.value = { formula: text.slice(1) };
        return;
    }
    const num = Number(text);
    if (text.trim() !== '' && !Number.isNaN(num) && String(num) === text.trim()) {
        cell.value = num;
        return;
    }
    cell.value = text;
}

function applySheetMeta(worksheet: ExcelJS.Worksheet, sheetData: SheetData) {
    if (sheetData.freeze) {
        const frozen = freezeExprToExcelView(sheetData.freeze);
        if (frozen) {
            worksheet.views = [{
                state: 'frozen',
                xSplit: frozen.xSplit,
                ySplit: frozen.ySplit,
                topLeftCell: sheetData.freeze,
            }];
        }
    }

    const autofilter = sheetData.autofilter;
    if (autofilter?.ref) {
        worksheet.autoFilter = autofilter.ref;
    }
}

function writeRowHeights(worksheet: ExcelJS.Worksheet, rows: SheetData['rows']) {
    if (!rows?.len) return;
    for (let ri = 0; ri < rows.len; ri += 1) {
        const row = rows[ri];
        if (!isRowData(row) || row.height == null) continue;
        if (Math.abs(row.height - DEFAULT_ROW_HEIGHT_PX) < 1) continue;
        worksheet.getRow(ri + 1).height = pxToExcelRowHeight(row.height);
    }
}

async function writeSheetToExcelJs(worksheet: ExcelJS.Worksheet, workbook: ExcelJS.Workbook, sheetData: SheetData) {
    const { rows, cols, styles = [], merges = [], hyperlinks = {}, validations } = sheetData;

    if (cols?.len) {
        for (let ci = 0; ci < cols.len; ci += 1) {
            worksheet.getColumn(ci + 1).width = pxToExcelColWidth(getColWidth(cols, ci));
        }
    }

    for (let i = 0; i < merges.length; i += 1) {
        worksheet.mergeCells(merges[i]);
    }

    applySheetMeta(worksheet, sheetData);
    writeRowHeights(worksheet, rows);
    writeWorksheetValidations(worksheet, validations);

    if (!rows) return;

    const rowLen = rows.len ?? 0;
    for (let ri = 0; ri < rowLen; ri += 1) {
        const row = rows[ri];
        if (!isRowData(row) || !row.cells) continue;
        for (const ciKey of Object.keys(row.cells)) {
            const ci = Number(ciKey);
            if (Number.isNaN(ci)) continue;
            const cellData = row.cells[ci];
            const excelCell = worksheet.getCell(ri + 1, ci + 1);
            const hl = hyperlinks[hyperlinkKey(ri, ci)] as SpreadsheetHyperlink | undefined;
            if (hl?.link) {
                writeCellHyperlink(excelCell, cellData.text ?? '', hl);
            } else {
                setCellValue(excelCell, cellData.text ?? '');
            }
            if (cellData.style != null && styles[cellData.style]) {
                applySpreadsheetStyle(excelCell, styles[cellData.style]);
            }
        }
    }

    writeWorksheetImages(worksheet, workbook, sheetData.images, sheetData.backgroundImage);
    await writeWorksheetProtection(worksheet, sheetData);
}

async function emitSave(buffer: Uint8Array, options?: ExportOptions) {
    const content = [...buffer];
    if (options?.saveAs) {
        handler.emit('saveAs', { content, ext: options.saveAsExt ?? 'xlsx' });
        return;
    }
    handler.emit('save', content);
}

async function patchWorkbookSortStates(buffer: Uint8Array, sheets: SheetData[]) {
    const zip = await JSZip.loadAsync(buffer);
    for (let i = 0; i < sheets.length; i += 1) {
        const file = zip.file(`xl/worksheets/sheet${i + 1}.xml`);
        if (!file) continue;
        const xml = await file.async('string');
        zip.file(`xl/worksheets/sheet${i + 1}.xml`, patchWorksheetSortStateXml(xml, sheets[i].autofilter));
    }
    return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

async function exportWithExcelJs(sheets: SheetData[], options?: ExportOptions) {
    const workbook = new ExcelJS.Workbook();
    for (let i = 0; i < sheets.length; i += 1) {
        const sheetData = sheets[i];
        const worksheet = workbook.addWorksheet(sheetData.name || `Sheet${i + 1}`);
        await writeSheetToExcelJs(worksheet, workbook, sheetData);
    }
    const buffer = new Uint8Array(await workbook.xlsx.writeBuffer());
    const patched = await patchWorkbookSortStates(buffer, sheets);
    await emitSave(patched, options);
}

function quoteCsvField(text: string, delimiter: string) {
    // Same quoting rules SheetJS used for CSV export, plus quoting of bare carriage returns.
    if (text === 'ID') return '"ID"';
    if (text.includes(delimiter) || /["\r\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

/** Serialise the cell text of one sheet as delimited text (rows joined with "\n"). */
function sheetToDelimitedText(xws: SheetData, delimiter: string): string {
    const grid: string[][] = [];
    let maxCol = -1;
    const rowobj = xws.rows;
    if (rowobj?.len) {
        for (let ri = 0; ri < rowobj.len; ri += 1) {
            const row = rowobj[ri];
            if (!isRowData(row)) continue;
            for (const ciKey of Object.keys(row.cells ?? {})) {
                const ci = Number(ciKey);
                if (Number.isNaN(ci)) continue;
                const text = row.cells[ci]?.text;
                if (text == null) continue;
                (grid[ri] ??= [])[ci] = String(text);
                if (ci > maxCol) maxCol = ci;
            }
        }
    }
    if (maxCol < 0) return '';
    const lines: string[] = [];
    for (let ri = 0; ri < grid.length; ri += 1) {
        const fields: string[] = [];
        for (let ci = 0; ci <= maxCol; ci += 1) {
            fields.push(quoteCsvField(grid[ri]?.[ci] ?? '', delimiter));
        }
        lines.push(fields.join(delimiter));
    }
    return lines.join('\n');
}

export async function exportSaveAs(
    spreadSheet: Spreadsheet,
    targetExt: string,
    csvEncoding: CsvEncoding = 'utf8',
    csvDelimiter: string = ',',
) {
    const ext = targetExt.replace('.', '').toLowerCase();
    const sheets = spreadSheet.getData();
    if (ext === 'xlsx' || ext === 'xlsm') {
        await exportWithExcelJs(sheets, { saveAs: true, saveAsExt: ext });
        return;
    }
    if (ext === 'csv' || ext === 'tsv') {
        const fs = ext === 'tsv' ? '\t' : csvDelimiter;
        const csvContent = sheetToDelimitedText(sheets[0], fs);
        const bytes = encodeCsvText(csvContent, csvEncoding);
        handler.emit('saveAs', { content: [...bytes], ext });
    }
}

export async function export_xlsx(
    spreadSheet: Spreadsheet,
    extName: string,
    csvEncoding: CsvEncoding = 'utf8',
    options?: ExportOptions,
    csvDelimiter: string = ',',
) {
    const ext = extName.replace('.', '').toLowerCase();
    const sheets = spreadSheet.getData();

    if (ext === 'xlsx' || ext === 'xlsm' || options?.saveAs) {
        await exportWithExcelJs(sheets, options?.saveAs ? { saveAs: true } : undefined);
        return;
    }
    if (ext === 'csv' || ext === 'tsv') {
        const fs = ext === 'tsv' ? '\t' : csvDelimiter;
        const csvContent = sheetToDelimitedText(sheets[0], fs);
        const bytes = encodeCsvText(csvContent, csvEncoding);
        handler.emit('save', [...bytes]);
    }
}
