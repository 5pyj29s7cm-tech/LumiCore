import { randomUUID } from 'crypto';
import { readDB, writeDB } from '../../db_layer';
import type { TaskComplexity } from './orchestrator';
import type { ToolPolicy } from '../personality/types';
import type { UserLLMFallbackCandidate } from '../llm/user_preferences';
import {
  diagnoseDurableTaskFailure,
  evaluateDurableResumeSafety,
  isDurableTaskReady,
  snapshotDurableToolRecords,
  updateDurableTaskRecovery,
  type DiagnoseDurableTaskFailureInput,
  type DurableTaskReceiptSnapshot,
  type DurableTaskRecoveryState,
} from '../cognition/durable_task_recovery';
import {
  buildTaskTerminalReceipt,
  validateCompletionTerminalReceipt,
  type TaskTerminalReceipt,
} from '../cognition/acceptance_evidence';

export type BackgroundDelegationStatus =
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export interface BackgroundDelegationWorker {
  id?: string;
  name: string;
  category?: string;
}

/**
 * Only execution metadata belongs here. Tool results remain in the unified
 * action receipt ledger and are referenced by task/action ids in this context.
 */
export interface BackgroundDelegationContext {
  conversationId?: string;
  conversationAgentId?: string;
  personalityId?: string;
  domain?: 'personal' | 'work';
  orgId?: string;
  sourceRequestId?: string;
  interactionId?: string;
  actionTaskId?: string;
  provider?: string;
  model?: string;
  selectionMode?: 'pinned' | 'ordered_fallback' | 'auto';
  fallbackCandidates?: UserLLMFallbackCandidate[];
  allowCloudFallback?: boolean;
  /** Durable privacy contract captured when the delegation was registered. */
  dataRoutingPolicy?: 'policy_scoped' | 'local_only';
  forceOrchestration?: boolean;
  toolPolicy?: ToolPolicy;
}

export interface BackgroundDelegationCheckpoint {
  phase: string;
  completedNodeIds?: string[];
  receiptIds?: string[];
  /** Redacted machine evidence used to prevent unsafe replay after restart. */
  receipts?: DurableTaskReceiptSnapshot[];
  detail?: string;
  updatedAt: string;
}

export interface BackgroundDelegationTask {
  id: string;
  userId: string;
  title: string;
  prompt: string;
  status: BackgroundDelegationStatus;
  reason?: string;
  complexity?: TaskComplexity;
  workers: BackgroundDelegationWorker[];
  workerNames: string[];
  context?: BackgroundDelegationContext;
  checkpoint?: BackgroundDelegationCheckpoint;
  idempotencyKey: string;
  toolCallsCount: number;
  cancelRequested: boolean;
  pauseRequested: boolean;
  attempt: number;
  recoveryCount: number;
  nextAttemptAt?: string;
  recovery?: DurableTaskRecoveryState;
  /** Unified terminal acceptance receipt. Completed tasks require a verified receipt. */
  terminalReceipt?: TaskTerminalReceipt;
  leaseId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  lastRecoveredAt?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  pausedAt?: string;
  resultPreview?: string;
  error?: string;
}

interface RegisterBackgroundTaskInput {
  id?: string;
  userId: string;
  title: string;
  prompt: string;
  reason?: string;
  complexity?: TaskComplexity;
  workers?: BackgroundDelegationWorker[];
  context?: BackgroundDelegationContext;
  idempotencyKey?: string;
}

export interface BackgroundTaskLeaseInput {
  leaseId?: string;
  owner?: string;
  durationMs?: number;
}

const tasks = new Map<string, BackgroundDelegationTask>();
const MAX_TERMINAL_TASKS = 200;
const DEFAULT_LEASE_MS = 45_000;
const RUNTIME_OWNER = `lumi:${process.pid}:${randomUUID()}`;
let hydrated = false;

function nowIso(): string {
  return new Date().toISOString();
}

function cloneTask(task: BackgroundDelegationTask): BackgroundDelegationTask {
  return {
    ...task,
    workers: task.workers.map(worker => ({ ...worker })),
    workerNames: [...task.workerNames],
    context: task.context ? {
      ...task.context,
      fallbackCandidates: task.context.fallbackCandidates?.map(candidate => ({ ...candidate })),
      toolPolicy: task.context.toolPolicy ? {
        ...task.context.toolPolicy,
        allowedTools: [...task.context.toolPolicy.allowedTools],
        requireConfirmation: [...task.context.toolPolicy.requireConfirmation],
        forbiddenTools: [...task.context.toolPolicy.forbiddenTools],
        securityOverrides: task.context.toolPolicy.securityOverrides
          ? { ...task.context.toolPolicy.securityOverrides }
          : undefined,
      } : undefined,
    } : undefined,
    checkpoint: task.checkpoint ? {
      ...task.checkpoint,
      completedNodeIds: [...(task.checkpoint.completedNodeIds || [])],
      receiptIds: [...(task.checkpoint.receiptIds || [])],
      receipts: task.checkpoint.receipts?.map(receipt => ({
        ...receipt,
        sideEffects: (receipt.sideEffects || []).map(effect => ({ ...effect })),
      })),
    } : undefined,
    recovery: task.recovery ? JSON.parse(JSON.stringify(task.recovery)) : undefined,
    terminalReceipt: task.terminalReceipt ? {
      ...task.terminalReceipt,
      evidenceRefs: [...task.terminalReceipt.evidenceRefs],
      toolNames: [...task.terminalReceipt.toolNames],
      workerIds: [...task.terminalReceipt.workerIds],
    } : undefined,
  };
}

function isTerminal(status: BackgroundDelegationStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'blocked' || status === 'cancelled';
}

function clearLease(task: BackgroundDelegationTask): void {
  task.leaseId = undefined;
  task.leaseOwner = undefined;
  task.leaseExpiresAt = undefined;
  task.heartbeatAt = undefined;
}

function hasLiveLease(task: BackgroundDelegationTask, leaseId?: string): boolean {
  if (!leaseId) return true;
  return task.status === 'running'
    && task.leaseId === leaseId
    && Boolean(task.leaseExpiresAt)
    && new Date(task.leaseExpiresAt!).getTime() > Date.now();
}

function normalizeStoredTask(value: unknown): BackgroundDelegationTask | null {
  const task = value as Partial<BackgroundDelegationTask> | null;
  if (!task || !task.id || !task.userId || !task.createdAt || !task.updatedAt) return null;
  const workers = Array.isArray(task.workers) ? task.workers.map(worker => ({ ...worker })) : [];
  return {
    ...task,
    title: String(task.title || 'Background task'),
    prompt: String(task.prompt || ''),
    status: task.status || 'queued',
    workers,
    workerNames: Array.isArray(task.workerNames) ? [...task.workerNames] : workers.map(worker => worker.name),
    idempotencyKey: task.idempotencyKey || `background:${task.id}`,
    toolCallsCount: Number(task.toolCallsCount) || 0,
    cancelRequested: task.cancelRequested === true,
    pauseRequested: task.pauseRequested === true,
    attempt: Number(task.attempt) || 0,
    recoveryCount: Number(task.recoveryCount) || 0,
  } as BackgroundDelegationTask;
}

export function recoverPersistedBackgroundTask(
  input: BackgroundDelegationTask,
  recoveredAt = nowIso(),
): BackgroundDelegationTask {
  const task = cloneTask(input);
  if (isTerminal(task.status) || task.status === 'paused' || task.status === 'queued') return task;
  if (task.status === 'cancelling' || task.cancelRequested) {
    task.status = 'cancelled';
    task.cancelRequested = true;
    task.completedAt = recoveredAt;
    task.updatedAt = recoveredAt;
    task.error = task.error || 'Cancellation completed during restart recovery';
    task.terminalReceipt = buildTaskTerminalReceipt({
      taskId: task.id,
      runtime: 'background',
      outcome: 'cancelled',
      reasonCode: 'restart_recovery_cancelled',
      reason: task.error,
      evidenceRefs: task.checkpoint?.receiptIds,
      createdAt: recoveredAt,
    });
    clearLease(task);
    return task;
  }
  if (task.status === 'pausing' || task.pauseRequested) {
    task.status = 'paused';
    task.pauseRequested = false;
    task.pausedAt = recoveredAt;
    task.updatedAt = recoveredAt;
    clearLease(task);
    return task;
  }
  const nextRecoveryCount = task.recoveryCount + 1;
  const hasPersistentReceiptLedger = Boolean(task.context?.conversationId && task.context?.actionTaskId);
  const resumeSafety = evaluateDurableResumeSafety(task.checkpoint?.receipts, hasPersistentReceiptLedger);
  if (!resumeSafety.allowed || nextRecoveryCount > 2) {
    const reason = !resumeSafety.allowed
      ? resumeSafety.reason
      : 'Background task exceeded its restart recovery budget.';
    const diagnosis = diagnoseDurableTaskFailure({
      error: reason,
      receiptSnapshots: task.checkpoint?.receipts,
      attempt: task.attempt,
      recoveryCount: nextRecoveryCount,
      previous: task.recovery,
      maxAttempts: 1,
      now: new Date(recoveredAt),
    });
    task.status = 'blocked';
    task.error = reason;
    task.completedAt = recoveredAt;
    task.updatedAt = recoveredAt;
    task.recoveryCount = nextRecoveryCount;
    task.lastRecoveredAt = recoveredAt;
    task.recovery = updateDurableTaskRecovery(task.recovery, diagnosis, task.checkpoint?.receipts);
    task.terminalReceipt = buildTaskTerminalReceipt({
      taskId: task.id,
      runtime: 'background',
      outcome: 'blocked',
      reasonCode: diagnosis.failureClass,
      reason,
      evidenceRefs: task.checkpoint?.receiptIds,
      createdAt: recoveredAt,
    });
    clearLease(task);
    return task;
  }
  task.status = 'queued';
  task.startedAt = undefined;
  task.updatedAt = recoveredAt;
  task.recoveryCount = nextRecoveryCount;
  task.lastRecoveredAt = recoveredAt;
  clearLease(task);
  return task;
}

function trimTasks(): void {
  const terminal = Array.from(tasks.values())
    .filter(task => isTerminal(task.status))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  for (const task of terminal.slice(MAX_TERMINAL_TASKS)) tasks.delete(task.id);
}

function persist(): void {
  trimTasks();
  try {
    const db = readDB();
    db.backgroundDelegationTasks = Array.from(tasks.values()).map(cloneTask);
    writeDB(db);
  } catch {
    // Unit tests and early bootstrap can legitimately run before SQLite exists.
  }
}

export function hydrateBackgroundTasksFromDb(force = false): number {
  if (hydrated && !force) return 0;
  let db: any;
  try {
    db = readDB();
  } catch {
    return 0;
  }
  const recoveredAt = nowIso();
  let recovered = 0;
  for (const value of Array.isArray(db.backgroundDelegationTasks) ? db.backgroundDelegationTasks : []) {
    const stored = normalizeStoredTask(value);
    if (!stored) continue;
    const restored = recoverPersistedBackgroundTask(stored, recoveredAt);
    if (restored.status !== stored.status || restored.recoveryCount !== stored.recoveryCount) recovered += 1;
    const current = tasks.get(restored.id);
    if (!current || current.updatedAt <= restored.updatedAt) tasks.set(restored.id, restored);
  }
  hydrated = true;
  if (recovered > 0) persist();
  return recovered;
}

function ensureHydrated(): void {
  if (!hydrated) hydrateBackgroundTasksFromDb();
}

export function registerBackgroundTask(input: RegisterBackgroundTaskInput): BackgroundDelegationTask {
  ensureHydrated();
  const timestamp = nowIso();
  const id = input.id || `bg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const existing = tasks.get(id);
  if (existing) return cloneTask(existing);
  if (input.idempotencyKey) {
    const duplicate = Array.from(tasks.values()).find(task => (
      task.userId === input.userId && task.idempotencyKey === input.idempotencyKey
    ));
    if (duplicate) return cloneTask(duplicate);
  }
  const workers = (input.workers || []).slice(0, 8).map(worker => ({
    id: worker.id,
    name: String(worker.name || worker.id || 'Worker'),
    category: worker.category,
  }));
  const task: BackgroundDelegationTask = {
    id,
    userId: input.userId,
    title: input.title.slice(0, 160) || 'Background task',
    prompt: input.prompt,
    status: 'queued',
    reason: input.reason,
    complexity: input.complexity,
    workers,
    workerNames: workers.map(worker => worker.name),
    context: input.context,
    idempotencyKey: input.idempotencyKey || `background:${id}`,
    toolCallsCount: 0,
    cancelRequested: false,
    pauseRequested: false,
    attempt: 0,
    recoveryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  tasks.set(id, task);
  persist();
  return cloneTask(task);
}

export function getBackgroundTask(id: string, userId?: string): BackgroundDelegationTask | null {
  ensureHydrated();
  const task = tasks.get(id);
  if (!task || (userId && task.userId !== userId)) return null;
  return cloneTask(task);
}

export function listBackgroundTasks(userId?: string): BackgroundDelegationTask[] {
  ensureHydrated();
  return Array.from(tasks.values())
    .filter(task => !userId || task.userId === userId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map(cloneTask);
}

export function claimBackgroundTask(id: string, input: BackgroundTaskLeaseInput = {}): BackgroundDelegationTask | null {
  ensureHydrated();
  const task = tasks.get(id);
  if (!task || isTerminal(task.status) || task.status === 'paused' || task.status === 'pausing') return null;
  if (!isDurableTaskReady(task.nextAttemptAt)) return null;
  if (task.cancelRequested || task.status === 'cancelling') return cancelBackgroundTask(id);
  const now = Date.now();
  const leaseExpired = !task.leaseExpiresAt || new Date(task.leaseExpiresAt).getTime() <= now;
  if (task.status === 'running' && !leaseExpired) return null;
  const timestamp = new Date(now).toISOString();
  const durationMs = Math.max(5_000, input.durationMs || DEFAULT_LEASE_MS);
  task.status = 'running';
  task.terminalReceipt = undefined;
  task.attempt += 1;
  task.startedAt = timestamp;
  task.updatedAt = timestamp;
  task.nextAttemptAt = undefined;
  task.leaseId = input.leaseId || randomUUID();
  task.leaseOwner = input.owner || RUNTIME_OWNER;
  task.heartbeatAt = timestamp;
  task.leaseExpiresAt = new Date(now + durationMs).toISOString();
  persist();
  return cloneTask(task);
}

export function markBackgroundTaskRunning(id: string): BackgroundDelegationTask | null {
  return claimBackgroundTask(id);
}

export function heartbeatBackgroundTask(id: string, leaseId: string, durationMs = DEFAULT_LEASE_MS): BackgroundDelegationTask | null {
  ensureHydrated();
  const task = tasks.get(id);
  if (!task || task.status !== 'running' || task.leaseId !== leaseId) return null;
  const now = Date.now();
  if (task.leaseExpiresAt && new Date(task.leaseExpiresAt).getTime() <= now) return null;
  task.heartbeatAt = new Date(now).toISOString();
  task.leaseExpiresAt = new Date(now + Math.max(5_000, durationMs)).toISOString();
  task.updatedAt = task.heartbeatAt;
  persist();
  return cloneTask(task);
}

export function checkpointBackgroundTask(
  id: string,
  checkpoint: Omit<BackgroundDelegationCheckpoint, 'updatedAt'>,
  leaseId?: string,
): BackgroundDelegationTask | null {
  ensureHydrated();
  const task = tasks.get(id);
  if (!task || !hasLiveLease(task, leaseId)) return null;
  const timestamp = nowIso();
  task.checkpoint = {
    ...checkpoint,
    completedNodeIds: [...(checkpoint.completedNodeIds || [])],
    receiptIds: [...(checkpoint.receiptIds || [])],
    receipts: checkpoint.receipts?.slice(-80).map(receipt => ({
      ...receipt,
      sideEffects: (receipt.sideEffects || []).map(effect => ({ ...effect })),
    })),
    updatedAt: timestamp,
  };
  task.updatedAt = timestamp;
  persist();
  return cloneTask(task);
}

export function incrementBackgroundTaskToolCalls(id: string, leaseId?: string): BackgroundDelegationTask | null {
  ensureHydrated();
  const task = tasks.get(id);
  if (!task || !hasLiveLease(task, leaseId)) return null;
  task.toolCallsCount += 1;
  task.updatedAt = nowIso();
  persist();
  return cloneTask(task);
}

export function requestPauseBackgroundTask(id: string, userId?: string): BackgroundDelegationTask | null {
  ensureHydrated();
  const task = tasks.get(id);
  if (!task || (userId && task.userId !== userId) || isTerminal(task.status)) return task ? cloneTask(task) : null;
  const timestamp = nowIso();
  task.pauseRequested = true;
  task.updatedAt = timestamp;
  if (task.status === 'queued') {
    task.status = 'paused';
    task.pauseRequested = false;
    task.pausedAt = timestamp;
    clearLease(task);
  } else if (task.status === 'running') {
    task.status = 'pausing';
  }
  persist();
  return cloneTask(task);
}

export function pauseBackgroundTask(id: string): BackgroundDelegationTask | null {
  ensureHydrated();
  const task = tasks.get(id);
  if (!task || isTerminal(task.status)) return task ? cloneTask(task) : null;
  const timestamp = nowIso();
  task.status = 'paused';
  task.pauseRequested = false;
  task.pausedAt = timestamp;
  task.updatedAt = timestamp;
  clearLease(task);
  persist();
  return cloneTask(task);
}

export function resumeBackgroundTask(id: string, userId?: string): BackgroundDelegationTask | null {
  ensureHydrated();
  const task = tasks.get(id);
  if (!task || (userId && task.userId !== userId) || task.status !== 'paused') return null;
  task.status = 'queued';
  task.terminalReceipt = undefined;
  task.pauseRequested = false;
  task.pausedAt = undefined;
  task.updatedAt = nowIso();
  persist();
  return cloneTask(task);
}

export function isBackgroundTaskPauseRequested(id: string): boolean {
  ensureHydrated();
  const task = tasks.get(id);
  return task?.pauseRequested === true || task?.status === 'pausing' || task?.status === 'paused';
}

export function requestCancelBackgroundTask(id: string, userId?: string): BackgroundDelegationTask | null {
  ensureHydrated();
  const task = tasks.get(id);
  if (!task || (userId && task.userId !== userId)) return null;
  if (isTerminal(task.status)) return cloneTask(task);
  task.cancelRequested = true;
  if (task.status === 'queued' || task.status === 'paused') return cancelBackgroundTask(id);
  task.status = 'cancelling';
  task.updatedAt = nowIso();
  persist();
  return cloneTask(task);
}

export function isBackgroundTaskCancellationRequested(id: string): boolean {
  ensureHydrated();
  const task = tasks.get(id);
  return task?.cancelRequested === true || task?.status === 'cancelling' || task?.status === 'cancelled';
}

export function completeBackgroundTask(
  id: string,
  result: string,
  terminalReceipt: TaskTerminalReceipt,
  leaseId?: string,
): BackgroundDelegationTask | null {
  ensureHydrated();
  const task = tasks.get(id);
  if (!task) return null;
  if (task.status === 'cancelled') return cloneTask(task);
  if (task.cancelRequested) return cancelBackgroundTask(id);
  if (task.status === 'paused') return cloneTask(task);
  if (task.pauseRequested) return pauseBackgroundTask(id);
  if (!hasLiveLease(task, leaseId)) return null;
  const acceptance = validateCompletionTerminalReceipt(terminalReceipt, {
    taskId: task.id,
    runtime: 'background',
  });
  if (!acceptance.accepted) return null;
  const timestamp = nowIso();
  task.status = 'completed';
  task.resultPreview = result.slice(0, 500);
  task.updatedAt = timestamp;
  task.completedAt = timestamp;
  task.terminalReceipt = {
    ...terminalReceipt,
    evidenceRefs: [...terminalReceipt.evidenceRefs],
    toolNames: [...terminalReceipt.toolNames],
    workerIds: [...terminalReceipt.workerIds],
  };
  clearLease(task);
  persist();
  return cloneTask(task);
}

export function failBackgroundTask(id: string, error: string, leaseId?: string): BackgroundDelegationTask | null {
  ensureHydrated();
  const task = tasks.get(id);
  if (!task) return null;
  if (!hasLiveLease(task, leaseId)) return null;
  if (task.cancelRequested) return cancelBackgroundTask(id);
  if (task.pauseRequested) return pauseBackgroundTask(id);
  const timestamp = nowIso();
  task.status = 'failed';
  task.error = error.slice(0, 500);
  task.updatedAt = timestamp;
  task.completedAt = timestamp;
  task.terminalReceipt = buildTaskTerminalReceipt({
    taskId: task.id,
    runtime: 'background',
    outcome: 'failed',
    reasonCode: 'background_execution_failed',
    reason: task.error,
    evidenceRefs: task.checkpoint?.receiptIds,
    createdAt: timestamp,
  });
  clearLease(task);
  persist();
  return cloneTask(task);
}

export function recordBackgroundTaskFailure(
  id: string,
  input: Omit<DiagnoseDurableTaskFailureInput, 'attempt' | 'recoveryCount' | 'previous'>,
  leaseId?: string,
): BackgroundDelegationTask | null {
  ensureHydrated();
  const task = tasks.get(id);
  if (!task) return null;
  if (task.status === 'cancelled') return cloneTask(task);
  if (task.cancelRequested) return cancelBackgroundTask(id);
  if (task.status === 'paused') return cloneTask(task);
  if (task.pauseRequested) return pauseBackgroundTask(id);
  if (!hasLiveLease(task, leaseId)) return null;
  const receipts = input.receiptSnapshots || snapshotDurableToolRecords(input.toolRecords || []);
  const diagnosis = diagnoseDurableTaskFailure({
    ...input,
    receiptSnapshots: receipts,
    attempt: task.attempt,
    recoveryCount: task.recoveryCount,
    previous: task.recovery,
  });
  task.recovery = updateDurableTaskRecovery(task.recovery, diagnosis, receipts);
  task.error = diagnosis.reason.slice(0, 500);
  task.updatedAt = diagnosis.diagnosedAt;
  clearLease(task);
  if (diagnosis.decision === 'retry' || diagnosis.decision === 'replan') {
    task.status = 'queued';
    task.terminalReceipt = undefined;
    task.startedAt = undefined;
    task.completedAt = undefined;
    task.nextAttemptAt = diagnosis.nextAttemptAt;
  } else {
    task.status = diagnosis.decision === 'block' ? 'blocked' : 'failed';
    task.completedAt = diagnosis.diagnosedAt;
    task.terminalReceipt = buildTaskTerminalReceipt({
      taskId: task.id,
      runtime: 'background',
      outcome: task.status,
      toolRecords: input.toolRecords,
      reasonCode: diagnosis.failureClass,
      reason: diagnosis.reason,
      evidenceRefs: task.checkpoint?.receiptIds,
      createdAt: diagnosis.diagnosedAt,
    });
  }
  persist();
  return cloneTask(task);
}

export function cancelBackgroundTask(id: string): BackgroundDelegationTask | null {
  ensureHydrated();
  const task = tasks.get(id);
  if (!task) return null;
  const timestamp = nowIso();
  task.cancelRequested = true;
  task.pauseRequested = false;
  task.status = 'cancelled';
  task.updatedAt = timestamp;
  task.completedAt = timestamp;
  task.terminalReceipt = buildTaskTerminalReceipt({
    taskId: task.id,
    runtime: 'background',
    outcome: 'cancelled',
    reasonCode: 'background_task_cancelled',
    reason: task.error || 'Background task cancelled.',
    evidenceRefs: task.checkpoint?.receiptIds,
    createdAt: timestamp,
  });
  clearLease(task);
  persist();
  return cloneTask(task);
}

export function resetBackgroundTasksForTest(options: { clearPersisted?: boolean; markHydrated?: boolean } = {}): void {
  tasks.clear();
  hydrated = options.markHydrated === true;
  if (options.clearPersisted) persist();
}
