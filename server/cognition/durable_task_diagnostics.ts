import { readDB } from '../../db_layer';
import type { DurableTaskRecoveryState } from './durable_task_recovery';

export interface DurableTaskDiagnosticItem {
  taskId: string;
  runtime: 'autonomous' | 'background';
  status: string;
  attempt: number;
  recoveryCount: number;
  nextAttemptAt?: string;
  failureClass?: string;
  blocker?: string;
}

export interface DurableTaskHealthSnapshot {
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
    ...((recovery?.blockedReason || task.error)
      ? { blocker: compact(recovery?.blockedReason || task.error) }
      : {}),
  };
}

export function getDurableTaskHealthSnapshot(
  userId: string,
  scope: { domain?: string; orgId?: string } = {},
): DurableTaskHealthSnapshot {
  let db: any;
  try {
    db = readDB();
  } catch {
    return {
      active: 0,
      retryScheduled: 0,
      blocked: 0,
      failed: 0,
      recent: [],
      safeAutomaticRecovery: ['reprobe_runtime_health'],
      forbiddenAutomaticRecovery: ['repeat_unknown_external_commit', 'bypass_confirmation', 'edit_runtime_code'],
    };
  }
  const isWork = scope.domain === 'work' && Boolean(scope.orgId);
  const autonomous = (Array.isArray(db.autonomousTasks) ? db.autonomousTasks : [])
    .filter((task: any) => !isWork && task.userId === userId)
    .map((task: any) => toItem(task, 'autonomous'));
  const background = (Array.isArray(db.backgroundDelegationTasks) ? db.backgroundDelegationTasks : [])
    .filter((task: any) => task.userId === userId)
    .filter((task: any) => isWork
      ? task.context?.domain === 'work' && task.context?.orgId === scope.orgId
      : task.context?.domain !== 'work' && !task.context?.orgId)
    .map((task: any) => toItem(task, 'background'));
  const items = [...autonomous, ...background];
  return {
    active: items.filter(item => ['pending', 'queued', 'running', 'pausing', 'paused'].includes(item.status)).length,
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
