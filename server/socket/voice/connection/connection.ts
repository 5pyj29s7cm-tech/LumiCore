import type { Server, Socket } from "socket.io";
import type { LLMGetters as LlmGetters } from "../../../llm/dispatch";
import type { AudioSession } from "../session";
import { getOrCreateActiveConversation, addMessageIdempotent, cancelConversationActionExecution, updateAssistantMessageTerminalPresentation } from "../../../conversation/manager";
import { CN_TASK_EXECUTION_MESSAGES } from "../../../regions/messages/task_execution_messages";
import { buildForegroundTaskCompletionFeedback } from "../../../cognition/acceptance_evidence";
import { recordChatExecutionPersistenceUnknownDurably, recordChatExecutionTerminalEventDurably, type ChatExecutionScope } from "../../chat_execution_registry";
import { voiceDurabilityUnknownText } from "../../voice_durability";
import { commitChatTerminalBoundary } from "../../chat_terminal_boundary";
import { flushDBOrThrow } from "../../../../db_layer";
import { logger } from "../../../../logger";
import { takeMeetingRecording, removeMeetingRecordingFiles, normalizeMeetingId } from "../../meeting_recordings";
import { clearVoiceSessionTtsSelection } from "../selection";
import { setRealtimeVoiceSessionActive } from "../../../autonomy/foreground_activity";
import { refineMeetingTranscript } from "../meetings";
import { randomUUID } from "node:crypto";
import { createVoiceCallAdmission } from "../../voice_call_admission";
import { captureVoiceTurnOwner, cancelActiveVoiceTurn, quiesceActiveVoiceTransport } from "../../voice_transport_runtime";

export type ProactiveContext = { contextId: string; userId: string; domain: 'personal' | 'work'; orgId: string; voiceId: string | null; enabled: boolean };

export function createVoiceConnectionRuntime(socket: Socket, llmGetters: LlmGetters, sensoryFn: (uid: string) => any, getUserId: (s: Socket) => string, io: Server) {

  const commitActiveVoiceCancellation = async (
    session: AudioSession,
    options: {
      text?: string;
      source?: string;
      publish?: boolean;
      preserveInterruptedTurn?: boolean;
    } = {},
  ): Promise<boolean> => {
    const owner = captureVoiceTurnOwner(session);
    const { userId, agentId, personalityId, domain, orgId } = session;
    const requestId = session.activeTurnRequestId;
    if (!requestId || !userId) {
      await cancelActiveVoiceTurn(session, options.preserveInterruptedTurn === true);
      return false;
    }
    const collector = session.activeExecutionReceipts?.requestId === requestId
      ? session.activeExecutionReceipts : undefined;
    const conversationId = owner.foregroundIdentity?.conversationId || session.activeTaskConversationId
      || getOrCreateActiveConversation(userId, agentId, domain, orgId).id;
    const performCancellation = async (): Promise<boolean> => {
      // Cancellation owns the terminal now. Abort the old transport pipeline
      // before persistence can yield, so it cannot race in a late success.
      quiesceActiveVoiceTransport(session);
      const receiptState = await collector?.settle();
      const cancellationRecords = receiptState?.records || [];
      const unsettled = receiptState?.settled === false;
      const source = options.source || 'voice_cancelled';
      const text = unsettled ? CN_TASK_EXECUTION_MESSAGES.cancellationOutcomeUnknown
        : options.text || CN_TASK_EXECUTION_MESSAGES.cancelled;
      const taskId = owner.foregroundIdentity?.expectedTaskId;
      const completionFeedback = taskId ? buildForegroundTaskCompletionFeedback({
        taskId, taskLabel: owner.interruptedRoutingText || text, toolRecords: cancellationRecords,
        ...(unsettled ? { blocked: true } : { status: 'cancelled' as const }),
        reason: unsettled ? 'tool_settlement_unknown' : 'cancelled',
      }) : { status: 'cancelled' as const, incomplete: [text], nextSteps: [] };
      const scope: ChatExecutionScope = {
        userId,
        domain,
        orgId,
        source: 'voice',
        conversationId,
      };
      const terminalPayload = {
        text,
        source,
        channel: 'voice',
        requestId,
        conversationId,
        finalized: true,
        blocked: true,
        reason: unsettled ? 'execution_settlement_unknown' : 'cancelled',
        completionFeedback,
      };
      const unknownPayload = {
        text: voiceDurabilityUnknownText(),
        agentName: 'Lumi',
        source: 'voice',
        channel: 'voice',
        requestId,
        conversationId,
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      };
      const shouldPublish = options.publish !== false;
      const committed = await commitChatTerminalBoundary({
        // Assistant + actual receipts + terminal disposition share one barrier.
        // Cancelling the ledger first would detach these receipts from the turn.
        persistTerminalState: () => undefined,
        persistAssistantMessage: () => {
          const updated = updateAssistantMessageTerminalPresentation({
            userId,
            conversationId,
            requestId,
            content: text,
            channel: 'voice',
            completionFeedback,
          });
          if (updated) {
            if (!unsettled) cancelConversationActionExecution(conversationId, userId, 'The active voice request was cancelled.', requestId);
            return;
          }
          addMessageIdempotent({
            userId,
            agentId,
            conversationId,
            role: 'assistant',
            content: text,
            personality: personalityId,
            mode: 'voice',
            channel: 'voice',
            cognitiveIntent: 'voice_turn_cancelled',
            llmWasCalled: false,
            domain,
            orgId,
            requestId,
            toolCalls: cancellationRecords.length ? cancellationRecords : undefined,
            completionFeedback,
            ...(taskId ? { terminalTaskDisposition: {
              outcome: unsettled ? 'blocked' as const : 'cancelled' as const,
              taskId, requestId,
              reason: unsettled ? 'tool_settlement_unknown' : 'The active voice request was cancelled.',
            } } : {}),
          });
        },
        flush: flushDBOrThrow,
        persistTerminalReceipt: () => recordChatExecutionTerminalEventDurably(
          scope,
          requestId,
          'agent:response',
          terminalPayload,
          unknownPayload,
        ),
        persistUnknownReceipt: () => recordChatExecutionPersistenceUnknownDurably(
          scope,
          requestId,
          unknownPayload,
        ),
        publishCommitted: () => {
          if (!shouldPublish || !socket.connected || !owner.isCurrent()) return;
          socket.emit('agent:response', terminalPayload);
          socket.emit('chat:conversation_updated', {
            conversationId,
            agentId,
            source,
            requestId,
          });
        },
        publishUnknown: () => {
          if (shouldPublish && socket.connected && owner.isCurrent()) socket.emit('agent:response', unknownPayload);
        },
        persistenceUnknownProjection: {
          text: unknownPayload.text,
          reason: 'Terminal persistence outcome is unknown.',
        },
        onPersistenceError: error => logger.warn('[Audio] Voice cancellation persistence failed:', error),
      });
      await cancelActiveVoiceTurn(session, options.preserveInterruptedTurn === true, false, false, owner);
      return committed;
    };
    return collector ? collector.cancelOnce(performCancellation) : performCancellation();
  };

  const stopVoiceCall = async (
    session: AudioSession,
    options: { source: string; refineTranscript?: boolean; preserveMeeting?: boolean; refinementId?: string; publish?: boolean; error?: { code: string; message: string } },
  ): Promise<void> => {
    const generation = ++session.callControlGeneration;
    session.stopAuthorizationWatch?.();
    session.stopAuthorizationWatch = undefined;
    const { sessionId, userId, meetingCapture } = session;
    const meetingSession = { ...session };
    const shouldRefineMeeting = session.transcriptionOnly && options.refineTranscript === true;
    if (meetingCapture) meetingCapture.closed = true;
    const stoppedRecording = meetingCapture && (shouldRefineMeeting || !options.preserveMeeting)
      ? takeMeetingRecording(meetingCapture.recording) : null;
    session.meetingCapture = undefined;
    // Stop admission synchronously; durable cancellation may wait for storage.
    session.isActive = false;
    clearVoiceSessionTtsSelection(session);
    if (session.silenceTimer) { clearTimeout(session.silenceTimer); session.silenceTimer = null; }
    const sttSession = session.sttSession;
    session.sttSession = null;
    try { sttSession?.end(); } catch (error) { logger.warn('[Audio] STT close failed:', error); }
    session.transcriptionOnly = false;
    session.meetingPcmPath = null;
    session.meetingPcmBytes = 0;
    try {
      await commitActiveVoiceCancellation(session, { source: options.source, publish: false });
    } finally {
      // A newer start owns the same socket's priority registration and UI.
      if (session.callControlGeneration === generation) {
        setRealtimeVoiceSessionActive(userId, socket.id, false);
        if (options.publish !== false && socket.connected) {
          socket.emit('audio:status', { status: 'idle', sessionId });
          if (options.error) socket.emit('audio:error', { ...options.error, sessionId });
        }
      }
      if (stoppedRecording) {
        if (shouldRefineMeeting) void refineMeetingTranscript(io, socket, meetingSession, stoppedRecording, normalizeMeetingId(options.refinementId) || randomUUID());
        else removeMeetingRecordingFiles(stoppedRecording);
      } else if (shouldRefineMeeting && socket.connected) {
        socket.emit('meeting:refine_error', { meetingId: meetingSession.meetingId, refinementId: normalizeMeetingId(options.refinementId), sessionId, message: 'The meeting recording is unavailable; keeping the live transcript.' });
      }
    }
  };

  const callAdmission = createVoiceCallAdmission();
  let pendingStandardStart: { sessionId: string; cancelled: boolean } | undefined;
  let proactiveContext: ProactiveContext | null = null;
  let proactiveController: AbortController | null = null;
  const cancelProactive = () => { proactiveController?.abort(); proactiveController = null; };
  return {
    socket,
    llmGetters,
    sensoryFn,
    getUserId,
    io,
    commitActiveVoiceCancellation,
    stopVoiceCall,
    callAdmission,
    get pendingStandardStart() { return pendingStandardStart; },
    set pendingStandardStart(value: { sessionId: string; cancelled: boolean } | undefined) { pendingStandardStart = value; },
    get proactiveContext() { return proactiveContext; },
    set proactiveContext(value: ProactiveContext | null) { proactiveContext = value; },
    get proactiveController() { return proactiveController; },
    set proactiveController(value: AbortController | null) { proactiveController = value; },
    cancelProactive,
  };
}

export type VoiceConnectionRuntime = ReturnType<typeof createVoiceConnectionRuntime>;
