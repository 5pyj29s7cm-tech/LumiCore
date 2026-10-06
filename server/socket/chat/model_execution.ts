import type { ToolContext } from "../../tools/types";


import { normalizeChatHistoryRecord } from "./history";

import { runLumiTurn, type ToolSessionOptions } from "../../llm/lumi_turn";
import { type ProviderGetters as SharedProviderGetters } from "../../llm/provider_getters";

import { isExplicitMemoryRequest } from "../../memory/turn_memory";
import { Socket } from "socket.io";

import { NormalizedMessage, StreamCallback } from "../../llm/providers";


import { ToolExecutionRecord } from "../../tools/types";
import { type MediaArtifactReceipt } from "../media_artifact_receipt";

import { toolRegistry } from "../../tools/registry";

import { type LLMResult } from "../../llm/adapter";

import { isModelConfigurationReadRequest } from "../../cognition/model_configuration_intent";

import { getMessagesByTokenBudget } from "../../conversation/manager";

import { recordTokenUsageBatch } from "../../llm/token_tracker";

import { buildModelSelfAwareness } from "../../cognition/vision_routing";

import { createToolLifecycleCallbacks } from "../tool_lifecycle";

type executeChatModelTurnInput = {
toolContext: ToolContext;
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
actionTaskExecution: Exclude<import("../../conversation/manager").ConversationActionExecutionPreparation, { bindingFailure: unknown }>;
emitToolLifecycle: (payload: { correlationId: string; name: string; arguments: Record<string, any>; args?: Record<string, any>; result?: string; error?: string; artifactReceipt?: MediaArtifactReceipt; }) => void;
priorTaskRecords: ToolExecutionRecord[];
runtimeOwnedDeterministicRecoveryCall: { source: "durable_task_capsule"; taskId: string; taskRevision: number; requestId: string; name: "write_file"; arguments: { path: string; content: string; }; } | { source: "structured_media_request"; taskId: string; taskRevision: number; requestId: string; name: "generate_image" | "ai_edit_image" | "generate_video"; arguments: Record<string, unknown>; };
desktopExecutionTracker: import("../../desktop/execution_runtime").DesktopExecutionTracker;
requestToolConfirmation: (toolName: string, args: Record<string, any>) => Promise<boolean>;
};
export async function executeChatModelTurn(context: executeChatModelTurnInput) {

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

  const toolLifecycle = createToolLifecycleCallbacks({
    emit: context.emitToolLifecycle,
    correlationPrefix: 'tool',
    formatResult: context.formatToolResultForUi,
    includeFailedResult: true,
    onRecord: record => context.allToolRecords.push(record),
    artifactReceipt: record => context.formatMediaArtifactReceiptForUi(record.name, record.arguments, record.result, record.error),
  });
  const config = {
    provider: context.activeProvider, model: context.activeModel, userId: context.uid,
    domain: context.resolvedDomain, orgId: context.resolvedOrgId,
    signal: context.abortController.signal, ...context.reasoningRoutePolicy,
  };
  const result = context.toolSessionActive
    ? await context.runAuthorizedTools({
        messages,
        registry: toolRegistry,
        config: { ...config, ...(modelIdentityRead ? { thinkingMode: 'disabled' as const, maxTokens: 512 } : {}) },
        onToolCall: toolLifecycle.onToolCall,
        maxIterations: context.modelCapabilityPolicy.maxIterations || context.personality.toolPolicy.maxIterations || 25,
        onStreamChunk: onChunk,
        context: {
          ...context.toolContext,
          taskRevision: context.actionTaskExecution.state?.revision,
          source: 'chat',
          onToolStart: toolLifecycle.onToolStart,
          priorToolRecords: context.priorTaskRecords,
          ...(context.runtimeOwnedDeterministicRecoveryCall ? { runtimeOwnedDeterministicRecoveryCall: context.runtimeOwnedDeterministicRecoveryCall } : {}),
          desktopExecutionTracker: context.desktopExecutionTracker,
          requestConfirmation: context.requestToolConfirmation,
        },
      })
    : await runLumiTurn({
        messages, config, onChunk, getters: context.llmGetters,
        isCancelled: context.isChatCancelled,
        assertCurrent: () => context.turnAuthorization.assertCurrent(),
        taskText: context.text,
      });
  if (!context.toolSessionActive) context.markTurnTiming('modelEnd');
  context.responseText = result.text || '';
  context.completionGuard = result.completionGuard;
  context.llmWasCalled = !context.toolSessionActive || result.usageRecords.length > 0;
  const totalUsage = recordTokenUsageBatch(context.uid, result.usageRecords, context.interactionId);
  if (context.turnAuthorization.isCurrent()) context.socket.emit('token:usage_update', {
    userId: context.uid,
    provider: context.toolSessionActive ? context.activeProvider : result.usageRecords.at(-1)?.provider || context.activeProvider,
    totalTokens: totalUsage, mode: 'chat', timestamp: new Date().toISOString(),
  });
  // The tool loop may cooperatively return a cancellation summary rather
  // than throw. Do not feed that through ordinary completion guards: the
  // outer cancellation boundary owns the only durable terminal outcome.
  if (context.isChatCancelled()) {
    throw new DOMException('Chat execution cancelled', 'AbortError');
  }
}
