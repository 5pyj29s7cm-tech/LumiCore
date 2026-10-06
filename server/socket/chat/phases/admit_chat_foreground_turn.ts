import { chatExecutionRoom } from "../connection_controls";
import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { reserveConversationExecution, getConversationExecution, getCurrentConversationExecution, cancelConversationExecution } from "../../../cognition/conversation_execution";
import { flushDBOrThrow } from "../../../../db_layer";
import { runtimeShutdownCancellation } from "../../../runtime/shutdown_work";
import { shouldForwardPreFinalizationProgress } from "../../../cognition/response_delivery";
import { buildTransportNeutralConfirmationScope, clearPendingConfirmationDurably } from "../../../tools/pending_confirmation";
import { admitAcceptedUserTurnDurably, resolveAcceptedTurnConfirmation, runAfterAcceptedUserTurnAdmission } from "../../action_turn_durability";
import { type ForegroundRequestIdentity as ChatForegroundRequestIdentity } from "../../../conversation/manager";
import { resolveConversationForEntry } from "../../../conversation/entry_conversation";
import { isUserObservedTaskCompletion } from "../../../cognition/action_continuation";
import { CN_TASK_EXECUTION_MESSAGES } from "../../../regions/messages/task_execution_messages";
import { beginQueuedChatExecution, beginChatSidecarExecution, markChatExecutionCancelling, persistChatSidecarCancellationIntent } from "../../chat_execution_registry";
import { sanitizeChatAgentErrorPayload } from "../../chat_public_error";
import { resolveActiveTaskMessageRelation } from "../../../cognition/task_concurrency";
import type { resolveChatControlTurn } from './resolve_chat_control_turn';
import { chatDurabilityUnknownText } from './shared';

export async function admitChatForegroundTurn(context: NonNullable<Awaited<ReturnType<typeof resolveChatControlTurn>>["context"]>) {

    // A new utterance does not destroy an active task. Continuations and
    // independent work wait behind the current foreground lease; only an
    // explicit replacement aborts it.
    const previousSession = getCurrentConversationExecution(context.executionScope, 'tail');
    if (previousSession && previousSession.requestId !== context.existingSession?.requestId) {
      context.resolvedTaskRelation = resolveActiveTaskMessageRelation(
        context.visibleUserText,
        context.activeConversationForStatus?.actionContinuationState || context.selectedConversation.actionContinuationState,
        {
          acceptedFeedback: context.resolvedTaskRelation.feedback,
          activeRequestId: previousSession.requestId,
          controlTargetRequestId: context.controlTargetRequestId,
          controlTargetTaskId: context.controlTargetTaskId,
          controlTargetRevision: context.controlTargetRevision,
          pendingAssistantOfferContext: context.pendingAssistantOfferContext,
        },
      );
    }
    const activeMessageRelation = previousSession ? context.resolvedTaskRelation.relation : null;
    let acknowledged = false;
    if (previousSession && activeMessageRelation === 'cancel') {
      if (!beginChatSidecarExecution(context.executionScope, context.requestId)) { return { terminal: true as const, context: undefined }; }
      // A typed/spoken "停止" has no client request id. Bind it to the exact
      // server-owned lease selected by the resolver. UI controls may still
      // supply an immutable fence, and stale explicit fences are rejected
      // before this branch.
      const cancellationTargetRequestId = context.controlTargetRequestId
        || context.resolvedTaskRelation.targetRequestId
        || previousSession.requestId;
      try {
        // A buffered cancellation must be durably fenced before it can touch
        // the foreground queue. On restart, this tombstone makes replay a
        // status lookup instead of a second cancellation of newer work.
        await persistChatSidecarCancellationIntent(context.executionScope, context.requestId, cancellationTargetRequestId);
      } catch (error: any) {
        const publicError = sanitizeChatAgentErrorPayload({ code: 'CHAT_CONTROL_RECEIPT_WRITE_FAILED' });
        await context.commitDeterministicTerminal({
          event: 'agent:error',
          payload: {
            message: publicError.message,
            code: 'CHAT_CONTROL_RECEIPT_WRITE_FAILED',
            sidecar: true,
          },
          errorContext: 'Cancellation reservation failure terminal',
        });
        try { context.ack?.({ ok: false, requestId: context.requestId, error: publicError.message }); } catch {}
        { return { terminal: true as const, context: undefined }; }
      }
      context.addMessageIdempotent({
        conversationId: context.selectedConversationId,
        role: 'user',
        content: context.storedUserContent,
        cognitiveIntent: 'task_cancel',
        receivedAt: context.requestReceivedAt,
        timestamp: context.requestReceivedAt,
        skipActionContinuation: true,
      });
      try {
        context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() });
        acknowledged = true;
      } catch {}
      context.emitAgent('agent:status', { status: 'cancelling', sidecar: true });
      if (!context.turnAuthorization.isCurrent()) {
        // This control already has a durable reservation and an acceptance
        // acknowledgement. Settle it without touching its old target.
        await context.commitChatReply({
          text: CN_TASK_EXECUTION_MESSAGES.cancelled,
          sidecar: true,
          reason: 'cancelled',
          message: () => ({
            cognitiveIntent: 'task_cancel',
            skipActionContinuation: true,
          }),
          errorContext: 'Revoked cancellation control terminal',
        });
        { return { terminal: true as const, context: undefined }; }
      }
      const currentTarget = getConversationExecution(context.executionScope, cancellationTargetRequestId);
      if (!currentTarget) {
        await context.commitChatReply({
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          sidecar: true,
          reason: 'stale_control',
          message: () => ({
            cognitiveIntent: 'task_cancel',
            skipActionContinuation: true,
          }),
          errorContext: 'Stale cancellation terminal',
        });
        { return { terminal: true as const, context: undefined }; }
      }
      try {
        await cancelConversationExecution(context.executionScope, cancellationTargetRequestId);
      } catch (error: any) {
        const settlementTimedOut = error?.code === 'serial_execution_cancellation_timeout';
        const failureText = settlementTimedOut
          ? CN_TASK_EXECUTION_MESSAGES.cancellationSettlementTimedOut
          : sanitizeChatAgentErrorPayload({ code: 'CHAT_CONTROL_CANCEL_FAILED' }).message;
        await context.commitDeterministicTerminal({
          ...(settlementTimedOut ? {} : { event: 'agent:error' as const }),
          payload: settlementTimedOut ? {
            text: failureText,
            agentName: 'Lumi',
            sidecar: true,
            finalized: true,
            blocked: true,
            reason: 'cancellation_settlement_timeout',
          } : {
            message: failureText,
            code: 'CHAT_CONTROL_CANCEL_FAILED',
            sidecar: true,
          },
          persistAssistantMessage: settlementTimedOut ? () => context.addMessageIdempotent({ conversationId: context.selectedConversationId, role: 'assistant', content: failureText, cognitiveIntent: 'cancellation_settlement_timeout', skipActionContinuation: true }) : undefined,
          errorContext: settlementTimedOut
            ? 'Cancellation settlement timeout terminal'
            : 'Cancellation failure terminal',
        });
        { return { terminal: true as const, context: undefined }; }
      }
      await context.commitChatReply({
        text: CN_TASK_EXECUTION_MESSAGES.cancelled,
        source: context.eventSource,
        requestId: context.requestId,
        sidecar: true,
        reason: 'cancelled_by_user',
        message: () => ({
          cognitiveIntent: 'task_cancel',
          skipActionContinuation: true,
        }),
        errorContext: 'Cancellation completion terminal',
      });
      { return { terminal: true as const, context: undefined }; }
    }

    // Bind and persist the foreground user turn before it waits behind any
    // older lease. This keeps receive order durable even when the model/tool
    // phase is long or the process exits before a terminal assistant result.
    const conversationTurn = resolveConversationForEntry(context.uid, context.requestScope, {
      kind: 'chat', phase: 'admit', agentId: context.conversationAgentId, userText: context.visibleUserText,
    }, context.selectedConversationId);
    let conversation = conversationTurn.conversation;
    const userObservedCompletionTaskId = context.attachments.length === 0
      && isUserObservedTaskCompletion(context.visibleUserText, conversation.actionContinuationState)
      ? conversation.actionContinuationState?.taskId
      : undefined;
    if (conversation.id !== context.selectedConversationId) {
      context.selectedConversationId = conversation.id;
      context.pendingAssistantOfferContext = undefined;
      context.acceptedRuntimeCleanupOffer = null;
      context.confirmationChannelScope = buildTransportNeutralConfirmationScope({
        domain: context.resolvedDomain,
        orgId: context.resolvedOrgId,
        conversationId: context.selectedConversationId,
      });
      context.confirmationScope = buildTransportNeutralConfirmationScope({
        domain: context.resolvedDomain,
        orgId: context.resolvedOrgId,
        conversationId: context.selectedConversationId,
      });
      context.executionScope = { ...context.executionScope, conversationId: context.selectedConversationId };
      context.executionRoom = chatExecutionRoom(context.executionScope);
      context.pendingConfirmation = null;
      context.pendingConfirmationPrompt = '';
    }
    if (context.rejectRevokedRequest()) { return { terminal: true as const, context: undefined }; }
    context.markTurnTiming('admissionStart');
    const chatAdmission = await admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: () => context.addMessageIdempotent({
        conversationId: conversation.id,
        role: 'user',
        content: context.storedUserContent,
        cognitiveIntent: context.confirmationCancellationRequested
          ? 'task_cancel'
          : context.resolvedTaskRelation.binding === 'active_task' || context.resolvedTaskRelation.binding === 'previous_task'
            ? `task_${context.resolvedTaskRelation.feedback}`
            : undefined,
        receivedAt: context.requestReceivedAt,
        timestamp: context.requestReceivedAt,
        deferActionPreparation: !context.confirmationCancellationRequested,
        skipActionContinuation: context.confirmationCancellationRequested,
      }),
      flush: flushDBOrThrow,
      onPersistenceUnknown: error => {
        console.error('[ChatHandler] Accepted user turn could not be flushed:', error);
        const unknownPayload = context.normalizeAgentPayload('agent:response', {
          text: chatDurabilityUnknownText(context.visibleUserText),
          agentName: 'Lumi',
          finalized: true,
          blocked: true,
          reason: 'persistence_unknown',
        });
        context.publishRecordedAgent('agent:response', unknownPayload);
        try { context.ack?.({ ok: false, requestId: context.requestId, error: 'Accepted user turn persistence is unknown' }); } catch {}
      },
    });
    if (!chatAdmission) {
      { return { terminal: true as const, context: undefined }; }
    }
    context.markTurnTiming('admissionEnd');
    const acceptedUserMessageId = chatAdmission.persisted;
    if (conversationTurn.rolledOver && conversationTurn.previousConversationId) {
      await runAfterAcceptedUserTurnAdmission(chatAdmission, () => (
        clearPendingConfirmationDurably(context.uid, buildTransportNeutralConfirmationScope({
          domain: context.resolvedDomain,
          orgId: context.resolvedOrgId,
          conversationId: conversationTurn.previousConversationId!,
        }))
      ));
    }
    const confirmationResolution = await resolveAcceptedTurnConfirmation({
      admission: chatAdmission,
      userId: context.uid,
      userText: context.visibleUserText,
      taskRelation: context.resolvedTaskRelation || undefined,
        actionState: conversation.actionContinuationState,
      taskScope: context.confirmationScope,
      channelScope: context.confirmationChannelScope,
    });
    context.pendingConfirmation = confirmationResolution.pending;
    context.pendingConfirmationPrompt = confirmationResolution.prompt;
    context.confirmationScope = confirmationResolution.scope;
    context.pendingConfirmationCleared = confirmationResolution.cleared;
    context.correctionRequiresFreshConfirmation = confirmationResolution.correctionRequiresFreshConfirmation;

    // Install the lease before waiting. Otherwise two messages arriving while
    // the same task is active both wait for that task and wake concurrently,
    // allowing the later request to supersede the earlier queued request.
    const sessionLease = runAfterAcceptedUserTurnAdmission(chatAdmission, () => {
      if (previousSession && activeMessageRelation === 'replace' && context.turnAuthorization.isCurrent()) {
        void cancelConversationExecution(context.executionScope);
      }
      beginQueuedChatExecution(context.executionScope, context.requestId);
      return reserveConversationExecution(context.executionScope, context.requestId);
    });
    const abortController = sessionLease.controller;
    const markRequestCancellation = () => markChatExecutionCancelling(context.executionScope, context.requestId);
    abortController.signal.addEventListener('abort', markRequestCancellation, { once: true });
    const stopAuthorizationWatch = context.turnAuthorization.watch(abortController);
    if (abortController.signal.aborted) markRequestCancellation();
    const isChatCancelled = () => !context.turnAuthorization.isCurrent() || abortController.signal.aborted;
    const forwardToolProgress = (step: string) => {
      if (!isChatCancelled() && shouldForwardPreFinalizationProgress(step)) {
        context.emitAgent('agent:progress', { text: step, agentName: 'Lumi' });
      }
    };
    const unregisterShutdownCancellation = runtimeShutdownCancellation.register(abortController);
    let releaseDesktopControlLease: (() => void) | null = null;
    let foregroundRequestIdentity: ChatForegroundRequestIdentity | null = null;
  return { terminal: false as const, context: extendTurnBindings(context, {
    stopAuthorizationWatch,
    abortController,
    markRequestCancellation,
    unregisterShutdownCancellation,
    get releaseDesktopControlLease(): typeof releaseDesktopControlLease { return releaseDesktopControlLease; },
    set releaseDesktopControlLease(value: typeof releaseDesktopControlLease) { releaseDesktopControlLease = value; },
    sessionLease,
    get foregroundRequestIdentity(): typeof foregroundRequestIdentity { return foregroundRequestIdentity; },
    set foregroundRequestIdentity(value: typeof foregroundRequestIdentity) { foregroundRequestIdentity = value; },
    get acknowledged(): typeof acknowledged { return acknowledged; },
    set acknowledged(value: typeof acknowledged) { acknowledged = value; },
    activeMessageRelation,
    chatAdmission,
    get conversation(): typeof conversation { return conversation; },
    set conversation(value: typeof conversation) { conversation = value; },
    userObservedCompletionTaskId,
    acceptedUserMessageId,
    isChatCancelled,
    conversationTurn,
    confirmationResolution,
    forwardToolProgress,
  }) };
}
