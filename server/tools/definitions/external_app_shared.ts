import { EXTERNAL_APP_MESSAGES } from '../../regions/packs/cn/external_app_messages';
import { providerGetterArguments } from "../../llm/provider_getters";
import { type ToolContext } from '../types';
import { analyzeScreen } from '../../llm/adapter';
import { getUserPreferredVisionConfig, type VisionProvider } from '../../llm/vision_preferences';
import { captureWindowsUiSnapshot } from '../../external_control/windows_uia';

export function requireDesktopRelay(context?: ToolContext) {
  if (!context?.desktopRelay) {
    throw new Error('External app actions require the Lumi desktop client relay.');
  }
  return context.desktopRelay;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function parseDesktopJson(raw: string): Record<string, any> {
  try {
    return JSON.parse(String(raw || '{}'));
  } catch {
    return {};
  }
}

export function isWeChatActiveWindow(info: Record<string, any>): boolean {
  const processName = String(info.process_name || info.processName || '').toLowerCase();
  const title = String(info.title || '').toLowerCase();
  return processName === 'weixin.exe' ||
    processName === 'wechat.exe' ||
    title.includes('wechat') ||
    title.includes(EXTERNAL_APP_MESSAGES.wechatTitle);
}

export function hasVisionProvider(context?: ToolContext): { provider: VisionProvider; model: string; userId: string; maxTokens?: number } | null {
  const userId = context?.userId || 'anonymous';
  const config = getUserPreferredVisionConfig(userId, { maxTokens: 1200 });
  const getters = context?.llmGetters;
  if (!getters) return null;
  const available = (
    (config.provider === 'openai' && getters.getOpenAI?.()) ||
    (config.provider === 'gemini' && getters.getGemini?.()) ||
    (config.provider === 'ark' && getters.getArk?.()) ||
    (config.provider === 'qwen' && getters.getQwen?.()) ||
    (config.provider === 'ollama' && getters.getOllama?.()) ||
    (config.provider === 'lmstudio' && getters.getLmStudio?.()) ||
    (config.provider === 'relay' && getters.getRelay?.())
  );
  return available ? config : null;
}

export function normalizeEvidenceText(value: unknown): string {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

export async function captureDesktopUiEvidence(
  desktopRelay: NonNullable<ToolContext['desktopRelay']>,
  maxNodes: number,
): Promise<string> {
  try {
    const relayed = await desktopRelay('desktop_ui_snapshot', { maxDepth: 5, maxNodes });
    if (String(relayed || '').trim()) return String(relayed);
  } catch {
    // Older desktop clients do not expose UIA through the relay. The local
    // backend remains a compatible fallback for the on-device deployment.
  }
  return JSON.stringify(await captureWindowsUiSnapshot({ maxDepth: 5, maxNodes }), null, 2);
}

export function parseWeChatConversationReadyVerification(value: unknown): {
  ready: boolean;
  confidence: number;
  reason: string;
} {
  const raw = String(value || '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ready: false, confidence: 0, reason: raw.slice(0, 240) || 'No conversation-selection verification result.' };
  try {
    const parsed = JSON.parse(match[0]);
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0)));
    return {
      ready: parsed.ready === true && confidence >= 0.7,
      confidence,
      reason: String(parsed.reason || '').trim().slice(0, 400),
    };
  } catch {
    return { ready: false, confidence: 0, reason: raw.slice(0, 240) || 'Invalid conversation-selection verification result.' };
  }
}

export function uiSnapshotShowsWeChatConversation(snapshot: string, contact: string): boolean {
  const target = normalizeEvidenceText(contact);
  if (!snapshot || !target) return false;
  try {
    const root = JSON.parse(snapshot);
    const nodes: any[] = [];
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      nodes.push(node);
      for (const child of Array.isArray(node.children) ? node.children : []) visit(child);
    };
    visit(root?.root || root);
    const rootNode = nodes[0] || {};
    const rootBounds = rootNode.boundingRectangle || rootNode.bounds || {};
    const rootY = Number(rootBounds.y || 0);
    const rootHeight = Number(rootBounds.height || 0);
    const hasExactContact = nodes.some(node => normalizeEvidenceText(node?.name) === target);
    const hasBottomComposer = nodes.some(node => {
      if (String(node?.controlType || '').toLowerCase() !== 'edit') return false;
      const bounds = node?.boundingRectangle || node?.bounds || {};
      const y = Number(bounds.y || 0);
      const width = Number(bounds.width || 0);
      return rootHeight > 0 && y >= rootY + rootHeight * 0.52 && width >= 180;
    });
    return hasExactContact && hasBottomComposer;
  } catch {
    return false;
  }
}

export async function prepareWeChatConversation(
  args: Record<string, any>,
  context: ToolContext | undefined,
  desktopRelay: NonNullable<ToolContext['desktopRelay']>,
  readOnly = false,
) {
  const progress = (step: string) => context?.onProgress?.(step);
  const contact = String(args.contact || '').trim();
  if (/^(?:\u4ed6|\u5979|\u5b83|\u5bf9\u65b9|\u90a3\u4e2a\u4eba|\u8fd9\u4e2a\u4eba)$/u.test(contact)) {
    throw new Error('Recipient pronoun could not be resolved to a concrete WeChat contact. No search or send was attempted.');
  }
  const useSearch = args.useSearch !== false && Boolean(contact);
  progress(EXTERNAL_APP_MESSAGES.reusingWindow);
  const openResult = await desktopRelay('desktop_open', { target: String(args.applicationTarget || 'wechat').trim() || 'wechat' });
  await sleep(450);
  let activeWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
  if (!isWeChatActiveWindow(activeWindow)) {
    await sleep(600);
    activeWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
  }
  if (!isWeChatActiveWindow(activeWindow)) {
    throw new Error(`WeChat is not the foreground window after opening. Active window: ${JSON.stringify(activeWindow).slice(0, 300)}`);
  }
  if (useSearch) {
    progress(EXTERNAL_APP_MESSAGES.locatingChat(contact));
    await desktopRelay('desktop_clipboard_write', { text: contact });
    await desktopRelay('desktop_keyboard_press', { key: 'ctrl+f' });
    await sleep(250);
    await desktopRelay('desktop_keyboard_press', { key: 'ctrl+v' });
    await sleep(450);
    await desktopRelay('desktop_keyboard_press', { key: 'enter' });
    await sleep(readOnly ? 750 : 650);
    activeWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
    if (!isWeChatActiveWindow(activeWindow)) {
      throw new Error(`Contact search did not leave WeChat in the foreground. Active window: ${JSON.stringify(activeWindow).slice(0, 300)}`);
    }
  }
  if (!readOnly && contact) {
    // Search success and a foreground process are not proof of the intended recipient.
    let snapshot = '';
    try { snapshot = await captureDesktopUiEvidence(desktopRelay, 240); } catch {}
    let ready = uiSnapshotShowsWeChatConversation(snapshot, contact);
    let reason = ready ? 'The UI snapshot contains the requested contact and a conversation composer.'
      : 'The UI snapshot did not prove that the requested conversation was open.';
    const vision = hasVisionProvider(context);
    if (vision) {
      try {
        const verification = parseWeChatConversationReadyVerification(await analyzeScreen(
          await desktopRelay('desktop_capture_screen', { quality: 75 }),
          [
            'Verify the current foreground WeChat state before any message is entered.',
            `Expected exact recipient/group: ${JSON.stringify(contact)}.`,
            'Set ready=true only when that exact conversation is visibly open and its message composer is available.',
            'A contact search box, search-result list, a different conversation, or an ambiguous header must return ready=false.',
            'Return only JSON: {"ready":boolean,"confidence":number,"reason":"short visible evidence"}.',
          ].join('\n'),
          vision, ...providerGetterArguments(context?.llmGetters),
        ));
        ready = verification.ready;
        reason = verification.reason || reason;
      } catch (err: any) {
        ready = false;
        reason = err?.message || String(err);
      }
    }
    if (!ready) throw new Error(`The requested WeChat conversation was not verified after contact search. ${reason}`);
  }
  return { contact, useSearch, openResult, activeWindow };
}
