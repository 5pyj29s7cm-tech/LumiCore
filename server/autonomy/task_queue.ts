/** Durable autonomous task queue for Lumi's unattended background work. */
import { randomUUID } from 'crypto';
import { flushDBOrThrow, readDB, writeDB } from '../../db_layer';
import type { ToolExecutionRecord } from '../tools/types';
import type { OrganizationMembershipAuthorization } from '../org/membership_authorization';
import { isAutonomousTaskFinalizationPending, projectAutonomousTaskFinalization, resetAutonomousTaskFinalizationsForTests } from './task_finalization';
export { setAutonomousTaskFinalizationPending } from './task_finalization';
import { sanitizeDiagnosticValue } from '../client/diagnostic_sanitizer';
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

export interface AutonomousTaskAction {
  id: string;
  attempt: number;
  callId?: string;
  name: string;
  argumentsDigest: string;
  mayHaveSideEffects: boolean;
  state: 'prepared' | 'started' | 'settled';
  /** Bounded, credential-redacted receipt; raw inputs are never stored here. */
  record?: ToolExecutionRecord;
}

export interface AutonomousTask {
  id: string;
  userId: string;
  title: string;
  description: string;
  status: AutonomousTaskStatus;
  source: 'scheduler' | 'curiosity' | 'pattern_detected' | 'user_request';
  domain?: 'personal' | 'work';
  orgId?: string;
  conversationId?: string;
  workflowId?: string;
  planId?: string;
  /** Exact member authority accepted with a work-domain manual plan request. */
  membershipAuthorization?: OrganizationMembershipAuthorization;
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
  actions?: AutonomousTaskAction[];
  executionPlan?: PersistedCapabilityExecutionPlan;
  /** Unified terminal acceptance receipt. Completed tasks require a verified receipt. */
  terminalReceipt?: TaskTerminalReceipt;
  /** Public projection only: the settled task still needs a successful save. */
  finalizationPending?: boolean;
}

export interface AutonomousTaskLeaseInput {
  leaseId?: string;
  owner?: string;
  durationMs?: number;
}

/** Shared scope boundary for readers and controls of the same task. */
export function autonomousTaskMatchesScope(
  task: Pick<AutonomousTask, 'domain' | 'orgId'>,
  scope: { domain: 'personal' | 'work'; orgId?: string },
): boolean {
  const domain = task.domain === 'work' ? 'work' : 'personal';
  const orgId = domain === 'work' ? String(task.orgId || '').trim() : '';
  const requestedOrg = String(scope.orgId || '').trim();
  if (scope.domain === 'work' && !requestedOrg) return false;
  if (domain === 'work' && !orgId) return false;
  return domain === scope.domain && (domain === 'personal' || orgId === requestedOrg);
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
// Expiry requests cooperative shutdown; it never proves a local executor has
// released its handler. This process fence outlives the wall-clock lease.
const activeExecutors = new Map<string, string>();
const executorStops = new Map<string, (reason: string) => void>();

function notifyExecutorStop(id: string, reason: string): void {
  try { executorStops.get(id)?.(reason); } catch { /* Stopping observers cannot undo a durable request. */ }
}

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

function ownsSettlement(task: AutonomousTask, leaseId?: string): boolean {
  if (!leaseId) return true;
  return (task.status === 'running' || task.status === 'pausing')
    && task.leaseId === leaseId
    && (activeExecutors.get(task.id) === leaseId
      || Boolean(task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) > Date.now()));
}

function recoveryReceipts(task: AutonomousTask): DurableTaskReceiptSnapshot[] {
  const receipts = new Map((task.checkpoint?.receipts || []).map(receipt => [receipt.id, receipt]));
  for (const action of task.actions || []) {
    if (action.state === 'settled' && action.record) {
      for (const receipt of snapshotDurableToolRecords([action.record])) receipts.set(receipt.id, receipt);
    } else if (action.state === 'started' && action.mayHaveSideEffects) {
      receipts.set(action.id, {
        id: action.id, name: action.name, idempotencyKey: action.id,
        status: 'unknown_outcome', verificationStatus: 'unverified', operation: 'unknown',
        sideEffects: [{ type: 'local_write', reversible: false }], resultDigest: '',
        error: 'The adapter started without a durable terminal receipt.', recordedAt: task.updatedAt || task.createdAt,
      });
    }
  }
  return [...receipts.values()];
}

function resumeSafety(task: AutonomousTask) {
  const receipts = recoveryReceipts(task);
  const records = new Set((task.actions || [])
    .filter(action => action.state === 'settled' && action.record)
    .map(action => action.record!.id));
  return evaluateDurableResumeSafety(receipts, receipts.every(receipt => records.has(receipt.id)));
}

function cloneTask(task: AutonomousTask): AutonomousTask {
  return {
    ...task,
    membershipAuthorization: task.membershipAuthorization ? { ...task.membershipAuthorization } : undefined,
    actions: task.actions ? structuredClone(task.actions) : undefined,
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
  if (recovered.status === 'running' || recovered.status === 'pausing' || recovered.status === 'paused') {
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
    if ((recovered.pauseRequestedAt || recovered.status === 'pausing' || recovered.status === 'paused')
      && resumeSafety(recovered).allowed) {
      recovered.status = 'paused';
      recovered.pausedAt = recoveredAt;
      recovered.pauseRequestedAt = undefined;
      recovered.updatedAt = recoveredAt;
      clearLease(recovered);
      return recovered;
    }
    const nextRecoveryCount = (recovered.recoveryCount || 0) + 1;
    const safety = resumeSafety(recovered);
    if (!safety.allowed || nextRecoveryCount > 2) {
      const reason = !safety.allowed
        ? safety.reason
        : 'Autonomous task exceeded its restart recovery budget.';
      const diagnosis = diagnoseDurableTaskFailure({
        error: reason,
        receiptSnapshots: recoveryReceipts(recovered),
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
      recovered.recovery = updateDurableTaskRecovery(recovered.recovery, diagnosis, recoveryReceipts(recovered));
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

/** Admission/terminal lifecycle barriers may never use best-effort persistence. */
export async function persistAutonomousTaskQueue(): Promise<void> {
  const db = readDB();
  db.autonomousTasks = [...queue, ...history.slice(-MAX_HISTORY)].map(cloneTask);
  writeDB(db);
  await flushDBOrThrow();
}

export function registerAutonomousTaskExecutor(id: string, leaseId: string, onStop?: (reason: string) => void): boolean {
  const task = findTask(id);
  if (!task || !hasLiveLease(task, leaseId) || activeExecutors.has(id)) return false;
  activeExecutors.set(id, leaseId);
  if (onStop) executorStops.set(id, onStop);
  return true;
}

export function reconcileExpiredAutonomousTasks(at = Date.now()): number {
  ensureHydrated();
  let changed = 0;
  for (const task of [...queue]) {
    if (!['running', 'pausing'].includes(task.status) || activeExecutors.has(task.id)) continue;
    if (task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) > at) continue;
    const recovered = recoverPersistedTask(task, new Date(at).toISOString());
    Object.assign(task, recovered);
    if (isTerminal(task.status)) moveToHistory(task);
    changed += 1;
  }
  if (changed) persist();
  return changed;
}

export function releaseAutonomousTaskExecutor(id: string, leaseId: string): void {
  if (activeExecutors.get(id) !== leaseId) return;
  activeExecutors.delete(id);
  executorStops.delete(id);
  reconcileExpiredAutonomousTasks();
}

export function prepareAutonomousTaskAction(
  id: string, leaseId: string,
  call: Pick<AutonomousTaskAction, 'callId' | 'name' | 'argumentsDigest' | 'mayHaveSideEffects'>,
): string {
  const task = findTask(id);
  if (!task || !hasLiveLease(task, leaseId) || task.cancelRequestedAt || task.pauseRequestedAt) {
    throw new Error('Autonomous action admission no longer owns a live task lease.');
  }
  task.actions ||= [];
  if (task.actions.some(action => action.attempt !== task.attempt && action.mayHaveSideEffects
    && action.argumentsDigest === call.argumentsDigest && action.name === call.name && action.state !== 'prepared')) {
    throw new Error('A prior autonomous side effect already owns this exact input; reuse its receipt or reconcile its result.');
  }
  const existing = call.callId && task.actions.find(action => (
    action.attempt === task.attempt && action.callId === call.callId
  ));
  if (existing) {
    if (existing.name !== call.name || existing.argumentsDigest !== call.argumentsDigest) {
      throw new Error('An autonomous action identity was reused for different input.');
    }
    return existing.id;
  }
  if (task.actions.length >= 40) throw new Error('Autonomous task reached its durable action limit.');
  const actionId = `${task.idempotencyKey || task.id}:action:${task.actions.length + 1}`;
  task.actions.push({ ...call, id: actionId, attempt: task.attempt || 0, state: 'prepared' });
  task.updatedAt = nowIso();
  return actionId;
}

export async function startAutonomousTaskAction(id: string, leaseId: string, actionId: string): Promise<void> {
  const task = findTask(id);
  const action = task?.actions?.find(item => item.id === actionId);
  if (!task || !action || !hasLiveLease(task, leaseId) || task.cancelRequestedAt || task.pauseRequestedAt) {
    throw new Error('Autonomous adapter admission no longer owns its live action.');
  }
  action.state = 'started';
  task.updatedAt = nowIso();
  await persistAutonomousTaskQueue();
  // A cancellation or expiry may arrive while SQLite is acknowledging entry.
  // Keep its conservative started fence but never dispatch the handler then.
  const current = findTask(id);
  if (!current || !hasLiveLease(current, leaseId) || current.cancelRequestedAt || current.pauseRequestedAt
    || !current.actions?.some(item => item.id === actionId && item.state === 'started')) {
    throw new Error('Autonomous adapter admission was revoked while persisting its start.');
  }
}

export async function settleAutonomousTaskAction(id: string, leaseId: string, record: ToolExecutionRecord): Promise<void> {
  const task = findTask(id);
  if (!task || !ownsSettlement(task, leaseId)) throw new Error('Autonomous terminal receipt lost its execution owner.');
  const action = task.actions?.find(item => item.id === record.idempotencyKey);
  if (!action) return; // A preflight denial did not reserve an adapter action.
  if (action.name !== record.name) throw new Error('Autonomous terminal receipt action mismatch.');
  // Keep the bounded canonical receipt already redacted by the tool engine.
  // Oversized receipts remain unknown rather than silently losing replay data.
  const stored = sanitizeDiagnosticValue(structuredClone(record));
  if (JSON.stringify(stored).length > 64_000) throw new Error('Autonomous terminal receipt exceeds its durable limit.');
  action.record = stored;
  action.state = 'settled';
  task.updatedAt = nowIso();
  task.checkpoint = {
    phase: 'tool_execution', updatedAt: task.updatedAt,
    receiptIds: [...new Set([...(task.checkpoint?.receiptIds || []), ...(record.id ? [record.id] : [])])],
    receipts: recoveryReceipts(task),
  };
  await persistAutonomousTaskQueue();
}

export function getAutonomousTaskPriorRecords(task: AutonomousTask): ToolExecutionRecord[] {
  return (task.actions || []).flatMap(action => action.state === 'settled' && action.record ? [structuredClone(action.record)] : []);
}

export function hydrateAutonomousTasksFromDb(force = false): number {
  if (hydrated && !force) return 0;
  if (activeExecutors.size > 0) return 0;
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

export function dequeue(userId?: string, taskId?: string): AutonomousTask | null {
  ensureHydrated();
  const pending = queue
    .filter(task => task.status === 'pending' && isDurableTaskReady(task.nextAttemptAt)
      && (!userId || task.userId === userId) && (!taskId || task.id === taskId))
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  return pending[0] ? cloneTask(pending[0]) : null;
}

export function claimAutonomousTask(id: string, input: AutonomousTaskLeaseInput = {}): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task || task.status === 'paused' || task.status === 'pausing' || isTerminal(task.status)) return null;
  if (!isDurableTaskReady(task.nextAttemptAt)) return null;
  if (activeExecutors.has(id)) return null;
  if (task.cancelRequestedAt) return markCancelled(id);
  if (task.status === 'pending' && !resumeSafety(task).allowed) {
    Object.assign(task, recoverPersistedTask({ ...task, status: 'running' }));
    if (isTerminal(task.status)) moveToHistory(task);
    persist();
    return null;
  }
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
  if (!task || !['running', 'pausing'].includes(task.status) || task.leaseId !== leaseId) return null;
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
  if (!task || !ownsSettlement(task, leaseId)) return null;
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
  // The execution ledger is authoritative even if the callback failed before
  // the caller could append its record to the turn-local tool list.
  const receiptsById = new Map((input.receiptSnapshots || snapshotDurableToolRecords(input.toolRecords || []))
    .map(receipt => [receipt.id, receipt]));
  for (const receipt of recoveryReceipts(task)) receiptsById.set(receipt.id, receipt);
  const receipts = [...receiptsById.values()];
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
  notifyExecutorStop(id, 'Autonomous task paused by user');
  return cloneTask(task);
}

export function markPaused(id: string): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task || isTerminal(task.status)) return task ? cloneTask(task) : null;
  if (task.cancelRequestedAt || cancellationRequests.has(id)) return markCancelled(id);
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
  if (task.cancelRequestedAt || cancellationRequests.has(id)) return markCancelled(id);
  if (!resumeSafety(task).allowed) {
    Object.assign(task, recoverPersistedTask(task));
    if (isTerminal(task.status)) moveToHistory(task);
    persist();
    return cloneTask(task);
  }
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
    notifyExecutorStop(id, 'Autonomous task cancelled by user');
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

function applyCancelledTaskState(task: AutonomousTask, reason: string): void {
  const timestamp = nowIso();
  task.status = 'cancelled';
  task.finalized = false;
  task.verified = false;
  task.blocked = false;
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
}

export function markCancelled(id: string, reason = 'Cancelled by user'): AutonomousTask | null {
  ensureHydrated();
  const task = findTask(id);
  if (!task) return null;
  applyCancelledTaskState(task, reason);
  moveToHistory(task);
  persist();
  return cloneTask(task);
}

/** Only an unpublished completion can change after it moved into history. */
export function cancelAutonomousTaskFinalization(id: string, reason: string): AutonomousTask | null {
  ensureHydrated();
  if (!isAutonomousTaskFinalizationPending(id)) return null;
  const task = history.find(candidate => candidate.id === id);
  if (!task) return null;
  applyCancelledTaskState(task, reason);
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
    .map(task => projectAutonomousTaskFinalization(cloneTask(task)));
}

export function getRunningTask(userId?: string): AutonomousTask | null {
  ensureHydrated();
  const task = [...queue, ...history].find(item => (
    item.status === 'running' || item.status === 'pausing' || activeExecutors.has(item.id)
  ) && (!userId || item.userId === userId));
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
  activeExecutors.clear();
  executorStops.clear();
  resetAutonomousTaskFinalizationsForTests();
  hydrated = options.markHydrated === true;
  if (options.clearPersisted) persist();
}
