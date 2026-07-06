import path from 'path';

type Workbook = any;
type Worksheet = any;

export function assertModernSpreadsheet(filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xls') {
    throw new Error('Legacy .xls files are not supported by the safe spreadsheet reader. Convert the file to .xlsx or .csv first.');
  }
  if (ext !== '.xlsx') {
    throw new Error(`Unsupported spreadsheet format: ${ext || '(none)'}. Supported: .xlsx`);
  }
}

async function createWorkbook(): Promise<Workbook> {
  const mod: any = await import('exceljs');
  const ExcelJS = mod.default || mod;
  return new ExcelJS.Workbook();
}

export async function loadXlsxWorkbook(filePath: string): Promise<Workbook> {
  assertModernSpreadsheet(filePath);
  const workbook = await createWorkbook();
  await workbook.xlsx.readFile(filePath);
  return workbook;
}

export async function writeXlsxWorkbook(workbook: Workbook, filePath: string): Promise<void> {
  await workbook.xlsx.writeFile(filePath);
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

export function worksheetToCsv(worksheet: Worksheet): string {
  const lines: string[] = [];
  const columnCount = Math.max(worksheet.columnCount || 0, worksheet.actualColumnCount || 0);

  worksheet.eachRow({ includeEmpty: false }, (row: any) => {
    const fields: string[] = [];
    for (let col = 1; col <= columnCount; col++) {
      fields.push(escapeCsvField(row.getCell(col).value));
    }
    while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
    if (fields.length > 0) lines.push(fields.join(','));
  });

  return lines.join('\n');
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

export function applySpreadsheetOperations(workbook: Workbook, operations: any[]): void {
  for (const op of operations) {
    if (op.addSheet) {
      const sheetName = normalizeSheetName(op.sheet, `Sheet${workbook.worksheets.length + 1}`);
      const worksheet = workbook.addWorksheet(sheetName);
      if (Array.isArray(op.headers) && op.headers.length > 0) worksheet.addRow(op.headers);
      for (const row of op.data || []) {
        worksheet.addRow(Array.isArray(row) ? row : Object.values(row || {}));
      }
      continue;
    }

    const worksheet = getWorksheetOrThrow(workbook, op.sheet);
    worksheet.getCell(op.cell || 'A1').value = op.value ?? null;
  }
}
