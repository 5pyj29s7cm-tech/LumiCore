import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { analyzeScreen } from '../../llm/adapter';
import { getUserPreferredVision, type VisionProvider } from '../../llm/vision_preferences';

interface DesktopAiTarget {
  id: string;
  label: string;
  aliases?: string[];
  openTargets: string[];
  match: RegExp;
  surface?: 'desktop_app' | 'browser_app' | 'local_runtime' | 'developer_tool';
}

interface DesktopAiTargetRun {
  target: string;
  label: string;
  status: 'sent' | 'prepared' | 'blocked';
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
    openTargets: ['Ollama', 'http://localhost:11434/'],
    match: /ollama|localhost:11434/i,
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
      surface: 'desktop_app' as const,
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
  const customTargets = customTargetsFromArgs(args.customTargets);
  const targets = resolveTargets(args.targets || args.target, customTargets);
  if (targets.length === 0) return 'Error: no supported desktop AI targets matched. Try targets=["workbuddy","codex"].';

  const desktopRelay = requireDesktopRelay(context);
  const openIfNeeded = args.openIfNeeded !== false;
  const send = args.send !== false;
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

    actions.push('desktop_clipboard_write');
    await desktopRelay('desktop_clipboard_write', { text: question });
    actions.push('desktop_keyboard_press:ctrl+v');
    await desktopRelay('desktop_keyboard_press', { key: 'ctrl+v' });

    if (send) {
      actions.push(`desktop_keyboard_press:${submitShortcut}`);
      await desktopRelay('desktop_keyboard_press', { key: submitShortcut });
    }
    if (collectAfterMs > 0) await sleep(collectAfterMs);
    const finalActive = activeWindowMatches(await desktopRelay('desktop_active_window', {}), target);

    results.push({
      target: target.id,
      label: target.label,
      status: send ? 'sent' : 'prepared',
      openTarget: focus.openTarget,
      openResult: focus.openResult,
      activeWindow: finalActive.parsed,
      actions,
      note: finalActive.ok
        ? (send ? 'Question pasted and submit shortcut pressed while target remained foreground.' : 'Question pasted; submit shortcut was not pressed.')
        : 'Question action finished, but foreground window no longer matches the target; verify before claiming completion.',
    });
  }

  return JSON.stringify({
    ok: results.some(result => result.status === 'sent' || result.status === 'prepared'),
    question,
    send,
    sentCount: results.filter(result => result.status === 'sent').length,
    preparedCount: results.filter(result => result.status === 'prepared').length,
    blockedCount: results.filter(result => result.status === 'blocked').length,
    results,
    next: send
      ? 'Wait for each AI to answer, then run desktop_ai_collect_answer for each target. Use the collected texts to summarize agreement, disagreement, and useful next steps.'
      : 'Review the prepared messages, then press send manually or re-run with send=true.',
  }, null, 2);
}

async function desktopAiCollectAnswer(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const customTargets = customTargetsFromArgs(args.customTargets);
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
    'Return the actual answer text if visible. If the app is still loading or only the prompt is visible, say so clearly. Do not invent hidden content.',
  ].filter(Boolean).join('\n');

  const answerText = await analyzeScreen(
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

  return JSON.stringify({
    target: target.id,
    label: target.label,
    status: 'collected',
    activeWindow: focus.activeWindow,
    provider,
    model,
    answerText,
    note: 'Answer was extracted from the visible desktop screen with the configured vision model. Verify if the response is partially off-screen.',
  }, null, 2);
}

export function registerDesktopAiTools(registry: ToolRegistry): void {
  registry.register({
    name: 'desktop_ai_list_targets',
    description: 'List supported local desktop AI collaboration targets such as WorkBuddy and Codex.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => JSON.stringify({
      targets: allTargets().map(target => ({
        id: target.id,
        label: target.label,
        aliases: target.aliases || [],
        surface: target.surface || 'desktop_app',
        openTargets: target.openTargets,
        route: 'desktop window, clipboard paste, optional submit shortcut, then visible-screen answer collection',
      })),
      boundary: 'Use API/MCP/CLI integrations when available. Desktop-only targets are controlled through visible windows and require screenshot or vision evidence for answer collection.',
    }, null, 2),
    permission: 'user',
    securityLevel: 'safe',
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
        collectAfterMs: { type: 'number', description: 'Optional wait after sending before final foreground verification. Does not read the answer; use desktop_ai_collect_answer for that.' },
      },
      required: ['question'],
    },
    handler: desktopAiAsk,
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
