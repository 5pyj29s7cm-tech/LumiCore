import type { TaskComplexity } from './orchestrator';

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

const BACKGROUND_REQUEST_PATTERNS = [
  /后台|子\s*agent|子智能体|交给.*agent|分派|派给|不用等|不要等|慢慢做|异步|并行/u,
  /\b(background|sub-?agent|delegate|dispatch|async|parallel|don't wait|do not wait)\b/i,
];

const BACKGROUND_APP_CONTEXT_RE =
  /(?:\u540e\u53f0(?:\u6b63\u5728)?\u8fd0\u884c|\u6b63\u5728\u540e\u53f0\u8fd0\u884c|\u540e\u53f0(?:\u8fdb\u7a0b|\u7a0b\u5e8f|\u8f6f\u4ef6|\u5e94\u7528|\u7a97\u53e3|\u5fae\u4fe1|WeChat|Weixin))/iu;

const EXPLICIT_BACKGROUND_DELEGATION_RE =
  /(?:\u5b50\s*agent|\u5b50\u667a\u80fd\u4f53|\u4ea4\u7ed9.*agent|\u5206\u6d3e|\u6d3e\u7ed9|\u4e0d\u7528\u7b49|\u4e0d\u8981\u7b49|\u5f02\u6b65|\u5e76\u884c|\b(?:background\s+task|sub-?agent|delegate|dispatch|async|parallel|don't wait|do not wait)\b)/iu;

const FOREGROUND_MESSAGING_SEND_RE =
  /(?:wechat|weixin|\u5fae\u4fe1).*(?:\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u5e2e\u6211\u53d1|\u53d1\u9001|\u53d1\u7ed9|\u53d1)|(?:\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u5e2e\u6211\u53d1|\u53d1\u9001|\u53d1\u7ed9|\u53d1).*(?:wechat|weixin|\u5fae\u4fe1)|(?:\u7ed9[^\s,，。.!?！？]{1,24}\u53d1[^\n]{0,80})|(?:\u53d1[^\n]{0,80}\u7ed9[^\s,，。.!?！？]{1,24})/iu;

const SHORT_FOREGROUND_SEND_FOLLOWUP_RE =
  /^(?:\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u53d1\u5427|\u53d1\u665a\u5b89|\u76f4\u63a5\u53d1\u665a\u5b89)\s*[\s\S]{0,40}$/u;

const FOREGROUND_MESSAGING_READ_RE =
  /(?:wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f).*(?:\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u804a\u5929\u5185\u5bb9|\u804a\u5929\u8bb0\u5f55|\u603b\u7ed3)|(?:\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u603b\u7ed3).*(?:wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f)/iu;

const WORK_CATEGORY_ALLOWLIST = new Set(['command', 'code', 'question', 'analysis']);

export function hasExplicitBackgroundDelegationPreference(text: string): boolean {
  if (BACKGROUND_APP_CONTEXT_RE.test(text) && !EXPLICIT_BACKGROUND_DELEGATION_RE.test(text)) {
    return false;
  }
  return BACKGROUND_REQUEST_PATTERNS.some(pattern => pattern.test(text));
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
