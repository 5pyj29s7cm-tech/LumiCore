import type { PresenceState, PresenceHeartbeat, DetectedUser } from './types';
import { readDB } from '../../db_layer';

const AWAY_TIMEOUT_MS = 5000; // 5s without face or voice → away

const presenceByUser = new Map<string, PresenceState>();

function defaultState(userId: string): PresenceState {
  return {
    userId,
    facePresent: false,
    faceMatched: false,
    faceConfidence: 0,
    voiceprintMatched: false,
    voiceprintConfidence: 0,
    lastFaceSeenAt: 0,
    lastVoiceHeardAt: 0,
    isAway: true,
    detectedUsers: [],
  };
}

export function getPresence(userId: string): PresenceState {
  return presenceByUser.get(userId) || defaultState(userId);
}

export function updatePresence(userId: string, heartbeat: PresenceHeartbeat): PresenceState {
  const prev = getPresence(userId);
  const now = Date.now();

  const next: PresenceState = {
    ...prev,
    userId,
    facePresent: heartbeat.facePresent,
    faceMatched: heartbeat.faceMatched,
    faceConfidence: heartbeat.faceConfidence,
    voiceprintMatched: heartbeat.voiceprintMatched,
    voiceprintConfidence: heartbeat.voiceprintConfidence,
    lastFaceSeenAt: heartbeat.faceMatched ? now : prev.lastFaceSeenAt,
    lastVoiceHeardAt: heartbeat.voiceprintMatched ? now : prev.lastVoiceHeardAt,
  };

  // Determine away state: away if both face and voice are absent for > AWAY_TIMEOUT_MS
  const faceAwayMs = now - next.lastFaceSeenAt;
  const voiceAwayMs = now - next.lastVoiceHeardAt;
  next.isAway = faceAwayMs > AWAY_TIMEOUT_MS && voiceAwayMs > AWAY_TIMEOUT_MS;

  // Detect other registered users from biometric store
  next.detectedUsers = detectOtherUsers(userId);

  // Track state transition
  if (prev.isAway !== next.isAway) {
    console.log(`[Presence] User ${userId}: ${next.isAway ? 'AWAY' : 'PRESENT'}`);
  }

  presenceByUser.set(userId, next);
  return next;
}

function detectOtherUsers(currentUserId: string): DetectedUser[] {
  let db: ReturnType<typeof readDB>;
  try {
    db = readDB();
  } catch {
    return [];
  }
  const users: DetectedUser[] = [];

  for (const row of (db.settings || [])) {
    if (!row.key?.startsWith('biometric_')) continue;
    const uid = row.key.replace('biometric_', '');
    if (uid === currentUserId) continue;

    // A user is "detected" if they have biometrics enrolled AND
    // the current face/voice recognition matched them
    // (in practice, the frontend sends this via heartbeat)
    const presence = presenceByUser.get(uid);
    if (presence && !presence.isAway) {
      const dbUser = (db.users || []).find((u: any) => u.uid === uid);
      users.push({
        uid,
        username: dbUser?.username || uid,
        faceConfidence: presence.faceConfidence,
        voiceprintConfidence: presence.voiceprintConfidence,
        lastDetectedAt: Math.max(presence.lastFaceSeenAt, presence.lastVoiceHeardAt),
      });
    }
  }

  return users;
}

export function isUserAway(userId: string): boolean {
  return getPresence(userId).isAway;
}
