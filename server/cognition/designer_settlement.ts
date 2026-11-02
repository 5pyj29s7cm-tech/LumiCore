import { isCanonicalToolExecutionRecord } from '../tools/execution_engine';
import { completeIndustryWorkflowFromVerifiedReceipts } from '../industry/workflow_autocomplete';
import { parseReceiptObject, toolRecordTerminalPayload } from '../tools/receipt_payload';
import type { ToolExecutionRecord } from '../tools/types';
import type { ResolvedTurnModelInput } from './turn_model';

/** Chat and voice share the same post-loop archival step and current identity. */
export async function settleDesignerWorkflow(model: ResolvedTurnModelInput, records: ToolExecutionRecord[]): Promise<ToolExecutionRecord | null> {
  const request = model.execution.turnIntent.flow.designerRequest;
  if (!request?.requiresStage || !('registry' in model) || !model.context?.userId) return null;
  model.config.signal?.throwIfAborted(); model.assertCurrent?.();
  if (model.isCancelled?.() || model.context.isCancelled?.()) return null;
  const requestId = model.execution.resolution.requestId;
  if (records.some(record => record.requestId === requestId && record.envelope?.status === 'waiting_confirmation')) return null;
  const start = [...records].reverse().find(record => record.name === 'industry_workflow_start' && record.requestId === requestId
    && record.terminalVerification?.status === 'verified' && !record.error && isCanonicalToolExecutionRecord(record));
  if (!start) return null;
  const payload = parseReceiptObject(toolRecordTerminalPayload(start));
  const task = payload?.task, metadata = task?.metadata?.industryWorkflow;
  const domain = model.context.domain === 'work' ? 'work' : 'personal';
  const orgId = domain === 'work' ? model.context.orgId || '' : '';
  if (payload?.ok !== true || payload.persisted !== true || !task?.id || task.userId !== model.context.userId
    || task.domain !== domain || (task.orgId || '') !== orgId || metadata?.productLine !== 'design'
    || metadata.entryId !== request.entryId || metadata.requestId !== requestId
    || !start.taskId || metadata.conversationTaskId !== start.taskId
    || model.context.taskId && model.context.taskId !== start.taskId) return null;
  return completeIndustryWorkflowFromVerifiedReceipts({ registry: model.registry, records,
    context: { ...model.context, requestId, taskId: start.taskId, toolPolicy: model.execution.authorizationPolicy,
      industryWorkflowTaskId: task.id, industryWorkflowProductLine: 'design', industryWorkflowEntryId: request.entryId,
      executionSignal: model.config.signal, isCancelled: () => Boolean(model.config.signal?.aborted || model.isCancelled?.() || model.context?.isCancelled?.()) },
  });
}
