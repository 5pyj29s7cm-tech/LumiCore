import './helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sqlite3 from 'sqlite3';
import { flushDB, initDatabase, readDB, writeDB } from '../db_layer';
import { getDataPath } from '../server/config/data_path';
import { addMessage, getOrCreateActiveConversation, setConversationSummary } from '../server/conversation/manager';

function readIndexNames(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(getDataPath('lumi.db'));
    database.all(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name`,
      (error, rows: Array<{ name: string }>) => {
        database.close();
        if (error) reject(error);
        else resolve(rows.map(row => row.name));
      },
    );
  });
}

function readInteractionColumns(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(getDataPath('lumi.db'));
    database.all(
      'PRAGMA table_info(interactions)',
      (error, rows: Array<{ name: string }>) => {
        database.close();
        if (error) reject(error);
        else resolve(rows.map(row => row.name));
      },
    );
  });
}

function readConversationColumns(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(getDataPath('lumi.db'));
    database.all(
      'PRAGMA table_info(conversations)',
      (error, rows: Array<{ name: string }>) => {
        database.close();
        if (error) reject(error);
        else resolve(rows.map(row => row.name));
      },
    );
  });
}

function readActionTaskColumns(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(getDataPath('lumi.db'));
    database.all(
      'PRAGMA table_info(conversation_action_tasks)',
      (error, rows: Array<{ name: string }>) => {
        database.close();
        if (error) reject(error);
        else resolve(rows.map(row => row.name));
      },
    );
  });
}

function readActionLedgerRows(conversationId: string): Promise<{ taskCount: number; receiptCount: number }> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(getDataPath('lumi.db'));
    database.get(
      `SELECT
        (SELECT COUNT(*) FROM conversation_action_tasks WHERE conversationId = ?) AS taskCount,
        (SELECT COUNT(*) FROM conversation_action_receipts WHERE conversationId = ?) AS receiptCount`,
      [conversationId, conversationId],
      (error, row: { taskCount: number; receiptCount: number }) => {
        database.close();
        if (error) reject(error);
        else resolve(row);
      },
    );
  });
}

function readConversationSummaryState(conversationId: string): Promise<{
  summaryChain: string;
  lastSummaryMessageCount: number;
  actionContinuationState: string;
}> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(getDataPath('lumi.db'));
    database.get(
      'SELECT summaryChain, lastSummaryMessageCount, actionContinuationState FROM conversations WHERE id = ?',
      [conversationId],
      (error, row: { summaryChain: string; lastSummaryMessageCount: number; actionContinuationState: string }) => {
        database.close();
        if (error) reject(error);
        else resolve(row);
      },
    );
  });
}

describe('SQLite persistence indexes', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterAll(async () => {
    await flushDB();
  });

  it('recreates performance indexes after an atomic full snapshot write', async () => {
    const db = readDB();
    if (!db.settings) db.settings = [];
    db.settings.push({ key: `index-test-${Date.now()}`, value: '1' });
    writeDB(db);
    await flushDB();

    const indexes = await readIndexNames();
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_interactions_user_conv',
      'idx_memories_user_type_tier',
      'idx_org_memberships_user_status',
      'idx_org_kb_articles_org_category',
      'idx_action_tasks_conversation_updated',
      'idx_action_receipts_idempotency',
    ]));
  });

  it('persists external message correlation fields across atomic snapshot writes', async () => {
    const columns = await readInteractionColumns();
    expect(columns).toEqual(expect.arrayContaining([
      'externalMessageId',
      'routeSequence',
      'receivedAt',
    ]));
  });

  it('persists conversation summary cadence and chain fields across atomic snapshot writes', async () => {
    const columns = await readConversationColumns();
    expect(columns).toEqual(expect.arrayContaining([
      'summaryChain',
      'lastSummaryMessageCount',
      'actionContinuationState',
    ]));

    const conversation = getOrCreateActiveConversation(
      `summary-persistence-${Date.now()}-${Math.random()}`,
      'lumi',
      'personal',
      '',
    );
    setConversationSummary(conversation.id, 'first persisted summary');
    setConversationSummary(conversation.id, 'second persisted summary');
    await flushDB();

    const persisted = await readConversationSummaryState(conversation.id);
    expect(JSON.parse(persisted.summaryChain)).toEqual(['first persisted summary']);
    expect(persisted.lastSummaryMessageCount).toBe(0);
  });

  it('persists the durable task identity and terminal receipts across an atomic snapshot write', async () => {
    expect(await readActionTaskColumns()).toEqual(expect.arrayContaining([
      'parentTaskId',
      'activeRequestId',
      'completionSource',
      'context',
    ]));
    const userId = `action-continuation-persistence-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '打开 WPS。',
      domain: 'personal',
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '已打开 WPS。',
      toolCalls: [{
        name: 'desktop_open',
        arguments: { target: 'WPS' },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target: 'WPS',
          targetMatched: true,
          actualTarget: { processName: 'wps.exe', title: 'WPS Writer' },
        }),
      }],
      domain: 'personal',
    });
    await flushDB();

    const persisted = await readConversationSummaryState(conversation.id);
    expect(JSON.parse(persisted.actionContinuationState)).toMatchObject({
      version: 2,
      goal: '打开 WPS。',
      appTarget: 'WPS',
      status: 'completed',
      unfinished: false,
      evidenceTools: ['desktop_open'],
      receipts: [{ name: 'desktop_open', outcome: 'success' }],
    });
    expect(JSON.parse(persisted.actionContinuationState).taskId).toMatch(/^task_/);
    expect(await readActionLedgerRows(conversation.id)).toMatchObject({
      taskCount: 1,
      receiptCount: 1,
    });
  });
});
