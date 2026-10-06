import { CN_VOICE_FAST_PATH_MESSAGES } from "../../../regions/messages/voice_fast_path_messages";
import { getOrCreateActiveConversation, getMessages, getConversationActionStatus, completeConversationActionFromUserObservation } from "../../../conversation/manager";
import { formatConversationActionTaskStatus } from "../../../cognition/action_continuation";
import { buildTransportNeutralConfirmationScope, clearPendingConfirmationDurably, consumePendingConfirmationDurably } from "../../../tools/pending_confirmation";
import { toolRegistry } from "../../../tools/registry";
import { withDesktopExecutionReceipt } from "../../../desktop/execution_runtime";
import { coalesceToolExecutionRecords, recordsToTaskReceipts, confirmedStepNeedsContinuation, toolRecordSucceeded } from "../../../cognition/task_execution_ledger";
import type { ToolExecutionRecord } from "../../../tools/types";
import { isExplicitMemoryRequest, persistTurnMemory } from "../../../memory/turn_memory";
import { isDirectDesktopTool } from "../../desktop_relay";
import { buildConfirmedStepContinuationMessages } from "../../../llm/adapter";
import { formatConversationExecutionFactAnswer, getConversationExecutionFacts, isConversationExecutionFactQuestion } from "../../../conversation/execution_facts";
import { resolveExactConversationCorrection } from "../../../conversation/exact_correction";
import { executeToolCall } from "../../../tools/execution_engine";
import { finalizeLumiResponse, tryFinalizeVerifiedBoundedAction } from "../../../cognition/result_finalizer";
import { recordTokenUsageBatch } from "../../../llm/token_tracker";
import { collectRecentActionToolRecords, describeRecentActionsFromHistory } from "../../voice_action_history";
import { runLumiTurn } from "../../../llm/lumi_turn";
import type { prepareVoiceRelease } from './prepare_voice_release';

export async function executeVoiceConfirmedAndDeterministicTurn(context: NonNullable<Awaited<ReturnType<typeof prepareVoiceRelease>>["context"]>) {

    if (context.transcriptExecutionGuard.action === 'clarify') {
      // Resolve uncertain STT before confirmation, meeting control, or tools.
      context.responseText = context.transcriptExecutionGuard.responseText;
      await context.finishVoiceTerminal({
        text: context.responseText,
        source: 'voice_transcript_guard',
        blocked: false,
        reason: context.transcriptExecutionGuard.reason,
        cognitiveIntent: 'voice_transcript_clarification',
        llmWasCalled: false,
        speechText: context.responseText,
      });
      { return { terminal: true as const, context: undefined }; }
    }

    if (!context.session.agentId?.startsWith('memory_avatar_') && isExplicitMemoryRequest(context.userText)) {
        const receipt = await persistTurnMemory({ userId: context.session.userId, domain: context.voiceScope.domain, orgId: context.voiceScope.orgId,
          userText: context.userText, channel: 'voice', source: 'voice', requestId: context.requestId, conversationId: context.conversationTurn.conversation.id,
          agentId: context.session.agentId, authorization: context.turnAuthorization, signal: context.pipelineAbort.signal, llmGetters: context.llmGetters });
        context.responseText = receipt.text;
        await context.finishVoiceTerminal({ text: receipt.text, speechText: receipt.text, source: 'voice_memory',
          blocked: receipt.status === 'failed', reason: receipt.status === 'saved' ? 'memory_saved' : 'memory_not_saved',
          cognitiveIntent: 'memory', llmWasCalled: true, toolCalls: [] });
      { return { terminal: true as const, context: undefined }; }
    }

    const deterministicConversationResponse = (() => {
      if (context.userObservedCompletion) return null;
      if (isConversationExecutionFactQuestion(context.actionIntentText)) {
        return {
          text: formatConversationExecutionFactAnswer(getConversationExecutionFacts({
            conversationId: context.conversationTurn.conversation.id,
            userId: context.session.userId,
            domain: context.voiceScope.domain,
            orgId: context.voiceScope.orgId,
            currentRequestId: context.requestId,
            taskId: context.actionTaskExecution.state?.taskId
              || context.conversationTurn.conversation.actionContinuationState?.taskId
              || undefined,
          }), context.actionIntentText),
          intent: 'execution_facts',
          source: 'voice_conversation_execution_facts',
        };
      }
      const corrected = resolveExactConversationCorrection(context.actionIntentText, context.recentVoiceHistory);
      return corrected
        ? { text: corrected, intent: 'exact_correction', source: 'voice_exact_correction' }
        : null;
    })();
    if (deterministicConversationResponse) {
      context.responseText = deterministicConversationResponse.text;
      await context.finishVoiceTerminal({
        text: context.responseText,
        source: deterministicConversationResponse.source,
        blocked: false,
        reason: deterministicConversationResponse.intent,
        cognitiveIntent: deterministicConversationResponse.intent,
        llmWasCalled: false,
        speechText: context.responseText,
      });
      { return { terminal: true as const, context: undefined }; }
    }

    if (context.userObservedCompletion) {
      const conversation = context.conversationTurn.conversation;
      const observedTask = context.userObservedCompletionTask!;
      await clearPendingConfirmationDurably(context.session.userId, buildTransportNeutralConfirmationScope({
        domain: context.voiceScope.domain, orgId: context.voiceScope.orgId,
        conversationId: conversation.id, taskId: observedTask.taskId,
      }));
      context.pendingConfirmation = null;
      context.pendingConfirmationPrompt = '';
      context.responseText = formatConversationActionTaskStatus({
        ...observedTask, status: 'completed', unfinished: false,
        latestBlocker: '', completionSource: 'user_observation',
      });
      await context.finishVoiceTerminal({
        text: context.responseText,
        source: 'voice_task_user_observation',
        blocked: false,
        reason: '',
        cognitiveIntent: 'task_user_observation',
        llmWasCalled: false,
        speechText: context.responseText,
        persistTerminalState: () => {
          const completed = completeConversationActionFromUserObservation(
            conversation.id, context.session.userId, context.userText,
            { taskId: observedTask.taskId!, requestId: context.requestId, userMessageId: context.voiceUserMessageId },
          );
          if (!completed) throw new Error('User observation no longer owns the pending task');
          return completed;
        },
      });
      { return { terminal: true as const, context: undefined }; }
    }

    if (context.actionFollowupIntent === 'status') {
      context.responseText = getConversationActionStatus(
        context.conversationTurn.conversation.id,
        context.session.userId,
        context.actionIntentText,
        context.conversationTurn.conversation.actionContinuationState,
      );
      await context.finishVoiceTerminal({
        text: context.responseText,
        source: 'voice_task_status',
        blocked: false,
        reason: '',
        cognitiveIntent: 'task_status',
        llmWasCalled: false,
        speechText: context.responseText,
      });
      { return { terminal: true as const, context: undefined }; }
    }

    // A short confirmation utterance is a continuation of the exact pending
    // action, not a fresh chat turn. Execute the stored tool/arguments directly
    // so the model cannot forget, rewrite, or merely print the tool protocol.
    if (context.pendingConfirmation) {
      const confirmedTask = context.pendingConfirmation.actionIntent || context.actionIntentText;
      const confirmedArgs = context.pendingConfirmation.exactArgs || {};
      const confirmationConsumed = await consumePendingConfirmationDurably(
        context.session.userId,
        context.pendingConfirmation.id,
        context.pendingConfirmation.toolName,
        confirmedArgs,
        context.confirmationScope,
      );
      const confirmationRecordId =
        `voice-confirmed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      context.session.isBackgroundWork = true;
      context.session.activeWorkStatus = 'executing';
      context.session.activeWorkStep = `Running ${context.pendingConfirmation.toolName}`;
      if (!isDirectDesktopTool(context.pendingConfirmation.toolName)) {
        context.emitToolLifecycle({
          correlationId: confirmationRecordId,
          name: context.pendingConfirmation.toolName,
          arguments: confirmedArgs,
        });
      }
      const confirmationRecord = await executeToolCall({
        registry: toolRegistry,
        id: confirmationRecordId,
        name: context.pendingConfirmation.toolName,
        arguments: confirmedArgs,
        context: {
          ...context.toolContext,
          toolPolicy: context.routedToolPolicy,
          userConfirmed: true,
          requestConfirmation: undefined,
          actionIntent: confirmedTask,
          routedTaskText: confirmedTask,
        },
        preflight: () => confirmationConsumed
          ? { allowed: true, arguments: confirmedArgs }
          : {
              allowed: false,
              arguments: confirmedArgs,
              reason: 'The one-time confirmation expired before execution.',
            },
      });
      if (!context.isCurrentTurn()) {
        { return { terminal: true as const, context: undefined }; }
      }
      if (!isDirectDesktopTool(confirmationRecord.name)) {
        if (confirmationRecord.error) {
          context.emitToolLifecycle({
            correlationId: confirmationRecord.id || `voice-confirmed-${Date.now()}`,
            name: confirmationRecord.name,
            arguments: confirmedArgs,
            error: confirmationRecord.error,
          });
        } else {
          context.emitToolLifecycle({
            correlationId: confirmationRecord.id || `voice-confirmed-${Date.now()}`,
            name: confirmationRecord.name,
            arguments: confirmedArgs,
            result: context.formatToolResultForUi(confirmationRecord.result),
          });
        }
      }
      const confirmationSucceeded = toolRecordSucceeded(confirmationRecord);
      confirmationRecord.executionOrigin = 'confirmed_action_resume';
      let confirmationRecords: ToolExecutionRecord[] = [confirmationRecord];
      let confirmationLlmWasCalled = false;
      const completedConfirmedAction = tryFinalizeVerifiedBoundedAction({
        taskText: confirmedTask,
        responseText: '',
        toolRecords: context.taskAwareRecords([confirmationRecord]),
        source: 'voice_confirmation',
        flow: { ...context.turnFlow, routeText: confirmedTask },
        taskId: context.actionTaskExecution.state?.taskId,
        requestId: context.requestId,
      });
      let confirmationCandidate = completedConfirmedAction?.text || (confirmationSucceeded
        ? CN_VOICE_FAST_PATH_MESSAGES.confirmationExecuted
        : CN_VOICE_FAST_PATH_MESSAGES.confirmationFailed(
            recordsToTaskReceipts([confirmationRecord])[0]?.error
              || confirmationRecord.error
              || confirmationRecord.result,
          ));

      if (!completedConfirmedAction && confirmedStepNeedsContinuation(confirmedTask, context.taskAwareRecords([confirmationRecord])) && context.isCurrentTurn()) {
        // Confirmation is a boundary inside the same task, not the end of the
        // task. Continue the remaining plan immediately with the exact confirmed
        // receipt in context; a later hard boundary will stop once again.
        context.turnAuthorization.assertCurrent();
        const continuation = await runLumiTurn({
          messages: [
            { role: 'system', content: context.voiceSystemPrompt },
            ...buildConfirmedStepContinuationMessages(confirmedTask, confirmationRecord, {
              messageId: context.voiceUserMessageId,
              text: context.userText,
            }),
          ],
          registry: toolRegistry,
          config: {
            provider: context.provider,
            model: context.voiceModel,
            modelTurnState: context.modelTurnState,
            userId: context.session.userId,
            domain: context.voiceScope.domain,
            orgId: context.voiceScope.orgId,
            signal: context.pipelineAbort.signal,
            inputTokenBudget: context.voiceInputTokenBudget,
            ...context.reasoningRoutePolicy,
          },
          onToolCall: context.observeVoiceTools().onToolCall,
          maxIterations: Math.max(1, context.routedToolPolicy.maxIterations || 5),
          context: {
            ...context.toolContext,
            actionIntent: confirmedTask,
            routedTaskText: confirmedTask,
            toolPolicy: context.routedToolPolicy,
            priorToolRecords: context.taskAwareRecords([confirmationRecord]),
          },
          getters: context.llmGetters,
        });
        if (!context.isCurrentTurn()) {
          { return { terminal: true as const, context: undefined }; }
        }
        confirmationRecords = coalesceToolExecutionRecords([confirmationRecord, ...(continuation.toolCalls || [])]);
        confirmationLlmWasCalled = continuation.usageRecords.length > 0;
        recordTokenUsageBatch(context.session.userId, continuation.usageRecords, context.requestId, 'voice');
        context.completionGuard = continuation.completionGuard;
        confirmationCandidate = context.pendingConfirmationCreatedThisTurn
          ? context.trustedVoiceConfirmationText!
          : continuation.text || confirmationCandidate;
      }
      confirmationRecords = withDesktopExecutionReceipt(confirmationRecords, context.desktopExecutionTracker);
      const confirmedFinal = context.pendingConfirmationCreatedThisTurn
        ? {
            text: context.trustedVoiceConfirmationText!,
            blocked: false,
            reason: 'waiting_confirmation',
            notification: undefined,
          }
        : finalizeLumiResponse({
            taskText: confirmedTask,
            responseText: confirmationCandidate,
            completionGuard: context.completionGuard,
            toolRecords: context.taskAwareRecords(confirmationRecords),
            source: 'voice_confirmation',
            flow: { ...context.turnFlow, routeText: confirmedTask },
            taskId: context.actionTaskExecution.state?.taskId,
            requestId: context.requestId,
          });
      context.responseText = confirmedFinal.text;
      await context.finishVoiceTerminal({
        text: context.responseText,
        source: 'voice_confirmation',
        blocked: confirmedFinal.blocked,
        reason: confirmedFinal.reason || '',
        cognitiveIntent: confirmedFinal.blocked ? 'work_product_guard' : 'confirmation',
        llmWasCalled: confirmationLlmWasCalled,
        toolCalls: confirmationRecords,
        speechText: context.responseText,
        notification: confirmedFinal.notification,
      }, {
        onCommitted: () => {
          context.persistVoiceLearning(context.responseText, {
            toolRecords: confirmationRecords,
            sourceInteractionId: `voice_confirmation_${Date.now()}`,
            logLabel: 'voice confirmation',
          });
        },
      });
      { return { terminal: true as const, context: undefined }; }
    }

    let recentActionExplanation: string | null = context.interruptedActivityResponse;
    let recentActionEvidence: ToolExecutionRecord[] = [];
    try {
      const conversation = getOrCreateActiveConversation(context.session.userId, context.session.agentId, context.voiceScope.domain, context.voiceScope.orgId);
      const recentActionHistory = context.recentVoiceHistory.length > 0
        ? context.recentVoiceHistory
        : getMessages(conversation.id, 30);
      recentActionEvidence = collectRecentActionToolRecords(recentActionHistory);
      if (!recentActionExplanation) {
        recentActionExplanation = describeRecentActionsFromHistory(context.userText, recentActionHistory);
      }
    } catch {}
    if (recentActionExplanation) {
      const finalizedRecentAction = finalizeLumiResponse({
        taskText: context.actionIntentText,
        responseText: recentActionExplanation,
        toolRecords: recentActionEvidence,
        source: 'voice_action_history',
        flow: context.turnFlow,
      });
      context.responseText = finalizedRecentAction.text;
      await context.finishVoiceTerminal({
        text: context.responseText,
        source: 'voice_action_history',
        blocked: finalizedRecentAction.blocked,
        reason: finalizedRecentAction.reason || '',
        cognitiveIntent: finalizedRecentAction.blocked ? 'work_product_guard' : 'action_history',
        llmWasCalled: false,
        speechText: context.responseText,
        notification: finalizedRecentAction.notification,
      }, {
        onCommitted: () => {
          context.persistVoiceLearning(context.responseText, {
            sourceInteractionId: `voice_action_history_${Date.now()}`,
            logLabel: 'voice action history explanation',
          });
        },
      });
      { return { terminal: true as const, context: undefined }; }
    }
  return { terminal: false as const, context };
}
