import { flushDBOrThrow, readDatabaseTables, commitDatabaseTables } from '../../db_layer';
import { sanitizeToolRecordsForPersistence } from '../cognition/user_output_protection';
import { createToolReceiptObserver } from '../tools/receipt_observer';
import type { ToolExecutionRecord } from '../tools/types';
import { appendConversationActionReceipts } from "./ledger/receipt_store";
import { type ConversationActionTaskRow } from "./ledger/contracts";

interface ReceiptOwner {
  userId: string;
  conversationId: string;
  taskId?: string;
  requestId: string;
  turnRowId?: string;
  externalMessageId?: string;
  domain?: string;
  orgId?: string;
}

/** Archive observations without adjudicating a task, publishing a reply or starting work. */
export function createConversationReceiptObserver(identity: ReceiptOwner, isAuthorized: () => boolean) {
  const owner = Object.freeze({ ...identity, domain: identity.domain || 'personal', orgId: identity.orgId || '' });
  const persist = async (record: ToolExecutionRecord): Promise<void> => {
    if (!owner.taskId || record.taskId !== owner.taskId || record.requestId !== owner.requestId || !isAuthorized()) return;
    const db = readDatabaseTables(["conversationActionTasks","conversationActionTurns","conversations","conversationActionReceipts","interactions"]);
    const conversation = (db.conversations || []).find((row: any) => row.id === owner.conversationId
      && row.userId === owner.userId && (row.domain || 'personal') === owner.domain && (row.orgId || '') === owner.orgId);
    const task = (db.conversationActionTasks || []).find((row: ConversationActionTaskRow) => row.id === owner.taskId
      && row.userId === owner.userId && row.conversationId === owner.conversationId
      && (row.domain || 'personal') === owner.domain && (row.orgId || '') === owner.orgId);
    const turn = (db.conversationActionTurns || []).find((row: any) => row.requestId === owner.requestId
      && row.taskId === owner.taskId && row.userId === owner.userId && row.conversationId === owner.conversationId
      && (row.domain || 'personal') === owner.domain && (row.orgId || '') === owner.orgId);
    if (!conversation || !task || !turn
      || (owner.turnRowId && owner.turnRowId !== turn.id)
      || (record.turnRowId && record.turnRowId !== turn.id)
      || (owner.externalMessageId && record.externalMessageId && owner.externalMessageId !== record.externalMessageId)) return;
    const records = sanitizeToolRecordsForPersistence([record]) as ToolExecutionRecord[];
    // This append-only path deliberately bypasses live task projection. Even an
    // on-time tool result is only one step, not proof the whole task is complete.
    const appended = appendConversationActionReceipts(db, { task, records, turnId: owner.requestId, requestId: owner.requestId,
      turnRowId: turn.id, externalMessageId: owner.externalMessageId });
    if (appended.length) commitDatabaseTables(db);
    // Flush duplicate deliveries too: an earlier attempt may have staged the
    // row in memory but failed to persist it. Native ACKs must await durability.
    await flushDBOrThrow();
  };
  return {
    onToolRecord: createToolReceiptObserver(persist).onToolRecord,
    async onDesktopLateResult(event: { correlationId: string; name: string; arguments: Record<string, any>; result?: string; error?: string }) {
      await persist({
        id: event.correlationId, idempotencyKey: event.correlationId,
        taskId: owner.taskId, requestId: owner.requestId, turnId: owner.requestId,
        turnRowId: owner.turnRowId, externalMessageId: owner.externalMessageId,
        name: event.name, arguments: event.arguments, result: event.result || '',
        error: event.error || 'outcome_unknown: Native substep returned after the enclosing tool ended; reconciliation is required.',
        // A physical substep is not the canonical result of its enclosing tool.
        terminalVerification: { status: 'unverified', strategy: 'terminal_receipt', reason: 'late_native_receipt_requires_tool_reconciliation' },
      });
    },
  };
}
