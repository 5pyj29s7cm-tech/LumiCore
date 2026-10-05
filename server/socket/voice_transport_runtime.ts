import { Socket } from "socket.io";
import { convergeForegroundRequestBeforeRelease, settleConversationActionExecutionRequest, supersedeConversationActionExecutionRequest, type ForegroundRequestIdentity as VoiceForegroundRequestIdentity, type ForegroundRequestReleaseInput, type ForegroundRequestReleaseResult as VoiceForegroundRequestReleaseResult, type ForegroundRequestDurabilityDependencies } from "../conversation/manager";
import { logger } from "../../logger";
import { type AudioSession } from "./voice/session";

/**
 * Keep a failed speech synthesis attempt visible to the active voice client
 * without turning a recoverable TTS outage into a dropped conversation. The
 * text response is still durable; this event only describes the audio lane.
 */
export function emitVoiceTtsFailure(socket: Socket, requestId?: string, lane = 'conversation'): void {
  if (!socket.connected) return;
  socket.emit('audio:tts_error', {
    code: 'TTS_OUTPUT_UNAVAILABLE',
    requestId,
    lane,
    retryable: true,
  });
}

export async function convergeVoiceForegroundRequestBeforeRelease(
  input: ForegroundRequestReleaseInput,
  dependencies: ForegroundRequestDurabilityDependencies = {},
): Promise<VoiceForegroundRequestReleaseResult> {
  return convergeForegroundRequestBeforeRelease({
    ...input,
    channel: 'Voice',
    // Preserve voice's exact-receipt settlement before fail-closed finalization.
    settlePendingTask: () => {
      try {
        settleConversationActionExecutionRequest(
          input.identity.conversationId,
          input.identity.userId,
          input.identity.requestId,
        );
      } catch (error: any) {
        logger.warn(`[Audio] Exact voice task settlement failed before finalization: ${error?.message || String(error)}`);
      }
    },
  }, dependencies);
}

export async function enforceVoiceForegroundConvergenceBeforeRelease(input: {
  identity: VoiceForegroundRequestIdentity | null;
  aborted: boolean;
  reason: string;
  assistantState?: string;
}): Promise<VoiceForegroundRequestReleaseResult | null> {
  if (!input.identity) return null;
  try {
    const result = await convergeVoiceForegroundRequestBeforeRelease({
      identity: input.identity,
      aborted: input.aborted,
      reason: input.reason,
      assistantState: input.assistantState,
    });
    if (!result.converged) {
      logger.error('[Audio] voice_foreground_finalization_incomplete', {
        code: 'VOICE_FOREGROUND_FINALIZATION_INCOMPLETE',
        identity: input.identity,
        convergence: {
          finalStatus: result.convergence.finalStatus,
          reason: result.convergence.reason,
          evidence: result.convergence.evidence,
        },
        finalization: result.finalization ? {
          effectiveOutcome: result.finalization.effectiveOutcome,
          taskStatus: result.finalization.taskStatus,
          actionTurnStatus: result.finalization.actionTurnStatus,
          reason: result.finalization.reason,
          evidence: result.finalization.evidence,
        } : null,
      });
    }
    return result;
  } catch (error: any) {
    logger.error('[Audio] voice_foreground_finalization_failed', {
      code: 'VOICE_FOREGROUND_FINALIZATION_FAILED',
      identity: input.identity,
      errorName: String(error?.name || 'Error'),
      errorMessage: String(error?.message || 'Unknown convergence error'),
    });
    return null;
  }
}

// Module-level ambient noise tracking — used by both processVoiceInput and registerVoiceHandlers
export const voiceTransportState = { ambientRms: 0, ambientRmsLastUpdate: 0, ttsSpeakingCount: 0 };

// TTS playback flag — shared with wake detector to suppress echo during speech

export function isTtsPlaying(): boolean { return voiceTransportState.ttsSpeakingCount > 0; }

export function quiesceActiveVoiceTransport(session: Pick<
  AudioSession,
  'bgGeneration' | 'isSpeaking' | 'ttsPlaybackUntil' | 'ttsAbortController' | 'pipelineAbortController' | 'sidecarAbortController'
>): void {
  session.bgGeneration += 1;
  session.isSpeaking = false;
  session.ttsPlaybackUntil = 0;
  session.ttsAbortController?.abort();
  session.pipelineAbortController?.abort();
  session.sidecarAbortController?.abort();
}

export function captureVoiceTurnOwner(session: AudioSession) {
  const { callControlGeneration, voiceTurnGeneration, sessionId, activeTurnRequestId, pipelineAbortController,
    activeForegroundRequestIdentity, activeRoutingText, activeWorkStep } = session;
  return {
    foregroundIdentity: activeForegroundRequestIdentity,
    interruptedRoutingText: activeRoutingText.trim(),
    assistantState: activeWorkStep || undefined,
    isCurrent: () => session.callControlGeneration === callControlGeneration
      && session.voiceTurnGeneration === voiceTurnGeneration
      && session.sessionId === sessionId
      && (session.activeTurnRequestId === activeTurnRequestId || session.activeTurnRequestId === null)
      && (!session.pipelineAbortController || session.pipelineAbortController === pipelineAbortController),
  };
}

export async function cancelActiveVoiceTurn(
  session: AudioSession,
  preserveInterruptedTurn = false,
  preserveDurableTask = false,
  preserveInputQueue = false,
  owner = captureVoiceTurnOwner(session),
): Promise<boolean> {
  const { foregroundIdentity, interruptedRoutingText } = owner;
  // Quiesce the old transport owner before the first awaited durability step.
  // Previously barge-in waited for convergence while the old model/TTS lane
  // remained live, allowing it to publish or speak after the new utterance.
  if (owner.isCurrent()) quiesceActiveVoiceTransport(session);
  const releaseReason = preserveDurableTask
    ? 'The voice request yielded to an exact continuation before terminal delivery.'
    : 'The active voice request was cancelled before transport resources were released.';
  if (preserveDurableTask && foregroundIdentity?.expectedTaskId) {
    try {
      const supersession = supersedeConversationActionExecutionRequest({
        conversationId: foregroundIdentity.conversationId,
        userId: foregroundIdentity.userId,
        requestId: foregroundIdentity.requestId,
        expectedTaskId: foregroundIdentity.expectedTaskId,
        reason: releaseReason,
        deferLocalOwnerClear: true,
      });
      if (!supersession.superseded) {
        logger.error('[Audio] voice_priority_handoff_supersession_incomplete', {
          code: 'VOICE_PRIORITY_HANDOFF_SUPERSESSION_INCOMPLETE',
          identity: foregroundIdentity,
          effectiveOutcome: supersession.effectiveOutcome,
          taskStatus: supersession.taskStatus,
          actionTurnStatus: supersession.actionTurnStatus,
          reason: supersession.reason,
          evidence: supersession.evidence,
        });
      }
    } catch (error: any) {
      logger.error('[Audio] voice_priority_handoff_supersession_failed', {
        code: 'VOICE_PRIORITY_HANDOFF_SUPERSESSION_FAILED',
        identity: foregroundIdentity,
        errorName: String(error?.name || 'Error'),
        errorMessage: String(error?.message || 'Unknown supersession error'),
      });
    }
  }
  const durableRelease = await enforceVoiceForegroundConvergenceBeforeRelease({
    identity: foregroundIdentity,
    aborted: !preserveDurableTask,
    reason: releaseReason,
    assistantState: owner.assistantState,
  });
  if (foregroundIdentity && !durableRelease?.converged) return false;
  if (!owner.isCurrent()) return false;
  if (preserveInterruptedTurn && interruptedRoutingText) {
    session.pendingInterruptedTurn = {
      text: interruptedRoutingText,
      interruptedAt: Date.now(),
    };
  } else if (!preserveInterruptedTurn) {
    session.pendingInterruptedTurn = null;
  }
  if (!preserveDurableTask) {
    session.activeTaskConversationId = null;
    session.activeTaskRequestId = null;
    session.activeTaskId = null;
  }
  session.bgGeneration++;
  session.isSpeaking = false;
  session.ttsPlaybackUntil = 0;
  session.isProcessing = false;
  if (!preserveInputQueue) session.inputQueue = [];
  session.accumulatedText = '';
  if (session.bargeinTimer) {
    clearTimeout(session.bargeinTimer);
    session.bargeinTimer = null;
  }
  if (session.ttsAbortController) {
    session.ttsAbortController.abort();
    session.ttsAbortController = null;
  }
  if (session.pipelineAbortController) {
    session.pipelineAbortController.abort();
    session.pipelineAbortController = null;
  }
  if (session.sidecarAbortController) {
    session.sidecarAbortController.abort();
    session.sidecarAbortController = null;
  }
  session.sidecarGeneration++;
  if (!preserveInterruptedTurn) session.sidecarHistory = [];
  session.isBackgroundWork = false;
  session.activeWorkStatus = 'idle';
  session.activeWorkStep = '';
  session.activeWorkToolCalls = 0;
  if (session.workHeartbeatTimer) {
    clearInterval(session.workHeartbeatTimer);
    session.workHeartbeatTimer = null;
  }
  session.activeTurnRequestId = null;
  session.activeTurnProvenance = null;
  if (
    !foregroundIdentity
    || session.activeForegroundRequestIdentity?.requestId === foregroundIdentity.requestId
  ) {
    session.activeForegroundRequestIdentity = null;
  }
  const pendingDecayCount = session.ttsDecayTimers.length;
  for (const t of session.ttsDecayTimers) clearTimeout(t);
  session.ttsDecayTimers = [];
  if (pendingDecayCount > 0) {
    voiceTransportState.ttsSpeakingCount = Math.max(0, voiceTransportState.ttsSpeakingCount - pendingDecayCount);
  }
  return true;
}

/**
 * Confirmation and correction are priority continuations of the active durable
 * task. Keep unrelated queued work, but reserve the transport lane immediately
 * so the aborted pipeline's finalizer cannot dequeue and overtake the priority
 * continuation during the 160 ms transcript handoff window.
 */
export async function reservePriorityVoiceHandoff(
  session: AudioSession,
  preserveInterruptedTurn: boolean,
): Promise<boolean> {
  if (!await cancelActiveVoiceTurn(session, preserveInterruptedTurn, true, true)) return false;
  session.isProcessing = true;
  return true;
}

export function interruptVoiceSpeech(session: AudioSession): void {
  session.bgGeneration++;
  session.isSpeaking = false;
  session.ttsPlaybackUntil = 0;
  if (session.ttsAbortController) {
    session.ttsAbortController.abort();
    session.ttsAbortController = null;
  }
  if (session.sidecarAbortController) {
    session.sidecarAbortController.abort();
    session.sidecarAbortController = null;
  }
  session.sidecarGeneration++;
  const pendingDecayCount = session.ttsDecayTimers.length;
  for (const timer of session.ttsDecayTimers) clearTimeout(timer);
  session.ttsDecayTimers = [];
  if (pendingDecayCount > 0) {
    voiceTransportState.ttsSpeakingCount = Math.max(0, voiceTransportState.ttsSpeakingCount - pendingDecayCount);
  }
}

export function getAmbientNoise(): number | null {
  if (Date.now() - voiceTransportState.ambientRmsLastUpdate > 15000) return null; // stale
  return voiceTransportState.ambientRms;
}

export function computeVolumeGain(): number {
  let gain = 1.0;
  const noise = getAmbientNoise();
  if (noise !== null) {
    if (noise > 0.15) gain = 1.2;
    else if (noise > 0.08) gain = 1.1;
    else if (noise < 0.02) gain = 0.85;
  }
  const hour = new Date().getHours();
  if (hour >= 22 || hour < 7) gain = Math.min(gain, 0.8);
  else if (hour >= 7 && hour < 9) gain = Math.min(gain, 0.9);
  return Math.max(0.5, Math.min(1.3, gain));
}

export async function handlePriorityVoiceStop(
  socket: Socket,
  session: AudioSession,
  persistCancellation?: () => Promise<void>,
): Promise<void> {
  const owner = captureVoiceTurnOwner(session);
  const sessionId = session.sessionId;
  const workContinues = session.isBackgroundWork && session.activeWorkStatus !== 'completed';
  const requestId = session.activeTurnRequestId;
  if (workContinues && requestId) session.suppressedSpeechRequestIds.add(requestId);
  if (workContinues) {
    interruptVoiceSpeech(session);
  } else {
    if (persistCancellation) await persistCancellation();
    else await cancelActiveVoiceTurn(session);
  }
  if (!owner.isCurrent()) return;
  socket.emit('audio:status', { status: 'interrupted', requestId, sessionId });
  socket.emit('audio:interrupt-ack', { workContinues, requestId, sessionId });
  socket.emit('audio:status', {
    status: 'listening',
    requestId,
    sessionId,
    ...(workContinues ? { lane: 'work' } : {}),
  });
  resetSilenceTimer(session, socket);
}

export function resetSilenceTimer(session: AudioSession, socket: Socket) {
  if (session.silenceTimer) { clearTimeout(session.silenceTimer); session.silenceTimer = null; }
  session.silenceTimer = setTimeout(() => {
    if (session.isActive && !session.isProcessing) {
      logger.info('[Audio] Silence timeout (5min) — closing STT session');
      if (session.sttSession) {
        session.sttSession.end();
        session.sttSession = null;
      }
      socket.emit("audio:status", { status: "idle" });
    }
  }, 5 * 60 * 1000);
}
