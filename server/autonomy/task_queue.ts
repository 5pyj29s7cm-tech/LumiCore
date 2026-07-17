/**
 * Autonomous Task Queue — in-memory queue with DB persistence for Lumi's background work.
 */
import { readDB, writeDB } from '../../db_layer';

export interface AutonomousTask {
  id: string;
  userId: string;
  title: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  source: 'scheduler' | 'curiosity' | 'pattern_detected' | 'user_request';
  workflowId?: string;
  planId?: string;
  priority: number;  // 0-10
  mode: 'desktop' | 'terminal' | 'analysis';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
  toolCallsCount?: number;
  tokensUsed?: number;
  finalized?: boolean;
  blocked?: boolean;
  verified?: boolean;
  verificationReason?: string;
  cancelRequestedAt?: string;
  recoveryCount?: number;
  lastRecoveredAt?: string;
}

const MAX_QUEUE_SIZE = 20;
const MAX_HISTORY = 200;
const TASK_TTL_DAYS = 7;

let queue: AutonomousTask[] = [];
let history: AutonomousTask[] = [];
const cancellationRequests = new Set<string>();

export function recoverPersistedTask(task: AutonomousTask, recoveredAt = new Date().toISOString()): AutonomousTask {
  if (task.status !== 'running') return { ...task };
  if (task.cancelRequestedAt) {
    return {
      ...task,
      status: 'cancelled',
      completedAt: recoveredAt,
      error: task.error || 'Cancellation completed during restart recovery',
    };
  }
  return {
    ...task,
    status: 'pending',
    startedAt: undefined,
    recoveryCount: (task.recoveryCount || 0) + 1,
    lastRecoveredAt: recoveredAt,
  };
}

function loadFromDb() {
  try {
    const db = readDB();
    if (db.autonomousTasks) {
      const stored: AutonomousTask[] = db.autonomousTasks;
      const all = stored.map(task => recoverPersistedTask(task));
      const now = Date.now();
      const cutoff = now - TASK_TTL_DAYS * 86400000;
      queue = all.filter(t => t.status === 'pending' || t.status === 'running');
      history = all.filter(t => (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') && new Date(t.createdAt).getTime() > cutoff);
      if (stored.some(task => task.status === 'running')) persist();
    }
  } catch {}
}

function persist() {
  try {
    const db = readDB();
    db.autonomousTasks = [...queue, ...history.slice(-MAX_HISTORY)];
    writeDB(db);
  } catch {}
}

export function enqueue(task: Omit<AutonomousTask, 'id' | 'createdAt' | 'status'>): AutonomousTask | null {
  if (queue.filter(t => t.userId === task.userId && t.status === 'pending').length >= MAX_QUEUE_SIZE) return null;

  const newTask: AutonomousTask = {
    ...task,
    id: `autotask_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  queue.push(newTask);
  persist();
  return newTask;
}

export function dequeue(userId?: string): AutonomousTask | null {
  const pending = queue
    .filter(t => t.status === 'pending' && (!userId || t.userId === userId))
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  return pending[0] || null;
}

export function markRunning(id: string): AutonomousTask | null {
  const task = findTask(id);
  if (!task) return null;
  task.status = 'running';
  task.startedAt = new Date().toISOString();
  persist();
  return task;
}

export function markCompleted(
  id: string,
  result: string,
  toolCallsCount: number,
  tokensUsed: number,
  verification: Pick<AutonomousTask, 'finalized' | 'blocked' | 'verified' | 'verificationReason'> = {},
): AutonomousTask | null {
  const task = findTask(id);
  if (!task) return null;
  if (isTaskCancellationRequested(id)) return markCancelled(id);
  task.status = 'completed';
  task.completedAt = new Date().toISOString();
  task.result = result;
  task.toolCallsCount = toolCallsCount;
  task.tokensUsed = tokensUsed;
  task.finalized = verification.finalized === true;
  task.blocked = verification.blocked === true;
  task.verified = verification.verified === true;
  task.verificationReason = verification.verificationReason;
  moveToHistory(task);
  persist();
  return task;
}

export function markFailed(id: string, error: string): AutonomousTask | null {
  const task = findTask(id);
  if (!task) return null;
  if (isTaskCancellationRequested(id)) return markCancelled(id, error);
  task.status = 'failed';
  task.completedAt = new Date().toISOString();
  task.error = error;
  moveToHistory(task);
  persist();
  return task;
}

export function cancelTask(id: string, userId?: string): boolean {
  const task = findTask(id, userId);
  if (!task || (task.status !== 'pending' && task.status !== 'running')) return false;
  if (task.status === 'running') {
    task.cancelRequestedAt = new Date().toISOString();
    cancellationRequests.add(id);
    persist();
    return true;
  }
  markCancelled(id);
  return true;
}

export function isTaskCancellationRequested(id: string, userId?: string): boolean {
  const task = findTask(id, userId);
  return cancellationRequests.has(id) || Boolean(task?.cancelRequestedAt);
}

export function markCancelled(id: string, reason = 'Cancelled by user'): AutonomousTask | null {
  const task = findTask(id);
  if (!task) return null;
  task.status = 'cancelled';
  task.completedAt = new Date().toISOString();
  task.error = reason;
  moveToHistory(task);
  persist();
  return task;
}

export function getTaskQueue(userId?: string): AutonomousTask[] {
  return queue.filter(t => (t.status === 'pending' || t.status === 'running') && (!userId || t.userId === userId));
}

export function getTaskHistory(limit: number = 50, offset: number = 0, userId?: string): AutonomousTask[] {
  return history
    .filter(task => !userId || task.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(offset, offset + limit);
}

export function getRunningTask(userId?: string): AutonomousTask | null {
  return queue.find(t => t.status === 'running' && (!userId || t.userId === userId)) || null;
}

function findTask(id: string, userId?: string): AutonomousTask | null {
  return queue.find(t => t.id === id && (!userId || t.userId === userId)) || null;
}

function moveToHistory(task: AutonomousTask) {
  queue = queue.filter(t => t.id !== task.id);
  cancellationRequests.delete(task.id);
  history.push(task);
  // Trim history
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }
}

// Load persisted state on import
loadFromDb();
