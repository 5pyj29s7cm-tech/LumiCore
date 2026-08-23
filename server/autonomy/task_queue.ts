/** Durable autonomous task queue for Lumi's unattended background work. */
import { randomUUID } from 'crypto';
import { readDB, writeDB } from '../../db_layer';
import type { PersistedCapabilityExecutionPlan } from '../conversation/action_ledger';
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

export type AutonomousTaskStatus = 'pending' | 'running' | 'pausing' | 'paused' | 'completed' | 'failed' | 'blocked' | 'cancelled';

export interface AutonomousTaskCheckpoint {
  phase: string;
  iteration?: number;
  receiptIds?: string[];
  /** Redacted machine evidence used only for replay-safety decisions. */
  receipts?: DurableTaskReceiptSnapshot[];
  detail?: string;
  updatedAt: string;
}

export interface AutonomousTask {
  id: string;
  userId: string;
  title: string;
  description: string;
  status: AutonomousTaskStatus;
  source: 'scheduler' | 'curiosity' | 'pattern_detected' | 'user_request';
  workflowId?: string;
  planId?: string;
  priority: number;  // 0-10
  mode: 'desktop' | 'terminal' | 'analysis';
  createdAt: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  pausedAt?: string;
  result?: string;
  error?: string;
  toolCallsCount?: number;
  tokensUsed?: number;
  finalized?: boolean;
  blocked?: boolean;
  verified?: boolean;
  verificationReason?: string;
  cancelRequestedAt?: string;
  pauseRequestedAt?: string;
  recoveryCount?: number;
  lastRecoveredAt?: string;
  attempt?: number;
  leaseId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  idempotencyKey?: string;
  nextAttemptAt?: string;
  recovery?: DurableTaskRecoveryState;
  checkpoint?: AutonomousTaskCheckpoint;
  executionPlan?: PersistedCapabilityExecutionPlan;
  /** Unified terminal acceptance receipt. Completed tasks require a verified receipt. */
  terminalReceipt?: TaskTerminalReceipt;
}

export interface AutonomousTaskLeaseInput {
  leaseId?: string;
  owner?: string;
  durationMs?: number;
}

const MAX_QUEUE_SIZE = 20;
const MAX_HISTORY = 200;
const TASK_TTL_DAYS = 7;
const DEFAULT_LEASE_MS = 60_000;
const RUNTIME_OWNER = `lumi:${process.pid}:${randomUUID()}`;

let queue: AutonomousTask[] = [];
let history: AutonomousTask[] = [];
let hydrated = false;
const cancellationRequests = new Set<string>();

function nowIso(): string {
  return new Date().toISOString();
}

function clearLease(task: AutonomousTask): void {
  task.leaseId = undefined;
  task.leaseOwner = undefined;
  task.leaseExpiresAt = undefined;
  task.heartbeatAt = undefined;
}

function hasLiveLease(task: AutonomousTask, leaseId?: string): boolean {
  if (!leaseId) return true;
  return task.status === 'running'
    && task.leaseId === leaseId
    && Boolean(task.leaseExpiresAt)
    && new Date(task.leaseExpiresAt!).getTime() > Date.now();
}

function cloneTask(task: AutonomousTask): AutonomousTask {
  return {
    ...task,
    checkpoint: task.checkpoint ? {
      ...task.checkpoint,
      receiptIds: [...(task.checkpoint.receiptIds || [])],
      receipts: task.checkpoint.receipts?.map(receipt => ({
        ...receipt,
        sideEffects: (receipt.sideEffects || []).map(effect => ({ ...effect })),
      })),
    } : undefined,
    recovery: task.recovery ? JSON.parse(JSON.stringify(task.recovery)) : undefined,
    executionPlan: task.executionPlan ? JSON.parse(JSON.stringify(task.executionPlan)) : undefined,
    terminalReceipt: task.terminalReceipt ? {
      ...task.terminalReceipt,
      evidenceRefs: [...task.terminalReceipt.evidenceRefs],
      toolNames: [...task.terminalReceipt.toolNames],
      workerIds: [...task.terminalReceipt.workerIds],
    } : undefined,
  };
}

function isTerminal(status: AutonomousTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'blocked' || status === 'cancelled';
}

function normalizeStoredTask(value: unknown): AutonomousTask | null {
  const task = value as Partial<AutonomousTask> | null;
  if (!task || !task.id || !task.userId || !task.createdAt) return null;
  return {
    ...task,
    title: String(task.title || 'Autonomous task'),
    description: String(task.description || ''),
    status: task.status || 'pending',
    source: task.source || 'user_request',
    priority: Number(task.priority) || 0,
    mode: task.mode || 'analysis',
    updatedAt: task.updatedAt || task.createdAt,
    recoveryCount: Number(task.recoveryCount) || 0,
    attempt: Number(task.attempt) || 0,
    idempotencyKey: task.idempotencyKey || `autonomous:${task.id}`,
  } as AutonomousTask;
}

export function recoverPersistedTask(task: AutonomousTask, recoveredAt = nowIso()): AutonomousTask {
  const recovered = cloneTask(task);
  if (recovered.status === 'running') {
    if (recovered.cancelRequestedAt) {
      recovered.status = 'cancelled';
      recovered.completedAt = recoveredAt;
      recovered.updatedAt = recoveredAt;
      recovered.error = recovered.error || 'Cancellation completed during restart recovery';
      recovered.terminalReceipt = buildTaskTerminalReceipt({
        taskId: recovered.id,
        runtime: 'autonomous',
        outcome: 'cancelled',
        reasonCode: 'restart_recovery_cancelled',
        reason: recovered.error,
        evidenceRefs: recovered.checkpoint?.receiptIds,
        createdAt: recoveredAt,
      });
      clearLease(recovered);
      return recovered;
    }
    if (recovered.pauseRequestedAt) {
      recovered.status = 'paused';
      recovered.pausedAt = recoveredAt;
      recovered.pauseRequestedAt = undefined;
      recovered.updatedAt = recoveredAt;
      clearLease(recovered);
      return recovered;
    }
    const nextRecoveryCount = (recovered.recoveryCount || 0) + 1;
    const resumeSafety = evaluateDurableResumeSafety(recovered.checkpoint?.receipts, false);
    if (!resumeSafety.allowed || nextRecoveryCount > 2) {
      const reason = !resumeSafety.allowed
        ? resumeSafety.reason
        : 'Autonomous task exceeded its restart recovery budget.';
      const diagnosis = diagnoseDurableTaskFailure({
        error: reason,
        receiptSnapshots: recovered.checkpoint?.receipts,
        sideEffectClass: recovered.executionPlan?.risk.sideEffectClass,
        attempt: recovered.attempt || 0,
        recoveryCount: nextRecoveryCount,
        previous: recovered.recovery,
        maxAttempts: 1,
        now: new Date(recoveredAt),
      });
      recovered.status = 'blocked';
      recovered.error = reason;
      recovered.blocked = true;
      recovered.finalized = true;
      recovered.verified = false;
      recovered.completedAt = recoveredAt;
      recovered.updatedAt = recoveredAt;
      recovered.recoveryCount = nextRecoveryCount;
      recovered.lastRecoveredAt = recoveredAt;
      recovered.recovery = updateDurableTaskRecovery(recovered.recovery, diagnosis, recovered.checkpoint?.receipts);
      recovered.terminalReceipt = buildTaskTerminalReceipt({
        taskId: recovered.id,
        runtime: 'autonomous',
        outcome: 'blocked',
        reasonCode: diagnosis.failureClass,
        reason,
        evidenceRefs: recovered.checkpoint?.receiptIds,
        createdAt: recoveredAt,
      });
      clearLease(recovered);
      return recovered;
    }
    recovered.status = 'pending';
    recovered.startedAt = undefined;
    recovered.updatedAt = recoveredAt;
    recovered.recoveryCount = nextRecoveryCount;
    recovered.lastRecoveredAt = recoveredAt;
    clearLease(recovered);
    return recovered;
  }
  if (recovered.status === 'pausing') {
    recovered.status = 'paused';
    recovered.pausedAt = recoveredAt;
    recovered.pauseRequestedAt = undefined;
    recovered.updatedAt = recoveredAt;
    clearLease(recovered);
  }
  return recovered;
}

function persist(): void {
  try {
    const db = readDB();
    db.autonomousTasks = [...queue, ...history.slice(-MAX_HISTORY)].map(cloneTask);
    writeDB(db);
  } catch {
    // Unit tests and early bootstrap can legitimately run before SQLite exists.
  }
}

export function hydrateAutonomousTasksFromDb(force = false): number {
  if (hydrated && !force) return 0;
  let db: any;
  try {
    db = readDB();
  } catch {
    return 0;
  }
  const recoveredAt = nowIso();
  const stored = (Array.isArray(db.autonomousTasks) ? db.autonomousTasks : [])
    .map(normalizeStoredTask)
    .filter((task): task is AutonomousTask => Boolean(task));
  let recoveredCount = 0;
  const recovered = stored.map(task => {
    const next = recoverPersistedTask(task, recoveredAt);
    if (next.status !== task.status || next.recoveryCount !== task.recoveryCount) recoveredCount += 1;
    return next;
  });
  const cutoff = Date.now() - TASK_TTL_DAYS * 86_400_000;
  const currentById = new Map([...queue, ...history].map(task => [task.id, task]));
  for (const task of recovered) {
    const current = currentById.get(task.id);
    if (current && String(current.updatedAt || current.createdAt) > String(task.updatedAt || task.createdAt)) continue;
    currentById.set(task.id, task);
  }
  const all = Array.from(currentById.values());
  queue = all.filter(task => task.status === 'pending' || task.status === 'running' || task.status === 'pausing' || task.status === 'paused');
  history = all
    .filter(task => isTerminal(task.status) && new Date(task.createdAt).getTime() > cutoff)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(-MAX_HISTORY);
  cancellationRequests.clear();
  for (const task of queue) if (task.cancelRequestedAt) cancellationRequests.add(task.id);
  hydrated = true;
  if (recoveredCount > 0) persist();
  return recoveredCount;
}

function ensureHydrated(): void {
  if (!hydrated) hydrateAutonomousTasksFromDb();
}

export function enqueue(
  task: Omit<AutonomousTask, 'id' | 'createdAt' | 'updatedAt' | 'status'>,
): AutonomousTask | null {
  ensureHydrated();
  if (task.idempotencyKey) {
    const duplicate = [...queue, ...history].find(item => (
      item.userId === task.userId && item.idempotencyKey === task.idempotencyKey
    ));
    if (duplicate) return cloneTask(duplicate);
  }
  if (queue.filter(item => item.userId === task.userId && item.status === 'pending').length >= MAX_QUEUE_SIZE) return null;
  const timestamp = nowIso();
  const id = `autotask_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const newTask: AutonomousTask = {
    ...task,
    id,
    status: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
    attempt: task.attempt || 0,
    recoveryCount: task.recoveryCount || 0,
    idempotencyKey: task.idempotencyKey || `autonomous:${id}`,
  };
  queue.push(newTask);
  persist();
  return cloneTask(newTask);
}

export function dequeue(userId?: string): AutonomousTask | null {
  ensureHydrated();
  const pending = queue
    .filter(task => task.status === 'pending' && isDurableTaskReady(task.nextAttemptAt) && (!userId || task.userId === userId))
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  return pending[0] ? cloneTask(pending[0]) : null;
}

export function claimAutonomousTask(id: string, input: AutonomousTaskLeaseInput = {}): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task || task.status === 'paused' || task.status === 'pausing' || isTerminal(task.status)) return null;
  if (!isDurableTaskReady(task.nextAttemptAt)) return null;
  if (task.cancelRequestedAt) return markCancelled(id);
  const now = Date.now();
  const leaseExpired = !task.leaseExpiresAt || new Date(task.leaseExpiresAt).getTime() <= now;
  if (task.status === 'running' && !leaseExpired) return null;
  const timestamp = new Date(now).toISOString();
  task.status = 'running';
  task.terminalReceipt = undefined;
  task.startedAt = timestamp;
  task.updatedAt = timestamp;
  task.nextAttemptAt = undefined;
  task.attempt = (task.attempt || 0) + 1;
  task.leaseId = input.leaseId || randomUUID();
  task.leaseOwner = input.owner || RUNTIME_OWNER;
  task.heartbeatAt = timestamp;
  task.leaseExpiresAt = new Date(now + Math.max(5_000, input.durationMs || DEFAULT_LEASE_MS)).toISOString();
  persist();
  return cloneTask(task);
}

export function markRunning(id: string): AutonomousTask | null {
  return claimAutonomousTask(id);
}

export function heartbeatAutonomousTask(id: string, leaseId: string, durationMs = DEFAULT_LEASE_MS): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task || task.status !== 'running' || task.leaseId !== leaseId) return null;
  const now = Date.now();
  if (task.leaseExpiresAt && new Date(task.leaseExpiresAt).getTime() <= now) return null;
  task.heartbeatAt = new Date(now).toISOString();
  task.leaseExpiresAt = new Date(now + Math.max(5_000, durationMs)).toISOString();
  task.updatedAt = task.heartbeatAt;
  persist();
  return cloneTask(task);
}

export function checkpointAutonomousTask(
  id: string,
  checkpoint: Omit<AutonomousTaskCheckpoint, 'updatedAt'>,
  leaseId?: string,
): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task || !hasLiveLease(task, leaseId)) return null;
  const timestamp = nowIso();
  task.checkpoint = {
    ...checkpoint,
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

export function attachAutonomousExecutionPlan(
  id: string,
  plan: PersistedCapabilityExecutionPlan,
  leaseId?: string,
): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task || !hasLiveLease(task, leaseId)) return null;
  task.executionPlan = plan;
  task.updatedAt = nowIso();
  persist();
  return cloneTask(task);
}

export function markCompleted(
  id: string,
  result: string,
  toolCallsCount: number,
  tokensUsed: number,
  verification: Pick<AutonomousTask, 'finalized' | 'blocked' | 'verified' | 'verificationReason'> & {
    terminalReceipt?: TaskTerminalReceipt;
  } = {},
  leaseId?: string,
): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task) return null;
  if (!hasLiveLease(task, leaseId)) return null;
  if (verification.finalized !== true || verification.verified !== true || verification.blocked === true) return null;
  const acceptance = validateCompletionTerminalReceipt(verification.terminalReceipt, {
    taskId: task.id,
    runtime: 'autonomous',
  });
  if (!acceptance.accepted) return null;
  if (isTaskCancellationRequested(id)) return markCancelled(id);
  if (task.pauseRequestedAt) return markPaused(id);
  const timestamp = nowIso();
  task.status = 'completed';
  task.completedAt = timestamp;
  task.updatedAt = timestamp;
  task.result = result;
  task.toolCallsCount = toolCallsCount;
  task.tokensUsed = tokensUsed;
  task.finalized = true;
  task.blocked = false;
  task.verified = true;
  task.verificationReason = verification.verificationReason;
  task.terminalReceipt = {
    ...verification.terminalReceipt!,
    evidenceRefs: [...verification.terminalReceipt!.evidenceRefs],
    toolNames: [...verification.terminalReceipt!.toolNames],
    workerIds: [...verification.terminalReceipt!.workerIds],
  };
  clearLease(task);
  moveToHistory(task);
  persist();
  return cloneTask(task);
}

export function markFailed(id: string, error: string, leaseId?: string): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task) return null;
  if (!hasLiveLease(task, leaseId)) return null;
  if (isTaskCancellationRequested(id)) return markCancelled(id, error);
  if (task.pauseRequestedAt) return markPaused(id);
  const timestamp = nowIso();
  task.status = 'failed';
  task.completedAt = timestamp;
  task.updatedAt = timestamp;
  task.error = error;
  task.terminalReceipt = buildTaskTerminalReceipt({
    taskId: task.id,
    runtime: 'autonomous',
    outcome: 'failed',
    reasonCode: 'autonomous_execution_failed',
    reason: error,
    evidenceRefs: task.checkpoint?.receiptIds,
    createdAt: timestamp,
  });
  clearLease(task);
  moveToHistory(task);
  persist();
  return cloneTask(task);
}

export function recordAutonomousTaskFailure(
  id: string,
  input: Omit<DiagnoseDurableTaskFailureInput, 'attempt' | 'recoveryCount' | 'previous'>,
  leaseId?: string,
): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task) return null;
  if (!hasLiveLease(task, leaseId)) return null;
  if (isTaskCancellationRequested(id)) return markCancelled(id, compactFailure(input.error));
  if (task.pauseRequestedAt) return markPaused(id);
  const receipts = input.receiptSnapshots || snapshotDurableToolRecords(input.toolRecords || []);
  const diagnosis = diagnoseDurableTaskFailure({
    ...input,
    receiptSnapshots: receipts,
    attempt: task.attempt || 0,
    recoveryCount: task.recoveryCount || 0,
    previous: task.recovery,
  });
  task.recovery = updateDurableTaskRecovery(task.recovery, diagnosis, receipts);
  task.error = diagnosis.reason;
  task.verificationReason = diagnosis.reason;
  task.verified = false;
  task.blocked = diagnosis.decision === 'block' || diagnosis.decision === 'fail';
  task.finalized = task.blocked;
  task.updatedAt = diagnosis.diagnosedAt;
  clearLease(task);
  if (diagnosis.decision === 'retry' || diagnosis.decision === 'replan') {
    task.status = 'pending';
    task.terminalReceipt = undefined;
    task.startedAt = undefined;
    task.completedAt = undefined;
    task.nextAttemptAt = diagnosis.nextAttemptAt;
  } else {
    task.status = diagnosis.decision === 'block' ? 'blocked' : 'failed';
    task.completedAt = diagnosis.diagnosedAt;
    task.terminalReceipt = buildTaskTerminalReceipt({
      taskId: task.id,
      runtime: 'autonomous',
      outcome: diagnosis.decision === 'block' ? 'blocked' : 'failed',
      toolRecords: input.toolRecords,
      reasonCode: diagnosis.failureClass,
      reason: diagnosis.reason,
      evidenceRefs: task.checkpoint?.receiptIds,
      createdAt: diagnosis.diagnosedAt,
    });
    moveToHistory(task);
  }
  persist();
  return cloneTask(task);
}

function compactFailure(error: unknown): string {
  return String(error instanceof Error ? error.message : error || 'Task failed').replace(/\s+/g, ' ').trim().slice(0, 700);
}

export function requestPauseAutonomousTask(id: string, userId?: string): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id, userId);
  if (!task || isTerminal(task.status)) return task ? cloneTask(task) : null;
  const timestamp = nowIso();
  task.pauseRequestedAt = timestamp;
  task.updatedAt = timestamp;
  if (task.status === 'pending') {
    task.status = 'paused';
    task.pausedAt = timestamp;
    task.pauseRequestedAt = undefined;
    clearLease(task);
  } else if (task.status === 'running') {
    task.status = 'pausing';
  }
  persist();
  return cloneTask(task);
}

export function markPaused(id: string): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task || isTerminal(task.status)) return task ? cloneTask(task) : null;
  const timestamp = nowIso();
  task.status = 'paused';
  task.pausedAt = timestamp;
  task.pauseRequestedAt = undefined;
  task.updatedAt = timestamp;
  clearLease(task);
  persist();
  return cloneTask(task);
}

export function resumeAutonomousTask(id: string, userId?: string): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id, userId);
  if (!task || task.status !== 'paused') return null;
  task.status = 'pending';
  task.terminalReceipt = undefined;
  task.pausedAt = undefined;
  task.pauseRequestedAt = undefined;
  task.updatedAt = nowIso();
  persist();
  return cloneTask(task);
}

export function isTaskPauseRequested(id: string, userId?: string): boolean {
  ensureHydrated();
  const task = findTask(id, userId);
  return task?.status === 'pausing' || task?.status === 'paused' || Boolean(task?.pauseRequestedAt);
}

export function cancelTask(id: string, userId?: string): boolean {
  ensureHydrated();
  const task = findTask(id, userId);
  if (!task || (task.status !== 'pending' && task.status !== 'running' && task.status !== 'pausing' && task.status !== 'paused')) return false;
  if (task.status === 'running' || task.status === 'pausing') {
    task.cancelRequestedAt = nowIso();
    task.updatedAt = task.cancelRequestedAt;
    cancellationRequests.add(id);
    persist();
    return true;
  }
  markCancelled(id);
  return true;
}

export function isTaskCancellationRequested(id: string, userId?: string): boolean {
  ensureHydrated();
  const task = findTask(id, userId);
  return cancellationRequests.has(id) || Boolean(task?.cancelRequestedAt);
}

export function markCancelled(id: string, reason = 'Cancelled by user'): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task) return null;
  const timestamp = nowIso();
  task.status = 'cancelled';
  task.completedAt = timestamp;
  task.updatedAt = timestamp;
  task.error = reason;
  task.terminalReceipt = buildTaskTerminalReceipt({
    taskId: task.id,
    runtime: 'autonomous',
    outcome: 'cancelled',
    reasonCode: 'autonomous_task_cancelled',
    reason,
    evidenceRefs: task.checkpoint?.receiptIds,
    createdAt: timestamp,
  });
  clearLease(task);
  moveToHistory(task);
  persist();
  return cloneTask(task);
}

export function getTaskQueue(userId?: string): AutonomousTask[] {
  ensureHydrated();
  return queue
    .filter(task => !isTerminal(task.status) && (!userId || task.userId === userId))
    .map(cloneTask);
}

export function getTaskHistory(limit: number = 50, offset: number = 0, userId?: string): AutonomousTask[] {
  ensureHydrated();
  return history
    .filter(task => !userId || task.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(offset, offset + limit)
    .map(cloneTask);
}

export function getRunningTask(userId?: string): AutonomousTask | null {
  ensureHydrated();
  const task = queue.find(item => (item.status === 'running' || item.status === 'pausing') && (!userId || item.userId === userId));
  return task ? cloneTask(task) : null;
}

function findTask(id: string, userId?: string): AutonomousTask | null {
  return queue.find(task => task.id === id && (!userId || task.userId === userId)) || null;
}

function moveToHistory(task: AutonomousTask): void {
  queue = queue.filter(item => item.id !== task.id);
  cancellationRequests.delete(task.id);
  history.push(task);
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
}

export function resetAutonomousTaskQueueForTest(options: { clearPersisted?: boolean; markHydrated?: boolean } = {}): void {
  queue = [];
  history = [];
  cancellationRequests.clear();
  hydrated = options.markHydrated === true;
  if (options.clearPersisted) persist();
}
