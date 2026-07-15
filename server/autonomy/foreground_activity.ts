/**
 * Tracks live, user-present voice sessions so background autonomy can yield.
 *
 * A socket key is used instead of a counter so reconnects/restarts are
 * idempotent and cannot leave the user permanently marked as active.
 */
const activeVoiceSessions = new Map<string, Set<string>>();
const lastVoiceActivityAt = new Map<string, number>();

const DEFAULT_GRACE_MS = 15_000;

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

/** Test-only reset for deterministic module-state assertions. */
export function resetRealtimeUserActivityForTests(): void {
  activeVoiceSessions.clear();
  lastVoiceActivityAt.clear();
}
