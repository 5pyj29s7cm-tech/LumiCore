import type { TaskComplexity } from './orchestrator';
import { CN_BACKGROUND_DELEGATION_MESSAGES } from '../regions/packs/cn/background_delegation_messages';

export interface BackgroundDelegationDecisionInput {
  text: string;
  source?: string;
  category?: string;
  complexity: TaskComplexity;
  allowToolUse: boolean;
  clientActionOnly: boolean;
  clientSurfaceRequest?: boolean;
  continuationContext?: boolean;
  selfRepair: boolean;
  sanctuary: boolean;
  directDesktop: boolean;
  prefersSequentialWorkflow: boolean;
  availableAgentCount: number;
}

export interface BackgroundDelegationDecision {
  shouldDelegate: boolean;
  reason: string;
}

const BACKGROUND_APP_CONTEXT_RE =
  /(?:\u540e\u53f0(?:\u6b63\u5728)?\u8fd0\u884c|\u6b63\u5728\u540e\u53f0\u8fd0\u884c|\u540e\u53f0(?:\u8fdb\u7a0b|\u7a0b\u5e8f|\u8f6f\u4ef6|\u5e94\u7528|\u7a97\u53e3|\u5fae\u4fe1|WeChat|Weixin))/iu;

const EXPLICIT_BACKGROUND_DELEGATION_RE =
  /(?:\u5b50\s*agent|\u5b50\u667a\u80fd\u4f53|\u4ea4\u7ed9.*agent|\u5206\u6d3e|\u6d3e\u7ed9|\u4e0d\u7528\u7b49|\u4e0d\u8981\u7b49|\u5f02\u6b65|\u5e76\u884c|\b(?:background\s+task|sub-?agent|delegate|dispatch|async|parallel|don't wait|do not wait)\b)/iu;

// Mentioning "后台" is not itself a delegation command. Users also use the
// word when asking what Lumi just did or when inspecting background apps.
const BACKGROUND_DELEGATION_ACTION_RE =
  /(?:\u653e\u5230|\u653e\u5728|\u8f6c\u5230|\u4ea4\u7ed9|\u4e22\u5230|\u8ba9[^\u3002\uff01\uff1f.!?\n]{0,20}\u5728|\u53bb)\u540e\u53f0(?:\u7ee7\u7eed|\u8fd0\u884c|\u5904\u7406|\u6267\u884c|\u505a|\u67e5|\u8dd1|\u5b8c\u6210|\u76ef|\u76d1\u63a7)?|\u540e\u53f0(?:\u7ee7\u7eed|\u5904\u7406|\u6267\u884c|\u505a|\u67e5|\u8dd1|\u5b8c\u6210|\u76ef|\u76d1\u63a7)(?:\u8fd9\u4e2a|\u4e00\u4e0b|\u4efb\u52a1|\u5de5\u4f5c)?|\b(?:run|continue|handle|execute|finish|monitor)\b[^.!?\n]{0,32}\bin\s+the\s+background\b/iu;

const BACKGROUND_META_INQUIRY_RE =
  /(?:\u521a\u624d|\u521a\u521a|\u4e4b\u524d|\u4e0a\u4e00\u8f6e|\u662f\u4e0d\u662f|\u662f\u5426|\u4e3a\u4ec0\u4e48|\u600e\u4e48|\u600e\u4e48\u56de\u4e8b)[^\u3002\uff01\uff1f.!?\n]{0,80}\u540e\u53f0|\u540e\u53f0[^\u3002\uff01\uff1f.!?\n]{0,80}(?:\u5417|\u4e48|\u4e3a\u4ec0\u4e48|\u600e\u4e48|\u600e\u4e48\u56de\u4e8b|\u4e0d\u56de|\u6ca1\u56de|\u4e0d\u7406|\u5361\u4f4f)|\b(?:were|was|are)\b[^.!?\n]{0,40}\b(?:you|lumi)\b[^.!?\n]{0,40}\bbackground\b/iu;

const FOREGROUND_MESSAGING_SEND_RE =
  /(?:wechat|weixin|\u5fae\u4fe1).*(?:\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u5e2e\u6211\u53d1|\u53d1\u9001|\u53d1\u7ed9|\u53d1)|(?:\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u5e2e\u6211\u53d1|\u53d1\u9001|\u53d1\u7ed9|\u53d1).*(?:wechat|weixin|\u5fae\u4fe1)|(?:\u7ed9[^\s,，。.!?！？]{1,24}\u53d1[^\n]{0,80})|(?:\u53d1[^\n]{0,80}\u7ed9[^\s,，。.!?！？]{1,24})/iu;

const SHORT_FOREGROUND_SEND_FOLLOWUP_RE =
  /^(?:\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u53d1\u5427|\u53d1\u665a\u5b89|\u76f4\u63a5\u53d1\u665a\u5b89)\s*[\s\S]{0,40}$/u;

const FOREGROUND_MESSAGING_READ_RE =
  /(?:wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f).*(?:\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u804a\u5929\u5185\u5bb9|\u804a\u5929\u8bb0\u5f55|\u603b\u7ed3)|(?:\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u603b\u7ed3).*(?:wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f)/iu;

const WORK_CATEGORY_ALLOWLIST = new Set(['command', 'code', 'question', 'analysis']);

export function hasExplicitBackgroundDelegationPreference(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (BACKGROUND_META_INQUIRY_RE.test(normalized)) return false;
  if (BACKGROUND_APP_CONTEXT_RE.test(normalized) && !EXPLICIT_BACKGROUND_DELEGATION_RE.test(normalized)) {
    return false;
  }
  return EXPLICIT_BACKGROUND_DELEGATION_RE.test(normalized)
    || BACKGROUND_DELEGATION_ACTION_RE.test(normalized);
}

export function isBackgroundMetaInquiry(text: string): boolean {
  return BACKGROUND_META_INQUIRY_RE.test(String(text || '').trim());
}

function isBackgroundAppInspection(text: string): boolean {
  const normalized = String(text || '').trim();
  return BACKGROUND_APP_CONTEXT_RE.test(normalized)
    && !hasExplicitBackgroundDelegationPreference(normalized);
}

export function isForegroundMessagingSend(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (/(?:\u8349\u7a3f|\u5148\u5199|\u7f16\u8f91\u4e00\u4e0b|\u4e0d\u8981\u53d1|\bdraft\b)/iu.test(normalized)) return false;
  return FOREGROUND_MESSAGING_SEND_RE.test(normalized) || SHORT_FOREGROUND_SEND_FOLLOWUP_RE.test(normalized);
}

export function isForegroundMessagingRead(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (isForegroundMessagingSend(normalized)) return false;
  return FOREGROUND_MESSAGING_READ_RE.test(normalized);
}

export function shouldDelegateWorkInBackground(input: BackgroundDelegationDecisionInput): BackgroundDelegationDecision {
  if (!input.text.trim()) return { shouldDelegate: false, reason: 'empty_text' };
  if (!input.allowToolUse) return { shouldDelegate: false, reason: 'tools_disabled' };
  if (input.clientActionOnly) return { shouldDelegate: false, reason: 'client_action_only' };
  if (input.clientSurfaceRequest) return { shouldDelegate: false, reason: 'client_surface_foreground' };
  if (input.selfRepair) return { shouldDelegate: false, reason: 'self_repair' };
  if (input.sanctuary) return { shouldDelegate: false, reason: 'sanctuary_agent' };
  if (input.directDesktop) return { shouldDelegate: false, reason: 'direct_desktop_visible_work' };
  if (input.prefersSequentialWorkflow) return { shouldDelegate: false, reason: 'artifact_first_sequential_workflow' };
  if (isBackgroundMetaInquiry(input.text)) return { shouldDelegate: false, reason: 'background_meta_inquiry' };
  if (isBackgroundAppInspection(input.text)) return { shouldDelegate: false, reason: 'background_app_inspection' };
  if (input.availableAgentCount < 1) return { shouldDelegate: false, reason: 'no_available_workers' };
  if (isForegroundMessagingRead(input.text)) return { shouldDelegate: false, reason: 'foreground_messaging_read' };
  if (isForegroundMessagingSend(input.text)) return { shouldDelegate: false, reason: 'foreground_messaging_send' };
  if (!WORK_CATEGORY_ALLOWLIST.has(input.category || '')) return { shouldDelegate: false, reason: 'non_work_category' };

  const explicitlyRequested = hasExplicitBackgroundDelegationPreference(input.text);
  if (input.continuationContext && !explicitlyRequested) {
    return { shouldDelegate: false, reason: 'foreground_task_continuation' };
  }
  if (explicitlyRequested) return { shouldDelegate: true, reason: 'explicit_background_preference' };
  if (input.complexity === 'complex' || input.complexity === 'moderate') {
    return { shouldDelegate: true, reason: `work_complexity_${input.complexity}` };
  }

  return { shouldDelegate: false, reason: 'simple_foreground_chat' };
}

export function buildDelegationAck(workerNames: string[], taskId: string): string {
  const names = workerNames.slice(0, 3).filter(Boolean);
  const workerLine = names.length > 0
    ? `我先交给 ${names.join('、')} 这些子 agent 在后台处理。`
    : '我先交给后台子 agent 处理。';
  return [
    `${workerLine}你不用等在这里，我会继续和你聊天。`,
    `后台任务号：${taskId}。有阶段结果或最终结果时，我会直接推回来。`,
  ].join('\n');
}

export function formatBackgroundDelegationFailure(error: unknown, chinese = true): string {
  const detail = error instanceof Error ? error.message : String(error || '');
  if (/No worker agent accepted|no available (?:worker|agent)|no agents? are available/i.test(detail)) {
    return chinese
      ? CN_BACKGROUND_DELEGATION_MESSAGES.noWorker
      : 'No background worker is available, so the task did not start. I can continue it in the current conversation.';
  }
  if (/cancelled|canceled/i.test(detail)) {
    return chinese ? CN_BACKGROUND_DELEGATION_MESSAGES.cancelled : 'The background task was cancelled.';
  }
  return chinese
    ? CN_BACKGROUND_DELEGATION_MESSAGES.failed(detail)
    : `The background task did not complete: ${detail || 'the execution path returned no result'}.`;
}
