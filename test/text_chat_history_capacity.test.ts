import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { commitDatabaseTables, initDatabase, readDatabaseTables } from '../db_layer';
import { compactRecordForPrompt, getMessagesByTokenBudget } from '../server/conversation/manager';
import { getMessagesThroughExternalMessage } from '../server/conversation/manager/message_history';
import { prepareChatModelTurn } from '../server/socket/chat/model_execution';

beforeAll(() => initDatabase());

function rowsFor(conversationId: string, records: any[]) {
  const start = Date.now() - records.length * 1000;
  return records.map((record, index) => ({ id: randomUUID(), userId: 'history-capacity-owner', conversationId,
    role: 'user', message: '', timestamp: new Date(start + index * 1000).toISOString(), ...record }));
}
function seed(records: any[]) {
  const db = readDatabaseTables(['interactions']);
  db.interactions.push(...records);
  commitDatabaseTables(db);
}
function context(conversationId: string, current: any): any {
  return { uid: 'history-capacity-owner', conversationId, requestId: current.requestId, acceptedUserMessageId: current.id,
    text: current.message, executionTaskText: current.message, eventSource: 'chat', effectiveSystemPrompt: 'Isolated history test',
    activeProvider: 'relay', activeModel: 'offline-selected-model', resolvedDomain: 'personal', resolvedOrgId: '',
    toolSessionActive: false, modelCapabilityPolicy: { maxIterations: 4 }, effectiveOperationMode: 'assistant',
    personality: { name: 'Lumi', id: 'lumi', toolPolicy: { maxIterations: 4 } }, abortController: new AbortController(),
    allToolRecords: [], actionTaskExecution: {}, desktopRelay: { getControlPauseReason: () => null },
    markTurnTiming: () => {}, emitToolLifecycle: () => {}, emitAgent: () => {}, formatToolResultForUi: (s: string) => s,
    formatMediaArtifactReceiptForUi: () => undefined, rememberRequestToolRecord: () => {},
    taskAwareRecords: (records: any[]) => records, isChatCancelled: () => false };
}

describe('text chat delegates history capacity to the selected model boundary', () => {
  it('keeps over 1000 earlier records and complete long middle text without including queued messages', async () => {
    const conversationId = 'wide-history-' + randomUUID();
    const longUser = 'old-user-start ' + '背景细节'.repeat(1600) + ' USER-MIDDLE-MUST-SURVIVE ' + '后半资料'.repeat(1600);
    const longAssistant = 'old-assistant-start ' + 'ordinary discussion '.repeat(500) + ' ASSISTANT-MIDDLE-MUST-SURVIVE ' + 'more context '.repeat(500) + 'assistant-end';
    const records = rowsFor(conversationId, [
      { message: longUser }, { role: 'assistant', message: longAssistant },
      ...Array.from({ length: 1004 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', message: 'ordinary historical turn ' + index })),
      { message: 'accepted current instruction', requestId: 'current-' + conversationId, externalMessageId: 'current-' + conversationId, source: 'chat', channel: 'chat' },
      { message: 'QUEUED-LATER-USER', requestId: 'later-' + conversationId, externalMessageId: 'later-' + conversationId },
      { role: 'assistant', message: 'QUEUED-LATER-ASSISTANT' },
    ]);
    seed(records);
    const current = records.at(-3)!;
    const prepared = await prepareChatModelTurn(context(conversationId, current));
    expect(prepared.messages).toContainEqual({ role: 'user', content: longUser });
    expect(prepared.messages).toContainEqual({ role: 'assistant', content: longAssistant });
    expect(prepared.messages.filter(message => message.content === current.message)).toHaveLength(1);
    expect(prepared.messages.filter(message => message.role !== 'system')).toHaveLength(1007);
    expect(JSON.stringify(prepared.messages)).not.toContain('QUEUED-LATER');
    expect(JSON.stringify(prepared.messages)).not.toContain('Prompt history compacted:');
  });

  it('cuts off by the accepted user row rather than a later duplicate external identity', async () => {
    const conversationId = 'exact-cutoff-' + randomUUID();
    const requestId = 'request-' + conversationId;
    const records = rowsFor(conversationId, [
      { message: 'earlier context' },
      { message: 'accepted text', requestId, externalMessageId: requestId, source: 'chat', channel: 'chat' },
      { message: 'DO-NOT-REPLAY-LATER', requestId: 'another-request', externalMessageId: requestId },
    ]);
    seed(records);
    const prepared = await prepareChatModelTurn(context(conversationId, records[1]));
    expect(prepared.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['earlier context', 'accepted text']);
  });

  it('does not expose queued server history when the accepted row cannot be resolved', async () => {
    const conversationId = 'missing-cutoff-' + randomUUID();
    seed(rowsFor(conversationId, [{ message: 'UNBOUND-QUEUED-HISTORY' }]));
    const current = { id: 'unresolved-id', requestId: 'unresolved-request', message: 'current instruction stays complete' };
    const prepared = await prepareChatModelTurn(context(conversationId, current));
    expect(prepared.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([current.message]);
  });

  it('keeps the bounded manager receipt and file-observation projections available to other callers', () => {
    const fileCall = { name: 'read_docx', arguments: { filePath: 'D:/fixtures/source.docx' }, result: 'Observed file facts: 6 people, budget 1200.', terminalVerification: { status: 'verified' } };
    const records: any[] = [
      { role: 'assistant', message: '已保存文件 D:/unobserved.docx。' + 'x'.repeat(9000), cognitiveIntent: 'execution_facts' },
      { role: 'assistant', message: 'No successful current-turn tool execution was recorded for that execution-status claim.', cognitiveIntent: 'work_product_guard' },
      { role: 'assistant', message: 'Unsupported prose says 99 people.', toolCalls: [fileCall] },
      { role: 'user', message: 'Read the source.', response: 'Unsupported prose says 99 people.', toolCalls: [fileCall] },
    ];
    for (const record of records) {
      const bounded = compactRecordForPrompt(record);
      const full = compactRecordForPrompt(record, { preserveText: true } as any);
      expect(full.toolReceiptLedger).toBe(bounded.toolReceiptLedger);
      expect(full.toolFileObservations).toBe(bounded.toolFileObservations);
      expect(full.toolCalls).toBeUndefined();
    }
  });

  it('leaves bounded defaults and finite through-request reads available to voice and messaging callers', () => {
    const conversationId = 'bounded-history-' + randomUUID();
    const records = rowsFor(conversationId, Array.from({ length: 20 }, (_, index) => ({ message: 'bounded-' + index + '普通背景'.repeat(1500), externalMessageId: 'bounded-request-' + index })));
    seed(records);
    const bounded = getMessagesByTokenBudget(conversationId, 6000, 4);
    expect(bounded.length).toBeLessThan(records.length);
    expect(bounded[0].message).toContain('Prompt history compacted:');
    expect(compactRecordForPrompt(records[0]).message).not.toBe(records[0].message);
    expect(compactRecordForPrompt(records[0], { preserveText: true } as any).message).toBe(records[0].message);
    expect(getMessagesThroughExternalMessage(conversationId, 'bounded-request-5', 3).map(record => record.id)).toEqual(records.slice(3, 6).map(record => record.id));
  });
});
