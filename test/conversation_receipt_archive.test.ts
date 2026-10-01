import { cloneDatabaseValue } from '../server/db/snapshot_changes';
import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, flushDBOrThrow, initDatabase, readDB, writeDB } from '../db_layer';
import { createConversationReceiptObserver } from '../server/conversation/execution_receipt_archive';
import { projectConversationReceiptHistory } from '../server/conversation/receipt_history';
import { getConversationExecutionFacts } from '../server/conversation/execution_facts';
import { addMessageIdempotent, getMessages, getOrCreateActiveConversation, prepareConversationActionExecution } from '../server/conversation/manager';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';
import { createVoiceExecutionReceiptCollector } from '../server/socket/voice_execution_receipts';

beforeAll(() => initDatabase());
const toolPolicy = { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 4 };
let sequence = 0;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function fixture() {
  const requestId = `archive-request-${++sequence}`;
  const userId = `archive-user-${sequence}`;
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
  const common = { userId, conversationId, agentId: 'lumi', domain: 'personal', orgId: '', requestId } as const;
  const target = path.join(String(process.env.LUMI_DATA_DIR), `${requestId}.txt`);
  const text = `Create the file ${target}`;
  const userMessageId = addMessageIdempotent({ ...common, role: 'user', content: text, deferActionPreparation: true });
  const prepared = prepareConversationActionExecution({ ...common, userMessageId, userText: text, forceTask: true, toolPolicy });
  if ('bindingFailure' in prepared || !prepared.state?.taskId) throw Error('Fixture could not bind task');
  const taskId = prepared.state.taskId;
  const owner = { ...common, taskId };
  let authorized = true;
  const observer = createConversationReceiptObserver(owner, () => authorized);
  const collector = createVoiceExecutionReceiptCollector(requestId);
  collector.bindTask(taskId);
  const started = deferred();
  const release = deferred();
  let fail = false;
  const registry = new ToolRegistry();
  registry.register({
    name: 'archive_fixture_write', description: 'Isolated late write', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: {}, required: [] },
    capability: { id: 'test.archive', family: 'test', lane: 'files', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_write', scope: 'isolated fixture', reversible: true }],
      verification: { strategy: 'artifact', required: true, requiredFields: [], requiredArtifacts: ['path'], successSignals: ['file exists'], limitations: [] } },
    handler: async () => {
      started.resolve(); await release.promise;
      if (fail) throw Error('The actual late write failed: fixture device unavailable.');
      fs.writeFileSync(target, 'late effect'); return JSON.stringify({ ok: true, path: target });
    },
  });
  const execute = () => executeToolCall({ registry, id: `${requestId}-call`, name: 'archive_fixture_write', arguments: {},
    context: { ...owner, turnId: requestId, source: 'chat', localExecution: true, authRole: 'admin', userConfirmed: true,
      onToolStart: collector.onToolStart, onToolFinished: collector.onToolFinished,
      onToolRecord: record => { collector.onToolRecord(record); observer.onToolRecord(record); } } });
  const cancel = () => addMessageIdempotent({ ...common, role: 'assistant', content: 'Cancelled; the started operation is still unverified.',
    toolCalls: collector.snapshot().records, terminalTaskDisposition: { outcome: 'cancelled', taskId, requestId, reason: 'user cancelled' } });
  return { owner, common, target, observer, collector, started, release, execute, cancel,
    revoke: () => { authorized = false; }, fail: () => { fail = true; } };
}

describe('shared conversation receipt archive', () => {
  it('retains a real late effect after cancellation, reconciles history and leaves a successor untouched', async () => {
    const f = fixture();
    const execution = f.execute();
    await f.started.promise;
    f.cancel();
    const db = readDB();
    const savedReply = db.interactions.find((row: any) => row.requestId === f.owner.requestId && row.role === 'assistant')!;
    const originalReply = JSON.stringify(savedReply);
    const nextRequestId = `${f.owner.requestId}-next`;
    const userMessageId = addMessageIdempotent({ ...f.common, requestId: nextRequestId, role: 'user', content: 'Open calculator', deferActionPreparation: true });
    prepareConversationActionExecution({ ...f.common, requestId: nextRequestId, userText: 'Open calculator', userMessageId, forceTask: true, toolPolicy });
    const tasksBefore = JSON.stringify(db.conversationActionTasks);
    const turnsBefore = JSON.stringify(db.conversationActionTurns);
    f.release.resolve();
    const record = await execution;
    f.observer.onToolRecord(record); // duplicate delivery must remain one receipt
    await flushDBOrThrow();
    expect(fs.readFileSync(f.target, 'utf8')).toBe('late effect');
    expect(JSON.stringify(db.conversationActionTasks)).toBe(tasksBefore);
    expect(JSON.stringify(db.conversationActionTurns)).toBe(turnsBefore);
    expect(JSON.stringify(savedReply)).toBe(originalReply);
    expect(db.conversationActionReceipts.filter((row: any) => row.taskId === f.owner.taskId && row.outcome === 'verified_success')).toHaveLength(1);
    const visibleReply = getMessages(f.owner.conversationId).find(row => row.id === savedReply.id)!;
    expect(visibleReply.toolCalls).toHaveLength(1);
    expect(visibleReply.toolCalls![0]).toMatchObject({ requestId: f.owner.requestId, terminalVerification: { status: 'verified' } });
    const facts = getConversationExecutionFacts({ ...f.owner, currentRequestId: nextRequestId });
    expect(facts.priorTurnToolCalls).toHaveLength(1);
    expect(facts.priorTurnToolCalls![0]).toMatchObject({ name: 'archive_fixture_write', error: false, terminalVerification: { status: 'verified' } });
  });

  it('archives an on-time substep without completing the live task', async () => {
    const f = fixture();
    const before = JSON.stringify(readDB().conversationActionTasks);
    f.release.resolve();
    await f.execute();
    await flushDBOrThrow();
    expect(JSON.stringify(readDB().conversationActionTasks)).toBe(before);
    expect(readDB().conversationActionReceipts.some((row: any) => row.taskId === f.owner.taskId)).toBe(true);
  });

  it('does not deduplicate an actual late failure against a legacy failed-but-unverified placeholder', async () => {
    const f = fixture();
    f.fail();
    const execution = f.execute();
    await f.started.promise;
    f.cancel();
    const db = readDB();
    const placeholder = db.conversationActionReceipts.find((row: any) => row.taskId === f.owner.taskId)!;
    placeholder.outcome = 'failed';
    placeholder.envelope = JSON.stringify({ ...JSON.parse(placeholder.envelope), status: 'failed' });
    writeDB(db);
    f.release.resolve();
    await execution;
    await flushDBOrThrow();
    const reply = getMessages(f.owner.conversationId).find(row => row.role === 'assistant' && row.requestId === f.owner.requestId)!;
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls![0]).toMatchObject({ error: expect.stringContaining('fixture device unavailable'), terminalVerification: { status: 'failed' } });
    expect(fs.existsSync(f.target)).toBe(false);
    expect(db.conversationActionTasks.find((row: any) => row.id === f.owner.taskId)?.status).toBe('cancelled');
  });

  it('rejects foreign, fabricated and revoked receipts', async () => {
    const first = fixture();
    const foreign = fixture();
    foreign.release.resolve();
    const record = await foreign.execute();
    first.observer.onToolRecord(record);
    first.observer.onToolRecord({ ...record, taskId: first.owner.taskId, requestId: first.owner.requestId });
    first.revoke();
    first.release.resolve();
    await first.execute();
    await flushDBOrThrow();
    expect(readDB().conversationActionReceipts.filter((row: any) => row.taskId === first.owner.taskId)).toEqual([]);
  });

  it('keeps late native substeps unverified and redacts sensitive result data', async () => {
    const f = fixture();
    f.cancel();
    await f.observer.onDesktopLateResult({ correlationId: 'late-native-fixture', name: 'desktop_open', arguments: { target: 'calculator' },
      result: JSON.stringify({ ok: true, apiKey: 'private-native-fixture-secret' }) });
    const receipt = readDB().conversationActionReceipts.find((row: any) => row.id === 'late-native-fixture')!;
    expect(receipt.outcome).toBe('unknown_outcome');
    expect(receipt.envelope).not.toContain('private-native-fixture-secret');
    expect(JSON.parse(receipt.envelope).verification.status).toBe('unverified');
    const task = readDB().conversationActionTasks.find((row: any) => row.id === f.owner.taskId)!;
    expect(task.status).toBe('cancelled');
  });

  it('does not project archive evidence across scopes or accept a mismatched persisted envelope', async () => {
    const f = fixture();
    f.release.resolve();
    await f.execute();
    f.cancel();
    const db = cloneDatabaseValue(readDB());
    const reply = db.interactions.find((row: any) => row.requestId === f.owner.requestId && row.role === 'assistant')!;
    const emptyReply = { ...reply, toolCalls: [] };
    for (const change of [{ userId: 'foreign' }, { domain: 'work', orgId: 'foreign' }, { requestId: 'other' }]) {
      expect(projectConversationReceiptHistory(db, [{ ...emptyReply, ...change }])[0].toolCalls).toEqual([]);
    }
    for (const row of db.conversationActionReceipts.filter((row: any) => row.taskId === f.owner.taskId)) {
      const envelope = JSON.parse(row.envelope);
      row.envelope = JSON.stringify({ ...envelope, requestId: 'forged-request' });
    }
    expect(projectConversationReceiptHistory(db, [emptyReply])[0].toolCalls).toEqual([]);
  });

  it('preserves late evidence and the cancelled disposition through a database restart', async () => {
    const f = fixture();
    const execution = f.execute();
    await f.started.promise;
    f.cancel();
    f.release.resolve();
    await execution;
    await flushDBOrThrow();
    await closeDatabase();
    await initDatabase();
    expect(readDB().conversationActionTasks.find((row: any) => row.id === f.owner.taskId)?.status).toBe('cancelled');
    const reply = getMessages(f.owner.conversationId).find(row => row.role === 'assistant' && row.requestId === f.owner.requestId)!;
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls![0]).toMatchObject({ taskId: f.owner.taskId, terminalVerification: { status: 'verified' } });
  });
});
