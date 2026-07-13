import { Socket } from "socket.io";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { readDB } from "../../../../../db_layer";
import { ToolExecutionRecord } from "../../../../tools/types";

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
  project: DesignProjectBrief;
  folder: string;
  proposal: string;
  budget: string;
  presentation: string;
  pdf: string;
  reportHtml: string;
  cadDxf: string;
  cadPreview: string;
  cadHandoffHtml: string;
  dynamoScript: string;
  revitCsv: string;
  revitHandoffHtml: string;
  wechatDraft: string;
  verification: string;
  verificationResult: DesignDeliveryVerification;
};

type DesignDeliveryFilePaths = Omit<DesignDeliveryFiles, 'project' | 'verification' | 'verificationResult'>;

type DesignBudgetLine = {
  label: string;
  amountWan: number;
  note: string;
};

type DesignProjectBrief = {
  sourceText: string;
  projectTitle: string;
  areaSqm: number;
  layout: string;
  style: string;
  budgetWan: number;
  budgetLabel: string;
  clientFocus: string[];
  deliverables: string[];
  roomLabels: string[];
  strategy: string[];
  confirmItems: string[];
  budgetLines: DesignBudgetLine[];
};

type DesignDeliveryVerification = {
  passed: boolean;
  checkedAt: string;
  checks: Array<{ label: string; passed: boolean; detail: string }>;
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

const EXPLICIT_DESIGN_DELIVERY_SCOPE_RE = /(?:装修设计交付|设计交付|装修交付|家装交付|工装交付|完整交付包|全套设计|全案设计|接管.{0,12}(?:装修|家装|工装|室内设计)|(?:方案|预算).{0,24}(?:CAD|DXF|Revit|BIM)|(?:CAD|DXF).{0,24}(?:Revit|BIM|预算|完整交付)|design\s*delivery|renovation\s*delivery|interior\s*design\s*(?:package|handoff|delivery)|full\s+(?:renovation|interior\s*design)\s+package|take\s*over.{0,24}(?:renovation|interior\s*design)|(?:cad|dxf).{0,24}(?:revit|bim|budget|delivery\s*package))/iu;
const EXPLICIT_REUSABLE_CAD_TOOL_RE = /(?:cad_generate_autocad_draw_script|cad_run_autocad_draw_script|cad_generate_dxf|floorplan_extract_geometry)/i;

const DEFAULT_DESIGN_PROJECT_BRIEF: DesignProjectBrief = buildDesignProjectBrief({
  sourceText: '',
  areaSqm: 120,
  layout: '三居室',
  style: '现代轻奢',
  budgetWan: 28,
  clientFocus: ['开放客餐厅', '收纳一体化', '采光和动线效率'],
  deliverables: ['方案', '预算', 'PPT/PDF', 'CAD DXF', 'Revit/Dynamo', '微信草稿'],
});

function normalizeBriefText(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function parseChineseRoomCount(raw: string): number | null {
  const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  const digit = raw.match(/\d+/)?.[0];
  if (digit) return Number(digit);
  const char = raw.match(/[一二两三四五六]/)?.[0];
  return char ? map[char] || null : null;
}

function formatWan(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} 万`;
}

function budgetLinesFromTotal(budgetWan: number): DesignBudgetLine[] {
  const total = Math.max(6, budgetWan || 28);
  return [
    { label: '基础施工', amountWan: total * 0.35, note: '拆改、砌筑、水电、防水、瓦工、木作基层、油工和安装人工。' },
    { label: '主材', amountWan: total * 0.33, note: '地砖、木地板、墙面材料、门、橱柜、卫浴、灯具和五金。' },
    { label: '定制与收纳', amountWan: total * 0.16, note: '玄关柜、餐边柜、衣柜、局部柜体和功能五金。' },
    { label: '软装与设备', amountWan: total * 0.11, note: '窗帘、局部灯光、家具软装、电器和氛围配置。' },
    { label: '风险预留', amountWan: total * 0.05, note: '用于现场尺寸偏差、水电改位、材料涨价和客户新增需求。' },
  ];
}

function roomLabelsFromLayout(layout: string): string[] {
  const count = parseChineseRoomCount(layout) || (layout.includes('别墅') || layout.includes('复式') ? 4 : 3);
  const rooms = ['玄关', '客餐厅', '厨房', '主卧'];
  if (count >= 2) rooms.push('次卧');
  if (count >= 3) rooms.push('书房/儿童房');
  if (count >= 4) rooms.push('老人房/多功能房');
  if (/店铺|办公室|工装|商业/.test(layout)) return ['入口接待区', '展示/办公区', '洽谈区', '储物区', '后勤区'];
  return rooms;
}

function buildDesignProjectBrief(input: {
  sourceText: string;
  areaSqm: number;
  layout: string;
  style: string;
  budgetWan: number;
  clientFocus: string[];
  deliverables: string[];
}): DesignProjectBrief {
  const layout = input.layout || '三居室';
  const style = input.style || '现代轻奢';
  const areaSqm = input.areaSqm || 120;
  const budgetWan = input.budgetWan || 28;
  const clientFocus = input.clientFocus.length ? input.clientFocus : ['收纳', '动线', '采光'];
  const deliverables = input.deliverables.length
    ? Array.from(new Set(['方案', '预算', 'PPT/PDF', ...input.deliverables]))
    : ['方案', '预算', 'PPT/PDF', 'CAD DXF', 'Revit/Dynamo', '微信草稿'];
  const budgetLabel = `${formatWan(budgetWan)}预算控制`;
  const projectTitle = `${areaSqm} 平 ${layout} ${style}装修设计交付`;
  const roomLabels = roomLabelsFromLayout(layout);
  const focusText = clientFocus.join('、');
  const strategy = [
    `围绕“${focusText}”先确认空间取舍，再进入造型和材料深化。`,
    `把 ${layout} 的公共区、安静区和服务区拆开处理，避免只做效果图不解决使用问题。`,
    `以 ${budgetLabel} 为边界，先保证硬装、水电和主材质量，再给软装和灯光留弹性。`,
  ];
  const confirmItems = [
    '现场精确尺寸、承重墙、梁位、管井和原始水电点位。',
    '结构、燃气、强弱电和防水相关改动是否满足现场及规范要求。',
    `客户是否确认 ${style} 方向、${budgetLabel} 和主要交付物：${deliverables.join('、')}。`,
  ];
  return {
    sourceText: input.sourceText,
    projectTitle,
    areaSqm,
    layout,
    style,
    budgetWan,
    budgetLabel,
    clientFocus,
    deliverables,
    roomLabels,
    strategy,
    confirmItems,
    budgetLines: budgetLinesFromTotal(budgetWan),
  };
}

function parseDesignProjectBrief(text: string): DesignProjectBrief {
  const sourceText = normalizeBriefText(text);
  const area = sourceText.match(/(\d{2,4}(?:\.\d+)?)\s*(?:平米|平|㎡|m2|平方)/i);
  const areaSqm = area ? Number(area[1]) : DEFAULT_DESIGN_PROJECT_BRIEF.areaSqm;
  const layoutMatch = sourceText.match(/(一居|两居|二居|三居|四居|五居|六居|[一二两三四五六]\s*室(?:[一二两三四五六]\s*厅)?|别墅|复式|loft|LOFT|公寓|办公室|店铺|工装|商业空间)/);
  const layout = layoutMatch ? layoutMatch[1].replace(/\s+/g, '') : DEFAULT_DESIGN_PROJECT_BRIEF.layout;
  const styles = ['现代轻奢', '现代简约', '奶油风', '原木风', '侘寂', '极简', '新中式', '北欧', '法式', '工业风', '美式', '日式', '中古', '轻奢'];
  const style = styles.find(item => sourceText.includes(item)) || DEFAULT_DESIGN_PROJECT_BRIEF.style;
  const budgetMatch = sourceText.match(/(?:预算|控制|上限|总价|大概|准备|投入)[^\d]{0,10}(\d+(?:\.\d+)?)\s*(万|w|W|元|块)?/i)
    || sourceText.match(/(\d+(?:\.\d+)?)\s*(万|w|W)\s*(?:预算|装修|以内|左右|上下)?/i);
  let budgetWan = DEFAULT_DESIGN_PROJECT_BRIEF.budgetWan;
  if (budgetMatch) {
    const value = Number(budgetMatch[1]);
    const unit = budgetMatch[2] || '万';
    budgetWan = /元|块/.test(unit) && value > 10000 ? value / 10000 : value;
  }
  const focusKeywords = ['收纳', '采光', '动线', '老人', '孩子', '儿童', '宠物', '办公', '书房', '预算', '环保', '快速入住', '出租', '民宿', '品质', '显大', '储物'];
  const clientFocus = focusKeywords.filter(item => sourceText.includes(item)).slice(0, 6);
  const deliverables = [
    /ppt|PPT|汇报/.test(sourceText) ? 'PPT' : '',
    /pdf|PDF/.test(sourceText) ? 'PDF' : '',
    /cad|CAD|dxf|DXF|图纸|施工图/.test(sourceText) ? 'CAD DXF' : '',
    /revit|Revit|Dynamo|BIM|bim/.test(sourceText) ? 'Revit/Dynamo' : '',
    /报价|预算|清单|材料/.test(sourceText) ? '预算材料清单' : '',
    /微信|回复|话术|客户/.test(sourceText) ? '微信草稿' : '',
  ].filter(Boolean);
  return buildDesignProjectBrief({
    sourceText,
    areaSqm,
    layout,
    style,
    budgetWan,
    clientFocus,
    deliverables,
  });
}

function buildDesignProposalText(project: DesignProjectBrief): string {
  return [
    'Lumi 装修设计交付方案',
    '',
    `项目：${project.projectTitle}`,
    `客户目标：用一版可确认、可报价、可继续深化到 CAD / Revit 的方案，快速判断是否进入正式施工图阶段。`,
    `空间定位：${project.style}，重点解决 ${project.clientFocus.join('、')}。`,
    project.sourceText ? `原始需求：${project.sourceText.slice(0, 260)}` : '',
    '',
    '一、需求判断',
    '1. 原始诉求不是普通咨询，而是一个可推进的设计交付任务。',
    `2. Lumi 已把需求拆成：${project.layout}、${project.areaSqm} 平、${project.style}、${project.budgetLabel}、交付物和风险边界。`,
    `3. 当前授权范围内，Lumi 可以准备：${project.deliverables.join('、')}。`,
    '',
    '二、方案结构',
    ...project.roomLabels.map((room, index) => `${index + 1}. ${room}：${roomStrategy(room, project)}。`),
    '',
    '三、空间策略',
    ...project.strategy.map((item, index) => `${index + 1}. ${item}`),
    '',
    '四、交付节奏',
    '今天：需求拆解、概念方案、预算框架、CAD 初稿、Revit 交接包和微信草稿。',
    '第 2 天：客户确认风格和预算后，深化立面、节点和材料。',
    '第 3-5 天：进入施工图、清单报价和现场交底版本。',
    '',
    '五、需要确认',
    ...project.confirmItems.map((item, index) => `${index + 1}. ${item}`),
  ].filter(Boolean).join('\n');
}

function roomStrategy(room: string, project: DesignProjectBrief): string {
  if (/玄关|入口/.test(room)) return '做通顶收纳、临时挂衣和换鞋区，先处理入户杂物';
  if (/客餐厅|展示|办公/.test(room)) return `围绕 ${project.clientFocus.join('、')} 做主空间，保留清晰通道和视觉轴线`;
  if (/厨房|后勤/.test(room)) return '优化洗切炒动线，材料优先耐污、防滑、易清洁';
  if (/主卧/.test(room)) return '保证睡眠区安静和衣物收纳，背景墙不过度堆料';
  if (/次卧|老人|儿童/.test(room)) return '根据家庭成员切换为老人房、儿童房或客房，保留安全通行距离';
  if (/书房|多功能/.test(room)) return '预留办公、学习或备用居住场景，减少固定硬装约束';
  return '先满足核心使用场景，再进入造型和材料深化';
}

function buildMaterialBudgetText(project: DesignProjectBrief): string {
  return [
    'Lumi 装修预算与材料清单',
    '',
    `项目：${project.projectTitle}`,
    `预算控制线：${formatWan(project.budgetWan)}`,
    `设计交付阶段：${project.deliverables.join(' + ')}`,
    '',
    ...project.budgetLines.flatMap(line => [
      `${line.label}：${formatWan(line.amountWan)}`,
      line.note,
      '',
    ]),
    '材料建议：',
    ...materialSuggestions(project).map((item, index) => `${index + 1}. ${item}`),
    '',
    'Lumi 执行规则：',
    '1. 常规材料比价、方案整理、交付包生成由 Lumi 接管。',
    '2. 涉及承重结构、燃气改造、最终报价签字和付款节点，必须向用户上报。',
    '3. 微信回复默认只准备草稿，不自动发送，除非用户明确授权。',
  ].join('\n');
}

function materialSuggestions(project: DesignProjectBrief): string[] {
  if (/奶油|原木|日式|北欧/.test(project.style)) {
    return ['低饱和暖白墙面，搭配木色柜体和柔和灯光。', '公共区优先耐磨地砖或稳定木地板，避免后期维护压力。', '定制柜体控制造型线条，用五金和灯光提升质感。'];
  }
  if (/新中式|法式|中古|美式/.test(project.style)) {
    return ['用局部线条、木饰面或石材建立风格识别，不做全屋堆叠。', '主材色系保持统一，避免预算被复杂造型消耗。', '软装后置确认，先把硬装比例和收口做好。'];
  }
  return ['公共区以暖白、浅灰石材和木色为底，降低压迫感。', '厨房、卫生间优先防滑砖和耐污台面，先保证使用寿命。', '局部金属、深色柜体或低饱和彩色做点缀，控制轻奢感不过度堆料。'];
}

function buildWechatDeliveryDraft(project: DesignProjectBrief): string {
  return [
    '您好，我这边已经先把需求整理成一版可推进的设计交付包。',
    '',
    `这版是按 ${project.areaSqm} 平 ${project.layout}、${project.style}、${project.budgetLabel} 来整理的，重点先解决 ${project.clientFocus.join('、')}。`,
    '',
    '这版里面包括：',
    ...project.deliverables.map((item, index) => `${index + 1}. ${item}；`),
    '',
    '目前这版可以先用于确认风格、预算和主要动线。进入正式施工图前，还需要复核现场精确尺寸、承重结构、梁位、管井和原始水电点位。',
    '',
    '如果您认可这个方向，我下一步会把它深化成施工图清单和可确认报价。',
  ].join('\n');
}

function buildDynamoScriptText(project: DesignProjectBrief): string {
  return [
    '# Lumi Revit / Dynamo handoff script',
    `# Project: ${project.projectTitle}`,
    '# Purpose: create model-ready spaces from the design delivery package.',
    '# Run inside a reviewed Revit/Dynamo environment after confirming site dimensions.',
    '',
    'rooms = [',
    ...project.roomLabels.map((room, index) => {
      const x = (index % 3) * 3200;
      const y = Math.floor(index / 3) * 3000;
      return `    {"name": "${room}", "x": ${x}, "y": ${y}, "width": 3000, "height": 2600, "finish": "${finishForRoom(room, project)}"},`;
    }),
    ']',
    '',
    'materials = {',
    `    "style": "${project.style}",`,
    `    "budget": "${project.budgetLabel}",`,
    `    "focus": "${project.clientFocus.join(' / ')}",`,
    '}',
    '',
    'print("Create Revit levels, room boundaries, walls, room tags, and material schedule from Lumi handoff data.")',
  ].join('\n');
}

function finishForRoom(room: string, project: DesignProjectBrief): string {
  if (/厨房|后勤|卫生/.test(room)) return 'anti-slip tile';
  if (/客餐厅|入口|玄关/.test(room)) return /轻奢|法式|新中式/.test(project.style) ? 'stone tile + wall finish' : 'tile + wood finish';
  return /原木|日式|北欧|奶油/.test(project.style) ? 'wood floor + warm wall paint' : 'wood floor';
}

function buildRoomScheduleCsv(project: DesignProjectBrief): string {
  return [
    'name,x,y,width,height,finish',
    ...project.roomLabels.map((room, index) => {
      const x = (index % 3) * 3200;
      const y = Math.floor(index / 3) * 3000;
      return `${room},${x},${y},3000,2600,${finishForRoom(room, project)}`;
    }),
  ].join('\n');
}

function normalizeIntentText(text: string): string {
  return text.replace(/\s+/g, '');
}

function isLocalSourceCadExecutionRequest(text: string): boolean {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  const hasLocalSource =
    /\b(?:desktop|local|folder|directory|path|files?)\b/i.test(raw)
    || /(?:\u684c\u9762|\u672c\u5730|\u6587\u4ef6\u5939|\u76ee\u5f55|\u8def\u5f84|\u91cc\u9762|\u5185\u5bb9|\u8d44\u6599)/u.test(raw);
  const hasSourceReading =
    /\b(?:read|scan|inspect|according\s+to|based\s+on|from)\b/i.test(raw)
    || /(?:\u8bfb\u53d6|\u8bfb|\u626b\u63cf|\u67e5\u770b|\u6574\u7406|\u6309\u7167|\u6839\u636e|\u4f9d\u636e|\u91cc\u9762\u7684|\u5185\u5bb9)/u.test(raw);
  const hasCadExecution =
    /\b(?:cad|dxf|dwg|autocad|draw|draft|floor\s*plan)\b/i.test(raw)
    || /(?:\u56fe\u7eb8|\u753b\u56fe|\u753b\u51fa\u6765|\u7ed8\u5236|\u5b9e\u64cd|\u5b9e\u9645\u753b|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe)/u.test(raw);

  return hasLocalSource && hasSourceReading && hasCadExecution;
}

export function isDesignDeliveryRequest(text: string): boolean {
  const raw = String(text || '');
  const normalized = normalizeIntentText(raw);
  if (!normalized) return false;
  if (EXPLICIT_REUSABLE_CAD_TOOL_RE.test(raw)) return false;
  if (isLocalSourceCadExecutionRequest(raw)) return false;
  if (!EXPLICIT_DESIGN_DELIVERY_SCOPE_RE.test(raw)) return false;
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

function buildOpenFileWithAppCommand(appPath: string, filePath: string): string {
  const app = appPath ? psString(appPath) : '$null';
  const file = psString(filePath);
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$app = ${app}
$file = ${file}
if ($app -and (Test-Path -LiteralPath $app)) {
  try {
    Start-Process -FilePath $app -ArgumentList @($file)
    Write-Output "OPENED_WITH_APP"
    exit 0
  } catch {}
  try {
    Start-Process -FilePath $app
    Start-Sleep -Seconds 2
    Start-Process -FilePath $file
    Write-Output "OPENED_APP_THEN_FILE"
    exit 0
  } catch {}
}
try {
  Start-Process -FilePath $file
  Write-Output "OPENED_FILE_DEFAULT"
  exit 0
} catch {}
Write-Output "OPEN_ATTEMPTED"
exit 0
`.trim();
  return powershellCommand(script);
}

function buildOpenRevitHandoffCommand(appPath: string, dynamoScriptPath: string, roomSchedulePath: string): string {
  const app = appPath ? psString(appPath) : '$null';
  const script = psString(dynamoScriptPath);
  const schedule = psString(roomSchedulePath);
  const command = `
$ErrorActionPreference = 'SilentlyContinue'
$app = ${app}
$script = ${script}
$schedule = ${schedule}
if ($app -and (Test-Path -LiteralPath $app)) {
  try {
    Start-Process -FilePath $app -ArgumentList @($script)
    Write-Output "OPENED_REVIT_APP"
    exit 0
  } catch {}
  try {
    Start-Process -FilePath $app
    Start-Sleep -Seconds 2
    Write-Output "OPENED_REVIT_ENTRY"
    exit 0
  } catch {}
}
try {
  Start-Process -FilePath $script
  Start-Sleep -Seconds 1
  Start-Process -FilePath $schedule
  Write-Output "OPENED_REVIT_HANDOFF_FILES"
  exit 0
} catch {}
Write-Output "OPEN_REVIT_HANDOFF_ATTEMPTED"
exit 0
`.trim();
  return powershellCommand(command);
}

function buildOpenWeChatCommand(personalShortcutPath: string, enterpriseShortcutPath: string): string {
  const personalShortcut = personalShortcutPath ? psString(personalShortcutPath) : '$null';
  const enterpriseShortcut = enterpriseShortcutPath ? psString(enterpriseShortcutPath) : '$null';
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class LumiWinFocus {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
$personalShortcut = ${personalShortcut}
$enterpriseShortcut = ${enterpriseShortcut}

function Focus-ProcessWindow($process, $label) {
  if (-not $process) { return $false }
  try {
    if ($process.MainWindowHandle -and $process.MainWindowHandle -ne 0) {
      [LumiWinFocus]::ShowWindowAsync($process.MainWindowHandle, 9) | Out-Null
      Start-Sleep -Milliseconds 250
      [LumiWinFocus]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
      Start-Sleep -Milliseconds 250
      try { [Microsoft.VisualBasic.Interaction]::AppActivate($process.Id) | Out-Null } catch {}
      Write-Output "WECHAT_FOCUSED_WINDOW:$label"
      return $true
    }
  } catch {}
  return $false
}

function Focus-PersonalWeChat {
  $processes = Get-Process | Where-Object { $_.ProcessName -match '^(Weixin|WeChat)$' } | Sort-Object @{ Expression = { if ($_.MainWindowTitle -match '微信|WeChat|Weixin') { 0 } else { 1 } } }, Id
  foreach ($process in $processes) {
    if (Focus-ProcessWindow $process $process.ProcessName) { return $true }
  }
  return $false
}

if (Focus-PersonalWeChat) { exit 0 }

$personalTitles = @('微信', 'Weixin', 'WeChat')
foreach ($title in $personalTitles) {
  try {
    if ([Microsoft.VisualBasic.Interaction]::AppActivate($title)) {
      Write-Output "WECHAT_FOCUSED_EXISTING:$title"
      exit 0
    }
  } catch {}
}

$personalProcess = Get-Process | Where-Object { $_.ProcessName -match '^(Weixin|WeChat)$' } | Select-Object -First 1
if ($personalProcess) {
  try {
    if ([Microsoft.VisualBasic.Interaction]::AppActivate($personalProcess.Id)) {
      Write-Output "WECHAT_FOCUSED_PROCESS:$($personalProcess.ProcessName)"
      exit 0
    }
  } catch {}
}

if ($personalShortcut -and (Test-Path -LiteralPath $personalShortcut)) {
  try {
    Start-Process -FilePath $personalShortcut
    Start-Sleep -Seconds 2
    if (Focus-PersonalWeChat) {
      Write-Output "WECHAT_OPENED_PERSONAL_SHORTCUT"
      exit 0
    }
    foreach ($title in $personalTitles) {
      if ([Microsoft.VisualBasic.Interaction]::AppActivate($title)) {
        Write-Output "WECHAT_OPENED_PERSONAL_SHORTCUT"
        exit 0
      }
    }
  } catch {}
}

$personalCandidates = @(
  "D:\\Weixin\\Weixin.exe",
  "$env:ProgramFiles\\Tencent\\Weixin\\Weixin.exe",
  "$env:ProgramFiles(x86)\\Tencent\\Weixin\\Weixin.exe",
  "$env:LOCALAPPDATA\\Tencent\\Weixin\\Weixin.exe",
  "$env:ProgramFiles\\Tencent\\WeChat\\WeChat.exe",
  "$env:ProgramFiles(x86)\\Tencent\\WeChat\\WeChat.exe",
  "$env:LOCALAPPDATA\\Tencent\\WeChat\\WeChat.exe",
  "Weixin.exe",
  "WeChat.exe"
)
foreach ($candidate in $personalCandidates) {
  try {
    if ((Test-Path -LiteralPath $candidate) -or $candidate -match '^(Weixin|WeChat)\\.exe$') {
      Start-Process -FilePath $candidate
      Start-Sleep -Seconds 2
      if (Focus-PersonalWeChat) {
        Write-Output "WECHAT_OPENED_PERSONAL_EXE"
        exit 0
      }
      foreach ($title in $personalTitles) {
        if ([Microsoft.VisualBasic.Interaction]::AppActivate($title)) {
          Write-Output "WECHAT_OPENED_PERSONAL_EXE"
          exit 0
        }
      }
    }
  } catch {}
}

if ($enterpriseShortcut -and (Test-Path -LiteralPath $enterpriseShortcut)) {
  try {
    Start-Process -FilePath $enterpriseShortcut
    Start-Sleep -Seconds 2
    if ([Microsoft.VisualBasic.Interaction]::AppActivate('企业微信')) {
      Write-Output "WECHAT_OPENED_ENTERPRISE_FALLBACK"
      exit 0
    }
  } catch {}
}

Write-Output "WECHAT_FOCUS_ATTEMPTED"
exit 0
`.trim();
  return powershellCommand(script);
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

function buildRenovationDxf(project = DEFAULT_DESIGN_PROJECT_BRIEF): string {
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
    ...dxfText(300, -520, `Lumi CAD draft - ${project.projectTitle} - review site dimensions before production`, 180, 'TITLE'),
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

function buildCadPreviewSvg(project = DEFAULT_DESIGN_PROJECT_BRIEF): string {
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
  <text class="label" x="0" y="-220">${xmlEscape(project.projectTitle)} CAD 平面布置预览</text>
  <text class="small" x="0" y="9060">${xmlEscape(project.budgetLabel)}；正式施工图前请复核现场精确尺寸、承重墙、梁位和水电点位。</text>
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

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pptTextShape(
  id: number,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  paragraphs: Array<{ text: string; size?: number; color?: string; bold?: boolean; bullet?: boolean }>,
): string {
  const paraXml = paragraphs.map((para) => {
    const color = para.color || 'E2E8F0';
    const size = Math.round((para.size || 20) * 100);
    const bullet = para.bullet ? '<a:pPr marL="342900" indent="-171450"><a:buChar char="•"/></a:pPr>' : '<a:pPr/>';
    const bold = para.bold ? ' b="1"' : '';
    return `<a:p>${bullet}<a:r><a:rPr lang="zh-CN" sz="${size}"${bold}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${xmlEscape(para.text)}</a:t></a:r></a:p>`;
  }).join('');
  return `
    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="${id}" name="${xmlEscape(name)}"/>
        <p:cNvSpPr txBox="1"/>
        <p:nvPr/>
      </p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        <a:noFill/>
        <a:ln><a:noFill/></a:ln>
      </p:spPr>
      <p:txBody>
        <a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/>
        <a:lstStyle/>
        ${paraXml}
      </p:txBody>
    </p:sp>`;
}

function pptRectShape(id: number, name: string, x: number, y: number, width: number, height: number, fill: string, alpha = 100000): string {
  return `
    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="${id}" name="${xmlEscape(name)}"/>
        <p:cNvSpPr/>
        <p:nvPr/>
      </p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm>
        <a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>
        <a:solidFill><a:srgbClr val="${fill}"><a:alpha val="${alpha}"/></a:srgbClr></a:solidFill>
        <a:ln><a:noFill/></a:ln>
      </p:spPr>
    </p:sp>`;
}

type PptVisualKind = 'cover' | 'plan' | 'living' | 'materials' | 'budget' | 'handoff';

function pptVisualShape(kind: PptVisualKind, accent: string, project = DEFAULT_DESIGN_PROJECT_BRIEF): string {
  const panelX = 5050000;
  const panelY = 1220000;
  const panelW = 3500000;
  const panelH = 3550000;
  const title = (text: string) => pptTextShape(40, 'Visual title', panelX + 260000, panelY + 190000, panelW - 520000, 300000, [
    { text, size: 15, color: '2F3A34', bold: true },
  ]);
  const note = (id: number, text: string, x: number, y: number, w = 850000, color = '475569') => pptTextShape(id, `Visual note ${id}`, x, y, w, 220000, [
    { text, size: 9, color, bold: true },
  ]);
  const frame = pptRectShape(30, 'Visual card', panelX, panelY, panelW, panelH, 'FFFFFF', 100000);

  if (kind === 'cover') {
    return [
      pptRectShape(30, 'Hero card', panelX, panelY, panelW, panelH, '20342D', 100000),
      pptRectShape(31, 'Hero plan base', panelX + 360000, panelY + 560000, 2500000, 1840000, 'F6F0E6', 100000),
      pptRectShape(32, 'Living', panelX + 880000, panelY + 780000, 1080000, 700000, 'CFE5D8', 100000),
      pptRectShape(33, 'Kitchen', panelX + 2030000, panelY + 780000, 520000, 700000, 'EBD7B6', 100000),
      pptRectShape(34, 'Bedroom', panelX + 880000, panelY + 1540000, 760000, 520000, 'D8D5EA', 100000),
      pptRectShape(35, 'Study', panelX + 1720000, panelY + 1540000, 830000, 520000, 'D7E6EA', 100000),
      pptRectShape(36, 'Chip warm', panelX + 440000, panelY + 2760000, 520000, 220000, 'F3E7D3', 100000),
      pptRectShape(37, 'Chip stone', panelX + 1070000, panelY + 2760000, 520000, 220000, 'BFC8C2', 100000),
      pptRectShape(38, 'Chip wood', panelX + 1700000, panelY + 2760000, 520000, 220000, 'A56A43', 100000),
      pptRectShape(39, 'Chip metal', panelX + 2330000, panelY + 2760000, 520000, 220000, 'C6A15B', 100000),
      pptTextShape(41, 'Hero caption', panelX + 420000, panelY + 3100000, 2600000, 300000, [
        { text: `${project.layout} + ${project.style} + ${project.budgetLabel}`, size: 13, color: 'F8FAFC', bold: true },
      ]),
    ].join('');
  }

  if (kind === 'plan') {
    return [
      frame,
      title('平面布局示意'),
      pptRectShape(31, 'Plan border', panelX + 330000, panelY + 720000, 2760000, 2140000, 'EEF1EC', 100000),
      pptRectShape(32, 'Entrance', panelX + 420000, panelY + 820000, 620000, 1040000, 'E7F3F0', 100000),
      pptRectShape(33, 'Living Dining', panelX + 1050000, panelY + 820000, 1360000, 1040000, 'D9E8D8', 100000),
      pptRectShape(34, 'Kitchen', panelX + 2430000, panelY + 820000, 520000, 1040000, 'EFE0C8', 100000),
      pptRectShape(35, 'Master', panelX + 420000, panelY + 1920000, 960000, 760000, 'E5DDEC', 100000),
      pptRectShape(36, 'Second Bedroom', panelX + 1410000, panelY + 1920000, 760000, 760000, 'D8E4EA', 100000),
      pptRectShape(37, 'Study', panelX + 2200000, panelY + 1920000, 750000, 760000, 'E9E3D4', 100000),
      pptRectShape(38, 'Main aisle', panelX + 1040000, panelY + 1220000, 1440000, 150000, accent, 72000),
      note(41, '玄关收纳', panelX + 510000, panelY + 1260000),
      note(42, '客餐厅一体', panelX + 1320000, panelY + 1260000, 1000000),
      note(43, 'U 型厨房', panelX + 2480000, panelY + 1260000),
      note(44, '主卧', panelX + 750000, panelY + 2250000),
      note(45, '次卧', panelX + 1610000, panelY + 2250000),
      note(46, '书房', panelX + 2420000, panelY + 2250000),
      note(47, '3.2m 主通道', panelX + 1390000, panelY + 1050000, 960000, '1F7A5A'),
    ].join('');
  }

  if (kind === 'living') {
    return [
      frame,
      title('客餐厅设计关系'),
      pptRectShape(31, 'Floor', panelX + 320000, panelY + 2500000, 2860000, 220000, 'D7C4A8', 100000),
      pptRectShape(32, 'Back wall', panelX + 420000, panelY + 760000, 2600000, 520000, 'E7E0D5', 100000),
      pptRectShape(33, 'TV storage', panelX + 620000, panelY + 880000, 800000, 250000, '2F3A34', 100000),
      pptRectShape(34, 'Vertical cabinet', panelX + 430000, panelY + 1320000, 480000, 1050000, '53665C', 100000),
      pptRectShape(35, 'Sofa', panelX + 980000, panelY + 2030000, 1050000, 380000, 'A7B7AA', 100000),
      pptRectShape(36, 'Coffee table', panelX + 2090000, panelY + 2020000, 520000, 260000, 'F7F3EA', 100000),
      pptRectShape(37, 'Dining table', panelX + 2160000, panelY + 1370000, 720000, 360000, 'C69C6D', 100000),
      pptRectShape(38, 'Light strip', panelX + 660000, panelY + 700000, 2120000, 65000, accent, 100000),
      note(41, '电视墙隐藏收纳', panelX + 1500000, panelY + 910000, 1200000),
      note(42, '餐边柜 + 冰箱区', panelX + 460000, panelY + 2400000, 1200000),
      note(43, '餐桌靠近厨房', panelX + 2220000, panelY + 1780000, 1000000),
      note(44, '主通道留白', panelX + 2040000, panelY + 2320000, 1000000),
    ].join('');
  }

  if (kind === 'materials') {
    return [
      frame,
      title('材料与色彩'),
      pptRectShape(31, 'Warm white', panelX + 420000, panelY + 800000, 680000, 760000, 'F6F0E6', 100000),
      pptRectShape(32, 'Stone', panelX + 1180000, panelY + 800000, 680000, 760000, 'BFC8C2', 100000),
      pptRectShape(33, 'Wood', panelX + 1940000, panelY + 800000, 680000, 760000, '9E6B45', 100000),
      pptRectShape(34, 'Charcoal', panelX + 420000, panelY + 1900000, 680000, 760000, '2F3A34', 100000),
      pptRectShape(35, 'Sage', panelX + 1180000, panelY + 1900000, 680000, 760000, '708B78', 100000),
      pptRectShape(36, 'Brass', panelX + 1940000, panelY + 1900000, 680000, 760000, 'C6A15B', 100000),
      note(41, '暖白墙面', panelX + 465000, panelY + 1600000),
      note(42, '浅灰石材', panelX + 1225000, panelY + 1600000),
      note(43, '木饰面', panelX + 2020000, panelY + 1600000),
      note(44, '深色柜体', panelX + 465000, panelY + 2700000),
      note(45, '低饱和绿', panelX + 1225000, panelY + 2700000),
      note(46, '金属点缀', panelX + 2020000, panelY + 2700000),
    ].join('');
  }

  if (kind === 'budget') {
    const lines = project.budgetLines;
    const max = Math.max(...lines.map(line => line.amountWan), 1);
    const bar = (id: number, y: number, w: number, fill: string, text: string) => [
      pptRectShape(id, `Bar track ${id}`, panelX + 420000, y, 2350000, 230000, 'ECE7DD', 100000),
      pptRectShape(id + 10, `Bar ${id}`, panelX + 420000, y, w, 230000, fill, 100000),
      note(id + 20, text, panelX + 450000, y + 28000, 1900000, '2F3A34'),
    ].join('');
    const widthFor = (amount: number) => Math.max(520000, Math.round(2180000 * amount / max));
    return [
      frame,
      title(`${project.budgetLabel}拆分`),
      ...lines.slice(0, 5).map((line, index) => bar(31 + index, panelY + 840000 + index * 400000, widthFor(line.amountWan), ['22C55E', '6BA6A6', '9B8BB4', 'C69C6D', '708B78'][index] || accent, `${line.label} ${formatWan(line.amountWan)}`)),
      note(56, `${lines[4]?.label || '风险预留'}：结构、燃气、水电变更需确认`, panelX + 420000, panelY + 2980000, 2600000, '8A5A2B'),
    ].join('');
  }

  return [
    frame,
    title('交付包内容'),
    pptRectShape(31, 'PPT', panelX + 450000, panelY + 820000, 920000, 520000, accent, 100000),
    pptRectShape(32, 'PDF', panelX + 1540000, panelY + 820000, 920000, 520000, '6BA6A6', 100000),
    pptRectShape(33, 'CAD', panelX + 450000, panelY + 1660000, 920000, 520000, '9B8BB4', 100000),
    pptRectShape(34, 'BIM', panelX + 1540000, panelY + 1660000, 920000, 520000, 'C69C6D', 100000),
    note(41, 'PPT 汇报', panelX + 610000, panelY + 1000000, 800000, 'FFFFFF'),
    note(42, 'PDF 确认', panelX + 1700000, panelY + 1000000, 800000, 'FFFFFF'),
    note(43, 'DXF 初稿', panelX + 620000, panelY + 1840000, 800000, 'FFFFFF'),
    note(44, 'Revit 交接', panelX + 1660000, panelY + 1840000, 900000, 'FFFFFF'),
    note(45, '微信草稿等待确认，不自动发送', panelX + 620000, panelY + 2660000, 2300000, '2F3A34'),
  ].join('');
}

function buildPptSlideXml(index: number, title: string, subtitle: string, bullets: string[], accent: string, visual: PptVisualKind, project = DEFAULT_DESIGN_PROJECT_BRIEF): string {
  const bulletParagraphs = bullets.map(text => ({ text, size: 17, color: '334155', bullet: true }));
  const isCover = visual === 'cover';
  const shapes = [
    pptRectShape(2, 'Top rule', 457200, 420000, 2100000, 90000, accent),
    pptTextShape(3, 'Deck label', 457200, 560000, 2500000, 260000, [
      { text: 'LUMI DESIGN PROPOSAL', size: 10, color: '64748B', bold: true },
    ]),
    pptTextShape(4, 'Title', 457200, isCover ? 950000 : 780000, 4150000, isCover ? 1260000 : 920000, [
      { text: title, size: isCover ? 38 : 30, color: '1F2933', bold: true },
      { text: subtitle, size: isCover ? 17 : 14, color: '66736A' },
    ]),
    pptRectShape(5, 'Content card', 620000, isCover ? 2460000 : 1820000, 3920000, isCover ? 1500000 : 2500000, 'FFFFFF', 100000),
    pptTextShape(6, 'Bullets', 900000, isCover ? 2740000 : 2120000, 3300000, isCover ? 980000 : 1850000, bulletParagraphs),
    pptVisualShape(visual, accent, project),
    pptTextShape(7, 'Footer', 700000, 6200000, 7600000, 260000, [
      { text: `Lumi design delivery package · ${String(index).padStart(2, '0')}`, size: 10, color: '8B928B' },
    ]),
  ].join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="F7F3EA"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${shapes}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function buildPptContentTypes(slideCount: number): string {
  const slideOverrides = Array.from({ length: slideCount }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
  <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
  <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
  ${slideOverrides}
</Types>`;
}

function buildPptPresentationXml(slideCount: number): string {
  const slideIds = Array.from({ length: slideCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>${slideIds}</p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:defaultTextStyle/>
</p:presentation>`;
}

function buildPptPresentationRels(slideCount: number): string {
  const slideRels = Array.from({ length: slideCount }, (_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  ${slideRels}
  <Relationship Id="rId${slideCount + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>
  <Relationship Id="rId${slideCount + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>
  <Relationship Id="rId${slideCount + 4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>
</Relationships>`;
}

function writeFileEnsured(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function zipDirectory(sourceDir: string, outPath: string): void {
  if (fs.existsSync(outPath)) fs.rmSync(outPath, { force: true });
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = (Get-Item -LiteralPath ${psString(sourceDir)}).FullName
$dst = ${psString(outPath)}
if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force }
$zip = [System.IO.Compression.ZipFile]::Open($dst, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length).TrimStart([char]92, [char]47)
    $entry = $rel.Replace([char]92, [char]47)
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entry) | Out-Null
  }
} finally {
  $zip.Dispose()
}
`.trim();
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 20000 });
}

function createDesignPresentationPptx(outPath: string, project = DEFAULT_DESIGN_PROJECT_BRIEF): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-design-pptx-'));
  const slides = [
    {
      title: `${project.areaSqm} 平 ${project.layout}装修方案`,
      subtitle: `${project.style} / ${project.budgetLabel} / 可深化到 CAD 与 Revit`,
      bullets: [
        `客户目标：围绕 ${project.clientFocus.join('、')} 快速确认方案方向`,
        `核心策略：${project.strategy[0]}`,
        `交付结果：${project.deliverables.join('、')}`,
      ],
      accent: '22C55E',
      visual: 'cover' as PptVisualKind,
    },
    {
      title: '平面布局怎么设计',
      subtitle: '先解决动线、收纳、采光，再进入造型',
      bullets: project.roomLabels.slice(0, 4).map(room => `${room}：${roomStrategy(room, project)}`),
      accent: '38BDF8',
      visual: 'plan' as PptVisualKind,
    },
    {
      title: '客餐厅效果怎么落地',
      subtitle: '开放感、收纳和预算之间的平衡',
      bullets: [
        `主空间先服务 ${project.clientFocus.slice(0, 3).join('、')}，再进入造型表达`,
        '电视墙和餐边柜优先承担收纳，避免只做装饰背景浪费空间',
        '沙发、餐桌和通道形成清晰视线轴，增强空间尺度感',
        '灯光用主灯、线性灯和局部氛围灯分层，控制风格不过度堆料',
      ],
      accent: 'A78BFA',
      visual: 'living' as PptVisualKind,
    },
    {
      title: '材料与色彩建议',
      subtitle: `${project.style} 的材料落地方式`,
      bullets: materialSuggestions(project),
      accent: 'F59E0B',
      visual: 'materials' as PptVisualKind,
    },
    {
      title: '预算怎么控制',
      subtitle: `${project.budgetLabel}，先保功能，再做颜值`,
      bullets: project.budgetLines.slice(0, 4).map(line => `${line.label}：${formatWan(line.amountWan)}，${line.note}`),
      accent: '14B8A6',
      visual: 'budget' as PptVisualKind,
    },
    {
      title: '交付包与下一步',
      subtitle: '客户确认方向后进入深化图纸和报价',
      bullets: [
        `${project.deliverables.join('、')} 已进入交付包`,
        'CAD DXF 进入外部 CAD 软件继续标注、调图层、深化施工图',
        'Dynamo 脚本和空间表交给 Revit / BIM 侧继续建模',
        '微信草稿只准备，不默认发送；确认后再推进客户',
      ],
      accent: 'F59E0B',
      visual: 'handoff' as PptVisualKind,
    },
  ];

  try {
    writeFileEnsured(path.join(tmpDir, '[Content_Types].xml'), buildPptContentTypes(slides.length));
    writeFileEnsured(path.join(tmpDir, '_rels', '.rels'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
    writeFileEnsured(path.join(tmpDir, 'docProps', 'core.xml'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/"
                   xmlns:dcmitype="http://purl.org/dc/dcmitype/"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(project.projectTitle)} 汇报</dc:title>
  <dc:creator>Lumi</dc:creator>
  <cp:lastModifiedBy>Lumi</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`);
    writeFileEnsured(path.join(tmpDir, 'docProps', 'app.xml'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
            xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>LumiOS</Application>
  <PresentationFormat>On-screen Show (16:9)</PresentationFormat>
  <Slides>${slides.length}</Slides>
</Properties>`);
    writeFileEnsured(path.join(tmpDir, 'ppt', 'presentation.xml'), buildPptPresentationXml(slides.length));
    writeFileEnsured(path.join(tmpDir, 'ppt', '_rels', 'presentation.xml.rels'), buildPptPresentationRels(slides.length));
    writeFileEnsured(path.join(tmpDir, 'ppt', 'slideMasters', 'slideMaster1.xml'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>
</p:sldMaster>`);
    writeFileEnsured(path.join(tmpDir, 'ppt', 'slideMasters', '_rels', 'slideMaster1.xml.rels'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`);
    writeFileEnsured(path.join(tmpDir, 'ppt', 'slideLayouts', 'slideLayout1.xml'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`);
    writeFileEnsured(path.join(tmpDir, 'ppt', 'slideLayouts', '_rels', 'slideLayout1.xml.rels'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`);
    writeFileEnsured(path.join(tmpDir, 'ppt', 'theme', 'theme1.xml'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Lumi">
  <a:themeElements>
    <a:clrScheme name="Lumi"><a:dk1><a:srgbClr val="0F172A"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="111827"/></a:dk2><a:lt2><a:srgbClr val="E2E8F0"/></a:lt2><a:accent1><a:srgbClr val="22C55E"/></a:accent1><a:accent2><a:srgbClr val="38BDF8"/></a:accent2><a:accent3><a:srgbClr val="A78BFA"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="14B8A6"/></a:accent5><a:accent6><a:srgbClr val="F43F5E"/></a:accent6><a:hlink><a:srgbClr val="38BDF8"/></a:hlink><a:folHlink><a:srgbClr val="A78BFA"/></a:folHlink></a:clrScheme>
    <a:fontScheme name="Lumi"><a:majorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:majorFont><a:minorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Lumi"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements>
</a:theme>`);
    writeFileEnsured(path.join(tmpDir, 'ppt', 'presProps.xml'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`);
    writeFileEnsured(path.join(tmpDir, 'ppt', 'viewProps.xml'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`);
    writeFileEnsured(path.join(tmpDir, 'ppt', 'tableStyles.xml'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
    slides.forEach((slide, index) => {
      const slideNo = index + 1;
      writeFileEnsured(path.join(tmpDir, 'ppt', 'slides', `slide${slideNo}.xml`), buildPptSlideXml(slideNo, slide.title, slide.subtitle, slide.bullets, slide.accent, slide.visual, project));
      writeFileEnsured(path.join(tmpDir, 'ppt', 'slides', '_rels', `slide${slideNo}.xml.rels`), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`);
    });
    zipDirectory(tmpDir, outPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return outPath;
}

function buildReportHtml(cadPreviewPath: string, project = DEFAULT_DESIGN_PROJECT_BRIEF): string {
  const cadPreviewUrl = pathToFileURL(cadPreviewPath).href;
  const focusText = project.clientFocus.join('、');
  const deliverableText = project.deliverables.join(' / ');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${htmlEscape(project.projectTitle)} PDF</title>
  <style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Microsoft YaHei", "SimHei", Arial, sans-serif; color: #0f172a; background: #f8fafc; }
    section { page-break-after: always; min-height: 267mm; padding: 18mm 14mm; background: #ffffff; }
    section:last-child { page-break-after: auto; }
    .cover { background: linear-gradient(135deg, #0f172a, #064e3b); color: #fff; display: flex; flex-direction: column; justify-content: center; }
    h1 { font-size: 38px; margin: 0 0 16px; }
    h2 { font-size: 26px; margin: 0 0 14px; color: #065f46; }
    p, li { font-size: 15px; line-height: 1.85; }
    .subtitle { font-size: 20px; color: #a7f3d0; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 20px; }
    .card { border: 1px solid #d1fae5; background: #ecfdf5; border-radius: 10px; padding: 14px; }
    .label { font-size: 12px; color: #64748b; letter-spacing: 0.08em; text-transform: uppercase; }
    .value { margin-top: 6px; font-size: 18px; font-weight: 700; }
    img { max-width: 100%; border: 1px solid #cbd5e1; border-radius: 10px; }
    .note { margin-top: 18px; padding: 12px; border-left: 4px solid #f59e0b; background: #fffbeb; color: #78350f; }
  </style>
</head>
<body>
  <section class="cover">
    <div class="label">LUMI DESIGN DELIVERY</div>
    <h1>${htmlEscape(project.projectTitle)}</h1>
    <div class="subtitle">${htmlEscape(project.style)} / ${htmlEscape(project.budgetLabel)} / ${htmlEscape(deliverableText)}</div>
    <p>本 PDF 用于客户确认和微信/邮件交付，PPTX 用于现场汇报和继续修改。</p>
  </section>
  <section>
    <h2>一、项目判断</h2>
    <p>客户需求已被 Lumi 拆解为正式设计交付任务：${project.areaSqm} 平 ${htmlEscape(project.layout)}，${htmlEscape(project.style)} 方向，${htmlEscape(project.budgetLabel)}。</p>
    <div class="grid">
      <div class="card"><div class="label">空间策略</div><div class="value">${htmlEscape(focusText)}</div></div>
      <div class="card"><div class="label">交付目标</div><div class="value">快速确认方案并进入深化</div></div>
      <div class="card"><div class="label">文件结果</div><div class="value">${htmlEscape(deliverableText)}</div></div>
      <div class="card"><div class="label">授权边界</div><div class="value">结构、燃气、签字、付款上报</div></div>
    </div>
    <div class="note">正式施工图前必须复核现场精确尺寸、承重墙、梁位、管井和原始水电点位。</div>
  </section>
  <section>
    <h2>二、CAD 平面预览</h2>
    <p>下图来自同一交付包内的 SVG 预览，对应 DXF 平面布置初稿，可进入 CAD 软件继续深化。</p>
    <img src="${cadPreviewUrl}" alt="CAD preview" />
  </section>
  <section>
    <h2>三、交付清单</h2>
    <ul>
      <li>01-Lumi-装修设计方案.rtf：客户需求、空间策略、交付节奏和风险点。</li>
      <li>02-Lumi-预算与材料清单.rtf：预算控制线、基础施工、主材、定制和风险预留。</li>
      <li>03-Lumi-装修设计方案汇报.pptx / .pdf：汇报和发送版本。</li>
      <li>04-Lumi-CAD-平面布置.dxf：CAD 深化初稿。</li>
      <li>05-Lumi-Revit-Dynamo建模脚本.py / 空间表.csv：Revit 侧建模交接数据。</li>
      <li>06-Lumi-微信交付话术.txt：发送前等待用户确认的客户回复草稿。</li>
    </ul>
    <h2>四、下一步确认</h2>
    <ul>
      ${project.confirmItems.map(item => `<li>${htmlEscape(item)}</li>`).join('')}
    </ul>
    <p>下一步：客户确认方向后，Lumi 继续推进施工图清单、报价深化和交底版本。</p>
  </section>
</body>
</html>`;
}

function buildHandoffPageShell(title: string, eyebrow: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${htmlEscape(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Microsoft YaHei", "SimHei", Arial, sans-serif;
      color: #e5f4ff;
      background: #08111f;
    }
    main { width: min(1180px, calc(100vw - 56px)); margin: 0 auto; padding: 32px 0 42px; }
    .eyebrow { color: #67e8f9; font-size: 12px; font-weight: 900; letter-spacing: .22em; text-transform: uppercase; }
    h1 { margin: 10px 0 10px; font-size: 34px; line-height: 1.16; }
    p { color: rgba(229, 244, 255, .72); line-height: 1.8; }
    .grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(280px, .75fr); gap: 18px; align-items: stretch; margin-top: 22px; }
    .panel { border: 1px solid rgba(103, 232, 249, .18); border-radius: 10px; background: rgba(15, 23, 42, .78); padding: 18px; box-shadow: 0 22px 54px rgba(0, 0, 0, .32); }
    .path { margin-top: 10px; padding: 11px 12px; border-radius: 8px; background: rgba(15, 23, 42, .9); color: #bae6fd; font-family: Consolas, "Microsoft YaHei", monospace; font-size: 13px; word-break: break-all; }
    .stat { display: grid; gap: 10px; margin-top: 14px; }
    .stat div { border: 1px solid rgba(255,255,255,.08); border-radius: 8px; padding: 12px; background: rgba(255,255,255,.035); }
    .stat b { display: block; margin-bottom: 4px; color: #fff; }
    img { width: 100%; max-height: 680px; object-fit: contain; border-radius: 8px; background: #f8fafc; }
    pre { margin: 0; max-height: 510px; overflow: auto; white-space: pre-wrap; color: #dbeafe; font-size: 13px; line-height: 1.58; font-family: Consolas, "Microsoft YaHei", monospace; }
    table { width: 100%; border-collapse: collapse; margin-top: 14px; color: #e0f2fe; }
    th, td { border-bottom: 1px solid rgba(255,255,255,.09); padding: 10px 8px; text-align: left; font-size: 13px; }
    th { color: #67e8f9; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
    @media (max-width: 860px) { main { width: min(100vw - 28px, 720px); } .grid { grid-template-columns: 1fr; } h1 { font-size: 28px; } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">${htmlEscape(eyebrow)}</div>
    <h1>${htmlEscape(title)}</h1>
    ${body}
  </main>
</body>
</html>`;
}

function buildCadHandoffHtml(cadPreviewPath: string, cadDxfPath: string, project = DEFAULT_DESIGN_PROJECT_BRIEF): string {
  const cadPreviewUrl = pathToFileURL(cadPreviewPath).href;
  const body = `
    <p>这是 Lumi 为 ${htmlEscape(project.projectTitle)} 生成的 CAD 初稿检查页：左侧是可视化平面预览，右侧是已经落地的 DXF 文件信息。后续可交给 AutoCAD、LibreCAD、中望、浩辰等 CAD 软件继续标注和深化。</p>
    <div class="grid">
      <div class="panel"><img src="${cadPreviewUrl}" alt="CAD 平面布置预览" /></div>
      <div class="panel">
        <div class="eyebrow">DXF READY</div>
        <h2>04-Lumi-CAD-平面布置.dxf</h2>
        <div class="path">${htmlEscape(cadDxfPath)}</div>
        <div class="stat">
          <div><b>单位</b>毫米 mm</div>
          <div><b>图层</b>EXTERIOR_WALL / INTERIOR_WALL / DOOR / WINDOW / FURNITURE / TEXT</div>
          <div><b>项目</b>${project.areaSqm} 平 ${htmlEscape(project.layout)} / ${htmlEscape(project.style)} / ${htmlEscape(project.budgetLabel)}</div>
          <div><b>用途</b>作为 CAD 深化底稿，进入现场量尺复核、尺寸标注和施工图深化。</div>
        </div>
      </div>
    </div>`;
  return buildHandoffPageShell('Lumi CAD 初稿已生成', 'CAD HANDOFF CHECK', body);
}

function buildRevitHandoffHtml(dynamoScriptPath: string, revitCsvPath: string, roomScheduleCsv: string, project = DEFAULT_DESIGN_PROJECT_BRIEF): string {
  const rows = roomScheduleCsv
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.split(','))
    .filter(cols => cols.length >= 6)
    .map(cols => `<tr>${cols.map(col => `<td>${htmlEscape(col)}</td>`).join('')}</tr>`)
    .join('');
  const body = `
    <p>这是 Lumi 为 ${htmlEscape(project.projectTitle)} 准备给 Revit / Dynamo 的建模交接包：Dynamo 脚本负责创建空间数据入口，CSV 空间表负责把房间、坐标、尺寸和材料策略交给 BIM 侧继续建模。</p>
    <div class="grid">
      <div class="panel">
        <div class="eyebrow">DYNAMO SCRIPT</div>
        <h2>05-Lumi-Revit-Dynamo建模脚本.py</h2>
        <div class="path">${htmlEscape(dynamoScriptPath)}</div>
        <pre>${htmlEscape(buildDynamoScriptText(project).slice(0, 1800))}</pre>
      </div>
      <div class="panel">
        <div class="eyebrow">ROOM SCHEDULE</div>
        <h2>05-Lumi-Revit-空间表.csv</h2>
        <div class="path">${htmlEscape(revitCsvPath)}</div>
        <table>
          <thead><tr><th>房间</th><th>X</th><th>Y</th><th>宽</th><th>高</th><th>材料</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  return buildHandoffPageShell('Lumi Revit 交接包已准备', 'REVIT / DYNAMO HANDOFF', body);
}

function findChromiumExecutable(): string {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

function pdfEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function writeAsciiFallbackPdf(outPath: string): void {
  const lines = [
    'Lumi Renovation Design Delivery PDF',
    '',
    'This fallback PDF is generated when Chrome PDF export is unavailable.',
    'Artifacts included in the same folder:',
    '- Proposal RTF',
    '- Budget and material list RTF',
    '- PPTX presentation',
    '- CAD DXF and SVG preview',
    '- Revit/Dynamo handoff script and room schedule',
    '- WeChat delivery draft',
  ];
  const stream = [
    'BT',
    '/F1 20 Tf',
    '72 740 Td',
    `(${pdfEscape(lines[0])}) Tj`,
    '/F1 12 Tf',
    ...lines.slice(1).map(line => `0 -22 Td (${pdfEscape(line)}) Tj`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, index) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  fs.writeFileSync(outPath, pdf, 'binary');
}

function createPdfFromHtml(htmlPath: string, pdfPath: string): string {
  const chrome = findChromiumExecutable();
  if (chrome) {
    try {
      execFileSync(chrome, [
        '--headless=new',
        '--disable-gpu',
        '--no-pdf-header-footer',
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(htmlPath).href,
      ], { timeout: 35000, stdio: 'ignore' });
      if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 1000) return pdfPath;
    } catch {}
  }
  writeAsciiFallbackPdf(pdfPath);
  return pdfPath;
}

function readTextForVerification(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function verifyFileExists(filePath: string, minBytes: number): { passed: boolean; detail: string } {
  if (!fs.existsSync(filePath)) return { passed: false, detail: '文件不存在' };
  const size = fs.statSync(filePath).size;
  return {
    passed: size >= minBytes,
    detail: size >= minBytes ? `已生成，${size} bytes` : `文件过小，${size} bytes`,
  };
}

function verifyDesignDeliveryFiles(files: DesignDeliveryFilePaths, project: DesignProjectBrief): DesignDeliveryVerification {
  const checks: DesignDeliveryVerification['checks'] = [];
  const addFileCheck = (label: string, filePath: string, minBytes: number) => {
    const result = verifyFileExists(filePath, minBytes);
    checks.push({ label, passed: result.passed, detail: result.detail });
  };
  const addTextCheck = (label: string, filePath: string, includes: string[]) => {
    const text = readTextForVerification(filePath);
    const missing = includes.filter(item => item && !text.includes(item));
    checks.push({
      label,
      passed: text.length > 0 && missing.length === 0,
      detail: missing.length ? `缺少关键内容：${missing.join('、')}` : '关键内容已写入',
    });
  };

  addFileCheck('方案 RTF', files.proposal, 600);
  addFileCheck('预算 RTF', files.budget, 600);
  addFileCheck('PPTX 汇报文件', files.presentation, 1200);
  addFileCheck('PDF 交付文件', files.pdf, 800);
  addFileCheck('CAD DXF 初稿', files.cadDxf, 800);
  addFileCheck('CAD 预览 SVG', files.cadPreview, 800);
  addFileCheck('Revit Dynamo 脚本', files.dynamoScript, 300);
  addFileCheck('Revit 空间表', files.revitCsv, 100);
  addFileCheck('微信交付草稿', files.wechatDraft, 120);
  addTextCheck('PDF/HTML 项目内容', files.reportHtml, [project.projectTitle, project.style, project.budgetLabel]);
  addTextCheck('CAD 项目标题', files.cadDxf, [project.projectTitle]);
  addTextCheck('Dynamo 项目标题', files.dynamoScript, [project.projectTitle, project.style]);
  addTextCheck('空间表房间数据', files.revitCsv, project.roomLabels.slice(0, 2));
  addTextCheck('微信草稿项目内容', files.wechatDraft, [String(project.areaSqm), project.layout, project.style, project.budgetLabel]);

  return {
    passed: checks.every(check => check.passed),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

function buildVerificationText(result: DesignDeliveryVerification, project: DesignProjectBrief): string {
  return [
    'Lumi 交付验证记录',
    '',
    `项目：${project.projectTitle}`,
    `检查时间：${result.checkedAt}`,
    `整体结果：${result.passed ? '通过' : '需要复核'}`,
    '',
    ...result.checks.map((check, index) => `${index + 1}. ${check.passed ? '通过' : '未通过'}｜${check.label}｜${check.detail}`),
    '',
    '仍需人工确认：',
    ...project.confirmItems.map((item, index) => `${index + 1}. ${item}`),
  ].join('\n');
}

export function createDesignDeliveryFiles(
  input?: string | DesignProjectBrief,
  options: { outputDirectory?: string; folderName?: string } = {},
): DesignDeliveryFiles {
  const project = typeof input === 'string'
    ? parseDesignProjectBrief(input)
    : input || DEFAULT_DESIGN_PROJECT_BRIEF;
  const desktopDir = path.join(os.homedir(), 'Desktop');
  const baseDir = options.outputDirectory
    ? path.resolve(options.outputDirectory.replace(/^~(?=$|[\\/])/, os.homedir()))
    : fs.existsSync(desktopDir) ? desktopDir : os.tmpdir();
  const folder = path.join(baseDir, options.folderName || 'Lumi-装修设计交付包');
  fs.mkdirSync(folder, { recursive: true });

  const proposal = writeRtf(path.join(folder, '01-Lumi-装修设计方案.rtf'), buildDesignProposalText(project));
  const budget = writeRtf(path.join(folder, '02-Lumi-预算与材料清单.rtf'), buildMaterialBudgetText(project));
  const presentation = path.join(folder, '03-Lumi-装修设计方案汇报.pptx');
  const pdf = path.join(folder, '03-Lumi-装修设计方案汇报.pdf');
  const reportHtml = path.join(folder, '03-Lumi-装修设计方案汇报.html');
  const cadDxf = path.join(folder, '04-Lumi-CAD-平面布置.dxf');
  const cadPreview = path.join(folder, '04-Lumi-CAD-平面预览.svg');
  const cadHandoffHtml = path.join(folder, '04-Lumi-CAD-交付检查.html');
  const dynamoScript = path.join(folder, '05-Lumi-Revit-Dynamo建模脚本.py');
  const revitCsv = path.join(folder, '05-Lumi-Revit-空间表.csv');
  const revitHandoffHtml = path.join(folder, '05-Lumi-Revit-交接检查.html');
  const wechatDraft = path.join(folder, '06-Lumi-微信交付话术.txt');
  const verification = path.join(folder, '07-Lumi-交付验证记录.txt');
  const revitRoomScheduleCsv = buildRoomScheduleCsv(project);

  fs.writeFileSync(cadDxf, buildRenovationDxf(project), 'utf8');
  fs.writeFileSync(cadPreview, buildCadPreviewSvg(project), 'utf8');
  fs.writeFileSync(cadHandoffHtml, buildCadHandoffHtml(cadPreview, cadDxf, project), 'utf8');
  createDesignPresentationPptx(presentation, project);
  fs.writeFileSync(reportHtml, buildReportHtml(cadPreview, project), 'utf8');
  createPdfFromHtml(reportHtml, pdf);
  fs.writeFileSync(dynamoScript, buildDynamoScriptText(project), 'utf8');
  fs.writeFileSync(revitCsv, revitRoomScheduleCsv, 'utf8');
  fs.writeFileSync(revitHandoffHtml, buildRevitHandoffHtml(dynamoScript, revitCsv, revitRoomScheduleCsv, project), 'utf8');
  fs.writeFileSync(wechatDraft, buildWechatDeliveryDraft(project), 'utf8');

  const filePaths: DesignDeliveryFilePaths = {
    folder,
    proposal,
    budget,
    presentation,
    pdf,
    reportHtml,
    cadDxf,
    cadPreview,
    cadHandoffHtml,
    dynamoScript,
    revitCsv,
    revitHandoffHtml,
    wechatDraft,
  };
  const verificationResult = verifyDesignDeliveryFiles(filePaths, project);
  fs.writeFileSync(verification, buildVerificationText(verificationResult, project), 'utf8');

  return { project, ...filePaths, verification, verificationResult };
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

  const project = parseDesignProjectBrief(userText);
  const files = createDesignDeliveryFiles(project);
  const wechatDraftText = buildWechatDeliveryDraft(project);
  const verificationText = files.verificationResult.passed ? '交付自检已经通过' : '交付自检里还有需要复核的项目';
  const officePatterns = [/wps/i, /winword/i, /word/i, /writer/i, /notepad/i, /记事本/i];
  const presentationPatterns = [/wps/i, /powerpnt/i, /powerpoint/i, /wpp/i, /演示/i, /presentation/i, /office/i];
  const browserPatterns = [/chrome/i, /edge/i, /firefox/i, /browser/i, /msedge/i, /iexplore/i];
  const pdfPatterns = [/chrome/i, /edge/i, /firefox/i, /browser/i, /msedge/i, /acrobat/i, /pdf/i, /wps/i];
  const cadPatterns = [/freecad/i, /librecad/i, /autocad/i, /acad/i, /zwcad/i, /gstarcad/i, /cad/i, /中望/i, /浩辰/i, /天正/i];
  const revitPatterns = [/revit/i, /dynamo/i, /autodesk/i, /freecad/i, /notepad/i, /wps/i, /excel/i, /et/i, /记事本/i];
  const wechatPatterns = [/wechat/i, /weixin/i, /微信/i, /wxwork/i];

  try {
    await runStep({
      text: `${greeting}我会把这条装修需求接管成正式设计交付任务：${project.areaSqm} 平 ${project.layout}，${project.style}，${project.budgetLabel}，重点处理 ${project.clientFocus.join('、')}。我会生成方案、预算、PPT 和 PDF 汇报版、CAD 初稿、Revit 交接包，最后准备微信交付话术。`,
      actions: [
        { tool: 'desktop_show_lumi_window', afterMs: 250 },
        { clientAction: { action: 'design_delivery_panel', stage: 'intake' } },
      ],
      pauseMs: 7600,
    });

    await enterWallpaperMode();

    await runStep({
      text: '第一步，我先生成正式设计方案。你看到的不是聊天摘要，而是已经放到桌面交付包里的真实文件。',
      actions: [
        { clientAction: { action: 'design_delivery_panel', stage: 'concept' } },
        { tool: 'desktop_open', args: { target: files.proposal }, afterMs: 4600 },
      ],
      timing: 'after',
      pauseMs: 6900,
    });
    await waitForActiveWindow(officePatterns, 5200);
    await pointActiveWindowRatio(officePatterns, 0.5, 0.44, false, { xRatio: 0.5, yRatio: 0.45 });
    await say(`方案里已经包含 ${project.layout} 的户型判断、空间策略、交付节奏和必须确认的风险点。普通沟通由我推进，承重结构、燃气、水电和最终签字我会上报给你。`, 7200);
    await closeActiveWindow(officePatterns);

    await runTool('desktop_open', { target: files.budget }, true);
    await wait(3600);
    await waitForActiveWindow(officePatterns, 4200);
    await pointActiveWindowRatio(officePatterns, 0.48, 0.48, false, { xRatio: 0.5, yRatio: 0.48 });
    await say(`同时我把预算和材料清单也生成出来，按 ${project.budgetLabel} 拆出施工项、主材、定制和风险预留，客户可以直接拿这个版本讨论是否进入深化。`, 7200);
    await closeActiveWindow(officePatterns);

    await runStep({
      text: '接着我生成客户可直接查看的 PDF 汇报版。这个版本适合发微信、发邮件、让客户确认方向。',
      actions: [
        { clientAction: { action: 'design_delivery_panel', stage: 'concept' } },
        { tool: 'desktop_open', args: { target: files.pdf }, afterMs: 4200 },
      ],
      timing: 'after',
      pauseMs: 6400,
    });
    await waitForActiveWindow(pdfPatterns, 5200);
    await pointActiveWindowRatio(pdfPatterns, 0.52, 0.5, false, { xRatio: 0.52, yRatio: 0.5 });
    await say('同一份内容我也做了 PPTX 汇报版：PDF 用来交付确认，PPT 用来现场讲解和继续修改。', 6000);
    await closeActiveWindow(pdfPatterns);

    await runTool('desktop_open', { target: files.presentation }, true);
    await wait(4200);
    await waitForActiveWindow(presentationPatterns, 4200);
    await pointActiveWindowRatio(presentationPatterns, 0.5, 0.46, false, { xRatio: 0.5, yRatio: 0.46 });
    await say('这里是 PPT 汇报文件。如果这台电脑装了 PowerPoint 或 WPS 演示，就会直接打开；没有关联软件时，文件也已经在交付包里，后续可以交给外部工具继续编辑。', 7200);
    await closeActiveWindow(presentationPatterns);

    const cadShortcut = await findDesktopShortcut([/freecad/i, /librecad/i, /autocad/i, /acad/i, /zwcad/i, /gstarcad/i, /中望/i, /浩辰/i, /天正/i, /(?:^|\\s)cad/i]);
    await runStep({
      text: '第二步，我打开电脑上的 CAD 软件，把生成好的 DXF 初稿交给外部软件继续深化。',
      actions: [
        { clientAction: { action: 'design_delivery_panel', stage: 'cad' } },
        { tool: 'desktop_run_command', args: { command: buildOpenFileWithAppCommand(cadShortcut, files.cadDxf) }, afterMs: 5600 },
      ],
      timing: 'after',
      pauseMs: 7200,
    });
    await waitForActiveWindow(cadPatterns, 8000);
    await pointActiveWindowRatio(cadPatterns, 0.54, 0.48, false, { xRatio: 0.54, yRatio: 0.48 });
    await say('CAD 初稿已经生成并交给外部 CAD 软件。这里的重点不是展示一张网页图，而是让图纸进入真实工具链，后面可以继续标注、调整图层、深化施工图。', 8200);
    await closeActiveWindow(cadPatterns);

    const revitShortcut = await findDesktopShortcut([/revit/i, /dynamo/i, /autodesk/i, /bim/i]);
    await runStep({
      text: '第三步，我准备 Revit 交接。这里不是打开浏览器，而是把 Dynamo 脚本和空间表交给外部建模工具。',
      actions: [
        { clientAction: { action: 'design_delivery_panel', stage: 'revit' } },
        { tool: 'desktop_run_command', args: { command: buildOpenRevitHandoffCommand(revitShortcut, files.dynamoScript, files.revitCsv) }, afterMs: 5200 },
      ],
      timing: 'after',
      pauseMs: 7600,
    });
    await waitForActiveWindow(revitPatterns, 7000);
    await pointActiveWindowRatio(revitPatterns, 0.52, 0.42, false, { xRatio: 0.52, yRatio: 0.42 });
    await say('Revit 交接数据已经准备好：Dynamo 脚本负责建模入口，空间表负责把房间、尺寸和材料策略交给 BIM 侧继续处理。', 7600);
    await closeActiveWindow(revitPatterns);

    await runTool('desktop_open', { target: files.folder }, true);
    await wait(2600);
    await pointActiveWindowRatio([/explorer/i, /文件资源管理器/i], 0.5, 0.46, false, { xRatio: 0.5, yRatio: 0.48 });
    await say(`现在交付包已经成型：方案、预算、PPT、PDF、CAD 初稿、Revit 交接数据、微信话术和交付验证记录都在这里。${verificationText}。`, 7600);
    await closeActiveWindow([/explorer/i, /文件资源管理器/i]);

    const shouldSendToWeChat = process.env.LUMI_DESIGN_DELIVERY_SEND_WECHAT === '1';
    await runStep({
      text: shouldSendToWeChat
        ? '最后我回到电脑微信，把交付话术发给客户。'
        : '最后我回到电脑微信，准备交付话术。默认不自动发送，真正发出前仍然等你确认。',
      actions: [
        { clientAction: { action: 'design_delivery_panel', stage: 'handoff' } },
        { tool: 'desktop_clipboard_write', args: { text: wechatDraftText }, afterMs: 500 },
      ],
      timing: 'after',
      pauseMs: shouldSendToWeChat ? 4300 : 6200,
    });

    const personalWechatShortcut = await findDesktopShortcut([/^(?!.*企业).*微信/i, /^wechat/i, /^weixin/i]);
    const enterpriseWechatShortcut = await findDesktopShortcut([/企业微信/i, /wxwork/i]);
    await runTool('desktop_run_command', { command: buildOpenWeChatCommand(personalWechatShortcut, enterpriseWechatShortcut) }, true);
    await wait(2600);

    let active = await waitForActiveWindow(wechatPatterns, 4800);
    if (!active) {
      await runTool('desktop_run_command', { command: buildOpenWeChatCommand(personalWechatShortcut, enterpriseWechatShortcut) }, true);
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
      await say(`好了，这一单我已经整理好了。方案、预算、PPT 汇报版、PDF 交付版、CAD 初稿、Revit 交接数据、微信交付草稿和自检记录都在交付包里，${verificationText}。接下来我会按你的授权边界，继续把客户推进到确认方案和深化交付。`, 9400);
      await wait(1200);
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
        arguments: { request: userText, voiceScope, project, folder: files.folder, verification: files.verificationResult },
        result: JSON.stringify(files, null, 2),
      },
      ...toolCalls,
    ],
  };
}

export const runDesignDeliveryDemo = runDesignDeliveryWorkflow;
