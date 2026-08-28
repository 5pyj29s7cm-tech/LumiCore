import { redactDiagnosticSecrets } from '../client/diagnostic_sanitizer';
import type { TaskCompletionFeedback } from '../cognition/acceptance_evidence';
import { sanitizeExecutionDiagnosticForPublicFeedback } from '../cognition/execution_guard_recovery';

export type { TaskCompletionFeedback } from '../cognition/acceptance_evidence';

const COMPLETION_FEEDBACK_STATUSES = new Set<TaskCompletionFeedback['status']>([
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'working',
  'unknown',
]);

const MAX_COMPLETION_FEEDBACK_ITEMS = 8;
const MAX_COMPLETION_FEEDBACK_ITEM_CHARS = 500;

// Completion evidence is deliberately richer inside the acceptance ledger.
// None of its protocol vocabulary belongs in chat history or a user-facing
// task card. The public projection below keeps only status-level semantics and
// a genuinely human blocker when one exists.
const INTERNAL_PUBLIC_FEEDBACK_RE = /(?:\b(?:desktop|execution)_[a-z0-9_]+\b|\b(?:verified|observed|terminal)\s+(?:tool|action)?\s*receipts?\b|\btool\s+(?:name|receipt|execution)\b|\bverified terminal evidence\b|\bmachine[- ]verified\b|\bterminal machine receipt\b|\bpreserved receipt ledger\b|\bproviderTrace\b)/iu;
const GENERATED_TASK_LABEL_RE = /(?:completed with verified terminal evidence|is not verified complete|is waiting for confirmation|is still running in the background)\.?$/iu;
const SNAKE_CASE_PROTOCOL_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/u;

type FeedbackSection = 'completed' | 'evidence' | 'incomplete' | 'blockers' | 'nextSteps';

function feedbackUsesChinese(raw: Record<string, unknown>): boolean {
  return ['completed', 'evidence', 'incomplete', 'blockers', 'nextSteps']
    .flatMap(key => Array.isArray(raw[key]) ? raw[key] as unknown[] : [])
    .some(item => typeof item === 'string' && /[\u3400-\u9fff]/u.test(item));
}

function publicStatusItem(
  section: FeedbackSection,
  status: TaskCompletionFeedback['status'],
  chinese: boolean,
): string {
  if (chinese) {
    // i18n-allow -- compact server-owned public feedback for Chinese chat.
    if (section === 'completed') return status === 'working' ? '已保留当前进度。' : '任务已完成。';
    // i18n-allow -- compact server-owned public feedback for Chinese chat.
    if (section === 'evidence') return '已记录当前执行结果。';
    // i18n-allow -- compact server-owned public feedback for Chinese chat.
    if (section === 'incomplete') {
      if (status === 'cancelled') return '任务已取消。';
      // i18n-allow -- compact server-owned public feedback for Chinese chat.
      if (status === 'working') return '任务仍在进行中。';
      // i18n-allow -- compact server-owned public feedback for Chinese chat.
      return '任务尚未完成。';
    }
    // i18n-allow -- compact server-owned public feedback for Chinese chat.
    if (section === 'blockers') return '当前步骤未能完成。';
    // i18n-allow -- compact server-owned public feedback for Chinese chat.
    if (status === 'completed' || status === 'cancelled') return '无需后续操作。';
    // i18n-allow -- compact server-owned public feedback for Chinese chat.
    return status === 'working' ? '按当前进度继续即可。' : '处理当前阻塞后可继续。';
  }
  if (section === 'completed') return status === 'working' ? 'Current progress was preserved.' : 'The task is complete.';
  if (section === 'evidence') return 'The current execution result was recorded.';
  if (section === 'incomplete') {
    if (status === 'cancelled') return 'The task was cancelled.';
    if (status === 'working') return 'The task is still in progress.';
    return 'The task is not complete yet.';
  }
  if (section === 'blockers') return 'The current step could not be completed.';
  if (status === 'completed' || status === 'cancelled') return 'No further action is needed.';
  return status === 'working' ? 'Continue from the current progress.' : 'Resolve the current blocker, then continue.';
}

function normalizeFeedbackItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .filter((item): item is string => typeof item === 'string')
    .map(item => sanitizeExecutionDiagnosticForPublicFeedback(redactDiagnosticSecrets(item))
      .replace(/\0/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_COMPLETION_FEEDBACK_ITEM_CHARS))
    .filter(Boolean);
  return Array.from(new Set(normalized)).slice(0, MAX_COMPLETION_FEEDBACK_ITEMS);
}

function normalizePublicNarrativeItems(value: unknown): string[] {
  return normalizeFeedbackItems(value).filter(item => (
    !INTERNAL_PUBLIC_FEEDBACK_RE.test(item)
    && !GENERATED_TASK_LABEL_RE.test(item)
    && !SNAKE_CASE_PROTOCOL_RE.test(item)
  ));
}

/**
 * Allowlist the small user-facing task summary persisted with one assistant
 * interaction. Arbitrary nested objects, tool inputs and provider metadata are
 * deliberately discarded; diagnostic strings are bounded and secret-redacted.
 */
export function normalizeCompletionFeedbackForPersistence(
  value: unknown,
): TaskCompletionFeedback | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const status = String(raw.status || '').trim().toLowerCase() as TaskCompletionFeedback['status'];
  if (!COMPLETION_FEEDBACK_STATUSES.has(status)) return undefined;
  const chinese = feedbackUsesChinese(raw);
  const rawCompletedPresent = Array.isArray(raw.completed)
    && raw.completed.some(item => typeof item === 'string' && item.trim());
  const rawEvidencePresent = Array.isArray(raw.evidence)
    && raw.evidence.some(item => typeof item === 'string' && item.trim());
  const rawIncompletePresent = Array.isArray(raw.incomplete)
    && raw.incomplete.some(item => typeof item === 'string' && item.trim());
  const rawBlockersPresent = Array.isArray(raw.blockers)
    && raw.blockers.some(item => typeof item === 'string' && item.trim());
  const blockers = normalizePublicNarrativeItems(raw.blockers);
  if ((status === 'blocked' || status === 'failed') && rawBlockersPresent && blockers.length === 0) {
    blockers.push(publicStatusItem('blockers', status, chinese));
  }
  const rawNextStepsPresent = Array.isArray(raw.nextSteps)
    && raw.nextSteps.some(item => typeof item === 'string' && item.trim());
  return {
    status,
    completed: rawCompletedPresent
      ? [publicStatusItem('completed', status, chinese)]
      : [],
    evidence: rawEvidencePresent
      ? [publicStatusItem('evidence', status, chinese)]
      : [],
    incomplete: rawIncompletePresent
      ? [publicStatusItem('incomplete', status, chinese)]
      : [],
    blockers,
    nextSteps: rawNextStepsPresent
      ? [publicStatusItem('nextSteps', status, chinese)]
      : [],
  };
}

export function serializeCompletionFeedbackForPersistence(value: unknown): string {
  const normalized = normalizeCompletionFeedbackForPersistence(value);
  return normalized ? JSON.stringify(normalized) : '';
}

export function parseCompletionFeedbackFromPersistence(
  value: unknown,
): TaskCompletionFeedback | undefined {
  let parsed = value;
  if (typeof parsed === 'string') {
    if (!parsed.trim()) return undefined;
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  return normalizeCompletionFeedbackForPersistence(parsed);
}
