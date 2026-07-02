import { Socket } from "socket.io";
import fs from "fs";
import os from "os";
import path from "path";
import { readDB } from "../../db_layer";
import { ToolExecutionRecord } from "../tools/types";

type VoiceScope = {
  domain: 'personal' | 'work';
  orgId: string;
};

type DesktopRelay = (toolName: string, args: Record<string, any>) => Promise<string>;
type Speak = (text: string) => void | number | Promise<void | number>;

interface DesignDeliveryWorkflowOptions {
  socket: Socket;
  userText: string;
  userId: string;
  desktopRelay: DesktopRelay;
  speak: Speak;
  voiceScope: VoiceScope;
  isCancelled?: () => boolean;
}

interface WorkflowAction {
  tool?: string;
  clientAction?: Record<string, any>;
  args?: Record<string, any>;
  optional?: boolean;
  delayMs?: number;
  afterMs?: number;
}

interface WorkflowStep {
  text: string;
  actions?: WorkflowAction[];
  postActions?: WorkflowAction[];
  timing?: 'before' | 'during' | 'after';
  actionLeadMs?: number;
  pauseMs?: number;
}

type ActiveWindowInfo = {
  title: string;
  process_name: string;
  pid?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

type ScreenMetrics = {
  width: number;
  height: number;
  x: number;
  y: number;
};

type ScreenPoint = {
  x: number;
  y: number;
  screenWidth?: number;
  screenHeight?: number;
  screenX?: number;
  screenY?: number;
};

type NativeFileEntry = {
  name: string;
  path: string;
  type?: string;
  isDirectory?: boolean;
  is_directory?: boolean;
};

type DesignDeliveryFiles = {
  folder: string;
  proposal: string;
  budget: string;
  cadDxf: string;
  cadPreview: string;
  dynamoScript: string;
  revitCsv: string;
  wechatDraft: string;
};

const DESIGN_DELIVERY_PATTERNS = [
  /(?:装修|家装|工装|室内设计|设计交付).{0,18}(?:接管|执行|开始|生成|制作|交付|方案|图纸|施工图|cad|dxf|revit|bim)/i,
  /(?:cad|dxf|dwg|施工图|平面图|户型图|revit|bim).{0,18}(?:生成|制作|出图|交付|接管|执行|开始)/i,
  /(?:帮我|给我|开始|执行).{0,18}(?:装修|家装|设计|cad|dxf|dwg|施工图|平面图|户型图|revit|bim).{0,18}(?:交付|方案|图纸|施工图|接管|包)/i,
  /(?:生成|制作|出|做).{0,18}(?:cad|dxf|dwg|施工图|平面图|户型图|revit|bim)/i,
  /(?:拍|录|演示).{0,12}(?:装修|设计交付|cad|revit|bim)/i,
  /(?:装修交付|设计交付|cad交付|revit交付|bim交付)/i,
  /(?:renovation|interior\s*design|design\s*delivery|cad|dxf|revit|bim).{0,24}(?:take\s*over|handoff|delivery|generate|demo)/i,
];

const DESIGN_PROPOSAL_TEXT = [
  'Lumi 装修设计交付方案',
  '',
  '项目：120 平米三居室全案设计交付',
  '客户目标：用一版可确认、可报价、可继续深化到 CAD / Revit 的方案，快速判断是否进入正式施工图阶段。',
  '空间定位：现代轻奢，保留开放式客餐厅，提高收纳、动线和采光效率。',
  '',
  '一、需求判断',
  '1. 原始诉求不是普通咨询，而是一个可推进的设计交付任务。',
  '2. Lumi 需要先把微信里的自然语言需求拆成户型、风格、预算、交付物、风险和下一步动作。',
  '3. 当前授权范围内，Lumi 可以生成方案、预算清单、CAD 初稿、Revit / Dynamo 交接包和微信交付话术。',
  '',
  '二、方案结构',
  '1. 玄关：通顶鞋柜 + 临时挂衣区，减少入户杂物外露。',
  '2. 客餐厅：客厅、餐厅、阳台一体化，保留 3.2 米主通道，电视墙增加隐藏收纳。',
  '3. 厨房：U 型操作台，冰箱外置到餐边柜区，提高厨房内部操作效率。',
  '4. 主卧：床头背景墙 + 衣柜一体化，预留梳妆台和夜间感应灯。',
  '5. 次卧：老人房优先无障碍动线，床侧预留 900mm 通行距离。',
  '6. 书房：保留独立办公区，后期可切换为儿童房。',
  '',
  '三、交付节奏',
  '今天：需求拆解、概念方案、预算框架、CAD 初稿、Revit 交接包。',
  '第 2 天：客户确认风格和预算后，深化立面、节点和材料。',
  '第 3-5 天：进入施工图、清单报价和现场交底版本。',
  '',
  '四、需要确认',
  '1. 现场精确尺寸、承重墙、梁位、管井和原始水电点位。',
  '2. 客户是否接受开放式厨房及烟道、燃气合规要求。',
  '3. 主材品牌和预算上限是否以 28 万为控制线。',
].join('\n');

const MATERIAL_BUDGET_TEXT = [
  'Lumi 装修预算与材料清单',
  '',
  '预算控制线：28 万元',
  '设计交付阶段：概念方案 + CAD 初稿 + Revit / Dynamo 交接包',
  '',
  '基础施工：98,000 元',
  '拆改、砌筑、水电、防水、瓦工、木作基层、油工和安装人工。',
  '',
  '主材：126,000 元',
  '地砖、木地板、墙面材料、门、橱柜、卫浴、灯具和五金。',
  '',
  '定制与软装：42,000 元',
  '玄关柜、餐边柜、主卧衣柜、窗帘、局部灯光和软装搭配。',
  '',
  '风险预留：14,000 元',
  '用于墙体复核、现场尺寸偏差、水电改位、材料涨价和客户新增需求。',
  '',
  'Lumi 执行规则：',
  '1. 常规材料比价、方案整理、交付包生成由 Lumi 接管。',
  '2. 涉及承重结构、燃气改造、最终报价签字和付款节点，必须向用户上报。',
  '3. 微信回复默认只准备草稿，不自动发送，除非用户明确授权。',
].join('\n');

const WECHAT_DELIVERY_DRAFT = [
  '您好，我这边已经先把需求整理成一版可推进的设计交付包。',
  '',
  '这版里面包括：',
  '1. 120 平三居的概念方案和空间拆解；',
  '2. 预算与材料控制清单；',
  '3. CAD 平面布置初稿和 SVG 预览；',
  '4. Revit / Dynamo 建模交接脚本和空间表。',
  '',
  '目前这版可以先用于确认风格、预算和主要动线。进入正式施工图前，还需要复核现场精确尺寸、承重结构、梁位、管井和原始水电点位。',
  '',
  '如果您认可这个方向，我下一步会把它深化成施工图清单和可确认报价。',
].join('\n');

const DYNAMO_SCRIPT_TEXT = [
  '# Lumi Revit / Dynamo handoff script',
  '# Purpose: create model-ready spaces from the design delivery package.',
  '# Run inside a reviewed Revit/Dynamo environment after confirming site dimensions.',
  '',
  'rooms = [',
  '    {"name": "玄关", "x": 0, "y": 0, "width": 2200, "height": 2400, "finish": "stone tile"},',
  '    {"name": "客餐厅", "x": 2200, "y": 0, "width": 5400, "height": 5200, "finish": "wood + tile"},',
  '    {"name": "厨房", "x": 7600, "y": 0, "width": 2600, "height": 3200, "finish": "anti-slip tile"},',
  '    {"name": "主卧", "x": 0, "y": 5200, "width": 4200, "height": 3600, "finish": "wood floor"},',
  '    {"name": "次卧", "x": 4200, "y": 5200, "width": 3200, "height": 3400, "finish": "wood floor"},',
  '    {"name": "书房", "x": 7400, "y": 5200, "width": 2800, "height": 3000, "finish": "wood floor"},',
  ']',
  '',
  'walls = [',
  '    {"start": (0, 0), "end": (10200, 0), "type": "exterior_200"},',
  '    {"start": (10200, 0), "end": (10200, 8800), "type": "exterior_200"},',
  '    {"start": (10200, 8800), "end": (0, 8800), "type": "exterior_200"},',
  '    {"start": (0, 8800), "end": (0, 0), "type": "exterior_200"},',
  '    {"start": (2200, 0), "end": (2200, 5200), "type": "interior_120"},',
  '    {"start": (7600, 0), "end": (7600, 5200), "type": "interior_120"},',
  '    {"start": (0, 5200), "end": (10200, 5200), "type": "interior_120"},',
  ']',
  '',
  'materials = {',
  '    "living": "warm white wall paint + walnut storage",',
  '    "kitchen": "matte tile + quartz countertop",',
  '    "bedroom": "wood floor + low-glare lighting",',
  '}',
  '',
  'print("Create Revit levels, room boundaries, walls, room tags, and material schedule from Lumi handoff data.")',
].join('\n');

function normalizeIntentText(text: string): string {
  return text.replace(/\s+/g, '');
}

export function isDesignDeliveryRequest(text: string): boolean {
  const normalized = normalizeIntentText(text || '');
  if (!normalized) return false;
  return DESIGN_DELIVERY_PATTERNS.some(pattern => pattern.test(normalized));
}

export const isDesignDeliveryDemoRequest = isDesignDeliveryRequest;

function getUserAddress(userId: string): string {
  try {
    const db = readDB();
    const user = (db.users || []).find((u: any) => u.uid === userId);
    const raw = String(user?.displayName || user?.username || '').trim();
    if (!raw) return '';
    if (/^(admin|anonymous|user|guest)$/i.test(raw)) return '';
    return raw;
  } catch {
    return '';
  }
}

function speechPauseMs(text: string, explicit?: number): number {
  if (explicit) return explicit;
  return Math.min(7600, Math.max(2600, text.length * 118));
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseActiveWindow(raw: string): ActiveWindowInfo | null {
  try {
    const parsed = JSON.parse(raw);
    return {
      title: String(parsed?.title || ''),
      process_name: String(parsed?.process_name || parsed?.processName || ''),
      pid: typeof parsed?.pid === 'number' ? parsed.pid : undefined,
      x: typeof parsed?.x === 'number' ? parsed.x : undefined,
      y: typeof parsed?.y === 'number' ? parsed.y : undefined,
      width: typeof parsed?.width === 'number' ? parsed.width : undefined,
      height: typeof parsed?.height === 'number' ? parsed.height : undefined,
    };
  } catch {
    return null;
  }
}

function activeWindowMatches(info: ActiveWindowInfo | null, patterns: RegExp[]): boolean {
  if (!info) return false;
  const haystack = `${info.title} ${info.process_name}`;
  return patterns.some(pattern => pattern.test(haystack));
}

function parseNativeFiles(raw: string): NativeFileEntry[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isNativeDirectory(entry: NativeFileEntry): boolean {
  return entry.type === 'directory' || entry.isDirectory === true || entry.is_directory === true;
}

function powershellCommand(script: string): string {
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function rtfUnicodeEscape(text: string): string {
  let escaped = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const char = text[i];
    if (char === '\r') continue;
    if (char === '\n') {
      escaped += '\\par\n';
    } else if (char === '\\' || char === '{' || char === '}') {
      escaped += `\\${char}`;
    } else if (code >= 0x20 && code <= 0x7e) {
      escaped += char;
    } else {
      escaped += `\\u${code > 32767 ? code - 65536 : code}?`;
    }
  }
  return escaped;
}

function buildRtf(text: string): string {
  const [title, ...bodyLines] = text.split(/\r?\n/);
  const body = bodyLines.join('\n').trim();
  return [
    '{\\rtf1\\ansi\\deff0\\uc1',
    '{\\fonttbl{\\f0\\fnil Microsoft YaHei;}}',
    '\\paperw11906\\paperh16838\\margl1200\\margr1200\\margt1000\\margb1000',
    `\\pard\\f0\\fs38\\b ${rtfUnicodeEscape(title || 'Lumi 装修设计交付')}\\b0\\par`,
    '\\pard\\f0\\fs23\\sl310\\slmult1',
    rtfUnicodeEscape(body),
    '}',
  ].join('\n');
}

function writeRtf(filePath: string, text: string): string {
  fs.writeFileSync(filePath, buildRtf(text), 'utf8');
  return filePath;
}

function dxfLine(x1: number, y1: number, x2: number, y2: number, layer = 'WALL'): string[] {
  return ['0', 'LINE', '8', layer, '10', String(x1), '20', String(y1), '30', '0', '11', String(x2), '21', String(y2), '31', '0'];
}

function dxfText(x: number, y: number, text: string, height = 220, layer = 'TEXT'): string[] {
  return ['0', 'TEXT', '8', layer, '10', String(x), '20', String(y), '30', '0', '40', String(height), '1', text];
}

function dxfRect(x: number, y: number, width: number, height: number, layer = 'WALL'): string[] {
  return [
    ...dxfLine(x, y, x + width, y, layer),
    ...dxfLine(x + width, y, x + width, y + height, layer),
    ...dxfLine(x + width, y + height, x, y + height, layer),
    ...dxfLine(x, y + height, x, y, layer),
  ];
}

function buildRenovationDxf(): string {
  const entities: string[] = [
    ...dxfRect(0, 0, 10200, 8800, 'EXTERIOR_WALL'),
    ...dxfLine(2200, 0, 2200, 5200, 'INTERIOR_WALL'),
    ...dxfLine(7600, 0, 7600, 5200, 'INTERIOR_WALL'),
    ...dxfLine(0, 5200, 10200, 5200, 'INTERIOR_WALL'),
    ...dxfLine(4200, 5200, 4200, 8800, 'INTERIOR_WALL'),
    ...dxfLine(7400, 5200, 7400, 8800, 'INTERIOR_WALL'),
    ...dxfRect(250, 250, 1650, 650, 'FURNITURE'),
    ...dxfRect(3000, 600, 2800, 900, 'FURNITURE'),
    ...dxfRect(8000, 500, 1700, 650, 'FURNITURE'),
    ...dxfRect(800, 6100, 2200, 1800, 'FURNITURE'),
    ...dxfRect(4700, 6100, 1800, 1600, 'FURNITURE'),
    ...dxfRect(8000, 6100, 1500, 900, 'FURNITURE'),
    ...dxfLine(900, 0, 1600, 0, 'DOOR'),
    ...dxfLine(3600, 5200, 4300, 5200, 'DOOR'),
    ...dxfLine(6100, 5200, 6800, 5200, 'DOOR'),
    ...dxfLine(8400, 5200, 9000, 5200, 'DOOR'),
    ...dxfLine(10200, 1300, 10200, 2700, 'WINDOW'),
    ...dxfLine(2800, 8800, 5600, 8800, 'WINDOW'),
    ...dxfLine(7600, 8800, 9600, 8800, 'WINDOW'),
    ...dxfText(600, 1500, '玄关', 260),
    ...dxfText(3900, 2600, '客餐厅', 320),
    ...dxfText(8200, 1850, '厨房', 280),
    ...dxfText(1350, 7050, '主卧', 280),
    ...dxfText(5050, 7050, '次卧', 280),
    ...dxfText(8150, 7050, '书房', 280),
    ...dxfText(300, -520, 'Lumi CAD draft - 10200mm x 8800mm - review site dimensions before production', 180, 'TITLE'),
  ];
  return [
    '0', 'SECTION',
    '2', 'HEADER',
    '9', '$INSUNITS',
    '70', '4',
    '0', 'ENDSEC',
    '0', 'SECTION',
    '2', 'ENTITIES',
    ...entities,
    '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\n');
}

function buildCadPreviewSvg(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="920" viewBox="-300 -680 10800 9800">
  <defs>
    <style>
      .bg { fill: #f8fafc; }
      .outer { fill: #ffffff; stroke: #111827; stroke-width: 120; }
      .wall { stroke: #1f2937; stroke-width: 90; stroke-linecap: square; }
      .room { fill: #e0f2fe; stroke: #93c5fd; stroke-width: 32; }
      .service { fill: #ecfccb; stroke: #bef264; stroke-width: 32; }
      .private { fill: #fae8ff; stroke: #e879f9; stroke-width: 32; }
      .furniture { fill: #fef3c7; stroke: #f59e0b; stroke-width: 28; }
      .opening { stroke: #0891b2; stroke-width: 85; }
      .label { font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 310px; font-weight: 700; fill: #0f172a; }
      .small { font-family: "Microsoft YaHei", Arial, sans-serif; font-size: 170px; fill: #475569; }
    </style>
  </defs>
  <rect class="bg" x="-300" y="-680" width="10800" height="9800" rx="80"/>
  <text class="label" x="0" y="-220">Lumi 装修 CAD 平面布置预览</text>
  <text class="small" x="0" y="9060">DXF 同步生成；正式施工图前请复核现场精确尺寸、承重墙、梁位和水电点位。</text>
  <rect class="outer" x="0" y="0" width="10200" height="8800"/>
  <rect class="room" x="0" y="0" width="2200" height="5200"/>
  <rect class="room" x="2200" y="0" width="5400" height="5200"/>
  <rect class="service" x="7600" y="0" width="2600" height="5200"/>
  <rect class="private" x="0" y="5200" width="4200" height="3600"/>
  <rect class="private" x="4200" y="5200" width="3200" height="3600"/>
  <rect class="private" x="7400" y="5200" width="2800" height="3600"/>
  <line class="wall" x1="2200" y1="0" x2="2200" y2="5200"/>
  <line class="wall" x1="7600" y1="0" x2="7600" y2="5200"/>
  <line class="wall" x1="0" y1="5200" x2="10200" y2="5200"/>
  <line class="wall" x1="4200" y1="5200" x2="4200" y2="8800"/>
  <line class="wall" x1="7400" y1="5200" x2="7400" y2="8800"/>
  <rect class="furniture" x="250" y="250" width="1650" height="650" rx="40"/>
  <rect class="furniture" x="3000" y="600" width="2800" height="900" rx="40"/>
  <rect class="furniture" x="8000" y="500" width="1700" height="650" rx="40"/>
  <rect class="furniture" x="800" y="6100" width="2200" height="1800" rx="40"/>
  <rect class="furniture" x="4700" y="6100" width="1800" height="1600" rx="40"/>
  <rect class="furniture" x="8000" y="6100" width="1500" height="900" rx="40"/>
  <line class="opening" x1="900" y1="0" x2="1600" y2="0"/>
  <line class="opening" x1="3600" y1="5200" x2="4300" y2="5200"/>
  <line class="opening" x1="6100" y1="5200" x2="6800" y2="5200"/>
  <line class="opening" x1="8400" y1="5200" x2="9000" y2="5200"/>
  <text class="label" x="650" y="2600">玄关</text>
  <text class="label" x="3850" y="2700">客餐厅</text>
  <text class="label" x="8300" y="2700">厨房</text>
  <text class="label" x="1450" y="7200">主卧</text>
  <text class="label" x="5050" y="7200">次卧</text>
  <text class="label" x="8250" y="7200">书房</text>
</svg>`;
}

function createDesignDeliveryFiles(): DesignDeliveryFiles {
  const desktopDir = path.join(os.homedir(), 'Desktop');
  const baseDir = fs.existsSync(desktopDir) ? desktopDir : os.tmpdir();
  const folder = path.join(baseDir, 'Lumi-装修设计交付包');
  fs.mkdirSync(folder, { recursive: true });

  const proposal = writeRtf(path.join(folder, '01-Lumi-装修设计方案.rtf'), DESIGN_PROPOSAL_TEXT);
  const budget = writeRtf(path.join(folder, '02-Lumi-预算与材料清单.rtf'), MATERIAL_BUDGET_TEXT);
  const cadDxf = path.join(folder, '03-Lumi-CAD-平面布置.dxf');
  const cadPreview = path.join(folder, '03-Lumi-CAD-平面预览.svg');
  const dynamoScript = path.join(folder, '04-Lumi-Revit-Dynamo建模脚本.py');
  const revitCsv = path.join(folder, '04-Lumi-Revit-空间表.csv');
  const wechatDraft = path.join(folder, '05-Lumi-微信交付话术.txt');

  fs.writeFileSync(cadDxf, buildRenovationDxf(), 'utf8');
  fs.writeFileSync(cadPreview, buildCadPreviewSvg(), 'utf8');
  fs.writeFileSync(dynamoScript, DYNAMO_SCRIPT_TEXT, 'utf8');
  fs.writeFileSync(revitCsv, [
    'name,x,y,width,height,finish',
    '玄关,0,0,2200,2400,stone tile',
    '客餐厅,2200,0,5400,5200,wood + tile',
    '厨房,7600,0,2600,3200,anti-slip tile',
    '主卧,0,5200,4200,3600,wood floor',
    '次卧,4200,5200,3200,3400,wood floor',
    '书房,7400,5200,2800,3000,wood floor',
  ].join('\n'), 'utf8');
  fs.writeFileSync(wechatDraft, WECHAT_DELIVERY_DRAFT, 'utf8');

  return { folder, proposal, budget, cadDxf, cadPreview, dynamoScript, revitCsv, wechatDraft };
}

function buildAppActivateCommand(title: string): string {
  const script = `
$title = ${psString(title)}
Add-Type -AssemblyName Microsoft.VisualBasic
$ok = [Microsoft.VisualBasic.Interaction]::AppActivate($title)
Write-Output "APP_ACTIVATE:$ok"
`.trim();
  return powershellCommand(script);
}

function buildOpenWpsWriterCommand(shortcutPath: string, documentPath: string): string {
  const shortcut = shortcutPath ? psString(shortcutPath) : '$null';
  const document = psString(documentPath);
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$shortcut = ${shortcut}
$document = ${document}
if ($shortcut -and (Test-Path -LiteralPath $shortcut)) {
  Start-Process -FilePath $shortcut -ArgumentList @($document)
  Start-Sleep -Seconds 2
  Write-Output "OPENED_WPS_SHORTCUT:$shortcut"
  exit 0
}
$candidates = @(
  "$env:ProgramFiles\\Kingsoft\\WPS Office\\ksolaunch.exe",
  "$env:ProgramFiles(x86)\\Kingsoft\\WPS Office\\ksolaunch.exe",
  "$env:LOCALAPPDATA\\Kingsoft\\WPS Office\\ksolaunch.exe",
  "wps.exe",
  "winword.exe",
  "notepad.exe"
)
foreach ($candidate in $candidates) {
  try {
    Start-Process -FilePath $candidate -ArgumentList @($document)
    Write-Output "OPENED_OFFICE:$candidate"
    exit 0
  } catch {}
}
Start-Process -FilePath "notepad.exe" -ArgumentList @($document)
Write-Output "OPENED_NOTEPAD_FALLBACK"
exit 0
`.trim();
  return powershellCommand(script);
}

function buildOpenWeChatCommand(shortcutPath: string): string {
  const shortcut = shortcutPath ? psString(shortcutPath) : '$null';
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$shortcut = ${shortcut}
if ($shortcut -and (Test-Path -LiteralPath $shortcut)) {
  Start-Process -FilePath $shortcut
  Start-Sleep -Seconds 2
}
$process = Get-Process | Where-Object { $_.ProcessName -match '^(WeChat|Weixin|微信|WXWork)$' } | Select-Object -First 1
if (-not $process) {
  $candidates = @(
    "$env:ProgramFiles\\Tencent\\WeChat\\WeChat.exe",
    "$env:ProgramFiles(x86)\\Tencent\\WeChat\\WeChat.exe",
    "$env:LOCALAPPDATA\\Tencent\\WeChat\\WeChat.exe",
    "WeChat.exe",
    "Weixin.exe"
  )
  foreach ($candidate in $candidates) {
    try {
      Start-Process -FilePath $candidate
      Start-Sleep -Seconds 2
      break
    } catch {}
  }
}
Add-Type -AssemblyName Microsoft.VisualBasic
$titles = @('微信', 'WeChat', 'Weixin')
foreach ($title in $titles) {
  try {
    $ok = [Microsoft.VisualBasic.Interaction]::AppActivate($title)
    if ($ok) {
      Write-Output "WECHAT_FOCUSED:$title"
      exit 0
    }
  } catch {}
}
Write-Output "WECHAT_FOCUS_ATTEMPTED"
exit 0
`.trim();
  return powershellCommand(script);
}

export async function runDesignDeliveryWorkflow({
  socket,
  userText,
  userId,
  desktopRelay,
  speak,
  voiceScope,
  isCancelled,
}: DesignDeliveryWorkflowOptions): Promise<{ responseText: string; toolCalls: ToolExecutionRecord[] }> {
  const address = getUserAddress(userId);
  const greeting = address ? `收到，${address}。` : '收到。';
  const spokenLines: string[] = [];
  const toolCalls: ToolExecutionRecord[] = [];

  const emitTool = (
    id: string,
    name: string,
    args: Record<string, any>,
    result?: string,
    error?: string,
  ) => {
    socket.emit('agent:tool_call', {
      correlationId: id,
      toolCallId: id,
      name,
      arguments: args,
      args,
      result,
      error,
      source: 'design_delivery_workflow',
    });
  };

  const runTool = async (name: string, args: Record<string, any> = {}, optional = true) => {
    const id = `design-delivery-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    emitTool(id, name, args);
    try {
      const output = await desktopRelay(name, args);
      const fullOutput = String(output || '');
      const result = fullOutput.slice(0, 700);
      emitTool(id, name, args, result);
      toolCalls.push({ id, name, arguments: args, result });
      return fullOutput;
    } catch (err: any) {
      const error = err?.message || String(err);
      emitTool(id, name, args, undefined, error);
      toolCalls.push({ id, name, arguments: args, result: '', error });
      if (!optional) throw err;
      return '';
    }
  };

  const runClientAction = (args: Record<string, any>) => runTool('client_action', args, true);

  const runAction = async (action: WorkflowAction) => {
    if (isCancelled?.()) return;
    if (action.delayMs) await wait(action.delayMs);
    if (isCancelled?.()) return;
    if (action.clientAction) {
      await runClientAction(action.clientAction);
    } else if (action.tool) {
      await runTool(action.tool, action.args || {}, action.optional !== false);
    }
    if (action.afterMs) await wait(action.afterMs);
  };

  const runActions = async (actions: WorkflowAction[] = []) => {
    for (const action of actions) {
      if (isCancelled?.()) break;
      await runAction(action);
    }
  };

  const startSpeech = (text: string, pauseMs?: number): Promise<void> => {
    if (isCancelled?.()) return Promise.resolve();
    spokenLines.push(text);
    return Promise.resolve(speak(text)).then(async result => {
      if (typeof result === 'number') {
        if (result > 0) await wait(result);
        return;
      }
      await wait(speechPauseMs(text, pauseMs));
    });
  };

  const say = async (text: string, pauseMs?: number) => {
    await startSpeech(text, pauseMs);
  };

  const runStep = async (step: WorkflowStep) => {
    if (isCancelled?.()) return;
    const actions = step.actions || [];
    const postActions = step.postActions || [];
    const totalMs = speechPauseMs(step.text, step.pauseMs);
    const timing = step.timing || 'before';

    if (timing === 'before') {
      await runActions(actions);
      await startSpeech(step.text, step.pauseMs);
      await runActions(postActions);
      return;
    }

    if (timing === 'after') {
      await startSpeech(step.text, step.pauseMs);
      await runActions(actions);
      await runActions(postActions);
      return;
    }

    const speechDone = startSpeech(step.text, step.pauseMs);
    const startedAt = Date.now();
    const leadMs = Math.min(step.actionLeadMs ?? 900, Math.max(300, totalMs - 600));
    await wait(leadMs);
    await runActions(actions);
    await wait(Math.max(0, totalMs - (Date.now() - startedAt)));
    await speechDone;
    await runActions(postActions);
  };

  const getActiveWindow = async () => {
    const raw = await runTool('desktop_active_window', {}, true);
    return parseActiveWindow(raw);
  };

  const waitForActiveWindow = async (patterns: RegExp[], timeoutMs = 5000) => {
    const started = Date.now();
    while (!isCancelled?.() && Date.now() - started < timeoutMs) {
      const info = await getActiveWindow();
      if (activeWindowMatches(info, patterns)) return info;
      await wait(650);
    }
    return null;
  };

  const listNativeFiles = async (dirPath: string) => {
    const raw = await runTool('desktop_list_files', { path: dirPath, limit: 300 }, true);
    return parseNativeFiles(raw);
  };

  const getDesktopDirectories = async () => {
    const candidates = new Set<string>();
    const home = os.homedir();
    candidates.add(path.join(home, 'Desktop'));
    candidates.add(path.join(home, 'OneDrive', 'Desktop'));
    if (process.env.PUBLIC) candidates.add(path.join(process.env.PUBLIC, 'Desktop'));
    candidates.add('C:\\Users\\Public\\Desktop');

    const homeEntries = await listNativeFiles(home);
    for (const entry of homeEntries) {
      if (isNativeDirectory(entry) && /^(desktop|桌面)$/i.test(entry.name)) {
        candidates.add(entry.path);
      }
    }
    return [...candidates];
  };

  const findDesktopShortcut = async (patterns: RegExp[]) => {
    const dirs = await getDesktopDirectories();
    const matches: NativeFileEntry[] = [];
    for (const dir of dirs) {
      const files = await listNativeFiles(dir);
      for (const file of files) {
        if (isNativeDirectory(file)) continue;
        const name = file.name || path.basename(file.path || '');
        if (!/\.lnk$/i.test(name) && !/\.url$/i.test(name)) continue;
        if (patterns.some(pattern => pattern.test(name))) matches.push(file);
      }
    }
    matches.sort((a, b) => a.name.localeCompare(b.name));
    return matches[0]?.path || '';
  };

  let wallpaperModeActive = false;

  const enterWallpaperMode = async () => {
    await runTool('desktop_cursor_glow_show', { timeoutMs: 140000 }, true);
    await runTool('desktop_set_wallpaper_mode', {
      enabled: true,
      source: 'design_delivery_workflow',
      timeoutMs: 140000,
    }, true);
    wallpaperModeActive = true;
    await wait(350);
  };

  const exitWallpaperMode = async () => {
    if (wallpaperModeActive) {
      await runTool('desktop_set_wallpaper_mode', {
        enabled: false,
        source: 'design_delivery_workflow',
      }, true);
      wallpaperModeActive = false;
      await wait(250);
    }
    await runTool('desktop_cursor_glow_hide', {}, true);
  };

  let cachedScreenMetrics: ScreenMetrics | null = null;

  const getScreenMetrics = async (): Promise<ScreenMetrics> => {
    if (cachedScreenMetrics) return cachedScreenMetrics;
    try {
      const raw = await runTool('desktop_capture_screen', { quality: 30 }, true);
      const parsed = JSON.parse(raw);
      cachedScreenMetrics = {
        width: Number(parsed?.width) || 1920,
        height: Number(parsed?.height) || 1080,
        x: Number(parsed?.x) || 0,
        y: Number(parsed?.y) || 0,
      };
    } catch {
      cachedScreenMetrics = { width: 1920, height: 1080, x: 0, y: 0 };
    }
    return cachedScreenMetrics;
  };

  const cursorArgs = (point: ScreenPoint) => ({
    x: point.x,
    y: point.y,
    coordinateSpace: 'screen',
    screenWidth: point.screenWidth,
    screenHeight: point.screenHeight,
    screenX: point.screenX || 0,
    screenY: point.screenY || 0,
  });

  const pointCursor = async (point: ScreenPoint, click = false) => {
    await runTool('desktop_cursor_glow_update', cursorArgs(point), true);
    await wait(260);
    if (click) {
      await runTool('desktop_cursor_glow_click', cursorArgs(point), true);
      await wait(180);
    }
  };

  const pointActiveWindowRatio = async (
    patterns: RegExp[],
    xRatio: number,
    yRatio: number,
    click = false,
    fallback = { xRatio, yRatio },
  ) => {
    const info = await getActiveWindow();
    if (activeWindowMatches(info, patterns) && info?.width && info.height && info.width > 0 && info.height > 0) {
      const screen = await getScreenMetrics();
      const point: ScreenPoint = {
        x: Math.round((info.x || 0) + info.width * xRatio),
        y: Math.round((info.y || 0) + info.height * yRatio),
        screenWidth: screen.width,
        screenHeight: screen.height,
        screenX: screen.x,
        screenY: screen.y,
      };
      await pointCursor(point, click);
      return point;
    }
    const screen = await getScreenMetrics();
    const point: ScreenPoint = {
      x: Math.round(screen.x + screen.width * fallback.xRatio),
      y: Math.round(screen.y + screen.height * fallback.yRatio),
      screenWidth: screen.width,
      screenHeight: screen.height,
      screenX: screen.x,
      screenY: screen.y,
    };
    await pointCursor(point, click);
    return point;
  };

  const closeActiveWindow = async (patterns?: RegExp[]) => {
    if (patterns) {
      const info = await getActiveWindow();
      if (!activeWindowMatches(info, patterns)) return;
    }
    await runTool('desktop_keyboard_press', { key: 'alt+f4' }, true);
    await wait(900);
  };

  socket.emit('agent:status', {
    status: 'thinking',
    agentName: 'Lumi',
    phase: 'design_delivery_workflow',
    detail: 'Running design delivery workflow',
  });

  const files = createDesignDeliveryFiles();
  const officePatterns = [/wps/i, /winword/i, /word/i, /writer/i, /notepad/i, /记事本/i];
  const browserPatterns = [/chrome/i, /edge/i, /firefox/i, /browser/i, /msedge/i, /iexplore/i];
  const wechatPatterns = [/wechat/i, /weixin/i, /微信/i, /wxwork/i];

  try {
    await runStep({
      text: `${greeting}我会把这条装修需求接管成一个正式的设计交付任务：先识别客户目标，再生成方案、预算、CAD 初稿、Revit 交接包，最后准备微信交付话术。`,
      actions: [
        { tool: 'desktop_show_lumi_window', afterMs: 250 },
        { clientAction: { action: 'design_delivery_panel', stage: 'intake' } },
      ],
      pauseMs: 7600,
    });

    await enterWallpaperMode();

    const wpsShortcut = await findDesktopShortcut([/wps/i, /金山/i, /文字/i, /writer/i]);
    await runStep({
      text: `第一步，我先生成正式设计方案。你看到的不是聊天摘要，而是已经落到电脑文件里的交付物，路径在 ${files.folder}。`,
      actions: [
        { clientAction: { action: 'design_delivery_panel', stage: 'concept' } },
        { tool: 'desktop_run_command', args: { command: buildOpenWpsWriterCommand(wpsShortcut, files.proposal) }, afterMs: 4600 },
      ],
      timing: 'after',
      pauseMs: 6900,
    });
    await waitForActiveWindow(officePatterns, 5200);
    await pointActiveWindowRatio(officePatterns, 0.5, 0.44, false, { xRatio: 0.5, yRatio: 0.45 });
    await say('方案里已经包含户型判断、空间策略、交付节奏和必须确认的风险点。普通沟通由我推进，承重结构、燃气、水电和最终签字我会上报给你。', 7200);
    await closeActiveWindow(officePatterns);

    await runTool('desktop_run_command', { command: buildOpenWpsWriterCommand(wpsShortcut, files.budget) }, true);
    await wait(3600);
    await waitForActiveWindow(officePatterns, 4200);
    await pointActiveWindowRatio(officePatterns, 0.48, 0.48, false, { xRatio: 0.5, yRatio: 0.48 });
    await say('同时我把预算和材料清单也生成出来，预算控制线、施工项、主材、定制和风险预留都已经拆开，客户可以直接拿这个版本讨论是否进入深化。', 7200);
    await closeActiveWindow(officePatterns);

    await runStep({
      text: '第二步，我生成 CAD 交付。这里同时有 DXF 文件和可直接预览的平面图，所以即使电脑还没装 CAD，也能先看到空间布局结果。',
      actions: [
        { clientAction: { action: 'design_delivery_panel', stage: 'cad' } },
        { tool: 'desktop_open', args: { target: files.cadPreview }, afterMs: 4200 },
      ],
      timing: 'after',
      pauseMs: 7200,
    });
    await waitForActiveWindow(browserPatterns, 5200);
    await pointActiveWindowRatio(browserPatterns, 0.55, 0.5, false, { xRatio: 0.55, yRatio: 0.5 });
    await say('这一步展示的是外部文件交付，不是 Lumi 客户端里的假图。DXF 已经在同一个交付包里，可以继续交给 CAD 软件打开、标注和深化。', 7200);
    await closeActiveWindow(browserPatterns);

    await runStep({
      text: '第三步，我准备 Revit 交接包。当前我生成的是 Dynamo 建模脚本和空间表，让 Revit 侧可以接着创建楼层、房间边界、墙体、房间标签和材料计划。',
      actions: [
        { clientAction: { action: 'design_delivery_panel', stage: 'revit' } },
        { tool: 'desktop_open', args: { target: files.dynamoScript }, afterMs: 3600 },
      ],
      timing: 'after',
      pauseMs: 7600,
    });
    await waitForActiveWindow(officePatterns, 4200);
    await pointActiveWindowRatio(officePatterns, 0.52, 0.42, false, { xRatio: 0.52, yRatio: 0.42 });
    await say('如果这台电脑安装了 Revit 或 Dynamo，这个交接脚本就能作为建模入口；没有安装时，我也会先把可交接的数据文件准备好，不让工作停在聊天里。', 7200);
    await closeActiveWindow(officePatterns);

    await runTool('desktop_open', { target: files.folder }, true);
    await wait(2600);
    await pointActiveWindowRatio([/explorer/i, /文件资源管理器/i], 0.5, 0.46, false, { xRatio: 0.5, yRatio: 0.48 });
    await say('现在交付包已经成型：方案、预算、CAD、预览图、Revit 空间表、Dynamo 脚本和微信话术都在这里。', 6200);
    await closeActiveWindow([/explorer/i, /文件资源管理器/i]);

    const shouldSendToWeChat = process.env.LUMI_DESIGN_DELIVERY_SEND_WECHAT === '1';
    await runStep({
      text: shouldSendToWeChat
        ? '最后我回到电脑微信，把交付话术发给客户。'
        : '最后我回到电脑微信，准备交付话术。默认不自动发送，真正发出前仍然等你确认。',
      actions: [
        { clientAction: { action: 'design_delivery_panel', stage: 'handoff' } },
        { tool: 'desktop_clipboard_write', args: { text: WECHAT_DELIVERY_DRAFT }, afterMs: 500 },
      ],
      timing: 'after',
      pauseMs: shouldSendToWeChat ? 4300 : 6200,
    });

    const wechatShortcut = await findDesktopShortcut([/微信/i, /wechat/i, /weixin/i]);
    if (wechatShortcut) {
      await runTool('desktop_open', { target: wechatShortcut }, true);
      await wait(3600);
    }
    await runTool('desktop_run_command', { command: buildOpenWeChatCommand(wechatShortcut) }, true);
    await wait(2800);

    let active = await waitForActiveWindow(wechatPatterns, 4800);
    if (!active) {
      await runTool('desktop_open', { target: 'WeChat' }, true);
      await wait(3200);
      active = await waitForActiveWindow(wechatPatterns, 3600);
    }

    if (active) {
      await pointActiveWindowRatio(wechatPatterns, 0.5, 0.86, true, { xRatio: 0.5, yRatio: 0.86 });
      await wait(260);
      await runTool('desktop_keyboard_press', { key: 'ctrl+a' }, true);
      await wait(140);
      await runTool('desktop_keyboard_press', { key: 'ctrl+v' }, true);
      await wait(1000);
      if (shouldSendToWeChat) {
        await runTool('desktop_keyboard_press', { key: 'enter' }, true);
        await wait(1600);
      }
    } else {
      await say('这台机器上暂时没有聚焦到电脑微信，所以我先把交付话术复制到剪贴板，并把草稿文件放在交付包里。', 5200);
    }

    if (!isCancelled?.()) {
      await exitWallpaperMode();
      await runTool('desktop_show_lumi_window', {}, true);
      await wait(500);
      await runClientAction({ action: 'design_delivery_panel', stage: 'result' });
      await say('装修设计交付包已经完成：方案、预算、CAD DXF、平面预览、Revit 交接数据和微信交付草稿都已生成。下一步不是继续问你要不要做，而是按你的授权边界把客户推进到确认方案和深化交付。', 8600);
    }
  } finally {
    await exitWallpaperMode();
  }

  return {
    responseText: spokenLines.join('\n'),
    toolCalls: [
      {
        id: `design-delivery-artifacts-${Date.now()}`,
        name: 'design_delivery_artifacts',
        arguments: { request: userText, voiceScope, folder: files.folder },
        result: JSON.stringify(files, null, 2),
      },
      ...toolCalls,
    ],
  };
}

export const runDesignDeliveryDemo = runDesignDeliveryWorkflow;
