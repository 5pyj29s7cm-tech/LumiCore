export const VOICE_CAPTURE_STALL_MS = 4_000;

export type VoiceCaptureHealth =
  | 'inactive'
  | 'healthy'
  | 'resume_context'
  | 'restart_capture';

export interface VoiceCaptureHealthInput {
  callActive: boolean;
  trackStates: ReadonlyArray<string>;
  audioContextState: string | null;
  lastFrameAt: number;
  now?: number;
  stallMs?: number;
}

/**
 * Classifies the browser capture graph without using signal energy. Silence is
 * valid input: a healthy ScriptProcessor still produces frames while the room
 * is quiet, so only a missing frame clock, ended track, or unusable context is
 * considered a capture failure.
 */
export function classifyVoiceCaptureHealth(input: VoiceCaptureHealthInput): VoiceCaptureHealth {
  if (!input.callActive) return 'inactive';

  const trackStates = input.trackStates.map(state => String(state || '').toLowerCase());
  if (trackStates.length === 0 || !trackStates.some(state => state === 'live')) {
    return 'restart_capture';
  }

  const contextState = String(input.audioContextState || '').toLowerCase();
  if (contextState === 'closed' || !contextState) return 'restart_capture';
  if (contextState === 'suspended' || contextState === 'interrupted') return 'resume_context';

  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const stallMs = Math.max(1_000, Number(input.stallMs) || VOICE_CAPTURE_STALL_MS);
  if (input.lastFrameAt <= 0 || now - input.lastFrameAt > stallMs) return 'restart_capture';
  return 'healthy';
}
