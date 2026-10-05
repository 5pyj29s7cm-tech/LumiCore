

import { type ToolSessionOptions } from "../../llm/tool_session";
import { type ProviderGetters as SharedProviderGetters } from "../../llm/provider_getters";

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

import { addMessageIdempotent as addMessageIdempotentUnbound, setConversationActionExecutionStatus } from "../../conversation/manager";

import { coalesceToolExecutionRecords, confirmedStepNeedsContinuation, toolRecordSucceeded } from "../../cognition/task_execution_ledger";

import { recordTokenUsage } from "../../llm/token_tracker";

import { CN_TASK_EXECUTION_MESSAGES, CN_VOICE_FAST_PATH_MESSAGES } from "../../regions/packs/cn/voice_fast_path_messages";

import { isDirectDesktopTool } from "../desktop_relay";

import { type ActiveTaskMessageResolution } from "../../cognition/task_concurrency";

type executeConfirmedChatTurnInput = {
pendingConfirmation: import("../../tools/pending_confirmation").PendingToolConfirmation;
visibleUserText: string;
uid: string;
confirmationScope: import("../../tools/pending_confirmation").PendingConfirmationScope;
emitAgent: (event: string, payload?: Record<string, any>) => boolean;
personality: Record<string, any> | import("../../personality/types").PersonalityConfig;
emitToolLifecycle: (payload: { correlationId: string; name: string; arguments: Record<string, any>; args?: Record<string, any>; result?: string; error?: string; artifactReceipt?: MediaArtifactReceipt; }) => void;
toolSecurityContext: { onToolRecord: (record: ToolExecutionRecord) => void; authenticated?: boolean; authRole?: string; orgRole?: string; localExecution?: boolean; executionBoundary?: "trusted_local" | "remote_restricted" | "trusted_system"; };
durableTaskId: string;
conversation: import("../../conversation/manager").Conversation;
requestId: string;
actionTaskExecution: Exclude<import("../../conversation/manager").ConversationActionExecutionPreparation, { bindingFailure: unknown }>;
resolvedDomain: import("../scope").RuntimeDomain;
resolvedOrgId: string;
desktopRelay: import("../desktop_relay").DesktopRelay;
llmGetters: SharedProviderGetters & Required<Pick<SharedProviderGetters, "getOpenAI" | "getAnthropic" | "getQwen" | "getOllama" | "isOllamaAvailable" | "getLmStudio" | "isLmStudioAvailable">>;
allowLocalFileWrites: boolean;
localWriteIntentReason: string;
abortController: AbortController;
isChatCancelled: () => boolean;
forwardToolProgress: (step: string) => void;
executionPipeline: import("../../cognition/execution_pipeline").LumiExecutionPipeline;
turnFlow: import("../../cognition/turn_flow").LumiTurnFlow;
modelCapabilityPolicy: import("../../personality/types").ToolPolicy;
modelToolProjection: { toolNames: string[]; requiredToolNames?: string[]; maxTools: number; allowDynamicDiscovery?: boolean; discoveryToolName?: string; droppedToolNames?: string[]; };
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
addMessageIdempotent: (message: Parameters<typeof addMessageIdempotentUnbound>[0]) => string;
conversationAgentId: string;
eventSource: string;
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
            ...context.toolSecurityContext,
            userId: context.uid,
            taskId: context.durableTaskId,
            conversationId: context.conversation.id,
            turnId: context.requestId,
            turnRowId: context.actionTaskExecution.turnRowId,
            requestId: context.requestId,
            domain: context.resolvedDomain,
            orgId: context.resolvedOrgId,
            desktopRelay: context.desktopRelay,
            llmGetters: context.llmGetters,
            source: 'chat_confirmation',
            supervisedExternalCommits: true,
            allowLocalFileWrites: context.allowLocalFileWrites,
            localWriteIntentReason: context.localWriteIntentReason,
            executionSignal: context.abortController.signal,
            isCancelled: context.isChatCancelled,
            onProgress: context.forwardToolProgress,
            userConfirmed: true,
            actionIntent: confirmedTask,
            currentTurnExecutionRequested: context.executionPipeline.executionRequested,
              resolutionId: context.executionPipeline.resolution.id,
            trustedActionContinuation: context.executionPipeline.trustedActionContinuation,
            routedTaskText: confirmedTask,
            acceptedTaskTarget: context.turnFlow.acceptedTaskTarget,
            currentAppTarget: context.turnFlow.currentAppEditTarget,
            toolPolicy: context.modelCapabilityPolicy,
            modelToolProjection: context.modelToolProjection,
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
            onToolCall: record => {
              context.rememberRequestToolRecord(record);
              if (!record?.name || isDirectDesktopTool(record.name)) return;
              context.emitToolLifecycle({
                correlationId: record.id || `chat-confirmation-resume-${Date.now()}`,
                name: record.name,
                arguments: record.arguments || {},
                result: record.error ? undefined : context.formatToolResultForUi(record.result),
                error: record.error,
                artifactReceipt: context.formatMediaArtifactReceiptForUi(record.name, record.arguments, record.result, record.error),
              });
            },
            maxIterations: Math.max(1, context.modelCapabilityPolicy.maxIterations || 5),
            context: {
              ...context.toolSecurityContext,
              userId: context.uid,
              taskId: context.durableTaskId,
              conversationId: context.conversation.id,
              turnId: context.requestId,
              turnRowId: context.actionTaskExecution.turnRowId,
              requestId: context.requestId,
              domain: context.resolvedDomain,
              orgId: context.resolvedOrgId,
              desktopRelay: context.desktopRelay,
              llmGetters: context.llmGetters,
              source: 'chat_confirmation_resume',
              supervisedExternalCommits: true,
              allowLocalFileWrites: context.allowLocalFileWrites,
              localWriteIntentReason: context.localWriteIntentReason,
              executionSignal: context.abortController.signal,
              isCancelled: context.isChatCancelled,
              onProgress: context.forwardToolProgress,
              requestConfirmation: context.requestToolConfirmation,
              actionIntent: confirmedTask,
              currentTurnExecutionRequested: context.executionPipeline.executionRequested,
              resolutionId: context.executionPipeline.resolution.id,
              trustedActionContinuation: context.executionPipeline.trustedActionContinuation,
              routedTaskText: confirmedTask,
              acceptedTaskTarget: context.turnFlow.acceptedTaskTarget,
            currentAppTarget: context.turnFlow.currentAppEditTarget,
              toolPolicy: context.modelCapabilityPolicy,
              modelToolProjection: context.modelToolProjection,
              priorToolRecords: context.taskAwareRecords([confirmedRecord]),
              desktopExecutionTracker: context.desktopExecutionTracker,
            },
          });
          if (context.isChatCancelled()) throw new DOMException('Chat confirmation continuation cancelled', 'AbortError');
          for (const usage of continuation.usageRecords) {
            recordTokenUsage(context.uid, usage.provider, usage.model, {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            }, context.interactionId);
          }
          const confirmationUsage = continuation.usageRecords.reduce(
            (sum, usage) => sum + (usage.totalTokens || 0),
            0,
          );
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
        confirmedRecord.executionOrigin = 'confirmed_action_resume';
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
              userId: context.uid,
              agentId: context.conversationAgentId,
              conversationId: context.conversationId,
              role: 'assistant',
              content: confirmationResponseText,
              personality: context.personality.id,
              domain: context.resolvedDomain,
              orgId: context.resolvedOrgId,
              source: context.eventSource,
              channel: 'chat',
              toolCalls: confirmationRecords,
              cognitiveIntent: finalized.blocked ? 'work_product_guard' : 'confirmation',
              llmWasCalled: confirmationLlmWasCalled,
              requestId: context.requestId,
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
