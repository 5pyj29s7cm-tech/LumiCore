import { chatExecutionRoom } from "../connection_controls";
import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { createChatTerminalReply } from "../terminal_reply";
import type { TurnResolution } from "../../../cognition/turn_resolution";
import { flushDBOrThrow, readDatabaseTables } from "../../../../db_layer";
import { projectPublicArtifactPayload } from "../../../conversation/chat_artifacts";
import { projectCustomerVisibleExecutionEvent } from "../../public_agent_event_projection";
import { normalizeCompletionFeedbackForPersistence } from "../../../conversation/completion_feedback";
import { sanitizeExecutionResponseForDelivery, sanitizeExecutionNotificationForDelivery } from "../../../cognition/execution_guard_recovery";
import { buildTransportNeutralConfirmationScope, isConfirmationCancellation } from "../../../tools/pending_confirmation";
import { buildPendingAssistantOfferContextFromTranscript, resolvePendingRuntimeCleanupOffer } from "../../../cognition/pending_assistant_offer";
import { getMessages, type startConversationActionExecutionHeartbeat } from "../../../conversation/manager";
import { getConversationActionStateByTaskId } from "../../../conversation/ledger/queries";
import { classifyRuntimeWorkIntent } from "../../../cognition/runtime_work_intent";
import { CN_TASK_EXECUTION_MESSAGES } from "../../../regions/messages/task_execution_messages";
import { recordChatExecutionEvent, recordChatExecutionPersistenceUnknownDurably, type ChatExecutionScope } from "../../chat_execution_registry";
import { commitChatTerminalBoundary, persistAuthorizedTerminalReceipt as persistAuthorizedReceipt } from "../../chat_terminal_boundary";
import { sanitizeChatAgentErrorPayload } from "../../chat_public_error";
import type { ActiveTaskMessageResolution } from "../../../cognition/task_concurrency";
import type { prepareChatRequest } from './prepare_chat_request';
import { chatDurabilityUnknownText } from './shared';

export async function prepareChatEvents(context: NonNullable<Awaited<ReturnType<typeof prepareChatRequest>>["context"]>) {

    const pendingAssistantOfferTranscript = getMessages(context.selectedConversationId, 4);
    let pendingAssistantOfferContext = buildPendingAssistantOfferContextFromTranscript({
      messages: pendingAssistantOfferTranscript,
      userId: context.uid,
      domain: context.resolvedDomain,
      orgId: context.resolvedOrgId,
      conversationId: context.selectedConversationId,
      taskId: context.selectedConversation.actionContinuationState?.taskId,
    });
    let acceptedRuntimeCleanupOffer = resolvePendingRuntimeCleanupOffer(
      context.visibleUserText,
      pendingAssistantOfferContext,
    );
    const explicitRuntimeWorkStatusRequest = classifyRuntimeWorkIntent(
      context.visibleUserText,
      pendingAssistantOfferContext,
    ) === 'status';
    let confirmationChannelScope = buildTransportNeutralConfirmationScope({
      domain: context.resolvedDomain,
      orgId: context.resolvedOrgId,
      conversationId: context.selectedConversationId,
    });
    let confirmationScope = buildTransportNeutralConfirmationScope({
      domain: context.resolvedDomain,
      orgId: context.resolvedOrgId,
      conversationId: context.selectedConversationId,
      taskId: context.selectedConversation.actionContinuationState?.taskId,
    });
    const confirmationCancellationRequested = isConfirmationCancellation(context.visibleUserText);
    let pendingConfirmationCleared = false;
    let correctionRequiresFreshConfirmation = false;
    let executionScope: ChatExecutionScope & { conversationId: string } = {
      userId: context.uid,
      domain: context.resolvedDomain,
      orgId: context.resolvedOrgId,
      source: context.eventSource,
      conversationId: context.selectedConversationId,
      requireConversation: true,
    };
    let executionRoom = chatExecutionRoom(executionScope);
    let resolvedTaskRelation: ActiveTaskMessageResolution | null = null;
    let acceptedTurnResolution: TurnResolution | undefined;
    const refreshResolvedTaskRelationFromLedger = (
      exactConversationId: string,
      exactTaskId = resolvedTaskRelation?.taskId || '',
      exactRequestId = context.requestId,
    ): ActiveTaskMessageResolution | null => {
      if (!exactConversationId || !resolvedTaskRelation) return null;
      const db = readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]);
      const requestTurns = (db.conversationActionTurns || []).filter((turn: any) => (
        turn.conversationId === exactConversationId
        && turn.userId === context.uid
        && turn.requestId === exactRequestId
        && String(turn.taskId || '').trim()
      ));
      // A deterministic tool turn may acquire its durable task only when the
      // assistant/tool receipt is persisted. The immutable request binding is
      // safer than selecting whichever task happens to be newest.
      const requestBoundTaskId = requestTurns.length === 1
        ? String(requestTurns[0].taskId || '').trim()
        : '';
      const normalizedTaskId = String(exactTaskId || requestBoundTaskId || '').trim();
      const durableConversation = (db.conversations || []).find((candidate: any) => (
        candidate.id === exactConversationId && candidate.userId === context.uid
      ));
      const durableState = normalizedTaskId
        ? getConversationActionStateByTaskId(db, {
            conversationId: exactConversationId,
            userId: context.uid,
            taskId: normalizedTaskId,
          })
        : durableConversation?.actionContinuationState;
      if (!durableState?.taskId) return null;
      resolvedTaskRelation = {
        ...resolvedTaskRelation,
        binding: durableState.unfinished ? 'active_task' : 'previous_task',
        taskId: durableState.taskId,
        revision: durableState.revision,
        // An idle/terminal durable task no longer owns this request lease.
        targetRequestId: durableState.activeRequestId || undefined,
      };
      return resolvedTaskRelation;
    };
    const normalizeAgentPayload = (
      event: string,
      payload: Record<string, any> = {},
      outputProtection: { trustedConfirmationRequestText?: string } = {},
    ): Record<string, any> => {
      const sanitizedPayload: Record<string, any> = event === 'agent:response'
        ? sanitizeExecutionResponseForDelivery(payload, {
            task: context.visibleUserText,
            toolRecords: context.collectRequestTerminalRecords(),
            ...outputProtection,
          })
        : event === 'agent:notification'
          ? sanitizeExecutionNotificationForDelivery(payload, { task: context.visibleUserText })
        : event === 'agent:error'
          ? sanitizeChatAgentErrorPayload(payload)
          : payload;
      const projectedEvent = projectCustomerVisibleExecutionEvent(event, sanitizedPayload, {
        taskText: context.visibleUserText,
      });
      const publicPayload = event === 'agent:response'
        ? projectPublicArtifactPayload(projectedEvent, context.collectRequestTerminalRecords(), context.selectedConversationId,
          { userId: context.uid, requestId: context.requestId, originalText: [context.visibleUserText] })
        : projectedEvent;
      const completionFeedback = normalizeCompletionFeedbackForPersistence(publicPayload.completionFeedback);
      const boundedPublicPayload = { ...publicPayload };
      delete boundedPublicPayload.completionFeedback;
      return {
        ...boundedPublicPayload,

        ...(event === 'agent:response' && context.latestMediaArtifactReceipt
          ? { artifactReceipt: context.latestMediaArtifactReceipt }
          : {}),
        // Every client-visible event carries the conversation owner.  The
        // desktop shell shares one user-level socket across Lumi, LAP, and
        // Memory Avatar surfaces; consumers must be able to reject a late
        // event from another surface instead of treating it as their own.
        agentId: context.conversationAgentId,
        ...(completionFeedback ? { completionFeedback } : {}),
        source: boundedPublicPayload.source || context.eventSource,
        requestId: context.requestId,
        conversationId: context.selectedConversationId,
        ...(resolvedTaskRelation ? { taskRelation: resolvedTaskRelation } : {}),
      };
    };
    let authorizationNoticeSent = false;
    const publishRecordedAgent = (event: string, normalizedPayload: Record<string, any>) => {
      if (!context.turnAuthorization.isCurrent()) {
        // Keep the originating UI from hanging, without publishing the old
        // workspace's text, tool output, task details, or completion claims.
        if (!authorizationNoticeSent && (event === 'agent:response' || event === 'agent:error')) {
          authorizationNoticeSent = true;
          context.socket.emit('agent:response', {
            text: CN_TASK_EXECUTION_MESSAGES.cancelled, agentName: 'Lumi',
            source: context.eventSource, requestId: context.requestId, conversationId: context.selectedConversationId,
            finalized: true, blocked: false, reason: 'cancelled',
          });
        }
        return;
      }
      if (event === 'agent:response') {
        if (process.env.LUMI_CHAT_LATENCY_DIAGNOSTICS === '1') {
          context.markTurnTiming('responseReady');
          console.log('[ChatTiming]', JSON.stringify({ requestId: context.requestId, ...context.turnTiming }));
        }
        // The originating native client must receive the terminal frame even
        // if its room membership changed during reconnect or conversation
        // rollover. Other signed-in clients still receive the same terminal
        // event through the user/workspace room without duplicating it here.
        context.socket.emit(event, normalizedPayload);
        context.socket.to(executionRoom).emit(event, normalizedPayload);
        return;
      }
      if (context.isMemoryAvatar) {
        // Memory Avatar requests are forced into the personal data scope. An
        // organization-authenticated socket may not be a member of that room,
        // so deliver its private stream/status frames directly to the socket
        // that initiated the request instead of silently dropping them.
        context.socket.emit(event, normalizedPayload);
        return;
      }
      context.io.to(executionRoom).emit(event, normalizedPayload);
    };
    let actionLeaseHeartbeat: ReturnType<typeof startConversationActionExecutionHeartbeat> | null = null;
    const emitAgent = (event: string, payload: Record<string, any> = {}) => {
      if (!context.conversationAuthorization.isCurrent()) return false;
      const normalizedPayload = normalizeAgentPayload(event, payload);
      // A late duplicate from the same handler is not a reconnect replay. The
      // explicit request/recovery entry points above own replay delivery; doing
      // it here turns one committed terminal into a second UI terminal frame.
      if (!recordChatExecutionEvent(executionScope, context.requestId, event, normalizedPayload)) return false;
      publishRecordedAgent(event, normalizedPayload);
      return true;
    };
    const persistAuthorizedTerminalReceipt = (
      event: 'agent:response' | 'agent:error', payload: Record<string, any>, unknownPayload: Record<string, any>,
    ) => persistAuthorizedReceipt({ scope: executionScope, requestId: context.requestId, event, payload, unknownPayload,
      authorization: context.turnAuthorization, conversationIsCurrent: context.conversationAuthorization.isCurrent, channel: 'chat', flush: flushDBOrThrow });
    const commitDeterministicTerminal = async (input: {
      event?: 'agent:response' | 'agent:error';
      payload: Record<string, any>;
      persistAssistantMessage?: () => void;
      publishAfter?: () => void;
      errorContext?: string;
    }): Promise<boolean> => {
      if (!context.conversationAuthorization.isCurrent()) return false;
      if (actionLeaseHeartbeat?.isLeaseLost()) {
        await actionLeaseHeartbeat.leaseLoss;
        return false;
      }
      const terminalEvent = input.event || 'agent:response';
      const terminalPayload = normalizeAgentPayload(terminalEvent, input.payload);
      const unknownPayload = normalizeAgentPayload('agent:response', {
        text: chatDurabilityUnknownText(context.visibleUserText),
        agentName: String(input.payload.agentName || 'Lumi'),
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      });
      const committed = await commitChatTerminalBoundary({
        persistTerminalState: () => undefined,
        persistAssistantMessage: () => {
          input.persistAssistantMessage?.();
          const relation = refreshResolvedTaskRelationFromLedger(
            context.selectedConversationId,
            resolvedTaskRelation?.taskId,
          );
          if (relation) {
            terminalPayload.taskRelation = relation;
            unknownPayload.taskRelation = relation;
          }
        },
        flush: flushDBOrThrow,
        persistTerminalReceipt: () => persistAuthorizedTerminalReceipt(
          terminalEvent,
          terminalPayload,
          unknownPayload,
        ),
        persistUnknownReceipt: () => recordChatExecutionPersistenceUnknownDurably(
            executionScope,
            context.requestId,
            unknownPayload,
          ),
        publishCommitted: () => {
          publishRecordedAgent(terminalEvent, terminalPayload);
          input.publishAfter?.();
        },
        publishUnknown: () => {
          // The success receipt failed its strict barrier. Publish only the
          // sanitized unknown frame already installed in the in-memory
          // quarantine; do not route it through the registry a second time.
          publishRecordedAgent('agent:response', unknownPayload);
        },
        persistenceUnknownProjection: {
          text: unknownPayload.text,
          completionFeedback: unknownPayload.completionFeedback,
          reason: 'Terminal persistence outcome is unknown.',
        },
        onPersistenceError: error => {
          console.error(`[ChatHandler] ${input.errorContext || 'Deterministic terminal'} persistence failed:`, error);
        },
      });
      if (committed) actionLeaseHeartbeat?.stop();
      return committed;
    };
    const commitChatReply = createChatTerminalReply({
      commit: commitDeterministicTerminal, write: context.addMessageIdempotent, getConversationId: () => context.selectedConversationId,
    });
    const emitConversationUpdated = (payload: Record<string, any>) => {
      if (!context.turnAuthorization.isCurrent()) return;
      context.io.to(executionRoom).emit('chat:conversation_updated', {
        ...payload,
        requestId: context.requestId,
        originSocketId: context.socket.id,
      });
    };
    console.log('[ChatHandler] domain:', context.resolvedDomain, 'orgId:', context.resolvedOrgId);
  return { terminal: false as const, context: extendTurnBindings(context, {
    get executionScope(): typeof executionScope { return executionScope; },
    set executionScope(value: typeof executionScope) { executionScope = value; },
    normalizeAgentPayload,
    publishRecordedAgent,
    get acceptedTurnResolution(): typeof acceptedTurnResolution { return acceptedTurnResolution; },
    set acceptedTurnResolution(value: typeof acceptedTurnResolution) { acceptedTurnResolution = value; },
    get pendingAssistantOfferContext(): typeof pendingAssistantOfferContext { return pendingAssistantOfferContext; },
    set pendingAssistantOfferContext(value: typeof pendingAssistantOfferContext) { pendingAssistantOfferContext = value; },
    get resolvedTaskRelation(): typeof resolvedTaskRelation { return resolvedTaskRelation; },
    set resolvedTaskRelation(value: typeof resolvedTaskRelation) { resolvedTaskRelation = value; },
    commitChatReply,
    get confirmationScope(): typeof confirmationScope { return confirmationScope; },
    set confirmationScope(value: typeof confirmationScope) { confirmationScope = value; },
    get confirmationChannelScope(): typeof confirmationChannelScope { return confirmationChannelScope; },
    set confirmationChannelScope(value: typeof confirmationChannelScope) { confirmationChannelScope = value; },
    get pendingConfirmationCleared(): typeof pendingConfirmationCleared { return pendingConfirmationCleared; },
    set pendingConfirmationCleared(value: typeof pendingConfirmationCleared) { pendingConfirmationCleared = value; },
    commitDeterministicTerminal,
    emitAgent,
    get acceptedRuntimeCleanupOffer(): typeof acceptedRuntimeCleanupOffer { return acceptedRuntimeCleanupOffer; },
    set acceptedRuntimeCleanupOffer(value: typeof acceptedRuntimeCleanupOffer) { acceptedRuntimeCleanupOffer = value; },
    get executionRoom(): typeof executionRoom { return executionRoom; },
    set executionRoom(value: typeof executionRoom) { executionRoom = value; },
    confirmationCancellationRequested,
    get correctionRequiresFreshConfirmation(): typeof correctionRequiresFreshConfirmation { return correctionRequiresFreshConfirmation; },
    set correctionRequiresFreshConfirmation(value: typeof correctionRequiresFreshConfirmation) { correctionRequiresFreshConfirmation = value; },
    get actionLeaseHeartbeat(): typeof actionLeaseHeartbeat { return actionLeaseHeartbeat; },
    set actionLeaseHeartbeat(value: typeof actionLeaseHeartbeat) { actionLeaseHeartbeat = value; },
    emitConversationUpdated,
    explicitRuntimeWorkStatusRequest,
    refreshResolvedTaskRelationFromLedger,
    persistAuthorizedTerminalReceipt,
  }) };
}
