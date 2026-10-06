import { replacePromptBlock } from "../prompt_blocks";
import { GENERIC_TOOL_REPLAN_PROMPT, hasRelevantEvidenceTool, normalizePlannedToolScope } from "../../cognition/tool_planning";
import { buildDeterministicExplicitToolRecoveryCall } from "../../cognition/deterministic_tool_recovery";
import type { ToolLoopState } from './loop_setup';
import type { LLMResult } from './contracts';
import { desktopControlPauseReason, hasCompletedCoreAction, buildDesktopControlPausedSummary, guardToolResponseIfNeeded } from './projection';
import { recordWorkflowIfToolsUsed } from './workflow';
import { prepareToolLoopModelResponse } from './model_response';
import { toolCallSignature, buildMissingVerificationObligationPrompt, MAX_VERIFICATION_OBLIGATION_REPLANS, hasUnverifiedToolOutcome, MAX_TOOL_RECOVERY_REPLANS, buildToolRecoveryReplanPrompt, isVerifiedToolSuccess, isRetryableToolOutcome, MAX_IDENTICAL_RECOVERY_RETRIES, shouldSuppressConfirmedReplay } from './recovery';
import { getPrimaryUserText, buildIterationLimitSummary } from './summaries';
import { executePlannedToolBatch } from './tool_batch';

export async function executeToolLoopIteration(state: ToolLoopState, iteration: number): Promise<LLMResult | undefined> {

    // Check for cancellation between iterations
    if (state.context?.isCancelled?.()) {
      return state.finish('Task was cancelled by the user.');
    }
    if (desktopControlPauseReason(state.context)) {
      recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config);
      return state.finish(hasCompletedCoreAction(state.primaryTask, state.executionLog, state.toolExecutionContext)
          ? ''
          : buildDesktopControlPausedSummary(state.primaryTask));
    }
    const { response, runtimeRecovery, runtimeRecoveryAlreadyRecorded, directStructuredMediaRecovery, noNewExecutionRecord, exposedToolNames } = await prepareToolLoopModelResponse(state, iteration);

    // A provider may ignore AbortSignal and resolve after the caller has
    // cancelled or timed out. Re-check before interpreting a late response so
    // it can never dispatch tool calls after a replacement model/turn starts.
    if (state.context?.isCancelled?.()) {
      return state.finish('Task was cancelled before the model response could be applied.');
    }
    if (desktopControlPauseReason(state.context)) {
      recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config);
      return state.finish(hasCompletedCoreAction(state.primaryTask, state.executionLog, state.toolExecutionContext)
          ? String(response.text || '')
          : buildDesktopControlPausedSummary(state.primaryTask));
    }

    // Collect usage from this LLM call
    if (response.usage) {
      const actualProvider = response.routing?.selectedProvider || state.config.provider;
      const actualModel = response.routing?.selectedModel || state.config.model;
      state.usageRecords.push({
        provider: actualProvider,
        model: actualModel,
        requestedProvider: response.routing?.requestedProvider || state.config.provider,
        requestedModel: response.routing?.requestedModel || state.config.model,
        selectionMode: response.routing?.selectionMode || state.config.selectionMode || 'pinned',
        fallbackReason: response.routing?.fallbackReason || '',
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
      });
    }

    let plannedToolCalls = response.toolCalls || [];
    if (runtimeRecovery) {
      // The accepted correction has one server-owned exact action. Model tool
      // output cannot change its path/content or substitute another tool.
      if (runtimeRecoveryAlreadyRecorded) {
        plannedToolCalls = [];
      } else if (!directStructuredMediaRecovery) {
        const id = `deterministic_correction_${iteration}_${Date.now().toString(36)}`;
        state.deterministicRecoveryToolCallIds.add(id);
        plannedToolCalls = [{
          id,
          name: runtimeRecovery.name,
          arguments: runtimeRecovery.arguments,
        }];
      }
    } else if (plannedToolCalls.length === 0) {
      const explicitRecoveryCandidate = noNewExecutionRecord
        ? buildDeterministicExplicitToolRecoveryCall(state.primaryTask, exposedToolNames)
        : null;
      const explicitRecovery = explicitRecoveryCandidate && !state.priorExecutionRecords.some(record => (
        toolCallSignature(record) === toolCallSignature({
          name: explicitRecoveryCandidate.name,
          arguments: explicitRecoveryCandidate.arguments,
        })
      ))
        ? explicitRecoveryCandidate
        : null;
      if (
        iteration === 0
        && noNewExecutionRecord
        && (
          hasRelevantEvidenceTool(state.toolRegistry, state.primaryTask, exposedToolNames)
          || Boolean(explicitRecovery)
        )
        && iteration + 1 < state.effectiveMaxIterations
      ) {
        state.conversationHistory.push({
          role: 'system',
          content: GENERIC_TOOL_REPLAN_PROMPT,
        });
        return undefined;
      }
      if (explicitRecovery) {
        const id = `deterministic_recovery_${iteration}_${Date.now().toString(36)}`;
        state.deterministicRecoveryToolCallIds.add(id);
        plannedToolCalls = [{
          id,
          name: explicitRecovery.name,
          arguments: explicitRecovery.arguments,
        }];
      }
    }
    if (plannedToolCalls.length === 0) {
      // Core evidence is a terminal success boundary. Auxiliary discovery
      // failures from earlier iterations may remain in the audit trail, but
      // they must not trigger another provider call after the exact requested
      // action has already completed.
      const coreActionCompleted = hasCompletedCoreAction(state.primaryTask, state.executionLog, state.toolExecutionContext);
      if (coreActionCompleted) {
        recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config);
        const guarded = guardToolResponseIfNeeded({
          task: getPrimaryUserText(state.messages),
          response: response.text || '',
          toolCalls: state.executionLog,
          source: state.context?.source,
          requestId: state.toolExecutionContext?.requestId,
          taskId: state.toolExecutionContext?.taskId,
          acceptedTaskTarget: state.toolExecutionContext?.acceptedTaskTarget,
        });
        return state.finish(guarded.text, guarded);
      }
      const missingVerification = buildMissingVerificationObligationPrompt(
        state.primaryTask,
        state.executionLog,
        state.toolRegistry,
        exposedToolNames,
        state.toolExecutionContext?.toolPolicy,
        state.toolExecutionContext,
      );
      if (
        missingVerification
        && state.verificationObligationReplans < MAX_VERIFICATION_OBLIGATION_REPLANS
      ) {
        // A verification continuation needs two model turns after the
        // premature completion attempt: one to choose/execute the verifier and
        // one to write the evidence-grounded final response. This allowance is
        // created only after the receipt gate proves it is necessary and is
        // still bounded by MAX_VERIFICATION_OBLIGATION_REPLANS.
        state.effectiveMaxIterations = Math.max(state.effectiveMaxIterations, iteration + 3);
        state.conversationHistory.push({
          role: 'assistant',
          content: response.text || 'The requested action has a verified receipt, but its completion evidence is incomplete.',
        });
        replacePromptBlock(state.conversationHistory, { id: 'missing-verification', kind: 'task_state',
          authority: 'server', required: true, content: missingVerification });
        state.verificationObligationReplans += 1;
        return undefined;
      }
      if (
        !coreActionCompleted
        && hasUnverifiedToolOutcome(state.executionLog)
        && exposedToolNames.size > 0
        && state.recoveryReplans < MAX_TOOL_RECOVERY_REPLANS
        && iteration + 1 < state.effectiveMaxIterations
      ) {
        state.conversationHistory.push({
          role: 'assistant',
          content: response.text || 'The previous tool path did not produce verified completion evidence.',
        });
        replacePromptBlock(state.conversationHistory, { id: 'tool-recovery', kind: 'task_state', authority: 'server',
          required: true, content: buildToolRecoveryReplanPrompt(
            'The previous tool path ended without verified terminal evidence, so a failure explanation is not a terminal result.',
          ),
        });
        state.recoveryReplans += 1;
        return undefined;
      }
      recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config);
      const guarded = guardToolResponseIfNeeded({
        task: getPrimaryUserText(state.messages),
        response: response.text || 'No response.',
        toolCalls: state.executionLog,
        source: state.context?.source,
        requestId: state.toolExecutionContext?.requestId,
        taskId: state.toolExecutionContext?.taskId,
        acceptedTaskTarget: state.toolExecutionContext?.acceptedTaskTarget,
      });
      return state.finish(guarded.text, guarded);
    }

    const rawToolCalls = plannedToolCalls.map((tc, index) => ({
      ...tc,
      id: tc.id || `call_${iteration}_${index}_${Date.now().toString(36)}`,
    }));
    if (rawToolCalls.length > state.invocationBudget.perResponseLimit) {
      return state.stopBudget('model_response', rawToolCalls.length, rawToolCalls.length, rawToolCalls.filter(call => exposedToolNames.has(call.name)).length);
    }
    const normalizedToolCalls = normalizePlannedToolScope(
      rawToolCalls,
      state.toolRegistry,
      state.primaryTask,
    );
    // Broad-scope normalization can turn one model-selected call into one call
    // per required schema enum member. Enforce the same response ceiling after
    // expansion so enum size cannot bypass the model-response budget.
    if (normalizedToolCalls.length > state.invocationBudget.perResponseLimit) {
      return state.stopBudget('model_response', rawToolCalls.length, normalizedToolCalls.length, normalizedToolCalls.filter(call => exposedToolNames.has(call.name)).length);
    }

    // Check for duplicate tool calls (prevents infinite loops within maxIterations)
    const lastAssistantMsg = state.conversationHistory
      .filter(m => m.role === 'assistant')
      .slice(-1)[0];
    if (lastAssistantMsg?.toolCalls) {
      const sameTools = lastAssistantMsg.toolCalls.every((tc, i) =>
        normalizedToolCalls[i] &&
        tc.name === normalizedToolCalls[i].name &&
        JSON.stringify(tc.arguments) === JSON.stringify(normalizedToolCalls[i].arguments)
      );
      if (sameTools && lastAssistantMsg.toolCalls.length === normalizedToolCalls.length) {
        const priorRecords = lastAssistantMsg.toolCalls.map(call => (
          [...state.executionLog].reverse().find(record => record.id === call.id)
        ));
        const priorBatchVerified = priorRecords.length > 0
          && priorRecords.every(isVerifiedToolSuccess);
        const priorBatchRetryable = priorRecords.length > 0
          && priorRecords.every(isRetryableToolOutcome);
        const retrySignatures = normalizedToolCalls.map(call => toolCallSignature({
          name: call.name,
          arguments: call.arguments || {},
        }));
        const retryBudgetAvailable = retrySignatures.every(signature => (
          (state.identicalRecoveryRetries.get(signature) || 0) < MAX_IDENTICAL_RECOVERY_RETRIES
        ));

        if (priorBatchRetryable && retryBudgetAvailable) {
          for (const signature of retrySignatures) {
            state.identicalRecoveryRetries.set(signature, (state.identicalRecoveryRetries.get(signature) || 0) + 1);
          }
        } else {
          const reason = priorBatchVerified
            ? 'The identical prior call already has verified terminal evidence. Skip duplicate execution and use that receipt to finish, or select only the still-missing verification step.'
            : priorBatchRetryable
              ? `The identical safe recovery retry budget (${MAX_IDENTICAL_RECOVERY_RETRIES}) is exhausted. Select a different declared fallback or verification capability.`
              : 'The identical prior call was not a verified success and is not safe to retry automatically. Reconcile its outcome or select a different declared fallback/verification capability.';
          if (
            state.recoveryReplans < MAX_TOOL_RECOVERY_REPLANS
            && iteration + 1 < state.effectiveMaxIterations
          ) {
            replacePromptBlock(state.conversationHistory, { id: 'tool-recovery', kind: 'task_state', authority: 'server',
              required: true, content: buildToolRecoveryReplanPrompt(reason) });
            state.recoveryReplans += 1;
            return undefined;
          }
          recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config);
          return state.finish(buildIterationLimitSummary(state.executionLog, getPrimaryUserText(state.messages)));
        }
      }
    }

    const invocableCallsInBatch = normalizedToolCalls.filter(tc => {
      if (!exposedToolNames.has(tc.name)) return false;
      const confirmedReplay = [...state.priorExecutionRecords].reverse().find(record => (
        toolCallSignature(record) === toolCallSignature({
          name: tc.name,
          arguments: tc.arguments || {},
        })
      ));
      return !shouldSuppressConfirmedReplay(confirmedReplay);
    }).length;
    if (state.invocationBudget.used + invocableCallsInBatch > state.invocationBudget.turnLimit) {
      return state.stopBudget('turn', rawToolCalls.length, normalizedToolCalls.length, invocableCallsInBatch);
    }
    // Reserve the whole admissible batch synchronously. Parallel/recovery
    // loops sharing this request id cannot both pass the remaining-budget
    // check and oversubscribe the turn while one adapter awaits I/O.
    state.invocationBudget.used += invocableCallsInBatch;
    state.invocationBudget.lastTouchedAt = Date.now();

    state.conversationHistory.push({
      role: 'assistant',
      content: normalizedToolCalls.some(call => state.deterministicRecoveryToolCallIds.has(call.id || ''))
        ? 'Server-owned recovery of the explicit, fully specified tool request.'
        : response.text,
      toolCalls: normalizedToolCalls,
      reasoningContent: response.reasoningContent,
    });
    const batchResult = await executePlannedToolBatch(state, { normalizedToolCalls, exposedToolNames, response });
    if (batchResult) return batchResult;

    if (directStructuredMediaRecovery) {
      // A workbench action is already fully specified and server-bound. Once
      // its one canonical tool call settles, return the receipt immediately;
      // neither initial planning nor a second summarization model call is
      // allowed to delay, mutate, duplicate, or hide that execution outcome.
      recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config);
      return state.finish('');
    }


}
