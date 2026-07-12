import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { analyzeScreen } from '../../llm/adapter';
import { getUserPreferredVision, type VisionProvider } from '../../llm/vision_preferences';
import { readDB, writeDB } from '../../../db_layer';

type DesktopAiSurface = 'desktop_app' | 'browser_app' | 'local_runtime' | 'developer_tool';

interface DesktopAiTarget {
  id: string;
  label: string;
  aliases?: string[];
  openTargets: string[];
  match: RegExp;
  surface?: DesktopAiSurface;
}

interface StoredDesktopAiTarget {
  id: string;
  label: string;
  aliases: string[];
  openTargets: string[];
  surface: DesktopAiSurface;
  sourceUrls: string[];
  notes: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface DesktopAiTargetRun {
  target: string;
  label: string;
  status: 'submitted_unverified' | 'prepared' | 'blocked';
  openTarget?: string;
  openResult?: string;
  activeWindow?: unknown;
  actions: string[];
  note: string;
}

const TARGETS: DesktopAiTarget[] = [
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    aliases: ['work buddy'],
    openTargets: ['WorkBuddy', 'workbuddy.exe'],
    match: /work\s*buddy|workbuddy/i,
    surface: 'desktop_app',
  },
  {
    id: 'codex',
    label: 'Codex',
    aliases: ['openai codex'],
    openTargets: ['Codex', 'codex.exe'],
    match: /codex|openai.*codex/i,
    surface: 'developer_tool',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    aliases: ['openai', 'openai chatgpt'],
    openTargets: ['ChatGPT', 'https://chatgpt.com/'],
    match: /chatgpt|chat\.openai|chatgpt\.com|openai/i,
    surface: 'browser_app',
  },
  {
    id: 'claude',
    label: 'Claude',
    aliases: ['anthropic claude'],
    openTargets: ['Claude', 'https://claude.ai/new'],
    match: /claude|anthropic|claude\.ai/i,
    surface: 'browser_app',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    aliases: ['google gemini', 'bard'],
    openTargets: ['Gemini', 'https://gemini.google.com/app'],
    match: /gemini|bard|gemini\.google/i,
    surface: 'browser_app',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    aliases: ['deep seek'],
    openTargets: ['DeepSeek', 'https://chat.deepseek.com/'],
    match: /deep\s*seek|deepseek|chat\.deepseek/i,
    surface: 'browser_app',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    aliases: ['moonshot', '月之暗面'],
    openTargets: ['Kimi', 'https://www.kimi.com/'],
    match: /kimi|moonshot|月之暗面|kimi\.com/i,
    surface: 'browser_app',
  },
  {
    id: 'doubao',
    label: '豆包',
    aliases: ['doubao', '字节豆包'],
    openTargets: ['豆包', 'Doubao', 'https://www.doubao.com/chat/'],
    match: /豆包|doubao|doubao\.com/i,
    surface: 'browser_app',
  },
  {
    id: 'tongyi',
    label: '通义千问',
    aliases: ['通义', 'qwen', 'tongyi qianwen'],
    openTargets: ['通义千问', 'Tongyi', 'https://tongyi.aliyun.com/qianwen/'],
    match: /通义|千问|tongyi|qwen|aliyun/i,
    surface: 'browser_app',
  },
  {
    id: 'wenxin',
    label: '文心一言',
    aliases: ['文心', 'ernie', 'baidu ai'],
    openTargets: ['文心一言', 'ERNIE Bot', 'https://yiyan.baidu.com/'],
    match: /文心|一言|ernie|yiyan|baidu/i,
    surface: 'browser_app',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    aliases: ['perplexity ai'],
    openTargets: ['Perplexity', 'https://www.perplexity.ai/'],
    match: /perplexity|perplexity\.ai/i,
    surface: 'browser_app',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    aliases: ['cursor ai', 'cursor editor'],
    openTargets: ['Cursor', 'Cursor.exe'],
    match: /cursor/i,
    surface: 'developer_tool',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    aliases: ['copilot', 'github copilot', 'vscode copilot'],
    openTargets: ['GitHub Copilot', 'Visual Studio Code'],
    match: /copilot|github.*copilot|visual studio code|vscode|code\.exe/i,
    surface: 'developer_tool',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    aliases: ['lm studio'],
    openTargets: ['LM Studio', 'LM Studio.exe'],
    match: /lm\s*studio|lmstudio/i,
    surface: 'local_runtime',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    aliases: ['ollama chat'],
    openTargets: ['Ollama', 'http://127.0.0.1:11434/'],
    match: /ollama|(?:localhost|127\.0\.0\.1):11434/i,
    surface: 'local_runtime',
  },
  {
    id: 'cherry-studio',
    label: 'Cherry Studio',
    aliases: ['cherrystudio', 'cherry ai'],
    openTargets: ['Cherry Studio', 'Cherry Studio.exe'],
    match: /cherry\s*studio|cherrystudio/i,
    surface: 'desktop_app',
  },
  {
    id: 'anythingllm',
    label: 'AnythingLLM',
    aliases: ['anything llm'],
    openTargets: ['AnythingLLM', 'http://localhost:3001/'],
    match: /anything\s*llm|anythingllm|localhost:3001/i,
    surface: 'local_runtime',
  },
];

const STORED_TARGETS_SETTING_PREFIX = 'desktop_ai_targets:';

const DISCOVERY_QUERIES = [
  'Windows desktop AI assistant app official site',
  'AI coding desktop app Windows official site',
  'local LLM desktop app Windows official site',
  'AI chat desktop client Windows official site',
  'browser AI assistant web app official site',
];

function requireDesktopRelay(context?: ToolContext): NonNullable<ToolContext['desktopRelay']> {
  if (!context?.desktopRelay) throw new Error('Desktop AI tools require the Lumi desktop client relay.');
  return context.desktopRelay;
}

function listArg(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,\n，、]/).map(item => item.trim()).filter(Boolean);
  return [];
}

function targetText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim().toLowerCase().replace(/\s+/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSurface(value: unknown): DesktopAiSurface {
  const surface = String(value || '').trim();
  if (surface === 'browser_app' || surface === 'local_runtime' || surface === 'developer_tool') return surface;
  return 'desktop_app';
}

function normalizeTargetId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function storedTargetsKey(userId: string): string {
  return `${STORED_TARGETS_SETTING_PREFIX}${userId || 'anonymous'}`;
}

function normalizeStoredTarget(raw: Record<string, any>, existing?: StoredDesktopAiTarget): StoredDesktopAiTarget {
  const label = String(raw.label || raw.name || existing?.label || '').trim().slice(0, 80);
  const id = normalizeTargetId(String(raw.id || raw.name || label || existing?.id || ''));
  const openTargets = listArg(raw.openTargets || raw.openTarget || raw.target || raw.url || raw.path || existing?.openTargets);
  const aliases = listArg(raw.aliases || raw.alias || raw.matchText || raw.windowTitle || existing?.aliases);
  if (!id) throw new Error('Desktop AI target id or label is required.');
  if (!label) throw new Error('Desktop AI target label is required.');
  if (openTargets.length === 0) throw new Error('At least one open target, URL, app name, or executable path is required.');

  const now = new Date().toISOString();
  return {
    id,
    label,
    aliases: Array.from(new Set([...(aliases || []), label].filter(Boolean))).slice(0, 16),
    openTargets: Array.from(new Set(openTargets)).slice(0, 8),
    surface: normalizeSurface(raw.surface || existing?.surface),
    sourceUrls: listArg(raw.sourceUrls || raw.sourceUrl || raw.sources || existing?.sourceUrls).slice(0, 12),
    notes: String(raw.notes || raw.note || existing?.notes || '').trim().slice(0, 1000),
    enabled: raw.enabled === undefined ? existing?.enabled !== false : raw.enabled !== false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

function storedTargetToRuntime(target: StoredDesktopAiTarget): DesktopAiTarget | null {
  if (!target.enabled) return null;
  const matchTerms = [
    target.label,
    target.id,
    ...target.aliases,
    ...target.openTargets.filter(openTarget => !/^https?:\/\//i.test(openTarget)),
  ].filter(Boolean);
  if (matchTerms.length === 0 || target.openTargets.length === 0) return null;
  return {
    id: target.id,
    label: target.label,
    aliases: target.aliases,
    openTargets: target.openTargets,
    match: new RegExp(matchTerms.map(escapeRegExp).join('|'), 'i'),
    surface: target.surface,
  };
}

function loadStoredTargetRecords(userId = 'anonymous'): StoredDesktopAiTarget[] {
  try {
    const db = readDB();
    const row = (db.settings || []).find((item: any) => item.key === storedTargetsKey(userId));
    const parsed = row?.value ? JSON.parse(row.value) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: any) => {
        try { return normalizeStoredTarget(item, item); } catch { return null; }
      })
      .filter((item): item is StoredDesktopAiTarget => Boolean(item));
  } catch {
    return [];
  }
}

function saveStoredTargetRecords(userId: string, targets: StoredDesktopAiTarget[]) {
  const db = readDB();
  if (!db.settings) db.settings = [];
  const key = storedTargetsKey(userId);
  const row = db.settings.find((item: any) => item.key === key);
  const value = JSON.stringify(targets.slice(0, 80));
  if (row) row.value = value;
  else db.settings.push({ key, value });
  writeDB(db);
}

function storedTargetsFromDb(userId = 'anonymous'): DesktopAiTarget[] {
  return loadStoredTargetRecords(userId)
    .map(storedTargetToRuntime)
    .filter((target): target is DesktopAiTarget => Boolean(target));
}

function customTargetsFromArgs(value: unknown): DesktopAiTarget[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map<DesktopAiTarget | null>((item, index) => {
    const raw = item as Record<string, any>;
    const id = String(raw.id || raw.name || `custom_${index + 1}`).trim();
    const label = String(raw.label || raw.name || id).trim();
    const openTargets = listArg(raw.openTargets || raw.openTarget || raw.target || raw.url || raw.path);
    const aliases = listArg(raw.aliases || raw.alias || raw.matchText || raw.windowTitle);
    const matchTerms = [
      label,
      id,
      ...aliases,
      ...openTargets.filter(target => !/^https?:\/\//i.test(target)),
    ].filter(Boolean);
    if (!id || openTargets.length === 0 || matchTerms.length === 0) return null;
    return {
      id,
      label,
      aliases,
      openTargets,
      match: new RegExp(matchTerms.map(escapeRegExp).join('|'), 'i'),
      surface: normalizeSurface(raw.surface),
    };
  }).filter((target): target is DesktopAiTarget => Boolean(target));
}

function allTargets(customTargets?: DesktopAiTarget[]): DesktopAiTarget[] {
  const merged = [...TARGETS];
  for (const target of customTargets || []) {
    const key = targetText(target.id);
    const index = merged.findIndex(item => targetText(item.id) === key);
    if (index >= 0) merged[index] = target;
    else merged.push(target);
  }
  return merged;
}

function runtimeTargetsFromContext(args: Record<string, any>, context?: ToolContext): DesktopAiTarget[] {
  const stored = args.includeStored === false ? [] : storedTargetsFromDb(context?.userId || 'anonymous');
  return [...stored, ...customTargetsFromArgs(args.customTargets)];
}

function resolveTargets(value: unknown, customTargets: DesktopAiTarget[] = []): DesktopAiTarget[] {
  const catalog = allTargets(customTargets);
  const requested = listArg(value);
  if (requested.length === 0) return catalog.filter(target => ['workbuddy', 'codex'].includes(target.id));
  const resolved: DesktopAiTarget[] = [];
  for (const item of requested) {
    const key = targetText(item);
    const found = catalog.find(target => (
      targetText(target.id) === key ||
      targetText(target.label) === key ||
      (target.aliases || []).some(alias => targetText(alias) === key) ||
      target.openTargets.some(openTarget => targetText(openTarget) === key)
    ));
    if (found && !resolved.some(target => target.id === found.id)) resolved.push(found);
  }
  return resolved;
}

function parseJson(raw: string): any {
  try { return JSON.parse(raw); } catch { return raw; }
}

function windowText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const item = value as Record<string, any>;
  return [
    item.title,
    item.name,
    item.processName,
    item.process_name,
    item.app,
    item.exe,
    item.path,
  ].filter(Boolean).join(' ');
}

function activeWindowMatches(raw: string, target: DesktopAiTarget): { ok: boolean; parsed: unknown } {
  const parsed = parseJson(raw);
  return { ok: target.match.test(windowText(parsed)), parsed };
}

function finiteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function promptInputPoint(activeWindow: unknown): { x: number; y: number } | null {
  if (!activeWindow || typeof activeWindow !== 'object') return null;
  const info = activeWindow as Record<string, any>;
  const bounds = info.bounds || info.rect || info.windowBounds || {};
  const x = finiteNumber(info.x, info.left, bounds.x, bounds.left);
  const y = finiteNumber(info.y, info.top, bounds.y, bounds.top);
  const right = finiteNumber(info.right, bounds.right);
  const bottom = finiteNumber(info.bottom, bounds.bottom);
  const width = finiteNumber(info.width, bounds.width, x !== null && right !== null ? right - x : null);
  const height = finiteNumber(info.height, bounds.height, y !== null && bottom !== null ? bottom - y : null);
  if (x === null || y === null || width === null || height === null || width < 320 || height < 320) return null;
  if (x < -10000 || y < -10000) return null;
  return {
    x: Math.round(x + width * 0.54),
    y: Math.round(y + height * 0.84),
  };
}

export function parseDesktopAiAnswerEvidence(value: unknown): {
  ready: boolean;
  answerText: string;
  confidence: number;
  reason: string;
} {
  const raw = String(value || '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ready: false, answerText: '', confidence: 0, reason: raw.slice(0, 300) || 'No structured answer evidence.' };
  try {
    const parsed = JSON.parse(match[0]);
    const answerText = String(parsed.answerText || parsed.answer || '').trim();
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0)));
    return {
      ready: parsed.ready === true && answerText.length > 0 && confidence >= 0.55,
      answerText,
      confidence,
      reason: String(parsed.reason || '').trim().slice(0, 500),
    };
  } catch {
    return { ready: false, answerText: '', confidence: 0, reason: raw.slice(0, 300) || 'Invalid answer evidence.' };
  }
}

function resolveVisionProvider(context?: ToolContext): VisionProvider | null {
  const g = context?.llmGetters;
  if (!g) return null;
  const provider = getUserPreferredVision(context?.userId || 'anonymous').provider;
  if (provider === 'openai' && g.getOpenAI?.()) return 'openai';
  if (provider === 'gemini' && g.getGemini?.()) return 'gemini';
  if (provider === 'ark' && g.getArk?.()) return 'ark';
  if (provider === 'qwen' && g.getQwen?.()) return 'qwen';
  if (provider === 'ollama' && g.getOllama?.()) return 'ollama';
  if (provider === 'lmstudio' && g.getLmStudio?.()) return 'lmstudio';
  if (provider === 'relay' && g.getRelay?.()) return 'relay';
  return null;
}

function fallbackVisionModel(provider: VisionProvider): string {
  switch (provider) {
    case 'qwen': return 'qwen-vl-max';
    case 'ark': return 'doubao-1-5-vision-pro-32k';
    case 'ollama': return 'qwen2.5vl:7b';
    case 'lmstudio': return 'local-vision-model';
    case 'relay': return 'qwen2.5-vl-7b-instruct';
    case 'openai': return 'gpt-4o';
    case 'gemini':
    default:
      return 'gemini-2.0-flash';
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(ms, 30_000))));
}

async function focusTarget(
  desktopRelay: NonNullable<ToolContext['desktopRelay']>,
  target: DesktopAiTarget,
  openIfNeeded: boolean,
): Promise<{ ok: boolean; openTarget?: string; openResult?: string; activeWindow?: unknown; note: string }> {
  const before = activeWindowMatches(await desktopRelay('desktop_active_window', {}), target);
  if (before.ok) {
    return { ok: true, activeWindow: before.parsed, note: 'Target is already foreground.' };
  }

  if (!openIfNeeded) {
    return { ok: false, activeWindow: before.parsed, note: 'Target is not foreground and openIfNeeded=false.' };
  }

  let lastOpenTarget = '';
  let lastOpenResult = '';
  let lastActive: unknown = before.parsed;
  for (const openTarget of target.openTargets) {
    lastOpenTarget = openTarget;
    lastOpenResult = await desktopRelay('desktop_open', { target: openTarget });
    await sleep(900);
    const active = activeWindowMatches(await desktopRelay('desktop_active_window', {}), target);
    lastActive = active.parsed;
    if (active.ok) {
      return {
        ok: true,
        openTarget,
        openResult: lastOpenResult,
        activeWindow: active.parsed,
        note: 'Target opened or focused.',
      };
    }
  }
  return {
    ok: false,
    openTarget: lastOpenTarget,
    openResult: lastOpenResult,
    activeWindow: lastActive,
    note: 'Could not verify target as the foreground desktop AI window.',
  };
}

async function desktopAiAsk(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const question = String(args.question || args.prompt || args.message || '').trim();
  if (!question) return 'Error: question is required.';
  const customTargets = runtimeTargetsFromContext(args, context);
  const targets = resolveTargets(args.targets || args.target, customTargets);
  if (targets.length === 0) return 'Error: no supported desktop AI targets matched. Try targets=["workbuddy","codex"].';

  const desktopRelay = requireDesktopRelay(context);
  const openIfNeeded = args.openIfNeeded !== false;
  const send = args.send !== false;
  const useVirtualCursor = args.useVirtualCursor !== false;
  const submitShortcut = String(args.submitShortcut || 'enter').trim() || 'enter';
  const collectAfterMs = Math.max(0, Math.min(Number(args.collectAfterMs) || 0, 30_000));
  const results: DesktopAiTargetRun[] = [];

  for (const target of targets) {
    const actions: string[] = [];
    const focus = await focusTarget(desktopRelay, target, openIfNeeded);
    if (!focus.ok) {
      results.push({
        target: target.id,
        label: target.label,
        status: 'blocked',
        openTarget: focus.openTarget,
        openResult: focus.openResult,
        activeWindow: focus.activeWindow,
        actions,
        note: focus.note,
      });
      continue;
    }

    const inputPoint = promptInputPoint(focus.activeWindow);
    if (useVirtualCursor && inputPoint) {
      actions.push('desktop_cursor_glow_show');
      await desktopRelay('desktop_cursor_glow_show', { source: 'desktop_ai_ask', timeoutMs: 12000 }).catch(() => '');
      await desktopRelay('desktop_cursor_glow_update', inputPoint).catch(() => '');
      actions.push('desktop_mouse_click_at');
      await desktopRelay('desktop_mouse_click_at', { ...inputPoint, button: 'left' });
      await desktopRelay('desktop_cursor_glow_click', inputPoint).catch(() => '');
      await sleep(180);
    }

    actions.push('desktop_clipboard_write');
    await desktopRelay('desktop_clipboard_write', { text: question });
    actions.push('desktop_keyboard_press:ctrl+v');
    await desktopRelay('desktop_keyboard_press', { key: 'ctrl+v' });

    if (send) {
      actions.push(`desktop_keyboard_press:${submitShortcut}`);
      await desktopRelay('desktop_keyboard_press', { key: submitShortcut });
    }
    if (useVirtualCursor && inputPoint) {
      await desktopRelay('desktop_cursor_glow_hide', { source: 'desktop_ai_ask' }).catch(() => '');
    }
    if (collectAfterMs > 0) await sleep(collectAfterMs);
    const finalActive = activeWindowMatches(await desktopRelay('desktop_active_window', {}), target);

    results.push({
      target: target.id,
      label: target.label,
      status: send ? 'submitted_unverified' : 'prepared',
      openTarget: focus.openTarget,
      openResult: focus.openResult,
      activeWindow: finalActive.parsed,
      actions,
      note: finalActive.ok
        ? (send
            ? 'Question was pasted and the submit shortcut was pressed while the target remained foreground. Submission is not marked verified until answer evidence is collected.'
            : 'Question pasted; submit shortcut was not pressed.')
        : 'Question action finished, but foreground window no longer matches the target; verify before claiming completion.',
    });
  }

  return JSON.stringify({
    ok: results.some(result => result.status === 'submitted_unverified' || result.status === 'prepared'),
    question,
    send,
    submittedCount: results.filter(result => result.status === 'submitted_unverified').length,
    sentCount: 0,
    verifiedSentCount: 0,
    preparedCount: results.filter(result => result.status === 'prepared').length,
    blockedCount: results.filter(result => result.status === 'blocked').length,
    results,
    next: send
      ? 'Submission actions are unverified until visible answers are collected. Run desktop_ai_collect_answer for each target, or use desktop_ai_roundtable to collect all answers and synthesize them.'
      : 'Review the prepared messages, then press send manually or re-run with send=true.',
  }, null, 2);
}

async function desktopAiCollectAnswer(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const customTargets = runtimeTargetsFromContext(args, context);
  const targets = resolveTargets(args.targets || args.target, customTargets);
  const target = targets[0];
  if (!target) return 'Error: target is required. Try target="workbuddy" or target="codex".';

  const desktopRelay = requireDesktopRelay(context);
  const openIfNeeded = args.openIfNeeded !== false;
  const waitMs = Math.max(0, Math.min(Number(args.waitMs) || 0, 60_000));
  if (waitMs > 0) await sleep(waitMs);

  const focus = await focusTarget(desktopRelay, target, openIfNeeded);
  const captureRaw = focus.ok ? await desktopRelay('desktop_capture_screen', { quality: 70 }) : '';
  const provider = resolveVisionProvider(context);
  if (!focus.ok) {
    return JSON.stringify({
      target: target.id,
      label: target.label,
      status: 'blocked',
      activeWindow: focus.activeWindow,
      answerText: null,
      note: focus.note,
    }, null, 2);
  }

  if (!provider) {
    return JSON.stringify({
      target: target.id,
      label: target.label,
      status: 'needs_vision_setup',
      activeWindow: focus.activeWindow,
      answerText: null,
      screenshotCaptured: Boolean(captureRaw),
      note: 'No configured vision provider is available. Configure a vision model or use a structured API/MCP adapter to read answers automatically.',
    }, null, 2);
  }

  const visionPref = getUserPreferredVision(context?.userId || 'anonymous');
  const model = visionPref.model || fallbackVisionModel(provider);
  const g = context?.llmGetters;
  if (!g) {
    return JSON.stringify({
      target: target.id,
      label: target.label,
      status: 'needs_vision_setup',
      activeWindow: focus.activeWindow,
      answerText: null,
      screenshotCaptured: Boolean(captureRaw),
      note: 'No LLM provider getters are available in this context.',
    }, null, 2);
  }
  const query = [
    `Read the visible answer from ${target.label}.`,
    args.question ? `Original question: ${String(args.question).slice(0, 1200)}` : '',
    'Use only visible evidence. Set ready=true only when a substantive assistant answer is visible, not when the app is loading or only the user prompt is visible.',
    'Return only JSON: {"ready":boolean,"answerText":"visible answer or empty","confidence":number,"reason":"short evidence"}. Do not invent hidden or off-screen content.',
  ].filter(Boolean).join('\n');

  const rawAnswerEvidence = await analyzeScreen(
    captureRaw,
    query,
    { provider, model, userId: context?.userId || 'anonymous' },
    g.getDeepSeek,
    g.getGemini,
    g.getOpenAI,
    g.getAnthropic,
    g.getQwen,
    g.getOllama,
    g.getLmStudio,
    g.getArk,
    g.getXiaomi,
    g.getKimi,
    g.getGlm,
    g.getRelay,
  );
  const evidence = parseDesktopAiAnswerEvidence(rawAnswerEvidence);

  return JSON.stringify({
    target: target.id,
    label: target.label,
    status: evidence.ready ? 'collected' : 'pending',
    activeWindow: focus.activeWindow,
    provider,
    model,
    answerText: evidence.ready ? evidence.answerText : null,
    confidence: evidence.confidence,
    evidenceReason: evidence.reason,
    note: evidence.ready
      ? 'A visible answer was extracted from the desktop screen. It may still be partial if the response extends off-screen.'
      : 'No completed visible answer was verified yet. Wait and collect again instead of inventing an answer.',
  }, null, 2);
}

async function desktopAiRoundtable(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const question = String(args.question || args.prompt || args.message || '').trim();
  if (!question) return 'Error: question is required.';
  const customTargets = runtimeTargetsFromContext(args, context);
  const targets = resolveTargets(args.targets || args.target, customTargets);
  if (targets.length === 0) return 'Error: no supported desktop AI targets matched.';

  const ask = JSON.parse(await desktopAiAsk({
    ...args,
    question,
    targets: targets.map(target => target.id),
    send: true,
    collectAfterMs: 0,
  }, context));
  const submitted = new Set(
    (ask.results || [])
      .filter((result: DesktopAiTargetRun) => result.status === 'submitted_unverified')
      .map((result: DesktopAiTargetRun) => result.target),
  );
  const initialWaitMs = Math.max(0, Math.min(Number(args.initialWaitMs ?? 4000), 60_000));
  const pollIntervalMs = Math.max(500, Math.min(Number(args.pollIntervalMs ?? 2500), 30_000));
  const pollAttempts = Math.max(1, Math.min(Number(args.pollAttempts ?? 2), 5));
  const answers: any[] = [];

  let first = true;
  for (const target of targets) {
    if (!submitted.has(target.id)) {
      const blocked = (ask.results || []).find((result: DesktopAiTargetRun) => result.target === target.id);
      answers.push({
        target: target.id,
        label: target.label,
        status: 'blocked',
        answerText: null,
        note: blocked?.note || 'Question was not submitted to this target.',
      });
      continue;
    }

    let collected: any = null;
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      const waitMs = first && attempt === 0 ? initialWaitMs : attempt > 0 ? pollIntervalMs : 0;
      first = false;
      collected = JSON.parse(await desktopAiCollectAnswer({
        ...args,
        question,
        target: target.id,
        targets: undefined,
        waitMs,
      }, context));
      if (collected.status === 'collected' || collected.status === 'blocked' || collected.status === 'needs_vision_setup') break;
    }
    answers.push(collected || {
      target: target.id,
      label: target.label,
      status: 'pending',
      answerText: null,
      note: 'No visible answer was collected.',
    });
  }

  const collectedAnswers = answers.filter(answer => answer?.status === 'collected' && String(answer?.answerText || '').trim());
  return JSON.stringify({
    ok: collectedAnswers.length > 0,
    question,
    targets: targets.map(target => ({ id: target.id, label: target.label })),
    ask,
    answers,
    collectedCount: collectedAnswers.length,
    pendingCount: answers.filter(answer => answer?.status === 'pending').length,
    blockedCount: answers.filter(answer => answer?.status === 'blocked').length,
    needsVisionSetupCount: answers.filter(answer => answer?.status === 'needs_vision_setup').length,
    synthesisInput: collectedAnswers.map(answer => ({
      target: answer.label || answer.target,
      answer: answer.answerText,
    })),
    next: collectedAnswers.length > 0
      ? 'Synthesize the collected answers: agreements, disagreements, strongest evidence, and a final recommendation. Clearly name targets that are still pending or blocked.'
      : 'No verified visible answer was collected. Configure vision if needed, wait for pending targets, and collect again.',
  }, null, 2);
}

export function registerDesktopAiTools(registry: ToolRegistry): void {
  registry.register({
    name: 'desktop_ai_list_targets',
    description: 'List supported local desktop AI collaboration targets such as WorkBuddy, Codex, registered user targets, and common browser/local AI tools.',
    parameters: {
      type: 'object',
      properties: {
        includeStored: { type: 'boolean', description: 'Include user-registered targets. Defaults true.' },
        customTargets: { type: 'array', description: 'Optional one-off targets to include in this listing.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const stored = args.includeStored === false ? [] : storedTargetsFromDb(context?.userId || 'anonymous');
      const custom = customTargetsFromArgs(args.customTargets);
      const storedIds = new Set(stored.map(target => target.id));
      const customIds = new Set(custom.map(target => target.id));
      return JSON.stringify({
        targets: allTargets([...stored, ...custom]).map(target => ({
          id: target.id,
          label: target.label,
          aliases: target.aliases || [],
          surface: target.surface || 'desktop_app',
          openTargets: target.openTargets,
          source: storedIds.has(target.id) ? 'registered' : customIds.has(target.id) ? 'custom' : 'built_in',
          route: 'desktop window, clipboard paste, optional submit shortcut, then visible-screen answer collection',
        })),
        discovery: 'Use desktop_ai_discovery_plan plus web_search/url_fetch/authority_research to research missing desktop AI tools, then register confirmed targets with desktop_ai_register_target.',
        boundary: 'Use API/MCP/CLI integrations when available. Desktop-only targets are controlled through visible windows and require screenshot or vision evidence for answer collection.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_ai_discovery_plan',
    description: 'Create a source-grounded discovery plan for new desktop AI or desktop tool targets that Lumi can later register and control through the generic desktop_ai_* route. Use with web_search/url_fetch/authority_research during autonomous public-source learning or when the user asks what other desktop AI/tools can be supported.',
    parameters: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: 'Discovery focus, e.g. desktop AI tools, coding agents, local LLM apps, browser AI apps.' },
        includeKnownTargets: { type: 'boolean', description: 'Include the current built-in and registered target catalog. Defaults true.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const focus = String(args.focus || 'desktop AI and desktop automation tools').trim();
      const knownTargets = args.includeKnownTargets === false
        ? []
        : allTargets(storedTargetsFromDb(context?.userId || 'anonymous')).map(target => ({
            id: target.id,
            label: target.label,
            surface: target.surface || 'desktop_app',
            openTargets: target.openTargets,
          }));
      return JSON.stringify({
        focus,
        knownTargets,
        suggestedQueries: DISCOVERY_QUERIES.map(query => `${focus} ${query}`),
        candidateSchema: {
          id: 'stable-lowercase-id',
          label: 'Human readable app/tool name',
          aliases: ['window title alias', 'brand alias'],
          openTargets: ['app name, executable, localhost URL, or official web URL'],
          surface: 'desktop_app | browser_app | local_runtime | developer_tool',
          sourceUrls: ['official product page or documentation URL'],
          notes: 'What it is, how to open it, login/API limits, and evidence from sources.',
        },
        evaluationChecklist: [
          'Prefer official product pages, docs, GitHub repos, or vendor download pages.',
          'Record whether the target is a desktop app, browser app, local runtime, or developer tool.',
          'Find a stable open target: app name, executable name, localhost URL, or official web URL.',
          'Name login, payment, captcha, account switching, or install requirements as blockers, not completed capability.',
          'After user confirmation, call desktop_ai_register_target so future desktop_ai_ask calls can use the target without one-off customTargets.',
        ],
        boundary: 'Discovery is public-source research. It does not install software, log into accounts, bypass verification, or activate a target without confirmation.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_ai_register_target',
    description: 'Register or update a user-confirmed desktop AI target discovered by research so future desktop_ai_ask and desktop_ai_collect_answer calls can use it without one-off customTargets.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable lowercase id, e.g. raycast-ai, windsurf, open-webui.' },
        label: { type: 'string', description: 'Human readable target name.' },
        aliases: { type: 'array', description: 'Window title, brand, or user aliases.' },
        openTargets: { type: 'array', description: 'App names, executable names, localhost URLs, or official web URLs to try in order.' },
        surface: { type: 'string', enum: ['desktop_app', 'browser_app', 'local_runtime', 'developer_tool'], description: 'Target surface type.' },
        sourceUrls: { type: 'array', description: 'Official source URLs used to verify this target.' },
        notes: { type: 'string', description: 'Source-grounded notes, limits, login/install requirements, and control assumptions.' },
        enabled: { type: 'boolean', description: 'Whether the target should be active. Defaults true.' },
      },
      required: ['label', 'openTargets'],
    },
    handler: async (args, context) => {
      const userId = context?.userId || 'anonymous';
      const existing = loadStoredTargetRecords(userId);
      const existingIndex = existing.findIndex(target => target.id === normalizeTargetId(String(args.id || args.label || '')));
      const target = normalizeStoredTarget(args, existingIndex >= 0 ? existing[existingIndex] : undefined);
      if (existingIndex >= 0) existing[existingIndex] = target;
      else existing.push(target);
      saveStoredTargetRecords(userId, existing);
      return JSON.stringify({
        registered: true,
        target,
        note: 'Target registered locally. Future desktop_ai_list_targets, desktop_ai_ask, and desktop_ai_collect_answer calls can resolve it by id, label, alias, or open target.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'desktop_ai_ask',
    description: 'Ask one or more local desktop AI apps such as WorkBuddy and Codex the same question through their real desktop windows. It opens/focuses each target, writes the question to the clipboard, pastes it, and optionally presses the submit shortcut. Use when the user asks Lumi to send a question to other AI apps on this computer.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question or task to send to the desktop AI targets.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Desktop AI target ids or names. Supported built-ins include workbuddy, codex, chatgpt, claude, gemini, deepseek, kimi, doubao, tongyi, wenxin, perplexity, cursor, copilot, lmstudio, ollama, cherry-studio, anythingllm. Defaults to WorkBuddy and Codex.' },
        customTargets: {
          type: 'array',
          items: { type: 'object' },
          description: 'Optional custom targets: [{id,label,openTargets:["AppName or URL"],aliases:["window title"]}]. Use this for other desktop tools before they become built-ins.',
        },
        send: { type: 'boolean', description: 'Press the submit shortcut after pasting. Defaults true. Set false to only prepare the message.' },
        submitShortcut: { type: 'string', description: 'Shortcut used to submit, default enter. Use ctrl+enter for apps that need it.' },
        openIfNeeded: { type: 'boolean', description: 'Open/focus the app if it is not already foreground. Defaults true.' },
        useVirtualCursor: { type: 'boolean', description: 'Focus the likely prompt area with Lumi\'s independent virtual cursor before pasting when window bounds are available. Defaults true.' },
        collectAfterMs: { type: 'number', description: 'Optional wait after sending before final foreground verification. Does not read the answer; use desktop_ai_collect_answer for that.' },
      },
      required: ['question'],
    },
    handler: desktopAiAsk,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_ai_roundtable',
    description: 'Ask multiple desktop AI targets the same question, wait for their visible responses, collect each answer with screenshot vision evidence, and return a structured synthesis input for Lumi. Use this when the user wants WorkBuddy, Codex, or other desktop/web AI answers brought back and summarized together.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question or task to send to every selected AI target.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Target ids or names. Defaults to WorkBuddy and Codex.' },
        customTargets: { type: 'array', items: { type: 'object' }, description: 'Optional one-off custom desktop AI targets.' },
        submitShortcut: { type: 'string', description: 'Submit shortcut, default enter.' },
        openIfNeeded: { type: 'boolean', description: 'Open/focus targets when needed. Defaults true.' },
        useVirtualCursor: { type: 'boolean', description: 'Focus likely prompt areas with the virtual cursor. Defaults true.' },
        initialWaitMs: { type: 'number', description: 'Initial wait before the first answer collection. Defaults 4000, max 60000.' },
        pollIntervalMs: { type: 'number', description: 'Wait between retries for pending answers. Defaults 2500, max 30000.' },
        pollAttempts: { type: 'number', description: 'Collection attempts per target, default 2, max 5.' },
      },
      required: ['question'],
    },
    handler: desktopAiRoundtable,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_ai_collect_answer',
    description: 'Collect the visible answer from a local desktop AI app such as WorkBuddy or Codex using screenshot vision evidence. Use after desktop_ai_ask when the user wants the answers brought back and summarized.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Desktop AI target id or name, e.g. workbuddy or codex.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Optional target list; the first supported target is used.' },
        customTargets: {
          type: 'array',
          items: { type: 'object' },
          description: 'Optional custom targets: [{id,label,openTargets:["AppName or URL"],aliases:["window title"]}].',
        },
        question: { type: 'string', description: 'Original question, used to help distinguish the answer from the prompt.' },
        openIfNeeded: { type: 'boolean', description: 'Open/focus the app if it is not already foreground. Defaults true.' },
        waitMs: { type: 'number', description: 'Optional wait before collecting, max 60000.' },
      },
      required: [],
    },
    handler: desktopAiCollectAnswer,
    permission: 'user',
    securityLevel: 'safe',
  });
}
