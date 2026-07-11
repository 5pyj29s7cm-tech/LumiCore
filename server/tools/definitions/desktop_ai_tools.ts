import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { analyzeScreen } from '../../llm/adapter';
import { getUserPreferredVision, type VisionProvider } from '../../llm/vision_preferences';

interface DesktopAiTarget {
  id: string;
  label: string;
  openTargets: string[];
  match: RegExp;
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
    openTargets: ['WorkBuddy', 'workbuddy.exe'],
    match: /work\s*buddy|workbuddy/i,
  },
  {
    id: 'codex',
    label: 'Codex',
    openTargets: ['Codex', 'codex.exe'],
    match: /codex|openai.*codex/i,
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

function resolveTargets(value: unknown): DesktopAiTarget[] {
  const requested = listArg(value);
  if (requested.length === 0) return TARGETS.slice(0, 2);
  const resolved: DesktopAiTarget[] = [];
  for (const item of requested) {
    const key = targetText(item);
    const found = TARGETS.find(target => (
      targetText(target.id) === key ||
      targetText(target.label) === key ||
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
  const targets = resolveTargets(args.targets || args.target);
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
  const targets = resolveTargets(args.targets || args.target);
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
      targets: TARGETS.map(target => ({
        id: target.id,
        label: target.label,
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
        targets: { type: 'array', items: { type: 'string' }, description: 'Desktop AI target ids or names. Supported: workbuddy, codex. Defaults to both.' },
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
