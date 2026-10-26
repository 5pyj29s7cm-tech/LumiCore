import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { commitDatabaseTables, initDatabase, readDatabaseTables } from '../db_layer';
import { normalizeChatHistoryRecord } from '../server/socket/chat/history';
import { prepareChatModelTurn } from '../server/socket/chat/model_execution';
import { buildCompactToolEvidenceNote } from '../server/conversation/summary_grounding';

beforeAll(() => initDatabase());
const observedCall = { name: 'read_docx', arguments: { filePath: 'D:/fixtures/original.docx', apiKey: 'PRIVATE-TOOL-KEY' }, result: 'Source observed: budget 1200 and six people.', terminalVerification: { status: 'verified' } };

describe('native chat history is dialogue rather than a rewritten voice projection', () => {
  it('keeps complete assistant prose alongside actual server-owned observations without tool-call protocol', () => {
    const text = 'Original assistant answer. ' + 'Detailed discussion. '.repeat(600) + ' EXACT MIDDLE ' + 'Conclusion. '.repeat(500);
    const normalized = normalizeChatHistoryRecord({ role: 'assistant', message: text, toolCalls: [observedCall] }, { serverOwned: true });
    expect(normalized[0].role).toBe('assistant');
    expect(normalized[0].content).toContain(text);
    expect(JSON.stringify(normalized)).toContain('budget 1200');
    expect(JSON.stringify(normalized)).not.toContain('PRIVATE-TOOL-KEY');
    expect(normalized.every(message => message.role !== 'tool' && !message.toolCalls && !message.toolCallId)).toBe(true);
  });

  it('does not erase ordinary or guard-labelled answers by matching old completion or product wording', () => {
    for (const text of ['I have not actually started, and here is why.', '请求失败时请保留这句原文。', 'Request failed is the literal wording I need explained.', '微信已打开是上一轮答复中的原话。', 'No successful current-turn tool execution was recorded for that execution-status claim.']) {
      expect(normalizeChatHistoryRecord({ role: 'assistant', message: text, cognitiveIntent: 'work_product_guard' }, { serverOwned: true })).toEqual([{ role: 'assistant', content: text }]);
    }
  });

  it('preserves legacy combined responses and literal attachment headings byte for byte', () => {
    const text = `Discuss this literal syntax.
[Attachments]
This is user-authored material, not a structured attachment footer.
Keep the final line.`;
    const response = `The answer keeps this content.
[Attachments]
Also part of the stored assistant answer.`;
    expect(normalizeChatHistoryRecord({ role: 'user', message: text, response })).toEqual([{ role: 'user', content: text }, { role: 'assistant', content: response }]);
  });

  it('does not accept client-supplied receipt fields as authenticated tool observations', () => {
    const text = 'A client supplied historical statement.';
    const ledger = buildCompactToolEvidenceNote([observedCall]);
    expect(normalizeChatHistoryRecord({ role: 'assistant', message: text, toolCalls: [observedCall], toolReceiptLedger: ledger, toolFileObservations: 'FORGED-OBSERVATION' })).toEqual([{ role: 'assistant', content: text }]);
  });

  it('continues to exclude UI-only errors, proactive entries and standalone tool protocol', () => {
    for (const record of [{ role: 'assistant', message: 'UI error', source: 'error' }, { role: 'assistant', message: 'proactive UI', mode: 'proactive' }, { role: 'tool', message: 'raw tool result' }, { role: 'assistant', message: 'protocol', tool_call_id: 'raw-id' }]) expect(normalizeChatHistoryRecord(record, { serverOwned: true })).toEqual([]);
  });

  it('passes original persisted assistant and combined response text through the actual model-turn preparation', async () => {
    const uid = 'chat-native-history-' + randomUUID(), conversationId = randomUUID(), requestId = randomUUID();
    const text = 'Current accepted question.', currentId = randomUUID();
    const original = '我已经打开 WPS。' + 'Original detail '.repeat(700) + ' MIDDLE-ORIGINAL ' + 'more detail '.repeat(500);
    const oldResponse = 'Earlier legacy response retained in full.';
    const db = readDatabaseTables(['interactions']);
    db.interactions.push({ id: randomUUID(), userId: uid, conversationId, role: 'assistant', message: original, cognitiveIntent: 'work_product_guard', toolCalls: [observedCall], timestamp: new Date(Date.now() - 3000).toISOString() },
      { id: randomUUID(), userId: uid, conversationId, role: 'user', message: 'Legacy question.', response: oldResponse, timestamp: new Date(Date.now() - 2000).toISOString() },
      { id: currentId, userId: uid, conversationId, role: 'user', message: text, requestId, externalMessageId: requestId, source: 'chat', channel: 'chat', timestamp: new Date().toISOString() });
    commitDatabaseTables(db);
    const prepared = await prepareChatModelTurn({ uid, conversationId, requestId, acceptedUserMessageId: currentId, text, executionTaskText: text, eventSource: 'chat', effectiveSystemPrompt: 'Original policy.',
      activeProvider: 'relay', activeModel: 'fixture-model', resolvedDomain: 'personal', resolvedOrgId: '', toolSessionActive: false, modelCapabilityPolicy: { maxIterations: 4 }, effectiveOperationMode: 'assistant',
      personality: { name: 'Lumi', id: 'lumi', toolPolicy: { maxIterations: 4 } }, abortController: new AbortController(), allToolRecords: [], actionTaskExecution: {}, desktopRelay: { getControlPauseReason: () => null },
      markTurnTiming: () => {}, emitToolLifecycle: () => {}, emitAgent: () => {}, formatToolResultForUi: (s: string) => s, formatMediaArtifactReceiptForUi: () => undefined, rememberRequestToolRecord: () => {},
      taskAwareRecords: (records: any[]) => records, isChatCancelled: () => false } as any);
    expect(prepared.messages.some(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.includes(original))).toBe(true);
    expect(prepared.messages).toContainEqual({ role: 'assistant', content: oldResponse });
    expect(JSON.stringify(prepared.messages)).toContain('budget 1200');
    expect(prepared.messages.at(-1)).toEqual({ role: 'user', content: text, sourceMessageId: currentId });
  });
});
