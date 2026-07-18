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

  it('persists only evidence-backed action continuation state across an atomic snapshot write', async () => {
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
        result: JSON.stringify({ ok: true, status: 'opened', target: 'WPS' }),
      }],
      domain: 'personal',
    });
    await flushDB();

    const persisted = await readConversationSummaryState(conversation.id);
    expect(JSON.parse(persisted.actionContinuationState)).toMatchObject({
      version: 1,
      goal: '打开 WPS。',
      appTarget: 'WPS',
      evidenceTools: ['desktop_open'],
    });
  });
});
