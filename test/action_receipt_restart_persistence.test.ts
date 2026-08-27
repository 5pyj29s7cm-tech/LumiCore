import './helpers';
import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import sqlite3 from 'sqlite3';

import {
  closeDatabase,
  flushDB,
  initDatabase,
  readDB,
  writeDB,
} from '../db_layer';
import { getDataPath } from '../server/config/data_path';

function withSqlite<T>(
  operation: (database: sqlite3.Database, done: (error: Error | null, value?: T) => void) => void,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(getDataPath('lumi.db'));
    const done = (error: Error | null, value?: T) => {
      database.close(closeError => {
        if (error || closeError) reject(error || closeError);
        else resolve(value);
      });
    };
    operation(database, done);
  });
}

function createLegacyReceiptTable(): Promise<void> {
  return withSqlite<void>((database, done) => {
    database.serialize(() => {
      database.run(`CREATE TABLE conversation_action_receipts (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        conversationId TEXT NOT NULL,
        turnId TEXT DEFAULT '',
        requestId TEXT DEFAULT '',
        idempotencyKey TEXT NOT NULL,
        toolName TEXT NOT NULL,
        targetIdentity TEXT DEFAULT '',
        inputDigest TEXT DEFAULT '',
        envelope TEXT NOT NULL DEFAULT '{}',
        outcome TEXT NOT NULL,
        createdAt TEXT NOT NULL
      )`);
      database.run(
        `INSERT INTO conversation_action_receipts
          (id, taskId, conversationId, turnId, requestId, idempotencyKey, toolName,
           targetIdentity, inputDigest, envelope, outcome, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'legacy-receipt',
          'legacy-task',
          'legacy-conversation',
          'legacy-turn',
          'legacy-request',
          'legacy-idempotency',
          'desktop_write_text_file',
          'legacy-target',
          'legacy-input',
          '{}',
          'waiting_confirmation',
          new Date(0).toISOString(),
        ],
        error => done(error),
      );
    });
  }).then(() => undefined);
}

function receiptColumns(): Promise<string[]> {
  return withSqlite<string[]>((database, done) => {
    database.all(
      'PRAGMA table_info(conversation_action_receipts)',
      (error, rows: Array<{ name: string }>) => done(error, rows?.map(row => row.name)),
    );
  }).then(value => value || []);
}

function persistedReceipt(id: string): Promise<Record<string, unknown> | null> {
  return withSqlite<Record<string, unknown> | null>((database, done) => {
    database.get(
      'SELECT * FROM conversation_action_receipts WHERE id = ?',
      [id],
      (error, row) => done(error, (row as Record<string, unknown> | undefined) || null),
    );
  }).then(value => value || null);
}

describe.sequential('conversation action receipt restart provenance', () => {
  beforeAll(async () => {
    await createLegacyReceiptTable();
    await initDatabase();
  });

  it('upgrades an old receipt table without inventing provenance', async () => {
    expect(await receiptColumns()).toEqual(expect.arrayContaining([
      'modelRoutingReceiptId',
      'executionOrigin',
    ]));
    expect(readDB().conversationActionReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'legacy-receipt',
        modelRoutingReceiptId: '',
        executionOrigin: '',
      }),
    ]));
  });

  it('round-trips the exact model route and execution origin across close/reopen', async () => {
    const nonce = crypto.randomUUID();
    const receiptId = `restart-receipt-${nonce}`;
    const routingReceiptId = `routing-receipt-${nonce}`;
    const db = readDB();
    db.conversationActionReceipts.push({
      id: receiptId,
      taskId: `task-${nonce}`,
      conversationId: `conversation-${nonce}`,
      turnId: `turn-${nonce}`,
      requestId: `request-${nonce}`,
      modelRoutingReceiptId: routingReceiptId,
      executionOrigin: 'model_selected',
      idempotencyKey: `idempotency-${nonce}`,
      toolName: 'desktop_write_text_file',
      targetIdentity: 'D:\\isolated\\restart-result.txt',
      inputDigest: 'a'.repeat(64),
      envelope: '{}',
      outcome: 'waiting_confirmation',
      createdAt: new Date().toISOString(),
    });
    writeDB(db);
    await flushDB();
    await closeDatabase();
    await initDatabase();

    expect(readDB().conversationActionReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: receiptId,
        modelRoutingReceiptId: routingReceiptId,
        executionOrigin: 'model_selected',
      }),
    ]));
    await expect(persistedReceipt(receiptId)).resolves.toMatchObject({
      modelRoutingReceiptId: routingReceiptId,
      executionOrigin: 'model_selected',
    });
  });
});
