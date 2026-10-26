import { readDatabaseTables } from '../../../../db_layer';
import { getChatExecution, type ChatExecutionScope } from '../../chat_execution_registry';
import { TERMINAL_RETENTION_MS } from '../../chat_execution_registry/contracts';
import { parseStoredArray, parseStoredObject } from '../../../tools/receipt_payload';
import { isCompletedObservationOnlyDelivery } from '../../../conversation/manager/terminal_disposition';
import { finalizeForegroundRequestDurably } from '../../../conversation/foreground_finalization';

/** Reconcile only the exact already-delivered observation reply; never rerun it. */
export async function reconcileCompletedChatReplay(scope: ChatExecutionScope, requestId: string): Promise<boolean> {
  const snapshot = getChatExecution(scope, requestId);
  const event = snapshot?.terminalEvent;
  const payload = event?.payload;
  const conversationId = scope.conversationId || snapshot?.conversationId;
  const updatedAt = Date.parse(snapshot?.updatedAt || '');
  if (!snapshot?.terminal || snapshot.status !== 'completed' || snapshot.sidecar
    || !Number.isFinite(updatedAt) || Date.now() - updatedAt >= TERMINAL_RETENTION_MS
    || snapshot.requestId !== requestId || snapshot.source !== scope.source
    || !conversationId || snapshot.conversationId !== conversationId
    || event?.event !== 'agent:response' || payload?.blocked !== false || payload.finalized !== true
    || payload.requestId !== requestId || payload.conversationId !== conversationId
    || payload.source !== scope.source || parseStoredObject(payload.completionFeedback).status !== 'completed') return false;

  const db = readDatabaseTables(['conversationActionTasks', 'conversationActionTurns', 'conversations', 'interactions']);
  const orgId = scope.domain === 'work' ? String(scope.orgId || '') : '';
  const inScope = (row: any) => row.userId === scope.userId && row.conversationId === conversationId;
  const conversations = (db.conversations || []).filter((row: any) => row.id === conversationId
    && row.userId === scope.userId && row.domain === scope.domain && String(row.orgId || '') === orgId);
  const turns = (db.conversationActionTurns || []).filter((row: any) => inScope(row) && row.requestId === requestId
    && row.domain === scope.domain && String(row.orgId || '') === orgId);
  if (conversations.length !== 1 || turns.length !== 1) return false;
  const conversation = conversations[0];
  const turn = turns[0];
  if (turn.status !== 'terminal' || turn.terminalReason !== 'task_outcome:blocked' || !turn.taskId || !turn.terminalMessageId) return false;
  const tasks = (db.conversationActionTasks || []).filter((row: any) => inScope(row) && row.id === turn.taskId
    && row.domain === scope.domain && String(row.orgId || '') === orgId);
  const assistants = (db.interactions || []).filter((row: any) => inScope(row) && row.role === 'assistant'
    && (row.requestId === requestId || row.externalMessageId === requestId));
  if (tasks.length !== 1 || assistants.length !== 1) return false;
  const task = tasks[0];
  const assistant = assistants[0];
  const context = parseStoredObject(task.context);
  const state = parseStoredObject(context.actionState);
  const disposition = parseStoredObject(context.taskFinalization);
  const assistantDisposition = parseStoredObject(assistant.terminalTaskDisposition);
  const live = parseStoredObject(conversation.actionContinuationState);
  if (task.status !== 'blocked' || task.activeRequestId || state.activeRequestId
    || (db.conversationActionTurns || []).some((row: any) => inScope(row) && row.requestId !== requestId && (row.status === 'accepted' || row.status === 'leased'))
    || state.taskId !== task.id || state.status !== 'blocked'
    || disposition.requestId !== requestId || disposition.outcome !== 'blocked'
    || context.terminalPersistence || state.terminalPersistence
    || (conversation.pendingActionContinuation?.requestId && conversation.pendingActionContinuation.requestId !== requestId)
    || (live.activeRequestId && live.activeRequestId !== requestId)
    || assistant.id !== turn.terminalMessageId || assistant.message !== payload.text
    || parseStoredObject(assistant.completionFeedback).status !== 'completed'
    || assistantDisposition.outcome === 'blocked' || assistantDisposition.outcome === 'cancelled') return false;
  const records = parseStoredArray(assistant.toolCalls);
  if (records.some(record => record.taskId !== task.id || record.requestId !== requestId)
    || !isCompletedObservationOnlyDelivery({ taskText: task.goal, currentInstruction: state.latestInstruction,
      taskCapsule: state.taskCapsule, assistantText: assistant.message,
      completionFeedback: assistant.completionFeedback, toolRecords: records, requestId, taskId: task.id })) return false;

  const result = await finalizeForegroundRequestDurably({
    conversationId, userId: scope.userId, requestId, expectedTaskId: task.id,
    assistantMessageId: assistant.id, assistantState: assistant.message,
    outcome: 'terminal', reason: 'task_outcome:completed',
  });
  return result.converged && result.effectiveOutcome === 'terminal' && result.taskStatus === 'completed';
}
