

import { normalizeChatHistoryRecord } from "./history";

import { type ToolSessionOptions } from "../../llm/tool_session";
import { type ProviderGetters as SharedProviderGetters } from "../../llm/provider_getters";

import { isExplicitMemoryRequest } from "../../memory/turn_memory";
import { Socket } from "socket.io";

import { NormalizedMessage, StreamCallback } from "../../llm/providers";
import { runConversationTurn } from "../../llm/conversation_turn";

import { ToolExecutionRecord } from "../../tools/types";
import { type MediaArtifactReceipt } from "../media_artifact_receipt";

import { toolRegistry } from "../../tools/registry";

import { type LLMResult } from "../../llm/adapter";

import { isModelConfigurationReadRequest } from "../../cognition/model_configuration_intent";

import { getMessagesByTokenBudget } from "../../conversation/manager";

import { recordTokenUsage } from "../../llm/token_tracker";

import { buildModelSelfAwareness } from "../../cognition/vision_routing";

import { isDirectDesktopTool } from "../desktop_relay";

type executeChatModelTurnInput = {
responseText: string;
conversationId: string;
requestId: string;
eventSource: string;
history: any[];
activeProvider: import("../../llm/user_preferences").UserLLMProvider;
activeModel: string;
uid: string;
visionIntent: boolean;
effectiveOperationMode: import("../../../shared/operation_modes").LumiClientMode;
effectiveSystemPrompt: string;
text: string;
acceptedUserMessageId: string;
toolSessionActive: boolean;
normalTurnMessages: NormalizedMessage[];
markTurnTiming: (phase: string) => void;
deferCompletionStream: boolean;
chatTextGate: import("../../cognition/response_delivery").PreFinalizationTextGate;
emitAgent: (event: string, payload?: Record<string, any>) => boolean;
personality: Record<string, any> | import("../../personality/types").PersonalityConfig;
resolvedDomain: import("../scope").RuntimeDomain;
resolvedOrgId: string;
abortController: AbortController;
reasoningRoutePolicy: { interactionId: `${string}-${string}-${string}-${string}-${string}`; source: string; inputTokenBudget: number; nativeDeviceId?: string; executionSessionId?: string; nativeClientIdentitySha256?: string; selectionMode: import("../../llm/user_preferences").UserLLMSelectionMode; fallbackCandidates: import("../../llm/user_preferences").UserLLMFallbackCandidate[]; allowCloudFallback: boolean; conversationId: string; requestId: string; thinkingMode?: "disabled"; };
llmGetters: SharedProviderGetters & Required<Pick<SharedProviderGetters, "getOpenAI" | "getAnthropic" | "getQwen" | "getOllama" | "isOllamaAvailable" | "getLmStudio" | "isLmStudioAvailable">>;
isChatCancelled: () => boolean;
turnAuthorization: import("../../conversation/lifecycle").RequestAuthorization;
completionGuard: import("../../work_product/completion_guard").CompletionGuardResult;
llmWasCalled: boolean;
interactionId: `${string}-${string}-${string}-${string}-${string}`;
socket: Socket;
modelCapabilityPolicy: import("../../personality/types").ToolPolicy;
runAuthorizedTools: (input: ToolSessionOptions) => Promise<LLMResult>;
allToolRecords: ToolExecutionRecord[];
formatToolResultForUi: (value?: string) => string;
formatMediaArtifactReceiptForUi: (name: string, args?: Record<string, any>, result?: string, error?: string) => MediaArtifactReceipt;
toolSecurityContext: { onToolRecord: (record: ToolExecutionRecord) => void; authenticated?: boolean; authRole?: string; orgRole?: string; localExecution?: boolean; executionBoundary?: "trusted_local" | "remote_restricted" | "trusted_system"; };
durableTaskId: string;
conversation: import("../../conversation/manager").Conversation;
actionTaskExecution: Exclude<import("../../conversation/manager").ConversationActionExecutionPreparation, { bindingFailure: unknown }>;
desktopRelay: import("../desktop_relay").DesktopRelay;
allowLocalFileWrites: boolean;
localWriteIntentReason: string;
emitToolLifecycle: (payload: { correlationId: string; name: string; arguments: Record<string, any>; args?: Record<string, any>; result?: string; error?: string; artifactReceipt?: MediaArtifactReceipt; }) => void;
forwardToolProgress: (step: string) => void;
modelToolProjection: { toolNames: string[]; requiredToolNames?: string[]; maxTools: number; allowDynamicDiscovery?: boolean; discoveryToolName?: string; droppedToolNames?: string[]; };
visibleUserText: string;
executionPipeline: import("../../cognition/execution_pipeline").LumiExecutionPipeline;
turnFlow: import("../../cognition/turn_flow").LumiTurnFlow;
priorTaskRecords: ToolExecutionRecord[];
runtimeOwnedDeterministicRecoveryCall: { source: "durable_task_capsule"; taskId: string; taskRevision: number; requestId: string; name: "write_file"; arguments: { path: string; content: string; }; } | { source: "structured_media_request"; taskId: string; taskRevision: number; requestId: string; name: "generate_image" | "ai_edit_image" | "generate_video"; arguments: Record<string, unknown>; };
desktopExecutionTracker: import("../../desktop/execution_runtime").DesktopExecutionTracker;
requestToolConfirmation: (toolName: string, args: Record<string, any>) => Promise<boolean>;
};
export async function executeChatModelTurn(context: executeChatModelTurnInput) {

      if (!context.responseText) {
        // LumiCore owns every normal and complex task through this single model/tool path.

        // Load conversation history from persistence (survives page reload / reconnect)
        let persistedHistory: NormalizedMessage[] = [];
        if (context.conversationId) {
          // Keep seven persisted rows because the current user row is removed
          // below, leaving three complete historical user/assistant turns.
          const msgs = getMessagesByTokenBudget(context.conversationId, 6_000, 7).filter((m: any) => !(
            m.role === 'user'
            && (
              m.requestId === context.requestId
              || (
                m.externalMessageId === context.requestId
                && m.source === context.eventSource
                && m.channel === 'chat'
              )
            )
          ));
          persistedHistory = msgs
            .filter((m: any) => m.message || m.content || m.response)
            .flatMap((m: any) => normalizeChatHistoryRecord(m, { serverOwned: true }));
        }

        // Once a server conversation exists, persistence is authoritative even
        // when the new segment is intentionally empty. Falling back to the
        // client's pre-rollover transcript would immediately restore the very
        // stale context this boundary is meant to remove.
        const conversationHistory = context.conversationId
          ? persistedHistory
          : (context.history ? context.history.flatMap((m: any) => normalizeChatHistoryRecord(m)) : []);

        // Tell Lumi which model is currently active without hiding routed vision capacity.
        const selfAwareness = buildModelSelfAwareness(context.activeProvider, context.activeModel, context.uid, { visionAware: context.visionIntent && context.effectiveOperationMode !== 'meeting' });
        const messages: NormalizedMessage[] = [
          { role: 'system', content: context.effectiveSystemPrompt + selfAwareness },
          ...conversationHistory,
          { role: 'user', content: context.text, sourceMessageId: context.acceptedUserMessageId },
        ];
        const modelIdentityRead = context.toolSessionActive && isModelConfigurationReadRequest(context.text);
        if (modelIdentityRead) messages.splice(0, messages.length,
          { role: 'system', content: 'Read model_configuration_get with role reasoning to answer the current model question. Report the current-turn activeCall when supplied, otherwise label the value as configuration. Do not change settings or test providers.' },
          { role: 'user', content: context.text, sourceMessageId: context.acceptedUserMessageId });
        context.normalTurnMessages = messages;

        context.markTurnTiming('modelStart');
        console.log('[ChatHandler] Calling Path C with provider:', context.activeProvider, 'model:', context.activeModel, 'tools:', context.toolSessionActive ? 'active' : 'conversation');
        const onChunk: StreamCallback = (chunk) => {
          if (!context.deferCompletionStream && !isExplicitMemoryRequest(context.text)) {
            const safeText = context.chatTextGate.push(chunk);
            if (safeText) {
              context.emitAgent("agent:chunk", { text: safeText, agentName: context.personality.name });
            }
          }
        };

        // Sanctuary agents get zero tool access — they can only talk
        if (!context.toolSessionActive) {
          const response = await runConversationTurn({
            messages,
            config: { provider: context.activeProvider, model: context.activeModel, userId: context.uid, domain: context.resolvedDomain, orgId: context.resolvedOrgId, signal: context.abortController.signal, ...context.reasoningRoutePolicy },
            onChunk,
            getters: context.llmGetters,
            isCancelled: context.isChatCancelled,
            assertCurrent: () => context.turnAuthorization.assertCurrent(),
            taskText: context.text,
          });

          context.markTurnTiming('modelEnd');
          context.responseText = response.text;
          context.completionGuard = response.completionGuard;
          context.llmWasCalled = true;
          for (const usage of response.usageRecords) {
            recordTokenUsage(context.uid, usage.provider, usage.model, {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            }, context.interactionId);
          }
          const totalUsage = response.usageRecords.reduce((sum, usage) => sum + (usage.totalTokens || 0), 0);
          if (context.turnAuthorization.isCurrent()) context.socket.emit('token:usage_update', {
            userId: context.uid,
            provider: response.usageRecords.at(-1)?.provider || context.activeProvider,
            totalTokens: totalUsage,
            mode: 'chat',
            timestamp: new Date().toISOString(),
          });
        } else {
          const maxIterations = context.modelCapabilityPolicy.maxIterations || context.personality.toolPolicy.maxIterations || 25;

          // Collect tool calls for persistence

          const result = await context.runAuthorizedTools({
            messages: messages,
            registry: toolRegistry,
            config: {
              provider: context.activeProvider,
              model: context.activeModel,
              userId: context.uid,
              domain: context.resolvedDomain,
              orgId: context.resolvedOrgId,
              signal: context.abortController.signal,
              ...context.reasoningRoutePolicy,
              ...(modelIdentityRead ? { thinkingMode: 'disabled' as const, maxTokens: 512 } : {}),
            },
            onToolCall: (record) => {
              context.allToolRecords.push(record);
              if (isDirectDesktopTool(record.name)) return;
              const toolPayload = {
                correlationId: record.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: record.name,
                arguments: record.arguments,
                args: record.arguments,
                result: context.formatToolResultForUi(record.result),
                error: record.error,
                artifactReceipt: context.formatMediaArtifactReceiptForUi(record.name, record.arguments, record.result, record.error),
              };
              context.emitAgent("agent:tool_call", toolPayload);
              context.emitAgent("agent:tool", toolPayload);
            },
            maxIterations: maxIterations,
            onStreamChunk: onChunk,
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
              taskRevision: context.actionTaskExecution.state?.revision,
              source: 'chat',
              supervisedExternalCommits: true,
              allowLocalFileWrites: context.allowLocalFileWrites,
              localWriteIntentReason: context.localWriteIntentReason,
              executionSignal: context.abortController.signal,
              isCancelled: context.isChatCancelled,
              onToolStart: (call) => {
                if (isDirectDesktopTool(call.name)) return;
                context.emitToolLifecycle({
                  correlationId: call.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  name: call.name,
                  arguments: call.arguments,
                });
              },
              onProgress: context.forwardToolProgress,
              toolPolicy: context.modelCapabilityPolicy,
              modelToolProjection: context.modelToolProjection,
              actionIntent: context.visibleUserText,
              currentTurnExecutionRequested: context.executionPipeline.executionRequested,
              resolutionId: context.executionPipeline.resolution.id,
              trustedActionContinuation: context.executionPipeline.trustedActionContinuation,
              routedTaskText: context.turnFlow.routeText,
              acceptedTaskTarget: context.turnFlow.acceptedTaskTarget,
              currentAppTarget: context.turnFlow.currentAppEditTarget,
              priorToolRecords: context.priorTaskRecords,
              ...(context.runtimeOwnedDeterministicRecoveryCall ? { runtimeOwnedDeterministicRecoveryCall: context.runtimeOwnedDeterministicRecoveryCall } : {}),
              desktopExecutionTracker: context.desktopExecutionTracker,
              ...(context.toolSessionActive ? { requestConfirmation: context.requestToolConfirmation } : {}),
            },
          });

          context.responseText = result.text || '';
          context.completionGuard = result.completionGuard;
          context.llmWasCalled = result.usageRecords.length > 0;
          // Record provider/model analytics. Product billing is not part of the local execution path.
          for (const u of result.usageRecords) {
            recordTokenUsage(context.uid, u.provider, u.model, { promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.totalTokens }, context.interactionId);
          }
          // Real-time token telemetry for the local dashboard.
          const totalUsage = result.usageRecords.reduce((s: number, r: any) => s + (r.totalTokens || 0), 0);
          if (context.turnAuthorization.isCurrent()) context.socket.emit('token:usage_update', {
            userId: context.uid,
            provider: context.activeProvider,
            totalTokens: totalUsage,
            mode: 'chat',
            timestamp: new Date().toISOString(),
          });
        }
        // The tool loop may cooperatively return a cancellation summary rather
        // than throw. Do not feed that through ordinary completion guards: the
        // outer cancellation boundary owns the only durable terminal outcome.
        if (context.isChatCancelled()) {
          throw new DOMException('Chat execution cancelled', 'AbortError');
        }
      }
}
