import { runResolvedLumiTurn, type ResolvedTurnModelInput } from './turn_model';
import { settleDesignerWorkflow } from './designer_settlement';
import { runResolvedLumiRecovery } from './turn_recovery';
import { finalizeLumiResponseForDelivery, type LumiResponseDeliveryInput } from './response_delivery';
import { mergeToolExecutionRecords } from './task_execution_ledger';
import type { ToolExecutionRecord } from '../tools/types';
import type { LLMResult } from '../llm/adapter';
import type { ToolSessionOptions } from '../llm/lumi_turn';
export interface PreparedLumiTurnInput {
  model: ResolvedTurnModelInput;
  source: string | (() => string);
  taskText: string;
  taskId?: string;
  requestId: string;
  toolRecords?: ToolExecutionRecord[];
  /** Receipt projection is passive: prior evidence and a current desktop aggregate. */
  projectRecords?: (records: ToolExecutionRecord[]) => ToolExecutionRecord[];
  /** Entry facts configure verification; this callback cannot execute another model. */
  finalization?: (candidate: { result: LLMResult; responseText: string; toolRecords: ToolExecutionRecord[] }) => Omit<LumiResponseDeliveryInput,
    'taskText' | 'responseText' | 'completionGuard' | 'source' | 'toolRecords' | 'attempt'>;
  recovery?: Pick<ToolSessionOptions, 'maxIterations' | 'onToolCall' | 'context'>;
  skipModel?: boolean;
  onResult?: (result: LLMResult) => void;
  onRecoveryStart?: () => void;
  onRecoveryUsage?: (records: LLMResult['usageRecords']) => void;
}
/** Execute and verify the accepted plan once, retaining its model budget and original messages for recovery. */
export async function runPreparedLumiTurn(input: PreparedLumiTurnInput) {
  if (input.requestId !== input.model.execution.resolution.requestId) throw new Error('Prepared execution does not belong to the accepted turn');
  const assertCurrent = () => {
    input.model.config.signal?.throwIfAborted();
    if (input.model.isCancelled?.()) throw new DOMException('Turn execution cancelled', 'AbortError');
    input.model.assertCurrent?.();
  };
  assertCurrent();
  const result: LLMResult = input.skipModel ? { text: '', toolCalls: [], usageRecords: [] } : await runResolvedLumiTurn(input.model);
  input.onResult?.(result); assertCurrent();
  const project = (records: ToolExecutionRecord[]) => input.projectRecords?.(records) || records;
  let toolRecords = project(mergeToolExecutionRecords(input.toolRecords || [], result.toolCalls || []));
  const usageRecords = [...(result.usageRecords || [])];
  const responseText = String(result.text || '').trim();
  const source = typeof input.source === 'function' ? input.source() : input.source;
  let policy = input.finalization?.({ result, responseText, toolRecords });
  if (!input.skipModel && !policy?.pendingConfirmation && !policy?.isPendingConfirmation?.()
    && !policy?.aborted && !policy?.isAborted?.()) {
    const completion = await settleDesignerWorkflow(input.model, toolRecords);
    assertCurrent();
    if (completion) {
      toolRecords = project(mergeToolExecutionRecords(toolRecords, [completion]));
      if ('registry' in input.model) await input.model.onToolCall?.(completion);
      policy = input.finalization?.({ result, responseText, toolRecords });
    }
  }
  const outbound = await finalizeLumiResponseForDelivery({
    taskText: input.taskText, responseText, completionGuard: result.completionGuard, source,
    flow: input.model.execution.turnIntent.flow, taskId: input.model.execution.taskId || input.taskId, requestId: input.requestId,
    allowToolUse: input.model.execution.executionRequested && !input.skipModel,
    isAborted: () => Boolean(input.model.config.signal?.aborted || input.model.isCancelled?.()),
    isPendingConfirmation: () => false, ...policy, toolRecords,
    attempt: async recovery => {
      assertCurrent(); input.onRecoveryStart?.();
      const model = 'registry' in input.model ? { ...input.model, ...input.recovery,
        context: { ...input.model.context, ...input.recovery?.context, source: input.recovery?.context?.source || (input.model.context?.source || input.model.config.source || source) + '_guard_recovery' } } : input.model;
      const attempt = await runResolvedLumiRecovery({ model, responseText, recovery });
      usageRecords.push(...attempt.usageRecords); input.onRecoveryUsage?.(attempt.usageRecords);
      const recovered = project(mergeToolExecutionRecords(toolRecords, attempt.toolRecords || []));
      const recoveryPolicy = input.finalization?.({ result: { ...result, text: attempt.text || '', toolCalls: recovered }, responseText: attempt.text || '', toolRecords: recovered });
      const completion = !recoveryPolicy?.pendingConfirmation && !recoveryPolicy?.isPendingConfirmation?.()
        && !recoveryPolicy?.aborted && !recoveryPolicy?.isAborted?.() ? await settleDesignerWorkflow(model, recovered) : null;
      assertCurrent();
      if (completion && 'registry' in model) await model.onToolCall?.(completion);
      return { ...attempt, toolRecords: project(completion ? mergeToolExecutionRecords(recovered, [completion]) : recovered) };
    },
  });
  assertCurrent();
  return { result, finalized: outbound.finalization, toolRecords: project(outbound.toolRecords), usageRecords };
}
