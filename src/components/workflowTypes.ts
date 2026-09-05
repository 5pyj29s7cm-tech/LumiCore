import type { Locale } from '@/i18n/runtime';
import { taskCompletionFeedbackCopy } from '@/i18n/locales/taskCompletionFeedback';
import {
  hasInternalAgentExecutionDetail,
  sanitizeAgentResponseTextForDisplay,
} from '@/lib/agentResponseDelivery';

export interface WorkflowStep {
  id: string;
  type: 'thinking' | 'background' | 'confirmation' | 'tool_start' | 'tool_result' | 'response' | 'error';
  text: string;
  time: number;
  detail?: string;
}

export type TaskCompletionFeedbackStatus =
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'working'
  | 'unknown';

export interface TaskCompletionFeedback {
  status: TaskCompletionFeedbackStatus;
  completed: string[];
  evidence: string[];
  incomplete: string[];
  blockers: string[];
  nextSteps: string[];
}

const TASK_COMPLETION_FEEDBACK_STATUSES = new Set<TaskCompletionFeedbackStatus>([
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'working',
  'unknown',
]);

function feedbackItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map(item => String(item || '').replace(/\s+/g, ' ').trim().slice(0, 700))
    .filter(Boolean)))
    .slice(0, 20);
}

// Machine-owned lifecycle fields stay available on the task/receipt objects,
// but their values are not suitable as customer prose.
const MACHINE_EXECUTION_DETAIL_RE = /(?:\b(?:toolName|taskId|requestId|targetIdentity|idempotencyKey|checkpoint|reasonCode|terminalVerification)\b\s*[:=]?|\b(?:desktop|mcp)_[a-z0-9_]+\b|\btarget_mismatch\b|\b(?:tool|receipt|arguments?|result|error|blocker|reason|phase)\s*[:=]|[a-z][a-z0-9-]*(?:_[a-z0-9-]+){1,}|(?:[a-z]:\\|\\\\)[^\s]+)/iu;

function compactCustomerText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 700);
}

export function customerVisibleTaskStatus(value: unknown, locale: Locale): string {
  const copy = taskCompletionFeedbackCopy(locale);
  const status = String(value || '').trim().toLowerCase();
  if (status === 'waiting_confirmation' || status === 'waiting_for_confirmation') return copy.awaitingConfirmation;
  if (['active', 'pending', 'queued', 'created', 'planning', 'running', 'working', 'executing', 'verifying', 'pausing', 'cancelling'].includes(status)) return copy.status.working;
  if (status === 'paused') return copy.status.paused;
  if (status === 'completed' || status === 'complete' || status === 'verified' || status === 'verified_success') return copy.status.completed;
  if (status === 'blocked') return copy.status.blocked;
  if (status === 'failed' || status === 'error' || status === 'timeout' || status === 'target_mismatch') return copy.status.failed;
  if (status === 'cancelled' || status === 'canceled') return copy.status.cancelled;
  return copy.status.unknown;
}

export function customerVisibleTaskBlocker(value: unknown, locale: Locale): string {
  const raw = compactCustomerText(value);
  if (!raw) return '';
  const sanitized = sanitizeAgentResponseTextForDisplay(raw, locale);
  if (
    sanitized
    && !hasInternalAgentExecutionDetail(sanitized)
    && !MACHINE_EXECUTION_DETAIL_RE.test(sanitized)
  ) return sanitized;
  // A backend blocker can contain provider errors, paths, tool names, or
  // verifier prose even when it does not match a known diagnostic code. The
  // assistant reply owns the detailed explanation; this panel only signals
  // the actionable customer state.
  return taskCompletionFeedbackCopy(locale).attentionHint;
}

export function customerVisibleTaskNextAction(value: unknown, locale: Locale): string {
  return customerVisibleTaskDetail(
    value,
    locale,
    taskCompletionFeedbackCopy(locale).nextAction,
  );
}

export function customerVisibleTaskDetail(
  value: unknown,
  locale: Locale,
  fallback: string,
): string {
  const raw = compactCustomerText(value);
  if (!raw) return '';
  const sanitized = sanitizeAgentResponseTextForDisplay(raw, locale);
  if (
    !sanitized
    || hasInternalAgentExecutionDetail(sanitized)
    || MACHINE_EXECUTION_DETAIL_RE.test(sanitized)
  ) return fallback;
  return sanitized;
}

export function projectTaskCompletionFeedbackForCustomer(
  value: unknown,
  locale: Locale,
): TaskCompletionFeedback | undefined {
  const normalized = normalizeTaskCompletionFeedback(value);
  if (!normalized) return undefined;
  const copy = taskCompletionFeedbackCopy(locale);
  const project = (items: string[], fallback: string) => Array.from(new Set(items
    .map(item => customerVisibleTaskDetail(item, locale, fallback))
    .filter(Boolean)));
  return {
    status: normalized.status,
    completed: project(normalized.completed, copy.status.completed),
    // Receipt/tool rows are intentionally summarized. Counts remain useful,
    // while raw tool names, arguments, targets, and verifier codes do not.
    evidence: normalized.evidence.length > 0
      ? [copy.verificationSummary(normalized.evidence.length)]
      : [],
    incomplete: project(normalized.incomplete, copy.attentionHint),
    blockers: normalized.blockers.length > 0
      ? [customerVisibleTaskBlocker(normalized.blockers[0], locale)]
      : [],
    nextSteps: project(normalized.nextSteps, copy.nextAction),
  };
}

export function normalizeTaskCompletionFeedback(value: unknown): TaskCompletionFeedback | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const rawStatus = String(record.status || '').trim().toLowerCase() as TaskCompletionFeedbackStatus;
  const hasFeedbackShape = Boolean(rawStatus)
    || ['completed', 'evidence', 'incomplete', 'blockers', 'nextSteps'].some(key => Array.isArray(record[key]));
  if (!hasFeedbackShape) return undefined;
  return {
    status: TASK_COMPLETION_FEEDBACK_STATUSES.has(rawStatus) ? rawStatus : 'unknown',
    completed: feedbackItems(record.completed),
    evidence: feedbackItems(record.evidence),
    incomplete: feedbackItems(record.incomplete),
    blockers: feedbackItems(record.blockers),
    nextSteps: feedbackItems(record.nextSteps),
  };
}

export interface WorkflowTask {
  id: string;
  title?: string;
  status: 'queued' | 'running' | 'pausing' | 'paused' | 'cancelling' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  toolCallsCount?: number;
  error?: string;
  resultPreview?: string;
  updatedAt?: string;
  completionFeedback?: TaskCompletionFeedback;
}
