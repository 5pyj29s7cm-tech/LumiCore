import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { answerPriorTaskStatus } from "../prior_task_status";
import { prepareChatPromptContext } from "../prompt_context";
import { retrieveChatContext } from "../context_retrieval";
import { buildClientSurfaceContinuationBridge, isShortClientContinuation } from "../client_surface";
import { TASK_TARGET_HISTORY_LIMIT } from "../../../conversation/task_target_anchor";
import { readDatabaseTables } from "../../../../db_layer";
import { normalizeOperationMode } from "../../../cognition/operation_modes";
import { getStoredOperationMode } from "../../../cognition/operation_mode_store";
import { clearPendingConfirmationDurably } from "../../../tools/pending_confirmation";
import { getMessages, setConversationMode, getConversationForScope, bindConversationActionExecutionTurn, cancelConversationActionExecution } from "../../../conversation/manager";
import { getConversationActionStateByTaskId, getLatestConversationActionState } from "../../../conversation/action_ledger";
import { buildRecentActionContinuationBridge } from "../../../cognition/action_continuation";
import { CN_TASK_EXECUTION_MESSAGES } from "../../../regions/messages/task_execution_messages";
import { formatActiveTaskRelationContext } from "../../../cognition/task_concurrency";
import type { prepareChatPriorTaskQuery } from './prepare_chat_prior_task_query';

export async function prepareChatConversationContext(context: NonNullable<Awaited<ReturnType<typeof prepareChatPriorTaskQuery>>["context"]>) {

      if (await answerPriorTaskStatus(context)) { return { terminal: true as const, context: undefined }; }

      // `deferActionPreparation` persisted only the transcript while this
      // request waited. Now that this request owns the serial lease, bind its
      // exact user row. A different pending request is an integrity failure,
      // not permission to overwrite the pointer and mis-attribute receipts.
      if (context.resolvedTaskRelation.feedback !== 'status') {
        const preserveExistingTask = (
          ['active_task', 'previous_task'].includes(context.resolvedTaskRelation.binding)
          && ['continue', 'correction', 'accept', 'retry', 'repeat'].includes(
            context.resolvedTaskRelation.feedback,
          )
        );
        const boundTurn = bindConversationActionExecutionTurn({
          conversationId: context.conversation.id,
          userId: context.uid,
          userText: context.visibleUserText,
          requestId: context.requestId,
          userMessageId: context.acceptedUserMessageId,
          preserveExistingTask,
        });
        if (!boundTurn) {
          await context.commitDeterministicTerminal({
            event: 'agent:error',
            payload: {
              message: 'Unable to bind this queued message to the action pipeline',
              code: 'CHAT_ACTION_TURN_BIND_FAILED',
            },
            errorContext: 'Action turn binding failure terminal',
          });
          await context.releaseChatSession();
          { return { terminal: true as const, context: undefined }; }
        }
        context.conversation = getConversationForScope(
          context.conversation.id,
          context.uid,
          context.resolvedDomain,
          context.resolvedOrgId,
        ) || context.conversation;
      }
      let { relevantMemories, ragChunks, emotionalState, personalityConfig, kbContext, isNovel, himState, emotionKey } = await retrieveChatContext(context);

      // ── Conversation mode: get/create conversation, apply mode from payload ──
      const conversationId = context.conversation?.id;
      if (context.conversationTurn.rolledOver) {
        console.log(
          '[ChatHandler] rolled over oversized conversation:',
          context.conversationTurn.previousConversationId,
          '->',
          conversationId,
        );
        // The client may still send its old local transcript after a server-side
        // rollover. Re-evaluate direct client intent without letting that stale
        // transcript reactivate a prior UI task.
        context.chatContextBridge = buildClientSurfaceContinuationBridge(context.visibleUserText, []);
        await clearPendingConfirmationDurably(context.uid, context.confirmationScope);
        context.pendingConfirmation = null;
        context.pendingConfirmationPrompt = '';
      }
      const conversationMode = context.payloadMode || context.conversation?.mode || undefined;
      if (context.conversation && context.payloadMode && context.payloadMode !== context.conversation.mode) {
        setConversationMode(context.conversation.id, context.payloadMode);
      }
      console.log('[ChatHandler] conversationId:', conversationId, 'mode:', conversationMode);

      if (conversationId && context.confirmationCancellationRequested) {
        const cancelled = cancelConversationActionExecution(conversationId, context.uid);
        const cancelledCurrentTask = cancelled?.status === 'cancelled';
        if (cancelledCurrentTask || context.pendingConfirmationCleared) {
          const responseText = context.pendingConfirmationCleared
            ? CN_TASK_EXECUTION_MESSAGES.pendingConfirmationCancelled
            : CN_TASK_EXECUTION_MESSAGES.cancelled;
          await context.commitDeterministicTerminal({
            payload: { text: responseText, agentName: "Lumi", finalized: true, blocked: false, reason: '' },
            persistAssistantMessage: () => context.addMessageIdempotent({ conversationId, role: 'assistant', content: responseText, cognitiveIntent: 'task_cancel', skipActionContinuation: true }),
            publishAfter: () => context.emitConversationUpdated({ conversationId, agentId: context.conversationAgentId, source: 'chat', rolledOver: context.conversationTurn.rolledOver, previousConversationId: context.conversationTurn.previousConversationId }),
            errorContext: 'Pending confirmation cancellation terminal',
          });
          await context.releaseChatSession();
          { return { terminal: true as const, context: undefined }; }
        }
        const boundTerminalTask = context.resolvedTaskRelation.taskId
          ? getConversationActionStateByTaskId(readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]), {
              conversationId,
              userId: context.uid,
              taskId: context.resolvedTaskRelation.taskId,
            })
          : getLatestConversationActionState(readDatabaseTables(["conversationActionTurns","conversations","interactions","conversationActionTasks","conversationActionReceipts"]), { conversationId, userId: context.uid });
        if (boundTerminalTask && !boundTerminalTask.unfinished) {
          const english = !/[\u3400-\u9fff]/u.test(context.visibleUserText);
          const responseText = english
            ? boundTerminalTask.status === 'completed'
              ? `The task "${boundTerminalTask.goal || 'the previous task'}" is already completed. Cancellation cannot undo its recorded result, and I did not execute anything again.`
              : `The task "${boundTerminalTask.goal || 'the previous task'}" is already ${boundTerminalTask.status || 'terminal'}. There is nothing left to stop, and I did not execute anything again.`
            : CN_TASK_EXECUTION_MESSAGES.terminalCannotCancel(
                boundTerminalTask.goal,
                boundTerminalTask.status || 'terminal',
              );
          await context.commitChatReply({
            text: responseText,
            reason: 'task_already_terminal',
            message: () => ({
              conversationId,
              cognitiveIntent: 'task_already_terminal',
              llmWasCalled: false,
              skipActionContinuation: true,
            }),
            publishAfter: () => context.emitConversationUpdated({
              conversationId,
              agentId: context.conversationAgentId,
              source: 'chat',
              rolledOver: context.conversationTurn.rolledOver,
              previousConversationId: context.conversationTurn.previousConversationId,
            }),
            errorContext: 'Terminal task cancellation no-op',
          });
          await context.releaseChatSession();
          { return { terminal: true as const, context: undefined }; }
        }
        const responseText = CN_TASK_EXECUTION_MESSAGES.noPendingOperation;
        await context.commitDeterministicTerminal({
          payload: { text: responseText, agentName: "Lumi", finalized: true, blocked: false, reason: '' },
          persistAssistantMessage: () => context.addMessageIdempotent({ conversationId, role: 'assistant', content: responseText, cognitiveIntent: 'task_cancel', skipActionContinuation: true }),
          publishAfter: () => context.emitConversationUpdated({ conversationId, agentId: context.conversationAgentId, source: 'chat', rolledOver: context.conversationTurn.rolledOver, previousConversationId: context.conversationTurn.previousConversationId }),
          errorContext: 'No pending confirmation terminal',
        });
        await context.releaseChatSession();
        { return { terminal: true as const, context: undefined }; }
      }

      const persistedConversationHistory = conversationId
        ? getMessages(conversationId, TASK_TARGET_HISTORY_LIMIT).filter(record => !(
            record.role === 'user'
            && (
              record.requestId === context.requestId
              || (
                record.externalMessageId === context.requestId
                && record.source === context.eventSource
                && record.channel === 'chat'
              )
            )
          ))
        : [];
      if (!context.chatContextBridge && conversationId && isShortClientContinuation(context.visibleUserText)) {
        const dbHistoryItems = persistedConversationHistory.slice(-12)
          .map(record => ({ role: record.role, message: record.message, response: record.response }));
        context.chatContextBridge = buildClientSurfaceContinuationBridge(context.visibleUserText, dbHistoryItems);
      }
      context.actionContinuationBridge = context.explicitRuntimeWorkStatusRequest
        ? ''
        : buildRecentActionContinuationBridge(
            context.visibleUserText,
            context.conversationTurn.rolledOver
              ? persistedConversationHistory
              : [...context.historyItems, ...persistedConversationHistory],
            context.conversation?.actionContinuationState,
          );
      const taskRelationContext = formatActiveTaskRelationContext(
        context.resolvedTaskRelation,
        context.conversation?.actionContinuationState,
      );
      if (taskRelationContext) {
        context.actionContinuationBridge = [context.actionContinuationBridge, taskRelationContext]
          .filter(Boolean)
          .join('\n\n');
      }
      const operationMode = (() => {
        if (typeof context.data.operationMode === 'string') return normalizeOperationMode(context.data.operationMode);
        try {
          return getStoredOperationMode(context.uid);
        } catch {}
        return 'assistant';
      })();
      let { turnFlow, executionPipeline, personality, effectiveSystemPrompt, executionTaskText, completionTaskText } = await prepareChatPromptContext(extendTurnBindings(context, {
    get relevantMemories(): typeof relevantMemories { return relevantMemories; },
    set relevantMemories(value: typeof relevantMemories) { relevantMemories = value; },
    get ragChunks(): typeof ragChunks { return ragChunks; },
    set ragChunks(value: typeof ragChunks) { ragChunks = value; },
    get emotionalState(): typeof emotionalState { return emotionalState; },
    set emotionalState(value: typeof emotionalState) { emotionalState = value; },
    get personalityConfig(): typeof personalityConfig { return personalityConfig; },
    set personalityConfig(value: typeof personalityConfig) { personalityConfig = value; },
    conversationId: conversationId as typeof conversationId,
    conversationMode: conversationMode as typeof conversationMode,
    operationMode: operationMode as typeof operationMode,
    persistedConversationHistory: persistedConversationHistory as typeof persistedConversationHistory,
    get kbContext(): typeof kbContext { return kbContext; },
    set kbContext(value: typeof kbContext) { kbContext = value; },
  }));
  return { terminal: false as const, context: extendTurnBindings(context, {
    get turnFlow(): typeof turnFlow { return turnFlow; },
    set turnFlow(value: typeof turnFlow) { turnFlow = value; },
    get executionPipeline(): typeof executionPipeline { return executionPipeline; },
    set executionPipeline(value: typeof executionPipeline) { executionPipeline = value; },
    conversationId: conversationId as typeof conversationId,
    get personality(): typeof personality { return personality; },
    set personality(value: typeof personality) { personality = value; },
    persistedConversationHistory: persistedConversationHistory as typeof persistedConversationHistory,
    get effectiveSystemPrompt(): typeof effectiveSystemPrompt { return effectiveSystemPrompt; },
    set effectiveSystemPrompt(value: typeof effectiveSystemPrompt) { effectiveSystemPrompt = value; },
    operationMode: operationMode as typeof operationMode,
    get executionTaskText(): typeof executionTaskText { return executionTaskText; },
    set executionTaskText(value: typeof executionTaskText) { executionTaskText = value; },
    get completionTaskText(): typeof completionTaskText { return completionTaskText; },
    set completionTaskText(value: typeof completionTaskText) { completionTaskText = value; },
    get emotionalState(): typeof emotionalState { return emotionalState; },
    set emotionalState(value: typeof emotionalState) { emotionalState = value; },
    get isNovel(): typeof isNovel { return isNovel; },
    set isNovel(value: typeof isNovel) { isNovel = value; },
    get himState(): typeof himState { return himState; },
    set himState(value: typeof himState) { himState = value; },
    get emotionKey(): typeof emotionKey { return emotionKey; },
    set emotionKey(value: typeof emotionKey) { emotionKey = value; },
  }) };
}
