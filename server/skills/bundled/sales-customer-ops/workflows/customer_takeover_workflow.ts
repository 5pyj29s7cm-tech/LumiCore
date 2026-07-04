import { Socket } from "socket.io";
import fs from "fs";
import os from "os";
import path from "path";
import { readDB } from "../../../../../db_layer";
import { ToolExecutionRecord } from "../../../../tools/types";

type VoiceScope = {
  domain: 'personal' | 'work';
  orgId: string;
};

type DesktopRelay = (toolName: string, args: Record<string, any>) => Promise<string>;
type Speak = (text: string) => void | number | Promise<void | number>;

interface CustomerTakeoverWorkflowOptions {
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

type CustomerTakeoverBrief = {
  sourceText: string;
  customerName: string;
  contextLabel: string;
  stage: string;
  need: string;
  recommendedPlan: string;
  quoteAmount: string;
  baseQuote: string;
  premiumQuote: string;
  deliveryPeriod: string;
  paymentTerms: string;
  riskFocus: string;
  userRules: string[];
};

const CUSTOMER_TAKEOVER_PATTERNS = [
  /按我的规则推进这个客户/,
  /接管(?:一下|下)?这个客户/,
  /帮我(?:推进|接管|谈)(?:一下|下)?(?:这个)?客户/,
  /(?:客户|线索).{0,8}(?:接管|推进|谈判|成交)/,
  /(?:微信| WeChat|wechat).{0,12}(?:客户|线索).{0,12}(?:推进|接管|成交)/i,
  /take\s*over\s*(this\s*)?customer/i,
  /handle\s*(this\s*)?lead/i,
  /close\s*(this\s*)?customer/i,
];

function normalizeIntentText(text: string): string {
  return text.replace(/\s+/g, '');
}

function compactText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function firstMatch(text: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = compactText(match?.[1] || match?.[0] || '');
    if (value) return value;
  }
  return '';
}

function parseAmountToYuan(label: string): number | null {
  const raw = compactText(label).replace(/[,，]/g, '');
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(万|w|W|千|k|K|元|块)?/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2] || '元';
  if (/万|w/i.test(unit)) return Math.round(value * 10000);
  if (/千|k/i.test(unit)) return Math.round(value * 1000);
  return Math.round(value);
}

function formatRmb(value: number | null): string {
  if (!value || !Number.isFinite(value)) return '待确认';
  return `￥${Math.round(value).toLocaleString('zh-CN')}`;
}

function buildCustomerTakeoverBrief(userText: string): CustomerTakeoverBrief {
  const sourceText = compactText(userText);
  const customerName = firstMatch(sourceText, [
    /(?:客户|联系人|对接人|负责人|老板|经理)[:：]?\s*([\u4e00-\u9fa5A-Za-z0-9_-]{1,12})/,
    /([\u4e00-\u9fa5]{1,4}(?:总|经理|老板|老师))/,
  ]) || '当前客户';
  const contextLabel = firstMatch(sourceText, [
    /(?:区域|地区|城市|门店|项目|公司)[:：]?\s*([^，。；;,.]{2,18})/,
    /(华东|华南|华北|华中|西南|西北|东北|北京|上海|深圳|广州|杭州|成都|重庆|南京|武汉|西安)/,
  ]) || '当前线索';
  const amountLabel = firstMatch(sourceText, [
    /(?:报价|预算|金额|价格|费用|合同|投入|准备|大概|控制)[^\d]{0,10}((?:￥|¥)?\d+(?:[,.，]\d+)*(?:\.\d+)?\s*(?:万|w|W|千|k|K|元|块)?)/,
    /((?:￥|¥)?\d+(?:[,.，]\d+)*(?:\.\d+)?\s*(?:万|w|W|千|k|K|元|块))/,
  ]);
  const amountYuan = parseAmountToYuan(amountLabel);
  const quoteAmount = amountLabel ? (/[￥¥]/.test(amountLabel) ? amountLabel : formatRmb(amountYuan)) : '待确认';
  const deliveryPeriod = firstMatch(sourceText, [
    /(\d+\s*(?:个)?工作日)/,
    /(\d+\s*(?:天|周|个月))/,
    /(今天|明天|本周|周内|月底|尽快|马上|加急)/,
  ]) || '待确认';
  const need = firstMatch(sourceText, [
    /(?:想要|希望|需要|要|目标|诉求)[:：]?\s*([^。；;\n]{4,60})/,
    /(?:客户|线索).{0,8}(?:要|问|想|希望)\s*([^。；;\n]{4,60})/,
  ]) || (sourceText ? sourceText.slice(0, 80) : '推进客户需求、报价口径、合同风险和下一步成交动作。');
  const recommendedPlan = /加急|马上|今天|今晚|尽快/.test(sourceText)
    ? '加急推进版'
    : /基础|先试|低配|最小/.test(sourceText)
      ? '基础启动版'
      : '标准推进版';
  const baseQuote = amountYuan ? formatRmb(Math.round(amountYuan * 0.72)) : '待核价';
  const premiumQuote = amountYuan ? formatRmb(Math.round(amountYuan * 1.35)) : '待核价';
  const userRules = [
    /不主动降价|不要主动降价/.test(sourceText) ? '先呈现方案价值，不主动降价。' : '',
    /底价|价格底线/.test(sourceText) ? '触及价格底线前必须上报用户确认。' : '',
    /合同|风险/.test(sourceText) ? '合同、交付周期和责任边界必须写清楚。' : '',
    /售后|复盘/.test(sourceText) ? '售后响应和复盘节奏需要明确写入。' : '',
  ].filter(Boolean);
  return {
    sourceText,
    customerName,
    contextLabel,
    stage: amountLabel ? '已出现价格/预算信号，需要形成正式报价口径。' : '客户需求已进入推进阶段，价格和边界仍需确认。',
    need,
    recommendedPlan,
    quoteAmount,
    baseQuote,
    premiumQuote,
    deliveryPeriod,
    paymentTerms: '40% 启动款 / 40% 阶段验收 / 20% 最终验收，可按用户规则调整',
    riskFocus: deliveryPeriod === '待确认' ? '交付周期、最终价格和责任边界需要确认' : '交付周期、变更范围和责任边界需要写入确认口径',
    userRules: userRules.length ? userRules : [
      '先推进可确认的方案和报价口径，不替用户做最终承诺。',
      '价格底线、合同风险、交付周期和发送动作必须等待确认。',
      '客户追问细节时，优先补充价值、范围、交付节点和风险控制。',
    ],
  };
}

function buildQuoteText(brief: CustomerTakeoverBrief): string {
  return [
    '客户推进报价方案',
    '',
    `客户：${brief.customerName} / ${brief.contextLabel}`,
    `阶段：${brief.stage}`,
    `核心诉求：${brief.need}`,
    brief.sourceText ? `原始消息：${brief.sourceText.slice(0, 260)}` : '',
    '',
    `推荐方案：${brief.recommendedPlan}`,
    `报价金额：${brief.quoteAmount}`,
    `交付周期：${brief.deliveryPeriod}`,
    '服务内容：需求确认、方案深化、实施排期、交付验收、复盘和风险控制。',
    '',
    '三档报价：',
    `1. 基础启动版：${brief.baseQuote}，适合快速启动，交付范围较克制。`,
    `2. ${brief.recommendedPlan}：${brief.quoteAmount}，覆盖当前客户最关心的范围、周期和推进动作。`,
    `3. 加急/增强版：${brief.premiumQuote}，用于压缩周期或增加专项交付人力。`,
    '',
    '谈判规则：',
    ...brief.userRules,
  ].filter(Boolean).join('\n');
}

function buildContractText(brief: CustomerTakeoverBrief): string {
  return [
    '项目合同草案要点',
    '',
    `项目名称：${brief.customerName} ${brief.recommendedPlan}交付`,
    `合同金额：${brief.quoteAmount}`,
    `付款节点：${brief.paymentTerms}`,
    `交付周期：${brief.deliveryPeriod}`,
    '',
    '关键条款：',
    '1. 需求确认后开始计算交付周期。',
    '2. 客户新增需求需形成书面变更单。',
    `3. ${brief.riskFocus}。`,
    '4. 售后、验收和复盘节奏需要写入附件。',
    '',
    '下一步：用户确认价格、边界和发送口径后，Lumi 再生成正式合同版本或发送给客户。',
  ].join('\n');
}

function buildWechatReplyDraft(brief: CustomerTakeoverBrief): string {
  const prefix = brief.customerName === '当前客户' ? '您好' : `${brief.customerName}`;
  return [
    `${prefix}，我这边先把需求整理成一版正式推进口径。`,
    '',
    `我建议先看「${brief.recommendedPlan}」：`,
    `金额：${brief.quoteAmount}`,
    `周期：${brief.deliveryPeriod}`,
    '包含：需求确认、方案深化、实施排期、交付验收、复盘和风险控制。',
    '',
    '如果这个方向认可，我可以同步把合同草案和项目启动清单发你确认。',
    `其中${brief.riskFocus}，我会写进确认文件里，避免后面执行时口径不一致。`,
  ].join('\n');
}

function buildPanelBrief(brief: CustomerTakeoverBrief): Record<string, string> {
  return {
    customer: `${brief.customerName} / ${brief.contextLabel}`,
    quote: `${brief.quoteAmount} ${brief.recommendedPlan}`,
    amount: brief.quoteAmount,
    period: brief.deliveryPeriod,
    risk: brief.riskFocus,
    status: brief.quoteAmount === '待确认' ? '等待确认报价边界' : `已形成${brief.recommendedPlan}口径`,
  };
}

export function isCustomerTakeoverRequest(text: string): boolean {
  const normalized = normalizeIntentText(text || '');
  if (!normalized) return false;
  return CUSTOMER_TAKEOVER_PATTERNS.some(pattern => pattern.test(normalized));
}

export const isCustomerTakeoverDemoRequest = isCustomerTakeoverRequest;

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
  return Math.min(7000, Math.max(2300, text.length * 112));
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

function buildDemoRtf(text: string): string {
  const [title, ...bodyLines] = text.split(/\r?\n/);
  const body = bodyLines.join('\n').trim();
  return [
    '{\\rtf1\\ansi\\deff0\\uc1',
    '{\\fonttbl{\\f0\\fnil Microsoft YaHei;}}',
    '\\paperw11906\\paperh16838\\margl1440\\margr1440\\margt1200\\margb1200',
    `\\pard\\f0\\fs36\\b ${rtfUnicodeEscape(title || '客户推进材料')}\\b0\\par`,
    '\\pard\\f0\\fs24\\sl320\\slmult1',
    rtfUnicodeEscape(body),
    '}',
  ].join('\n');
}

function createDemoFile(fileName: string, text: string): string {
  const desktopDir = path.join(os.homedir(), 'Desktop');
  const fallbackDir = path.join(os.tmpdir(), 'LumiOS-Demo');
  const dir = fs.existsSync(desktopDir) ? desktopDir : fallbackDir;
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buildDemoRtf(text), 'utf8');
  return filePath;
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

export async function runCustomerTakeoverWorkflow({
  socket,
  userText,
  userId,
  desktopRelay,
  speak,
  voiceScope,
  isCancelled,
}: CustomerTakeoverWorkflowOptions): Promise<{ responseText: string; toolCalls: ToolExecutionRecord[] }> {
  void voiceScope;
  const brief = buildCustomerTakeoverBrief(userText);
  const quoteText = buildQuoteText(brief);
  const contractText = buildContractText(brief);
  const wechatReplyDraft = buildWechatReplyDraft(brief);
  const panelBrief = buildPanelBrief(brief);
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
      source: 'customer_takeover_workflow',
    });
  };

  const runTool = async (name: string, args: Record<string, any> = {}, optional = true) => {
    const id = `customer-takeover-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    emitTool(id, name, args);
    try {
      const output = await desktopRelay(name, args);
      const fullOutput = String(output || '');
      const result = fullOutput.slice(0, 600);
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

  const runClientAction = (args: Record<string, any>) => {
    const enriched = args?.action === 'customer_takeover_panel'
      ? { ...args, brief: panelBrief }
      : args;
    return runTool('client_action', enriched, true);
  };

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
    const leadMs = Math.min(step.actionLeadMs ?? 850, Math.max(250, totalMs - 500));
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
    await runTool('desktop_cursor_glow_show', { timeoutMs: 120000 }, true);
    await runTool('desktop_set_wallpaper_mode', {
      enabled: true,
      source: 'customer_takeover_workflow',
      timeoutMs: 120000,
    }, true);
    wallpaperModeActive = true;
    await wait(350);
  };

  const exitWallpaperMode = async () => {
    if (wallpaperModeActive) {
      await runTool('desktop_set_wallpaper_mode', {
        enabled: false,
        source: 'customer_takeover_workflow',
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

  const runQuoteDemo = async () => {
    await runStep({
      text: `第一步，我把这条线索变成正式客户推进任务：客户是${brief.customerName}，核心诉求是${brief.need}。`,
      actions: [
        { clientAction: { action: 'customer_takeover_panel', stage: 'intake' } },
        { tool: 'desktop_capture_screen', args: { quality: 45 }, afterMs: 220 },
      ],
      pauseMs: 5800,
    });

    await enterWallpaperMode();

    const quoteFile = createDemoFile('Lumi-客户推进-报价方案.rtf', quoteText);
    const contractFile = createDemoFile('Lumi-客户推进-合同草案.rtf', contractText);
    const officePatterns = [/wps/i, /winword/i, /word/i, /writer/i, /notepad/i, /记事本/i];
    const wpsShortcut = await findDesktopShortcut([/wps/i, /金山/i, /文字/i, /writer/i]);

    await runTool('desktop_run_command', { command: buildOpenWpsWriterCommand(wpsShortcut, quoteFile) }, true);
    await wait(5200);
    let active = await waitForActiveWindow(officePatterns, 5200);
    if (!active) {
      await runTool('desktop_run_command', { command: buildOpenWpsWriterCommand('', quoteFile) }, true);
      await wait(3200);
      active = await waitForActiveWindow(officePatterns, 3600);
    }

    if (active) {
      await runTool('desktop_run_command', { command: buildAppActivateCommand('WPS') }, true);
      await wait(300);
      await runTool('desktop_clipboard_write', { text: quoteText }, true);
      await pointActiveWindowRatio(officePatterns, 0.48, 0.52, true, { xRatio: 0.5, yRatio: 0.46 });
      await wait(260);
      await runTool('desktop_keyboard_press', { key: 'ctrl+a' }, true);
      await wait(160);
      await runTool('desktop_keyboard_press', { key: 'ctrl+v' }, true);
      await wait(900);
    }

    await say(`第二步，我不是只写一句回复。我已经为${brief.customerName}生成了报价方案、合同草案和项目启动要点，报价口径是${brief.quoteAmount}。`, 5600);

    await runTool('desktop_run_command', { command: buildOpenWpsWriterCommand(wpsShortcut, contractFile) }, true);
    await wait(2600);
  };

  const runResearchDemo = async () => {
    const query = encodeURIComponent(`${brief.customerName} ${brief.need} 报价 交付周期 风险控制`);
    await runStep({
      text: '同时，我会补充客户行业信息和风险点。这一阶段，我会连接浏览器、企业信息、历史文件和你的报价规则。',
      actions: [
        {
          tool: 'desktop_open',
          args: { target: `https://www.baidu.com/s?wd=${query}` },
          afterMs: 2600,
        },
        { tool: 'desktop_active_window' },
      ],
      timing: 'after',
      pauseMs: 6200,
    });
    const browserPatterns = [/chrome/i, /edge/i, /firefox/i, /browser/i, /msedge/i, /iexplore/i];
    await waitForActiveWindow(browserPatterns, 2600);
    await pointActiveWindowRatio(browserPatterns, 0.5, 0.18, false, { xRatio: 0.5, yRatio: 0.16 });
  };

  const runWeChatDraftDemo = async () => {
    const shouldSendToWeChat = process.env.LUMI_CUSTOMER_DEMO_SEND_WECHAT === '1';
    await runStep({
      text: shouldSendToWeChat
        ? '第三步，我回到电脑微信，按你的风格继续跟进客户。'
        : '第三步，我回到电脑微信，准备客户回复草稿。默认不自动发送，真正发给客户前会等你确认。',
      actions: [
        { clientAction: { action: 'customer_takeover_panel', stage: 'wechat' } },
        { tool: 'desktop_cursor_glow_show', args: { timeoutMs: 120000 }, afterMs: 160 },
      ],
      timing: 'after',
      pauseMs: shouldSendToWeChat ? 4200 : 6200,
    });

    const wechatPatterns = [/wechat/i, /weixin/i, /微信/i, /wxwork/i];
    const wechatShortcut = await findDesktopShortcut([/微信/i, /wechat/i, /weixin/i]);
    if (wechatShortcut) {
      await runTool('desktop_open', { target: wechatShortcut }, true);
      await wait(4200);
    }
    await runTool('desktop_run_command', { command: buildOpenWeChatCommand(wechatShortcut) }, true);
    await wait(2800);

    let active = await waitForActiveWindow(wechatPatterns, 4800);
    if (!active) {
      await runTool('desktop_open', { target: 'WeChat' }, true);
      await wait(3200);
      active = await waitForActiveWindow(wechatPatterns, 3600);
    }

    await runTool('desktop_clipboard_write', { text: wechatReplyDraft }, true);
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
      await say('这台机器上暂时没有聚焦到电脑微信，所以我先把客户回复草稿复制到剪贴板，等待你确认粘贴。', 5000);
    }
  };

  socket.emit('agent:status', {
    status: 'thinking',
    agentName: 'Lumi',
    phase: 'customer_takeover_workflow',
    detail: 'Running customer takeover workflow',
  });

  try {
    await runStep({
      text: `${greeting}我会按你的规则推进${brief.customerName}。常规沟通、报价材料和跟进动作由我处理；涉及价格底线、合同风险和最终责任判断时，我再叫你。`,
      actions: [
        { tool: 'desktop_show_lumi_window', afterMs: 250 },
        { clientAction: { action: 'customer_takeover_panel', stage: 'intake' } },
      ],
      pauseMs: 7600,
    });

    await runStep({
      text: `这条消息不是普通提醒，而是一条客户机会。我会围绕${brief.need}，拆成需求、报价、合同、回款和项目启动五个动作。`,
      actions: [{ clientAction: { action: 'customer_takeover_panel', stage: 'rules' } }],
      pauseMs: 6100,
    });

    if (!isCancelled?.()) await runQuoteDemo();
    if (!isCancelled?.()) await runResearchDemo();
    if (!isCancelled?.()) await runWeChatDraftDemo();

    if (!isCancelled?.()) {
      await exitWallpaperMode();
      await runTool('desktop_show_lumi_window', {}, true);
      await wait(500);
      await runClientAction({ action: 'customer_takeover_panel', stage: 'result' });
      await say(`客户推进结果已经形成：${brief.recommendedPlan}、${brief.quoteAmount}报价口径、合同草案和项目启动清单都已经准备好。下一步，是客户确认后进入启动流程。`, 7600);
      await say('这就是 Lumi 这一阶段要达到的能力：不是反复提醒你，而是在授权边界内接管工作，把微信里的机会推进成结果。', 6800);
    }
  } finally {
    await exitWallpaperMode();
  }

  return {
    responseText: spokenLines.join('\n'),
    toolCalls,
  };
}

export const runCustomerTakeoverDemo = runCustomerTakeoverWorkflow;
