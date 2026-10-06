import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import { getOrCreateActiveConversation, addMessageIdempotent, prepareConversationActionExecution } from '../server/conversation/manager';
import { appendConversationActionReceipts } from "../server/conversation/ledger/receipt_store";
import { buildToolExecutionEnvelope } from '../server/tools/execution_envelope';
import { inspectPersistedToolExecutionReceipt } from '../server/tools/persisted_execution_receipt';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';
import { recordsToTaskReceipts, taskReceiptsToRecords } from '../server/cognition/task_execution_ledger';
import type { ToolExecutionRecord } from '../server/tools/types';

beforeAll(() => initDatabase());
const policy = { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 2 };
let sequence = 0;
function fixture() {
  const userId = 'turn-row-user-' + ++sequence;
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
  const requestId = 'server-request-' + sequence;
  const common = { userId, conversationId, requestId, agentId: 'lumi' };
  const text = 'Create a report file';
  const userMessageId = addMessageIdempotent({ ...common, role: 'user', content: text, deferActionPreparation: true });
  const prepared = prepareConversationActionExecution({ ...common, userText: text, userMessageId, toolPolicy: policy, forceTask: true });
  if ('bindingFailure' in prepared || !prepared.state?.taskId || !prepared.turnRowId) throw Error('Turn was not admitted');
  const db = readDB();
  const task = db.conversationActionTasks.find((row: any) => row.id === prepared.state!.taskId);
  return { db, task, common, turnRowId: prepared.turnRowId, externalMessageId: 'transport-message-' + sequence };
}
const result = (overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord => ({
  id: 'exact-invocation', name: 'identity_fixture', arguments: {}, result: '{"ok":true}', ...overrides,
});

describe('explicit execution identities', () => {
  it('propagates independent IDs through a real canonical invocation and envelope', async () => {
    const f = fixture();
    const registry = new ToolRegistry();
    registry.register({ name: 'identity_fixture', description: 'Local identity probe', permission: 'public', securityLevel: 'safe',
      parameters: { type: 'object', properties: {}, required: [] }, handler: async () => '{"ok":true}' });
    const identity = { taskId: f.task.id, requestId: f.common.requestId, turnRowId: f.turnRowId,
      externalMessageId: f.externalMessageId, resolutionId: 'accepted-semantic-snapshot', turnId: 'legacy-transport-value' };
    const record = await executeToolCall({ registry, name: 'identity_fixture', arguments: {}, id: 'probe-call',
      context: { ...identity, userId: f.common.userId, localExecution: true, authRole: 'admin', currentTurnExecutionRequested: true } });
    expect(record.adapterStarted).toBe(true);
    expect(record).toMatchObject(identity);
    expect(record.envelope).toMatchObject(identity);
    expect(taskReceiptsToRecords(recordsToTaskReceipts([record]))[0]).toMatchObject(identity);
  });


  it('does not acquire a different request identity when a handler mutates its context', async () => {
    const registry = new ToolRegistry();
    const context = { userId: 'context-drift-user', taskId: 'accepted-task', localExecution: true, authRole: 'admin',
      currentTurnExecutionRequested: true, requestId: '', turnRowId: '' };
    registry.register({ name: 'identity_fixture', description: 'Local context drift probe', permission: 'public', securityLevel: 'safe',
      parameters: { type: 'object', properties: {}, required: [] }, handler: async () => {
        context.requestId = 'later-request'; context.turnRowId = 'later-turn-row'; return '{"ok":true}';
      } });
    const record = await executeToolCall({ registry, name: 'identity_fixture', arguments: {}, id: 'drift-call', context });
    expect(record.adapterStarted).toBe(true);
    expect(record.requestId).toBeUndefined();
    expect(record.envelope?.requestId).toBe('');
    expect(record.envelope?.turnRowId).toBeUndefined();
  });

  it('does not invent a request or durable turn row from an ambiguous legacy ID', () => {
    const envelope = buildToolExecutionEnvelope(result({ turnId: 'could-be-message-or-task' }));
    expect(envelope.requestId).toBe('');
    expect(envelope.turnRowId).toBeUndefined();
    expect(envelope.externalMessageId).toBeUndefined();
  });

  it('binds new archived evidence to the scoped row using its request, never legacy turnId', () => {
    const f = fixture();
    const [row] = appendConversationActionReceipts(f.db, { task: f.task,
      records: [result({ requestId: f.common.requestId, turnId: f.externalMessageId, externalMessageId: f.externalMessageId })] });
    expect(row).toMatchObject({ requestId: f.common.requestId, turnRowId: f.turnRowId, externalMessageId: f.externalMessageId });
    expect(JSON.parse(row.envelope)).toMatchObject({ turnRowId: f.turnRowId, externalMessageId: f.externalMessageId });
    expect(inspectPersistedToolExecutionReceipt(row, { turnRowId: f.turnRowId }).valid).toBe(true);
  });

  it('refuses a supplied foreign turn row even if other receipt fields claim the local owner', () => {
    const f = fixture(); const foreign = fixture();
    expect(appendConversationActionReceipts(f.db, { task: f.task,
      records: [result({ requestId: f.common.requestId, turnRowId: foreign.turnRowId })] })).toEqual([]);
    expect(f.db.conversationActionReceipts.some((row: any) => row.taskId === f.task.id)).toBe(false);
  });

  it.each(['turnRowId', 'externalMessageId'] as const)('rejects mismatched persisted %s fields before accepting evidence', field => {
    const f = fixture();
    const [row] = appendConversationActionReceipts(f.db, { task: f.task,
      records: [result({ requestId: f.common.requestId, turnId: 'legacy', externalMessageId: f.externalMessageId })] });
    const envelope = JSON.parse(row.envelope);
    const forged = { ...row, envelope: JSON.stringify({ ...envelope, [field]: 'foreign-identity' }) };
    expect(inspectPersistedToolExecutionReceipt(forged).valid).toBe(false);
    const hydrated = taskReceiptsToRecords(recordsToTaskReceipts([result({ ...envelope, name: row.toolName, result: '{"ok":true}',
      [field]: 'foreign-identity', envelope })]));
    expect((hydrated[0] as any).receiptScopeConflict).toBe(true);
  });

  it('keeps legacy rows readable without pretending their IDs have been migrated', () => {
    const record = result({ taskId: 'legacy-task', requestId: 'legacy-request', turnId: 'legacy-message' });
    const envelope = buildToolExecutionEnvelope(record);
    const row = { ...envelope, outcome: envelope.status, envelope: JSON.stringify(envelope) };
    expect(inspectPersistedToolExecutionReceipt(row).valid).toBe(true);
    expect(inspectPersistedToolExecutionReceipt(row, { turnRowId: 'invented-turn-row' }).valid).toBe(false);
  });
});
