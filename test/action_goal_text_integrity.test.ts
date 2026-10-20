import './helpers';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, flushDBOrThrow, initDatabase, readDB } from '../db_layer';
import { addMessageIdempotent, getOrCreateActiveConversation, prepareConversationActionExecution } from '../server/conversation/manager';
import { getConversationActionStateFromLedger } from '../server/conversation/ledger/queries';

beforeAll(() => initDatabase());

describe('authoritative action goal text', () => {
  it('preserves an exact multiline literal through prepare, durable task storage and database reload', async () => {
    const suffix = randomUUID();
    const userId = 'goal-literal-' + suffix;
    const requestId = 'goal-literal-request-' + suffix;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const literal = '甲：I am not complete.\r\n乙：这是一段  虚构对白。';
    const text = '在 C:/isolated/literal.txt 新建文本文件，只写入“' + literal + '”，写完回读并告诉我全文。';
    const userMessageId = addMessageIdempotent({ userId, conversationId: conversation.id, agentId: 'lumi',
      role: 'user', content: text, requestId, domain: 'personal', deferActionPreparation: true });
    const prepared = prepareConversationActionExecution({ userId, conversationId: conversation.id, userText: text,
      requestId, userMessageId, forceTask: true,
      toolPolicy: { allowedTools: ['write_file', 'read_file'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 } });
    expect(prepared.state?.goal).toBe(text);
    expect(prepared.state?.latestInstruction).toBe(text);
    const taskId = prepared.state?.taskId;
    expect(taskId).toBeTruthy();
    expect(readDB().conversationActionTasks.find((row: any) => row.id === taskId)?.goal).toBe(text);
    await flushDBOrThrow();
    await closeDatabase();
    await initDatabase();
    const db = readDB();
    const row = db.conversationActionTasks.find((item: any) => item.id === taskId);
    expect(row?.goal).toBe(text);
    const source = db.interactions.find((item: any) => item.id === userMessageId);
    expect(source?.role).toBe('user');
    expect(String(source?.message || source?.content || '')).toBe(text);
    const restored = getConversationActionStateFromLedger(db, { userId, conversationId: conversation.id });
    expect(restored?.taskId).toBe(taskId);
    expect(restored?.goal).toBe(text);
    expect(restored?.latestInstruction).toBe(text);
    expect(restored?.goal).toContain(literal);
  });

  it('preserves the full authoritative request beyond700 with a tail target, CRLF and double spaces across actual database reload', async () => {
    const suffix = randomUUID(), userId = 'long-goal-' + suffix, requestId = 'long-request-' + suffix;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const tailTarget = 'C:/isolated/after-700-target.txt';
    const literal = 'First  line.\r\nSecond  line.';
    const text = 'Create a text report using all the following unverified facts.\r\n' + 'Fact  still unverified.\r\n'.repeat(60)
      + 'Save the report to "' + tailTarget + '" containing "' + literal + '" and read it back completely.';
    expect(text.indexOf(tailTarget)).toBeGreaterThan(700);
    const userMessageId = addMessageIdempotent({ userId, conversationId: conversation.id, agentId: 'lumi', role: 'user', content: text, requestId, domain: 'personal', deferActionPreparation: true });
    const prepared = prepareConversationActionExecution({ userId, conversationId: conversation.id, userText: text, requestId, userMessageId, forceTask: true,
      toolPolicy: { allowedTools: ['write_file', 'read_file'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 } });
    const taskId = prepared.state?.taskId, preparedGoal = prepared.state?.goal, preparedInstruction = prepared.state?.latestInstruction;
    const storedGoal = readDB().conversationActionTasks.find((row: any) => row.id === taskId)?.goal;
    await flushDBOrThrow(); await closeDatabase(); await initDatabase();
    const db = readDB(), row = db.conversationActionTasks.find((row: any) => row.id === taskId);
    const source = db.interactions.find((row: any) => row.id === userMessageId);
    const restored = getConversationActionStateFromLedger(db, { userId, conversationId: conversation.id });
    if (process.env.PROBE_EVIDENCE_DIR) {
      const observed = (value: unknown) => ({ length: String(value || '').length, sha256: createHash('sha256').update(String(value || '')).digest('hex'), tailPresent: String(value || '').includes(tailTarget), literalPresent: String(value || '').includes(literal), crlfPresent: String(value || '').includes('\r\n'), doubleSpacePresent: String(value || '').includes('  ') });
      fs.writeFileSync(path.join(process.env.PROBE_EVIDENCE_DIR, 'long-authority-observation.json'), JSON.stringify({ expected: observed(text), tailIndex: text.indexOf(tailTarget), preparedGoal: observed(preparedGoal), preparedInstruction: observed(preparedInstruction), storedGoal: observed(storedGoal), reloadedRowGoal: observed(row?.goal), restoredGoal: observed(restored?.goal), restoredInstruction: observed(restored?.latestInstruction), originalUser: observed(source?.message || source?.content || '') }, null, 2));
    }
    expect(taskId).toBeTruthy();
    expect.soft(preparedGoal).toBe(text); expect.soft(preparedInstruction).toBe(text); expect.soft(storedGoal).toBe(text);
    expect.soft(row?.goal).toBe(text); expect.soft(restored?.goal).toBe(text); expect.soft(restored?.latestInstruction).toBe(text);
    expect(source?.role).toBe('user'); expect(String(source?.message || source?.content || '')).toBe(text);
    expect.soft(restored?.goal).toContain(tailTarget); expect.soft(restored?.goal).toContain(literal);
  });
});
