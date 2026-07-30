/** Durable autonomous task queue for Lumi's unattended background work. */
import { randomUUID } from 'crypto';
import { readDB, writeDB } from '../../db_layer';
import type { PersistedCapabilityExecutionPlan } from '../conversation/action_ledger';

export type AutonomousTaskStatus = 'pending' | 'running' | 'pausing' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface AutonomousTaskCheckpoint {
  phase: string;
  iteration?: number;
  receiptIds?: string[];
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
  checkpoint?: AutonomousTaskCheckpoint;
  executionPlan?: PersistedCapabilityExecutionPlan;
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

function cloneTask(task: AutonomousTask): AutonomousTask {
  return {
    ...task,
    checkpoint: task.checkpoint ? {
      ...task.checkpoint,
      receiptIds: [...(task.checkpoint.receiptIds || [])],
    } : undefined,
    executionPlan: task.executionPlan ? JSON.parse(JSON.stringify(task.executionPlan)) : undefined,
  };
}

function isTerminal(status: AutonomousTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
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
    recovered.status = 'pending';
    recovered.startedAt = undefined;
    recovered.updatedAt = recoveredAt;
    recovered.recoveryCount = (recovered.recoveryCount || 0) + 1;
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
    .filter(task => task.status === 'pending' && (!userId || task.userId === userId))
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  return pending[0] ? cloneTask(pending[0]) : null;
}

export function claimAutonomousTask(id: string, input: AutonomousTaskLeaseInput = {}): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task || task.status === 'paused' || task.status === 'pausing' || isTerminal(task.status)) return null;
  if (task.cancelRequestedAt) return markCancelled(id);
  const now = Date.now();
  const leaseExpired = !task.leaseExpiresAt || new Date(task.leaseExpiresAt).getTime() <= now;
  if (task.status === 'running' && !leaseExpired) return null;
  const timestamp = new Date(now).toISOString();
  task.status = 'running';
  task.startedAt = timestamp;
  task.updatedAt = timestamp;
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
  if (!task || (leaseId && task.leaseId !== leaseId)) return null;
  const timestamp = nowIso();
  task.checkpoint = { ...checkpoint, receiptIds: [...(checkpoint.receiptIds || [])], updatedAt: timestamp };
  task.updatedAt = timestamp;
  persist();
  return cloneTask(task);
}

export function attachAutonomousExecutionPlan(
  id: string,
  plan: PersistedCapabilityExecutionPlan,
): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task) return null;
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
  verification: Pick<AutonomousTask, 'finalized' | 'blocked' | 'verified' | 'verificationReason'> = {},
): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task) return null;
  if (isTaskCancellationRequested(id)) return markCancelled(id);
  if (task.pauseRequestedAt) return markPaused(id);
  const timestamp = nowIso();
  task.status = 'completed';
  task.completedAt = timestamp;
  task.updatedAt = timestamp;
  task.result = result;
  task.toolCallsCount = toolCallsCount;
  task.tokensUsed = tokensUsed;
  task.finalized = verification.finalized === true;
  task.blocked = verification.blocked === true;
  task.verified = verification.verified === true;
  task.verificationReason = verification.verificationReason;
  clearLease(task);
  moveToHistory(task);
  persist();
  return cloneTask(task);
}

export function markFailed(id: string, error: string): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task) return null;
  if (isTaskCancellationRequested(id)) return markCancelled(id, error);
  if (task.pauseRequestedAt) return markPaused(id);
  const timestamp = nowIso();
  task.status = 'failed';
  task.completedAt = timestamp;
  task.updatedAt = timestamp;
  task.error = error;
  clearLease(task);
  moveToHistory(task);
  persist();
  return cloneTask(task);
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
