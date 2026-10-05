

import { type ToolSessionOptions } from "../../llm/tool_session";
import { type ProviderGetters as SharedProviderGetters } from "../../llm/provider_getters";

import { scheduleTurnMemory } from "../../memory/turn_memory";
import { Socket } from "socket.io";

import { readDatabaseTables, commitDatabaseTables } from "../../../db_layer";
import { pushNotification } from "../../routes/notifications";
import { NormalizedMessage } from "../../llm/providers";

import { ToolExecutionRecord } from "../../tools/types";
import { type MediaArtifactReceipt } from "../media_artifact_receipt";

import { toolRegistry } from "../../tools/registry";

import { type LLMResult } from "../../llm/adapter";

import { buildLumiCapabilitySelection } from "../../cognition/capability_selection";

import { withDesktopExecutionReceipt } from "../../desktop/execution_runtime";
import { finalizeLumiResponse } from "../../cognition/result_finalizer";
import { buildForegroundTaskCompletionFeedback } from "../../cognition/acceptance_evidence";

import { recoverBlockedExecutionOnce } from "../../cognition/execution_guard_recovery";

import { shouldBlockForDesktopControlPause } from "../../cognition/desktop_control_pause";

import { formatPendingConfirmationRequest } from "../../tools/pending_confirmation";

import { saveEmotionalState, updateEmotionalState, updateEmotionalStateWithHIM, saveHIMState, generateContextualGreeting } from "../../personality/state";

import { addMessage, addMessageIdempotent as addMessageIdempotentUnbound, extractTopics, trackTopic, setConversationActionExecutionStatus } from "../../conversation/manager";

import { RECONFIRMATION_REQUIRED_BLOCKER } from "../../cognition/action_continuation";

import { summarizeToolRecordForPersistence } from "../../cognition/tool_record_status";

import { recordTokenUsage } from "../../llm/token_tracker";

import { formatDesktopControlPausePresentation } from "../../regions/packs/cn/desktop_control_messages";

import { isDirectDesktopTool } from "../desktop_relay";

import { type ActiveTaskMessageResolution } from "../../cognition/task_concurrency";

type completeChatTurnInput = {
pendingConfirmationCreatedThisTurn: import("../../tools/pending_confirmation").PendingToolConfirmation;
executionTaskText: string;
responseText: string;
completionGuard: import("../../work_product/completion_guard").CompletionGuardResult;
finalTaskRecords: ToolExecutionRecord[];
turnFlow: import("../../cognition/turn_flow").LumiTurnFlow;
durableTaskId: string;
requestId: string;
taskAwareRecords: (records: ToolExecutionRecord[]) => ToolExecutionRecord[];
allToolRecords: ToolExecutionRecord[];
desktopRelay: import("../desktop_relay").DesktopRelay;
toolSessionActive: boolean;
correctionRequiresFreshConfirmation: boolean;
abortController: AbortController;
isChatCancelled: () => boolean;
llmWasCalled: boolean;
runAuthorizedTools: (input: ToolSessionOptions) => Promise<LLMResult>;
normalTurnMessages: NormalizedMessage[];
activeProvider: import("../../llm/user_preferences").UserLLMProvider;
activeModel: string;
uid: string;
resolvedDomain: import("../scope").RuntimeDomain;
resolvedOrgId: string;
reasoningRoutePolicy: { interactionId: `${string}-${string}-${string}-${string}-${string}`; source: string; inputTokenBudget: number; nativeDeviceId?: string; executionSessionId?: string; nativeClientIdentitySha256?: string; selectionMode: import("../../llm/user_preferences").UserLLMSelectionMode; fallbackCandidates: import("../../llm/user_preferences").UserLLMFallbackCandidate[]; allowCloudFallback: boolean; conversationId: string; requestId: string; thinkingMode?: "disabled"; };
rememberRequestToolRecord: (record: ToolExecutionRecord) => void;
formatToolResultForUi: (value?: string) => string;
formatMediaArtifactReceiptForUi: (name: string, args?: Record<string, any>, result?: string, error?: string) => MediaArtifactReceipt;
emitAgent: (event: string, payload?: Record<string, any>) => boolean;
modelCapabilityPolicy: import("../../personality/types").ToolPolicy;
personality: Record<string, any> | import("../../personality/types").PersonalityConfig;
toolSecurityContext: { onToolRecord: (record: ToolExecutionRecord) => void; authenticated?: boolean; authRole?: string; orgRole?: string; localExecution?: boolean; executionBoundary?: "trusted_local" | "remote_restricted" | "trusted_system"; };
conversation: import("../../conversation/manager").Conversation;
actionTaskExecution: Exclude<import("../../conversation/manager").ConversationActionExecutionPreparation, { bindingFailure: unknown }>;
llmGetters: SharedProviderGetters & Required<Pick<SharedProviderGetters, "getOpenAI" | "getAnthropic" | "getQwen" | "getOllama" | "isOllamaAvailable" | "getLmStudio" | "isLmStudioAvailable">>;
allowLocalFileWrites: boolean;
localWriteIntentReason: string;
forwardToolProgress: (step: string) => void;
emitToolLifecycle: (payload: { correlationId: string; name: string; arguments: Record<string, any>; args?: Record<string, any>; result?: string; error?: string; artifactReceipt?: MediaArtifactReceipt; }) => void;
modelToolProjection: { toolNames: string[]; requiredToolNames?: string[]; maxTools: number; allowDynamicDiscovery?: boolean; discoveryToolName?: string; droppedToolNames?: string[]; };
visibleUserText: string;
executionPipeline: import("../../cognition/execution_pipeline").LumiExecutionPipeline;
runtimeOwnedDeterministicRecoveryCall: { source: "durable_task_capsule"; taskId: string; taskRevision: number; requestId: string; name: "write_file"; arguments: { path: string; content: string; }; } | { source: "structured_media_request"; taskId: string; taskRevision: number; requestId: string; name: "generate_image" | "ai_edit_image" | "generate_video"; arguments: Record<string, unknown>; };
desktopExecutionTracker: import("../../desktop/execution_runtime").DesktopExecutionTracker;
requestToolConfirmation: (toolName: string, args: Record<string, any>) => Promise<boolean>;
interactionId: `${string}-${string}-${string}-${string}-${string}`;
priorTaskRecords: ToolExecutionRecord[];
conversationId: string;
completionTaskText: string;
normalizeAgentPayload: (event: string, payload?: Record<string, any>, outputProtection?: { trustedConfirmationRequestText?: string; }) => Record<string, any>;
pendingConfirmationAssistantState: string;
chatDurabilityUnknownText: (userText: string) => string;
actionLeaseHeartbeat: import("../../conversation/action_execution_runtime").ConversationActionExecutionHeartbeat;
releaseChatSession: (reason?: string) => Promise<boolean>;
commitRecordedTerminal: (input: { payload: Record<string, any>; unknownPayload: Record<string, any>; persistTerminalState: () => ReturnType<(assistantText: string, options?: { toolRecords?: ToolExecutionRecord[]; source?: string; sourceInteractionId?: string; capabilitySelection?: ReturnType<typeof buildLumiCapabilitySelection>; finalizationBlocked?: boolean; assistantTextTrusted?: boolean; finalizationReason?: string; }) => import("../../work_takeover/execution_writeback").WorkTakeoverTurnExecutionWritebackResult>; persistAssistantMessage: () => void; notification?: Record<string, any>; llmWasCalled?: boolean; repairUnknownAssistant?: boolean; updateSource?: string; errorContext: string; }) => Promise<boolean>;
persistChatTakeoverExecution: (assistantText: string, options?: { toolRecords?: ToolExecutionRecord[]; source?: string; sourceInteractionId?: string; capabilitySelection?: ReturnType<typeof buildLumiCapabilitySelection>; finalizationBlocked?: boolean; assistantTextTrusted?: boolean; finalizationReason?: string; }) => import("../../work_takeover/execution_writeback").WorkTakeoverTurnExecutionWritebackResult;
capabilitySelection: import("../../cognition/execution_pipeline").LumiCapabilityPlan;
conversationAgentId: string;
addMessageIdempotent: (message: Parameters<typeof addMessageIdempotentUnbound>[0]) => string;
eventSource: string;
refreshTerminalPayloadTaskRelation: (payload: Record<string, any>, exactTaskId?: string) => ActiveTaskMessageResolution;
turnAuthorization: import("../../conversation/lifecycle").RequestAuthorization;
text: string;
scheduleChatSummary: (targetConversationId: string) => void;
isMemoryAvatar: boolean;
persistChatLearning: (assistantText: string, options?: { channel?: "chat" | "workflow"; toolRecords?: ToolExecutionRecord[]; sourceInteractionId?: string; logLabel?: string; }) => void;
allowAdaptiveLearning: boolean;
emotionalState: import("../../personality/state").EmotionalState;
sentiment: import("../../cognition/sentiment").SentimentResult;
isNovel: boolean;
himState: import("../../personality/him").HIMState;
emotionKey: string;
socket: Socket;
};
export async function completeChatTurn(context: completeChatTurnInput) {

      // Waiting for an immutable one-time confirmation is a valid terminal
      // state for this turn, not a failed completion attempt. The model/tool
      // path must render the same confirmation receipt as the deterministic
      // quick-command path and must not let the completion guard overwrite it
      // with a generic "missing core evidence" failure.
      let finalResponse: ReturnType<typeof finalizeLumiResponse> = context.pendingConfirmationCreatedThisTurn
        ? {
            text: formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn),
            blocked: false,
            reason: 'waiting_confirmation',
            notification: undefined,
          }
        : finalizeLumiResponse({
            taskText: context.executionTaskText,
            responseText: context.responseText,
            completionGuard: context.completionGuard,
            toolRecords: context.finalTaskRecords,
            source: 'chat',
            flow: context.turnFlow,
            taskId: context.durableTaskId,
            requestId: context.requestId,
          });
      const desktopPauseBlocksCurrentTask = (
        records = context.taskAwareRecords(context.allToolRecords),
      ) => {
        return shouldBlockForDesktopControlPause({
          pauseReason: context.desktopRelay.getControlPauseReason(),
          waitingForConfirmation: Boolean(context.pendingConfirmationCreatedThisTurn),
          taskText: context.executionTaskText,
          toolRecords: records,
        });
      };
      if (desktopPauseBlocksCurrentTask()) {
        const pausePresentation = formatDesktopControlPausePresentation(context.executionTaskText);
        finalResponse = {
          ...finalResponse,
          text: pausePresentation.text,
          blocked: true,
          reason: pausePresentation.reason,
        };
      }
      const guardRecovery = await recoverBlockedExecutionOnce({
        task: context.executionTaskText,
        responseText: context.responseText,
        finalization: finalResponse,
        allowToolUse: context.toolSessionActive,
        pendingConfirmation: Boolean(context.pendingConfirmationCreatedThisTurn),
        requiresFreshConfirmation: context.correctionRequiresFreshConfirmation,
        aborted: context.abortController.signal.aborted || desktopPauseBlocksCurrentTask(),
        // A physical-input pause revokes further desktop authority, but it is
        // not a user cancellation.  Treating the pause as AbortError made the
        // outer chat catch publish the misleading "task stopped" terminal.
        isAborted: context.isChatCancelled,
        isPendingConfirmation: () => Boolean(context.pendingConfirmationCreatedThisTurn),
        toolRecords: context.taskAwareRecords(context.allToolRecords),
        attempt: async ({ instruction, priorToolRecords, recordTool }) => {
          console.warn('[ChatHandler] Recovering blocked execution internally.');
          context.llmWasCalled = true;
          const recovery = await context.runAuthorizedTools({
            messages: [
              ...context.normalTurnMessages,
              ...(String(context.responseText || '').trim()
                ? [{ role: 'assistant' as const, content: context.responseText }]
                : []),
              { role: 'user', content: instruction },
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
              // Preserve terminal receipts independently from the provider
              // result; a late provider error must not erase tool evidence.
              context.rememberRequestToolRecord(record);
              recordTool(record);
              if (isDirectDesktopTool(record.name)) return;
              const toolPayload = {
                correlationId: record.id || `guard-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: record.name,
                arguments: record.arguments,
                args: record.arguments,
                result: context.formatToolResultForUi(record.result),
                error: record.error,
                artifactReceipt: context.formatMediaArtifactReceiptForUi(record.name, record.arguments, record.result, record.error),
              };
              context.emitAgent('agent:tool_call', toolPayload);
              context.emitAgent('agent:tool', toolPayload);
            },
            maxIterations: Math.max(2, Math.min(12, context.modelCapabilityPolicy.maxIterations || context.personality.toolPolicy.maxIterations || 8)),
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
              source: 'chat_guard_recovery',
              supervisedExternalCommits: true,
              allowLocalFileWrites: context.allowLocalFileWrites,
              localWriteIntentReason: context.localWriteIntentReason,
              executionSignal: context.abortController.signal,
              isCancelled: context.isChatCancelled,
              onProgress: context.forwardToolProgress,
              onToolStart: call => {
                if (isDirectDesktopTool(call.name)) return;
                context.emitToolLifecycle({
                  correlationId: call.id || `guard-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  name: call.name,
                  arguments: call.arguments,
                });
              },
              toolPolicy: context.modelCapabilityPolicy,
              modelToolProjection: context.modelToolProjection,
              actionIntent: context.visibleUserText,
              currentTurnExecutionRequested: context.executionPipeline.executionRequested,
              resolutionId: context.executionPipeline.resolution.id,
              trustedActionContinuation: context.executionPipeline.trustedActionContinuation,
              routedTaskText: context.turnFlow.routeText,
              acceptedTaskTarget: context.turnFlow.acceptedTaskTarget,
            currentAppTarget: context.turnFlow.currentAppEditTarget,
              ...(context.runtimeOwnedDeterministicRecoveryCall ? { runtimeOwnedDeterministicRecoveryCall: context.runtimeOwnedDeterministicRecoveryCall } : {}),
              priorToolRecords,
              desktopExecutionTracker: context.desktopExecutionTracker,
              requestConfirmation: context.requestToolConfirmation,
            },
              });
          for (const usage of recovery.usageRecords) {
            recordTokenUsage(context.uid, usage.provider, usage.model, {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            }, context.interactionId);
          }
          return {
            text: recovery.text,
            completionGuard: recovery.completionGuard,
            toolRecords: withDesktopExecutionReceipt(
              recovery.toolCalls || [],
              context.desktopExecutionTracker,
            ),
          };
        },
        finalize: (candidateText, records, recoveryCompletionGuard) => {
          const recoveredRecords = withDesktopExecutionReceipt(records, context.desktopExecutionTracker);
          const candidate = context.pendingConfirmationCreatedThisTurn
            ? {
                text: formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn),
                blocked: false,
                reason: 'waiting_confirmation',
                notification: undefined,
              }
            : finalizeLumiResponse({
                taskText: context.executionTaskText,
                responseText: candidateText,
                completionGuard: recoveryCompletionGuard,
                toolRecords: recoveredRecords,
                source: 'chat_guard_recovery',
                flow: context.turnFlow,
                taskId: context.durableTaskId,
                requestId: context.requestId,
              });
          if (!desktopPauseBlocksCurrentTask(recoveredRecords)) return candidate;
          const pausePresentation = formatDesktopControlPausePresentation(context.executionTaskText);
          return {
            ...candidate,
            text: pausePresentation.text,
            blocked: true,
            reason: pausePresentation.reason,
          };
        },
      });
      for (const record of guardRecovery.toolRecords) {
        const isPriorTaskReceipt = context.priorTaskRecords.some(item => (
          record.id
            ? item.id === record.id
            : item.name === record.name && item.result === record.result && item.error === record.error
        ));
        if (isPriorTaskReceipt) continue;
        const duplicate = record.id
          ? context.allToolRecords.some(item => item.id === record.id)
          : context.allToolRecords.some(item => (
              item.name === record.name
              && item.result === record.result
              && item.error === record.error
            ));
        if (!duplicate) context.allToolRecords.push(record);
      }
      const recoveredDesktopRecords = withDesktopExecutionReceipt(context.allToolRecords, context.desktopExecutionTracker);
      if (recoveredDesktopRecords.length > context.allToolRecords.length) {
        context.allToolRecords.push(...recoveredDesktopRecords.slice(context.allToolRecords.length));
      }
      finalResponse = guardRecovery.finalization;
      context.responseText = finalResponse.text;
      if (finalResponse.blocked) {
        console.warn('[ChatHandler] Completion claim blocked:', finalResponse.reason);
        // Keep the live action lease until the terminal assistant persistence
        // boundary when this turn already has tool evidence.  Finalizing the
        // task here clears its active request before `addMessageIdempotent`
        // can bind the evidence, causing verified observations (notably the
        // WPS active-window anchor) to be archived as stale and dropping the
        // target from the durable capsule.  A blocked turn with no evidence
        // still needs the early request finalization below.
        if (context.conversationId && context.actionTaskExecution.state?.taskId && context.toolSessionActive && context.allToolRecords.length === 0) {
          const blocker = context.correctionRequiresFreshConfirmation
            && !context.pendingConfirmationCreatedThisTurn
            ? RECONFIRMATION_REQUIRED_BLOCKER
            : finalResponse.reason || 'The current work product did not pass final verification.';
          setConversationActionExecutionStatus(context.conversationId, context.uid, 'blocked', {
            blocker,
            assistantState: context.responseText,
            requestId: '',
          });
        }
      }

      // Completion is a durability claim. Keep the native terminal frame
      // behind the task/message write and strict database flush.
      const responseCompletionFeedback = context.durableTaskId
        ? buildForegroundTaskCompletionFeedback({
            taskId: context.durableTaskId,
            taskLabel: context.completionTaskText,
            toolRecords: context.taskAwareRecords(context.allToolRecords),
            blocked: finalResponse.blocked,
            reason: finalResponse.reason,
            status: context.pendingConfirmationCreatedThisTurn || finalResponse.reason === 'waiting_confirmation'
              ? 'waiting_confirmation' : finalResponse.reason === 'workflow_running' ? 'executing' : undefined,
          })
        : undefined;
      const trustedConfirmationRequestText = context.pendingConfirmationCreatedThisTurn
        ? formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn)
        : undefined;
      const responseTerminalPayload = context.normalizeAgentPayload('agent:response', {
        text: context.responseText,
        agentName: context.personality.name,
        finalized: true,
        blocked: finalResponse.blocked,
        reason: finalResponse.reason || '',
        completionFeedback: responseCompletionFeedback,
      }, trustedConfirmationRequestText ? { trustedConfirmationRequestText } : undefined);
      context.responseText = String(responseTerminalPayload.text || '');
      finalResponse = { ...finalResponse, text: context.responseText };
      if (
        context.pendingConfirmationCreatedThisTurn
        && context.conversationId
        && context.pendingConfirmationAssistantState !== context.responseText
      ) {
        setConversationActionExecutionStatus(context.conversationId, context.uid, 'waiting_confirmation', {
          assistantState: context.responseText,
          requestId: context.requestId,
        });
        context.pendingConfirmationAssistantState = context.responseText;
      }
      const responseUnknownPayload = context.normalizeAgentPayload('agent:response', {
        text: context.chatDurabilityUnknownText(context.visibleUserText),
        agentName: context.personality.name,
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
        completionFeedback: context.durableTaskId
          ? buildForegroundTaskCompletionFeedback({
              taskId: context.durableTaskId,
              taskLabel: context.completionTaskText,
              toolRecords: context.taskAwareRecords(context.allToolRecords),
              status: 'persistence_unknown',
              reason: 'Terminal persistence outcome is unknown.',
            })
          : undefined,
      });
      if (context.actionLeaseHeartbeat?.isLeaseLost()) {
        await context.actionLeaseHeartbeat.leaseLoss;
        await context.releaseChatSession();
        return;
      }
      const terminalCommitted = await context.commitRecordedTerminal({
          persistTerminalState: () => context.persistChatTakeoverExecution(context.responseText, {
          toolRecords: context.allToolRecords,
          source: 'chat',
          sourceInteractionId: context.interactionId,
          capabilitySelection: context.capabilitySelection,
          finalizationBlocked: finalResponse.blocked,
          assistantTextTrusted: !finalResponse.blocked,
          finalizationReason: finalResponse.reason,
        }),
          persistAssistantMessage: () => {
          if (!context.conversationId) return;
          // Keep terminal tool evidence immediately before the assistant row in
          // the same strict durability boundary.
          for (const tc of context.allToolRecords) {
            if (!tc.error && !String(tc.result || '').trim()) continue;
            const tcSummary = summarizeToolRecordForPersistence(tc);
            addMessage({ userId: context.uid, agentId: context.conversationAgentId, conversationId: context.conversationId, role: 'tool', content: tcSummary, domain: context.resolvedDomain, orgId: context.resolvedOrgId });
          }
          context.addMessageIdempotent({
            userId: context.uid,
            agentId: context.conversationAgentId,
            conversationId: context.conversationId,
            role: 'assistant',
            content: context.responseText,
            personality: context.personality.id,
            domain: context.resolvedDomain,
            orgId: context.resolvedOrgId,
            source: context.eventSource,
            channel: 'chat',
            toolCalls: context.allToolRecords.length ? context.allToolRecords : undefined,
            cognitiveIntent: finalResponse.blocked ? 'work_product_guard' : context.executionPipeline.normalizedIntent.kind,
            llmWasCalled: context.llmWasCalled,
            requestId: context.requestId,
            completionFeedback: responseCompletionFeedback,
            ...(finalResponse.blocked && context.durableTaskId ? {
              terminalTaskDisposition: {
                outcome: 'blocked' as const,
                taskId: context.durableTaskId,
                requestId: context.requestId,
                reason: finalResponse.reason
                  || 'The foreground request ended without verified goal-level completion evidence.',
              },
            } : {}),
          });
          context.refreshTerminalPayloadTaskRelation(responseTerminalPayload, context.durableTaskId);
        },
        payload: responseTerminalPayload,
        unknownPayload: responseUnknownPayload,
        notification: finalResponse.notification,
        llmWasCalled: context.llmWasCalled,
        repairUnknownAssistant: true,
        errorContext: 'Terminal persistence failed:',
      });
      if (!terminalCommitted) {
        await context.releaseChatSession();
        return;
      }
      context.actionLeaseHeartbeat?.stop();

      // Post-commit enrichment must never delay or precede the durable terminal.
      if (!context.turnAuthorization.isCurrent()) return;

      if (context.conversationId) {
        // (conversation_updated NOW emitted AFTER agent:response — see below)

        // Topic tracking — extract and record topics for cross-session continuity
        if (!finalResponse.blocked) {
          try {
            const topics = extractTopics(context.text + ' ' + context.responseText);
            for (const topic of topics) trackTopic(context.conversationId, topic);
          } catch {}
        }

        // Shared chat/voice scheduler owns cadence, reservation, guard
        // filtering, and captured-count persistence.
        context.scheduleChatSummary(context.conversationId);
      }

      if (!context.isMemoryAvatar && !finalResponse.blocked) {
        context.persistChatLearning(context.responseText, { toolRecords: context.allToolRecords, logLabel: 'chat' });
      }

      // Clean up abort session
      await context.releaseChatSession();
      if (!context.turnAuthorization.isCurrent()) return;

      if (context.allowAdaptiveLearning && !finalResponse.blocked) scheduleTurnMemory({
        userId: context.uid, domain: context.resolvedDomain, orgId: context.resolvedOrgId, userText: context.text,
        channel: 'chat', source: context.eventSource, requestId: context.requestId, conversationId: context.conversationId,
        agentId: context.conversationAgentId, authorization: context.turnAuthorization, llmGetters: context.llmGetters,
      });

      // Update emotional state — reconnect if user was away for a while
      if (!context.turnAuthorization.isCurrent()) return;
      const hoursSinceLast = context.emotionalState.lastInteractionAt
        ? (Date.now() - new Date(context.emotionalState.lastInteractionAt).getTime()) / (1000 * 60 * 60)
        : 24;
      const isReconnect = hoursSinceLast > 1;
      let updatedState = updateEmotionalState(context.emotionalState, { type: 'interaction', userId: context.uid, timestamp: new Date().toISOString() });
      // Apply sentiment analysis results to emotional state
      if (context.sentiment.valence !== 0 || context.sentiment.frustration > 0 || context.sentiment.urgency > 0) {
        updatedState = updateEmotionalState(updatedState, { type: 'sentiment_analysis', sentiment: context.sentiment, userId: context.uid, timestamp: new Date().toISOString() });
      }
      if (isReconnect) {
        updatedState = updateEmotionalState(updatedState, { type: 'reconnect', intensity: Math.min(1, hoursSinceLast / 72), userId: context.uid, timestamp: new Date().toISOString() });
      }
      if (context.isNovel) {
        updatedState = updateEmotionalState(updatedState, { type: 'novel_topic', userId: context.uid, timestamp: new Date().toISOString() });
      }
      // HIM: comfort-gradient drive → dynamic initiative + curiosity
      const { state: himUpdated, him: newHim } = updateEmotionalStateWithHIM(updatedState, { type: 'self_reflection', userId: context.uid }, context.himState, context.text.slice(0, 40));
      saveEmotionalState(context.emotionKey, himUpdated);
      saveHIMState(context.emotionKey, newHim);

      // Emit a contextual greeting on reconnect.
      if (!context.isMemoryAvatar && context.turnAuthorization.isCurrent() && isReconnect && updatedState.intimacy > 0.2) {
        const greeting = generateContextualGreeting(updatedState, context.uid);
        if (greeting) {
          const greetingTs = new Date().toISOString();
          // Save to chat log
          const greetingDb = readDatabaseTables(["interactions"]);
          greetingDb.interactions.push({
            id: `greeting-${context.uid}-${Date.now()}`,
            userId: context.uid,
            agentId: context.conversationAgentId,
            conversationId: context.conversationId || '',
            content: greeting,
            response: '',
            role: 'agent',
            personality: context.personality.id,
            timestamp: greetingTs,
            cognitiveIntent: 'greeting',
            llmWasCalled: false,
          });
          commitDatabaseTables(greetingDb);

          // Emit to chat window and notification center
          context.socket.emit('agent:proactive', {
            type: 'greeting',
            message: greeting,
            agentName: context.personality.name,
            intimacy: updatedState.intimacy,
            timestamp: greetingTs,
          });
          pushNotification(context.uid, { type: 'greeting', title: `Welcome back`, message: greeting });
        }
      }
}
