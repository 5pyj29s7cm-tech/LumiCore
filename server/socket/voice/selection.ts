import { isVoiceProfileAccessible, voiceProfileScope, listScopedVoiceProfiles } from "../../tts/profile_store";
import { getActiveProvider as getTTSProvider, isTtsCancellationError, listVoices as listTTSVoices, resolveEmotionVoice } from "../../tts/adapter";
import { type TTSProvider } from "../../tts/types";
import { logger } from "../../../logger";
import { loadEmotionalState } from "../../personality/state";
import { getVoicePreference, getConfiguredVoiceModel } from "../../config/voice_preference";
import { type AudioSession, getVoiceStateKey } from "./session";
export interface VoiceSwitchRequest {
  voiceId?: unknown;
  sessionId?: unknown;
}


export type VoiceSwitchSession = Pick<
  AudioSession,
  'isActive' | 'sessionId' | 'userId' | 'domain' | 'orgId' | 'currentVoiceId'
>;


/** Drop provider-specific speaker identity when the realtime call ends. */
export function clearVoiceSessionTtsSelection(
  session: Pick<AudioSession, 'currentVoiceId' | 'voiceSwitchGeneration'>,
): void {
  session.currentVoiceId = null;
  session.voiceSwitchGeneration += 1;
}


export type VoiceStartAsyncFence = 'current' | 'stale_voice_selection' | 'abandon_start';


/**
 * An in-call voice switch invalidates only the pending speaker resolution.
 * The same audio:start request still owns STT initialization. A stopped call
 * or a newer session id, by contrast, invalidates the whole start handler.
 */
export function resolveVoiceStartAsyncFence(input: {
  sessionActive: boolean;
  currentSessionId: string;
  startSessionId: string;
  currentVoiceSwitchGeneration: number;
  startVoiceSwitchGeneration: number;
}): VoiceStartAsyncFence {
  if (!input.sessionActive || input.currentSessionId !== input.startSessionId) {
    return 'abandon_start';
  }
  if (input.currentVoiceSwitchGeneration !== input.startVoiceSwitchGeneration) {
    return 'stale_voice_selection';
  }
  return 'current';
}


export type VoiceSwitchResolution =
  | {
      accepted: true;
      voiceId: string;
      previousVoiceId: string | null;
      sessionId: string;
    }
  | {
      accepted: false;
      reason: 'inactive_session' | 'session_mismatch' | 'invalid_voice_id' | 'voice_profile_scope_mismatch' | 'voice_not_available';
      requestedVoiceId: string;
      currentVoiceId: string | null;
      sessionId: string;
    };


export function normalizeVoiceSwitchId(value: unknown): string {
  const voiceId = String(value || '').trim();
  if (!voiceId || voiceId.length > 256 || /[\u0000-\u001f\u007f]/.test(voiceId)) return '';
  return voiceId;
}


/** Validate and atomically apply a voice change without restarting microphone/STT. */
export function applyVoiceSwitchRequest(
  session: VoiceSwitchSession,
  data: VoiceSwitchRequest,
  canAccess: typeof isVoiceProfileAccessible = isVoiceProfileAccessible,
  isAvailable: (scope: ReturnType<typeof voiceProfileScope>, voiceId: string) => boolean = () => true,
): VoiceSwitchResolution {
  const requestedVoiceId = normalizeVoiceSwitchId(data?.voiceId);
  const requestedSessionId = String(data?.sessionId || '').trim();
  const rejected = (reason: Exclude<VoiceSwitchResolution, { accepted: true }>['reason']): VoiceSwitchResolution => ({
    accepted: false,
    reason,
    requestedVoiceId,
    currentVoiceId: session.currentVoiceId,
    sessionId: session.sessionId,
  });

  if (!session.isActive) return rejected('inactive_session');
  if (!requestedSessionId || requestedSessionId !== session.sessionId) return rejected('session_mismatch');
  if (!requestedVoiceId) return rejected('invalid_voice_id');

  const scope = voiceProfileScope(session.userId, session.domain, session.orgId);
  if (!canAccess(scope, requestedVoiceId)) return rejected('voice_profile_scope_mismatch');
  if (!isAvailable(scope, requestedVoiceId)) return rejected('voice_not_available');

  const previousVoiceId = session.currentVoiceId;
  session.currentVoiceId = requestedVoiceId;
  return {
    accepted: true,
    voiceId: requestedVoiceId,
    previousVoiceId,
    sessionId: session.sessionId,
  };
}


export async function isVoiceSwitchSelectionAvailable(
  scope: ReturnType<typeof voiceProfileScope>,
  voiceId: string,
): Promise<boolean> {
  if (voiceId === 'default') return true;
  const provider = getTTSProvider();
  if (!provider) return false;

  const resolution = await resolveVoiceForProvider(scope, provider, voiceId);
  return resolution.voiceId === voiceId;
}


export interface ProviderVoiceResolution {
  voiceId: string | null;
  requestedVoiceId: string;
  replaced: boolean;
}


export interface LockedVoiceTurnTtsRoute {
  readonly provider: TTSProvider;
  readonly voiceId: string;
  readonly model?: string;
  readonly speechRate?: number;
  readonly pitch?: number;
  readonly volume?: number;
}


/**
 * The identity of a speaker is immutable for one assistant response. Provider
 * settings and live voice changes are intentionally observed by the next
 * response, never half way through a sentence queue already being played.
 */
export function lockVoiceTurnTtsRoute(input: LockedVoiceTurnTtsRoute): LockedVoiceTurnTtsRoute {
  return Object.freeze({ ...input });
}


/** A real provider failure may fall back only before this reply emitted audio. */
export function canFallbackVoiceTurnTtsRoute(input: {
  emittedSegments: number;
  fallbackAttempted: boolean;
  error: unknown;
  signal?: AbortSignal;
}): boolean {
  return input.emittedSegments === 0
    && !input.fallbackAttempted
    && !isTtsCancellationError(input.error, input.signal);
}


/**
 * Keep a live call's voice on the same provider as the active TTS route.
 * Preview requests carry provider/model explicitly, while the realtime socket
 * historically carried only a voice id.  After switching providers that left
 * an Ark/OpenAI voice id paired with relay CosyVoice and produced text without
 * audio.  Prefer the requested id only when it belongs to this provider;
 * otherwise select the first ready scoped voice or provider preset.
 */
export function chooseVoiceForProvider(
  requestedVoiceId: unknown,
  provider: TTSProvider,
  scopedProfiles: any[],
  providerVoices: Array<{ voiceId?: string }>,
): ProviderVoiceResolution {
  const requested = normalizeVoiceSwitchId(requestedVoiceId);
  const readyProfiles = (Array.isArray(scopedProfiles) ? scopedProfiles : []).filter((entry: any) => (
    String(entry?.provider || 'cosyvoice') === provider
    && entry?.status !== 'training'
    && entry?.status !== 'failed'
    && normalizeVoiceSwitchId(entry?.voiceId)
  ));
  const catalogue = (Array.isArray(providerVoices) ? providerVoices : [])
    .map(entry => normalizeVoiceSwitchId(entry?.voiceId))
    .filter(Boolean);
  const requestedProfile = (Array.isArray(scopedProfiles) ? scopedProfiles : [])
    .find((entry: any) => normalizeVoiceSwitchId(entry?.voiceId) === requested);
  const requestedProfileCompatible = Boolean(
    requestedProfile
    && String(requestedProfile.provider || 'cosyvoice') === provider
    && requestedProfile.status !== 'training'
    && requestedProfile.status !== 'failed',
  );

  if (requested && (requestedProfileCompatible || catalogue.includes(requested))) {
    return { voiceId: requested, requestedVoiceId: requested, replaced: false };
  }

  const fallback = normalizeVoiceSwitchId(readyProfiles[0]?.voiceId) || catalogue[0] || null;
  return {
    voiceId: fallback,
    requestedVoiceId: requested,
    replaced: Boolean(requested && fallback !== requested),
  };
}


export async function resolveVoiceForProvider(
  scope: ReturnType<typeof voiceProfileScope>,
  provider: TTSProvider,
  requestedVoiceId: unknown,
): Promise<ProviderVoiceResolution> {
  const profiles = listScopedVoiceProfiles(scope);
  let providerVoices: Array<{ voiceId?: string }> = [];
  try {
    providerVoices = await listTTSVoices(provider);
  } catch (error: any) {
    logger.warn(`[Audio] Could not load ${provider} voice catalogue: ${error?.message || String(error)}`);
  }
  return chooseVoiceForProvider(requestedVoiceId, provider, profiles, providerVoices);
}


export async function resolveSingleVoiceTtsRoute(
  session: Pick<AudioSession, 'userId' | 'domain' | 'orgId' | 'currentVoiceId' | 'personalityId'>,
  provider: TTSProvider,
  requestedVoiceId: string | null,
  emotional = true,
): Promise<LockedVoiceTurnTtsRoute | null> {
  const resolution = await resolveVoiceForProvider(
    voiceProfileScope(session.userId, session.domain, session.orgId),
    provider,
    requestedVoiceId,
  );
  if (!resolution.voiceId) return null;
  const emotionVoice = emotional
    ? (() => {
        try { return resolveEmotionVoice(resolution.voiceId!, loadEmotionalState(getVoiceStateKey(session as AudioSession))); }
        catch { return { voiceId: resolution.voiceId! }; }
      })()
    : { voiceId: resolution.voiceId };
  const preference = getVoicePreference();
  return lockVoiceTurnTtsRoute({
    provider,
    voiceId: emotionVoice.voiceId,
    ...(provider === 'relay' ? { model: getConfiguredVoiceModel('tts', preference) } : {}),
    ...('speechRate' in emotionVoice && emotionVoice.speechRate !== undefined ? { speechRate: emotionVoice.speechRate } : {}),
    ...('pitch' in emotionVoice && emotionVoice.pitch !== undefined ? { pitch: emotionVoice.pitch } : {}),
    ...('volume' in emotionVoice && emotionVoice.volume !== undefined ? { volume: emotionVoice.volume } : {}),
  });
}
