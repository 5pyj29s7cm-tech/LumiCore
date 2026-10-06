import { getAudioSession } from "../session";
import { getChatExecution } from "../../chat_execution_registry";
import { logger } from "../../../../logger";
import { appendMeetingAudio, takeMeetingRecording, findPausedMeetingRecording, removeMeetingRecordingFiles, normalizeMeetingId } from "../../meeting_recordings";
import { normalizeVoiceSwitchId, type VoiceSwitchRequest, isVoiceSwitchSelectionAvailable, applyVoiceSwitchRequest } from "../selection";
import { refineMeetingTranscript, meetingAuthorizationKey } from "../meetings";
import { recordVoiceCaptureChunk } from "../../voice_provenance";
import { resolveSocketScope } from "../../scope";
import { captureChatAuthorization } from "../../chat_authorization";
import { isVoiceProfileAccessible, voiceProfileScope } from "../../../tts/profile_store";
import { getMeetingAudioDir } from "../../../stt/artifact_paths";
import { markVoiceLatencyMilestone, recordVoicePlaybackMetrics } from "../../../monitor/voice_latency_store";
import { updatePresence } from "../../../biometrics/presence";
import { emitVoiceWorkProgress } from "../work_progress";
import { captureVoiceTurnOwner, resetSilenceTimer, interruptVoiceSpeech } from "../../voice_transport_runtime";
import type { VoiceConnectionRuntime } from './connection';

export function registerVoiceCaptureAndControl(runtime: VoiceConnectionRuntime) {


  runtime.socket.on('audio:switch-voice', async (data: VoiceSwitchRequest = {}) => {
    const session = getAudioSession(runtime.socket);
    const switchGeneration = ++session.voiceSwitchGeneration;
    const requestedVoiceId = normalizeVoiceSwitchId(data?.voiceId);
    const scope = voiceProfileScope(session.userId, session.domain, session.orgId);
    const available = requestedVoiceId
      ? await isVoiceSwitchSelectionAvailable(scope, requestedVoiceId)
      : false;
    if (session.voiceSwitchGeneration !== switchGeneration) {
      runtime.socket.emit('audio:voice_unavailable', {
        accepted: false,
        reason: 'voice_switch_superseded',
        requestedVoiceId,
        currentVoiceId: session.currentVoiceId,
        sessionId: session.sessionId,
      });
      return;
    }
    const resolution = applyVoiceSwitchRequest(
      session,
      data,
      isVoiceProfileAccessible,
      () => available,
    );
    if (!resolution.accepted) {
      runtime.socket.emit('audio:voice_unavailable', resolution);
      return;
    }

    runtime.socket.emit('audio:voice_changed', {
      voiceId: resolution.voiceId,
      previousVoiceId: resolution.previousVoiceId,
      sessionId: resolution.sessionId,
    });
  });

  const resolveMeetingRequest = (data: { meetingId?: string; refinementId?: string }) => {
    const userId = runtime.getUserId(runtime.socket);
    const scope = resolveSocketScope(runtime.socket, userId);
    if (!userId || (runtime.socket.data?.authenticatedOrgId && scope.domain !== 'work')) throw new Error('Organization access changed.');
    const meetingId = normalizeMeetingId(data?.meetingId);
    if (!meetingId) throw new Error('A meeting identity is required.');
    const authorization = captureChatAuthorization(userId, scope);
    const directory = getMeetingAudioDir({ userId, domain: scope.domain, orgId: scope.orgId });
    const recording = findPausedMeetingRecording(directory, meetingId, meetingAuthorizationKey(userId, scope), authorization.isCurrent);
    return { recording, snapshot: { ...getAudioSession(runtime.socket), ...scope, userId, meetingId, authorization } };
  };
  runtime.socket.on('meeting:refine', (data: { meetingId?: string; refinementId?: string }) => {
    const identity = { meetingId: normalizeMeetingId(data?.meetingId), refinementId: normalizeMeetingId(data?.refinementId) };
    try {
      const { recording, snapshot } = resolveMeetingRequest(data);
      const detached = recording && takeMeetingRecording(recording);
      if (!detached) throw new Error('No paused recording is available; keeping the live transcript.');
      void refineMeetingTranscript(runtime.io, runtime.socket, snapshot, detached, identity.refinementId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Meeting recording is unavailable.';
      runtime.socket.emit('meeting:refine_error', { ...identity, message, ...(/authorization|Organization access/i.test(message) ? { reason: 'authorization_revoked' } : {}) });
    }
  });
  runtime.socket.on('meeting:discard', (data: { meetingId?: string }) => {
    try {
      const { recording } = resolveMeetingRequest(data);
      const detached = recording && takeMeetingRecording(recording);
      if (detached) removeMeetingRecordingFiles(detached);
    } catch { /* A discard never grants access to a recording owned by another identity. */ }
  });

  let chunkCount = 0;
  runtime.socket.on("audio:chunk", (data: Buffer) => {
    const session = getAudioSession(runtime.socket);
    if (!session.isActive || session.authorization?.isCurrent() === false) return;
    session.lastChunkTime = Date.now();
    resetSilenceTimer(session, runtime.socket);
    if (session.transcriptionOnly && session.meetingPcmPath) {
      try {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (session.meetingCapture) appendMeetingAudio(session.meetingCapture, chunk);
        session.meetingPcmBytes = session.meetingCapture?.bytes || 0;
      } catch (err: any) {
        logger.warn(`[Meeting] Failed to append PCM chunk: ${err?.message || err}`);
      }
    }
    if (session.sttSession) {
      recordVoiceCaptureChunk(session.voiceCaptureProvenance);
      session.sttSession.sendAudio(data);
      chunkCount++;
      if (chunkCount === 1 || chunkCount % 50 === 0) {
        const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data);
        let sumSquares = 0;
        let peak = 0;
        const sampleCount = Math.floor(pcm.length / 2);
        for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
          const normalized = pcm.readInt16LE(offset) / 32768;
          sumSquares += normalized * normalized;
          peak = Math.max(peak, Math.abs(normalized));
        }
        const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
        logger.info(
          `[Audio] Sent ${chunkCount} chunks (${data.length} bytes each, rms=${rms.toFixed(4)}, peak=${peak.toFixed(4)})`,
        );
      }
    }
  });

  // ── Voiceprint: receive MFCC match results from frontend hook ──
  runtime.socket.on("voiceprint:result", (data: { isOwnerSpeaking: boolean; confidence: number; speakerLabel?: string | null; source?: string; quality?: number; frameCount?: number; reason?: string; utteranceEpoch?: number }) => {
    const session = getAudioSession(runtime.socket);
    if (session.domain === 'work') return;
    session.voiceprintMatched = data.isOwnerSpeaking === true;
    session.voiceprintConfidence = Number(data.confidence) || 0;
    session.voiceprintSpeakerLabel = data.speakerLabel || null;
    session.voiceprintSource = data.source || '';
    session.voiceprintLastAt = Date.now();

    const resultEpoch = Number(data.utteranceEpoch);
    if (
      session.voiceprintRequired
      && (!Number.isInteger(resultEpoch) || resultEpoch !== session.voiceprintUtteranceEpoch)
    ) {
      logger.info(`[Voiceprint] Ignored stale/untagged result epoch=${Number.isFinite(resultEpoch) ? resultEpoch : '-'} current=${session.voiceprintUtteranceEpoch}`);
      return;
    }

    session.utteranceVoiceprintDecided = true;
    session.utteranceVoiceprintMatched = data.isOwnerSpeaking === true;
    session.utteranceVoiceprintConfidence = Number(data.confidence) || 0;
    session.utteranceVoiceprintQuality = Number(data.quality) || 0;
    session.utteranceVoiceprintFrameCount = Math.max(0, Math.floor(Number(data.frameCount) || 0));
    session.utteranceVoiceprintSpeakerLabel = data.speakerLabel || null;
    session.utteranceVoiceprintSource = data.source || '';
    session.utteranceVoiceprintLastAt = Date.now();
    logger.info(`[Voiceprint] result epoch=${resultEpoch} source=${data.source || 'unknown'} matched=${data.isOwnerSpeaking} conf=${session.utteranceVoiceprintConfidence.toFixed(2)} quality=${session.utteranceVoiceprintQuality.toFixed(2)} frames=${session.utteranceVoiceprintFrameCount} reason=${data.reason || '-'}`);
  });

  runtime.socket.on('audio:playback_started', (data: { requestId?: string; lane?: string; durationMs?: number; clientDecodeMs?: number; clientReceiptToPlaybackMs?: number }) => {
    const requestId = String(data?.requestId || '').trim();
    if (!requestId.startsWith('voice_')) return;
    const session = getAudioSession(runtime.socket);
    const durationMs = Math.max(250, Math.min(120_000, Number(data?.durationMs) || 3_000));
    session.ttsPlaybackUntil = Math.max(session.ttsPlaybackUntil, Date.now() + durationMs + 250);
    recordVoicePlaybackMetrics(requestId, data);
    markVoiceLatencyMilestone(requestId, 'firstPlaybackAt');
    logger.info(
      `[Audio Playback] Acknowledged request=${requestId} lane=${data?.lane || 'conversation'} durationMs=${durationMs}`,
    );
  });

  // ── Presence: periodic heartbeat from usePresence hook ──
  runtime.socket.on("presence:heartbeat", (data: { facePresent: boolean; faceMatched?: boolean; faceConfidence: number; voiceprintMatched: boolean; voiceprintConfidence: number }) => {
    const userId = runtime.getUserId(runtime.socket);
    const presenceScope = resolveSocketScope(runtime.socket, userId);
    if (presenceScope.domain === 'work') {
      runtime.socket.emit('presence:state_change', { isAway: true, status: 'unavailable_in_organization' });
      return;
    }
    const state = updatePresence(userId, {
      facePresent: data.facePresent === true,
      faceMatched: data.faceMatched === true,
      faceConfidence: Number(data.faceConfidence) || 0,
      voiceprintMatched: data.voiceprintMatched === true,
      voiceprintConfidence: Number(data.voiceprintConfidence) || 0,
    });
    const status = state.isAway ? 'away' : (state.faceMatched || state.voiceprintMatched ? 'present' : 'uncertain');
    runtime.socket.emit('presence:state_change', { isAway: state.isAway, status });
  });

  runtime.socket.on('audio:interrupt-candidate', (data?: {
    source?: string;
    rms?: number;
    threshold?: number;
    frames?: number;
    ttsAgeMs?: number;
  }) => {
    const session = getAudioSession(runtime.socket);
    logger.info(`[Audio] Interrupt candidate source=${String(data?.source || 'unknown')} rms=${Number(data?.rms || 0).toFixed(4)} threshold=${Number(data?.threshold || 0).toFixed(4)} frames=${Math.max(0, Number(data?.frames || 0))} ttsAgeMs=${Math.max(0, Number(data?.ttsAgeMs || 0))} speaking=${session.isSpeaking} processing=${session.isProcessing} request=${session.activeTurnRequestId || 'none'}`);
  });

  runtime.socket.on("audio:interrupt", async (data?: { source?: string; sessionId?: string; requestId?: string }) => {
    logger.info(`[Audio] Interrupt source=${String(data?.source || 'legacy')} socket=${runtime.socket.id}`);
    const session = getAudioSession(runtime.socket);
    if (data?.sessionId && data.sessionId !== session.sessionId) return;
    if (data?.requestId && data.requestId !== session.activeTurnRequestId) return;
    const owner = captureVoiceTurnOwner(session);
    const sessionId = session.sessionId;
    const requestId = session.activeTurnRequestId;
    if (session.isBackgroundWork && session.isProcessing && session.pipelineAbortController) {
      const workRequestId = session.activeTurnRequestId;
      if (workRequestId) session.suppressedSpeechRequestIds.add(workRequestId);
      interruptVoiceSpeech(session);
      runtime.socket.emit("audio:status", { status: "interrupted", sessionId, requestId: workRequestId });
      runtime.socket.emit("audio:interrupt-ack", { workContinues: true, sessionId, requestId: workRequestId });
      return;
    }
    await runtime.commitActiveVoiceCancellation(session, { source: 'voice_interrupt' });
    if (!owner.isCurrent()) return;
    runtime.socket.emit("audio:status", { status: "interrupted", sessionId, requestId });
    runtime.socket.emit("audio:interrupt-ack", { workContinues: false, sessionId, requestId });
  });

  runtime.socket.on('audio:cancel_turn', async (data?: { requestId?: string; reason?: string; sessionId?: string }) => {
    const session = getAudioSession(runtime.socket);
    if (data?.sessionId && data.sessionId !== session.sessionId) return;
    const owner = captureVoiceTurnOwner(session);
    const sessionId = session.sessionId;
    const requestId = session.activeTurnRequestId;
    if (!requestId || (data?.requestId && data.requestId !== requestId)) return;
    if (data?.reason === 'thinking_watchdog') {
      logger.warn(`[Audio] Ignored legacy UI watchdog cancellation for live request ${requestId}`);
      if (session.isBackgroundWork && session.isProcessing) {
        emitVoiceWorkProgress(
          runtime.socket,
          session,
          requestId,
          session.activeWorkStatus,
          undefined,
          true,
        );
      } else {
        runtime.socket.emit('audio:status', { status: 'thinking', requestId });
      }
      return;
    }
    logger.warn(`[Audio] Cancelling stuck voice turn ${requestId} (${data?.reason || 'client_request'})`);
    await runtime.commitActiveVoiceCancellation(session, {
      source: 'voice_turn_cancelled',
    });
    if (!owner.isCurrent()) return;
    runtime.socket.emit('audio:interrupt-ack', { workContinues: false, requestId, sessionId });
    runtime.socket.emit('audio:status', { status: 'listening', requestId, sessionId });
    resetSilenceTimer(session, runtime.socket);
  });

  runtime.socket.on('audio:work_status_probe', (data?: { requestId?: string; lane?: string }) => {
    const session = getAudioSession(runtime.socket);
    const requestId = session.activeTurnRequestId;
    const requestedRequestId = String(data?.requestId || '').trim();
    if (requestedRequestId) {
      const recovered = getChatExecution({
        userId: session.userId,
        domain: session.domain,
        orgId: session.orgId,
        source: 'voice',
      }, requestedRequestId);
      if (recovered?.terminalEvent) {
        runtime.socket.emit(recovered.terminalEvent.event, recovered.terminalEvent.payload);
        runtime.socket.emit('audio:status', { status: 'listening', requestId: requestedRequestId });
        return;
      }
      if (recovered && !recovered.terminal && !requestId) {
        runtime.socket.emit('audio:status', {
          status: recovered.status === 'waiting_confirmation' ? 'listening' : 'thinking',
          requestId: requestedRequestId,
          lane: data?.lane || 'work',
        });
        return;
      }
    }
    if (!requestId || (data?.requestId && data.requestId !== requestId)) {
      runtime.socket.emit('audio:status', { status: 'listening', requestId: data?.requestId });
      return;
    }
    if (session.isBackgroundWork && session.isProcessing) {
      emitVoiceWorkProgress(
        runtime.socket,
        session,
        requestId,
        session.activeWorkStatus,
        undefined,
        true,
      );
      return;
    }
    runtime.socket.emit('audio:status', {
      status: session.isProcessing ? 'thinking' : 'listening',
      requestId,
      lane: data?.lane || 'conversation',
    });
  });

  runtime.socket.on("audio:stop", async (data?: { refineTranscript?: boolean; preserveMeeting?: boolean; refinementId?: string; sessionId?: string }) => {
    logger.info(`[Audio] Voice call ended by ${runtime.socket.id}`);
    if (runtime.pendingStandardStart && (!data?.sessionId || data.sessionId === runtime.pendingStandardStart.sessionId)) {
      runtime.pendingStandardStart.cancelled = true;
      runtime.pendingStandardStart = undefined;
      return;
    }
    const session = getAudioSession(runtime.socket);
    if (data?.sessionId && session.sessionId && data.sessionId !== session.sessionId) return;
    await runtime.stopVoiceCall(session, { source: 'voice_call_stopped', refineTranscript: data?.refineTranscript, preserveMeeting: data?.preserveMeeting, refinementId: data?.refinementId });
  });
}
