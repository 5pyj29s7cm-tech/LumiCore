/**
 * PDF Tools — read, create, merge, split, and convert PDF documents.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { ToolRegistry } from '../registry';
import { extractPdfTextContent } from '../../utils/pdf_text';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import type { ToolCapabilityMetadata, ToolDefinition } from '../types';
import { getGeneratedOutputDir } from '../../config/data_path';

const OUTPUT_DIR = getGeneratedOutputDir();
const require = createRequire(import.meta.url);

function pdfArtifactCapability(
  id: string,
  scope: string,
  status: 'created' | 'converted' | 'merged' = 'created',
): ToolCapabilityMetadata {
  return capabilityContract({
    id,
    family: 'pdf',
    lane: 'office',
    operation: 'create',
    risk: 'medium',
    sideEffects: [{ type: 'local_write', scope, reversible: true }],
    verification: {
      strategy: 'artifact',
      required: true,
      requiredFields: ['ok', 'status', 'path'],
      requiredValues: { ok: true, status },
      successStatuses: [status],
      requiredArtifacts: ['path'],
      successSignals: ['the exact PDF/text artifact exists and is non-empty'],
      limitations: ['Artifact existence does not independently prove layout fidelity.'],
    },
  });
}

function pdfArtifactEvidence(
  id: string,
  subjectArgument: string,
): NonNullable<ToolDefinition['evidence']> {
  return capabilityEvidence({ id, operation: 'create', subjectArgument });
}

function ensureOutputDir(): string {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  return OUTPUT_DIR;
}

// ── Handlers ──

async function readPdf(args: Record<string, any>): Promise<string> {
  const filePath: string = args.filePath || '';
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`PDF file not found: ${filePath}`);
  }

  const data = await extractPdfTextContent(filePath, args.password);

  const info = [
    `Pages: ${data.pageCount}`,
    `Info: ${JSON.stringify(data.info || {})}`,
    ``,
    data.text.slice(0, 10000),
  ];
  if (data.text.length > 10000) {
    info.push(`\n[Truncated — ${data.text.length} total characters]`);
  }
  return info.join('\n');
}

async function pdfToText(args: Record<string, any>): Promise<string> {
  const filePath: string = args.filePath || '';
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`PDF file not found: ${filePath}`);
  }

  const data = await extractPdfTextContent(filePath, args.password);

  // Save extracted text alongside the PDF
  const outPath = filePath.replace(/\.pdf$/i, '.txt');
  fs.writeFileSync(outPath, data.text, 'utf-8');
  return JSON.stringify({ ok: true, status: 'converted', path: outPath, characters: data.text.length, size: fs.statSync(outPath).size }, null, 2);
}

async function createPdf(args: Record<string, any>): Promise<string> {
  const { content, title, images } = args;
  if (!content && (!images || images.length === 0)) throw new Error('content or images is required');

  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 72;
  const fontSize = 12;
  const lineHeight = 16;
  const maxWidth = pageWidth - margin * 2;
  const pages: any[] = [];

  // Detect CJK characters and load appropriate font
  const hasCJK = content ? /[一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿ가-힯]/.test(content) : false;
  let font;
  if (hasCJK) {
    const systemFonts = [
      'C:\\Windows\\Fonts\\simhei.ttf',
      'C:\\Windows\\Fonts\\simsunb.ttf',
      'C:\\Windows\\Fonts\\msyh.ttc',
      'C:\\Windows\\Fonts\\simsun.ttc',
    ];
    let fontLoaded = false;
    for (const fontPath of systemFonts) {
      if (fs.existsSync(fontPath)) {
        try {
          const fontBytes = fs.readFileSync(fontPath);
          const magic = fontBytes.toString('ascii', 0, 4);
          if (magic === 'ttcf') {
            const numFonts = fontBytes.readUInt32BE(8);
            if (numFonts > 0) {
              const firstOffset = fontBytes.readUInt32BE(12);
              const nextOffset = numFonts > 1 ? fontBytes.readUInt32BE(16) : fontBytes.length;
              const faceBytes = fontBytes.slice(firstOffset, nextOffset);
              font = await doc.embedFont(faceBytes);
              fontLoaded = true;
            }
          } else {
            font = await doc.embedFont(fontBytes);
            fontLoaded = true;
          }
          if (fontLoaded) break;
        } catch (e) {
          console.warn(`[createPdf] Failed to load font ${fontPath}:`, e);
        }
      }
    }
    if (!fontLoaded) {
      font = await doc.embedFont(StandardFonts.Helvetica);
    }
  } else {
    font = await doc.embedFont(StandardFonts.Helvetica);
  }

  // ── Render text content ──
  if (content) {
    const lines: string[] = [];
    const paragraphs = content.split('\n');
    for (const para of paragraphs) {
      if (!para.trim()) { lines.push(''); continue; }
      const chars = para.split('');
      let line = '';
      for (const ch of chars) {
        const testLine = line + ch;
        if (font.widthOfTextAtSize(testLine, fontSize) > maxWidth && line) {
          lines.push(line);
          line = ch;
        } else {
          line = testLine;
        }
      }
      if (line) lines.push(line);
    }

    let y = pageHeight - margin;
    let page = doc.addPage([pageWidth, pageHeight]);
    pages.push(page);

    for (const line of lines) {
      if (y < margin) {
        page = doc.addPage([pageWidth, pageHeight]);
        pages.push(page);
        y = pageHeight - margin;
      }
      if (line) {
        page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0, 0, 0) });
      }
      y -= lineHeight;
    }
  }

  // ── Embed images ──
  if (images && Array.isArray(images)) {
    for (const imgDef of images) {
      if (!imgDef.path || !fs.existsSync(imgDef.path)) continue;

      const ext = path.extname(imgDef.path).toLowerCase();
      let imgBytes = fs.readFileSync(imgDef.path);

      // Convert non-PNG/JPG formats via sharp
      if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
        try {
          const sharp = require('sharp');
          imgBytes = await sharp(imgBytes).png().toBuffer();
        } catch {
          continue; // skip unsupported formats
        }
      }

      let embedded: any;
      const isPng = ext === '.png' || !['.jpg', '.jpeg'].includes(ext);
      if (isPng) {
        embedded = await doc.embedPng(imgBytes);
      } else {
        embedded = await doc.embedJpg(imgBytes);
      }

      // Determine target page
      const targetIdx = (imgDef.page && imgDef.page > 0) ? imgDef.page - 1 : (pages.length > 0 ? pages.length - 1 : 0);
      let targetPage: any;
      while (pages.length <= targetIdx) {
        pages.push(doc.addPage([pageWidth, pageHeight]));
      }
      targetPage = pages[targetIdx];

      if (imgDef.fullBleed) {
        targetPage.drawImage(embedded, { x: 0, y: 0, width: pageWidth, height: pageHeight });
      } else {
        const imgW = imgDef.width || Math.min(embedded.width, pageWidth - 2 * margin);
        const imgH = imgDef.height || (embedded.height * (imgW / embedded.width));
        const imgX = imgDef.x ?? margin;
        const imgY = imgDef.y ?? (pageHeight - margin - imgH);
        targetPage.drawImage(embedded, { x: imgX, y: imgY, width: imgW, height: imgH });
      }
    }
  }

  // Ensure at least one page
  if (pages.length === 0) {
    pages.push(doc.addPage([pageWidth, pageHeight]));
  }

  if (title) doc.setTitle(title);

  const outDir = ensureOutputDir();
  const fileName = `${title || 'document'}_${Date.now()}.pdf`;
  const outPath = path.join(outDir, fileName);
  const pdfBytes = await doc.save();
  fs.writeFileSync(outPath, pdfBytes);
  return JSON.stringify({ ok: true, status: 'created', path: outPath, pageCount: pages.length, size: pdfBytes.length }, null, 2);
}

async function mergePdf(args: Record<string, any>): Promise<string> {
  const filePaths: string[] = args.filePaths || [];
  if (filePaths.length < 2) throw new Error('At least 2 PDF file paths required');

  const { PDFDocument } = require('pdf-lib');
  const merged = await PDFDocument.create();

  for (const fp of filePaths) {
    if (!fs.existsSync(fp)) throw new Error(`File not found: ${fp}`);
    const bytes = fs.readFileSync(fp);
    const doc = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    for (const page of pages) {
      merged.addPage(page);
    }
  }

  const outDir = ensureOutputDir();
  const outPath = path.join(outDir, `merged_${Date.now()}.pdf`);
  const pdfBytes = await merged.save();
  fs.writeFileSync(outPath, pdfBytes);
  return JSON.stringify({ ok: true, status: 'merged', path: outPath, sourceCount: filePaths.length, pageCount: merged.getPageCount(), size: pdfBytes.length }, null, 2);
}

async function splitPdf(args: Record<string, any>): Promise<string> {
  const filePath: string = args.filePath || '';
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`PDF not found: ${filePath}`);

  const { PDFDocument } = require('pdf-lib');
  const bytes = fs.readFileSync(filePath);
  const srcDoc = await PDFDocument.load(bytes);
  const pageCount = srcDoc.getPageIndices().length;
  const outDir = ensureOutputDir();
  const baseName = path.basename(filePath, '.pdf');
  const results: string[] = [];

  for (let i = 0; i < pageCount; i++) {
    const newDoc = await PDFDocument.create();
    const [page] = await newDoc.copyPages(srcDoc, [i]);
    newDoc.addPage(page);
    const outPath = path.join(outDir, `${baseName}_p${i + 1}.pdf`);
    fs.writeFileSync(outPath, await newDoc.save());
    results.push(outPath);
  }

  return JSON.stringify({
    ok: true,
    status: 'split',
    sourcePath: filePath,
    pageCount,
    artifacts: results.map((artifactPath, index) => ({ page: index + 1, path: artifactPath, size: fs.statSync(artifactPath).size })),
  }, null, 2);
}

async function convertToPdf(args: Record<string, any>): Promise<string> {
  const filePath: string = args.filePath || '';
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const ext = path.extname(filePath).toLowerCase();

  // Images → PDF
  if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext)) {
    const { PDFDocument } = require('pdf-lib');
    const imageBytes = fs.readFileSync(filePath);
    const doc = await PDFDocument.create();

    let image;
    if (ext === '.png') {
      image = await doc.embedPng(imageBytes);
    } else if (ext === '.jpg' || ext === '.jpeg') {
      image = await doc.embedJpg(imageBytes);
    } else {
      throw new Error(`Image format ${ext} not supported for PDF conversion`);
    }

    const page = doc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });

    const outDir = ensureOutputDir();
    const outPath = path.join(outDir, path.basename(filePath, ext) + '.pdf');
    fs.writeFileSync(outPath, await doc.save());
    return JSON.stringify({ ok: true, status: 'converted', path: outPath, sourcePath: filePath, size: fs.statSync(outPath).size }, null, 2);
  }

  // Text/markdown → PDF
  if (['.txt', '.md', '.markdown'].includes(ext)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const created = JSON.parse(await createPdf({ content, title: path.basename(filePath, ext) }));
    return JSON.stringify({ ...created, status: 'converted', sourcePath: filePath }, null, 2);
  }

  throw new Error(`Unsupported source format: ${ext}`);
}

// ── PDF Table Extraction ──

async function extractPdfTables(args: Record<string, any>): Promise<string> {
  const filePath: string = args.filePath || '';
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`PDF not found: ${filePath}`);

  let pdfjsLib: any;
  try {
    pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  } catch {
    try {
      pdfjsLib = require('pdfjs-dist');
    } catch {
      throw new Error('pdfjs-dist is required for table extraction.');
    }
  }

  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const allTables: Array<{ page: number; headerRow: string[]; rows: string[][] }> = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();

    // Group text items by Y coordinate into rows (tolerance ~5px)
    const rowMap = new Map<number, Array<{ x: number; text: string }>>();
    for (const item of textContent.items) {
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      let rowKey = y;
      for (const key of rowMap.keys()) {
        if (Math.abs(key - y) <= 5) { rowKey = key; break; }
      }
      if (!rowMap.has(rowKey)) rowMap.set(rowKey, []);
      rowMap.get(rowKey)!.push({ x, text: item.str });
    }

    // Sort rows by Y descending (PDF coordinates: high Y = top of page)
    const sortedRows = [...rowMap.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([_, cells]) => cells.sort((a, b) => a.x - b.x));

    // Detect tables: consecutive rows with similar column count
    for (let i = 0; i < sortedRows.length; i++) {
      const rowCells = sortedRows[i].map(c => c.text);
      const candidateRows = [rowCells];
      for (let j = i + 1; j < sortedRows.length; j++) {
        if (sortedRows[j].length === rowCells.length) {
          candidateRows.push(sortedRows[j].map(c => c.text));
        } else {
          break;
        }
      }
      if (candidateRows.length >= 2) {
        allTables.push({
          page: pageNum,
          headerRow: candidateRows[0],
          rows: candidateRows.slice(1),
        });
        i += candidateRows.length - 1;
      }
    }
  }

  const outputFormat = args.outputFormat || 'json';

  if (outputFormat === 'csv') {
    const csvParts = allTables.map((t, i) => {
      const lines = [`# Table ${i + 1} (Page ${t.page})`, t.headerRow.join(','), ...t.rows.map(r => r.join(','))];
      return lines.join('\n');
    });
    return `Extracted ${allTables.length} table(s):\n\n${csvParts.join('\n\n')}`;
  }

  return JSON.stringify({ success: true, tableCount: allTables.length, tables: allTables });
}

// ── Registration ──

export function registerPdfTools(registry: ToolRegistry): void {
  registry.register({
    name: 'read_pdf',
    description: 'Read and extract text from a PDF file, including password-protected PDFs when the user supplies the password. Returns page count, metadata, and text truncated at 10000 chars. If a password is required or incorrect, ask the user and retry; never repeat the password.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the PDF file' },
        password: { type: 'string', description: 'Optional PDF open password. Sensitive: use only for this read and never repeat it in output.' },
      },
      required: ['filePath'],
    },
    handler: readPdf,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'pdf_to_text',
    description: 'Extract all text from a PDF, including a password-protected PDF when the user supplies the password, and save it as an unencrypted .txt file alongside the original. Returns the output path. Never repeat the password.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the PDF file' },
        password: { type: 'string', description: 'Optional PDF open password. Sensitive: use only for this conversion and never repeat it in output.' },
      },
      required: ['filePath'],
    },
    handler: pdfToText,
    permission: 'user',
    securityLevel: 'safe',
    capability: pdfArtifactCapability('office.pdf.extract-text-file', 'plain-text extraction from PDF', 'converted'),
    evidence: pdfArtifactEvidence('office.pdf.extract-text-file', 'filePath'),
  });

  registry.register({
    name: 'create_pdf',
    description: 'Create a new PDF document from text content with optional embedded images. Supports CJK characters. Embed images alongside text with positioning (x, y, width, height, page, fullBleed). Saves to lumi_output.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The text content for the PDF body (optional if images are provided)' },
        title: { type: 'string', description: 'Document title (used as filename)' },
        images: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute path to image file' },
              x: { type: 'number', description: 'X position from left (default: margin)' },
              y: { type: 'number', description: 'Y position from bottom (default: auto-positioned)' },
              width: { type: 'number', description: 'Image width (default: auto-scale to fit)' },
              height: { type: 'number', description: 'Image height (default: maintain aspect ratio)' },
              page: { type: 'number', description: 'Page number to place image on (1-indexed, default: last page)' },
              fullBleed: { type: 'boolean', description: 'Set true to fill the entire page as background' },
            },
          },
          description: 'Optional: array of images to embed in the PDF',
        },
      },
      required: [],
    },
    handler: createPdf,
    permission: 'user',
    securityLevel: 'safe',
    capability: pdfArtifactCapability('office.pdf.create', 'new PDF document', 'created'),
    evidence: pdfArtifactEvidence('office.pdf.create', 'title'),
  });

  registry.register({
    name: 'merge_pdf',
    description: 'Merge multiple PDF files into a single PDF. Provide an array of file paths in order.',
    parameters: {
      type: 'object',
      properties: {
        filePaths: { type: 'array', items: { type: 'string' }, description: 'Array of absolute paths to PDF files to merge' },
      },
      required: ['filePaths'],
    },
    handler: mergePdf,
    permission: 'user',
    securityLevel: 'safe',
    capability: pdfArtifactCapability('office.pdf.merge', 'merged PDF document', 'merged'),
    evidence: pdfArtifactEvidence('office.pdf.merge', 'filePaths'),
  });

  registry.register({
    name: 'split_pdf',
    description: 'Split a PDF into individual pages, each saved as a separate PDF file.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the PDF file to split' },
      },
      required: ['filePath'],
    },
    handler: splitPdf,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'office.pdf.split',
      family: 'pdf',
      lane: 'office',
      operation: 'create',
      risk: 'medium',
      sideEffects: [{ type: 'local_write', scope: 'one PDF artifact per source page', reversible: true }],
      verification: {
        strategy: 'artifact',
        required: true,
        requiredFields: ['ok', 'status', 'pageCount', 'artifacts'],
        requiredValues: { ok: true, status: 'split' },
        successStatuses: ['split'],
        requiredArtifactCollections: ['artifacts'],
        successSignals: ['every page artifact exists and is non-empty'],
        limitations: ['The split preserves pages but does not validate their visual content.'],
      },
    }),
    evidence: pdfArtifactEvidence('office.pdf.split', 'filePath'),
  });

  registry.register({
    name: 'convert_to_pdf',
    description: 'Convert an image (PNG, JPG) or text/markdown file to PDF format.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the source file' },
      },
      required: ['filePath'],
    },
    handler: convertToPdf,
    permission: 'user',
    securityLevel: 'safe',
    capability: pdfArtifactCapability('office.pdf.convert', 'PDF conversion output', 'converted'),
    evidence: pdfArtifactEvidence('office.pdf.convert', 'filePath'),
  });

  registry.register({
    name: 'extract_pdf_tables',
    description: 'Extract structured tables from a PDF document using positional analysis. Detects table grids by clustering text items by Y/X coordinates. Output as JSON or CSV. Useful for extracting data tables from reports, invoices, and forms.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the PDF file' },
        outputFormat: { type: 'string', description: '"json" (default) or "csv"' },
      },
      required: ['filePath'],
    },
    handler: extractPdfTables,
    permission: 'user',
    securityLevel: 'safe',
  });
}
