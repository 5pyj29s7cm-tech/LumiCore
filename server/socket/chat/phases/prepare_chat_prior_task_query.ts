import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { revalidateAcceptedTaskRelation } from "../../../cognition/task_concurrency";
import { isExplicitMemoryRequest, persistTurnMemory } from "../../../memory/turn_memory";
import { readDatabaseTables } from "../../../../db_layer";
import { buildTransportNeutralConfirmationScope, clearPendingConfirmationDurably, isExplicitConfirmationReply } from "../../../tools/pending_confirmation";
import { getMessages, getConversationForScope, completeConversationActionFromUserObservation } from "../../../conversation/manager";
import { getConversationActionStateByTaskId, getConversationActionStateFromLedger } from "../../../conversation/ledger/queries";
import { findAdjacentVerifiedConfirmedAction } from "../../../conversation/duplicate_confirmation";
import { findLatestRepeatableAssistantReply } from "../../../conversation/assistant_restatement";
import { conversationActionRequiresFreshConfirmationReview, formatConversationActionTaskStatus, isUserObservedTaskCompletion, pendingRuntimeCancellationRecheck } from "../../../cognition/action_continuation";
import { CN_TASK_EXECUTION_MESSAGES } from "../../../regions/messages/task_execution_messages";
import { taskRelationFollowupIntent } from "../../../cognition/task_concurrency";
import type { startChatForegroundTurn } from './start_chat_foreground_turn';

export async function prepareChatPriorTaskQuery(context: NonNullable<Awaited<ReturnType<typeof startChatForegroundTurn>>["context"]>) {

      // The turn may have waited behind one or more executions. Re-read the
      // durable conversation and resolve the user's feedback against that
      // exact revision. Never merge a receive-time task id/revision over a
      // newer state: explicit controls are optimistic-concurrency fences.
      context.turnAuthorization.assertCurrent();
      const refreshedConversation = getConversationForScope(
        context.conversation.id,
        context.uid,
        context.resolvedDomain,
        context.resolvedOrgId,
      );
      if (!refreshedConversation) {
        await context.commitDeterministicTerminal({
          event: 'agent:error',
          payload: {
            message: 'Conversation is unavailable for this user or workspace',
            code: 'CHAT_CONVERSATION_REFRESH_FAILED',
          },
          errorContext: 'Conversation refresh failure terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }
      context.conversation = refreshedConversation;
      // Explicit memory edits own a durable turn without entering task/tool planning.
      if (!context.isMemoryAvatar && isExplicitMemoryRequest(context.visibleUserText)) {
        const receipt = await persistTurnMemory({ userId: context.uid, domain: context.resolvedDomain, orgId: context.resolvedOrgId,
          userText: context.visibleUserText, channel: 'chat', source: context.eventSource, requestId: context.requestId, conversationId: context.conversation.id,
          agentId: context.conversationAgentId, authorization: context.turnAuthorization, signal: context.abortController.signal, llmGetters: context.llmGetters });
        await context.commitChatReply({
          text: receipt.text,
          blocked: receipt.status === 'failed',
          reason: receipt.status === 'saved' ? 'memory_saved' : 'memory_not_saved',
          message: () => ({
            conversationId: context.conversation.id,
            cognitiveIntent: 'memory',
            llmWasCalled: true,
            skipActionContinuation: true,
          }),
          errorContext: 'Explicit memory terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }
      context.resolvedTaskRelation = revalidateAcceptedTaskRelation(context.resolvedTaskRelation, context.conversation.actionContinuationState);
      context.emitAgent('agent:task_relation', { relation: context.resolvedTaskRelation });
      if (context.resolvedTaskRelation.binding === 'stale' || (
        context.userObservedCompletionTaskId
        && context.conversation.actionContinuationState?.taskId !== context.userObservedCompletionTaskId
      )) {
        await context.commitChatReply({
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          reason: context.resolvedTaskRelation.reason || 'stale_control',
          message: () => ({
            conversationId: context.conversation.id,
            cognitiveIntent: 'stale_task_control',
            llmWasCalled: false,
            skipActionContinuation: true,
          }),
          errorContext: 'Stale foreground task terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }

      if (context.userObservedCompletionTaskId && isUserObservedTaskCompletion(context.visibleUserText, context.conversation.actionContinuationState)) {
        const observedTask = context.conversation.actionContinuationState!;
        await clearPendingConfirmationDurably(context.uid, buildTransportNeutralConfirmationScope({
          domain: context.resolvedDomain,
          orgId: context.resolvedOrgId,
          conversationId: context.conversation.id,
          taskId: observedTask.taskId,
        }));
        context.pendingConfirmation = null;
        context.pendingConfirmationPrompt = '';
        const responseText = formatConversationActionTaskStatus({
          ...observedTask, status: 'completed', unfinished: false,
          latestBlocker: '', completionSource: 'user_observation',
        });
        await context.commitDeterministicTerminal({
          payload: {
            text: responseText, agentName: 'Lumi', finalized: true,
            blocked: false, reason: 'task_user_observation',
          },
          persistAssistantMessage: () => {
            const completed = completeConversationActionFromUserObservation(
              context.conversation.id, context.uid, context.visibleUserText,
              { taskId: observedTask.taskId!, requestId: context.requestId, userMessageId: context.acceptedUserMessageId },
            );
            if (!completed) throw new Error('User observation no longer owns the pending task');
            context.addMessageIdempotent({ conversationId: context.conversation.id,
              role: 'assistant', content: responseText,
              source: 'chat_task_user_observation',
              cognitiveIntent: 'task_user_observation', llmWasCalled: false, skipActionContinuation: true,
            });
          },
          publishAfter: () => context.emitConversationUpdated({
            conversationId: context.conversation.id, agentId: context.conversationAgentId,
            source: 'chat_task_user_observation',
          }),
          errorContext: 'User-observed task completion terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }

      if (context.resolvedTaskRelation.feedback === 'repeat') {
        // Restatement is an exact adjacent-turn read, not a planning request.
        // Resolve it from the persisted transcript so it cannot fall back to
        // an older task, consume model capacity, or inherit tool permissions.
        const repeatTranscript = getMessages(context.conversation.id);
        let acceptedRepeatIndex = -1;
        for (let index = repeatTranscript.length - 1; index >= 0; index -= 1) {
          const item = repeatTranscript[index];
          if (
            item.role === 'user'
            && String(item.requestId || item.externalMessageId || '') === context.requestId
          ) {
            acceptedRepeatIndex = index;
            break;
          }
        }
        const responseText = findLatestRepeatableAssistantReply(
          acceptedRepeatIndex >= 0 ? repeatTranscript.slice(0, acceptedRepeatIndex) : [],
        ) || CN_TASK_EXECUTION_MESSAGES.noRepeatableReply;
        await context.commitChatReply({
          text: responseText,
          reason: 'repeat_previous_reply',
          message: () => ({
            conversationId: context.conversation.id,
            cognitiveIntent: 'task_repeat',
            llmWasCalled: false,
            skipActionContinuation: true,
          }),
          publishAfter: () => context.emitConversationUpdated({
            conversationId: context.conversation.id,
            agentId: context.conversationAgentId,
            source: context.eventSource,
          }),
          errorContext: 'Adjacent reply repeat terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }

      const adjacentConfirmedAction = !context.pendingConfirmation
        && !context.conversation.actionContinuationState?.unfinished
        && isExplicitConfirmationReply(context.visibleUserText)
        ? findAdjacentVerifiedConfirmedAction({
            messages: getMessages(context.conversation.id, 32),
            currentRequestId: context.requestId,
          })
        : null;
      const repeatedConfirmationWithoutPending = Boolean(adjacentConfirmedAction);
      if (repeatedConfirmationWithoutPending) {
        const responseText = CN_TASK_EXECUTION_MESSAGES.noPendingConfirmation;
        await context.commitChatReply({
          text: responseText,
          reason: 'no_pending_confirmation',
          message: () => ({
            conversationId: context.conversation.id,
            cognitiveIntent: 'duplicate_confirmation_noop',
            llmWasCalled: false,
            skipActionContinuation: true,
          }),
          publishAfter: () => context.emitConversationUpdated({
            conversationId: context.conversation.id,
            agentId: context.conversationAgentId,
            source: context.eventSource,
          }),
          errorContext: 'Duplicate confirmation no-op terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }

      // Prior-turn receipt questions are deterministic ledger reads. Resolve
      // them before memory embeddings, RAG, personality assembly, or any model
      // client so a slow provider cannot block a local execution-status answer.
      const runtimeStatusOwnsThisTurn = context.explicitRuntimeWorkStatusRequest
        && !(
          context.resolvedTaskRelation.feedback === 'status'
          && ['active_task', 'previous_task'].includes(context.resolvedTaskRelation.binding)
          && Boolean(context.resolvedTaskRelation.taskId)
        );
      const acceptedFollowupIntent = runtimeStatusOwnsThisTurn
        ? 'none' as const
        : taskRelationFollowupIntent(context.resolvedTaskRelation);
      const acceptedNormalizedIntent = context.acceptedTurnResolution!.userIntent;
      const confirmationNeedsFreshReview = Boolean(
        acceptedFollowupIntent === 'status'
        && isExplicitConfirmationReply(context.visibleUserText)
        && conversationActionRequiresFreshConfirmationReview(
          context.conversation.actionContinuationState,
        ),
      );
      const asksToRecheckPreviousAction = acceptedFollowupIntent === 'status'
        && acceptedNormalizedIntent.kind === 'status_query'
        && acceptedNormalizedIntent.target === 'previous_action';
      const asksAboutBoundConversationTask = acceptedFollowupIntent === 'status'
        && ['active_task', 'previous_task'].includes(context.resolvedTaskRelation.binding)
        && Boolean(context.resolvedTaskRelation.taskId)
        && (
          acceptedNormalizedIntent.kind === 'none'
          || (
            acceptedNormalizedIntent.kind === 'status_query'
            && ['previous_action', 'recent_task'].includes(acceptedNormalizedIntent.target)
          )
        );
      const asksAboutRecentConversationTask = acceptedFollowupIntent === 'status'
        && acceptedNormalizedIntent.kind === 'status_query'
        && acceptedNormalizedIntent.target === 'recent_task';
      const serverBoundRecheckTaskId = asksToRecheckPreviousAction
        ? String(context.resolvedTaskRelation.taskId || '').trim()
        : '';
      const mayUseUnboundRecheckFallback = asksToRecheckPreviousAction
        && !serverBoundRecheckTaskId
        && context.resolvedTaskRelation.binding === 'conversation'
        && !context.controlTargetRequestId
        && !context.controlTargetTaskId
        && context.controlTargetRevision === undefined;
      const previousActionState = asksToRecheckPreviousAction
        ? serverBoundRecheckTaskId
          ? getConversationActionStateByTaskId(readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]), {
              conversationId: context.conversation.id,
              userId: context.uid,
              taskId: serverBoundRecheckTaskId,
            })
          : mayUseUnboundRecheckFallback
            ? getConversationActionStateFromLedger(readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]), {
                conversationId: context.conversation.id,
                userId: context.uid,
                query: context.visibleUserText,
              })
            : null
        : null;
      const runtimeCancellationRecheck = pendingRuntimeCancellationRecheck(previousActionState);
  return { terminal: false as const, context: extendTurnBindings(context, {
    runtimeCancellationRecheck: runtimeCancellationRecheck as typeof runtimeCancellationRecheck,
    previousActionState: previousActionState as typeof previousActionState,
    acceptedFollowupIntent: acceptedFollowupIntent as typeof acceptedFollowupIntent,
    confirmationNeedsFreshReview: confirmationNeedsFreshReview as typeof confirmationNeedsFreshReview,
    asksAboutBoundConversationTask: asksAboutBoundConversationTask as typeof asksAboutBoundConversationTask,
    asksAboutRecentConversationTask: asksAboutRecentConversationTask as typeof asksAboutRecentConversationTask,
    acceptedNormalizedIntent: acceptedNormalizedIntent as typeof acceptedNormalizedIntent,
    serverBoundRecheckTaskId: serverBoundRecheckTaskId as typeof serverBoundRecheckTaskId,
  }) };
}
