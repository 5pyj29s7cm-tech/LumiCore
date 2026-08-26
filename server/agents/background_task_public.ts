import type { BackgroundDelegationTask } from './background_tasks';
import { buildTaskCompletionFeedback } from '../cognition/acceptance_evidence';
import {
  redactDiagnosticSecrets,
  sanitizeDiagnosticValue,
} from '../client/diagnostic_sanitizer';

export type BackgroundTaskScope = { domain: 'personal' | 'work'; orgId: string };

function boundedText(value: unknown, limit = 700): string | undefined {
  const text = redactDiagnosticSecrets(value)
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, limit) : undefined;
}

function backgroundControls(status: string) {
  return {
    canPause: status === 'queued' || status === 'running',
    canResume: status === 'paused',
    canCancel: ['queued', 'running', 'pausing', 'paused'].includes(status),
  };
}

function publicBackgroundIssue(status: string, present: boolean): string | undefined {
  if (!present) return undefined;
  if (status === 'blocked') return 'Background task is blocked. Review the task controls or local runtime logs before retrying.';
  if (status === 'failed') return 'Background task failed. Inspect the local runtime logs before retrying.';
  return 'Background task requires attention. Inspect the local runtime logs for details.';
}

export function backgroundTaskMatchesScope(
  task: BackgroundDelegationTask,
  scope: BackgroundTaskScope,
): boolean {
  const domain = task.context?.domain === 'work' ? 'work' : 'personal';
  const orgId = domain === 'work' ? String(task.context?.orgId || '').trim() : '';
  if (scope.domain === 'work' && !scope.orgId.trim()) return false;
  if (domain === 'work' && !orgId) return false;
  return domain === scope.domain && (domain === 'personal' || orgId === scope.orgId);
}

/**
 * The only background-task shape allowed across HTTP/socket trust boundaries.
 * Prompts, model/provider configuration, policies, leases and full context are
 * intentionally absent; callers receive only bounded progress and controls.
 */
export function projectBackgroundTask(task: BackgroundDelegationTask) {
  const terminalReceipt = task.terminalReceipt;
  const title = boundedText(task.title, 240) || task.id;
  const error = publicBackgroundIssue(task.status, Boolean(task.error));
  const completionFeedback = sanitizeDiagnosticValue(buildTaskCompletionFeedback(
    terminalReceipt,
    title,
    { status: task.status, reason: error },
  ));
  return {
    id: task.id,
    kind: 'delegation' as const,
    title,
    status: task.status,
    phase: boundedText(task.checkpoint?.phase, 80),
    workerNames: task.workerNames
      .map(name => boundedText(name, 120))
      .filter((name): name is string => Boolean(name))
      .slice(0, 20),
    toolCallsCount: Math.max(0, Number(task.toolCallsCount || 0)),
    cancelRequested: task.cancelRequested || task.status === 'cancelled' || task.status === 'cancelling',
    pauseRequested: task.pauseRequested || task.status === 'pausing',
    controls: backgroundControls(task.status),
    resultPreview: boundedText(task.resultPreview),
    error,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    completionFeedback: {
      ...completionFeedback,
      blockers: completionFeedback.blockers.length
        ? [error || 'Background task is not verified complete. Inspect local runtime details.']
        : [],
    },
  };
}
