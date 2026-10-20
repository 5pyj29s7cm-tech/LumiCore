// ── Voiceprint ──

export interface VoiceprintTemplate {
  uid: string;
  voiceprintId: string;       // unique ID per voiceprint
  label: string;              // human-readable label e.g. "Owner voice 1"
  mfccFeatures: number[][];   // 13-dim MFCC vectors per audio frame
  embedding?: number[];        // optional mature speaker embedding
  embeddingProvider?: string;  // e.g. speechbrain-ecapa
  embeddingModel?: string;
  embeddingDim?: number;
  sampleCount: number;        // how many audio frames contributed
  createdAt: string;
  lastMatchedAt: string;
}

export interface VoiceprintMatch {
  voiceprintId: string;
  uid: string;
  label: string;
  confidence: number;         // 0..1 cosine similarity
}

export interface VoiceprintVerificationResult {
  matched: boolean;
  isOwner: boolean;
  isStranger: boolean;
  topMatch?: VoiceprintMatch;
  allMatches: VoiceprintMatch[];
  threshold: 'high' | 'medium' | 'low' | 'reject';
  source: 'local' | 'cloud' | 'speechbrain';
}

// ── Face ──

export interface FaceTemplate {
  uid: string;
  faceId: string;
  label: string;
  embedding: number[];        // normalized face feature vector
  createdAt: string;
  lastMatchedAt: string;
}

// ── Presence ──

export interface PresenceState {
  userId: string | null;
  facePresent: boolean;
  faceMatched: boolean;
  faceConfidence: number;
  voiceprintMatched: boolean;
  voiceprintConfidence: number;
  lastFaceSeenAt: number;         // timestamp ms
  lastVoiceHeardAt: number;
  isAway: boolean;
  detectedUsers: DetectedUser[];
}

export interface DetectedUser {
  uid: string;
  username: string;
  faceConfidence: number;
  voiceprintConfidence: number;
  lastDetectedAt: number;
}

export interface PresenceHeartbeat {
  facePresent: boolean;
  faceMatched: boolean;
  faceConfidence: number;
  voiceprintMatched: boolean;
  voiceprintConfidence: number;
}

export interface TripleLockConfig {
  enabled: boolean;
  pinHash?: string;           // bcrypt hash
  autoLockTimeoutMs: number;  // auto-lock after away (default 5 min)
}

// ── Biometric DB Schema ──

export interface BiometricStore {
  voiceprints: VoiceprintTemplate[];
  faces: FaceTemplate[];
  tripleLock: TripleLockConfig | null;
}
