import type { ToolExecutionRecord, ToolContext } from "../../tools/types";
import type { CompletionGuardResult } from "../../work_product/completion_guard";
import { CN_TASK_EXECUTION_MESSAGES } from "../../regions/messages/task_execution_messages";
import { buildIterationLimitSummary } from './summaries';
import { parseReceiptObject } from '../../tools/receipt_payload';
import { sanitizeUserFacingExecutionOutput } from '../../cognition/user_output_protection';
import { guardToolResponseIfNeeded, inspectPublicExecutionReferences } from './projection';
import { actualDocumentReadContent, isSuccessfulExactDocumentRead, documentReadMatchesRequestedTarget } from '../../cognition/action_desktop_evidence';

export function buildVerifiedToolCheckpoint(executionLog: ToolExecutionRecord[], task: string, context?: ToolContext): CompletionGuardResult {
  const input = { task, response: '', toolCalls: executionLog, requestId: context?.requestId,
    taskId: context?.taskId, completionRequest: context?.completionRequest, acceptedTaskTarget: context?.acceptedTaskTarget,
    acceptedActionContract: context?.acceptedActionContract };
  const currentRecords = context?.requestId && context?.taskId ? inspectPublicExecutionReferences(input, '').currentRecords : [];
  const evidence = currentRecords.flatMap(record => {
    const receipt = parseReceiptObject(record.receipt);
    return ['create', 'mutate'].includes(record.capability?.operation || '') && record.capability?.verification.requiredFields?.includes('content') && typeof receipt?.content === 'string' && receipt.content.trim()
      ? [receipt.content.trim()] : record.capability?.operation === 'observe' && isSuccessfulExactDocumentRead(record)
        && documentReadMatchesRequestedTarget(record, task, context?.acceptedTaskTarget, [], context?.userId ? { userId: context.userId, domain: context.domain || 'personal', orgId: context.orgId || '' } : undefined)
        ? [actualDocumentReadContent(record)] : [];
  });
  const checkpoint = evidence.length ? evidence.join('\n\n') : buildIterationLimitSummary(executionLog, task);
  if (inspectPublicExecutionReferences(input, checkpoint).privateReference) return {
    text: CN_TASK_EXECUTION_MESSAGES.incompleteWholeRequest, blocked: true, reason: 'reply_private_reference',
  };
  const text = sanitizeUserFacingExecutionOutput(checkpoint, { task, toolRecords: executionLog });
  if (context?.currentTurnExecutionRequested) return { text, blocked: true, reason: 'The primary-model whole-request result is unavailable; verified progress is preserved.' };
  return guardToolResponseIfNeeded({ ...input, response: text });
}

export function isCallerCancellation(
  signal: AbortSignal | undefined,
  isCancelled: (() => boolean) | undefined,
): boolean {
  if (signal?.aborted) return true;
  try { return Boolean(isCancelled?.()); } catch { return false; }
}
