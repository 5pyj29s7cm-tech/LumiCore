import type { ProviderGetters } from "./provider_getters";
import { createModelTurnState } from "./model_turn_state";
import { CN_MODEL_FAILURE_BEFORE_EXECUTION } from "../regions/messages/voice_fast_path_messages";
import type { ToolRegistry } from "../tools/registry";
import type { ToolExecutionRecord, ToolContext } from "../tools/types";
import { type NormalizedMessage, makeLLMCall, resolveModelAttemptTimeouts, type StreamCallback, type ModelAttemptTimeouts } from "./providers";
import type { LLMConfig, LLMResult, LLMUsageRecord } from './tool_loop/contracts';
import { positiveBudget, DEFAULT_TOOL_LOOP_MODEL_WAIT_BUDGET_MS, ToolLoopModelBudget } from './tool_loop/model_budget';
import { DEFAULT_TOOL_LIFECYCLE_OBSERVER_TIMEOUT_MS, ToolLifecyclePersistenceError, toolLifecycleCallKey, waitForToolLifecycleObserver, isToolLifecyclePersistenceError } from './tool_loop/lifecycle';
import { resolveToolInvocationBudget } from './tool_loop/invocation_budget';
import { isCallerCancellation, buildVerifiedToolCheckpoint } from './tool_loop/checkpoints';
import { runWithToolsInternal } from './tool_loop/loop_dispatch';
import { getPrimaryUserText } from './tool_loop/summaries';
import { hasPendingVerificationObligation, withoutRuntimeOwnedRecoveryCall, buildMissingVerificationObligationPrompt } from './tool_loop/recovery';
import { resolveModelVisibleToolNames } from './tool_loop/runtime_activation';
import { recordWorkflowIfToolsUsed } from './tool_loop/workflow';

export { isConfirmationBlockedToolRecord } from '../tools/confirmation_block';
export type { LLMConfig } from './tool_loop/contracts';
export type { LLMResult } from './tool_loop/contracts';
export type { LLMUsageRecord } from './tool_loop/contracts';
export { HARD_MAX_TOOL_INVOCATIONS_PER_MODEL_RESPONSE } from './tool_loop/invocation_budget';
export { HARD_MAX_TOOL_INVOCATIONS_PER_TURN } from './tool_loop/invocation_budget';
export type { ToolLifecyclePersistencePhase } from './tool_loop/lifecycle';
export type { ToolLifecyclePersistenceErrorDetails } from './tool_loop/lifecycle';
export { ToolLifecyclePersistenceError } from './tool_loop/lifecycle';
export { isToolLifecyclePersistenceError } from './tool_loop/lifecycle';
export { DEFAULT_TOOL_LIFECYCLE_OBSERVER_TIMEOUT_MS } from './tool_loop/lifecycle';
export { resolveRequiredToolNamesForModel } from './tool_loop/runtime_activation';
export { isUntrustedToolOutput } from './tool_loop/receipts';
export { wrapToolOutputForModel } from './tool_loop/receipts';
export { compactToolResultForModel } from './tool_loop/receipts';
export { formatToolRecordForModel } from './tool_loop/receipts';
export { buildConfirmedStepContinuationMessages } from './tool_loop/recovery';
export { buildArtifactProgressPrompt } from './tool_loop/artifacts';
export { resolveArtifactReadbackCall } from './tool_loop/artifacts';
export { compactToolLoopMessagesForModel } from './tool_loop/context_budget';
export { localizeInternalStatusLeak } from './tool_loop/summaries';
export { isForbiddenLocalCadImageFallback } from './tool_loop/artifacts';
export { ToolLoopModelBudgetError } from './tool_loop/model_budget';
export { resolveInteractiveToolTimeouts } from './tool_loop/model_budget';
export { resolveInteractiveToolConfig } from './tool_loop/model_budget';
export { parseScreenshotBase64 } from './tool_loop/vision';
export { analyzeScreen } from './tool_loop/vision';

export async function runWithTools(
  messages: NormalizedMessage[],
  toolRegistry: ToolRegistry,
  config: LLMConfig,
  onToolCall?: (record: ToolExecutionRecord) => unknown,
  maxIterations: number = 5,
  getDeepSeek?: () => any,
  getGemini?: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  onStreamChunk?: StreamCallback,
  context?: ToolContext,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
): Promise<LLMResult> {
  config = { ...config, modelTurnState: config.modelTurnState || createModelTurnState() };
  const priorToolRecords = (context?.priorToolRecords || [])
    .filter(record => Boolean(record?.name))
    .slice(-40);
  const policyAttemptTimeoutMs = positiveBudget(
    context?.toolPolicy?.modelAttemptTimeoutMs,
    resolveModelAttemptTimeouts(config.attemptTimeouts).absoluteMs,
  );
  const configuredAttemptTimeouts: Partial<ModelAttemptTimeouts> = {
    ...config.attemptTimeouts,
    absoluteMs: config.attemptTimeouts?.absoluteMs ?? policyAttemptTimeoutMs,
  };
  const modelWaitBudgetMs = positiveBudget(
    config.modelWaitBudgetMs ?? context?.toolPolicy?.modelWaitBudgetMs,
    DEFAULT_TOOL_LOOP_MODEL_WAIT_BUDGET_MS,
  );
  const lifecycleObserverTimeoutMs = positiveBudget(
    config.toolLifecycleObserverTimeoutMs,
    DEFAULT_TOOL_LIFECYCLE_OBSERVER_TIMEOUT_MS,
  );
  const supervisor = new ToolLoopModelBudget(modelWaitBudgetMs, config.signal, context?.isCancelled, config.modelTurnState);
  const toolInvocationBudget = resolveToolInvocationBudget(context);
  const observedRecords: ToolExecutionRecord[] = [];
  const observedUsageRecords: LLMUsageRecord[] = [];
  let activeToolCall: { id?: string; name: string; arguments: Record<string, any> } | undefined;
  const durablyStartedToolCalls = new Set<string>();
  const adapterStartPersistenceErrors = new Map<string, ToolLifecyclePersistenceError>();
  const claimedTerminalToolCalls = new Set<string>();
  const guardedToolCall = async (record: ToolExecutionRecord) => {
    const lifecycleKey = toolLifecycleCallKey(record);
    const adapterStartError = adapterStartPersistenceErrors.get(lifecycleKey);
    if (adapterStartError) {
      adapterStartPersistenceErrors.delete(lifecycleKey);
      throw adapterStartError;
    }
    const durablyStarted = durablyStartedToolCalls.has(lifecycleKey);
    // UI/model events are quarantined after cancellation, but a terminal
    // receipt is different: once adapter_started was durably acknowledged it
    // must replace that uncertainty fence even when the caller has timed out.
    if (!supervisor.acceptsEvents && !durablyStarted) return;
    if (claimedTerminalToolCalls.has(lifecycleKey)) return;
    claimedTerminalToolCalls.add(lifecycleKey);
    observedRecords.push(record);
    if (!onToolCall) {
      if (durablyStarted) {
        throw new ToolLifecyclePersistenceError(
          new Error('No durable terminal lifecycle observer is installed'),
          {
            phase: 'terminal',
            toolName: record.name,
            toolCallId: record.id,
            quarantined: true,
          },
        );
      }
      return;
    }
    await waitForToolLifecycleObserver({
      phase: 'terminal',
      toolName: record.name,
      toolCallId: record.id,
      timeoutMs: lifecycleObserverTimeoutMs,
      quarantined: durablyStarted,
      observe: () => onToolCall(record),
    });
  };
  const guardedChunk: StreamCallback | undefined = onStreamChunk
    ? chunk => {
        if (supervisor.acceptsEvents) onStreamChunk(chunk);
      }
    : undefined;
  const guardedContext: ToolContext | undefined = context
    ? {
        ...context,
        isCancelled: () => isCallerCancellation(config.signal, context.isCancelled),
        onProgress: context.onProgress
          ? step => { if (supervisor.acceptsEvents) context.onProgress?.(step); }
          : undefined,
        onToolStart: call => {
          activeToolCall = {
            id: call.id,
            name: call.name,
            arguments: { ...(call.arguments || {}) },
          };
          if (supervisor.acceptsEvents) context.onToolStart?.(call);
        },
        requestConfirmation: context.requestConfirmation
          ? async (...confirmationArgs) => {
              if (!supervisor.acceptsEvents) return false;
              const approved = await context.requestConfirmation!(...confirmationArgs);
              return supervisor.acceptsEvents && approved;
            }
          : undefined,
        onAdapterStart: context.onAdapterStart
          ? async call => {
              if (!supervisor.acceptsEvents) throw config.signal?.reason || new Error('Turn no longer active');
              const lifecycleCall = activeToolCall || { name: call.name, arguments: {} };
              const lifecycleKey = toolLifecycleCallKey(lifecycleCall);
              try {
                await waitForToolLifecycleObserver({
                  phase: 'adapter_started',
                  toolName: lifecycleCall.name,
                  toolCallId: lifecycleCall.id,
                  timeoutMs: lifecycleObserverTimeoutMs,
                  // A timeout may mean the write committed but its acknowledgement
                  // was lost. Refuse handler entry/replay and retain quarantine.
                  quarantined: true,
                  observe: () => context.onAdapterStart?.(call),
                });
              } catch (error) {
                const persistenceError = isToolLifecyclePersistenceError(error)
                  ? error
                  : new ToolLifecyclePersistenceError(error, {
                      phase: 'adapter_started',
                      toolName: lifecycleCall.name,
                      toolCallId: lifecycleCall.id,
                      quarantined: true,
                    });
                adapterStartPersistenceErrors.set(lifecycleKey, persistenceError);
                throw persistenceError;
              }
              // Do not re-check caller cancellation here. The durable fence now
              // promises that this exact adapter entry will produce a terminal
              // receipt; allowing the handler to enter is what makes the fence
              // truthful. The handler still sees cancellation and may stop safely.
              durablyStartedToolCalls.add(lifecycleKey);
            }
          : undefined,
      }
    : { isCancelled: () => isCallerCancellation(config.signal, undefined) };

  const providerGetters: Partial<ProviderGetters> = {
    getDeepSeek,
    getGemini,
    getOpenAI,
    getAnthropic,
    getQwen,
    getOllama,
    getLmStudio,
    getArk,
    getXiaomi,
    getKimi,
    getGlm,
    getRelay,
  };
  const runLoop = (loopMessages: NormalizedMessage[], iterations = maxIterations, loopContext = guardedContext) =>
    runWithToolsInternal(loopMessages, toolRegistry, { ...config, attemptTimeouts: configuredAttemptTimeouts },
      providerGetters, guardedToolCall, iterations, guardedChunk, loopContext, supervisor,
      observedUsageRecords, toolInvocationBudget);
  const operation = runLoop(messages);

  try {
    return await operation;
  } catch (error) {
    if (isToolLifecyclePersistenceError(error)) throw error;
    if (isCallerCancellation(config.signal, context?.isCancelled)) {
      return {
        text: 'Task was cancelled by the user.',
        toolCalls: [...priorToolRecords, ...observedRecords],
        usageRecords: observedUsageRecords,
      };
    }
    const checkpointRecords = [...priorToolRecords, ...observedRecords];
    if (priorToolRecords.length > 0 && observedRecords.length === 0
      && priorToolRecords.every(record => Boolean(record.error))) {
      // Prior failures cannot prove that this model attempt reached a tool.
      // i18n-allow: Current model failure, distinct from historical tool failures.
      const text = /[\u3400-\u9fff]/u.test(getPrimaryUserText(messages))
        ? CN_MODEL_FAILURE_BEFORE_EXECUTION
        : 'The model call failed before any new action started. The original task and prior failure records are retained; you can retry.';
      return { text, toolCalls: priorToolRecords, usageRecords: observedUsageRecords,
        completionGuard: { text, blocked: true, reason: 'model_failed_before_tool_execution' } };
    }
    const primaryTask = String(context?.routedTaskText || '').trim()
      || getPrimaryUserText(messages);
    if (
      checkpointRecords.length > 0
      && hasPendingVerificationObligation(primaryTask, checkpointRecords, context)
      && supervisor.remainingMs() > 0
    ) {
      // A provider failure after a confirmed side effect must not bypass the
      // same evidence continuation used for a premature model completion. Run
      // one bounded continuation through the user's unchanged provider/fallback
      // configuration; the model still selects from the policy-filtered
      // capability manifest and the confirmed mutation remains immutable prior
      // evidence. If that continuation also fails, preserve the checkpoint.
      try {
        const retryDeclarations = toolRegistry.getToolDeclarationsForPolicy(
          context?.toolPolicy,
          {
            failClosedWithoutPolicy: context?.autonomous === true,
            context: withoutRuntimeOwnedRecoveryCall(context),
            visibleToolNames: resolveModelVisibleToolNames(context, checkpointRecords, toolRegistry),
          },
        );
        const missingVerification = buildMissingVerificationObligationPrompt(
          primaryTask,
          checkpointRecords,
          toolRegistry,
          new Set(retryDeclarations.map(declaration => declaration.function.name)),
          context?.toolPolicy,
          withoutRuntimeOwnedRecoveryCall(context),
        );
        if (missingVerification) {
          return await runLoop(
            [
              ...messages,
              {
                role: 'system',
                content: [
                  'The preceding model-provider attempt failed before it could continue from the preserved execution receipts.',
                  'Continue through the configured provider/fallback policy without replaying any verified mutation.',
                  missingVerification,
                ].join('\n'),
              },
            ],
            Math.max(maxIterations, 3),
            { ...(guardedContext || {}), priorToolRecords: checkpointRecords },
          );
        }
      } catch (continuationError) {
        if (isToolLifecyclePersistenceError(continuationError)) {
          throw continuationError;
        }
        // The bounded provider/fallback continuation also failed. Fall through
        // to the immutable checkpoint response below; never replay the action.
      }
    }
    if (checkpointRecords.length > 0) {
      recordWorkflowIfToolsUsed(checkpointRecords, messages, config);
      const guarded = buildVerifiedToolCheckpoint(checkpointRecords, getPrimaryUserText(messages), context);
      return {
        text: guarded.text,
        completionGuard: guarded,
        toolCalls: checkpointRecords,
        usageRecords: observedUsageRecords,
      };
    }
    throw error;
  } finally {
    supervisor.dispose();
  }
}

/** Run a multimodal conversation with vision-capable models. */
export async function runWithVision(
  messages: NormalizedMessage[],
  config: LLMConfig,
  getDeepSeek?: () => any,
  getGemini?: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
): Promise<string> {
  const result = await makeLLMCall(messages, [], config, getDeepSeek || (() => null), getGemini || (() => null), getOpenAI, getAnthropic, getQwen, getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay);
  return result.text || '';
}
