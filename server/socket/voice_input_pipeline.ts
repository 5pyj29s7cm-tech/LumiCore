import { Server, Socket } from "socket.io";
import { type AudioSession, type VoiceInputTiming, type VoiceInputResources } from "./voice/session";
import type { LLMGetters as LlmGetters } from '../llm/dispatch';
import { logger } from "../../logger";
import { getConversationForScope, addMessageIdempotent, getMessages, setConversationActionExecutionStatus } from "../conversation/manager";
import { CN_VOICE_WORK_MESSAGES, formatCnToolFailureDetail } from "../regions/messages/voice_fast_path_messages";
import { voiceDurabilityUnknownText } from './voice_durability';
import { CN_TASK_EXECUTION_MESSAGES } from '../regions/messages/task_execution_messages';
import { getChatExecution, recordChatExecutionPersistenceUnknownDurably, recordChatExecutionTerminalEventDurably, type ChatExecutionScope } from './chat_execution_registry';
import { commitChatTerminalBoundary } from './chat_terminal_boundary';
import { flushDBOrThrow } from "../../db_layer";
import { processVoiceInput } from "./voice_conversation_turn";
import { cancelActiveVoiceTurn, captureVoiceTurnOwner } from "./voice_transport_runtime";

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
  const resources: VoiceInputResources = { owner: captureVoiceTurnOwner(session) };
  try {
    await processVoiceInput(socket, session, userText, llmGetters, sensoryFn, io, userReceivedAt, voiceAuthorized, inputTiming, resources);
  } catch (err: any) {
    const owner = resources.owner!;
    if (!owner.isCurrent()) return;
    if (originalAuthorization && !originalAuthorization.isCurrent()) {
      if (session.authorization === originalAuthorization && session.activeTurnRequestId) {
        await session.cancelAuthorizationTurn?.(session.activeTurnRequestId);
      }
      return;
    }
    const request = resources.request;
    const requestIsCurrent = request?.authorization.isCurrent() ?? true;
    logger.error('[Voice Error]:', err);
    const failedRequestId = request?.requestId;
    const queuedWork = session.inputQueue.slice();
    const conversationId = request?.conversationId || '';
    let terminalResponseAlreadyPersisted = false;
    try {
      if (requestIsCurrent && request && conversationId && getConversationForScope(conversationId, request.userId, request.domain, request.orgId)) {
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
            userId: request.userId,
            domain: request.domain,
            orgId: request.orgId,
            source: 'voice',
            conversationId,
          };
          await commitChatTerminalBoundary({
            persistTerminalState: () => setConversationActionExecutionStatus(
              conversationId,
              request.userId,
              'blocked',
              {
                blocker: formatCnToolFailureDetail(err?.message || String(err)),
                assistantState: failureText,
                requestId: failedRequestId,
              },
            ),
            persistAssistantMessage: () => addMessageIdempotent({
              userId: request.userId,
              agentId: request.agentId,
              conversationId,
              role: 'assistant',
              content: failureText,
              personality: request.personalityId,
              mode: 'voice',
              source: 'voice_error',
              channel: 'voice',
              cognitiveIntent: 'voice_processing_failed',
              llmWasCalled: false,
              domain: request.domain,
              orgId: request.orgId,
              requestId: failedRequestId,
              ...(request.provenance || {}),
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
              if (!owner.isCurrent() || !request.authorization.isCurrent()) return;
              socket.emit('agent:response', failurePayload);
              socket.emit('audio:work_progress', {
                requestId: failedRequestId,
                text: failureText,
                phase: 'blocked',
              });
              socket.emit('chat:conversation_updated', {
                conversationId,
                agentId: request.agentId,
                source: 'voice_error',
              });
            },
            publishUnknown: () => {
              if (owner.isCurrent() && request.authorization.isCurrent()) socket.emit('agent:response', unknownPayload);
            },
            persistenceUnknownProjection: {
              text: unknownPayload.text,
              reason: 'Terminal persistence outcome is unknown.',
            },
            onPersistenceError: persistenceError => {
              logger.warn('[Audio] Outer failure terminal persistence failed:', persistenceError);
            },
          });
        }
      }
    } catch (persistError: any) {
      logger.warn(`[Audio] Failed to persist outer pipeline error: ${persistError?.message || String(persistError)}`);
    }
    if (!await cancelActiveVoiceTurn(session, false, true, false, owner) || !owner.isCurrent()) return;
    session.activeTaskConversationId = null;
    session.activeTaskRequestId = null;
    session.activeTaskId = null;
    session.inputQueue = requestIsCurrent ? queuedWork : [];
    socket.emit('audio:status', { status: 'listening', sessionId: session.sessionId, requestId: failedRequestId || undefined });
  } finally {
    // The executor has settled. Its frozen reservation still needs a durable
    // terminal when cancellation or a newer owner bypassed in-turn delivery.
    const request = resources.request;
    if (request && getChatExecution(request, request.requestId)?.terminal === false) {
      const scope: ChatExecutionScope = { userId: request.userId, domain: request.domain,
        orgId: request.orgId, source: 'voice', conversationId: request.conversationId };
      const cancelled = request.signal.aborted || !request.authorization.isCurrent() || !resources.owner?.isCurrent();
      const payload = { text: cancelled ? CN_TASK_EXECUTION_MESSAGES.cancelled : CN_VOICE_WORK_MESSAGES.processingFailed,
        agentName: 'Lumi', source: 'voice', channel: 'voice', requestId: request.requestId,
        conversationId: request.conversationId, finalized: true, blocked: true,
        reason: cancelled ? 'cancelled' : 'voice_processing_failed' };
      const unknown = { ...payload, text: voiceDurabilityUnknownText(), reason: 'persistence_unknown' };
      try {
        await recordChatExecutionTerminalEventDurably(scope, request.requestId, 'agent:response', payload, unknown);
      } catch (error) {
        try {
          await recordChatExecutionPersistenceUnknownDurably(scope, request.requestId, unknown);
        } catch (persistError) {
          logger.warn('[Audio] Settled voice receipt persistence failed:', persistError);
        }
      }
    }
    if (!resources.ownedByDurableRelease) resources.admission?.release();
    if (!resources.owner?.isCurrent() || !session.isActive || session.isProcessing || session.inputQueue.length === 0) return;
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
    const handoffOwner = captureVoiceTurnOwner(session);
    setImmediate(() => {
      if (!handoffOwner.isCurrent() || !session.isActive) return;
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
