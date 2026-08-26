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
  const rawBlockersPresent = Array.isArray(raw.blockers)
    && raw.blockers.some(item => typeof item === 'string' && item.trim());
  const blockers = normalizeFeedbackItems(raw.blockers);
  if ((status === 'blocked' || status === 'failed') && rawBlockersPresent && blockers.length === 0) {
    blockers.push('The requested action did not produce a verifiable result after automatic recovery.');
  }
  return {
    status,
    completed: normalizeFeedbackItems(raw.completed),
    evidence: normalizeFeedbackItems(raw.evidence),
    incomplete: normalizeFeedbackItems(raw.incomplete),
    blockers,
    nextSteps: normalizeFeedbackItems(raw.nextSteps),
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
