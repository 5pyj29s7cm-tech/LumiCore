import type {
  LAPTask,
  LAPTaskDelegateRequest,
  LAPTaskDelegateResponse,
  LAPTaskResultRequest,
  LAPTaskResultResponse,
  LAPTaskStatus,
  LAPSession,
} from './types';

export interface TaskRecord {
  task: LAPTask;
  sessionId: string;
  from: string;      // delegator agentId
  to: string;        // delegate agentId
  status: LAPTaskStatus;
  createdAt: string;
  updatedAt: string;
  result?: Record<string, any>;
  error?: string;
  lateResultAt?: string;
}

const tasks: Map<string, TaskRecord> = new Map();
const taskKey = (sessionId: string, taskId: string) => JSON.stringify([sessionId, taskId]);

function immutableJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value: unknown): string {
  const sort = (entry: any): any => Array.isArray(entry) ? entry.map(sort)
    : entry && typeof entry === 'object'
      ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, sort(entry[key])]))
      : entry;
  return JSON.stringify(sort(immutableJson(value)));
}

function acceptedTaskResponse(record: TaskRecord): LAPTaskDelegateResponse {
  return {
    accepted: true,
    taskId: record.task.taskId,
    status: record.status,
    ...(record.result ? { result: immutableJson(record.result) } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.lateResultAt ? { lateResultAt: record.lateResultAt } : {}),
  };
}

export function delegateTask(
  request: LAPTaskDelegateRequest,
  session: LAPSession,
  fromAgentId: string = session.peerA.agentId,
): LAPTaskDelegateResponse {
  const { task } = request;

  if (session.authorizationStatus !== 'approved') {
    return { accepted: false, taskId: task.taskId || '', reason: 'Session is waiting for local user approval' };
  }
  if (request.sessionId !== session.sessionId) {
    return { accepted: false, taskId: task.taskId || '', reason: 'Task session does not match the authenticated session' };
  }

  // Validate task
  if (!task.type || !task.taskId) {
    return { accepted: false, taskId: task.taskId || '', reason: 'Task requires type and taskId' };
  }

  // Check delegation is within session scope
  if (!session.scope.includes('delegate_task')) {
    return { accepted: false, taskId: task.taskId, reason: 'Session does not permit task delegation' };
  }

  const toAgentId = session.peerA.agentId === fromAgentId
    ? session.peerB.agentId
    : session.peerB.agentId === fromAgentId
      ? session.peerA.agentId
      : '';
  if (!toAgentId) return { accepted: false, taskId: task.taskId, reason: 'Delegating peer is not part of this session' };
  const key = taskKey(session.sessionId, task.taskId);
  const existing = tasks.get(key);
  if (existing) {
    if (existing.from !== fromAgentId || existing.to !== toAgentId || canonicalJson(existing.task) !== canonicalJson(task)) {
      return { accepted: false, taskId: task.taskId, reason: 'Task identity is already bound to another sender or immutable payload' };
    }
    // A retry is a lookup, including after its deadline. Preserve completed,
    // failed and unknown receipts rather than accepting a fresh execution.
    return acceptedTaskResponse(existing);
  }
  if (task.deadline) {
    const deadlineMs = new Date(task.deadline).getTime();
    if (!Number.isFinite(deadlineMs) || deadlineMs < Date.now()) {
      return { accepted: false, taskId: task.taskId, reason: 'Task deadline is invalid or in the past' };
    }
  }

  const record: TaskRecord = {
    task: immutableJson(task),
    sessionId: session.sessionId,
    from: fromAgentId,
    to: toAgentId,
    status: 'accepted',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  tasks.set(key, record);
  return acceptedTaskResponse(record);
}

export function registerOutboundTask(task: LAPTask, session: LAPSession, fromAgentId: string): TaskRecord {
  const toAgentId = session.peerA.agentId === fromAgentId
    ? session.peerB.agentId
    : session.peerB.agentId === fromAgentId
      ? session.peerA.agentId
      : '';
  if (!toAgentId) throw new Error('Outbound LAP sender is not part of this session.');
  const key = taskKey(session.sessionId, task.taskId);
  const existing = tasks.get(key);
  if (existing) {
    if (existing.from !== fromAgentId || existing.to !== toAgentId || canonicalJson(existing.task) !== canonicalJson(task)) {
      throw new Error('LAP task id is already bound to another sender or immutable payload.');
    }
    return existing;
  }
  const now = new Date().toISOString();
  const record: TaskRecord = {
    task: immutableJson(task),
    sessionId: session.sessionId,
    from: fromAgentId,
    to: toAgentId,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(key, record);
  return record;
}

export function updateTaskStatus(
  sessionId: string,
  taskId: string,
  status: LAPTaskStatus,
  output?: Record<string, any>,
  error?: string,
  fromAgentId?: string,
): boolean {
  const record = tasks.get(taskKey(sessionId, taskId));
  if (!record) return false;
  if (fromAgentId && record.to !== fromAgentId) return false;
  if (!['pending', 'accepted', 'rejected', 'running', 'completed', 'failed', 'unknown'].includes(status)) return false;
  const previousStatus = record.status;
  const terminal = new Set<LAPTaskStatus>(['completed', 'failed', 'rejected']);
  if (terminal.has(previousStatus)) {
    return status === previousStatus
      && (!output || canonicalJson(record.result || {}) === canonicalJson(boundedOutput(output)))
      && (!error || record.error === String(error).slice(0, 2_000));
  }
  if (previousStatus === 'unknown' && status !== 'completed' && status !== 'failed') return false;
  if ((previousStatus === 'running' || previousStatus === 'accepted') && status === 'pending') return false;
  if (previousStatus === 'running' && status === 'accepted') return false;
  record.status = status;
  record.updatedAt = new Date().toISOString();
  if (previousStatus === 'unknown' && (status === 'completed' || status === 'failed')) {
    record.lateResultAt = record.updatedAt;
  }
  if (output) {
    record.result = boundedOutput(output);
  }
  if (error) record.error = String(error).slice(0, 2_000);
  return true;
}

function boundedOutput(output: Record<string, any>): Record<string, any> {
  const serialized = JSON.stringify(output);
  return serialized.length <= 16_000
    ? JSON.parse(serialized)
    : { truncated: true, preview: serialized.slice(0, 12_000) };
}

export function getTask(taskId: string, sessionId?: string): TaskRecord | undefined {
  expirePendingTasks();
  if (sessionId) return tasks.get(taskKey(sessionId, taskId));
  // Legacy in-process callers may omit scope only when the ID is unambiguous.
  const matches = Array.from(tasks.values()).filter(record => record.task.taskId === taskId);
  return matches.length === 1 ? matches[0] : undefined;
}

export function getTasksForSession(sessionId: string): TaskRecord[] {
  expirePendingTasks();
  return Array.from(tasks.values()).filter(t => t.sessionId === sessionId);
}

export function getTasksForAgent(agentId: string): TaskRecord[] {
  expirePendingTasks();
  return Array.from(tasks.values()).filter(t => t.from === agentId || t.to === agentId);
}

export function cancelTasksForSession(sessionId: string): number {
  let count = 0;
  for (const record of tasks.values()) {
    if (record.sessionId === sessionId && !['completed', 'failed', 'rejected'].includes(record.status)) {
      record.status = 'failed';
      record.error = 'Session revoked';
      count++;
    }
  }
  return count;
}

export function buildTaskListResponse(tasks: TaskRecord[], options: { includeResult?: boolean } = {}): Record<string, any> {
  return {
    tasks: tasks.map(r => ({
      taskId: r.task.taskId,
      type: r.task.type,
      status: r.status,
      from: r.from,
      to: r.to,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      hasResult: !!r.result,
      ...(options.includeResult ? {
        result: r.result,
        error: r.error,
        lateResultAt: r.lateResultAt,
        receiptStatus: r.status === 'completed'
          ? r.lateResultAt ? 'peer_reported_late' : 'peer_reported'
          : r.status === 'failed' || r.status === 'rejected'
            ? 'failed'
            : r.status === 'unknown'
              ? 'unknown'
              : 'pending',
      } : {}),
    })),
    summary: {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending' || t.status === 'accepted').length,
      running: tasks.filter(t => t.status === 'running').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      unknown: tasks.filter(t => t.status === 'unknown').length,
    },
  };
}

export function resetLAPTasksForTests(): void {
  tasks.clear();
}

function expirePendingTasks(): void {
  for (const record of tasks.values()) {
    if (['pending', 'accepted', 'running'].includes(record.status) && record.task.deadline
      && Date.parse(record.task.deadline) <= Date.now()) {
      record.status = 'unknown';
      record.error = 'The task deadline passed without a terminal peer receipt.';
      record.updatedAt = new Date().toISOString();
    }
  }
}
