import type { ToolExecutionRecord, ToolContext } from "../../tools/types";
import type { CompletionGuardResult } from "../../work_product/completion_guard";
import { CN_TASK_EXECUTION_MESSAGES } from "../../regions/messages/task_execution_messages";
import { buildIterationLimitSummary } from './summaries';
import { isModelDeadlineError, isModelContextCapacityError } from '../model_routing_receipts';
import { parseReceiptObject } from '../../tools/receipt_payload';
import { sanitizeUserFacingExecutionOutput } from '../../cognition/user_output_protection';
import { guardToolResponseIfNeeded, inspectPublicExecutionReferences } from './projection';
import { actualDocumentReadContent, isSuccessfulExactDocumentRead, documentReadMatchesRequestedTarget, requestsExactReadOnlyArtifactInspection } from '../../cognition/action_desktop_evidence';

export function buildVerifiedToolCheckpoint(executionLog: ToolExecutionRecord[], task: string, context?: ToolContext, failure?: unknown): CompletionGuardResult {
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
  const readOnly = requestsExactReadOnlyArtifactInspection(task);
  const checkpoint = evidence.length && !readOnly ? evidence.join('\n\n') : buildIterationLimitSummary(executionLog, task, context);
  if (inspectPublicExecutionReferences(input, checkpoint).privateReference) return {
    text: CN_TASK_EXECUTION_MESSAGES.incompleteWholeRequest, blocked: true, reason: 'reply_private_reference',
  };
  if (isModelContextCapacityError(failure)) {
    const explanation = /[\u3400-\u9fff]/u.test(task)
      ? '这轮需要保留的内容超出了可处理容量，暂时没能生成完整回答。已有聊天内容保留。可以减少同时处理的材料，或在新聊天中继续。'
      : 'The content that must be retained exceeds the available processing capacity, so a complete answer was not produced. Existing conversation content is retained. Reduce the material handled together or continue in a new chat.';
    const text = sanitizeUserFacingExecutionOutput([explanation, ...evidence].join('\n\n'), { task, toolRecords: executionLog });
    return { text, blocked: true, reason: 'model_context_capacity' };
  }
  const deadline = isModelDeadlineError(failure);
  const checkpointText = deadline
    ? [/[\u3400-\u9fff]/u.test(task)
      ? '等待模型结果超时，本次回答尚未完成；已经取得的结果保留。'
      : 'The model response timed out. This request remains incomplete; verified results are retained.', checkpoint].join('\n')
    : checkpoint;
  const text = sanitizeUserFacingExecutionOutput(checkpointText, { task, toolRecords: executionLog });
  if (deadline) return { text, blocked: true, reason: 'model_wait_deadline' };
  if (readOnly || !evidence.length || context?.currentTurnExecutionRequested) return { text, blocked: true, reason: 'The primary-model whole-request result is unavailable; verified progress is preserved.' };
  return guardToolResponseIfNeeded({ ...input, response: text });
}

export function isCallerCancellation(
  signal: AbortSignal | undefined,
  isCancelled: (() => boolean) | undefined,
): boolean {
  if (signal?.aborted) return true;
  try { return Boolean(isCancelled?.()); } catch { return false; }
}
