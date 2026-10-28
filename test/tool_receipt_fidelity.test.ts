import './helpers';
import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, commitDatabaseTables, flushDBOrThrow, initDatabase, readDatabaseTables } from '../db_layer';
import { addMessageIdempotent, getMessages, getOrCreateActiveConversation, prepareConversationActionExecution } from '../server/conversation/manager';
import { hydrateConversationActionState } from '../server/conversation/action_state_hydration';
import { getConversationActionStateByTaskId } from '../server/conversation/ledger/queries';
import { sanitizeToolRecordsForPersistence } from '../server/cognition/user_output_protection';
import { recordsToTaskReceipts, normalizeConversationTaskReceipt, taskReceiptsToRecords } from '../server/cognition/task_execution_ledger';
import { buildToolExecutionEnvelope } from '../server/tools/execution_envelope';
import { formatToolRecordForModel } from '../server/llm/tool_loop/receipts';
import { toolRecordTerminalPayload } from '../server/tools/receipt_payload';
import type { ToolExecutionRecord } from '../server/tools/types';

function observation(name: string, result: string): ToolExecutionRecord {
  const record: ToolExecutionRecord = { id: name + '-call', name, arguments: {}, result, requestId: 'fidelity-request', taskId: 'fidelity-task', turnId: 'fidelity-request',
    terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Source observation returned.' } };
  record.envelope = buildToolExecutionEnvelope(record);
  return record;
}

describe('complete durable observation payloads', () => {
  beforeAll(async () => { await initDatabase(); });
  it.each(['sensor_inventory', 'camera_inventory'])('preserves all source fields and counters across persistence and task hydration for %s', name => {
    const payload = { source: name, observedAt: '2026-10-28T00:00:00Z', absent: null, count: 0,
      notes: 'Long ordinary source description. '.repeat(220),
      entries: Array.from({ length: 120 }, (_, id) => ({ id, nested: { data: { jobs: [{ id: id + 800, pagesPrinted: 0, totalPages: 7, state: null }] } } })),
      columns: Object.fromEntries(Array.from({ length: 100 }, (_, id) => ['field' + id, id])),
      deep: { one: { two: { three: { four: { five: { six: { seven: { sourceFact: 'deep observed fact', cookie: 'DEEP_SECRET' } } } } } } } },
      finalFact: 'Last observed source fact' };
    const expected = JSON.parse(JSON.stringify(payload).replace('DEEP_SECRET', '[redacted]'));
    const original = observation(name, JSON.stringify(payload));
    const persisted = sanitizeToolRecordsForPersistence([original])![0];
    expect(JSON.parse(persisted.result)).toEqual(expected);
    expect(persisted.envelope.result).toEqual(expected);
    expect(JSON.stringify(persisted)).not.toMatch(/structured_result_summary|nested value omitted|stored result truncated|DEEP_SECRET/);
    const receipt = recordsToTaskReceipts([persisted])[0];
    expect(JSON.parse(receipt.result)).toEqual(expected);
    expect(receipt.envelope?.result).toBeUndefined();
    expect(receipt.receipt).toBeUndefined();
    const normalized = normalizeConversationTaskReceipt(JSON.parse(JSON.stringify(receipt)))!;
    const restored = taskReceiptsToRecords([normalized])[0];
    expect(JSON.parse(restored.result!)).toEqual(expected);
    expect(toolRecordTerminalPayload(restored)).toEqual(expected);
    expect(restored).toMatchObject({ requestId: original.requestId, taskId: original.taskId, id: original.id });
    const model = formatToolRecordForModel(restored);
    expect(model).toContain('deep observed fact');
    expect(model).toContain('Last observed source fact');
    expect(model).toContain('"id":919');
    expect(model).toContain('"pagesPrinted":0');
    expect(sanitizeToolRecordsForPersistence([persisted])![0]).toEqual(persisted);
  });

  it('retains exact plain text and section boundaries for a non-document observation', () => {
    const text = 'First source section\n\n' + 'ordinary observation text \n'.repeat(300) + '\nMiddle fact: still unavailable\n\nLast fact: 0 jobs';
    const persisted = sanitizeToolRecordsForPersistence([observation('device_snapshot', text)])![0];
    expect(persisted.result).toBe(text);
    const receipt = recordsToTaskReceipts([persisted])[0];
    const restored = taskReceiptsToRecords([normalizeConversationTaskReceipt(JSON.parse(JSON.stringify(receipt)))!])[0];
    expect(restored.result).toBe(text);
    expect(formatToolRecordForModel(restored)).toContain(text);
  });

  it('keeps safe JSON serialization, shared values, secret redaction and binary omission', () => {
    const shared = { count: 0, token: 'PRIVATE_TOKEN' };
    const cyclic: any = { source: 'cycle-fixture', left: shared, right: shared, image_base64: 'A'.repeat(20000) };
    cyclic.self = cyclic;
    const record = observation('device_snapshot', '{}');
    record.receipt = cyclic;
    const stored = sanitizeToolRecordsForPersistence([record])![0];
    expect(() => JSON.stringify(stored)).not.toThrow();
    expect(stored.receipt.left).toEqual({ count: 0, token: '[redacted]' });
    expect(stored.receipt.right).toEqual(stored.receipt.left);
    expect(stored.receipt.self).toBe('[circular value omitted]');
    expect(JSON.stringify(stored)).not.toMatch(/AAAAA|PRIVATE_TOKEN/);
  });
  it('keeps one complete authoritative payload through database archive, reopen, task hydration and model continuation', async () => {
    const userId = 'observation-fidelity-' + crypto.randomUUID();
    const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
    const requestId = crypto.randomUUID();
    const common = { userId, conversationId, requestId, agentId: 'lumi', domain: 'personal' as const, orgId: '', source: 'chat', channel: 'chat' };
    const goal = 'Read the observed device sources and prepare a report.';
    const userMessageId = addMessageIdempotent({ ...common, role: 'user', content: goal, deferActionPreparation: true });
    const prepared = prepareConversationActionExecution({ ...common, userMessageId, userText: goal, forceTask: true,
      toolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 2 } });
    if ('bindingFailure' in prepared || !prepared.state?.taskId) throw Error('Observation fixture could not bind a task');
    const taskId = prepared.state.taskId;
    const originalBodies = [
      JSON.stringify({ source: 'sensor_snapshot', notes: 'ordinary observed data '.repeat(350),
        nodes: Array.from({ length: 95 }, (_, index) => ({ index, child: { job: { id: index + 1200, pagesPrinted: 0 } } })),
        deep: { a: { b: { c: { d: { e: { f: { observedFact: 'deep actual source fact', unavailable: null } } } } } } },
        lastFact: 'final snapshot fact' }),
      'Section one\n\n' + 'ordinary source text\n'.repeat(350) + '\nLast source fact: 0 jobs; endpoint not observed',
    ];
    const records = originalBodies.map((body, index) => {
      const record = { ...observation(index ? 'camera_snapshot' : 'sensor_snapshot', body), taskId, requestId, turnId: requestId, turnRowId: prepared.turnRowId };
      record.envelope = buildToolExecutionEnvelope(record);
      record.idempotencyKey = record.envelope.idempotencyKey;
      return record;
    });
    const sanitized = sanitizeToolRecordsForPersistence(records)!;
    const assistantMessageId = addMessageIdempotent({ ...common, role: 'assistant', content: 'Source observations returned; report remains pending.', toolCalls: sanitized });
    const receipts = recordsToTaskReceipts(sanitized);
    const tables = ['conversations', 'conversationActionTasks', 'conversationActionTurns', 'conversationActionReceipts', 'interactions'] as const;
    let db = readDatabaseTables(tables);
    const task = db.conversationActionTasks.find(row => row.id === taskId)!;
    task.status = 'blocked'; task.activeRequestId = '';
    task.context = JSON.stringify({ ...JSON.parse(task.context), actionState: { ...prepared.state, status: 'blocked', unfinished: true, activeRequestId: undefined, receipts } });
    delete db.conversations.find(row => row.id === conversationId)!.actionContinuationState;
    commitDatabaseTables(db);
    await flushDBOrThrow(); await closeDatabase(); await initDatabase();

    expect(getMessages(conversationId).find(row => row.id === assistantMessageId)!.toolCalls!.map(record => record.result)).toEqual(originalBodies);
    db = readDatabaseTables(tables);
    expect(db.conversationActionReceipts.filter(row => row.taskId === taskId)).toHaveLength(2);
    const state = hydrateConversationActionState(db, db.conversations.find(row => row.id === conversationId)!, '继续刚才的任务');
    expect(state?.taskId).toBe(taskId);
    const restored = taskReceiptsToRecords(state!.receipts);
    expect(restored.map(record => record.result)).toEqual(originalBodies);
    expect(restored.map(record => record.requestId)).toEqual([requestId, requestId]);
    expect(restored.map(record => record.taskId)).toEqual([taskId, taskId]);
    expect(toolRecordTerminalPayload(restored[0])).toEqual(JSON.parse(originalBodies[0]));
    expect(toolRecordTerminalPayload(restored[1])).toBe(originalBodies[1]);
    expect(state!.receipts.every(receipt => receipt.receipt === undefined && receipt.envelope?.result === undefined)).toBe(true);
    const model = restored.map(formatToolRecordForModel).join('\n');
    expect(model).toContain('deep actual source fact');
    expect(model).toContain('final snapshot fact');
    expect(model).toContain('Last source fact: 0 jobs; endpoint not observed');
    expect(model).toContain('"id":1294');
    expect(model).toContain('"pagesPrinted":0');
    expect(getConversationActionStateByTaskId(db, { conversationId, userId: 'another-user', taskId })).toBeNull();
  });

});
