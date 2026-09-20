import path from 'path';
import fs from 'fs/promises';
import ExcelJSModule from 'exceljs/dist/exceljs.min.js';
import JSZip from 'jszip';
import { generatedCellValue, recalculateSpreadsheet } from './spreadsheet_formulas';
import { addSpreadsheetCharts, preserveSpreadsheetCharts, type SheetCharts } from './spreadsheet_charts';

type Workbook = any;
type Worksheet = any;
const originalPackages = new WeakMap<object, JSZip>();

export function assertModernSpreadsheet(filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xls') {
    throw new Error('Legacy .xls files are not supported by the safe spreadsheet reader. Convert the file to .xlsx or .csv first.');
  }
  if (ext !== '.xlsx') {
    throw new Error(`Unsupported spreadsheet format: ${ext || '(none)'}. Supported: .xlsx`);
  }
}

export async function createXlsxWorkbook(): Promise<Workbook> {
  const ExcelJS: any = ExcelJSModule;
  return new ExcelJS.Workbook();
}

export async function loadXlsxWorkbook(filePath: string): Promise<Workbook> {
  assertModernSpreadsheet(filePath);
  const workbook = await createXlsxWorkbook();
  const buffer = await fs.readFile(filePath);
  await workbook.xlsx.load(buffer);
  originalPackages.set(workbook, await JSZip.loadAsync(buffer));
  return workbook;
}

export async function writeXlsxWorkbook(workbook: Workbook, filePath: string, charts: SheetCharts[] = []): Promise<{ formulaCount: number; totalFormulaCount: number; chartCount: number; unresolvedFormulas: string[]; calculatedCells: Array<{ sheet: string; cell: string; value: number; label?: string }> }> {
  const calculation = recalculateSpreadsheet(workbook);
  const buffer = await workbook.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(buffer);
  const original = originalPackages.get(workbook);
  const preserved = original ? await preserveSpreadsheetCharts(original, zip, workbook) : 0;
  const added = await addSpreadsheetCharts(zip, workbook, charts);
  await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const calculatedCells: Array<{ sheet: string; cell: string; value: number; label?: string }> = [];
  let totalFormulaCount = 0;
  workbook.eachSheet((sheet: any) => sheet.eachRow((row: any) => row.eachCell((cell: any) => {
    // i18n-allow: Spreadsheet aggregate-label data recognition.
    if (cell.formula && (row.values || []).some((value: unknown) => typeof value === 'string'
      && /^(?:总计|合计|总金额|总额|总价|总费用|grand\s+total|total(?:\s+(?:amount|cost|price))?)[:：\s]*$/iu.test(value.trim()))) totalFormulaCount++;
    if (calculatedCells.length < 80 && cell.formula && typeof cell.result === 'number' && Number.isFinite(cell.result)) {
      const label = typeof row.getCell(1).value === 'string' ? row.getCell(1).value.trim().slice(0, 120) : '';
      calculatedCells.push({ sheet: sheet.name, cell: cell.address, value: cell.result, ...(label ? { label } : {}) });
    }
  })));
  return { ...calculation, totalFormulaCount, chartCount: preserved + added, calculatedCells };
}

function cellValueToText(value: any): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value.richText)) {
    return value.richText.map((part: any) => String(part?.text ?? '')).join('');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'result')) {
    return cellValueToText(value.result);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'text')) {
    return cellValueToText(value.text);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'hyperlink')) {
    return cellValueToText(value.text || value.hyperlink);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'formula')) {
    return cellValueToText(value.formula);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'error')) {
    return cellValueToText(value.error);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function escapeCsvField(value: any): string {
  const text = cellValueToText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function worksheetToCsv(worksheet: Worksheet, options: { startRow?: number; endRow?: number } = {}): string {
  const lines: string[] = [];
  const columnCount = Math.max(worksheet.columnCount || 0, worksheet.actualColumnCount || 0);

  worksheet.eachRow({ includeEmpty: false }, (row: any, rowNumber: number) => {
    if (rowNumber < (options.startRow ?? 1) || rowNumber > (options.endRow ?? Infinity)) return;
    const fields: string[] = [];
    for (let col = 1; col <= columnCount; col++) {
      fields.push(escapeCsvField(row.getCell(col).value));
    }
    while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
    if (fields.length > 0) lines.push(fields.join(','));
  });

  return lines.join('\n');
}

export function worksheetToCsvPage(worksheet: Worksheet, startRow: number, maxRows: number, maxChars = 10000): {
  csv: string; endRow: number; totalRows: number; hasMore: boolean;
} {
  const totalRows = worksheet.rowCount;
  const columnCount = Math.max(worksheet.columnCount || 0, worksheet.actualColumnCount || 0);
  const lines: string[] = [];
  let length = 0;
  let endRow = Math.min(startRow - 1, totalRows);
  for (let index = startRow; index <= Math.min(totalRows, startRow + maxRows - 1); index++) {
    const row = worksheet.getRow(index);
    const fields = Array.from({ length: columnCount }, (_, col) => escapeCsvField(row.getCell(col + 1).value));
    while (fields.length && fields[fields.length - 1] === '') fields.pop();
    const line = fields.join(',');
    if (lines.length && length + 1 + line.length > maxChars) break;
    endRow = index;
    if (!fields.length) continue;
    lines.push(line);
    length += line.length + (lines.length > 1 ? 1 : 0);
  }
  return { csv: lines.join('\n'), endRow, totalRows, hasMore: endRow < totalRows };
}

export function getWorksheetNames(workbook: Workbook): string[] {
  return workbook.worksheets.map((worksheet: Worksheet) => worksheet.name);
}

export function getWorksheetOrThrow(workbook: Workbook, sheetName: string): Worksheet {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" not found. Available: ${getWorksheetNames(workbook).join(', ')}`);
  }
  return sheet;
}

export async function workbookToText(filePath: string, options: { blankSections?: boolean } = {}): Promise<string> {
  const workbook = await loadXlsxWorkbook(filePath);
  return workbook.worksheets
    .map((worksheet: Worksheet) => {
      const csv = worksheetToCsv(worksheet);
      if (!csv.trim() && !options.blankSections) return '';
      return [`[${worksheet.name}]`, csv].filter(Boolean).join('\n');
    })
    .filter((section: string) => section.trim().length > 0)
    .join('\n\n');
}

function normalizeSheetName(name: string, fallback: string): string {
  return String(name || fallback).replace(/[\[\]:*?/\\]/g, '_').slice(0, 31) || fallback;
}

/** Object rows are keyed records, never positional Object.values arrays. */
export function prepareSpreadsheetRows(headers: string[] = [], data: any[] = []): { headers: string[]; rows: any[][] } {
  const objectRows = data.filter(row => row && !Array.isArray(row) && typeof row === 'object');
  const keys = headers.length ? headers : [...new Set(objectRows.flatMap(row => Object.keys(row)))];
  for (const row of objectRows) {
    const unknown = Object.keys(row).filter(key => !keys.includes(key));
    if (unknown.length) throw new Error(`Object row fields are missing from headers: ${unknown.join(', ')}. Use field names as headers or omit headers to infer them.`);
  }
  return {
    headers: keys,
    rows: data.map(row => {
      if (Array.isArray(row)) return row.map(generatedCellValue);
      if (!row || typeof row !== 'object') throw new Error('Spreadsheet data rows must be arrays or objects.');
      return keys.map(key => generatedCellValue(Object.prototype.hasOwnProperty.call(row, key) ? row[key] ?? null : null));
    }),
  };
}

export function applySpreadsheetOperations(workbook: Workbook, operations: any[]): Array<{ sheet: string; cell: string; previous: any; value: any }> {
  const edits: Array<{ sheet: string; cell: string; previous: any; value: any }> = [];
  for (const op of operations) {
    if (op.addSheet) {
      const sheetName = normalizeSheetName(op.sheet, `Sheet${workbook.worksheets.length + 1}`);
      const worksheet = workbook.addWorksheet(sheetName);
      const prepared = prepareSpreadsheetRows(op.headers || [], op.data || []);
      if (prepared.headers.length > 0) worksheet.addRow(prepared.headers);
      for (const row of prepared.rows) worksheet.addRow(row);
      continue;
    }

    const worksheet = getWorksheetOrThrow(workbook, op.sheet);
    let address = op.cell;
    if (op.match !== undefined || op.column !== undefined) {
      if (address) throw new Error('Use either an exact cell or a row/column selector, not both.');
      if (!op.match || typeof op.match.column !== 'string' || typeof op.column !== 'string'
        || op.match.value === undefined) throw new Error('A label edit requires match.column, match.value and column.');
      const headerRow = op.headerRow ?? 1;
      if (!Number.isSafeInteger(headerRow) || headerRow < 1 || headerRow > worksheet.rowCount) throw new Error('Invalid headerRow.');
      const text = (value: any) => cellValueToText(value).normalize('NFKC').trim();
      const columnIndex = (label: string) => {
        const matches: number[] = [];
        worksheet.getRow(headerRow).eachCell((cell: any, index: number) => {
          if (text(cell.value) === text(label)) matches.push(index);
        });
        if (matches.length !== 1) throw new Error(`Column label must match exactly one header: ${label} (${matches.length} matches).`);
        return matches[0];
      };
      const keyColumn = columnIndex(op.match.column), valueColumn = columnIndex(op.column);
      const rows: number[] = [];
      worksheet.eachRow((row: any, index: number) => {
        if (index > headerRow && text(row.getCell(keyColumn).value) === text(op.match.value)) rows.push(index);
      });
      if (rows.length !== 1) throw new Error(`Row selector must match exactly one data row (${rows.length} matches).`);
      address = worksheet.getRow(rows[0]).getCell(valueColumn).address;
    }
    if (!address) throw new Error('A cell address or exact row/column selector is required for spreadsheet edits.');
    const cell = worksheet.getCell(address), previous = cell.value;
    cell.value = generatedCellValue(op.value ?? null);
    edits.push({ sheet: worksheet.name, cell: cell.address, previous, value: cell.value });
  }
  return edits;
}
