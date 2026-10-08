import type { prepareChatPriorTaskQuery } from './phases/prepare_chat_prior_task_query';

import { toolRegistry } from "../../tools/registry";
import { executeToolCall } from "../../tools/execution_engine";

import { buildForegroundTaskCompletionFeedback } from "../../cognition/acceptance_evidence";

import { formatRuntimeCleanupReceipt } from "../../regions/messages/runtime_cleanup_messages";

import { personalityRegistry } from "../../personality";

import { addMessage, getConversationActionStatus, prepareConversationActionExecution } from "../../conversation/manager";

import { formatConversationExecutionFactAnswer, getConversationExecutionFacts, isConversationExecutionFactQuestion } from "../../conversation/execution_facts";

import { summarizeToolRecordForPersistence } from "../../cognition/tool_record_status";

type answerPriorTaskStatusInput = NonNullable<Awaited<ReturnType<typeof prepareChatPriorTaskQuery>>['context']>;
export async function answerPriorTaskStatus(context: answerPriorTaskStatusInput) {

      if (context.runtimeCancellationRecheck) {
        const recheckPolicy = {
          allowedTools: ['runtime_work_cancel'],
          requireConfirmation: [],
          forbiddenTools: [],
          maxIterations: 1,
        };
        const recheckPreparation = prepareConversationActionExecution({
          conversationId: context.conversation.id,
          userId: context.uid,
          userText: context.visibleUserText,
          requestId: context.requestId,
          userMessageId: context.acceptedUserMessageId,
          toolPolicy: recheckPolicy,
          forceResume: true,
          forceNewTask: false,
          forceTask: true,
          preserveExistingTask: true,
        });
        if (recheckPreparation.state?.taskId === context.runtimeCancellationRecheck.taskId) {
          const recheckState = recheckPreparation.state;
          context.foregroundRequestIdentity = Object.freeze({
            conversationId: context.conversation.id,
            userId: context.uid,
            requestId: context.requestId,
            expectedTaskId: context.runtimeCancellationRecheck.taskId,
          });
          context.resolvedTaskRelation = {
            ...context.resolvedTaskRelation,
            binding: 'active_task',
            taskId: recheckState.taskId,
            revision: recheckState.revision,
            targetRequestId: recheckState.activeRequestId || context.requestId,
          };
          context.emitAgent('agent:task_relation', {
            relation: context.resolvedTaskRelation,
            phase: 'runtime_cleanup_recheck_prepared',
          });
          const recheckRecord = await executeToolCall({
            registry: toolRegistry,
            id: `runtime_cleanup_recheck_${context.requestId}`,
            name: 'runtime_work_cancel',
            arguments: { taskIds: [...context.runtimeCancellationRecheck.taskIds] },
            executionOrigin: 'deterministic_route',
            context: {
              ...context.toolSecurityContext,
              userId: context.uid,
              taskId: context.runtimeCancellationRecheck.taskId,
              conversationId: context.conversation.id,
              turnId: context.requestId,
              requestId: context.requestId,
              domain: context.resolvedDomain,
              orgId: context.resolvedOrgId,
              source: 'chat_runtime_cleanup_recheck',
              turnRowId: 'turnRowId' in recheckPreparation ? recheckPreparation.turnRowId : undefined,
              resolutionId: context.acceptedTurnResolution?.id,
              toolPolicy: recheckPolicy,
              actionIntent: context.previousActionState?.goal || context.visibleUserText,
              routedTaskText: context.previousActionState?.goal || context.visibleUserText,
              // This is an idempotent verification of the exact immutable IDs
              // accepted in the immediately preceding cancellation receipt,
              // not fresh mutation authority and never a cancel-all request.
              userConfirmed: true,
              executionSignal: context.abortController.signal,
              isCancelled: context.isChatCancelled,
            },
          });
          const recheckLifecycle = {
            correlationId: recheckRecord.id || `runtime_cleanup_recheck_${context.requestId}`,
            name: recheckRecord.name,
            arguments: recheckRecord.arguments,
            args: recheckRecord.arguments,
            result: recheckRecord.error ? undefined : context.formatToolResultForUi(recheckRecord.result),
            error: recheckRecord.error,
          };
          context.emitAgent('agent:tool_call', recheckLifecycle);
          context.emitAgent('agent:tool', recheckLifecycle);
          let recheckReceipt: Record<string, any> = {
            ok: false,
            status: 'failed',
            requestedTaskIds: context.runtimeCancellationRecheck.taskIds,
            cancelledTaskIds: [],
            cancellingTaskIds: [],
            notCancelledTaskIds: context.runtimeCancellationRecheck.taskIds,
            targetResults: context.runtimeCancellationRecheck.taskIds.map(taskId => ({ taskId, status: 'failed' })),
          };
          try {
            const parsed = JSON.parse(String(recheckRecord.result || '{}'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              recheckReceipt = parsed;
            }
          } catch {}
          const recheckSettled = !recheckRecord.error
            && recheckRecord.terminalVerification?.status === 'verified'
            && ['idle', 'cancelled'].includes(String(recheckReceipt.status || ''));
          const recheckPending = !recheckRecord.error
            && String(recheckReceipt.status || '') === 'cancelling';
          const recheckReason = recheckSettled
            ? 'runtime_cleanup_recheck_completed'
            : recheckPending
              ? 'runtime_cleanup_recheck_pending'
              : 'runtime_cleanup_recheck_failed';
          const recheckText = formatRuntimeCleanupReceipt(context.visibleUserText, recheckReceipt);
          const recheckCompletionFeedback = buildForegroundTaskCompletionFeedback({
            taskId: context.runtimeCancellationRecheck.taskId,
            taskLabel: context.previousActionState?.goal || context.visibleUserText,
            toolRecords: [recheckRecord],
            finalization: { blocked: !recheckSettled,
            reason: recheckSettled
              ? ''
              : recheckPending
                ? 'Cancellation is still in progress.'
                : recheckRecord.error
                  || recheckRecord.terminalVerification?.reason
                  || 'The exact runtime cancellation could not be verified.' },
          });
          await context.commitDeterministicTerminal({
            payload: {
              text: recheckText,
              agentName: 'Lumi',
              finalized: true,
              blocked: !recheckSettled,
              reason: recheckReason,
              completionFeedback: recheckCompletionFeedback,
            },
            persistAssistantMessage: () => {
              const summary = summarizeToolRecordForPersistence(recheckRecord);
              if (summary) {
                addMessage({
                  userId: context.uid,
                  agentId: context.conversationAgentId,
                  conversationId: context.conversation.id,
                  role: 'tool',
                  content: summary,
                  domain: context.resolvedDomain,
                  orgId: context.resolvedOrgId,
                });
              }
              context.addMessageIdempotent({
                conversationId: context.conversation.id,
                role: 'assistant',
                content: recheckText,
                personality: personalityRegistry.get('lumi')?.id || 'lumi',
                source: 'chat_runtime_cleanup_recheck',
                toolCalls: [recheckRecord],
                cognitiveIntent: recheckReason,
                llmWasCalled: false,
                completionFeedback: recheckCompletionFeedback,
              });
            },
            publishAfter: () => context.emitConversationUpdated({
              conversationId: context.conversation.id,
              agentId: context.conversationAgentId,
              source: 'chat_runtime_cleanup_recheck',
              rolledOver: context.conversationTurn.rolledOver,
              previousConversationId: context.conversationTurn.previousConversationId,
            }),
            errorContext: 'Runtime cleanup recheck terminal',
          });
          await context.releaseChatSession();
          return true;
        }
      }
      if (
        context.acceptedFollowupIntent === 'status'
        && (
          context.confirmationNeedsFreshReview
          || context.asksAboutBoundConversationTask
          || context.asksAboutRecentConversationTask
          || (
            context.acceptedNormalizedIntent.kind === 'status_query'
            && context.acceptedNormalizedIntent.target === 'previous_action'
          )
        )
      ) {
        const executionFactQuestion = isConversationExecutionFactQuestion(context.visibleUserText);
        const statusText = executionFactQuestion
          ? formatConversationExecutionFactAnswer(getConversationExecutionFacts({
              conversationId: context.conversation.id,
              userId: context.uid,
              domain: context.resolvedDomain,
              orgId: context.resolvedOrgId,
              currentRequestId: context.requestId,
              taskId: context.serverBoundRecheckTaskId || context.previousActionState?.taskId || '',
            }), context.visibleUserText)
          : getConversationActionStatus(
              context.conversation.id,
              context.uid,
              context.visibleUserText,
              context.conversation.actionContinuationState,
              context.resolvedTaskRelation.taskId || '',
            );
        const responseIntent = executionFactQuestion
          ? 'execution_facts'
          : context.confirmationNeedsFreshReview
            ? 'reconfirmation_required'
            : 'task_status';
        await context.commitDeterministicTerminal({
          payload: {
            text: statusText,
            agentName: 'Lumi',
            finalized: true,
            blocked: context.confirmationNeedsFreshReview,
            reason: responseIntent,
          },
          persistAssistantMessage: () => context.addMessageIdempotent({
            conversationId: context.conversation.id,
            role: 'assistant',
            content: statusText,
            source: executionFactQuestion ? 'chat_conversation_execution_facts' : 'chat_task_status',
            cognitiveIntent: responseIntent,
            llmWasCalled: false,
            skipActionContinuation: true,
          }),
          publishAfter: () => {
            context.emitConversationUpdated({
            conversationId: context.conversation.id,
            agentId: context.conversationAgentId,
            source: executionFactQuestion ? 'chat_conversation_execution_facts' : 'chat_task_status',
            rolledOver: context.conversationTurn.rolledOver,
              previousConversationId: context.conversationTurn.previousConversationId,
            });
          },
          errorContext: 'Deterministic task status terminal',
        });
        await context.releaseChatSession();
        return true;
      }
return false;
}
