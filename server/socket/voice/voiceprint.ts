import { Socket } from "socket.io";
import { logger } from "../../../logger";
import { type AudioSession } from "./session";
const VOICEPRINT_LOCAL_COMMAND_THRESHOLD = 0.82;

const VOICEPRINT_EMBEDDING_COMMAND_THRESHOLD = 0.66;

const VOICEPRINT_MIN_UTTERANCE_FRAMES = 3;

const VOICEPRINT_MIN_LOCAL_QUALITY = 0.55;


export interface VoiceprintUtteranceDecision {
  required: boolean;
  decided: boolean;
  matched: boolean;
  confidence: number;
  quality: number;
  frameCount: number;
  source: string;
}


export function isVoiceprintUtteranceAccepted(decision: VoiceprintUtteranceDecision): boolean {
  if (!decision.required) return true;
  if (!decision.decided || !decision.matched) return false;
  if (decision.frameCount < VOICEPRINT_MIN_UTTERANCE_FRAMES) return false;
  if (decision.source === 'speechbrain') {
    return decision.confidence >= VOICEPRINT_EMBEDDING_COMMAND_THRESHOLD;
  }
  if (decision.confidence < VOICEPRINT_LOCAL_COMMAND_THRESHOLD) return false;
  if (decision.quality < VOICEPRINT_MIN_LOCAL_QUALITY) return false;
  return true;
}


export function isVoiceprintGateOpen(session: AudioSession): boolean {
  return isVoiceprintUtteranceAccepted({
    required: session.voiceprintRequired,
    decided: session.utteranceVoiceprintDecided,
    matched: session.utteranceVoiceprintMatched,
    confidence: session.utteranceVoiceprintConfidence,
    quality: session.utteranceVoiceprintQuality,
    frameCount: session.utteranceVoiceprintFrameCount,
    source: session.utteranceVoiceprintSource,
  });
}


export function resetUtteranceVoiceprint(session: AudioSession): void {
  session.utteranceVoiceprintDecided = false;
  session.utteranceVoiceprintMatched = false;
  session.utteranceVoiceprintConfidence = 0;
  session.utteranceVoiceprintQuality = 0;
  session.utteranceVoiceprintFrameCount = 0;
  session.utteranceVoiceprintSpeakerLabel = null;
  session.utteranceVoiceprintSource = '';
  session.utteranceVoiceprintLastAt = 0;
}


export function advanceVoiceprintUtterance(socket: Socket, session: AudioSession): void {
  session.voiceprintUtteranceEpoch += 1;
  resetUtteranceVoiceprint(session);
  socket.emit('voiceprint:utterance_reset', { epoch: session.voiceprintUtteranceEpoch });
}


export async function waitForVoiceprintGate(session: AudioSession, timeoutMs = 1_100): Promise<boolean> {
  if (isVoiceprintGateOpen(session)) return true;
  const startedAt = Date.now();
  while (session.isActive && Date.now() - startedAt < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 70));
    if (isVoiceprintGateOpen(session)) return true;
    // A short early sample can be negative and become reliable as the same
    // utterance accumulates. Keep the bounded synchronization window open for
    // a later result, but never borrow identity from another utterance.
  }
  return isVoiceprintGateOpen(session);
}


export function getVoiceprintSpeakerMeta(session: AudioSession): {
  speakerLabel: string | null;
  speakerConfidence: number;
  speakerSource: string;
  speakerMatched: boolean;
} {
  const utteranceMatched = isVoiceprintGateOpen(session) && session.voiceprintRequired;
  const speakerMatched = Boolean(utteranceMatched && session.utteranceVoiceprintSpeakerLabel);
  return {
    speakerLabel: speakerMatched ? session.utteranceVoiceprintSpeakerLabel : null,
    speakerConfidence: utteranceMatched ? session.utteranceVoiceprintConfidence : 0,
    speakerSource: utteranceMatched ? session.utteranceVoiceprintSource : '',
    speakerMatched,
  };
}


export function blockUnverifiedVoice(socket: Socket, session: AudioSession, reason: string): void {
  logger.info(`[Voiceprint] ${reason} (required=${session.voiceprintRequired}, epoch=${session.voiceprintUtteranceEpoch}, decided=${session.utteranceVoiceprintDecided}, matched=${session.utteranceVoiceprintMatched}, conf=${session.utteranceVoiceprintConfidence.toFixed(2)}, quality=${session.utteranceVoiceprintQuality.toFixed(2)}, frames=${session.utteranceVoiceprintFrameCount})`);
  session.accumulatedText = '';
  socket.emit('audio:voice_rejected', { reason: 'voiceprint_unverified' });
}
