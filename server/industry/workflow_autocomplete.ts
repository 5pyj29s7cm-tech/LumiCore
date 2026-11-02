import { executeToolCall } from '../tools/execution_engine';
import type { ToolRegistry } from '../tools/registry';
import type { ToolContext, ToolExecutionRecord } from '../tools/types';
import { getIndustryWorkflowContract } from './workflow_contracts';
import { getIndustryWorkflowTask, recordMatchesWorkflowBinding } from './workflow_service';

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : {};
  } catch {
    return {};
  }
}

function verifiedReceipt(record: ToolExecutionRecord | undefined): boolean {
  return Boolean(
    record
    && !record.error
    && record.terminalVerification?.status === 'verified'
    && String(record.result || '').trim(),
  );
}

export function isVerifiedIndustryWorkflowCompletionRecord(
  record: ToolExecutionRecord | undefined,
): boolean {
  if (!verifiedReceipt(record) || record?.name !== 'industry_workflow_complete') return false;
  const payload = parseObject(record.result);
  const verification = parseObject(payload.verification);
  return payload.ok === true
    && payload.persisted === true
    && String(payload.status || '').toLowerCase() === 'verified'
    && verification.passed === true;
}

function taskIdFromStartRecord(records: ToolExecutionRecord[]): string {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.name !== 'industry_workflow_start' || !verifiedReceipt(record)) continue;
    const task = parseObject(parseObject(record.result).task);
    const taskId = String(task.id || '').trim();
    if (taskId) return taskId;
  }
  return '';
}

function terminalRequiredFailure(record: ToolExecutionRecord | undefined): boolean {
  if (!record) return false;
  const status = record.terminalVerification?.status;
  return Boolean(record.error || status === 'failed');
}

/**
 * Settle an industry workflow deterministically once every required capability
 * has produced a current-loop terminal receipt. All verified receipts close it
 * successfully; a terminal failure closes the attempt as blocked/needs-review
 * through the canonical verifier, so an industry and project ledger cannot be
 * left misleadingly "in progress" after a known provider failure. This never
 * substitutes narration or historical receipts for current-turn evidence.
 */
export async function completeIndustryWorkflowFromVerifiedReceipts(input: {
  registry: ToolRegistry;
  records: ToolExecutionRecord[];
  context?: ToolContext;
}): Promise<ToolExecutionRecord | null> {
  const context = input.context;
  if (!context?.industryWorkflowEntryId || !context.industryWorkflowProductLine) return null;
  if (context.isCancelled?.()) return null;

  const contract = getIndustryWorkflowContract(
    context.industryWorkflowProductLine,
    context.industryWorkflowEntryId,
  );
  const required = Array.from(new Set(
    (contract?.requiredToolReceipts || [])
      .map(String)
      .filter(Boolean),
  ));
  if (!required.length) return null;
  const taskId = String(context.industryWorkflowTaskId || '').trim() || taskIdFromStartRecord(input.records);
  if (!taskId || !context.userId) return null;
  const task = getIndustryWorkflowTask({userId: context.userId, domain: context.domain === 'work' ? 'work' : 'personal', orgId: context.domain === 'work' ? String(context.orgId || '') : ''}, taskId);
  const metadata = task?.metadata?.industryWorkflow;
  if (!task || metadata?.entryId !== contract?.entryId || metadata?.productLine !== contract?.productLine
    || context.taskId !== metadata.conversationTaskId || context.requestId !== metadata.requestId) return null;
  const scopedRecords = input.records.filter(record => recordMatchesWorkflowBinding(task, record));
  if (scopedRecords.some(record => isVerifiedIndustryWorkflowCompletionRecord(record) && parseObject(parseObject(record.result).task).id === taskId)) return null;

  const latestRequiredRecords = required.map((name) => {
    for (let index = scopedRecords.length - 1; index >= 0; index -= 1) {
      const record = scopedRecords[index];
      if (record.name === name) return { index, record };
    }
    return { index: -1, record: undefined };
  });
  if (latestRequiredRecords.some(item => item.index < 0)) return null;

  const allVerified = latestRequiredRecords.every(item => verifiedReceipt(item.record));
  const hasTerminalFailure = latestRequiredRecords.some(item => terminalRequiredFailure(item.record));
  if (!allVerified && !hasTerminalFailure) return null;

  // If verification already ran after the newest required receipt, preserve
  // that result. Retry only when a newer required capability receipt arrives.
  const newestRequiredIndex = Math.max(...latestRequiredRecords.map(item => item.index));
  let latestCompletionAttemptIndex = -1;
  for (let index = scopedRecords.length - 1; index >= 0; index -= 1) {
    if (scopedRecords[index].name === 'industry_workflow_complete') {
      latestCompletionAttemptIndex = index;
      break;
    }
  }
  if (latestCompletionAttemptIndex >= newestRequiredIndex) return null;

  return executeToolCall({
    registry: input.registry,
    id: `industry-autocomplete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'industry_workflow_complete',
    arguments: { taskId },
    context: {
      ...context,
      industryWorkflowTaskId: taskId,
      idempotencyKey: `${allVerified ? 'industry-complete' : 'industry-settle-failure'}:${context.requestId || context.turnId || 'turn'}:${taskId}`,
      getCurrentToolRecords: () => [...input.records],
    },
  });
}
