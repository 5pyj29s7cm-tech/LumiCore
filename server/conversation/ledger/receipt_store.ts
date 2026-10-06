import crypto from "node:crypto";
import { buildToolExecutionEnvelope, toolRecordIdempotencyKey } from "../../tools/execution_envelope";
import type { ToolExecutionRecord } from "../../tools/types";
import type { ConversationActionTaskRow, ConversationActionReceiptRow } from './contracts';
import { ensureTables, parseObject, digest } from './serialization';

export function appendConversationActionReceipts(
  db: any,
  input: {
    task: ConversationActionTaskRow;
    records: ToolExecutionRecord[];
    turnId?: string;
    requestId?: string;
    turnRowId?: string;
    externalMessageId?: string;
    now?: string;
  },
): ConversationActionReceiptRow[] {
  ensureTables(db);
  const now = input.now || new Date().toISOString();
  const receipts = db.conversationActionReceipts as ConversationActionReceiptRow[];
  const appended: ConversationActionReceiptRow[] = [];
  input.records.forEach((rawRecord, index) => {
    const record: ToolExecutionRecord = {
      ...rawRecord,
      taskId: rawRecord.taskId || input.task.id,
      turnId: rawRecord.turnId || input.turnId,
      requestId: rawRecord.requestId || input.requestId,
      turnRowId: rawRecord.turnRowId || input.turnRowId,
      externalMessageId: rawRecord.externalMessageId || input.externalMessageId,
      idempotencyKey: rawRecord.idempotencyKey || toolRecordIdempotencyKey(rawRecord),
    };
    // Bind only to the exact persisted row in this task's ownership scope.
    // Legacy turnId values can be message/request/plan IDs and are never joined.
    const turns = (db.conversationActionTurns || []).filter((turn: any) => (
      record.taskId === input.task.id && turn.requestId === record.requestId && turn.taskId === input.task.id
      && turn.userId === input.task.userId && turn.conversationId === input.task.conversationId
      && (turn.domain || 'personal') === (input.task.domain || 'personal')
      && (turn.orgId || '') === (input.task.orgId || '')
    ));
    if (record.turnRowId && (turns.length !== 1 || turns[0].id !== record.turnRowId)) return;
    if (turns.length === 1) record.turnRowId = turns[0].id;
    const envelope = buildToolExecutionEnvelope(record, {
      taskId: input.task.id,
      turnId: input.turnId,
      requestId: input.requestId,
      completedAt: now,
    });
    const duplicate = receipts.find(candidate => (
      candidate.taskId === input.task.id
      && candidate.idempotencyKey === envelope.idempotencyKey
      && candidate.toolName === record.name
      && candidate.outcome === envelope.status
    ));
    if (duplicate) {
      const previous = parseObject(duplicate.envelope);
      // Legacy unknown placeholders occupied the same SQLite unique key as a
      // real failure. Reconcile only that exact request's nonterminal slot;
      // never rewrite an actual terminal or another request's receipt.
      const unresolvedPlaceholder = duplicate.outcome === 'failed'
        && duplicate.requestId === envelope.requestId
        && previous.requestId === envelope.requestId
        && previous.verification?.status === 'unverified'
        && previous.verification?.reason === 'tool_settlement_unknown'
        && envelope.verification.status === 'failed';
      if (!unresolvedPlaceholder) return;
    }
    const requestedReceiptId = String(record.id || `receipt_${crypto.randomUUID()}_${index}`);
    const receiptId = duplicate?.id || (receipts.some(candidate => candidate.id === requestedReceiptId)
      ? `receipt_${crypto.randomUUID()}_${index}`
      : requestedReceiptId);
    const row: ConversationActionReceiptRow = {
      id: receiptId,
      taskId: input.task.id,
      conversationId: input.task.conversationId,
      turnId: envelope.turnId,
      requestId: envelope.requestId,
      ...(envelope.turnRowId ? { turnRowId: envelope.turnRowId } : {}),
      ...(envelope.externalMessageId ? { externalMessageId: envelope.externalMessageId } : {}),
      ...(record.modelRoutingReceiptId
        ? { modelRoutingReceiptId: String(record.modelRoutingReceiptId).trim().slice(0, 180) }
        : {}),
      ...(record.executionOrigin ? { executionOrigin: record.executionOrigin } : {}),
      idempotencyKey: envelope.idempotencyKey,
      toolName: envelope.toolName,
      targetIdentity: envelope.targetIdentity,
      inputDigest: digest(record.arguments || {}),
      envelope: JSON.stringify(envelope),
      outcome: envelope.status,
      createdAt: now,
    };
    if (duplicate) Object.assign(duplicate, row);
    else receipts.push(row);
    appended.push(row);
  });
  return appended;
}
