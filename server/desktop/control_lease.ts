import { randomUUID } from 'node:crypto';

export type DesktopControlLeaseStatus = 'waiting' | 'active' | 'paused' | 'released' | 'expired';

export interface DesktopControlWindowBinding {
  title: string;
  processName: string;
  processId?: number;
  nativeWindowHandle?: number;
  displayId?: string;
  fingerprint: string;
  observedAt: string;
}

export interface DesktopControlLeaseSnapshot {
  leaseId: string;
  userId: string;
  taskId: string;
  source: string;
  priority: number;
  status: DesktopControlLeaseStatus;
  reason?: string;
  acquiredAt?: string;
  updatedAt: string;
  expiresAt?: string;
  windowBinding?: DesktopControlWindowBinding;
}

export interface AcquireDesktopControlLeaseInput {
  userId: string;
  taskId: string;
  source: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  leaseMs?: number;
  priority?: number;
  onStateChange?: (snapshot: DesktopControlLeaseSnapshot) => void;
  onPause?: (reason: string) => void;
}

export interface DesktopControlLeaseHandle {
  readonly leaseId: string;
  readonly signal: AbortSignal;
  snapshot(): DesktopControlLeaseSnapshot;
  heartbeat(leaseMs?: number): boolean;
  bindWindow(binding: DesktopControlWindowBinding): boolean;
  release(reason?: string): void;
}

export interface DesktopControlRuntimeSnapshot {
  active: number;
  waiting: number;
  userActivityHolds: number;
  bySource: Record<string, number>;
}

type LeaseEntry = DesktopControlLeaseSnapshot & {
  controller: AbortController;
  holders: number;
  leaseMs: number;
  onStateChange: Set<NonNullable<AcquireDesktopControlLeaseInput['onStateChange']>>;
  onPause: Set<NonNullable<AcquireDesktopControlLeaseInput['onPause']>>;
};

type WaitingEntry = {
  input: AcquireDesktopControlLeaseInput;
  priority: number;
  enqueuedAt: number;
  resolve: (handle: DesktopControlLeaseHandle) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
};

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_WAIT_MS = 30_000;
const USER_ACTIVITY_HOLD_MS = 2_500;
const activeByUser = new Map<string, LeaseEntry>();
const waitersByUser = new Map<string, WaitingEntry[]>();
const userActiveUntil = new Map<string, number>();
const wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const leaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function normalized(value: unknown, fallback: string): string {
  return String(value || '').trim() || fallback;
}

export function desktopControlPriority(source: string): number {
  const value = String(source || '').toLowerCase();
  if (value.includes('voice')) return 100;
  if (value.includes('chat') || value.includes('task')) return 80;
  if (value.includes('messag')) return 60;
  if (value.includes('background')) return 30;
  if (value.includes('autonom')) return 20;
  return 50;
}

function publicSnapshot(entry: LeaseEntry): DesktopControlLeaseSnapshot {
  return {
    leaseId: entry.leaseId,
    userId: entry.userId,
    taskId: entry.taskId,
    source: entry.source,
    priority: entry.priority,
    status: entry.status,
    reason: entry.reason,
    acquiredAt: entry.acquiredAt,
    updatedAt: entry.updatedAt,
    expiresAt: entry.expiresAt,
    windowBinding: entry.windowBinding ? { ...entry.windowBinding } : undefined,
  };
}

function notify(entry: LeaseEntry): void {
  const snapshot = publicSnapshot(entry);
  for (const listener of entry.onStateChange) {
    try { listener(snapshot); } catch {}
  }
}

function clearWakeTimer(userId: string): void {
  const timer = wakeTimers.get(userId);
  if (timer) clearTimeout(timer);
  wakeTimers.delete(userId);
}

function clearLeaseTimer(userId: string): void {
  const timer = leaseTimers.get(userId);
  if (timer) clearTimeout(timer);
  leaseTimers.delete(userId);
}

function scheduleLeaseExpiry(entry: LeaseEntry): void {
  clearLeaseTimer(entry.userId);
  const expiresAt = entry.expiresAt ? new Date(entry.expiresAt).getTime() : Date.now();
  const timer = setTimeout(() => {
    leaseTimers.delete(entry.userId);
    if (activeByUser.get(entry.userId)?.leaseId !== entry.leaseId) return;
    expireIfNeeded(entry.userId);
    dispatchNext(entry.userId);
  }, Math.max(0, expiresAt - Date.now()));
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  leaseTimers.set(entry.userId, timer);
}

function scheduleWake(userId: string): void {
  clearWakeTimer(userId);
  const delay = Math.max(0, (userActiveUntil.get(userId) || 0) - Date.now());
  if (delay <= 0) {
    userActiveUntil.delete(userId);
    dispatchNext(userId);
    return;
  }
  const timer = setTimeout(() => {
    wakeTimers.delete(userId);
    userActiveUntil.delete(userId);
    dispatchNext(userId);
  }, delay);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  wakeTimers.set(userId, timer);
}

function expireIfNeeded(userId: string, now = Date.now()): void {
  const active = activeByUser.get(userId);
  if (!active || !active.expiresAt || new Date(active.expiresAt).getTime() > now) return;
  active.status = 'expired';
  active.reason = 'desktop_control_lease_expired';
  active.updatedAt = nowIso(now);
  active.controller.abort(new Error(active.reason));
  notify(active);
  activeByUser.delete(userId);
  clearLeaseTimer(userId);
}

function pauseEntry(entry: LeaseEntry, reason: string): void {
  if (entry.status !== 'active') return;
  entry.status = 'paused';
  entry.reason = reason;
  entry.updatedAt = nowIso();
  entry.windowBinding = undefined;
  entry.controller.abort(new Error(reason));
  notify(entry);
  for (const listener of entry.onPause) {
    try { listener(reason); } catch {}
  }
  if (activeByUser.get(entry.userId) === entry) {
    activeByUser.delete(entry.userId);
    clearLeaseTimer(entry.userId);
  }
}

function grant(input: AcquireDesktopControlLeaseInput, priority: number): DesktopControlLeaseHandle {
  const now = Date.now();
  const leaseMs = Math.max(10_000, input.leaseMs || DEFAULT_LEASE_MS);
  const entry: LeaseEntry = {
    leaseId: randomUUID(),
    userId: normalized(input.userId, 'anonymous'),
    taskId: normalized(input.taskId, `desktop-task-${randomUUID()}`),
    source: normalized(input.source, 'unknown'),
    priority,
    status: 'active',
    acquiredAt: nowIso(now),
    updatedAt: nowIso(now),
    expiresAt: nowIso(now + leaseMs),
    controller: new AbortController(),
    holders: 1,
    leaseMs,
    onStateChange: new Set(input.onStateChange ? [input.onStateChange] : []),
    onPause: new Set(input.onPause ? [input.onPause] : []),
  };
  activeByUser.set(entry.userId, entry);
  scheduleLeaseExpiry(entry);
  notify(entry);
  return handleFor(entry);
}

function handleFor(entry: LeaseEntry): DesktopControlLeaseHandle {
  let released = false;
  return {
    leaseId: entry.leaseId,
    signal: entry.controller.signal,
    snapshot: () => publicSnapshot(entry),
    heartbeat(leaseMs = entry.leaseMs) {
      if (entry.status !== 'active' || activeByUser.get(entry.userId) !== entry) return false;
      const now = Date.now();
      entry.updatedAt = nowIso(now);
      entry.expiresAt = nowIso(now + Math.max(10_000, leaseMs));
      scheduleLeaseExpiry(entry);
      return true;
    },
    bindWindow(binding) {
      if (entry.status !== 'active' || activeByUser.get(entry.userId) !== entry) return false;
      entry.windowBinding = { ...binding };
      entry.updatedAt = nowIso();
      notify(entry);
      return true;
    },
    release(reason = 'desktop_control_released') {
      if (released) return;
      released = true;
      entry.holders = Math.max(0, entry.holders - 1);
      if (entry.holders > 0 || entry.status !== 'active') return;
      entry.status = 'released';
      entry.reason = reason;
      entry.updatedAt = nowIso();
      entry.windowBinding = undefined;
      notify(entry);
      if (activeByUser.get(entry.userId) === entry) {
        activeByUser.delete(entry.userId);
        clearLeaseTimer(entry.userId);
      }
      dispatchNext(entry.userId);
    },
  };
}

function removeWaiter(userId: string, waiter: WaitingEntry): void {
  const waiters = waitersByUser.get(userId) || [];
  const next = waiters.filter(candidate => candidate !== waiter);
  if (next.length > 0) waitersByUser.set(userId, next);
  else waitersByUser.delete(userId);
  clearTimeout(waiter.timer);
  if (waiter.onAbort && waiter.input.signal) waiter.input.signal.removeEventListener('abort', waiter.onAbort);
}

function dispatchNext(userId: string): void {
  expireIfNeeded(userId);
  if (activeByUser.has(userId)) return;
  if ((userActiveUntil.get(userId) || 0) > Date.now()) {
    scheduleWake(userId);
    return;
  }
  const waiters = waitersByUser.get(userId) || [];
  if (waiters.length === 0) return;
  waiters.sort((left, right) => right.priority - left.priority || left.enqueuedAt - right.enqueuedAt);
  const waiter = waiters[0];
  removeWaiter(userId, waiter);
  if (waiter.input.signal?.aborted) {
    waiter.reject(new Error('Desktop control request cancelled while waiting for the global lease.'));
    dispatchNext(userId);
    return;
  }
  waiter.resolve(grant(waiter.input, waiter.priority));
}

export function acquireDesktopControlLease(input: AcquireDesktopControlLeaseInput): Promise<DesktopControlLeaseHandle> {
  const userId = normalized(input.userId, 'anonymous');
  const taskId = normalized(input.taskId, `desktop-task-${randomUUID()}`);
  const normalizedInput = { ...input, userId, taskId };
  const priority = input.priority ?? desktopControlPriority(input.source);
  if (input.signal?.aborted) {
    return Promise.reject(new Error('Desktop control request cancelled before acquiring the global lease.'));
  }
  expireIfNeeded(userId);
  const active = activeByUser.get(userId);

  if (active && active.taskId === taskId && active.status === 'active') {
    active.holders += 1;
    if (input.onStateChange) active.onStateChange.add(input.onStateChange);
    if (input.onPause) active.onPause.add(input.onPause);
    active.updatedAt = nowIso();
    return Promise.resolve(handleFor(active));
  }

  if (active && priority > active.priority && /autonom|background/i.test(active.source)) {
    pauseEntry(active, `desktop_control_preempted_by_${normalized(input.source, 'foreground')}`);
  }
  if (!activeByUser.has(userId) && (userActiveUntil.get(userId) || 0) <= Date.now()) {
    return Promise.resolve(grant(normalizedInput, priority));
  }

  return new Promise<DesktopControlLeaseHandle>((resolve, reject) => {
    const timeoutMs = Math.max(1_000, input.timeoutMs || DEFAULT_WAIT_MS);
    const waiter: WaitingEntry = {
      input: normalizedInput,
      priority,
      enqueuedAt: Date.now(),
      resolve,
      reject,
      timer: setTimeout(() => {
        removeWaiter(userId, waiter);
        reject(new Error('Desktop control conflict: timed out waiting for the global desktop lease.'));
      }, timeoutMs),
    };
    if (typeof (waiter.timer as any).unref === 'function') (waiter.timer as any).unref();
    if (input.signal) {
      waiter.onAbort = () => {
        removeWaiter(userId, waiter);
        reject(new Error('Desktop control request cancelled while waiting for the global lease.'));
      };
      input.signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    const waiters = waitersByUser.get(userId) || [];
    waiters.push(waiter);
    waitersByUser.set(userId, waiters);
    input.onStateChange?.({
      leaseId: '',
      userId,
      taskId,
      source: normalized(input.source, 'unknown'),
      priority,
      status: 'waiting',
      reason: activeByUser.has(userId) ? 'desktop_control_conflict' : 'user_activity_detected',
      updatedAt: nowIso(),
    });
    if (!activeByUser.has(userId)) scheduleWake(userId);
  });
}

export function reportDesktopUserActivity(
  userId: string,
  holdMs = USER_ACTIVITY_HOLD_MS,
  activityAt?: string | number,
): DesktopControlLeaseSnapshot | null {
  const uid = normalized(userId, 'anonymous');
  const active = activeByUser.get(uid);
  const activityAtMs = typeof activityAt === 'number'
    ? activityAt
    : activityAt
      ? new Date(activityAt).getTime()
      : Number.NaN;
  const acquiredAtMs = active?.acquiredAt ? new Date(active.acquiredAt).getTime() : Number.NaN;
  // Native idle-reset reports are polled and can arrive several seconds late.
  // If the physical input happened before this lease was acquired, it was the
  // input that started the foreground request, not a takeover of Lumi's new
  // desktop work.
  if (
    active
    && Number.isFinite(activityAtMs)
    && Number.isFinite(acquiredAtMs)
    && activityAtMs <= acquiredAtMs + 250
  ) return null;
  userActiveUntil.set(uid, Date.now() + Math.max(500, holdMs));
  if (active) pauseEntry(active, 'desktop_control_paused_for_user_activity');
  scheduleWake(uid);
  return active ? publicSnapshot(active) : null;
}

export function getDesktopControlLease(userId: string): DesktopControlLeaseSnapshot | null {
  const uid = normalized(userId, 'anonymous');
  expireIfNeeded(uid);
  const active = activeByUser.get(uid);
  return active ? publicSnapshot(active) : null;
}

export function getDesktopControlQueueLength(userId?: string): number {
  if (userId) return (waitersByUser.get(normalized(userId, 'anonymous')) || []).length;
  return Array.from(waitersByUser.values()).reduce((sum, waiters) => sum + waiters.length, 0);
}

export function getDesktopControlRuntimeSnapshot(): DesktopControlRuntimeSnapshot {
  const now = Date.now();
  for (const userId of activeByUser.keys()) expireIfNeeded(userId, now);
  const active = Array.from(activeByUser.values()).filter(entry => entry.status === 'active');
  const bySource = active.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.source] = (counts[entry.source] || 0) + 1;
    return counts;
  }, {});
  return {
    active: active.length,
    waiting: getDesktopControlQueueLength(),
    userActivityHolds: Array.from(userActiveUntil.values()).filter(until => until > now).length,
    bySource,
  };
}

export function resetDesktopControlLeasesForTests(): void {
  for (const entry of activeByUser.values()) entry.controller.abort();
  for (const [userId, waiters] of waitersByUser.entries()) {
    for (const waiter of waiters) {
      removeWaiter(userId, waiter);
      waiter.reject(new Error('Desktop control lease manager reset.'));
    }
  }
  for (const timer of wakeTimers.values()) clearTimeout(timer);
  for (const timer of leaseTimers.values()) clearTimeout(timer);
  activeByUser.clear();
  waitersByUser.clear();
  userActiveUntil.clear();
  wakeTimers.clear();
  leaseTimers.clear();
}
