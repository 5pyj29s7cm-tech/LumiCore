import { runResolvedLumiTurn, type ResolvedTurnModelInput } from './turn_model';
import type { ExecutionGuardRecoveryAttemptContext, ExecutionGuardRecoveryAttemptResult } from './execution_guard_recovery';
import type { LLMUsageRecord } from '../llm/adapter';

export interface ResolvedTurnRecoveryInput {
  model: ResolvedTurnModelInput;
  responseText: string;
  recovery: ExecutionGuardRecoveryAttemptContext;
}

/** The recovery keeps the accepted plan, budget and receipts; transport output stays buffered. */
export async function runResolvedLumiRecovery(input: ResolvedTurnRecoveryInput): Promise<ExecutionGuardRecoveryAttemptResult & { usageRecords: LLMUsageRecord[] }> {
  const { model, recovery } = input;
  const messages = [
    ...model.messages,
    ...(input.responseText.trim() ? [{ role: 'assistant' as const, content: input.responseText }] : []),
    { role: 'user' as const, content: recovery.instruction },
  ];
  const result = 'registry' in model
    ? await runResolvedLumiTurn({
        ...model, messages, streaming: false, onStreamChunk: undefined,
        context: { ...model.context, priorToolRecords: recovery.priorToolRecords },
        onToolCall: async record => {
          await model.onToolCall?.(record);
          if (record.result !== undefined || record.error !== undefined) recovery.recordTool({
            ...record, arguments: record.arguments || {}, result: record.result || '',
          });
        },
      })
    : await runResolvedLumiTurn({ ...model, messages, streaming: false, onChunk: undefined });
  return { text: result.text, completionGuard: result.completionGuard, toolRecords: result.toolCalls, usageRecords: result.usageRecords };
}
