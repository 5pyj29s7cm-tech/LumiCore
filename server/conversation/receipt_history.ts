import { inspectPersistedToolExecutionReceipt } from '../tools/persisted_execution_receipt';
import type { ToolExecutionRecord } from '../tools/types';
import { sanitizeToolRecordsForPersistence } from '../cognition/user_output_protection';

/** Project late evidence onto its original reply without rewriting the saved transcript. */
export function projectConversationReceiptHistory<T extends {
  role?: string; requestId?: string; externalMessageId?: string; userId?: string;
  conversationId?: string; domain?: string; orgId?: string; toolCalls?: unknown;
}>(db: any, messages: T[]): T[] {
  const ownerKey = (row: any) => JSON.stringify([row.userId, row.conversationId, row.domain || 'personal', row.orgId || '', row.requestId || row.externalMessageId]);
  const owners = new Set(messages.filter(message => message.role === 'assistant').map(ownerKey));
  if (!owners.size) return messages;
  const tasks = new Map<string, any>((db.conversationActionTasks || []).map((task: any) => [task.id, task]));
  const turns = new Map<string, any>((db.conversationActionTurns || []).map((turn: any) => [JSON.stringify([ownerKey(turn), turn.taskId]), turn]));
  const archived = new Map<string, ToolExecutionRecord[]>();
  for (const row of db.conversationActionReceipts || []) {
    const task = tasks.get(row.taskId);
    if (!task || row.conversationId !== task.conversationId || !row.requestId) continue;
    const key = ownerKey({ ...task, requestId: row.requestId });
    const turn = turns.get(JSON.stringify([key, task.id]));
    if (!owners.has(key) || !turn) continue;
    const inspection = inspectPersistedToolExecutionReceipt(row, { rowTaskId: task.id, envelopeTaskId: task.id,
      requestId: row.requestId, ...(row.turnRowId ? { turnRowId: turn.id } : {}) });
    if (!inspection.valid) continue;
    const envelope = inspection.envelope!;
    const record: ToolExecutionRecord = {
      id: row.id, idempotencyKey: row.idempotencyKey, name: row.toolName,
      taskId: task.id, requestId: row.requestId, turnId: row.turnId,
      ...(envelope.turnRowId ? { turnRowId: envelope.turnRowId } : {}),
      ...(envelope.externalMessageId ? { externalMessageId: envelope.externalMessageId } : {}),
      ...(envelope.resolutionId ? { resolutionId: envelope.resolutionId } : {}),
      arguments: row.targetIdentity ? { target: row.targetIdentity } : {},
      result: typeof envelope.result === 'string' ? envelope.result : JSON.stringify(envelope.result ?? ''),
      error: envelope.error, envelope,
      terminalVerification: {
        status: inspection.verificationStatus || 'unverified', strategy: 'terminal_receipt', reason: envelope.verification.reason,
      },
    };
    const records = archived.get(key) || [];
    records.push(record);
    archived.set(key, records);
  }
  return messages.map(message => {
    if (message.role !== 'assistant') return message;
    const requestId = message.requestId || message.externalMessageId;
    const receipts = archived.get(ownerKey(message));
    if (!receipts?.length) return message;
    const records: ToolExecutionRecord[] = sanitizeToolRecordsForPersistence(message.toolCalls) || [];
    for (const receipt of receipts) {
      const existing = records.findIndex(record => record.name === receipt.name
        && (record.requestId || requestId) === receipt.requestId
        && (!record.taskId || record.taskId === receipt.taskId)
        && Boolean(record.id || record.idempotencyKey)
        && [record.id, record.idempotencyKey].some(id => id && (id === receipt.id || id === receipt.idempotencyKey)));
      if (existing < 0) records.push(receipt);
      else if (records[existing].terminalVerification?.reason === 'tool_settlement_unknown') {
        // Keep the original arguments and call id; only replace the missing
        // outcome with evidence for that exact invocation.
        records[existing] = { ...receipt, id: records[existing].id, arguments: records[existing].arguments };
      }
    }
    return { ...message, toolCalls: records };
  });
}
