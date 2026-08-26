import {
  isTerminalConversationTaskStatus,
  type ConversationTaskStatus,
} from '../cognition/task_execution_ledger';

export type FocusThreadStatus = ConversationTaskStatus;

export interface ConversationFocusThread {
  schemaVersion: 1;
  threadId: string;
  taskId: string;
  evidenceTaskId: string;
  goal: string;
  status: FocusThreadStatus;
  commitment: string;
  nextAction: string;
  waitingFor: string;
  interruption: string;
  resumePoint: string;
  dueAt: string;
  updatedAt: string;
}

interface FocusTaskLike {
  id: string;
  userId?: string;
  domain?: string;
  orgId?: string;
  goal: string;
  status: FocusThreadStatus;
  blocker?: string;
  context?: string | Record<string, unknown>;
  updatedAt?: string;
  revision?: number;
}

function compact(value: unknown, limit = 600): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function normalizedDueAt(value: unknown): string {
  const raw = compact(value, 80);
  if (!raw) return '';
  const timestamp = new Date(raw).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

export function reconcileConversationFocusThread(
  previousValue: unknown,
  task: FocusTaskLike,
  now = task.updatedAt || new Date().toISOString(),
): ConversationFocusThread {
  const previousCandidate = parseObject(previousValue);
  const previous = previousCandidate.taskId === task.id ? previousCandidate : {};
  const terminal = isTerminalConversationTaskStatus(task.status);
  const waitingFor = task.status === 'waiting_confirmation'
    ? compact(previous.waitingFor, 600) || 'user_confirmation'
    : task.status === 'blocked'
      ? compact(task.blocker, 600) || compact(previous.waitingFor, 600)
      : '';

  return {
    schemaVersion: 1,
    threadId: compact(previous.threadId, 180) || `focus_${task.id}`,
    taskId: task.id,
    evidenceTaskId: task.id,
    goal: compact(task.goal, 1200),
    status: task.status,
    // A durable action task is work Lumi has accepted. Use the persisted goal
    // as the minimum honest commitment while preserving any later, explicit
    // commitment recorded by the runtime.
    commitment: compact(previous.commitment, 1000) || compact(task.goal, 1000),
    nextAction: terminal ? '' : compact(previous.nextAction, 1000),
    waitingFor: terminal ? '' : waitingFor,
    interruption: compact(previous.interruption, 1000),
    resumePoint: compact(previous.resumePoint, 1200),
    dueAt: normalizedDueAt(previous.dueAt),
    updatedAt: now,
  };
}

export function readConversationFocusThread(task: FocusTaskLike): ConversationFocusThread {
  const context = parseObject(task.context);
  return reconcileConversationFocusThread(context.focusThread, task);
}

export function updateConversationFocusThread(
  db: any,
  input: {
    taskId: string;
    userId: string;
    domain?: string;
    orgId?: string;
    commitment?: string;
    nextAction?: string;
    waitingFor?: string;
    interruption?: string;
    resumePoint?: string;
    dueAt?: string;
    now?: string;
  },
): ConversationFocusThread | null {
  const tasks = Array.isArray(db?.conversationActionTasks) ? db.conversationActionTasks as FocusTaskLike[] : [];
  const task = tasks.find(candidate => (
    candidate.id === input.taskId
    && candidate.userId === input.userId
    && (!input.domain || candidate.domain === input.domain)
    && (input.domain !== 'work' || !input.orgId || candidate.orgId === input.orgId)
  ));
  if (!task) return null;

  const now = input.now || new Date().toISOString();
  const context = parseObject(task.context);
  const current = reconcileConversationFocusThread(context.focusThread, task, now);
  const next: ConversationFocusThread = {
    ...current,
    ...(input.commitment !== undefined ? { commitment: compact(input.commitment, 1000) } : {}),
    ...(input.nextAction !== undefined ? { nextAction: compact(input.nextAction, 1000) } : {}),
    ...(input.waitingFor !== undefined ? { waitingFor: compact(input.waitingFor, 600) } : {}),
    ...(input.interruption !== undefined ? { interruption: compact(input.interruption, 1000) } : {}),
    ...(input.resumePoint !== undefined ? { resumePoint: compact(input.resumePoint, 1200) } : {}),
    ...(input.dueAt !== undefined ? { dueAt: normalizedDueAt(input.dueAt) } : {}),
    updatedAt: now,
  };
  if (isTerminalConversationTaskStatus(task.status)) {
    next.nextAction = '';
    next.waitingFor = '';
  }
  task.context = JSON.stringify({ ...context, focusThread: next });
  task.updatedAt = now;
  task.revision = Math.max(1, Number(task.revision) || 1) + 1;
  return next;
}

export function listConversationFocusThreads(
  db: any,
  input: { userId: string; domain?: string; orgId?: string; includeTerminal?: boolean },
): ConversationFocusThread[] {
  const tasks = Array.isArray(db?.conversationActionTasks) ? db.conversationActionTasks as FocusTaskLike[] : [];
  return tasks
    .filter(task => (
      task.userId === input.userId
      && (!input.domain || task.domain === input.domain)
      && (input.domain !== 'work' || !input.orgId || task.orgId === input.orgId)
      && (input.includeTerminal || !isTerminalConversationTaskStatus(task.status))
    ))
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .map(readConversationFocusThread);
}
