import './helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sqlite3 from 'sqlite3';
import {
  closeDatabase,
  flushDB,
  getDatabasePersistenceStatus,
  initDatabase,
  readDB,
  writeDB,
} from '../db_layer';
import { getDataPath } from '../server/config/data_path';
import { addMessage, getOrCreateActiveConversation, setConversationSummary } from '../server/conversation/manager';
import { ToolRegistry, resetExternalCommitRuntimeCacheForTests } from '../server/tools/registry';

// A separate connection verifies committed disk state, not the writer's transaction.
function readPersistedRows<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(getDataPath('lumi.db'));
    database.all(sql, params, (error, rows: T[]) => {
      database.close(closeError => {
        if (error || closeError) reject(error || closeError);
        else resolve(rows);
      });
    });
  });
}

async function readIndexNames(): Promise<string[]> {
  return (await readPersistedRows("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name"))
    .map(row => row.name);
}

async function readColumnNames(table: string): Promise<string[]> {
  return (await readPersistedRows(`PRAGMA table_info(${table})`)).map(row => row.name);
}

async function readActionLedgerRows(conversationId: string) {
  return (await readPersistedRows(
    `SELECT
        (SELECT COUNT(*) FROM conversation_action_tasks WHERE conversationId = ?) AS taskCount,
        (SELECT COUNT(*) FROM conversation_action_receipts WHERE conversationId = ?) AS receiptCount,
        t.id AS taskId,
        t.status,
        t.context,
        (SELECT outcome FROM conversation_action_receipts WHERE taskId = t.id ORDER BY createdAt DESC LIMIT 1) AS receiptOutcome
       FROM conversation_action_tasks t
       WHERE t.conversationId = ?
       ORDER BY t.updatedAt DESC
       LIMIT 1`,
    [conversationId, conversationId, conversationId],
  ))[0];
}

async function readConversationSummaryState(conversationId: string) {
  return (await readPersistedRows(
    'SELECT summaryChain, lastSummaryMessageCount, actionContinuationState FROM conversations WHERE id = ?',
    [conversationId],
  ))[0];
}

describe('SQLite persistence indexes', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterAll(async () => {
    await flushDB();
  });

  it('persists only changed tables while preserving performance indexes', async () => {
    const db = readDB();
    if (!db.settings) db.settings = [];
    db.settings.push({ key: `index-test-${Date.now()}`, value: '1' });
    writeDB(db);
    await flushDB();

    expect(getDatabasePersistenceStatus().lastFlushTables).toEqual(['settings']);

    writeDB(db);
    await flushDB();
    expect(getDatabasePersistenceStatus().lastFlushTables).toEqual([]);

    const indexes = await readIndexNames();
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_interactions_user_conv',
      'idx_memories_user_type_tier',
      'idx_org_memberships_user_status',
      'idx_org_kb_articles_org_category',
      'idx_action_tasks_conversation_updated',
      'idx_action_receipts_idempotency',
      'idx_autonomous_tasks_user_status',
      'idx_external_commit_journal_task',
      'idx_external_ai_history_sources_user_status',
      'idx_external_ai_history_jobs_source_status',
      'idx_external_ai_history_conversations_identity',
      'idx_external_ai_history_messages_identity',
      'idx_external_ai_history_attachments_identity',
      'idx_extension_revisions_identity',
      'idx_extension_revisions_active',
      'idx_extension_publishers_status',
      'idx_extension_receipts_extension_created',
    ]));
  });

  it('keeps legacy founder timestamps stable across unrelated flushes', async () => {
    const db = readDB(), before = db.founderVision, beforeTime = db.founderVisionUpdatedAt, avatars = [...db.memoryAvatars];
    try {
      db.founderVision = 'Synthetic durable founder text'; db.founderVisionUpdatedAt = '';
      db.memoryAvatars.push({ id: 'legacy-time-avatar', userId: 'legacy-time-user', name: 'Legacy avatar' });
      writeDB(db); await flushDB();
      const rows = await readPersistedRows('SELECT content,updatedAt FROM founder_vision');
      expect(rows).toEqual([{ content: db.founderVision, updatedAt: new Date(0).toISOString() }]);
      expect(await readPersistedRows("SELECT createdAt,updatedAt FROM memory_avatars WHERE id='legacy-time-avatar'")).toEqual([{ createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]);
      writeDB(db); await flushDB();
      expect(getDatabasePersistenceStatus().lastFlushTables).toEqual([]);
      expect(await readPersistedRows('SELECT content,updatedAt FROM founder_vision')).toEqual(rows);
    } finally { db.founderVision = before; db.founderVisionUpdatedAt = beforeTime; db.memoryAvatars = avatars; writeDB(db); await flushDB(); }
  });

  it('creates the write-ahead journal required for external-commit restart safety', async () => {
    expect(await readColumnNames('external_commit_journal')).toEqual(expect.arrayContaining([
      'idempotencyKey',
      'taskId',
      'userId',
      'toolName',
      'inputDigest',
      'state',
      'replayResult',
      'claimToken',
      'createdAt',
      'updatedAt',
    ]));
  });

  it('persists external message correlation fields across atomic snapshot writes', async () => {
    const columns = await readColumnNames('interactions');
    expect(columns).toEqual(expect.arrayContaining([
      'externalMessageId',
      'routeSequence',
      'receivedAt',
    ]));
  });

  it('persists conversation summary cadence and chain fields across atomic snapshot writes', async () => {
    const columns = await readColumnNames('conversations');
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

  it('persists task identity and receipts only in the durable ledger across an atomic snapshot write', async () => {
    expect(await readColumnNames('conversation_action_tasks')).toEqual(expect.arrayContaining([
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
    expect(JSON.parse(persisted.actionContinuationState)).toEqual({});
    const ledger = await readActionLedgerRows(conversation.id);
    expect(ledger).toMatchObject({
      taskCount: 1,
      receiptCount: 1,
      status: 'completed',
      receiptOutcome: 'verified_success',
    });
    expect(ledger.taskId).toMatch(/^task_/);
    expect(JSON.parse(ledger.context).actionState).toMatchObject({
      version: 2,
      goal: '打开 WPS。',
      appTarget: 'WPS',
      status: 'completed',
      unfinished: false,
      evidenceTools: ['desktop_open'],
      receipts: [{ name: 'desktop_open', outcome: 'success' }],
    });
  });

  it('deduplicates an external commit after closing and reopening SQLite', async () => {
    const toolName = `restart_safe_commit_${Date.now()}`;
    const idempotencyKey = `restart-safe-key-${Date.now()}-${Math.random()}`;
    const calls: string[] = [];
    const register = (registry: ToolRegistry) => registry.register({
      name: toolName,
      description: 'Restart-safe external commit test tool.',
      parameters: { type: 'object', properties: {} },
      permission: 'user',
      securityLevel: 'confirm',
      capability: {
        lane: 'messaging',
        operation: 'mutate',
        risk: 'high',
        sideEffects: [{ type: 'external_communication', scope: 'recipient', reversible: false }],
        verification: {
          strategy: 'provider_ack',
          required: true,
          requiredFields: ['sent', 'verificationStatus'],
          successSignals: ['provider receipt'],
          limitations: [],
        },
      },
      handler: async () => {
        calls.push('sent');
        return JSON.stringify({
          sent: true,
          verificationStatus: 'verified',
          providerReceipt: 'sqlite-restart-receipt',
          message: 'must not be persisted in replay evidence',
        });
      },
    });
    const args = { target: 'SQLite Restart Recipient', payload: 'Send exactly once' };
    const context = {
      userId: 'sqlite-restart-user',
      taskId: 'sqlite-restart-task',
      userConfirmed: true,
      idempotencyKey,
    };

    const firstRegistry = new ToolRegistry();
    register(firstRegistry);
    await expect(firstRegistry.execute(toolName, args, context)).resolves.toContain('sqlite-restart-receipt');
    await closeDatabase();
    resetExternalCommitRuntimeCacheForTests();
    await initDatabase();

    const restartedRegistry = new ToolRegistry();
    register(restartedRegistry);
    const replay = await restartedRegistry.execute(toolName, args, context);
    expect(calls).toEqual(['sent']);
    expect(JSON.parse(replay)).toMatchObject({
      providerReceipt: 'sqlite-restart-receipt',
      verificationStatus: 'verified',
      deduplicated: true,
    });
    expect(replay).not.toContain('must not be persisted in replay evidence');
  });
});
