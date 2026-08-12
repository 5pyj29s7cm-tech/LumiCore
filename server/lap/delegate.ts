import { randomUUID } from 'crypto';
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

export function delegateTask(
  request: LAPTaskDelegateRequest,
  session: LAPSession,
  fromAgentId: string = session.peerA.agentId,
): LAPTaskDelegateResponse {
  const { task } = request;

  if (session.authorizationStatus !== 'approved') {
    return { accepted: false, taskId: task.taskId || '', reason: 'Session is waiting for local user approval' };
  }

  // Validate task
  if (!task.type || !task.taskId) {
    return { accepted: false, taskId: task.taskId || '', reason: 'Task requires type and taskId' };
  }

  // Check delegation is within session scope
  if (!session.scope.includes('delegate_task')) {
    return { accepted: false, taskId: task.taskId, reason: 'Session does not permit task delegation' };
  }

  // Check deadline
  if (task.deadline) {
    const deadlineMs = new Date(task.deadline).getTime();
    if (deadlineMs < Date.now()) {
      return { accepted: false, taskId: task.taskId, reason: 'Task deadline is in the past' };
    }
  }

  const toAgentId = session.peerA.agentId === fromAgentId
    ? session.peerB.agentId
    : session.peerB.agentId === fromAgentId
      ? session.peerA.agentId
      : '';
  if (!toAgentId) return { accepted: false, taskId: task.taskId, reason: 'Delegating peer is not part of this session' };

  const record: TaskRecord = {
    task,
    sessionId: session.sessionId,
    from: fromAgentId,
    to: toAgentId,
    status: 'accepted',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  tasks.set(task.taskId, record);

  return {
    accepted: true,
    taskId: task.taskId,
    estimatedCompletion: task.type === 'code_review' ? '~5min' : task.type === 'web_search' ? '~30s' : undefined,
  };
}

export function registerOutboundTask(task: LAPTask, session: LAPSession, fromAgentId: string): TaskRecord {
  const toAgentId = session.peerA.agentId === fromAgentId
    ? session.peerB.agentId
    : session.peerB.agentId === fromAgentId
      ? session.peerA.agentId
      : '';
  if (!toAgentId) throw new Error('Outbound LAP sender is not part of this session.');
  const existing = tasks.get(task.taskId);
  if (existing) {
    if (existing.sessionId !== session.sessionId || existing.from !== fromAgentId) {
      throw new Error('LAP task id is already bound to another session or sender.');
    }
    return existing;
  }
  const now = new Date().toISOString();
  const record: TaskRecord = {
    task,
    sessionId: session.sessionId,
    from: fromAgentId,
    to: toAgentId,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(task.taskId, record);
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
  const record = tasks.get(taskId);
  if (!record || record.sessionId !== sessionId) return false;
  if (fromAgentId && record.to !== fromAgentId) return false;
  if (!['pending', 'accepted', 'rejected', 'running', 'completed', 'failed', 'unknown'].includes(status)) return false;
  const previousStatus = record.status;
  const terminal = new Set<LAPTaskStatus>(['completed', 'failed', 'rejected']);
  if (terminal.has(previousStatus) && status !== previousStatus) return false;
  if (previousStatus === 'unknown' && status !== 'completed' && status !== 'failed') return false;
  if ((previousStatus === 'running' || previousStatus === 'accepted') && status === 'pending') return false;
  if (previousStatus === 'running' && status === 'accepted') return false;
  record.status = status;
  record.updatedAt = new Date().toISOString();
  if (previousStatus === 'unknown' && (status === 'completed' || status === 'failed')) {
    record.lateResultAt = record.updatedAt;
  }
  if (output) {
    const serialized = JSON.stringify(output);
    record.result = serialized.length <= 16_000
      ? output
      : { truncated: true, preview: serialized.slice(0, 12_000) };
  }
  if (error) record.error = String(error).slice(0, 2_000);
  return true;
}

export function getTask(taskId: string): TaskRecord | undefined {
  return tasks.get(taskId);
}

export function getTasksForSession(sessionId: string): TaskRecord[] {
  return Array.from(tasks.values()).filter(t => t.sessionId === sessionId);
}

export function getTasksForAgent(agentId: string): TaskRecord[] {
  return Array.from(tasks.values()).filter(t => t.from === agentId || t.to === agentId);
}

export function cancelTasksForSession(sessionId: string): number {
  let count = 0;
  for (const [id, record] of tasks) {
    if (record.sessionId === sessionId && record.status !== 'completed' && record.status !== 'failed') {
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
