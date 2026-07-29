import { Socket } from "socket.io";
import fs from "fs";
import os from "os";
import path from "path";
import { readDB } from "../../../../../db_layer";
import { ToolExecutionRecord } from "../../../../tools/types";
import { buildSelfIntroductionPlan, getSelfModelSnapshot } from '../../../../client/self_model';
import { DESKTOP_APPLICATION_REGISTRY } from '../../../../desktop/execution_plan';

type VoiceScope = {
  domain: 'personal' | 'work';
  orgId: string;
};

type DesktopRelay = (toolName: string, args: Record<string, any>) => Promise<string>;
type Speak = (text: string) => void | number | Promise<void | number>;

interface SelfIntroDemoOptions {
  socket: Socket;
  userText: string;
  userId: string;
  desktopRelay: DesktopRelay;
  speak: Speak;
  voiceScope: VoiceScope;
  isCancelled?: () => boolean;
}

interface DemoAction {
  tool?: string;
  clientAction?: Record<string, any>;
  args?: Record<string, any>;
  optional?: boolean;
  delayMs?: number;
  afterMs?: number;
}

interface DemoStep {
  text: string;
  actions?: DemoAction[];
  postActions?: DemoAction[];
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

const SELF_INTRO_PATTERNS = [
  /自我介绍/,
  /介绍(?:一下|下)?(?:你自己|自己|lumi|Lumi)/,
  /介绍(?:一下|下)?你(?:的能力|能做什么|会做什么)/,
  /(?:你|lumi|Lumi).{0,8}介绍.{0,8}(?:自己|一下)/,
  /(?:你|lumi|Lumi).{0,12}(?:能做什么|会做什么|有哪些能力|能力演示)/,
  /(?:展示|演示)(?:一下)?(?:你自己|自己|lumi|Lumi)/,
  /(?:展示|演示)(?:一下|下)?(?:你|lumi|Lumi).{0,12}(?:能力|桌面|操作|自己)/,
  /(?:让|叫|请)(?:你|lumi|Lumi).{0,8}(?:自我介绍|介绍自己|演示自己)/,
  /(?:给|向)(?:新用户|用户|大家).{0,12}(?:介绍|演示)(?:一下|下)?(?:你|lumi|Lumi|自己)/,
  /(?:开始|播放|启动).{0,8}(?:自我介绍|能力演示|介绍视频)/,
  /(?:你|lumi|Lumi).{0,8}是谁/,
  /introduce\s*(yourself|lumi)/i,
  /show\s*(yourself|lumi)/i,
  /demo\s*(yourself|lumi)/i,
];

export const OFFICE_DEMO_TEXT = [
  'Lumi 自我介绍',
  '',
  '定位：Lumi 是一个私有化部署在本机的个人 AI 助理和伙伴。',
  '能力：我可以理解你的目标，记住长期背景，整理资料，撰写文档，打开应用，并控制桌面完成真实操作。',
  '工作方式：我会先看见屏幕，再拆解任务，然后把每一步动作落到真实软件里。',
  '价值：我不是只回答一句话，而是把“我会回答”推进成“我能执行”。',
  '协作关系：用户负责方向和判断，Lumi 负责执行、记录、验证、复盘和持续跟进。',
].join('\n');

const CODEX_DEMO_PROMPT = '请你作为 Codex，和 Lumi 一起回答：如何和我一起推进用户的需求？请给出一个从理解目标、拆解任务、执行验证到交付复盘的协作流程。';

function normalizeIntentText(text: string): string {
  return text.replace(/\s+/g, '');
}

export function isSelfIntroDemoRequest(text: string): boolean {
  const normalized = normalizeIntentText(text || '');
  if (!normalized) return false;
  const selfIntroduction = SELF_INTRO_PATTERNS.some(pattern => pattern.test(normalized))
    || /(?:自我介绍|介绍(?:一下)?你自己|你是谁|(?:introduce|demo|show).{0,40}(?:yourself|lumi))/iu.test(normalized); // i18n-allow: Chinese self-introduction input recognition.
  const visibleDemo = /(?:演示|展示|桌面操作|实际操作|边介绍边操作|(?:demo|show).{0,40}(?:yourself|lumi))/iu.test(normalized); // i18n-allow: Chinese visible-demo input recognition.
  return selfIntroduction && visibleDemo;
}

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
  return Math.min(6400, Math.max(2200, text.length * 115));
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

const OFFICE_EDITOR_PATTERNS = [
  /wps/i,
  /winword/i,
  /\bword\b/i,
  /writer/i,
  /notepad/i,
  /\u8bb0\u4e8b\u672c/i,
];

export function verifyOfficePasteEvidence(input: {
  activeWindowRaw: string;
  uiSnapshotRaw: string;
  clipboardWriteResult: string;
  clipboardReadResult: string;
  selectAllResult: string;
  pasteResult: string;
  expectedText?: string;
}): { ok: boolean; reason: string } {
  const active = parseActiveWindow(input.activeWindowRaw);
  if (!activeWindowMatches(active, OFFICE_EDITOR_PATTERNS)) {
    return { ok: false, reason: 'active_editor_not_verified' };
  }
  if (!/clipboard updated/i.test(input.clipboardWriteResult) || /failed/i.test(input.clipboardWriteResult)) {
    return { ok: false, reason: 'clipboard_write_not_verified' };
  }
  if (
    input.clipboardReadResult.replace(/\r\n/g, '\n')
    !== (input.expectedText || OFFICE_DEMO_TEXT).replace(/\r\n/g, '\n')
  ) {
    return { ok: false, reason: 'clipboard_readback_mismatch' };
  }
  if (!/pressed:\s*ctrl\+a/i.test(input.selectAllResult)) {
    return { ok: false, reason: 'select_all_not_verified' };
  }
  if (!/pressed:\s*ctrl\+v/i.test(input.pasteResult)) {
    return { ok: false, reason: 'paste_not_verified' };
  }
  try {
    const snapshot = JSON.parse(input.uiSnapshotRaw);
    const capturedNodes = Number(snapshot?.capturedNodes || 0);
    if (
      snapshot?.status !== 'ok'
      || capturedNodes < 1
      || !OFFICE_EDITOR_PATTERNS.some(pattern => pattern.test(input.uiSnapshotRaw))
    ) {
      return { ok: false, reason: 'editor_ui_not_verified' };
    }
  } catch {
    return { ok: false, reason: 'editor_ui_not_verified' };
  }
  return { ok: true, reason: 'verified' };
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

function buildOfficeDemoRtf(text: string): string {
  const [title, ...bodyLines] = text.split(/\r?\n/);
  const body = bodyLines.join('\n').trim();
  return [
    '{\\rtf1\\ansi\\deff0\\uc1',
    '{\\fonttbl{\\f0\\fnil Microsoft YaHei;}}',
    '\\paperw11906\\paperh16838\\margl1440\\margr1440\\margt1200\\margb1200',
    `\\pard\\f0\\fs36\\b ${rtfUnicodeEscape(title || 'Lumi 自我介绍')}\\b0\\par`,
    '\\pard\\f0\\fs24\\sl320\\slmult1',
    rtfUnicodeEscape(body),
    '}',
  ].join('\n');
}

function createOfficeDemoFile(text = OFFICE_DEMO_TEXT): string {
  const desktopDir = path.join(os.homedir(), 'Desktop');
  const fallbackDir = path.join(os.tmpdir(), 'LumiOS-Demo');
  const dir = fs.existsSync(desktopDir) ? desktopDir : fallbackDir;
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'Lumi-自我介绍-演示.rtf');
  fs.writeFileSync(filePath, buildOfficeDemoRtf(text), 'utf8');
  return filePath;
}

export async function runSelfIntroDemo(options: SelfIntroDemoOptions): Promise<{
  responseText: string;
  toolCalls: ToolExecutionRecord[];
  speechSummary: string;
}> {
  const { userId, userText, voiceScope, desktopRelay, isCancelled } = options;
  const snapshot = getSelfModelSnapshot(userId, voiceScope);
  const introPlan = buildSelfIntroductionPlan(userId, voiceScope, {
    visibleDemo: true,
    requestText: userText,
  });
  const toolCalls: ToolExecutionRecord[] = [];
  const run = async (name: string, args: Record<string, any>): Promise<string> => {
    const id = `self-intro-dynamic-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (isCancelled?.()) {
      toolCalls.push({ id, name, arguments: args, result: '', error: 'cancelled_before_execution' });
      return '';
    }
    try {
      const result = String(await desktopRelay(name, args) || '');
      toolCalls.push({ id, name, arguments: args, result });
      return result;
    } catch (error: any) {
      toolCalls.push({
        id,
        name,
        arguments: args,
        result: '',
        error: String(error?.message || error || 'workflow_adapter_failed'),
      });
      return '';
    }
  };

  // The presentation sequence is compiled from the current snapshot. These
  // are client-native adapters, not hard-coded pixel coordinates or business
  // decisions. Missing/stale capabilities simply do not enter the plan.
  const clientActions: Array<Record<string, any>> = [];
  if (snapshot.runtime.awareness !== 'missing') {
    clientActions.push({ action: 'refresh_client_state' });
  }
  if (snapshot.configuredModels.some(model => model.configured)) {
    clientActions.push({ action: 'open_settings', section: 'ai-providers' });
  }
  if (snapshot.knowledgeCoverage.totalFiles > 0) {
    clientActions.push({ action: 'show_knowledge_base' });
  }
  if (snapshot.memoryState.available) {
    clientActions.push({ action: 'open_memory_avatar' });
  }
  clientActions.push({ action: 'open_chat' });

  for (const action of clientActions) {
    await run('client_action', action);
  }

  // External applications are considered only when the request named one.
  // Installed-app and foreground-window evidence are mandatory preflight and
  // postflight gates; an unavailable app is reported instead of substituted.
  const requestedExternal = introPlan.demoCandidates
    .filter(candidate => candidate.enabled && candidate.applicationId !== 'lumi-client');
  for (const candidate of requestedExternal) {
    const application = DESKTOP_APPLICATION_REGISTRY
      .find(item => item.id === candidate.applicationId);
    if (!application) continue;
    const installed = await run('desktop_list_apps', {});
    const identityTerms = [application.displayName, application.id, ...application.aliases]
      .map(value => value.toLowerCase());
    if (!identityTerms.some(term => installed.toLowerCase().includes(term))) continue;
    await run('desktop_open', { target: application.displayName });
    await run('desktop_active_window', {});
  }

  const succeeded = toolCalls.filter(call => !call.error && call.result).length;
  const failed = toolCalls.filter(call => Boolean(call.error)).length;
  const facts = introPlan.statements.map(statement => statement.text).join('');
  const executionSummary = failed > 0
    ? `Visible demo produced ${succeeded} verified adapter result(s) and ${failed} failure(s); failed actions were stopped.`
    : `Visible demo produced ${succeeded} adapter result(s) from the live capability plan.`;
  return {
    responseText: `${facts}\n\n${executionSummary}`,
    speechSummary: `${introPlan.statements.slice(0, 3).map(statement => statement.text).join('')} ${executionSummary}`,
    toolCalls,
  };
}

/**
 * Retained for one-version read-only compatibility tests. It is not registered
 * as a workflow and therefore has no intent, selection, or completion authority.
 */
async function runLegacySelfIntroDemoAdapter({
  socket,
  userText,
  userId,
  desktopRelay,
  speak,
  voiceScope,
  isCancelled,
}: SelfIntroDemoOptions): Promise<{
  responseText: string;
  toolCalls: ToolExecutionRecord[];
  speechSummary: string;
}> {
  const address = getUserAddress(userId);
  const greeting = address ? `好的，${address}。` : '好的。';
  const introPlan = buildSelfIntroductionPlan(
    userId,
    voiceScope,
    { visibleDemo: true, requestText: userText },
  );
  const opening = `${greeting}${introPlan.statements.slice(0, 2).map(statement => statement.text).join('')}`;
  const officeDemoText = introPlan.documentText;
  const spokenLines: string[] = [];
  const toolCalls: ToolExecutionRecord[] = [];
  let officeOutcomeLine = '';

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
      source: 'self_intro_demo',
    });
  };

  const runTool = async (name: string, args: Record<string, any> = {}, optional = true) => {
    const id = `self-intro-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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

  const runClientAction = (args: Record<string, any>) => runTool('client_action', args, true);

  const runAction = async (action: DemoAction) => {
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

  const runActions = async (actions: DemoAction[] = []) => {
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

  const runStep = async (step: DemoStep) => {
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

  const tryOpenAndMatch = async (target: string, patterns: RegExp[], settleMs = 2200) => {
    await runTool('desktop_open', { target }, true);
    await wait(settleMs);
    return waitForActiveWindow(patterns, 2600);
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
    matches.sort((a, b) => {
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      const aw = /wps/i.test(an) ? 0 : /文字|writer/i.test(an) ? 1 : 2;
      const bw = /wps/i.test(bn) ? 0 : /文字|writer/i.test(bn) ? 1 : 2;
      return aw - bw || an.localeCompare(bn);
    });
    return matches[0]?.path || '';
  };

  let wallpaperModeActive = false;

  const enterWallpaperMode = async () => {
    await runTool('desktop_cursor_glow_show', { timeoutMs: 90000 }, true);
    await runTool('desktop_set_wallpaper_mode', {
      enabled: true,
      source: 'self_intro_demo',
      timeoutMs: 90000,
    }, true);
    wallpaperModeActive = true;
    await wait(350);
  };

  const exitWallpaperMode = async () => {
    if (wallpaperModeActive) {
      await runTool('desktop_set_wallpaper_mode', {
        enabled: false,
        source: 'self_intro_demo',
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
    const { x, y } = point;
    await runTool('desktop_mouse_move', { x, y }, true);
    await wait(220);
    if (click) {
      await runTool('desktop_mouse_click_at', { x, y, button: 'left' }, true);
      await runTool('desktop_cursor_glow_click', cursorArgs(point), true);
      await wait(350);
    }
  };

  const getScreenPoint = async (xRatio: number, yRatio: number): Promise<ScreenPoint> => {
    const screen = await getScreenMetrics();
    return {
      x: Math.round(screen.x + screen.width * xRatio),
      y: Math.round(screen.y + screen.height * yRatio),
      screenWidth: screen.width,
      screenHeight: screen.height,
      screenX: screen.x,
      screenY: screen.y,
    };
  };

  const pointScreenRatio = async (xRatio: number, yRatio: number, click = false) => {
    const point = await getScreenPoint(xRatio, yRatio);
    await pointCursor(point, click);
    return point;
  };

  const pointActiveWindowRatio = async (
    patterns: RegExp[],
    xRatio: number,
    yRatio: number,
    click = false,
    fallback: { xRatio: number; yRatio: number } = { xRatio: 0.5, yRatio: 0.88 },
  ) => {
    const screen = await getScreenMetrics();
    const active = await getActiveWindow();
    if (
      activeWindowMatches(active, patterns) &&
      Number(active?.width) > 120 &&
      Number(active?.height) > 120
    ) {
      const point: ScreenPoint = {
        x: Math.round(Number(active?.x || 0) + Number(active?.width || 0) * xRatio),
        y: Math.round(Number(active?.y || 0) + Number(active?.height || 0) * yRatio),
        screenWidth: screen.width,
        screenHeight: screen.height,
        screenX: screen.x,
        screenY: screen.y,
      };
      await pointCursor(point, click);
      return point;
    }
    return pointScreenRatio(fallback.xRatio, fallback.yRatio, click);
  };

  const buildAppActivateCommand = (title: string) => {
    const script = `
$shell = New-Object -ComObject WScript.Shell
$ok = $shell.AppActivate(${psString(title)})
Start-Sleep -Milliseconds 250
Write-Output "APP_ACTIVATE:$ok"
`.trim();
    return powershellCommand(script);
  };

  const buildFocusCodexWindowCommand = () => {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LumiWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
}
"@
$proc = Get-Process |
  Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -ieq 'Codex' -or $_.MainWindowTitle -match 'Codex') } |
  Sort-Object @{ Expression = { if ($_.MainWindowTitle -match '^Codex$') { 0 } else { 1 } } }, StartTime -Descending |
  Select-Object -First 1
if (-not $proc) {
  Write-Output 'CODEX_WINDOW_NOT_FOUND'
  exit 2
}
$hwnd = [IntPtr]$proc.MainWindowHandle
[LumiWin32]::ShowWindowAsync($hwnd, 9) | Out-Null
Start-Sleep -Milliseconds 180
[LumiWin32]::ShowWindowAsync($hwnd, 3) | Out-Null
Start-Sleep -Milliseconds 260
[LumiWin32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 320
$rect = New-Object LumiWin32+RECT
[LumiWin32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$width = [Math]::Max(0, $rect.Right - $rect.Left)
$height = [Math]::Max(0, $rect.Bottom - $rect.Top)
Write-Output ("CODEX_WINDOW_FOCUSED:{0}:{1},{2},{3},{4}" -f $proc.Id, $rect.Left, $rect.Top, $width, $height)
`.trim();
    return powershellCommand(script);
  };

  const buildOpenWpsWriterCommand = (shortcutPath: string, documentPath: string) => {
    const shortcut = shortcutPath ? psString(shortcutPath) : '$null';
    const docPath = psString(documentPath);
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$shortcut = ${shortcut}
$docPath = ${docPath}
Get-Process -Name 'wps' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -eq 0 } |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
$roots = @()
if ($shortcut -and (Test-Path -LiteralPath $shortcut)) {
  $shell = New-Object -ComObject WScript.Shell
  $target = $shell.CreateShortcut($shortcut).TargetPath
  if ($target) {
    $targetDir = Split-Path -Parent $target
    if ($targetDir) { $roots += $targetDir }
    $parent = Split-Path -Parent $targetDir
    if ($parent) { $roots += $parent }
  }
}
$roots += 'D:\\WPS Office'
$candidate = $null
foreach ($root in ($roots | Where-Object { $_ } | Select-Object -Unique)) {
  if (Test-Path -LiteralPath $root) {
    $candidate = Get-ChildItem -LiteralPath $root -Recurse -Filter 'wps.exe' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($candidate) { break }
  }
}
if ($candidate) {
  Start-Process -FilePath $candidate.FullName -ArgumentList @($docPath) -WorkingDirectory $candidate.DirectoryName
  Write-Output "WPS_WRITER_DOC:$($candidate.FullName):$docPath"
  exit 0
}
if ($docPath -and (Test-Path -LiteralPath $docPath)) {
  Start-Process -LiteralPath $docPath
  Write-Output "WPS_DOC_DEFAULT:$docPath"
  exit 0
}
if ($shortcut -and (Test-Path -LiteralPath $shortcut)) {
  Start-Process -LiteralPath $shortcut
  Write-Output "WPS_SHORTCUT:$($shortcut)"
  exit 0
}
Write-Output 'WPS_NOT_FOUND'
exit 2
`.trim();
    return powershellCommand(script);
  };

  const buildOpenCodexCommand = () => {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$app = Get-StartApps | Where-Object { $_.Name -match '^Codex$' -or $_.AppID -match 'OpenAI\\.Codex|Codex' } | Select-Object -First 1
if ($app -and $app.AppID) {
  Start-Process ("shell:AppsFolder\\" + $app.AppID)
  Write-Output ("CODEX_APPID:" + $app.AppID)
  exit 0
}
$cmd = Get-Command 'codex.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cmd -and $cmd.Source) {
  Start-Process -FilePath $cmd.Source
  Write-Output ("CODEX_COMMAND:" + $cmd.Source)
  exit 0
}
$paths = @(
  (Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Links\\codex.exe'),
  (Join-Path $env:LOCALAPPDATA 'OpenAI\\Codex\\Codex.exe')
)
foreach ($path in $paths) {
  if ($path -and (Test-Path -LiteralPath $path)) {
    Start-Process -FilePath $path
    Write-Output ("CODEX_PATH:" + $path)
    exit 0
  }
}
Write-Output 'CODEX_NOT_FOUND'
exit 2
`.trim();
    return powershellCommand(script);
  };

  const internalSteps: DemoStep[] = [
    {
      text: '先看我的主界面。这里不是一个孤立聊天框，而是我在这台电脑上的操作空间。',
      actions: [
        { clientAction: { action: 'demo_open_surface', target: 'home' } },
      ],
    },
    {
      text: '这里是对话入口。你可以用自然语言叫醒我、交代任务，也可以随时打断我。',
      actions: [
        { clientAction: { action: 'demo_open_surface', target: 'chat' } },
      ],
      postActions: [{ clientAction: { action: 'close_client_surface', target: 'chat' } }],
    },
    {
      text: '这里是知识库和记忆。我会把文件、资料、对话和长期背景沉淀下来，减少你反复解释的成本。',
      actions: [
        { clientAction: { action: 'demo_open_surface', target: 'knowledge' } },
      ],
      postActions: [{ clientAction: { action: 'close_client_surface', target: 'knowledge' } }],
    },
    {
      text: '这里是形象和声音。我可以有自己的视觉形象、语音和情绪反馈，让陪伴不只停在文字里。',
      actions: [
        { clientAction: { action: 'demo_open_surface', target: 'personalization' } },
      ],
      postActions: [{ clientAction: { action: 'close_client_surface', target: 'personalization' } }],
    },
    {
      text: '这里是技能。我可以把文档、网页、代码、数据、行业流程这些能力沉淀成可以复用的工作模块。',
      actions: [
        { clientAction: { action: 'demo_open_surface', target: 'skills' } },
      ],
      postActions: [{ clientAction: { action: 'close_client_surface', target: 'skills' } }],
      pauseMs: 4600,
    },
    {
      text: '这里是工具。真正执行任务时，我会把调用、进度和结果证据展示出来，让你看到每一步不是黑箱。',
      actions: [
        { clientAction: { action: 'demo_open_surface', target: 'tools' } },
      ],
      postActions: [{ clientAction: { action: 'close_client_surface', target: 'tools' } }],
      pauseMs: 4600,
    },
    {
      text: '复杂任务不是黑箱。我会把工具调用、执行进度和结果证据展示出来，你能看见我正在做什么。',
      actions: [
        { clientAction: { action: 'open_computer_adaptation' } },
      ],
      postActions: [{ clientAction: { action: 'close_client_surface', target: 'kernel' } }],
    },
    {
      text: '我也能组织多个子智能体协作。对个人，我是助理和伙伴；对团队，我可以扩展成 AI 工作系统。',
      actions: [
        { clientAction: { action: 'demo_open_surface', target: 'team' } },
      ],
      postActions: [{ clientAction: { action: 'close_client_surface', target: 'team' } }],
    },
    {
      text: '接下来我会离开自己的界面，操作真实桌面。比如打开办公软件写内容、打开浏览器查信息、再打开 Codex 做 AI 协作。',
      actions: [
        {
          clientAction: voiceScope.domain === 'work'
            ? { action: 'demo_open_surface', target: 'org' }
            : { action: 'demo_open_surface', target: 'plans' },
        },
        { tool: 'desktop_cursor_glow_show', args: { timeoutMs: 180000 } },
      ],
      postActions: [
        {
          clientAction: voiceScope.domain === 'work'
            ? { action: 'close_client_surface', target: 'org' }
            : { action: 'close_client_surface', target: 'plans' },
        },
      ],
      pauseMs: 6200,
    },
  ];

  const runOfficeDemo = async () => {
    await runStep({
      text: '先演示办公写作。我会尝试打开 WPS 写一份演示文档；如果这台机器没有 WPS，我会自动用记事本完成同样的写作动作。',
      actions: [
        { tool: 'desktop_capture_screen', args: { quality: 45 }, afterMs: 250 },
        { tool: 'desktop_cursor_glow_show', args: { timeoutMs: 180000 }, afterMs: 160 },
      ],
      timing: 'after',
      pauseMs: 6400,
    });

    await enterWallpaperMode();

    const officePatterns = OFFICE_EDITOR_PATTERNS;
    const wpsShortcut = await findDesktopShortcut([/wps/i, /金山/i, /文字/i, /writer/i]);
    const officeDemoFile = createOfficeDemoFile(officeDemoText);
    let active: ActiveWindowInfo | null = null;
    await runTool('desktop_run_command', { command: buildOpenWpsWriterCommand(wpsShortcut, officeDemoFile) }, true);
    await wait(7200);
    active = await waitForActiveWindow(officePatterns, 7800);

    if (!active || !activeWindowMatches(active, officePatterns)) {
      await runTool('desktop_run_command', { command: buildOpenWpsWriterCommand('', officeDemoFile) }, true);
      await wait(5200);
      active = await waitForActiveWindow(officePatterns, 5200);
    }
    if (!active || !activeWindowMatches(active, officePatterns)) active = await tryOpenAndMatch('wps.exe', officePatterns, 5200);
    if (!active) active = await tryOpenAndMatch('winword.exe', officePatterns, 3200);
    if (!active) active = await tryOpenAndMatch('notepad.exe', officePatterns, 1400);

    if (!active) {
      officeOutcomeLine = '这台机器上没有找到可用的文档编辑器，所以我跳过写作窗口，继续演示浏览器和 AI 协作。';
      await say(officeOutcomeLine, 4200);
      return;
    }

    await enterWallpaperMode();
    await runTool('desktop_run_command', { command: buildAppActivateCommand('WPS') }, true);
    await wait(400);
    try {
      const clipboardWriteResult = await runTool(
        'desktop_clipboard_write',
        { text: officeDemoText },
        false,
      );
      const clipboardReadResult = await runTool('desktop_clipboard_read', {}, false);
      await pointActiveWindowRatio(
        officePatterns,
        0.48,
        0.52,
        true,
        { xRatio: 0.5, yRatio: 0.46 },
      );
      await wait(400);
      const selectAllResult = await runTool(
        'desktop_keyboard_press',
        { key: 'ctrl+a' },
        false,
      );
      await wait(220);
      const pasteResult = await runTool(
        'desktop_keyboard_press',
        { key: 'ctrl+v' },
        false,
      );
      await wait(1200);
      const activeWindowRaw = await runTool('desktop_active_window', {}, false);
      const uiSnapshotRaw = await runTool(
        'desktop_ui_snapshot',
        { root: 'active', maxDepth: 4, maxNodes: 120 },
        false,
      );
      const verification = verifyOfficePasteEvidence({
        activeWindowRaw,
        uiSnapshotRaw,
        clipboardWriteResult,
        clipboardReadResult,
        selectAllResult,
        pasteResult,
        expectedText: officeDemoText,
      });
      if (!verification.ok) {
        officeOutcomeLine = `办公文档这一步没有完成：粘贴后的编辑器状态未通过验证（${verification.reason}），所以我不会说已经写好了。`; // i18n-allow: reviewed CN workflow result copy.
        await say(officeOutcomeLine, 5200);
        return;
      }
      officeOutcomeLine = '你看到的不是预录动画。我已经在真实应用里输入了一份演示文档草稿，并核对了编辑器窗口和界面状态。'; // i18n-allow: reviewed CN workflow result copy.
      await say(officeOutcomeLine, 5200);
    } catch (error: any) {
      officeOutcomeLine = `办公文档这一步没有完成：${error?.message || String(error)}。我已跳过完成宣告，继续后面的演示。`; // i18n-allow: reviewed CN workflow result copy.
      await say(officeOutcomeLine, 5200);
    }
  };

  const runBrowserDemo = async () => {
    await runStep({
      text: '接着我打开浏览器。需要查资料、看网页、检索信息时，我可以把浏览器作为外部工作台来使用。',
      actions: [
        { tool: 'desktop_capture_screen', args: { quality: 45 }, afterMs: 250 },
        {
          tool: 'desktop_open',
          args: { target: 'https://www.baidu.com/s?wd=Lumi%20AI%20%E7%A7%81%E6%9C%89%E5%8C%96%20%E4%B8%AA%E4%BA%BA%E5%8A%A9%E7%90%86' },
          afterMs: 3200,
        },
        {
          tool: 'desktop_set_wallpaper_mode',
          args: { enabled: true, source: 'self_intro_demo', timeoutMs: 90000 },
          afterMs: 220,
        },
        { tool: 'desktop_cursor_glow_show', args: { timeoutMs: 90000 }, afterMs: 120 },
        { tool: 'desktop_active_window' },
      ],
      timing: 'after',
      pauseMs: 6200,
    });
    wallpaperModeActive = true;
    const browserPatterns = [/chrome/i, /edge/i, /firefox/i, /browser/i, /msedge/i, /iexplore/i];
    await waitForActiveWindow(browserPatterns, 3200);
    await pointActiveWindowRatio(browserPatterns, 0.5, 0.18, false, { xRatio: 0.5, yRatio: 0.16 });
  };

  const runCodexDemo = async () => {
    const shouldSendToCodex = process.env.LUMI_SELF_INTRO_SEND_CODEX === '1';
    await runStep({
      text: shouldSendToCodex
        ? '最后我打开 Codex 桌面端，向另一个 AI 工具发起一次协作请求。'
        : '最后我打开 Codex 桌面端，准备一条协作请求。默认不自动发送，真正把内容交给外部 AI 前，我会等你确认。',
      actions: [
        { tool: 'desktop_capture_screen', args: { quality: 45 }, afterMs: 250 },
        { tool: 'desktop_cursor_glow_show', args: { timeoutMs: 180000 }, afterMs: 160 },
      ],
      timing: 'after',
      pauseMs: shouldSendToCodex ? 4600 : 6600,
    });

    const codexPatterns = [/codex/i];
    const codexShortcut = await findDesktopShortcut([/codex/i]);
    let active: ActiveWindowInfo | null = null;
    if (codexShortcut) {
      await runTool('desktop_open', { target: codexShortcut }, true);
      await wait(4200);
      await enterWallpaperMode();
      await runTool('desktop_run_command', { command: buildFocusCodexWindowCommand() }, true);
      await wait(900);
      active = await waitForActiveWindow(codexPatterns, 4200);
    }
    if (!active) {
      await runTool('desktop_run_command', { command: buildOpenCodexCommand() }, true);
      await wait(5200);
      await enterWallpaperMode();
      await runTool('desktop_run_command', { command: buildFocusCodexWindowCommand() }, true);
      await wait(900);
      active = await waitForActiveWindow(codexPatterns, 7200);
    }
    if (!active) {
      active = await tryOpenAndMatch('Codex', codexPatterns, 2600);
      await runTool('desktop_run_command', { command: buildFocusCodexWindowCommand() }, true);
      await wait(900);
      active = await waitForActiveWindow(codexPatterns, 3200) || active;
    }
    await enterWallpaperMode();

    if (!active) {
      await say('这台机器上没有找到 Codex 桌面端，所以这一步我先用运行日志记录下来。安装后我就能把任务交给它协作。', 5200);
      return;
    }

    await runTool('desktop_clipboard_write', { text: CODEX_DEMO_PROMPT }, true);
    await runTool('desktop_run_command', { command: buildFocusCodexWindowCommand() }, true);
    await wait(900);
    await runTool('desktop_keyboard_press', { key: 'escape' }, true);
    await wait(120);
    await pointActiveWindowRatio(codexPatterns, 0.55, 0.88, true, { xRatio: 0.5, yRatio: 0.9 });
    await wait(260);
    await runTool('desktop_keyboard_press', { key: 'ctrl+a' }, true);
    await wait(180);
    await runTool('desktop_keyboard_press', { key: 'ctrl+v' }, true);
    await wait(900);
    await pointActiveWindowRatio(codexPatterns, 0.55, 0.82, true, { xRatio: 0.5, yRatio: 0.84 });
    await wait(160);
    await runTool('desktop_keyboard_press', { key: 'ctrl+a' }, true);
    await wait(120);
    await runTool('desktop_keyboard_press', { key: 'ctrl+v' }, true);
    await wait(1600);
    if (shouldSendToCodex) {
      await runTool('desktop_keyboard_press', { key: 'enter' }, true);
      await wait(2600);
    }
  };

  socket.emit('agent:status', {
    status: 'thinking',
    agentName: 'Lumi',
    phase: 'self_intro_demo',
    detail: 'Running self-introduction demo script',
  });

  try {
  await runStep({
    text: opening,
    actions: [{ tool: 'desktop_show_lumi_window', afterMs: 250 }],
    pauseMs: 5200,
  });

  for (const step of internalSteps) {
    if (isCancelled?.()) break;
    await runStep(step);
  }

  if (!isCancelled?.()) {
    await enterWallpaperMode();
    await runTool('desktop_capture_screen', { quality: 45 }, true);
  }
  const enabledDemoIds = new Set(
    introPlan.demoCandidates.filter(candidate => candidate.enabled).map(candidate => candidate.applicationId),
  );
  if (!isCancelled?.() && enabledDemoIds.has('office-suite')) await runOfficeDemo();
  if (!isCancelled?.() && enabledDemoIds.has('desktop-browser')) await runBrowserDemo();
  if (!isCancelled?.() && enabledDemoIds.has('desktop-ai-client')) await runCodexDemo();

  if (!isCancelled?.()) {
    await exitWallpaperMode();
    await runTool('desktop_show_lumi_window', {}, true);
    await wait(600);
    await runClientAction({ action: 'focus_home' });
    await say(introPlan.statements[3]?.text || introPlan.statements[0].text, 6800);
    await say(introPlan.statements[4]?.text || introPlan.statements[0].text, 5600);
  }

  } finally {
    await exitWallpaperMode();
  }

  return {
    responseText: spokenLines.join('\n'),
    toolCalls,
    speechSummary: [officeOutcomeLine, ...spokenLines.slice(-2)].filter(Boolean).join('\n'),
  };
}
