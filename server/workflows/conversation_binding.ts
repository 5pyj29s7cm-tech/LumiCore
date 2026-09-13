import { readDB } from '../../db_layer';
import type { ConversationActionReceiptRow, ConversationActionTaskRow } from '../conversation/action_ledger';
import { inspectPersistedToolExecutionReceipt } from '../tools/persisted_execution_receipt';
import { parseReceiptObject } from '../tools/receipt_payload';
import type { ToolContext } from '../tools/types';
import { getWorkflowRun, type WorkflowRun } from './runtime';

/** Resolve only the run proved by this exact conversation task's durable receipts.
 * A workflow definition, a model-supplied id, or another task is never a binding.
 * This is an observation target, not permission to approve or replay a step. */
export function resolveConversationWorkflowRun(
  context: Pick<ToolContext, 'userId' | 'conversationId' | 'taskId' | 'domain' | 'orgId'> | undefined,
  db = readDB(),
  lookup = getWorkflowRun,
): WorkflowRun | null {
  if (!context?.userId || !context.conversationId || !context.taskId) return null;
  const domain = context.domain === 'work' ? 'work' : 'personal';
  const orgId = domain === 'work' ? String(context.orgId || '') : '';
  const task = (db.conversationActionTasks as ConversationActionTaskRow[] || []).find(row =>
    row.id === context.taskId && row.conversationId === context.conversationId && row.userId === context.userId
    && row.domain === domain && row.orgId === orgId);
  if (!task) return null;
  const runs = new Map<string, WorkflowRun>();
  for (const row of db.conversationActionReceipts as ConversationActionReceiptRow[] || []) {
    if (row.taskId !== task.id || row.conversationId !== task.conversationId
      || !['run_workflow', 'get_workflow_run', 'decide_workflow_confirmation', 'resume_workflow_run'].includes(row.toolName)) continue;
    const proof = inspectPersistedToolExecutionReceipt(row, { rowTaskId: task.id, outcome: 'verified_success' });
    if (!proof.valid || !proof.explicitlyTerminalVerified) continue;
    const result = parseReceiptObject(proof.envelope?.result);
    if (result?.ok !== true || typeof result.runId !== 'string' || typeof result.workflowId !== 'string') continue;
    const run = lookup(result.runId, context.userId);
    if (run && run.workflowId === result.workflowId && run.scope.domain === domain && run.scope.orgId === orgId) runs.set(run.runId, run);
  }
  const active = [...runs.values()].filter(run => !['completed', 'cancelled'].includes(run.status));
  // Ambiguous tasks need an explicit selection; never choose the latest run globally.
  return active.length === 1 ? active[0] : active.length === 0 && runs.size === 1 ? [...runs.values()][0] : null;
}
