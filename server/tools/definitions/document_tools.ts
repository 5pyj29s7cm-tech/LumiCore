/**
 * Document Parsing Tools — read DOCX, XLSX, and extract text for RAG ingestion.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { ToolRegistry } from '../registry';
import { ingestDocument } from '../../agents/rag';
import { extractPptxText } from '../../knowledge/pptx';
import { extractRtfText } from '../../knowledge/rtf';
import { AUDIO_FILE_EXTS, isAudioTranscriptionUnavailable, transcribeAudioFile } from '../../stt/file_transcription';
import { applySpreadsheetOperations, getWorksheetNames, getWorksheetOrThrow, loadXlsxWorkbook, workbookToText, worksheetToCsv, writeXlsxWorkbook } from '../../utils/spreadsheet';

const OUTPUT_DIR = path.join(process.cwd(), 'lumi_output');
const require = createRequire(import.meta.url);

function ensureOutputDir(): string {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  return OUTPUT_DIR;
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

function safeOutputBaseName(value: string, fallback = 'audio_transcript'): string {
  const base = path.basename(String(value || fallback), path.extname(String(value || '')));
  const safe = base
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
  return safe || fallback;
}

function uniqueOutputPath(baseName: string, extension: '.txt' | '.md'): string {
  const outDir = ensureOutputDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let candidate = path.join(outDir, `${baseName}_${stamp}${extension}`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(outDir, `${baseName}_${stamp}_${counter}${extension}`);
    counter += 1;
  }
  return candidate;
}

function formatAudioTranscriptFile(args: Record<string, any>, result: Awaited<ReturnType<typeof transcribeAudioFile>>, sourcePath: string, format: 'txt' | 'md'): string {
  const title = String(args.title || args.caseName || path.basename(sourcePath)).trim() || path.basename(sourcePath);
  const createdAt = new Date().toISOString();
  if (format === 'md') {
    return [
      `# ${title}`,
      '',
      '- Type: audio transcript',
      `- Source file: ${sourcePath}`,
      `- Provider: ${result.provider}/${result.model}`,
      `- Language: ${result.language}`,
      `- Created at: ${createdAt}`,
      result.warnings?.length ? `- Warnings: ${result.warnings.join('; ')}` : '',
      '',
      '## Transcript',
      '',
      result.text.trim(),
      '',
    ].filter(line => line !== '').join('\n');
  }

  return [
    title,
    '',
    'Type: audio transcript',
    `Source file: ${sourcePath}`,
    `Provider: ${result.provider}/${result.model}`,
    `Language: ${result.language}`,
    `Created at: ${createdAt}`,
    result.warnings?.length ? `Warnings: ${result.warnings.join('; ')}` : '',
    '',
    '--- Transcript ---',
    '',
    result.text.trim(),
    '',
  ].filter(line => line !== '').join('\n');
}

async function transcribeAudioToTextFile(args: Record<string, any>): Promise<string> {
  const filePath = String(args.filePath || args.audioPath || '').trim().replace(/^["']|["']$/g, '');
  if (!filePath) throw new Error('filePath is required. Attach an audio file or provide the local audio path.');
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    throw new Error(`Audio file not found: ${resolvedPath}`);
  }
  if (!AUDIO_FILE_EXTS.test(resolvedPath)) {
    throw new Error('Unsupported audio format. Supported: mp3, wav, m4a, ogg, flac, aac, wma, webm.');
  }

  try {
    const result = await transcribeAudioFile(fs.readFileSync(resolvedPath), {
      fileName: path.basename(resolvedPath),
      language: String(args.language || 'zh'),
      preferredProvider: args.preferredProvider || 'auto',
      allowLocal: args.allowLocal !== false,
    });
    const format = /^(md|markdown)$/i.test(String(args.outputFormat || '')) ? 'md' : 'txt';
    const extension = format === 'md' ? '.md' : '.txt';
    const baseName = safeOutputBaseName(String(args.filename || args.title || args.caseName || path.basename(resolvedPath)), 'audio_transcript');
    const outputPath = uniqueOutputPath(baseName, extension);
    const content = formatAudioTranscriptFile(args, result, resolvedPath, format);
    fs.writeFileSync(outputPath, content, 'utf-8');

    const excerptLimit = Math.max(300, Math.min(Number(args.excerptLimit) || 1200, 5000));
    const warnings = result.warnings?.length ? `\n- Provider fallbacks: ${result.warnings.join('; ')}` : '';
    return [
      '# Audio transcription result',
      '',
      '- Status: completed',
      `- Source audio: ${resolvedPath}`,
      `- Text file: ${outputPath}`,
      `- Provider: ${result.provider}/${result.model}`,
      `- Language: ${result.language}`,
      `- Characters: ${result.text.length}`,
      warnings,
      '',
      '## Transcript excerpt',
      result.text.trim().slice(0, excerptLimit) || '(empty transcript)',
    ].filter(line => line !== '').join('\n');
  } catch (err: any) {
    if (isAudioTranscriptionUnavailable(err)) {
      throw new Error('No audio transcription provider is configured. Configure OpenAI Whisper, Deepgram, DashScope SenseVoice, Doubao Speech, or local Whisper, then retry.');
    }
    throw err;
  }
}

async function parsePdfText(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const pdfModule: any = require('pdf-parse');
  const legacyParser = typeof pdfModule === 'function'
    ? pdfModule
    : typeof pdfModule.default === 'function'
      ? pdfModule.default
      : null;

  if (legacyParser) {
    const result = await legacyParser(buffer);
    return String(result?.text || '');
  }

  const PDFParse = pdfModule.PDFParse || pdfModule.default?.PDFParse;
  if (typeof PDFParse !== 'function') {
    throw new Error('Unsupported pdf-parse API');
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return String(result?.text || '');
  } finally {
    await parser.destroy?.();
  }
}

async function readDocx(args: Record<string, any>): Promise<string> {
  const filePath: string = args.filePath || '';
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`DOCX file not found: ${filePath}`);
  }

  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  const text = result.value.slice(0, 15000);
  let output = result.value;
  if (result.value.length > 15000) {
    output = result.value.slice(0, 15000) + `\n\n[Truncated — ${result.value.length} total characters]`;
  }
  if (result.messages?.length) {
    output += '\n\nWarnings: ' + result.messages.join('; ');
  }
  return output;
}

async function readXlsx(args: Record<string, any>): Promise<string> {
  const filePath: string = args.filePath || '';
  const sheetName: string = args.sheetName || '';
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`XLSX file not found: ${filePath}`);
  }

  const workbook = await loadXlsxWorkbook(filePath);
  const sheetNames = getWorksheetNames(workbook);

  if (sheetName) {
    const sheet = getWorksheetOrThrow(workbook, sheetName);
    const csv = worksheetToCsv(sheet);
    return `Sheet: ${sheetName}\n\n${csv.slice(0, 10000)}`;
  }

  // Return summary of all sheets
  const results: string[] = [`Workbook has ${sheetNames.length} sheet(s): ${sheetNames.join(', ')}`];
  for (const sheet of workbook.worksheets.slice(0, 5)) {
    const name = sheet.name;
    const csv = worksheetToCsv(sheet);
    results.push(`\n=== ${name} ===\n${csv.slice(0, 3000)}`);
    if (csv.length > 3000) results.push(`[Truncated - ${csv.length} total chars]`);
  }
  return results.join('\n');
}

async function extractDocumentText(args: Record<string, any>): Promise<string> {
  const filePath: string = args.filePath || '';
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const ext = path.extname(filePath).toLowerCase();
  let text: string;

  switch (ext) {
    case '.docx':
      const mammoth = require('mammoth');
      text = (await mammoth.extractRawText({ path: filePath })).value;
      break;
    case '.xlsx':
      text = await workbookToText(filePath);
      break;
    case '.xls':
      throw new Error('Legacy .xls files are not supported by the safe spreadsheet reader. Convert the file to .xlsx or .csv first.');
    case '.pptx':
      text = await extractPptxText(filePath);
      break;
    case '.pdf':
      text = await parsePdfText(filePath);
      break;
    case '.txt':
    case '.md':
    case '.csv':
      text = fs.readFileSync(filePath, 'utf-8');
      break;
    case '.rtf':
      text = extractRtfText(fs.readFileSync(filePath, 'utf-8'));
      break;
    default:
      throw new Error(`Unsupported format: ${ext}. Supported: .docx, .xlsx, .xls, .pptx, .pdf, .rtf, .txt, .md, .csv`);
  }

  return text;
}

async function ingestDocumentToRag(args: Record<string, any>, context?: any): Promise<string> {
  const filePath: string = args.filePath || '';
  const agentId: string = args.agentId || '';
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  if (!agentId) throw new Error('agentId is required for RAG ingestion');

  const userId = context?.userId || 'system';
  const title = args.title || path.basename(filePath);
  const text = await extractDocumentText({ filePath });
  const count = await ingestDocument(userId, agentId, title, text, { filePath });

  return `Ingested "${title}" into agent ${agentId}: ${count} chunks stored.`;
}

// ── XLSX Creation & Modification ──

async function createXlsx(args: Record<string, any>): Promise<string> {
  const { sheets, filename } = args;
  if (!sheets || (Array.isArray(sheets) && sheets.length === 0)) {
    throw new Error('sheets (non-empty array) is required');
  }

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();

  if (Array.isArray(sheets)) {
    for (const sheetDef of sheets) {
      const name = (sheetDef.name || `Sheet${wb.worksheets.length + 1}`).slice(0, 31);
      const ws = wb.addWorksheet(name);

      const headers: string[] = sheetDef.headers || [];
      const data = sheetDef.data || [];

      // Write header row
      if (headers.length > 0) {
        const headerRow = ws.addRow(headers);
        headerRow.eachCell((cell: any) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
            left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
            bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
            right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          };
        });
        headerRow.height = 24;
      }

      // Write data rows
      for (let i = 0; i < data.length; i++) {
        const rowData = Array.isArray(data[i]) ? data[i] : Object.values(data[i]);
        const row = ws.addRow(rowData);
        if (i % 2 === 1) {
          row.eachCell((cell: any) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
          });
        }
      }

      // Auto-fit column widths
      const colCount = headers.length || (data.length > 0 ? (Array.isArray(data[0]) ? data[0].length : Object.keys(data[0]).length) : 0);
      for (let c = 0; c < colCount; c++) {
        let maxLen = headers[c] ? String(headers[c]).length : 0;
        for (const row of data) {
          const val = Array.isArray(row) ? String(row[c] ?? '') : String(Object.values(row)[c] ?? '');
          maxLen = Math.max(maxLen, val.length);
        }
        const col = ws.getColumn(c + 1);
        col.width = Math.min(Math.max(maxLen * 2 + 4, 10), 50);
      }
    }
  }

  const outDir = ensureOutputDir();
  const safeName = (filename || 'spreadsheet').replace(/[\\/:*?"<>|]/g, '_');
  const outPath = path.join(outDir, `${safeName}_${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  return `XLSX created: ${outPath} (${wb.worksheets.length} sheet(s), styled)`;
}

async function modifyXlsx(args: Record<string, any>): Promise<string> {
  const { filePath, operations } = args;
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`XLSX not found: ${filePath}`);
  if (!operations || !Array.isArray(operations) || operations.length === 0) {
    throw new Error('operations (non-empty array) is required');
  }

  const wb = await loadXlsxWorkbook(filePath);
  applySpreadsheetOperations(wb, operations);

  const outPath = filePath.replace(/\.xlsx$/i, `_modified_${Date.now()}.xlsx`);
  await writeXlsxWorkbook(wb, outPath);
  return `XLSX modified: ${outPath}`;
}

// ── DOCX Creation & Modification ──

async function createDocx(args: Record<string, any>): Promise<string> {
  const { title, content, paragraphs, headings, tables, filename } = args;

  const { Document, Packer, Paragraph, TextRun, HeadingLevel,
          Table, TableRow, TableCell, WidthType, AlignmentType } = require('docx');

  const children: any[] = [];

  if (title) {
    children.push(new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
    }));
  }

  if (headings && Array.isArray(headings)) {
    for (const h of headings) {
      const level = Math.min(Math.max(h.level || 1, 1), 4);
      const headingMap: Record<number, typeof HeadingLevel.HEADING_1> = {
        1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4,
      };
      children.push(new Paragraph({
        text: h.text,
        heading: headingMap[level],
        spacing: { before: 240, after: 120 },
      }));
    }
  }

  if (paragraphs && Array.isArray(paragraphs)) {
    for (const p of paragraphs) {
      if (typeof p === 'string') {
        children.push(new Paragraph({
          children: [new TextRun(p)],
          spacing: { after: 160 },
        }));
      }
    }
  }

  if (!headings && !paragraphs && content) {
    for (const line of String(content).split('\n')) {
      children.push(new Paragraph({
        children: [new TextRun(line || ' ')],
        spacing: { after: 100 },
      }));
    }
  }

  if (tables && Array.isArray(tables)) {
    for (const tbl of tables) {
      const colCount = (tbl.headers || (tbl.rows?.[0]) || []).length || 1;
      const cellWidth = Math.floor(9000 / colCount);
      const headerRow = new TableRow({
        children: (tbl.headers || []).map((h: string) => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
          width: { size: cellWidth, type: WidthType.DXP },
        })),
      });
      const dataRows = (tbl.rows || []).map((row: string[]) => new TableRow({
        children: row.map((cell: string) => new TableCell({
          children: [new Paragraph({ children: [new TextRun(String(cell ?? ''))] })],
        })),
      }));
      children.push(new Table({ rows: [headerRow, ...dataRows], width: { size: 9000, type: WidthType.DXP } }));
      children.push(new Paragraph({ spacing: { after: 200 } }));
    }
  }

  if (children.length === 0) {
    throw new Error('No content provided. Specify title, content, paragraphs, headings, or tables.');
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(doc);

  const outDir = ensureOutputDir();
  const safeName = (filename || title || 'document').replace(/[\\/:*?"<>|]/g, '_');
  const outPath = path.join(outDir, `${safeName}_${Date.now()}.docx`);
  fs.writeFileSync(outPath, buffer);
  return `DOCX created: ${outPath} (${buffer.length} bytes)`;
}

async function modifyDocx(args: Record<string, any>): Promise<string> {
  const { filePath, replacements } = args;
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`DOCX not found: ${filePath}`);
  if (!replacements) throw new Error('replacements (object or array) is required');

  const replaceMap: Record<string, string> = {};
  if (Array.isArray(replacements)) {
    for (const r of replacements) replaceMap[r.placeholder] = r.value;
  } else if (typeof replacements === 'object') {
    Object.assign(replaceMap, replacements);
  }

  const replaceScript = Object.entries(replaceMap).map(([k, v]) =>
    `$find.Text = '${esc(k)}'\n$find.Replacement.Text = '${esc(v)}'\n$find.Execute($null, $null, $null, $null, $null, $null, $null, $null, $null, $null, 2)`
  ).join('\n');

  const outPathEsc = esc(filePath.replace(/\.docx$/i, `_filled_${Date.now()}.docx`));
  const psScript = `
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$doc = $word.Documents.Open('${esc(filePath)}')
$find = $word.Selection.Find
${replaceScript}
$doc.SaveAs([ref]'${outPathEsc}')
$doc.Close()
$word.Quit()
Write-Output '${outPathEsc}'
`;

  const tmpFile = path.join(require('os').tmpdir(), `lumi_docx_mod_${Date.now()}.ps1`);
  fs.writeFileSync(tmpFile, '﻿' + psScript, 'utf-8');
  try {
    const result = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { timeout: 30000, encoding: 'utf-8' },
    );
    return `DOCX modified: ${result.trim().split(/\r?\n/).pop()?.trim() || 'done'}`;
  } catch (err: any) {
    return `DOCX modification failed: ${err.stderr || err.message}. Ensure Microsoft Word is installed.`;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ── Format Conversion ──

async function xlsxToCsv(args: Record<string, any>): Promise<string> {
  const { filePath, sheetName, outputPath } = args;
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`XLSX not found: ${filePath}`);

  const wb = await loadXlsxWorkbook(filePath);
  const sheetNames = getWorksheetNames(wb);
  const targetSheet = sheetName || sheetNames[0];
  const ws = getWorksheetOrThrow(wb, targetSheet);

  const csv = worksheetToCsv(ws);
  const outPath = outputPath || filePath.replace(/\.xlsx$/i, '.csv');
  fs.writeFileSync(outPath, csv, 'utf-8');
  return `XLSX converted to CSV: ${outPath} (${csv.length} chars)`;
}

async function docxToMarkdown(args: Record<string, any>): Promise<string> {
  const { filePath, outputPath } = args;
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`DOCX not found: ${filePath}`);

  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  const markdown = result.value
    .split(/\n{2,}/)
    .map((p: string) => p.trim())
    .filter(Boolean)
    .join('\n\n');

  const outPath = outputPath || filePath.replace(/\.docx$/i, '.md');
  fs.writeFileSync(outPath, markdown, 'utf-8');
  return `DOCX converted to Markdown: ${outPath} (${markdown.length} chars)`;
}

async function docxToPdf(args: Record<string, any>): Promise<string> {
  const { filePath, outputPath } = args;
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`DOCX not found: ${filePath}`);

  const outPath = outputPath || filePath.replace(/\.docx$/i, '.pdf');
  const psScript = `
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$doc = $word.Documents.Open('${esc(filePath)}')
$doc.SaveAs([ref]'${esc(outPath)}', [ref]17)
$doc.Close()
$word.Quit()
Write-Output '${esc(outPath)}'
`;

  const tmpFile = path.join(require('os').tmpdir(), `lumi_docx2pdf_${Date.now()}.ps1`);
  fs.writeFileSync(tmpFile, '﻿' + psScript, 'utf-8');
  try {
    const result = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { timeout: 30000, encoding: 'utf-8' },
    );
    return `DOCX converted to PDF: ${result.trim().split(/\r?\n/).pop()?.trim() || outPath}`;
  } catch (err: any) {
    return `DOCX to PDF conversion failed: ${err.stderr || err.message}. Ensure Microsoft Word is installed.`;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ── Document Comparison ──

async function diffDocuments(args: Record<string, any>): Promise<string> {
  const { filePath1, filePath2, outputFormat } = args;
  if (!filePath1 || !fs.existsSync(filePath1)) throw new Error(`File not found: ${filePath1}`);
  if (!filePath2 || !fs.existsSync(filePath2)) throw new Error(`File not found: ${filePath2}`);

  const ext1 = path.extname(filePath1).toLowerCase();
  const ext2 = path.extname(filePath2).toLowerCase();

  async function extractText(fp: string, ext: string): Promise<string> {
    switch (ext) {
      case '.docx': {
        const mammoth = require('mammoth');
        return (await mammoth.extractRawText({ path: fp })).value;
      }
      case '.pdf': {
        return parsePdfText(fp);
      }
      case '.txt': case '.md': case '.csv':
        return fs.readFileSync(fp, 'utf-8');
      default:
        throw new Error(`Unsupported format for diff: ${ext}. Supported: .docx, .pdf, .txt, .md, .csv`);
    }
  }

  const [text1, text2] = await Promise.all([
    extractText(filePath1, ext1),
    extractText(filePath2, ext2),
  ]);

  const diffLib = require('diff');
  const format = outputFormat || 'unified';

  if (format === 'unified') {
    const patch = diffLib.createPatch('comparison', text1, text2, path.basename(filePath1), path.basename(filePath2));
    const outDir = ensureOutputDir();
    const outPath = path.join(outDir, `diff_${Date.now()}.diff`);
    fs.writeFileSync(outPath, patch, 'utf-8');
    const truncated = patch.length > 8000 ? patch.slice(0, 8000) + '\n\n[Truncated — see file for full diff]' : patch;
    return `Unified diff (${patch.split('\n').length} lines):\n\n${truncated}\n\nSaved to: ${outPath}`;
  }

  if (format === 'html') {
    const changes = diffLib.diffLines(text1, text2);
    const htmlParts: string[] = [];
    for (const part of changes) {
      const escaped = part.value
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (part.added) {
        htmlParts.push(`<ins style="background:#d4edda;color:#155724">${escaped}</ins>`);
      } else if (part.removed) {
        htmlParts.push(`<del style="background:#f8d7da;color:#721c24">${escaped}</del>`);
      } else {
        htmlParts.push(`<span>${escaped}</span>`);
      }
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Document Comparison</title></head><body style="font-family:monospace;white-space:pre-wrap;max-width:900px;margin:2rem auto;padding:1rem;line-height:1.6"><div>${htmlParts.join('')}</div></body></html>`;
    const outDir = ensureOutputDir();
    const outPath = path.join(outDir, `diff_${Date.now()}.html`);
    fs.writeFileSync(outPath, html, 'utf-8');
    return `HTML redline comparison saved to: ${outPath}`;
  }

  if (format === 'summary') {
    const changes = diffLib.diffLines(text1, text2);
    const added = changes.filter((c: any) => c.added).length;
    const removed = changes.filter((c: any) => c.removed).length;
    const unchanged = changes.length - added - removed;
    const changePct = text1.length > 0 ? Math.round((added + removed) / changes.length * 100) : 0;
    return `Comparison: ${path.basename(filePath1)} vs ${path.basename(filePath2)}\n- Added: ${added} blocks\n- Removed: ${removed} blocks\n- Unchanged: ${unchanged} blocks\n- Change ratio: ~${changePct}%`;
  }

  throw new Error(`Unknown outputFormat: ${format}. Use "unified", "html", or "summary".`);
}

export function registerDocumentTools(registry: ToolRegistry): void {
  registry.register({
    name: 'read_docx',
    description: 'Read and extract text from a .docx Word document. Returns the full text content.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the .docx file' },
      },
      required: ['filePath'],
    },
    handler: readDocx,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'read_xlsx',
    description: 'Read and extract data from an Excel .xlsx spreadsheet. Specify sheetName or get a summary of all sheets.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the .xlsx file' },
        sheetName: { type: 'string', description: 'Optional: specific sheet name to read' },
      },
      required: ['filePath'],
    },
    handler: readXlsx,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'extract_document_text',
    description: 'Auto-detect document format and extract text. Supports .docx, .xlsx, .pptx, .pdf, .rtf, .txt, .md, .csv. Use this when you need to read any document without knowing its format in advance.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the document' },
      },
      required: ['filePath'],
    },
    handler: extractDocumentText,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'ingest_document_to_rag',
    description: 'Read a document (.docx, .pdf, .xlsx, .pptx, .rtf, .txt, .md) and ingest it into an agent\'s RAG knowledge base. The document is chunked and stored as searchable memories scoped to the specified agent.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the document' },
        agentId: { type: 'string', description: 'Target agent ID for knowledge storage' },
        title: { type: 'string', description: 'Optional title override (defaults to filename)' },
      },
      required: ['filePath', 'agentId'],
    },
    handler: ingestDocumentToRag,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'transcribe_audio_to_text_file',
    description: 'Transcribe an uploaded audio recording or voice memo to a saved text transcript file. Use when the user sends an audio file and asks for transcription, speech-to-text, a written transcript, or a text file.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute local path to the uploaded audio file' },
        audioPath: { type: 'string', description: 'Alias for filePath' },
        title: { type: 'string', description: 'Transcript title' },
        caseName: { type: 'string', description: 'Optional legal case or matter name used in the transcript title' },
        filename: { type: 'string', description: 'Optional output filename base without extension' },
        outputFormat: { type: 'string', description: 'txt or md. Defaults to txt.' },
        language: { type: 'string', description: 'Speech language code. Defaults to zh.' },
        preferredProvider: { type: 'string', description: 'Optional STT provider: auto, qwen, deepgram, whisper, ark, local-whisper' },
        allowLocal: { type: 'boolean', description: 'Allow local Whisper fallback. Defaults to true.' },
        excerptLimit: { type: 'number', description: 'Maximum transcript excerpt characters returned in chat. Defaults to 1200.' },
      },
      required: ['filePath'],
    },
    handler: transcribeAudioToTextFile,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'create_xlsx',
    description: 'Create a new Excel .xlsx spreadsheet. Supports multiple sheets with headers and data rows, or JSON arrays. Saves to the lumi_output directory.',
    parameters: {
      type: 'object',
      properties: {
        sheets: {
          type: 'array',
          description: 'Array of sheet definitions: [{ name?: string, headers?: string[], data: any[][] | object[] }]',
          items: { type: 'object' },
        },
        filename: { type: 'string', description: 'Output filename (without extension)' },
      },
      required: ['sheets'],
    },
    handler: createXlsx,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'modify_xlsx',
    description: 'Modify an existing .xlsx file — update cell values or add new sheets.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the .xlsx file' },
        operations: {
          type: 'array',
          description: 'Operations: [{ sheet: "Sheet1", cell: "A1", value: "new" }] or [{ addSheet: true, sheet: "New", headers: [...], data: [[...]] }]',
          items: { type: 'object' },
        },
      },
      required: ['filePath', 'operations'],
    },
    handler: modifyXlsx,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'create_docx',
    description: 'Create a new Word .docx document with headings, paragraphs, and tables. Supports structured layout with title, heading levels (1-4), body paragraphs, and formatted tables with headers. Saves to lumi_output directory.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title (large centered heading)' },
        headings: { type: 'array', items: { type: 'object', properties: { level: { type: 'number' }, text: { type: 'string' } } }, description: 'Array of { level: 1|2|3|4, text: string }' },
        paragraphs: { type: 'array', items: { type: 'string' }, description: 'Array of paragraph text strings' },
        tables: { type: 'array', items: { type: 'object', properties: { headers: { type: 'array' }, rows: { type: 'array' } } }, description: 'Array of { headers: string[], rows: string[][] }' },
        content: { type: 'string', description: 'Flat text content (fallback — for simple documents)' },
        filename: { type: 'string', description: 'Output filename (without extension)' },
      },
      required: [],
    },
    handler: createDocx,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'modify_docx',
    description: 'Fill placeholders (like {{name}}, {{date}}) in a .docx template document. Uses Microsoft Word COM on Windows.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the .docx template file' },
        replacements: {
          type: 'object',
          description: 'Key-value map of placeholder to replacement text, e.g. {"{{name}}": "John", "{{date}}": "2026-06-15"}',
        },
      },
      required: ['filePath', 'replacements'],
    },
    handler: modifyDocx,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'xlsx_to_csv',
    description: 'Convert an Excel .xlsx sheet to a CSV file.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the .xlsx file' },
        sheetName: { type: 'string', description: 'Optional: specific sheet name (default: first sheet)' },
        outputPath: { type: 'string', description: 'Optional: output CSV path (default: same name with .csv extension)' },
      },
      required: ['filePath'],
    },
    handler: xlsxToCsv,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'docx_to_markdown',
    description: 'Convert a .docx Word document to a Markdown (.md) text file.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the .docx file' },
        outputPath: { type: 'string', description: 'Optional: output .md path (default: same name with .md extension)' },
      },
      required: ['filePath'],
    },
    handler: docxToMarkdown,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'docx_to_pdf',
    description: 'Convert a .docx Word document to PDF using Microsoft Word. Requires Office installed on Windows.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the .docx file' },
        outputPath: { type: 'string', description: 'Optional: output PDF path (default: same name with .pdf extension)' },
      },
      required: ['filePath'],
    },
    handler: docxToPdf,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'diff_documents',
    description: 'Compare two documents (.docx, .pdf, .txt, .md, .csv) and produce a detailed diff. Output formats: "unified" (text diff file), "html" (redline with green/red highlights), or "summary" (change statistics). Essential for contract review and document revision tracking.',
    parameters: {
      type: 'object',
      properties: {
        filePath1: { type: 'string', description: 'Absolute path to the first (original) document' },
        filePath2: { type: 'string', description: 'Absolute path to the second (modified) document' },
        outputFormat: { type: 'string', description: '"unified" (text diff, default), "html" (colored redline), or "summary" (statistics only)' },
      },
      required: ['filePath1', 'filePath2'],
    },
    handler: diffDocuments,
    permission: 'user',
    securityLevel: 'safe',
  });
}
