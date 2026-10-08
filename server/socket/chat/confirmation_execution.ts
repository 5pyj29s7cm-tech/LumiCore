import { executeConfirmedToolStep } from '../../tools/confirmed_step';
import type { prepareChatRuntimeControlAndModel } from './phases/prepare_chat_runtime_control_and_model';

import { createToolLifecycleCallbacks } from "../tool_lifecycle";

import { ToolExecutionRecord } from "../../tools/types";

import { toolRegistry } from "../../tools/registry";
import { buildConfirmedStepContinuationMessages, type LLMResult } from "../../llm/adapter";

import { withDesktopExecutionReceipt } from "../../desktop/execution_runtime";
import { finalizeLumiResponse, tryFinalizeVerifiedBoundedAction } from "../../cognition/result_finalizer";
import { buildForegroundTaskCompletionFeedback } from "../../cognition/acceptance_evidence";

import { formatPendingConfirmationRequest } from "../../tools/pending_confirmation";

import { setConversationActionExecutionStatus } from "../../conversation/manager";

import { coalesceToolExecutionRecords, toolRecordSucceeded } from "../../cognition/task_execution_ledger";

import { recordTokenUsageBatch } from "../../llm/token_tracker";

import { CN_VOICE_FAST_PATH_MESSAGES } from "../../regions/messages/voice_fast_path_messages";
import { CN_TASK_EXECUTION_MESSAGES } from "../../regions/messages/task_execution_messages";

import { isDirectDesktopTool } from "../desktop_relay";

type executeConfirmedChatTurnInput = NonNullable<Awaited<ReturnType<typeof prepareChatRuntimeControlAndModel>>['context']>;
export async function executeConfirmedChatTurn(context: executeConfirmedChatTurnInput) {

        const confirmedTask = context.pendingConfirmation.actionIntent || context.visibleUserText;
        const confirmedArgs = context.pendingConfirmation.exactArgs || {};
        const confirmedRecordId =
          `chat-confirmed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const confirmedRecord = await executeConfirmedToolStep({
          userId: context.uid, pending: context.pendingConfirmation, scope: context.confirmationScope,
          registry: toolRegistry,
          id: confirmedRecordId,
          context: {
            ...context.toolContext,
            source: 'chat_confirmation',
            actionIntent: confirmedTask,
            routedTaskText: confirmedTask,
          },
          onReady: () => {
        context.emitAgent('agent:status', { status: 'thinking', agentName: context.personality.name, phase: 'tool' });
        if (!isDirectDesktopTool(context.pendingConfirmation.toolName)) {
          context.emitToolLifecycle({
            correlationId: confirmedRecordId,
            name: context.pendingConfirmation.toolName,
            arguments: confirmedArgs,
          });
        }

          },
        });
        context.rememberRequestToolRecord(confirmedRecord);
        if (context.isChatCancelled()) throw new DOMException('Chat confirmation execution cancelled', 'AbortError');
        if (!isDirectDesktopTool(confirmedRecord.name)) {
          context.emitToolLifecycle({
            correlationId: confirmedRecord.id || `chat-confirmed-${Date.now()}`,
            name: confirmedRecord.name,
            arguments: confirmedArgs,
            ...(confirmedRecord.error
              ? { error: confirmedRecord.error }
              : {
                  result: context.formatToolResultForUi(confirmedRecord.result),
                  artifactReceipt: context.formatMediaArtifactReceiptForUi(confirmedRecord.name, confirmedArgs, confirmedRecord.result),
                }),
          });
        }
        let confirmationRecords: ToolExecutionRecord[] = [confirmedRecord];
        let confirmationLlmWasCalled = false;
        let confirmationCompletionGuard: LLMResult['completionGuard'];
        const completedConfirmedAction = tryFinalizeVerifiedBoundedAction({
          taskText: confirmedTask,
          responseText: '',
          toolRecords: context.taskAwareRecords([confirmedRecord]),
          source: 'chat_confirmation',
          flow: { ...context.turnFlow, routeText: confirmedTask },
          taskId: context.durableTaskId,
          requestId: context.requestId,
        });
        let candidate = completedConfirmedAction?.text || (toolRecordSucceeded(confirmedRecord)
          ? CN_VOICE_FAST_PATH_MESSAGES.confirmationExecuted
          : CN_VOICE_FAST_PATH_MESSAGES.confirmationFailed(
              confirmedRecord.error || confirmedRecord.result,
            ));
        if (!completedConfirmedAction && !context.isChatCancelled()) {
          confirmationLlmWasCalled = true;
          const continuation = await context.runAuthorizedTools({
            execution: context.executionPipeline,
            messages: [
              { role: 'system', content: context.effectiveSystemPrompt },
              ...buildConfirmedStepContinuationMessages(confirmedTask, confirmedRecord, {
                messageId: context.acceptedUserMessageId,
                text: context.visibleUserText,
              }),
            ],
            registry: toolRegistry,
            config: {
              provider: context.activeProvider,
              model: context.activeModel,
              userId: context.uid,
              domain: context.resolvedDomain,
              orgId: context.resolvedOrgId,
              signal: context.abortController.signal,
              ...context.reasoningRoutePolicy,
            },
            onToolCall: createToolLifecycleCallbacks({
              emit: context.emitToolLifecycle, correlationPrefix: 'chat-confirmation-resume',
              formatResult: context.formatToolResultForUi, onRecord: context.rememberRequestToolRecord,
              artifactReceipt: record => context.formatMediaArtifactReceiptForUi(record.name, record.arguments, record.result, record.error),
            }).onToolCall,
            maxIterations: Math.max(1, context.modelCapabilityPolicy.maxIterations || 5),
            context: {
              ...context.toolContext,
              source: 'chat_confirmation_resume',
              requestConfirmation: context.requestToolConfirmation,
              actionIntent: confirmedTask,
              routedTaskText: confirmedTask,
              priorToolRecords: context.taskAwareRecords([confirmedRecord]),
              desktopExecutionTracker: context.desktopExecutionTracker,
            },
          });
          if (context.isChatCancelled()) throw new DOMException('Chat confirmation continuation cancelled', 'AbortError');
          const confirmationUsage = recordTokenUsageBatch(context.uid, continuation.usageRecords, context.interactionId);
          if (context.turnAuthorization.isCurrent()) context.socket.emit('token:usage_update', {
            userId: context.uid,
            provider: context.activeProvider,
            totalTokens: confirmationUsage,
            mode: 'chat',
            timestamp: new Date().toISOString(),
          });
          confirmationRecords = coalesceToolExecutionRecords([
            confirmedRecord,
            ...context.requestToolRecords,
            ...(continuation.toolCalls || []),
          ]);
          confirmationCompletionGuard = continuation.completionGuard;
          candidate = context.pendingConfirmationCreatedThisTurn
            ? CN_TASK_EXECUTION_MESSAGES.waitingConfirmation(confirmedTask)
            : continuation.text || candidate;
        }
        confirmationRecords = withDesktopExecutionReceipt(confirmationRecords, context.desktopExecutionTracker);
        const trustedConfirmationRequestText = context.pendingConfirmationCreatedThisTurn
          ? formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn)
          : undefined;
        const finalized = context.pendingConfirmationCreatedThisTurn
          ? {
              text: trustedConfirmationRequestText!,
              blocked: false,
              reason: 'waiting_confirmation',
              notification: undefined,
            }
          : finalizeLumiResponse({
              taskText: confirmedTask,
              responseText: candidate,
              completionGuard: confirmationCompletionGuard,
              toolRecords: context.taskAwareRecords(confirmationRecords),
              source: 'chat_confirmation',
              flow: { ...context.turnFlow, routeText: confirmedTask },
              taskId: context.durableTaskId,
              requestId: context.requestId,
            });
        const confirmationCompletionFeedback = buildForegroundTaskCompletionFeedback({
          taskId: context.durableTaskId!,
          taskLabel: confirmedTask,
          toolRecords: context.taskAwareRecords(confirmationRecords),
          finalization: finalized,
          status: context.pendingConfirmationCreatedThisTurn ? 'waiting_confirmation' : undefined,
        });
        const confirmationTerminalPayload = context.normalizeAgentPayload('agent:response', {
          text: finalized.text,
          agentName: context.personality.name,
          finalized: true,
          blocked: finalized.blocked,
          reason: finalized.reason || '',
          completionFeedback: confirmationCompletionFeedback,
        }, trustedConfirmationRequestText ? { trustedConfirmationRequestText } : undefined);
        const confirmationResponseText = String(confirmationTerminalPayload.text || '');
        if (
          context.pendingConfirmationCreatedThisTurn
          && context.conversationId
          && context.pendingConfirmationAssistantState !== confirmationResponseText
        ) {
          setConversationActionExecutionStatus(context.conversationId, context.uid, 'waiting_confirmation', {
            assistantState: confirmationResponseText,
            requestId: context.requestId,
          });
          context.pendingConfirmationAssistantState = confirmationResponseText;
        }
        const confirmationUnknownPayload = context.normalizeAgentPayload('agent:response', {
          text: context.chatDurabilityUnknownText(context.visibleUserText),
          agentName: context.personality.name,
          finalized: true,
          blocked: true,
          reason: 'persistence_unknown',
          completionFeedback: buildForegroundTaskCompletionFeedback({
            taskId: context.durableTaskId!,
            taskLabel: confirmedTask,
            toolRecords: context.taskAwareRecords(confirmationRecords),
            status: 'persistence_unknown',
            reason: 'Terminal persistence outcome is unknown.',
          }),
        });
        if (context.actionLeaseHeartbeat?.isLeaseLost()) {
          await context.actionLeaseHeartbeat.leaseLoss;
          await context.releaseChatSession();
          return;
        }
        const terminalCommitted = await context.commitRecordedTerminal({
        persistTerminalState: () => context.persistChatTakeoverExecution(confirmationResponseText, {
            toolRecords: confirmationRecords,
            source: 'chat_confirmation',
            sourceInteractionId: `${context.interactionId}_confirmation`,
            capabilitySelection: context.capabilitySelection,
            finalizationBlocked: finalized.blocked,
            assistantTextTrusted: !finalized.blocked,
            finalizationReason: finalized.reason,
          }),
          persistAssistantMessage: () => {
            if (!context.conversationId) return;
            context.addMessageIdempotent({
              conversationId: context.conversationId,
              role: 'assistant',
              content: confirmationResponseText,
              personality: context.personality.id,
              toolCalls: confirmationRecords,
              cognitiveIntent: finalized.blocked ? 'work_product_guard' : 'confirmation',
              llmWasCalled: confirmationLlmWasCalled,
              completionFeedback: confirmationCompletionFeedback,
              ...(finalized.blocked && context.durableTaskId ? {
                terminalTaskDisposition: {
                  outcome: 'blocked' as const,
                  taskId: context.durableTaskId,
                  requestId: context.requestId,
                  reason: finalized.reason
                    || 'The confirmed foreground request ended without verified goal-level completion evidence.',
                },
              } : {}),
            });
            context.refreshTerminalPayloadTaskRelation(confirmationTerminalPayload, context.durableTaskId);
          },
          payload: confirmationTerminalPayload,
          unknownPayload: confirmationUnknownPayload,
          notification: finalized.notification,
          llmWasCalled: confirmationLlmWasCalled,
          repairUnknownAssistant: true,
          errorContext: 'Confirmation terminal persistence failed:'
        });
        if (!terminalCommitted) {
          await context.releaseChatSession();
          return;
        }
        context.actionLeaseHeartbeat?.stop();
        if (context.conversationId) context.scheduleChatSummary(context.conversationId);
        if (!finalized.blocked) {
          context.persistChatLearning(confirmationResponseText, {
            toolRecords: confirmationRecords,
            sourceInteractionId: `${context.interactionId}_confirmation`,
            logLabel: 'chat confirmation',
          });
        }
        await context.releaseChatSession();
        return;
}
