import { createToolLifecycleCallbacks } from "../tool_lifecycle";
import type { ToolContext } from "../../tools/types";
import type { ChatMessageWriter } from "./message_writer";


import { type ToolSessionOptions } from "../../llm/lumi_turn";

import { Socket } from "socket.io";

import { ToolExecutionRecord } from "../../tools/types";
import { type MediaArtifactReceipt } from "../media_artifact_receipt";

import { toolRegistry } from "../../tools/registry";
import { executeToolCall } from "../../tools/execution_engine";
import { buildConfirmedStepContinuationMessages, type LLMResult } from "../../llm/adapter";

import { buildLumiCapabilitySelection } from "../../cognition/capability_selection";

import { withDesktopExecutionReceipt } from "../../desktop/execution_runtime";
import { finalizeLumiResponse, tryFinalizeVerifiedBoundedAction } from "../../cognition/result_finalizer";
import { buildForegroundTaskCompletionFeedback } from "../../cognition/acceptance_evidence";

import { consumePendingConfirmationDurably, formatPendingConfirmationRequest } from "../../tools/pending_confirmation";

import { setConversationActionExecutionStatus } from "../../conversation/manager";

import { coalesceToolExecutionRecords, confirmedStepNeedsContinuation, toolRecordSucceeded } from "../../cognition/task_execution_ledger";

import { recordTokenUsageBatch } from "../../llm/token_tracker";

import { CN_VOICE_FAST_PATH_MESSAGES } from "../../regions/messages/voice_fast_path_messages";
import { CN_TASK_EXECUTION_MESSAGES } from "../../regions/messages/task_execution_messages";

import { isDirectDesktopTool } from "../desktop_relay";

import { type ActiveTaskMessageResolution } from "../../cognition/task_concurrency";

type executeConfirmedChatTurnInput = {
toolContext: ToolContext;
pendingConfirmation: import("../../tools/pending_confirmation").PendingToolConfirmation;
visibleUserText: string;
uid: string;
confirmationScope: import("../../tools/pending_confirmation").PendingConfirmationScope;
emitAgent: (event: string, payload?: Record<string, any>) => boolean;
personality: Record<string, any> | import("../../personality/types").PersonalityConfig;
emitToolLifecycle: (payload: { correlationId: string; name: string; arguments: Record<string, any>; args?: Record<string, any>; result?: string; error?: string; artifactReceipt?: MediaArtifactReceipt; }) => void;
durableTaskId: string;
requestId: string;
resolvedDomain: import("../scope").RuntimeDomain;
resolvedOrgId: string;
abortController: AbortController;
isChatCancelled: () => boolean;
turnFlow: import("../../cognition/turn_flow").LumiTurnFlow;
modelCapabilityPolicy: import("../../personality/types").ToolPolicy;
rememberRequestToolRecord: (record: ToolExecutionRecord) => void;
formatToolResultForUi: (value?: string) => string;
formatMediaArtifactReceiptForUi: (name: string, args?: Record<string, any>, result?: string, error?: string) => MediaArtifactReceipt;
taskAwareRecords: (records: ToolExecutionRecord[]) => ToolExecutionRecord[];
runAuthorizedTools: (input: ToolSessionOptions) => Promise<LLMResult>;
effectiveSystemPrompt: string;
acceptedUserMessageId: string;
activeProvider: import("../../llm/user_preferences").UserLLMProvider;
activeModel: string;
reasoningRoutePolicy: { interactionId: `${string}-${string}-${string}-${string}-${string}`; source: string; inputTokenBudget: number; nativeDeviceId?: string; executionSessionId?: string; nativeClientIdentitySha256?: string; selectionMode: import("../../llm/user_preferences").UserLLMSelectionMode; fallbackCandidates: import("../../llm/user_preferences").UserLLMFallbackCandidate[]; allowCloudFallback: boolean; conversationId: string; requestId: string; thinkingMode?: "disabled"; };
requestToolConfirmation: (toolName: string, args: Record<string, any>) => Promise<boolean>;
desktopExecutionTracker: import("../../desktop/execution_runtime").DesktopExecutionTracker;
interactionId: `${string}-${string}-${string}-${string}-${string}`;
turnAuthorization: import("../../conversation/lifecycle").RequestAuthorization;
socket: Socket;
requestToolRecords: ToolExecutionRecord[];
pendingConfirmationCreatedThisTurn: import("../../tools/pending_confirmation").PendingToolConfirmation;
normalizeAgentPayload: (event: string, payload?: Record<string, any>, outputProtection?: { trustedConfirmationRequestText?: string; }) => Record<string, any>;
conversationId: string;
pendingConfirmationAssistantState: string;
chatDurabilityUnknownText: (userText: string) => string;
actionLeaseHeartbeat: import("../../conversation/action_execution_runtime").ConversationActionExecutionHeartbeat;
releaseChatSession: (reason?: string) => Promise<boolean>;
commitRecordedTerminal: (input: { payload: Record<string, any>; unknownPayload: Record<string, any>; persistTerminalState: () => ReturnType<(assistantText: string, options?: { toolRecords?: ToolExecutionRecord[]; source?: string; sourceInteractionId?: string; capabilitySelection?: ReturnType<typeof buildLumiCapabilitySelection>; finalizationBlocked?: boolean; assistantTextTrusted?: boolean; finalizationReason?: string; }) => import("../../work_takeover/execution_writeback").WorkTakeoverTurnExecutionWritebackResult>; persistAssistantMessage: () => void; notification?: Record<string, any>; llmWasCalled?: boolean; repairUnknownAssistant?: boolean; updateSource?: string; errorContext: string; }) => Promise<boolean>;
persistChatTakeoverExecution: (assistantText: string, options?: { toolRecords?: ToolExecutionRecord[]; source?: string; sourceInteractionId?: string; capabilitySelection?: ReturnType<typeof buildLumiCapabilitySelection>; finalizationBlocked?: boolean; assistantTextTrusted?: boolean; finalizationReason?: string; }) => import("../../work_takeover/execution_writeback").WorkTakeoverTurnExecutionWritebackResult;
capabilitySelection: import("../../cognition/execution_pipeline").LumiCapabilityPlan;
addMessageIdempotent: ChatMessageWriter;
refreshTerminalPayloadTaskRelation: (payload: Record<string, any>, exactTaskId?: string) => ActiveTaskMessageResolution;
scheduleChatSummary: (targetConversationId: string) => void;
persistChatLearning: (assistantText: string, options?: { channel?: "chat" | "workflow"; toolRecords?: ToolExecutionRecord[]; sourceInteractionId?: string; logLabel?: string; }) => void;
};
export async function executeConfirmedChatTurn(context: executeConfirmedChatTurnInput) {

        const confirmedTask = context.pendingConfirmation.actionIntent || context.visibleUserText;
        const confirmedArgs = context.pendingConfirmation.exactArgs || {};
        const confirmedRecordId =
          `chat-confirmed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const consumed = await consumePendingConfirmationDurably(
          context.uid,
          context.pendingConfirmation.id,
          context.pendingConfirmation.toolName,
          confirmedArgs,
          context.confirmationScope,
        );
        context.emitAgent('agent:status', { status: 'thinking', agentName: context.personality.name, phase: 'tool' });
        if (!isDirectDesktopTool(context.pendingConfirmation.toolName)) {
          context.emitToolLifecycle({
            correlationId: confirmedRecordId,
            name: context.pendingConfirmation.toolName,
            arguments: confirmedArgs,
          });
        }
        const confirmedRecord = await executeToolCall({
          registry: toolRegistry,
          id: confirmedRecordId,
          name: context.pendingConfirmation.toolName,
          arguments: confirmedArgs,
          context: {
            ...context.toolContext,
            source: 'chat_confirmation',
            userConfirmed: true,
            actionIntent: confirmedTask,
            routedTaskText: confirmedTask,
          },
          preflight: () => consumed
            ? { allowed: true, arguments: confirmedArgs }
            : {
                allowed: false,
                arguments: confirmedArgs,
                reason: 'The one-time confirmation expired before execution.',
              },
        });
        confirmedRecord.executionOrigin = 'confirmed_action_resume';
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
        if (
          !completedConfirmedAction
          &&
          confirmedStepNeedsContinuation(
            confirmedTask,
            context.taskAwareRecords([confirmedRecord]),
          )
          && !context.isChatCancelled()
        ) {
          confirmationLlmWasCalled = true;
          const continuation = await context.runAuthorizedTools({
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
          blocked: finalized.blocked,
          reason: finalized.reason,
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
