import {
  cancelBackgroundTask,
  listBackgroundTasks,
  requestPauseBackgroundTask,
  requestCancelBackgroundTask,
  resumeBackgroundTask,
  type BackgroundDelegationTask,
} from '../agents/background_tasks';
import {
  cancelTask,
  getTaskQueue,
  requestPauseAutonomousTask,
  resumeAutonomousTask,
  type AutonomousTask,
} from '../autonomy/task_queue';
import {
  listWorkTakeoverTasks,
  updateWorkTakeoverTask,
  type WorkTakeoverTask,
} from '../work_takeover/tasks';

export type RuntimeWorkKind = 'delegation' | 'autonomy' | 'takeover';

export interface RuntimeWorkItem {
  id: string;
  kind: RuntimeWorkKind;
  title: string;
  status: string;
  updatedAt: string;
  cancellationRequested: boolean;
}

export interface RuntimeWorkSnapshot {
  ok: true;
  status: 'idle' | 'active' | 'paused';
  activeCount: number;
  items: RuntimeWorkItem[];
  observedAt: string;
}

export interface RuntimeWorkCancellationResult {
  ok: true;
  status: 'idle' | 'cancelled' | 'cancelling';
  matchedCount: number;
  cancelledCount: number;
  cancellingCount: number;
  items: RuntimeWorkItem[];
  observedAt: string;
}

function delegationItem(task: BackgroundDelegationTask): RuntimeWorkItem {
  return {
    id: task.id,
    kind: 'delegation',
    title: task.title,
    status: task.status,
    updatedAt: task.updatedAt,
    cancellationRequested: task.cancelRequested,
  };
}

function autonomyItem(task: AutonomousTask): RuntimeWorkItem {
  return {
    id: task.id,
    kind: 'autonomy',
    title: task.title,
    status: task.status,
    updatedAt: task.updatedAt || task.startedAt || task.createdAt,
    cancellationRequested: Boolean(task.cancelRequestedAt),
  };
}

function takeoverItem(task: WorkTakeoverTask): RuntimeWorkItem {
  return {
    id: task.id,
    kind: 'takeover',
    title: task.title,
    status: task.status,
    updatedAt: task.updatedAt,
    cancellationRequested: false,
  };
}

function normalizeKinds(kinds?: RuntimeWorkKind[]): Set<RuntimeWorkKind> {
  const valid = (kinds || []).filter((kind): kind is RuntimeWorkKind => (
    kind === 'delegation' || kind === 'autonomy' || kind === 'takeover'
  ));
  return new Set(valid.length > 0 ? valid : ['delegation', 'autonomy', 'takeover']);
}

export function getRuntimeWorkSnapshot(userId: string, kinds?: RuntimeWorkKind[]): RuntimeWorkSnapshot {
  const selected = normalizeKinds(kinds);
  const items: RuntimeWorkItem[] = [];
  if (selected.has('delegation')) {
    items.push(...listBackgroundTasks(userId)
      .filter(task => ['queued', 'running', 'pausing', 'paused', 'cancelling'].includes(task.status))
      .map(delegationItem));
  }
  if (selected.has('autonomy')) {
    try { items.push(...getTaskQueue(userId).map(autonomyItem)); } catch {}
  }
  if (selected.has('takeover')) {
    try {
      items.push(...listWorkTakeoverTasks({ userId, status: 'active', limit: 200 }).map(takeoverItem));
    } catch {}
  }
  items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const activeCount = items.filter(item => item.status !== 'paused').length;
  return {
    ok: true,
    status: activeCount > 0 ? 'active' : items.length > 0 ? 'paused' : 'idle',
    activeCount,
    items,
    observedAt: new Date().toISOString(),
  };
}

export function pauseRuntimeWork(input: {
  userId: string;
  taskId?: string;
  kinds?: RuntimeWorkKind[];
}) {
  const selected = normalizeKinds(input.kinds);
  const before = getRuntimeWorkSnapshot(input.userId, [...selected]);
  const matched = before.items.filter(item => (
    (!input.taskId || item.id === input.taskId)
    && item.status !== 'paused'
    && (item.kind === 'delegation' || item.kind === 'autonomy')
  ));
  const items: RuntimeWorkItem[] = [];
  for (const item of matched) {
    const task = item.kind === 'delegation'
      ? requestPauseBackgroundTask(item.id, input.userId)
      : requestPauseAutonomousTask(item.id, input.userId);
    if (task) items.push(item.kind === 'delegation' ? delegationItem(task as BackgroundDelegationTask) : autonomyItem(task as AutonomousTask));
  }
  const pausingCount = items.filter(item => item.status === 'pausing').length;
  return {
    ok: true as const,
    status: matched.length === 0 ? 'idle' as const : pausingCount > 0 ? 'pausing' as const : 'paused' as const,
    matchedCount: matched.length,
    pausedCount: items.filter(item => item.status === 'paused').length,
    pausingCount,
    items,
    observedAt: new Date().toISOString(),
  };
}

export function resumeRuntimeWork(input: {
  userId: string;
  taskId?: string;
  kinds?: RuntimeWorkKind[];
}) {
  const selected = normalizeKinds(input.kinds);
  const before = getRuntimeWorkSnapshot(input.userId, [...selected]);
  const matched = before.items.filter(item => (
    (!input.taskId || item.id === input.taskId)
    && item.status === 'paused'
    && (item.kind === 'delegation' || item.kind === 'autonomy')
  ));
  const items: RuntimeWorkItem[] = [];
  for (const item of matched) {
    const task = item.kind === 'delegation'
      ? resumeBackgroundTask(item.id, input.userId)
      : resumeAutonomousTask(item.id, input.userId);
    if (task) items.push(item.kind === 'delegation' ? delegationItem(task as BackgroundDelegationTask) : autonomyItem(task as AutonomousTask));
  }
  return {
    ok: true as const,
    status: matched.length === 0 ? 'idle' as const : 'resumed' as const,
    matchedCount: matched.length,
    resumedCount: items.length,
    items,
    observedAt: new Date().toISOString(),
  };
}

export function cancelRuntimeWork(input: {
  userId: string;
  taskId?: string;
  kinds?: RuntimeWorkKind[];
}): RuntimeWorkCancellationResult {
  const selected = normalizeKinds(input.kinds);
  const before = getRuntimeWorkSnapshot(input.userId, [...selected]);
  const matched = input.taskId
    ? before.items.filter(item => item.id === input.taskId)
    : before.items;

  for (const item of matched) {
    if (item.kind === 'delegation') {
      const task = listBackgroundTasks(input.userId).find(candidate => candidate.id === item.id);
      if (!task) continue;
      if (task.status === 'queued') cancelBackgroundTask(task.id);
      else requestCancelBackgroundTask(task.id, input.userId);
      continue;
    }
    if (item.kind === 'autonomy') {
      cancelTask(item.id, input.userId);
      continue;
    }
    updateWorkTakeoverTask(input.userId, item.id, {
      status: 'cancelled',
      note: 'Cancelled by the user through runtime work control.',
    });
  }

  const afterItems = getRuntimeWorkSnapshot(input.userId, [...selected]).items;
  const outcomeItems = matched.map(item => {
    const remaining = afterItems.find(candidate => candidate.id === item.id);
    if (!remaining) return { ...item, status: 'cancelled', cancellationRequested: true };
    return remaining;
  });
  const cancellingCount = outcomeItems.filter(item => (
    item.status === 'cancelling'
    || (item.status === 'running' && item.cancellationRequested)
  )).length;
  const cancelledCount = outcomeItems.length - cancellingCount;
  return {
    ok: true,
    status: matched.length === 0 ? 'idle' : cancellingCount > 0 ? 'cancelling' : 'cancelled',
    matchedCount: matched.length,
    cancelledCount,
    cancellingCount,
    items: outcomeItems,
    observedAt: new Date().toISOString(),
  };
}
