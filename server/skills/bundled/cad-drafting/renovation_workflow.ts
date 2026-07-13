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
  sourceInventoryOnly: true;
  completionEligible: false;
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
  workflowState: 'awaiting_image_geometry_extraction' | 'source_inventory_ready' | 'needs_source_geometry';
  primaryReferenceImage?: string;
  recommendedToolCalls: Array<{ tool: string; arguments?: Record<string, any>; useResultFrom?: string; reason: string }>;
  nextSteps: string[];
  warnings: string[];
}

const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.log', '.rtf']);
const DOC_EXTS = new Set(['.docx', '.xlsx', '.xls', '.pptx', '.pdf']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);
const SUPPORTED_EXTS = new Set([...TEXT_EXTS, ...DOC_EXTS, ...IMAGE_EXTS]);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-server', '.codex-run', 'LumiCAD装修方案', 'LumiCAD_Source_Inventory']);

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

function inferOuterSize(signals: RenovationSignals): { widthMm: number; heightMm: number; calibrated: boolean; note: string } {
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

  return {
    widthMm: 0,
    heightMm: 0,
    calibrated: false,
    note: signals.areas[0]
      ? `Only area ${signals.areas[0]} was found; it cannot establish the real outer proportions.`
      : 'No confirmed overall width and depth were found.',
  };
}

function buildGeometry(signals: RenovationSignals): DraftGeometry {
  const outer = inferOuterSize(signals);
  const missing = [
    outer.calibrated ? '' : '至少一个实测总开间/进深或图纸比例尺',
    'Real coordinates for rooms, walls, openings, and structure, or a floor-plan image that can be visually extracted',
    signals.dimensions.some(d => /墙厚/.test(d)) ? '' : '墙体厚度',
    signals.dimensions.some(d => /门洞|窗洞/.test(d)) ? '' : '门窗洞口宽度和位置',
    signals.constraints.includes('承重墙') ? '' : '承重墙/剪力墙/梁柱位置',
  ].filter((item): item is string => Boolean(item));
  return {
    widthMm: outer.widthMm,
    heightMm: outer.heightMm,
    rooms: [],
    calibrated: outer.calibrated,
    precisionNote: outer.note,
    missingPrecisionInputs: unique(missing, 8),
  };
}

function makeMarkdown(
  args: RenovationFolderWorkflowArgs,
  files: ExtractedFile[],
  images: ReferenceImage[],
  skipped: SkippedFile[],
  signals: RenovationSignals,
  geometry: DraftGeometry,
) {
  const projectName = args.projectName || safeName(path.basename(args.folderPath), 'Unnamed renovation project');
  const materials = files.map(file => `- ${file.name} (${file.chars} chars)`).join('\n') || '- No readable text source';
  const imageList = images.map(file => `- ${file.name} (${Math.round(file.size / 1024)} KB)`).join('\n') || '- No image or measured sketch';
  const skippedList = skipped.map(file => `- ${file.path}: ${file.reason}`).join('\n') || '- None';
  const excerpt = files.map(file => `## ${file.name}\n${file.excerpt}`).join('\n\n').slice(0, 12000);
  const missing = geometry.missingPrecisionInputs.map(item => `- ${item}`).join('\n') || '- None recorded';

  const summary = `# ${projectName} source inventory

## Readable text sources
${materials}

## Image and drawing sources
${imageList}

## Skipped or unreadable sources
${skippedList}

## Extracted source signals
- Dimensions: ${signals.dimensions.join('; ') || 'not found'}
- Areas: ${signals.areas.join('; ') || 'not found'}
- Rooms mentioned: ${signals.rooms.map(room => `${room.name}(${room.count})`).join('; ') || 'not found'}
- Styles mentioned: ${signals.styles.join('; ') || 'not found'}
- Budgets mentioned: ${signals.budgets.join('; ') || 'not found'}
- Constraints mentioned: ${signals.constraints.join('; ') || 'not found'}
- Needs mentioned: ${signals.needs.join('; ') || 'not found'}

## Geometry readiness
- Confirmed overall envelope: ${geometry.calibrated ? `${geometry.widthMm} x ${geometry.heightMm} mm` : 'not available'}
- Status: ${geometry.precisionNote}
- CAD files generated by this scan: none

## Missing inputs before drafting
${missing}

## Source excerpts
${excerpt}
`;

  const cadPlan = `# ${projectName} verified CAD execution plan

1. Select the primary source drawing instead of inventing a default floor plan.
2. Run floorplan_extract_geometry with every known calibration dimension.
3. Review the returned walls, rooms, doors, windows, confidence, assumptions, and missing precision inputs.
4. For visible AutoCAD work, pass the extracted geometry to cad_prepare_autocad_operations and then mcp_cad-drafting_autocad_playback_file.
5. For an explicitly requested DXF file, pass the extracted geometry to cad_generate_dxf and verify the output path.
6. Treat a failed extraction or playback as a blocker. Do not substitute a generated grid, default room list, script, preview, or task packet.
`;

  const requirements = `# ${projectName} extracted requirements

- Style terms from source: ${signals.styles.join(' / ') || 'not supplied'}
- Budget terms from source: ${signals.budgets.join('; ') || 'not supplied'}
- Functional needs from source: ${signals.needs.join('; ') || 'not supplied'}
- Constraints from source: ${signals.constraints.join('; ') || 'not supplied'}
- Rooms mentioned in source: ${signals.rooms.map(room => room.name).join('; ') || 'not supplied'}

This file records source facts only. It is not a design proposal, material schedule, budget, floor plan, or construction deliverable.
`;

  const checklist = `# ${projectName} source verification checklist

- Confirm total width, depth, floor height, scale, and at least one calibration dimension.
- Confirm structural walls, shear walls, beams, columns, and non-removable elements.
- Confirm door and window openings, sill heights, and swing directions.
- Confirm gas, flue, water, drain, electrical, HVAC, and equipment locations.
- Compare extracted geometry against the original source before AutoCAD playback or DXF export.
- Require professional review before construction use.
`;

  return { summary, cadPlan, requirements, checklist };
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

  const projectName = args.projectName || safeName(path.basename(folderPath), 'Unnamed renovation project');
  const signals = extractRenovationSignals(corpus, args);
  const geometry = buildGeometry(signals);
  const primaryReferenceImage = selectPrimaryReferenceImage(referenceImages);
  const markdown = makeMarkdown({ ...args, folderPath, projectName }, filesRead, referenceImages, filesSkipped, signals, geometry);
  const outputDir = args.outputDir
    ? path.resolve(expandHome(args.outputDir))
    : path.join(folderPath, 'LumiCAD_Source_Inventory');

  const draftMap: Array<[string, string]> = [
    ['00_source_inventory.md', markdown.summary],
    ['01_verified_cad_execution_plan.md', markdown.cadPlan],
    ['02_extracted_requirements.md', markdown.requirements],
    ['03_source_verification_checklist.md', markdown.checklist],
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
  } else {
    for (const [name, content] of draftMap) draftFiles.push({ name, preview: content.slice(0, 1200) });
  }

  return {
    sourceInventoryOnly: true,
    completionEligible: false,
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
      : referenceImages.length || filesRead.length
      ? 'source_inventory_ready'
      : 'needs_source_geometry',
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
            tool: 'cad_prepare_autocad_operations',
            useResultFrom: 'floorplan_extract_geometry.cadPrepareAutocadOperationsArgs',
            reason: 'Prepare the validated entity operations required by the AutoCAD MCP/COM bridge.',
          },
          {
            tool: 'mcp_cad-drafting_autocad_playback_file',
            useResultFrom: 'cad_prepare_autocad_operations',
            reason: 'Draw visibly in real AutoCAD through MCP/COM and require its completion marker. Do not fall back to files or scripts.',
          },
          {
            tool: 'cad_generate_dxf',
            useResultFrom: 'floorplan_extract_geometry.cadGenerateDxfArgs',
            reason: 'Generate an editable DXF only as a separate requested deliverable, never as visible AutoCAD completion evidence.',
          },
        ]
      : [],
    nextSteps: [
      referenceImages.length
        ? 'Run floorplan_extract_geometry on the primary floor-plan image before any CAD generation.'
        : 'Add a floor-plan image, measured sketch, or structured wall/door/window geometry before drafting.',
      geometry.calibrated
        ? 'Use the recognized overall dimensions only as calibration input; they do not define room or wall positions.'
        : 'Ask for a confirmed overall width/depth or drawing scale before claiming dimensional precision.',
      'Have a designer/contractor verify structure, MEP, code, and site measurements before construction.',
    ],
    warnings: [
      'This folder scan never generates CAD, BIM, renders, budgets, material schedules, or client delivery packages.',
      'A source inventory or execution plan is preparation only and cannot satisfy CAD completion evidence.',
      primaryReferenceImage ? 'Reference images were catalogued but not visually traced inside this MCP step. Continue with floorplan_extract_geometry.' : '',
      filesSkipped.length ? `${filesSkipped.length} file(s) were skipped or only partially readable.` : '',
    ].filter(Boolean),
  };
}
