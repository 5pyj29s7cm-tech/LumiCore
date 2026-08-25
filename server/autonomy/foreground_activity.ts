/**
 * Tracks live, user-present voice sessions so background autonomy can yield.
 *
 * A socket key is used instead of a counter so reconnects/restarts are
 * idempotent and cannot leave the user permanently marked as active.
 */
const activeVoiceSessions = new Map<string, Set<string>>();
const lastVoiceActivityAt = new Map<string, number>();
const backgroundAbortControllers = new Map<string, Set<AbortController>>();

const DEFAULT_GRACE_MS = 15_000;
const LIVE_VOICE_PRIORITY_REASON = 'Live user voice session has priority over background autonomy';

function interruptBackgroundWork(userId: string): void {
  const controllers = backgroundAbortControllers.get(userId);
  if (!controllers) return;
  backgroundAbortControllers.delete(userId);
  for (const controller of controllers) {
    if (!controller.signal.aborted) controller.abort(new Error(LIVE_VOICE_PRIORITY_REASON));
  }
}

export function setRealtimeVoiceSessionActive(
  userId: string,
  sessionKey: string,
  active: boolean,
): void {
  const uid = String(userId || '').trim();
  const key = String(sessionKey || '').trim();
  if (!uid || !key) return;

  const sessions = activeVoiceSessions.get(uid) || new Set<string>();
  if (active) {
    sessions.add(key);
    activeVoiceSessions.set(uid, sessions);
    lastVoiceActivityAt.set(uid, Date.now());
    interruptBackgroundWork(uid);
    return;
  }

  sessions.delete(key);
  lastVoiceActivityAt.set(uid, Date.now());
  if (sessions.size > 0) activeVoiceSessions.set(uid, sessions);
  else activeVoiceSessions.delete(uid);
}

export function isRealtimeUserActive(userId?: string, graceMs = DEFAULT_GRACE_MS): boolean {
  const uid = String(userId || '').trim();
  if (!uid) return false;
  if ((activeVoiceSessions.get(uid)?.size || 0) > 0) return true;
  const lastActiveAt = lastVoiceActivityAt.get(uid) || 0;
  return lastActiveAt > 0 && Date.now() - lastActiveAt < Math.max(0, graceMs);
}

/**
 * Creates a race-free interruption signal for background model work. The
 * caller subscribes before checking current activity, so a voice session that
 * starts between the scheduler gate and the provider call still aborts it.
 */
export function createRealtimeVoicePrioritySignal(userId: string): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const uid = String(userId || '').trim();
  const controller = new AbortController();
  if (!uid) return { signal: controller.signal, dispose: () => undefined };

  const controllers = backgroundAbortControllers.get(uid) || new Set<AbortController>();
  controllers.add(controller);
  backgroundAbortControllers.set(uid, controllers);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const current = backgroundAbortControllers.get(uid);
    current?.delete(controller);
    if (current?.size === 0) backgroundAbortControllers.delete(uid);
  };

  if (isRealtimeUserActive(uid)) {
    controller.abort(new Error(LIVE_VOICE_PRIORITY_REASON));
    dispose();
  }
  return { signal: controller.signal, dispose };
}

/** Test-only reset for deterministic module-state assertions. */
export function resetRealtimeUserActivityForTests(): void {
  for (const controllers of backgroundAbortControllers.values()) {
    for (const controller of controllers) controller.abort();
  }
  activeVoiceSessions.clear();
  lastVoiceActivityAt.clear();
  backgroundAbortControllers.clear();
}
