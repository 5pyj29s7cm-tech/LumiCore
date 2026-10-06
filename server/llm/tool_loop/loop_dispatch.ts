import type { ProviderGetters } from "../provider_getters";
import type { ToolRegistry } from "../../tools/registry";
import type { ToolExecutionRecord, ToolContext } from "../../tools/types";
import type { NormalizedMessage, StreamCallback } from "../providers";
import type { LLMConfig, LLMUsageRecord, LLMResult } from './contracts';
import type { ToolLoopModelBudget } from './model_budget';
import type { ToolInvocationBudgetState } from './invocation_budget';
import { prepareToolLoop } from './loop_setup';
import { executeToolLoopIteration } from './iteration';
import { recordWorkflowIfToolsUsed } from './workflow';
import { hasCompletedCoreAction } from './projection';
import { buildIterationLimitSummary, getPrimaryUserText } from './summaries';

export async function runWithToolsInternal(
  messages: NormalizedMessage[],
  toolRegistry: ToolRegistry,
  config: LLMConfig,
  providerGetters: Partial<ProviderGetters>,
  onToolCall?: (record: ToolExecutionRecord) => unknown,
  maxIterations: number = 5,
  onStreamChunk?: StreamCallback,
  context?: ToolContext,
  modelBudget?: ToolLoopModelBudget,
  usageRecordSink?: LLMUsageRecord[],
  invocationBudgetState?: ToolInvocationBudgetState,
): Promise<LLMResult> {
  const prepared = prepareToolLoop(messages, toolRegistry, config, providerGetters, onToolCall, maxIterations, onStreamChunk, context, modelBudget, usageRecordSink, invocationBudgetState);
  if (prepared.terminal) return prepared.terminal;
  const state = prepared.state!;
  for (let iteration = 0; iteration < state.effectiveMaxIterations; iteration++) {
    const result = await executeToolLoopIteration(state, iteration);
    if (result) return result;
  }


  recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config);
  if (hasCompletedCoreAction(state.primaryTask, state.executionLog, state.toolExecutionContext)) {
    // Channels finalize this from the verified receipt set. Returning an empty
    // model body is safer than replacing completed work with an iteration or
    // recovery warning.
    return state.finish('');
  }
  return state.finish(buildIterationLimitSummary(state.executionLog, getPrimaryUserText(state.messages)));
}
