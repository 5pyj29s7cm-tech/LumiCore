import fs from 'fs';
import os from 'os';
import path from 'path';

export interface RenovationFolderWorkflowArgs {
  folderPath: string;
  projectName?: string;
  stylePreference?: string;
  knownDimensions?: string;
  budget?: string;
  outputDir?: string;
  writeFiles?: boolean;
  maxFiles?: number;
  maxChars?: number;
}

interface ExtractedFile {
  path: string;
  name: string;
  ext: string;
  chars: number;
  excerpt: string;
}

interface ReferenceImage {
  path: string;
  name: string;
  ext: string;
  size: number;
}

interface SkippedFile {
  path: string;
  reason: string;
}

interface RoomSignal {
  name: string;
  count: number;
}

interface RenovationSignals {
  dimensions: string[];
  areas: string[];
  rooms: RoomSignal[];
  styles: string[];
  budgets: string[];
  constraints: string[];
  needs: string[];
}

interface RoomRect {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DraftGeometry {
  widthMm: number;
  heightMm: number;
  rooms: RoomRect[];
  calibrated: boolean;
  precisionNote: string;
  missingPrecisionInputs: string[];
}

export interface RenovationFolderWorkflowResult {
  projectName: string;
  folderPath: string;
  outputDir?: string;
  filesRead: ExtractedFile[];
  referenceImages: ReferenceImage[];
  filesSkipped: SkippedFile[];
  signals: RenovationSignals;
  geometry: DraftGeometry;
  draftFiles: Array<{ name: string; path?: string; preview: string }>;
  cadFiles: Array<{ name: string; path?: string; preview?: string }>;
  workflowState: 'awaiting_image_geometry_extraction' | 'drafting_base_ready' | 'needs_dimension_calibration';
  primaryReferenceImage?: string;
  recommendedToolCalls: Array<{ tool: string; arguments?: Record<string, any>; useResultFrom?: string; reason: string }>;
  nextSteps: string[];
  warnings: string[];
}

const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.log', '.rtf']);
const DOC_EXTS = new Set(['.docx', '.xlsx', '.xls', '.pptx', '.pdf']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);
const SUPPORTED_EXTS = new Set([...TEXT_EXTS, ...DOC_EXTS, ...IMAGE_EXTS]);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-server', '.codex-run', 'LumiCAD装修方案']);

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function expandHome(value: string): string {
  return String(value || '').replace(/^~(?=$|[\\/])/, os.homedir());
}

function safeName(value: string, fallback = 'renovation_project'): string {
  return path.basename(String(value || fallback)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || fallback;
}

function unique(values: string[], max = 16): string[] {
  return Array.from(new Set(values.map(v => v.trim()).filter(Boolean))).slice(0, max);
}

function selectPrimaryReferenceImage(images: ReferenceImage[]): ReferenceImage | undefined {
  const score = (image: ReferenceImage) => {
    const name = image.name.toLowerCase();
    let value = Math.min(image.size / (1024 * 1024), 10);
    if (/(?:户型|平面|底图|图纸|测量|尺寸|floor|plan|layout|measure|sketch)/i.test(name)) value += 30;
    if (/(?:效果|render|photo|现场|实景)/i.test(name)) value -= 8;
    return value;
  };
  return [...images].sort((a, b) => score(b) - score(a))[0];
}

function walkFiles(root: string, maxFiles: number): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    if (files.length >= maxFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) visit(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}

function decodeRtfUnicode(value: number): string {
  const code = value < 0 ? value + 65536 : value;
  return String.fromCharCode(code);
}

export function extractRtfText(rtf: string): string {
  const destinationWords = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object']);
  const stack: Array<{ ignorable: boolean; ucSkip: number }> = [{ ignorable: false, ucSkip: 1 }];
  let output = '';
  let index = 0;
  let pendingIgnorable = false;
  const current = () => stack[stack.length - 1];
  const append = (text: string) => { if (!current().ignorable) output += text; };

  while (index < rtf.length) {
    const char = rtf[index];
    if (char === '{') {
      stack.push({ ...current(), ignorable: pendingIgnorable || current().ignorable });
      pendingIgnorable = false;
      index++;
      continue;
    }
    if (char === '}') {
      if (stack.length > 1) stack.pop();
      pendingIgnorable = false;
      index++;
      continue;
    }
    if (char !== '\\') {
      append(char);
      index++;
      continue;
    }

    const next = rtf[index + 1];
    if (next === '\\' || next === '{' || next === '}') {
      append(next);
      index += 2;
      continue;
    }
    if (next === '~') {
      append(' ');
      index += 2;
      continue;
    }
    if (next === '*') {
      pendingIgnorable = true;
      index += 2;
      continue;
    }
    if (next === "'") {
      const byte = Number.parseInt(rtf.slice(index + 2, index + 4), 16);
      if (Number.isFinite(byte)) append(Buffer.from([byte]).toString('latin1'));
      index += 4;
      continue;
    }

    const match = rtf.slice(index + 1).match(/^([a-zA-Z]+)(-?\d+)? ?/);
    if (!match) {
      index += 2;
      continue;
    }
    const word = match[1];
    const parameter = match[2] !== undefined ? Number(match[2]) : undefined;
    index += 1 + match[0].length;

    if (destinationWords.has(word)) current().ignorable = true;
    else if (word === 'uc' && parameter !== undefined) current().ucSkip = Math.max(0, parameter);
    else if (word === 'u' && parameter !== undefined) {
      append(decodeRtfUnicode(parameter));
      index += current().ucSkip;
    } else if (word === 'par' || word === 'line') append('\n');
    else if (word === 'tab') append('\t');
  }
  return normalizeWhitespace(output);
}

async function extractPdfText(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const pdfModule: any = await import('pdf-parse');
  const legacyParser = typeof pdfModule.default === 'function'
    ? pdfModule.default
    : typeof pdfModule === 'function'
      ? pdfModule
      : null;
  if (legacyParser) return String((await legacyParser(buffer))?.text || '');
  const PDFParse = pdfModule.PDFParse || pdfModule.default?.PDFParse;
  if (typeof PDFParse !== 'function') throw new Error('Unsupported pdf-parse API');
  const parser = new PDFParse({ data: buffer });
  try {
    return String((await parser.getText())?.text || '');
  } finally {
    await parser.destroy?.();
  }
}

function extractOoxmlTextBlocks(xml: string): string[] {
  const decode = (value: string) => value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
  const runs = (chunk: string) => Array.from(chunk.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g))
    .map(match => decode(match[1] || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const paragraphs = Array.from(xml.matchAll(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g))
    .map(match => runs(match[0]).join(' ').trim())
    .filter(Boolean);
  return paragraphs.length ? paragraphs : runs(xml);
}

async function extractPptxText(filePath: string): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip: any = await JSZip.loadAsync(fs.readFileSync(filePath));
  const entries = Object.values(zip.files as Record<string, any>)
    .filter((entry: any) => !entry.dir && /^ppt\/(?:slides|notesSlides)\/(?:slide|notesSlide)\d+\.xml$/i.test(entry.name))
    .sort((a: any, b: any) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const sections: string[] = [];
  for (const entry of entries as any[]) {
    const xml = await entry.async('string');
    const blocks = extractOoxmlTextBlocks(xml);
    if (blocks.length) sections.push(`[${entry.name}]\n${blocks.join('\n')}`);
  }
  return sections.join('\n\n');
}

function cellValueToText(value: any): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value.richText)) return value.richText.map((part: any) => String(part?.text ?? '')).join('');
  if (Object.prototype.hasOwnProperty.call(value, 'result')) return cellValueToText(value.result);
  if (Object.prototype.hasOwnProperty.call(value, 'text')) return cellValueToText(value.text);
  return String(value);
}

function worksheetToCsv(worksheet: any): string {
  const lines: string[] = [];
  const columnCount = Math.max(worksheet.columnCount || 0, worksheet.actualColumnCount || 0);
  worksheet.eachRow({ includeEmpty: false }, (row: any) => {
    const fields: string[] = [];
    for (let col = 1; col <= columnCount; col++) {
      const text = cellValueToText(row.getCell(col).value);
      fields.push(/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    }
    while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
    if (fields.length > 0) lines.push(fields.join(','));
  });
  return lines.join('\n');
}

async function extractXlsxText(filePath: string): Promise<string> {
  const mod: any = await import('exceljs');
  const ExcelJS = mod.default || mod;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook.worksheets.map((sheet: any) => `[${sheet.name}]\n${worksheetToCsv(sheet)}`).join('\n\n');
}

async function extractFileText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (['.txt', '.md', '.csv', '.json', '.log'].includes(ext)) return fs.readFileSync(filePath, 'utf-8');
  if (ext === '.rtf') return extractRtfText(fs.readFileSync(filePath, 'utf-8'));
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    return String((await mammoth.extractRawText({ path: filePath })).value || '');
  }
  if (ext === '.xlsx') return extractXlsxText(filePath);
  if (ext === '.xls') throw new Error('Legacy .xls files are not supported. Convert the file to .xlsx or .csv first.');
  if (ext === '.pptx') return extractPptxText(filePath);
  if (ext === '.pdf') return extractPdfText(filePath);
  throw new Error(`Unsupported file type: ${ext || '(none)'}`);
}

function countKeyword(corpus: string, keyword: string): number {
  return (corpus.match(new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
}

export function extractRenovationSignals(text: string, args: Partial<RenovationFolderWorkflowArgs> = {}): RenovationSignals {
  const dimensions = unique([
    ...Array.from(text.matchAll(/\d+(?:\.\d+)?\s*(?:mm|毫米|cm|厘米|m|米)\s*[x×*]\s*\d+(?:\.\d+)?\s*(?:mm|毫米|cm|厘米|m|米)?/gi)).map(m => m[0]),
    ...Array.from(text.matchAll(/(?:开间|进深|长|宽|层高|净高|墙厚|门洞|窗洞|尺寸)[:：]?\s*\d+(?:\.\d+)?\s*(?:mm|毫米|cm|厘米|m|米)/gi)).map(m => m[0]),
    args.knownDimensions || '',
  ], 20);
  const areas = unique(Array.from(text.matchAll(/\d+(?:\.\d+)?\s*(?:㎡|m2|m²|平米|平方米)/gi)).map(m => m[0]), 12);
  const budgets = unique([
    ...Array.from(text.matchAll(/(?:预算|总价|造价|费用)[:：]?\s*(?:人民币|¥|￥)?\s*\d+(?:\.\d+)?\s*(?:万|万元|元)/g)).map(m => m[0]),
    args.budget || '',
  ], 8);
  const roomNames = ['玄关', '客厅', '餐厅', '厨房', '主卧', '次卧', '卧室', '儿童房', '老人房', '书房', '卫生间', '卫浴', '阳台', '衣帽间', '储物间', '家政间', '过道', '客房'];
  const rooms = roomNames
    .map(name => ({ name, count: countKeyword(text, name) }))
    .filter(room => room.count > 0);
  const styleKeywords = ['现代简约', '原木', '奶油风', '北欧', '轻奢', '新中式', '侘寂', '工业风', '极简', '日式', '法式', '美式'];
  const styles = unique([...styleKeywords.filter(style => text.includes(style)), args.stylePreference || ''], 8);
  const constraintKeywords = ['承重墙', '剪力墙', '梁', '柱', '燃气', '烟道', '下水', '地漏', '采光', '通风', '隔音', '收纳', '老人', '儿童', '宠物', '预算有限'];
  const constraints = unique(constraintKeywords.filter(item => text.includes(item)), 12);
  const needKeywords = ['收纳', '开放式厨房', '干湿分离', '三分离', '岛台', '双台盆', '投影', '书桌', '办公', '儿童活动', '适老', '宠物友好', '智能家居'];
  const needs = unique(needKeywords.filter(item => text.includes(item)), 14);
  return { dimensions, areas, rooms, styles, budgets, constraints, needs };
}

function parseMetricLength(value: string): number | null {
  const match = value.match(/(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米)?/i);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = (match[2] || '').toLowerCase();
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === 'm' || unit === '米') return n * 1000;
  if (unit === 'cm' || unit === '厘米') return n * 10;
  return n;
}

function inferOuterSize(signals: RenovationSignals, corpus: string): { widthMm: number; heightMm: number; calibrated: boolean; note: string } {
  const pairText = signals.dimensions.find(item => /[x×*]/i.test(item));
  if (pairText) {
    const parts = pairText.split(/[x×*]/i);
    const first = parseMetricLength(parts[0] || '');
    const second = parseMetricLength(parts[1] || '');
    if (first && second) {
      return {
        widthMm: Math.max(2500, Math.round(first)),
        heightMm: Math.max(2500, Math.round(second)),
        calibrated: true,
        note: `按资料中的整体尺寸 ${pairText} 生成。`,
      };
    }
  }

  const areaText = signals.areas[0];
  const areaMatch = areaText?.match(/(\d+(?:\.\d+)?)/);
  if (areaMatch) {
    const area = Number(areaMatch[1]);
    if (Number.isFinite(area) && area > 8) {
      const width = Math.round(Math.sqrt(area * 1_000_000 * 1.35));
      const height = Math.round((area * 1_000_000) / width);
      return {
        widthMm: Math.max(3500, width),
        heightMm: Math.max(3500, height),
        calibrated: false,
        note: `按面积 ${areaText} 估算外框，需补一个实测开间或进深校准。`,
      };
    }
  }

  const twoRoom = /两室|2室|二室/.test(corpus);
  const threeRoom = /三室|3室/.test(corpus);
  if (threeRoom) return { widthMm: 10500, heightMm: 9000, calibrated: false, note: '按三室常见户型估算外框，需校准。' };
  if (twoRoom) return { widthMm: 9000, heightMm: 7600, calibrated: false, note: '按两室常见户型估算外框，需校准。' };
  return { widthMm: 7800, heightMm: 6200, calibrated: false, note: '未识别整体尺寸，生成概念外框，需校准。' };
}

function roomList(signals: RenovationSignals): string[] {
  const detected = signals.rooms.map(room => room.name);
  if (detected.length > 0) return unique(detected, 10);
  return ['玄关', '客厅', '餐厅', '厨房', '主卧', '次卧', '卫生间', '阳台'];
}

function buildGeometry(signals: RenovationSignals, corpus: string): DraftGeometry {
  const outer = inferOuterSize(signals, corpus);
  const rooms = roomList(signals);
  const cols = Math.max(2, Math.ceil(Math.sqrt(rooms.length)));
  const rows = Math.max(2, Math.ceil(rooms.length / cols));
  const cellW = outer.widthMm / cols;
  const cellH = outer.heightMm / rows;
  const rects: RoomRect[] = rooms.map((name, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    return {
      name,
      x: Math.round(col * cellW),
      y: Math.round((rows - row - 1) * cellH),
      width: Math.round(cellW),
      height: Math.round(cellH),
    };
  });
  const missing = [
    outer.calibrated ? '' : '至少一个实测总开间/进深或图纸比例尺',
    signals.dimensions.some(d => /墙厚/.test(d)) ? '' : '墙体厚度',
    signals.dimensions.some(d => /门洞|窗洞/.test(d)) ? '' : '门窗洞口宽度和位置',
    signals.constraints.includes('承重墙') ? '' : '承重墙/剪力墙/梁柱位置',
  ].filter((item): item is string => Boolean(item));
  return {
    widthMm: outer.widthMm,
    heightMm: outer.heightMm,
    rooms: rects,
    calibrated: outer.calibrated,
    precisionNote: outer.note,
    missingPrecisionInputs: unique(missing, 8),
  };
}

function dxfLine(x1: number, y1: number, x2: number, y2: number, layer = 'WALL'): string {
  return `0\nLINE\n8\n${layer}\n10\n${x1}\n20\n${y1}\n30\n0\n11\n${x2}\n21\n${y2}\n31\n0\n`;
}

function dxfText(x: number, y: number, value: string, height = 220, layer = 'TEXT'): string {
  return `0\nTEXT\n8\n${layer}\n10\n${x}\n20\n${y}\n30\n0\n40\n${height}\n1\n${String(value).replace(/\r?\n/g, ' ')}\n`;
}

function dxfCircle(x: number, y: number, radius: number, layer = 'POINT'): string {
  return `0\nCIRCLE\n8\n${layer}\n10\n${x}\n20\n${y}\n30\n0\n40\n${radius}\n`;
}

function dxfRect(x: number, y: number, width: number, height: number, layer = 'WALL'): string {
  return dxfLine(x, y, x + width, y, layer)
    + dxfLine(x + width, y, x + width, y + height, layer)
    + dxfLine(x + width, y + height, x, y + height, layer)
    + dxfLine(x, y + height, x, y, layer);
}

function dxfRoom(room: RoomRect, layer = 'ROOM'): string {
  const labelX = Math.round(room.x + room.width * 0.12);
  const labelY = Math.round(room.y + room.height * 0.52);
  return dxfRect(room.x, room.y, room.width, room.height, layer)
    + dxfText(labelX, labelY, room.name, Math.max(180, Math.min(room.width, room.height) * 0.08), 'TEXT');
}

function buildDxf(projectName: string, geometry: DraftGeometry, mode: 'base' | 'layout' | 'mep'): string {
  let entities = dxfRect(0, 0, geometry.widthMm, geometry.heightMm, 'OUTLINE');
  for (const room of geometry.rooms) entities += dxfRoom(room, mode === 'base' ? 'ROOM_EXISTING' : 'ROOM_LAYOUT');

  if (mode === 'layout') {
    for (const room of geometry.rooms) {
      const margin = Math.min(room.width, room.height) * 0.14;
      entities += dxfRect(
        Math.round(room.x + margin),
        Math.round(room.y + margin),
        Math.round(room.width - margin * 2),
        Math.round(room.height - margin * 2),
        'FURNITURE',
      );
    }
  }

  if (mode === 'mep') {
    for (const room of geometry.rooms) {
      const x = Math.round(room.x + room.width * 0.18);
      const y = Math.round(room.y + room.height * 0.18);
      entities += dxfCircle(x, y, 80, 'SOCKET');
      entities += dxfCircle(Math.round(room.x + room.width * 0.82), y, 80, 'SOCKET');
      entities += dxfText(x + 120, y + 90, `${room.name} 插座/灯位待现场复核`, 140, 'MEP_TEXT');
    }
  }

  entities += dxfText(0, geometry.heightMm + 500, `${projectName} - ${mode.toUpperCase()} - ${geometry.precisionNote}`, 220, 'TITLE');
  return `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
}

function svgRect(x: number, y: number, width: number, height: number, label?: string): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="#1f2937" stroke-width="2"/><text x="${x + 10}" y="${y + Math.max(24, height / 2)}" font-size="18" fill="#111827">${label || ''}</text>`;
}

function buildPreviewSvg(projectName: string, geometry: DraftGeometry): string {
  const scale = Math.min(920 / geometry.widthMm, 620 / geometry.heightMm);
  const width = Math.round(geometry.widthMm * scale) + 40;
  const height = Math.round(geometry.heightMm * scale) + 80;
  const rooms = geometry.rooms.map(room => svgRect(
    Math.round(room.x * scale) + 20,
    Math.round((geometry.heightMm - room.y - room.height) * scale) + 40,
    Math.round(room.width * scale),
    Math.round(room.height * scale),
    room.name,
  )).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#f8fafc"/>
<text x="20" y="24" font-size="18" fill="#0f172a">${projectName} - DXF preview</text>
${rooms}
<text x="20" y="${height - 18}" font-size="13" fill="#64748b">${geometry.precisionNote}</text>
</svg>`;
}

function materialRows(signals: RenovationSignals): string[][] {
  const style = signals.styles[0] || '待定';
  return [
    ['类别', '建议材料/做法', '适用空间', '备注'],
    ['地面', style.includes('原木') ? '木地板/木纹砖' : '耐磨地砖或复合地板', '客餐厅/卧室', '按预算和地暖条件复核'],
    ['墙面', '乳胶漆/局部护墙板', '全屋', '颜色结合采光确认'],
    ['顶面', '局部吊顶+无主灯或吸顶灯', '客餐厅/过道', '避开梁位和空调管线'],
    ['厨房', '防滑地砖、墙砖、橱柜、台面', '厨房', '燃气和烟道位置不可随意改'],
    ['卫浴', '防水、墙地砖、洁具、五金', '卫生间', '重点复核地漏坡度和干湿分离'],
    ['收纳', '定制柜体/成品柜', signals.needs.includes('收纳') ? '玄关/卧室/阳台' : '按需求确认', '预留检修口和插座'],
  ];
}

function csvEscape(value: string): string {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

function makeMarkdown(
  args: RenovationFolderWorkflowArgs,
  files: ExtractedFile[],
  images: ReferenceImage[],
  skipped: SkippedFile[],
  signals: RenovationSignals,
  geometry: DraftGeometry,
) {
  const projectName = args.projectName || safeName(path.basename(args.folderPath), '未命名装修项目');
  const materials = files.map(file => `- ${file.name} (${file.chars} chars)`).join('\n') || '- 暂无可读文字材料';
  const imageList = images.map(file => `- ${file.name} (${Math.round(file.size / 1024)} KB)`).join('\n') || '- 暂无图片/草稿图';
  const skippedList = skipped.map(file => `- ${file.path}: ${file.reason}`).join('\n') || '- 无';
  const excerpt = files.map(file => `## ${file.name}\n${file.excerpt}`).join('\n\n').slice(0, 12000);
  const rooms = geometry.rooms.map(room => `- ${room.name}: ${room.width} x ${room.height} mm (草图分区)`).join('\n');
  const missing = geometry.missingPrecisionInputs.map(item => `- ${item}`).join('\n') || '- 暂无';

  const summary = `# ${projectName} 装修 CAD 文件夹摘要

## 输入材料
${materials}

## 草稿图/参考图
${imageList}

## 暂未读取材料
${skippedList}

## 自动识别线索
- 尺寸：${signals.dimensions.join('；') || '未识别'}
- 面积：${signals.areas.join('；') || '未识别'}
- 房间：${signals.rooms.map(room => `${room.name}(${room.count})`).join('；') || '未识别'}
- 风格：${signals.styles.join('；') || '待定'}
- 预算：${signals.budgets.join('；') || '待定'}
- 约束：${signals.constraints.join('；') || '待现场确认'}
- 需求：${signals.needs.join('；') || '待访谈确认'}

## CAD 精度状态
- 外框：${geometry.widthMm} x ${geometry.heightMm} mm
- 校准状态：${geometry.calibrated ? '已根据资料尺寸初步校准' : '概念草图，需补尺寸校准'}
- 说明：${geometry.precisionNote}

## 需补充的关键输入
${missing}

## 材料摘录
${excerpt}
`;

  const cadPlan = `# ${projectName} CAD 建模计划

## 交付文件
- 01_户型底图.dxf：按当前资料生成的户型/空间底图。
- 02_平面布置方案.dxf：加入家具/功能块的布置草图。
- 03_水电点位建议.dxf：灯位、插座点位和复核提示草图。
- preview.svg：浏览器可看的预览图。

## 分区草图
${rooms}

## 建模规则
1. 当前 DXF 为可编辑草稿，不作为施工最终图。
2. 没有比例尺或实测尺寸时，只做概念分区和方案推演。
3. 承重墙、梁柱、烟道、燃气、下水、强弱电箱位置必须现场复核。
4. 后续如安装 AutoCAD/LibreCAD/浩辰/中望，可直接打开 DXF 继续深化。
`;

  const proposal = `# ${projectName} 装修方案草稿

## 设计定位
- 风格方向：${signals.styles.join(' / ') || args.stylePreference || '现代耐看、易维护'}
- 预算边界：${signals.budgets.join('；') || args.budget || '待确认'}
- 核心需求：${signals.needs.join('；') || '收纳、采光、动线和易维护'}

## 平面策略
1. 玄关优先解决鞋柜、换鞋、临时置物和弱电/清洁工具收纳。
2. 客餐厅保持主通道顺畅，家具尺度按通行净宽复核。
3. 厨房优先确认烟道、燃气、上下水和冰箱位，再确定开放/半开放方案。
4. 卫生间优先复核下水、地漏和门洞，能做干湿分离则优先。
5. 卧室重点控制床、衣柜、过道和书桌/梳妆位的冲突。

## 重点风险
${geometry.missingPrecisionInputs.map(item => `- ${item}`).join('\n') || '- 当前未发现，但仍需现场复尺。'}
`;

  const checklist = `# ${projectName} 施工复核清单

- 复尺：总开间、总进深、层高、梁底高度。
- 结构：承重墙、剪力墙、梁、柱、不可拆改构件。
- 门窗：洞口宽高、窗台高度、开启方向。
- 厨卫：燃气、烟道、上下水、地漏、排风。
- 机电：强弱电箱、空调孔、新风/地暖/中央空调条件。
- 交付：DXF 图层、尺寸标注、材料表、预算和施工说明逐项复核。
`;

  const materialsCsv = materialRows(signals).map(row => row.map(csvEscape).join(',')).join('\n');

  return { summary, cadPlan, proposal, checklist, materialsCsv };
}

export async function runRenovationFolderWorkflow(args: RenovationFolderWorkflowArgs): Promise<RenovationFolderWorkflowResult> {
  const folderPath = path.resolve(expandHome(args.folderPath || ''));
  if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new Error(`Folder not found: ${args.folderPath || '(empty)'}`);
  }

  const maxFiles = Math.min(Math.max(Number(args.maxFiles) || 100, 1), 400);
  const maxChars = Math.min(Math.max(Number(args.maxChars) || 220000, 10000), 900000);
  const files = walkFiles(folderPath, maxFiles);
  const filesRead: ExtractedFile[] = [];
  const referenceImages: ReferenceImage[] = [];
  const filesSkipped: SkippedFile[] = [];
  let corpus = [args.projectName || '', args.stylePreference || '', args.knownDimensions || '', args.budget || ''].join('\n');

  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) {
      filesSkipped.push({ path: filePath, reason: `unsupported extension ${ext || '(none)'}` });
      continue;
    }
    if (IMAGE_EXTS.has(ext)) {
      const stat = fs.statSync(filePath);
      referenceImages.push({ path: filePath, name: path.basename(filePath), ext, size: stat.size });
      continue;
    }
    if (corpus.length >= maxChars) {
      filesSkipped.push({ path: filePath, reason: 'max corpus size reached' });
      continue;
    }
    try {
      const text = normalizeWhitespace(await extractFileText(filePath));
      if (!text) {
        filesSkipped.push({ path: filePath, reason: 'no extractable text' });
        continue;
      }
      const remaining = maxChars - corpus.length;
      const clipped = text.slice(0, remaining);
      corpus += `\n\n# ${path.basename(filePath)}\n${clipped}`;
      filesRead.push({
        path: filePath,
        name: path.basename(filePath),
        ext,
        chars: text.length,
        excerpt: text.slice(0, 1800),
      });
    } catch (err: any) {
      filesSkipped.push({ path: filePath, reason: err?.message || String(err) });
    }
  }

  const projectName = args.projectName || safeName(path.basename(folderPath), '未命名装修项目');
  const signals = extractRenovationSignals(corpus, args);
  const geometry = buildGeometry(signals, corpus);
  const primaryReferenceImage = selectPrimaryReferenceImage(referenceImages);
  const markdown = makeMarkdown({ ...args, folderPath, projectName }, filesRead, referenceImages, filesSkipped, signals, geometry);
  const outputDir = args.outputDir
    ? path.resolve(expandHome(args.outputDir))
    : path.join(folderPath, 'LumiCAD装修方案');

  const draftMap: Array<[string, string]> = [
    ['00_资料摘要.md', markdown.summary],
    ['01_CAD建模计划.md', markdown.cadPlan],
    ['02_装修方案草稿.md', markdown.proposal],
    ['03_施工复核清单.md', markdown.checklist],
    ['04_材料清单.csv', markdown.materialsCsv],
  ];
  const cadMap: Array<[string, string]> = [
    ['01_户型底图.dxf', buildDxf(projectName, geometry, 'base')],
    ['02_平面布置方案.dxf', buildDxf(projectName, geometry, 'layout')],
    ['03_水电点位建议.dxf', buildDxf(projectName, geometry, 'mep')],
    ['preview.svg', buildPreviewSvg(projectName, geometry)],
  ];

  const draftFiles: RenovationFolderWorkflowResult['draftFiles'] = [];
  const cadFiles: RenovationFolderWorkflowResult['cadFiles'] = [];
  const writeFiles = args.writeFiles !== false;
  if (writeFiles) {
    fs.mkdirSync(outputDir, { recursive: true });
    for (const [name, content] of draftMap) {
      const target = path.join(outputDir, name);
      fs.writeFileSync(target, content, 'utf-8');
      draftFiles.push({ name, path: target, preview: content.slice(0, 1200) });
    }
    for (const [name, content] of cadMap) {
      const target = path.join(outputDir, name);
      fs.writeFileSync(target, content, 'utf-8');
      cadFiles.push({ name, path: target, preview: content.slice(0, 800) });
    }
  } else {
    for (const [name, content] of draftMap) draftFiles.push({ name, preview: content.slice(0, 1200) });
    for (const [name, content] of cadMap) cadFiles.push({ name, preview: content.slice(0, 800) });
  }

  return {
    projectName,
    folderPath,
    outputDir: writeFiles ? outputDir : undefined,
    filesRead,
    referenceImages,
    filesSkipped,
    signals,
    geometry,
    draftFiles,
    cadFiles,
    workflowState: primaryReferenceImage
      ? 'awaiting_image_geometry_extraction'
      : geometry.calibrated
      ? 'drafting_base_ready'
      : 'needs_dimension_calibration',
    primaryReferenceImage: primaryReferenceImage?.path,
    recommendedToolCalls: primaryReferenceImage
      ? [
          {
            tool: 'floorplan_extract_geometry',
            arguments: {
              imagePath: primaryReferenceImage.path,
              projectName,
              knownDimensions: signals.dimensions.join('; '),
              unit: 'mm',
            },
            reason: 'The folder workflow catalogued this likely floor-plan image but did not visually trace it.',
          },
          {
            tool: 'cad_generate_dxf',
            useResultFrom: 'floorplan_extract_geometry.cadGenerateDxfArgs',
            reason: 'Generate the editable DXF from extracted image geometry, not from the conceptual room grid.',
          },
          {
            tool: 'cad_generate_autocad_draw_script',
            useResultFrom: 'floorplan_extract_geometry.cadGenerateAutocadArgs',
            reason: 'Prepare visible stroke-by-stroke AutoCAD drawing from the same extracted geometry.',
          },
          {
            tool: 'cad_run_autocad_draw_script',
            useResultFrom: 'cad_generate_autocad_draw_script',
            reason: 'Actually execute and verify the AutoCAD drawing through its completion marker.',
          },
        ]
      : [],
    nextSteps: [
      referenceImages.length
        ? 'For higher accuracy, run floorplan_extract_geometry on the main floor-plan image, then regenerate DXF with confirmed geometry.'
        : 'Add a floor-plan image or measured sketch if available.',
      geometry.calibrated
        ? 'Open the DXF in AutoCAD/LibreCAD/ZWCAD/GstarCAD for layer and dimension review.'
        : 'Ask the user for one confirmed overall width/depth before calling the DXF production-ready.',
      'Have a designer/contractor verify structure, MEP, code, and site measurements before construction.',
    ],
    warnings: [
      'DXF files are editable drafting bases, not final construction drawings.',
      'DWG output requires a licensed CAD application or approved converter; this workflow intentionally emits DXF.',
      primaryReferenceImage ? 'Reference images were catalogued but not visually traced inside this MCP step. Continue with floorplan_extract_geometry before treating the CAD as source-faithful.' : '',
      filesSkipped.length ? `${filesSkipped.length} file(s) were skipped or only partially readable.` : '',
    ].filter(Boolean),
  };
}
