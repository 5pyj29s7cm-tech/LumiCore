import { listScopedConversationTaskDiagnostics } from '../conversation/history_repository';
import { listPersistedAutonomousTasks } from '../autonomy/task_queue';
import { projectAutonomousTaskFinalization } from '../autonomy/task_finalization';
import type { DurableTaskRecoveryState } from './durable_task_recovery';

export interface DurableTaskDiagnosticItem {
  taskId: string;
  runtime: 'autonomous' | 'conversation';
  status: string;
  attempt: number;
  recoveryCount: number;
  nextAttemptAt?: string;
  failureClass?: string;
  blocker?: string;
}

export interface DurableTaskHealthSnapshot {
  available: boolean;
  diagnostics: string[];
  paused: number;
  active: number;
  retryScheduled: number;
  blocked: number;
  failed: number;
  recent: DurableTaskDiagnosticItem[];
  safeAutomaticRecovery: string[];
  forbiddenAutomaticRecovery: string[];
}

function compact(value: unknown, limit = 300): string {
  return String(value || '')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret))\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function toItem(task: any, runtime: DurableTaskDiagnosticItem['runtime']): DurableTaskDiagnosticItem {
  const recovery = task.recovery as DurableTaskRecoveryState | undefined;
  const diagnosis = recovery?.diagnoses?.at(-1);
  return {
    taskId: compact(task.id, 180),
    runtime,
    status: compact(task.status, 40),
    attempt: Number(task.attempt) || 0,
    recoveryCount: Number(task.recoveryCount) || 0,
    ...(task.nextAttemptAt ? { nextAttemptAt: compact(task.nextAttemptAt, 80) } : {}),
    ...(diagnosis?.failureClass ? { failureClass: diagnosis.failureClass } : {}),
    ...((recovery?.blockedReason || task.blocker || task.error)
      ? { blocker: compact(recovery?.blockedReason || task.blocker || task.error) }
      : {}),
  };
}

export function getDurableTaskHealthSnapshot(
  userId: string,
  scope: { domain?: string; orgId?: string } = {},
): DurableTaskHealthSnapshot {
  const diagnostics: string[] = [];
  const items: DurableTaskDiagnosticItem[] = [];
  const domain = scope.domain === 'work' ? 'work' : 'personal';
  const orgId = domain === 'work' ? String(scope.orgId || '') : '';
  if (domain === 'work' && !orgId) diagnostics.push('invalid_work_scope');
  else {
    if (domain === 'personal') try {
      items.push(...listPersistedAutonomousTasks(userId).map(task => toItem(projectAutonomousTaskFinalization(task), 'autonomous')));
    } catch { diagnostics.push('autonomous_tasks_unavailable'); }
    try {
      items.push(...listScopedConversationTaskDiagnostics(userId, domain, orgId).map(task => toItem(task, 'conversation')));
    } catch { diagnostics.push('conversation_tasks_unavailable'); }
  }
  return {
    available: diagnostics.length === 0,
    diagnostics,
    paused: items.filter(item => item.status === 'paused').length,
    active: items.filter(item => ['pending', 'queued', 'running', 'executing', 'waiting_confirmation', 'pausing'].includes(item.status)).length,
    retryScheduled: items.filter(item => Boolean(item.nextAttemptAt) && ['pending', 'queued'].includes(item.status)).length,
    blocked: items.filter(item => item.status === 'blocked').length,
    failed: items.filter(item => item.status === 'failed').length,
    recent: items.slice(-20).reverse(),
    safeAutomaticRecovery: [
      'retry_read_only_or_test_after_backoff',
      'resume_verified_receipts',
      'refresh_client_state',
      'reprobe_runtime_health',
    ],
    forbiddenAutomaticRecovery: [
      'repeat_unknown_external_commit',
      'replay_unverified_side_effect',
      'bypass_confirmation_or_policy',
      'edit_runtime_code_or_credentials',
    ],
  };
}
