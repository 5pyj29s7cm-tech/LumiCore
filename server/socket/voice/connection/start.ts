import { type AudioSession, normalizeVoiceSessionId, getAudioSession } from "../session";
import { logger } from "../../../../logger";
import { normalizeMeetingId } from "../../meeting_recordings";
import { resolveVoiceForProvider, normalizeVoiceSwitchId, resolveVoiceStartAsyncFence } from "../selection";
import { setRealtimeVoiceSessionActive } from "../../../autonomy/foreground_activity";
import { startMeetingPcmRecording } from "../meetings";
import { createVoiceCaptureProvenance } from "../../voice_provenance";
import { buildSocketNativeRequestBinding } from "../../native_request_binding";
import { getTaskRegressionSyntheticVoiceBinding } from "../../../evidence/task_truth_snapshot_route";
import { resolveSocketScope } from "../../scope";
import { captureChatAuthorization } from "../../chat_authorization";
import { getVoiceprints } from "../../../biometrics/store";
import { resetUtteranceVoiceprint } from "../voiceprint";
import { personalityRegistry } from "../../../personality";
import { isVoiceProfileAccessible, voiceProfileScope } from "../../../tts/profile_store";
import { getActiveProvider as getTTSProvider } from "../../../tts/adapter";
import { cancelActiveVoiceTurn, quiesceActiveVoiceTransport, emitVoiceTtsFailure } from "../../voice_transport_runtime";
import type { VoiceConnectionRuntime } from './connection';
import { startVoiceTranscription } from './transcription';

export type StandardVoiceStartRequest = {
    voiceId?: string;
    personalityId?: string;
    agentId?: string;
    transcriptionOnly?: boolean;
    meetingId?: string;
    domain?: 'personal' | 'work';
    orgId?: string;
    sessionId?: string;
    audioInputKind?: string;
    captureSessionId?: string;
  };

export async function handleStandardVoiceStart(runtime: VoiceConnectionRuntime, data: StandardVoiceStartRequest): Promise<void> {

    logger.info(`[Audio] Voice call started by ${runtime.socket.id}`);
    runtime.cancelProactive();
    const pendingOwner = { sessionId: normalizeVoiceSessionId(data.sessionId), cancelled: false };
    runtime.pendingStandardStart = pendingOwner;
    let admittedSession: AudioSession | undefined;
    const candidate = runtime.callAdmission.claim(async () => {
      pendingOwner.cancelled = true;
      if (admittedSession) await runtime.stopVoiceCall(admittedSession, { source: 'voice_call_replaced', error: { code: 'CALL_REPLACED', message: 'Another voice call started.' } });
    }, 'lumi');
    const reservation = candidate instanceof Promise ? await candidate : candidate;
    if (!reservation.isCurrent() || !runtime.socket.connected || pendingOwner.cancelled || runtime.pendingStandardStart !== pendingOwner) { reservation.release(); return; }
    runtime.pendingStandardStart = undefined;
    const session = getAudioSession(runtime.socket);
    admittedSession = session;
    const startControlGeneration = ++session.callControlGeneration;
    session.stopAuthorizationWatch?.();
    session.stopAuthorizationWatch = undefined;
    // Reserve the incoming id before waiting, so a stop for this pending start
    // can cancel it and old STT callbacks cannot admit work into it.
    session.sessionId = pendingOwner.sessionId;
    const voiceStartSessionId = session.sessionId;
    session.isActive = false;
    if (session.silenceTimer) { clearTimeout(session.silenceTimer); session.silenceTimer = null; }
    const previousSttSession = session.sttSession;
    session.sttSession = null;
    try { previousSttSession?.end(); } catch (error) { logger.warn('[Audio] Previous STT close failed:', error); }
    // Even an inactive call can still have cancellation timers awaiting
    // convergence. The new owner must finish clearing those before admission.
    if (session.userId) {
      setRealtimeVoiceSessionActive(session.userId, runtime.socket.id, false);
      if (session.activeTurnRequestId) {
        await runtime.commitActiveVoiceCancellation(session, { source: 'voice_restarted' });
      } else {
        await cancelActiveVoiceTurn(session);
      }
    }
    if (session.callControlGeneration !== startControlGeneration || !runtime.socket.connected) return;
    session.isActive = true;
    session.voiceSwitchGeneration += 1;
    const voiceStartGeneration = session.voiceSwitchGeneration;
    session.accumulatedText = '';
    session.isSpeaking = false;
    session.isProcessing = false;
    session.isBackgroundWork = false;
    session.activeWorkStatus = 'idle';
    session.activeWorkStep = '';
    session.activeWorkToolCalls = 0;
    session.sidecarAbortController?.abort();
    session.sidecarAbortController = null;
    session.sidecarGeneration++;
    session.sidecarHistory = [];
    session.inputQueue = [];
    session.lastChunkTime = 0;
    session.lastSpeechEndedAt = 0;
    session.lastSpeechStartedAt = 0;
    session.endpointSilenceMs = 850;
    session.lastAcceptedCommandKey = '';
    session.lastAcceptedCommandAt = 0;
    session.lastAcceptedCommandChunkAt = 0;
    session.userId = runtime.getUserId(runtime.socket);
    setRealtimeVoiceSessionActive(session.userId, runtime.socket.id, true);
    const requestedAgentId = String(data.agentId || 'lumi').trim() || 'lumi';
    // Memory Avatars are deliberately text-only, frozen, tool-free surfaces.
    // Voice currently uses the full Lumi execution lane, so accepting a
    // memory_avatar_* id here would silently bypass that boundary. Reject it
    // explicitly until a separately constrained voice lane exists.
    if (requestedAgentId.startsWith('memory_avatar_')) {
      logger.warn(`[Audio] Refused voice start for Memory Avatar lane: ${requestedAgentId}`);
      session.isActive = false;
      setRealtimeVoiceSessionActive(session.userId, runtime.socket.id, false);
      session.agentId = 'lumi';
      runtime.socket.emit('audio:error', {
        code: 'MEMORY_AVATAR_VOICE_UNAVAILABLE',
        message: 'Memory Avatars are available in their private text sanctuary, not in the voice execution lane.',
      });
      return;
    }
    session.agentId = requestedAgentId;
    session.voiceCaptureProvenance = createVoiceCaptureProvenance({
      captureSessionId: String(data.captureSessionId || '') === session.sessionId
        ? data.captureSessionId
        : '',
      audioInputKind: data.audioInputKind,
      nativeBinding: buildSocketNativeRequestBinding(runtime.socket),
      syntheticBinding: getTaskRegressionSyntheticVoiceBinding(),
    });
    session.activeTurnProvenance = null;
    session.activeForegroundRequestIdentity = null;
    const sessionScope = resolveSocketScope(runtime.socket, session.userId, data);
    session.domain = sessionScope.domain;
    session.orgId = sessionScope.orgId;
    if (runtime.socket.data?.authenticatedOrgId && sessionScope.domain !== 'work') {
      await runtime.stopVoiceCall(session, { source: 'voice_authorization_revoked', error: { code: 'ORGANIZATION_ACCESS_CHANGED', message: 'Organization access changed. Start a new authorized session.' } });
      return;
    }
    const authorization = captureChatAuthorization(session.userId, sessionScope);
    session.authorization = authorization;
    const authorizationAbort = new AbortController();
    let authorizationCancellation: Promise<void> | undefined;
    session.cancelAuthorizationTurn = (requestId: string) => {
      if (session.authorization !== authorization || session.activeTurnRequestId !== requestId) return Promise.resolve();
      if (!authorizationCancellation) authorizationCancellation = runtime.commitActiveVoiceCancellation(session, {
        source: 'voice_authorization_revoked',
      }).then(() => undefined);
      return authorizationCancellation;
    };
    authorizationAbort.signal.addEventListener('abort', () => {
      if (session.authorization !== authorization) return;
      session.isActive = false;
      queueMicrotask(() => { if (session.authorization === authorization) session.stopAuthorizationWatch?.(); });
      quiesceActiveVoiceTransport(session);
      session.inputQueue = [];
      if (session.silenceTimer) { clearTimeout(session.silenceTimer); session.silenceTimer = null; }
      const revokedStt = session.sttSession;
      session.sttSession = null;
      try { revokedStt?.end(); } catch { /* The revoked call remains closed. */ }
      setRealtimeVoiceSessionActive(session.userId, runtime.socket.id, false);
      runtime.socket.emit('audio:error', { code: 'ORGANIZATION_ACCESS_CHANGED', message: 'Organization access changed. Start a new authorized session.', sessionId: voiceStartSessionId });
    }, { once: true });
    session.stopAuthorizationWatch = authorization.watch(authorizationAbort);

    session.transcriptionOnly = data.transcriptionOnly === true;
    if (session.meetingCapture) session.meetingCapture.closed = true;
    session.meetingCapture = undefined;
    session.meetingId = normalizeMeetingId(data.meetingId) || session.sessionId;
    session.meetingPcmPath = null;
    session.meetingPcmBytes = 0;
    session.meetingStartedAt = 0;
    if (session.transcriptionOnly) {
      try {
        startMeetingPcmRecording(session);
      } catch (err: any) {
        logger.warn(`[Meeting] Failed to start PCM recording: ${err?.message || err}`);
      }
    }
    const enrolledVoiceprints = session.domain === 'personal' && session.userId ? getVoiceprints(session.userId) : [];
    session.voiceprintRequired = enrolledVoiceprints.length > 0;
    session.voiceprintMatched = !session.voiceprintRequired;
    session.voiceprintConfidence = 0;
    session.voiceprintSpeakerLabel = null;
    session.voiceprintSource = '';
    session.voiceprintLastAt = 0;
    session.voiceprintUtteranceEpoch += 1;
    resetUtteranceVoiceprint(session);
    runtime.socket.emit('voiceprint:utterance_reset', { epoch: session.voiceprintUtteranceEpoch });
    const personalityCfg = personalityRegistry.getForUser(
      data.personalityId || 'lumi',
      session.userId,
      session.domain === 'work' ? session.orgId : undefined,
    );
    // Use explicit voiceId, then personality's TTS voice. Reconcile that id
    // with the active TTS provider before the first utterance; preview calls
    // carry a provider explicitly but the realtime socket does not.
    const requestedVoiceId = normalizeVoiceSwitchId(data.voiceId || personalityCfg?.ttsVoiceId) || null;
    const voiceScope = voiceProfileScope(session.userId, session.domain, session.orgId);
    if (requestedVoiceId && !isVoiceProfileAccessible(voiceScope, requestedVoiceId)) {
      logger.warn(`[Audio] Refused voice profile from another domain: ${requestedVoiceId}`);
      session.currentVoiceId = null;
      runtime.socket.emit('audio:voice_unavailable', {
        reason: 'voice_profile_scope_mismatch',
        requestedVoiceId,
        currentVoiceId: session.currentVoiceId,
        sessionId: session.sessionId,
      });
    } else {
      const activeTtsProvider = getTTSProvider();
      if (activeTtsProvider) {
        try {
          const voiceResolution = await resolveVoiceForProvider(
            voiceScope,
            activeTtsProvider,
            requestedVoiceId,
          );
          if (session.callControlGeneration !== startControlGeneration) return;
          const voiceStartFence = resolveVoiceStartAsyncFence({
            sessionActive: session.isActive,
            currentSessionId: session.sessionId,
            startSessionId: voiceStartSessionId,
            currentVoiceSwitchGeneration: session.voiceSwitchGeneration,
            startVoiceSwitchGeneration: voiceStartGeneration,
          });
          if (voiceStartFence === 'abandon_start') return;
          if (voiceStartFence === 'current') {
            session.currentVoiceId = voiceResolution.voiceId;
            if (voiceResolution.voiceId && voiceResolution.voiceId !== requestedVoiceId) {
              logger.info(
                `[Audio] Reconciled live voice for provider=${activeTtsProvider} requested=${requestedVoiceId || 'none'} resolved=${voiceResolution.voiceId}`,
              );
              runtime.socket.emit('audio:voice_changed', {
                voiceId: voiceResolution.voiceId,
                previousVoiceId: requestedVoiceId,
                sessionId: session.sessionId,
                provider: activeTtsProvider,
                fallback: true,
                reason: 'provider_compatibility',
              });
            }
          }
        } catch (error: any) {
          if (session.callControlGeneration !== startControlGeneration) return;
          const voiceStartFence = resolveVoiceStartAsyncFence({
            sessionActive: session.isActive,
            currentSessionId: session.sessionId,
            startSessionId: voiceStartSessionId,
            currentVoiceSwitchGeneration: session.voiceSwitchGeneration,
            startVoiceSwitchGeneration: voiceStartGeneration,
          });
          if (voiceStartFence === 'abandon_start') return;
          if (voiceStartFence === 'current') {
            session.currentVoiceId = requestedVoiceId;
            logger.warn(
              `[Audio] Could not reconcile live voice for provider=${activeTtsProvider}: ${error?.message || String(error)}`,
            );
            if (!session.transcriptionOnly) emitVoiceTtsFailure(runtime.socket, undefined, 'conversation');
          }
        }
      } else {
        // Preserve the requested id so a provider that recovers during this
        // call can reconcile it at synthesis time. STT remains usable.
        session.currentVoiceId = requestedVoiceId;
        if (!session.transcriptionOnly) emitVoiceTtsFailure(runtime.socket, undefined, 'conversation');
      }
    }
    session.personalityId = data.personalityId || 'lumi';
  return startVoiceTranscription(runtime, session, startControlGeneration, voiceStartSessionId, authorization);
}
