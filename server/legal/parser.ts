/**
 * Legal document parser — extracts text and metadata from Chinese legal documents.
 * Supports PDF (judgments, rulings) and DOCX (contracts, bids).
 */
import fs from 'fs';
import { extractPptxText } from '../knowledge/pptx';
import { extractRtfText } from '../knowledge/rtf';
import { loadXlsxWorkbook, worksheetToCsv } from '../utils/spreadsheet';
import { extractPdfTextContent, PdfPasswordError } from '../utils/pdf_text';

// ── PDF Parsing ─────────────────────────────────────────────────────────

export interface LegalMetadata {
  caseNumber?: string;       // 案号: (2024)京0105民初12345号
  court?: string;            // 审理法院
  title?: string;            // 文书标题
  parties?: string[];        // 当事人
  causeOfAction?: string;    // 案由
  judgmentDate?: string;     // 裁判日期
  statutesCited?: string[];  // 引用法条
  judgmentResult?: string;   // 判决主文
  rawText: string;           // 原始全文
}

export async function parsePdf(filePath: string, password?: string): Promise<{ text: string; pageCount: number } | null> {
  try {
    const result = await extractPdfTextContent(filePath, password);
    return { text: result.text, pageCount: result.pageCount };
  } catch (error) {
    if (error instanceof PdfPasswordError) throw error;
    return null;
  }
}

// ── DOCX Parsing ────────────────────────────────────────────────────────

export async function parseDocx(filePath: string): Promise<string | null> {
  try {
    const mammoth = (await import('mammoth')).default;
    const buffer = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch {
    return null;
  }
}

// ── Text Parsing (plain .txt fallback) ──────────────────────────────────

export function parseText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

export async function parseSpreadsheet(filePath: string): Promise<string | null> {
  try {
    const workbook = await loadXlsxWorkbook(filePath);
    const sections = workbook.worksheets.map((sheet: any) => {
      const csv = worksheetToCsv(sheet);
      return [`# Sheet: ${sheet.name}`, csv].filter(Boolean).join('\n');
    }).filter((section: string) => section.trim().length > 0);
    return sections.join('\n\n');
  } catch {
    return null;
  }
}

// ── Unified parse ───────────────────────────────────────────────────────

export async function parseDocument(filePath: string, options: { password?: string } = {}): Promise<{ text: string; format: string } | null> {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    pdf: 'pdf',
    docx: 'docx',
    doc: 'docx',
    xlsx: 'spreadsheet',
    xls: 'spreadsheet',
    pptx: 'pptx',
    rtf: 'rtf',
    csv: 'csv',
    txt: 'text',
    md: 'text',
  };
  const format = mimeMap[ext || ''] || 'text';

  try {
    if (format === 'pdf') {
      const result = await parsePdf(filePath, options.password);
      return result ? { text: result.text, format } : null;
    }
    if (format === 'docx') {
      const text = await parseDocx(filePath);
      return text ? { text, format } : null;
    }
    if (format === 'spreadsheet') {
      const text = await parseSpreadsheet(filePath);
      return text ? { text, format } : null;
    }
    if (format === 'pptx') {
      const text = await extractPptxText(filePath);
      return text ? { text, format } : null;
    }
    if (format === 'rtf') {
      return { text: extractRtfText(parseText(filePath)), format };
    }
    if (format === 'csv') {
      return { text: parseText(filePath), format };
    }
    return { text: parseText(filePath), format: 'text' };
  } catch {
    return null;
  }
}

// ── Legal Metadata Extraction ───────────────────────────────────────────

const CASE_NUMBER_RE = /[（(]\d{4}[）)].*?[号字]/;
const COURT_RE = /(.*?(?:人民法院|中级法院|高级法院|最高法院))/;
const JUDGMENT_DATE_RE = /(?:二[〇○]|二零)(?:\d{2})年[一二三四五六七八九十\d]+月[一二三四五六七八九十\d]+日/;
const CAUSE_RE = /案由[：:]\s*(.+?)(?:\n|$)/;
const STATUTE_RE = /《([^》]+)》/g;
const PARTY_SECTION_RE = /(?:原告|被告|上诉人|被上诉人|申请人|被申请人|再审申请人|再审被申请人|第三人)[：:]/g;

export function extractLegalMetadata(text: string): LegalMetadata {
  const meta: LegalMetadata = { rawText: text };

  // Case number — pattern like (2024)京0105民初12345号
  const cnMatch = text.match(CASE_NUMBER_RE);
  if (cnMatch) meta.caseNumber = cnMatch[0].trim();

  // Court — first court mention
  const courtMatch = text.match(COURT_RE);
  if (courtMatch) meta.court = courtMatch[1].trim();

  // Cause of action
  const causeMatch = text.match(CAUSE_RE);
  if (causeMatch) meta.causeOfAction = causeMatch[1].trim();

  // Judgment date
  const dateMatch = text.match(JUDGMENT_DATE_RE);
  if (dateMatch) meta.judgmentDate = dateMatch[0].trim();

  // Parties — collect unique party designations
  const parties = new Set<string>();
  let pm: RegExpExecArray | null;
  const partyRe = /(?:原告|被告|上诉人|被上诉人|申请人|被申请人|再审申请人|再审被申请人|第三人|法定代表人|委托代理人|委托诉讼代理人)[：:]\s*([^\n]{1,30})/g;
  while ((pm = partyRe.exec(text)) !== null) {
    const name = pm[1].replace(/[,，。.]/g, '').trim();
    if (name && name.length > 1) parties.add(name);
  }
  meta.parties = [...parties];

  // Statutes cited — 《...》 pattern
  const statutes = new Set<string>();
  let sm: RegExpExecArray | null;
  while ((sm = STATUTE_RE.exec(text)) !== null) {
    statutes.add(sm[1].trim());
  }
  meta.statutesCited = [...statutes];

  // Judgment result — text after "判决如下" or "裁定如下"
  const resultSection = text.match(/(?:判决如下|裁定如下)[：:]?\s*([\s\S]+?)(?=\n\s*(?:审判长|审判员|本判决|如不服|审\s*判\s*长|$))/);
  if (resultSection) {
    meta.judgmentResult = resultSection[1].trim().slice(0, 2000);
  }

  return meta;
}

// ── Chinese-aware Sentence Splitting ────────────────────────────────────

export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    current += text[i];
    if ('。！？；\n'.includes(text[i])) {
      const trimmed = current.trim();
      if (trimmed && trimmed.length > 2) sentences.push(trimmed);
      current = '';
    }
  }
  const remainder = current.trim();
  if (remainder && remainder.length > 2) sentences.push(remainder);
  return sentences;
}

// ── Legal-aware Chunking ────────────────────────────────────────────────

/**
 * Chunk legal text by section/paragraph boundaries rather than fixed width.
 * Preserves citation context: a statute reference stays with its surrounding reasoning.
 */
export function chunkLegalText(text: string, maxChunkChars = 800, overlapChars = 150): string[] {
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 20);
  const chunks: string[] = [];

  for (const para of paragraphs) {
    if (para.length <= maxChunkChars) {
      chunks.push(para.trim());
      continue;
    }
    // Split oversized paragraphs by sentence
    const sentences = splitSentences(para);
    let buf = '';
    for (const s of sentences) {
      if (buf.length + s.length > maxChunkChars && buf.length > 0) {
        chunks.push(buf.trim());
        buf = buf.slice(-overlapChars) + s;
      } else {
        buf += (buf ? '' : '') + s;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }

  return chunks.filter(c => c.length > 10);
}
