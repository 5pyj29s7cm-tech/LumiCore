import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatDocumentPreview } from '../../shared/chat_artifacts';
import { loadXlsxWorkbook } from '../utils/spreadsheet';
import { extractPptxText } from '../knowledge/pptx';

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

function table(text: string, delimiter = ','): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  let truncated = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === delimiter || char === '\n' || char === '\r')) {
      if (row.length < 50) row.push(field.slice(0, 4000)); else truncated = true;
      if (field.length > 4000) truncated = true;
      field = '';
      if (char !== delimiter) {
        rows.push(row); row = [];
        if (char === '\r' && text[i + 1] === '\n') i++;
        if (rows.length >= 200) return { rows, truncated: i < text.length - 1 || truncated };
      }
    } else field += char;
  }
  if (field || row.length) {
    if (row.length < 50) row.push(field.slice(0, 4000)); else truncated = true;
    rows.push(row);
  }
  return { rows, truncated };
}

/** A local, bounded content preview. Never run macros, HTML, formulas or model calls. */
export async function readDocumentPreview(filePath: string): Promise<ChatDocumentPreview> {
  const extension = path.extname(filePath).toLowerCase();
  const stats = await fs.stat(filePath);
  if (/^\.(txt|md|json|csv|tsv|html|log|xml|yaml|yml|css|js|ts|tsx|jsx|py|dxf)$/.test(extension)) {
    const handle = await fs.open(filePath, 'r');
    let text: string;
    try {
      const buffer = Buffer.alloc(Math.min(stats.size, MAX_TEXT_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString('utf16le') : bytes.toString('utf8');
      text = text.replace(/^\uFEFF/, '');
    } finally { await handle.close(); }
    if (extension === '.csv' || extension === '.tsv') {
      const parsed = table(text, extension === '.tsv' ? '\t' : ',');
      return { kind: 'table', sections: [{ name: path.basename(filePath), rows: parsed.rows }],
        truncated: parsed.truncated || stats.size > MAX_TEXT_BYTES };
    }
    return { kind: 'text', text, truncated: stats.size > MAX_TEXT_BYTES };
  }
  if (stats.size > MAX_DOCUMENT_BYTES) return { kind: 'unsupported', truncated: true };
  if (extension === '.xlsx') {
    const workbook = await loadXlsxWorkbook(filePath);
    let truncated = workbook.worksheets.length > 8;
    const sections = workbook.worksheets.slice(0, 8).map((sheet: any) => {
      const rows: string[][] = [];
      truncated ||= sheet.rowCount > 200 || sheet.columnCount > 50;
      for (let r = 1; r <= Math.min(sheet.rowCount, 200); r++) {
        const row: string[] = [];
        for (let c = 1; c <= Math.min(sheet.columnCount, 50); c++) {
          const text = String(sheet.getCell(r, c).text || '');
          truncated ||= text.length > 4000;
          row.push(text.slice(0, 4000));
        }
        rows.push(row);
      }
      return { name: String(sheet.name), rows };
    });
    return { kind: 'table', sections, truncated, extracted: true };
  }
  let text: string;
  if (extension === '.docx') {
    const mammoth = await import('mammoth');
    text = (await mammoth.extractRawText({ path: filePath })).value;
  } else if (extension === '.pptx') {
    text = await extractPptxText(filePath);
  } else if (extension === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: await fs.readFile(filePath) });
    let partial = false;
    try { const result = await parser.getText({ first: 20 }); text = result.text; partial = result.total > 20; }
    finally { await parser.destroy(); }
    return { kind: 'text', text: text.slice(0, MAX_TEXT_BYTES), extracted: true, truncated: partial || text.length > MAX_TEXT_BYTES };
  } else return { kind: 'unsupported' };
  return { kind: 'text', text: text.slice(0, MAX_TEXT_BYTES), truncated: text.length > MAX_TEXT_BYTES, extracted: true };
}
