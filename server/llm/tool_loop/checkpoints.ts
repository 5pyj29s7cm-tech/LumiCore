import type { ToolExecutionRecord, ToolContext } from "../../tools/types";
import type { CompletionGuardResult } from "../../work_product/completion_guard";
import { CN_DURABLE_EXECUTION_MESSAGES } from "../../regions/messages/durable_execution_messages";
import { isVerifiedToolSuccess } from './recovery';
import { buildIterationLimitSummary, humanToolLabel } from './summaries';
import { compactReceiptForModel, compactStringForModel } from './receipts';
import { guardToolResponseIfNeeded } from './projection';

export function buildVerifiedToolCheckpoint(executionLog: ToolExecutionRecord[], task: string, context?: ToolContext): CompletionGuardResult {
  const verified = executionLog.filter(isVerifiedToolSuccess).slice(-4);
  if (verified.length === 0) return { text: buildIterationLimitSummary(executionLog, task), blocked: false };
  const isZh = /[\u3400-\u9fff]/.test(task);
  const evidence = verified.map((record, index) => {
    const result = String(record.result || '').trim();
    const receipt = result ? '' : compactReceiptForModel(record.receipt);
    const detail = compactStringForModel(
      result || receipt || record.terminalVerification?.reason || (isZh ? CN_DURABLE_EXECUTION_MESSAGES.terminalVerificationPassed : 'terminal verification passed'),
      3_000,
      'Verified checkpoint evidence',
    );
    return `${index + 1}. ${humanToolLabel(record.name)}\n${detail}`;
  });
  const checkpoint = isZh
    ? [
        CN_DURABLE_EXECUTION_MESSAGES.verifiedCheckpointHeading,
        ...evidence,
        '',
        CN_DURABLE_EXECUTION_MESSAGES.verifiedCheckpointContinuation,
      ].join('\n')
    : ['Verified execution results:', ...evidence, '', 'The progress and receipts are preserved so subsequent work can continue from this checkpoint.'].join('\n');
  return guardToolResponseIfNeeded({
    task,
    response: checkpoint,
    toolCalls: executionLog,
    requestId: context?.requestId,
    taskId: context?.taskId,
    acceptedTaskTarget: context?.acceptedTaskTarget,
  });
}

export function isCallerCancellation(
  signal: AbortSignal | undefined,
  isCancelled: (() => boolean) | undefined,
): boolean {
  if (signal?.aborted) return true;
  try { return Boolean(isCancelled?.()); } catch { return false; }
}
