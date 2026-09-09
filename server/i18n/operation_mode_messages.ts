import type { OperationMode } from '../cognition/operation_modes';

const HAN_RE = /[\u3400-\u9fff]/u;

const ENGLISH_MODE_LABELS: Record<OperationMode, string> = {
  chat: 'Lumi',
  assistant: 'Lumi',
  autonomous: 'Lumi',
  meeting: 'Meeting mode',
};

const CHINESE_MODE_LABELS: Record<OperationMode, string> = {
  chat: 'Lumi',
  assistant: 'Lumi',
  autonomous: 'Lumi',
  meeting: '会议模式',
};

export function formatOperationModeSwitchResponse(
  mode: OperationMode,
  synced: boolean,
  userText: string,
): string {
  if (mode !== 'meeting') return HAN_RE.test(userText)
    ? 'Lumi 的对话、办事和学习共用一个核心，无需切换模式。'
    : 'Lumi uses one core for conversation, tasks and learning; no mode switch is needed.';
  if (HAN_RE.test(userText)) {
    const label = CHINESE_MODE_LABELS[mode];
    return synced
      ? `已切到${label}。`
      : `我收到了切换到${label}的请求，但客户端还没有完成切换。`;
  }

  const label = ENGLISH_MODE_LABELS[mode];
  return synced
    ? `Switched to ${label}.`
    : `I received the request to switch to ${label}, but the client did not complete the change.`;
}
