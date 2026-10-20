import { readDocumentText, walkSourceFiles } from './host_documents';
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
3. Continue only when staged extraction and source comparison return geometryReady=true and geometryVerified=true.
4. For visible AutoCAD work, pass the returned receipt handoff unchanged to cad_prepare_autocad_operations and then mcp_cad-drafting_autocad_playback_file.
5. For an explicitly requested DXF file, pass the same receipt handoff to cad_generate_dxf and verify the output path.
6. Treat failed extraction, source comparison, entity-count verification, or playback as a blocker. Never reconstruct coordinates in chat or substitute a generated grid, default room list, script, preview, or task packet.
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
  const files = walkSourceFiles(folderPath, maxFiles, IGNORE_DIRS);
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
      const text = normalizeWhitespace(await readDocumentText(filePath, { blankSections: true }));
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
