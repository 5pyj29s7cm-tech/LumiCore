import type { TaskComplexity } from './orchestrator';

export interface BackgroundDelegationDecisionInput {
  text: string;
  source?: string;
  category?: string;
  complexity: TaskComplexity;
  allowToolUse: boolean;
  clientActionOnly: boolean;
  clientSurfaceRequest?: boolean;
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

const WORK_CATEGORY_ALLOWLIST = new Set(['command', 'code', 'question', 'analysis']);

export function hasExplicitBackgroundDelegationPreference(text: string): boolean {
  if (BACKGROUND_APP_CONTEXT_RE.test(text) && !EXPLICIT_BACKGROUND_DELEGATION_RE.test(text)) {
    return false;
  }
  return BACKGROUND_REQUEST_PATTERNS.some(pattern => pattern.test(text));
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
  if (!WORK_CATEGORY_ALLOWLIST.has(input.category || '')) return { shouldDelegate: false, reason: 'non_work_category' };

  const explicitlyRequested = hasExplicitBackgroundDelegationPreference(input.text);
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
