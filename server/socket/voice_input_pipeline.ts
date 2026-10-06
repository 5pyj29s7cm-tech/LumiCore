import { Server, Socket } from "socket.io";
import { type AudioSession, type VoiceInputTiming } from "./voice/session";
import type { LLMGetters as LlmGetters } from '../llm/dispatch';
import { type ConversationResourceLifetime } from '../cognition/conversation_execution';
import { logger } from "../../logger";
import { getOrCreateActiveConversation, addMessageIdempotent, getMessages, setConversationActionExecutionStatus } from "../conversation/manager";
import { CN_VOICE_WORK_MESSAGES, formatCnToolFailureDetail } from "../regions/messages/voice_fast_path_messages";
import { voiceDurabilityUnknownText } from './voice_durability';
import { recordChatExecutionPersistenceUnknownDurably, recordChatExecutionTerminalEventDurably, type ChatExecutionScope } from './chat_execution_registry';
import { commitChatTerminalBoundary } from './chat_terminal_boundary';
import { flushDBOrThrow } from "../../db_layer";
import { processVoiceInput } from "./voice_conversation_turn";
import { cancelActiveVoiceTurn } from "./voice_transport_runtime";

export async function runVoiceInputPipeline(
  socket: Socket,
  session: AudioSession,
  userText: string,
  llmGetters: LlmGetters,
  sensoryFn: (uid: string) => any,
  io: Server,
  userReceivedAt = new Date().toISOString(),
  voiceAuthorized = false,
  inputTiming: VoiceInputTiming = {},
): Promise<void> {
  const originalAuthorization = session.authorization;
  const resources: ConversationResourceLifetime = {};
  try {
    await processVoiceInput(socket, session, userText, llmGetters, sensoryFn, io, userReceivedAt, voiceAuthorized, inputTiming, resources);
  } catch (err: any) {
    if (originalAuthorization && !originalAuthorization.isCurrent()) {
      if (session.authorization === originalAuthorization && session.activeTurnRequestId) {
        await session.cancelAuthorizationTurn?.(session.activeTurnRequestId);
      }
      return;
    }
    logger.error('[Voice Error]:', err);
    const failedRequestId = session.activeTurnRequestId;
    const queuedWork = session.inputQueue.slice();
    let conversationId = session.activeTaskConversationId || '';
    let terminalResponseAlreadyPersisted = false;
    try {
      if (!conversationId) {
        conversationId = getOrCreateActiveConversation(
          session.userId,
          session.agentId,
          session.domain,
          session.orgId,
        ).id;
      }
      terminalResponseAlreadyPersisted = getMessages(conversationId, 4).some((message: any) => (
        message?.role === 'assistant'
        && Boolean(failedRequestId)
        && (
          message?.requestId === failedRequestId
          || message?.externalMessageId === failedRequestId
        )
      ));
      if (!terminalResponseAlreadyPersisted && failedRequestId) {
        const failureText = CN_VOICE_WORK_MESSAGES.processingFailed;
        const failurePayload = {
          text: failureText,
          source: 'voice_error',
          channel: 'voice',
          requestId: failedRequestId,
          conversationId,
          finalized: true,
          blocked: true,
          reason: 'voice_processing_failed',
        };
        const unknownPayload = {
          text: voiceDurabilityUnknownText(),
          agentName: 'Lumi',
          source: 'voice',
          channel: 'voice',
          requestId: failedRequestId,
          conversationId,
          finalized: true,
          blocked: true,
          reason: 'persistence_unknown',
        };
        const failureScope: ChatExecutionScope = {
          userId: session.userId,
          domain: session.domain,
          orgId: session.orgId,
          source: 'voice',
          conversationId,
        };
        await commitChatTerminalBoundary({
          persistTerminalState: () => setConversationActionExecutionStatus(
            conversationId,
            session.userId,
            'blocked',
            {
              blocker: formatCnToolFailureDetail(err?.message || String(err)),
              assistantState: failureText,
              requestId: failedRequestId,
            },
          ),
          persistAssistantMessage: () => addMessageIdempotent({
            userId: session.userId,
            agentId: session.agentId,
            conversationId,
            role: 'assistant',
            content: failureText,
            personality: session.personalityId,
            mode: 'voice',
            source: 'voice_error',
            channel: 'voice',
            cognitiveIntent: 'voice_processing_failed',
            llmWasCalled: false,
            domain: session.domain,
            orgId: session.orgId,
            requestId: failedRequestId,
            ...(session.activeTurnProvenance || {}),
          }),
          flush: flushDBOrThrow,
          persistTerminalReceipt: () => recordChatExecutionTerminalEventDurably(
            failureScope,
            failedRequestId,
            'agent:response',
            failurePayload,
            unknownPayload,
          ),
          persistUnknownReceipt: () => recordChatExecutionPersistenceUnknownDurably(
            failureScope,
            failedRequestId,
            unknownPayload,
          ),
          publishCommitted: () => {
            socket.emit('agent:response', failurePayload);
            socket.emit('audio:work_progress', {
              requestId: failedRequestId,
              text: failureText,
              phase: 'blocked',
            });
            socket.emit('chat:conversation_updated', {
              conversationId,
              agentId: session.agentId,
              source: 'voice_error',
            });
          },
          publishUnknown: () => socket.emit('agent:response', unknownPayload),
          persistenceUnknownProjection: {
            text: unknownPayload.text,
            reason: 'Terminal persistence outcome is unknown.',
          },
          onPersistenceError: persistenceError => {
            logger.warn('[Audio] Outer failure terminal persistence failed:', persistenceError);
          },
        });
      }
    } catch (persistError: any) {
      logger.warn(`[Audio] Failed to persist outer pipeline error: ${persistError?.message || String(persistError)}`);
    }
    await cancelActiveVoiceTurn(session, false, true);
    session.activeTaskConversationId = null;
    session.activeTaskRequestId = null;
    session.activeTaskId = null;
    session.inputQueue = queuedWork;
    socket.emit('audio:status', { status: 'listening', requestId: failedRequestId || undefined });
  } finally {
    if (!resources.ownedByDurableRelease) resources.admission?.release();
    if (!session.isActive || session.isProcessing || session.inputQueue.length === 0) return;
    const next = session.inputQueue.shift();
    if (!next) return;

    // Reserve the lane before yielding so a new transcript cannot replace the
    // queued action in the small handoff window between two work turns.
    session.isProcessing = true;
    socket.emit('audio:work_started', {
      text: next.text,
      queuedAt: next.queuedAt,
      remaining: session.inputQueue.length,
    });
    setImmediate(() => {
      void runVoiceInputPipeline(
        socket,
        session,
        next.text,
        llmGetters,
        sensoryFn,
        io,
        next.queuedAt,
        next.voiceAuthorized,
        next.inputTiming,
      );
    });
  }
}
