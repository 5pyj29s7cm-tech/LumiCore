import './helpers';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, flushDBOrThrow, getDatabasePersistenceStatus, initDatabase, querySQL, readDB, runSQL, writeDB } from '../db_layer';

describe.sequential('snapshot batch persistence', () => {
  beforeEach(async () => { await initDatabase(); });
  afterEach(async () => { vi.restoreAllMocks(); await closeDatabase(); });

  it('preserves every row and exact Unicode/quoted content across restart', async () => {
    const state = readDB();
    const original = [...state.settings];
    const rows = Array.from({ length: 2500 }, (_, index) => ({ key: `batch-restart-${index}`, value: `第${index}行 'quoted'\n原文` }));
    await runSQL('CREATE INDEX snapshot_settings_value ON settings(value)');
    const statements = vi.spyOn(sqlite3.Database.prototype, 'run');
    state.settings.push(...rows);
    writeDB(state);
    await flushDBOrThrow();
    expect(statements.mock.calls.filter(([sql]) => /CREATE.*INDEX/.test(sql))).toEqual([]);
    expect(await querySQL("SELECT name FROM sqlite_master WHERE name='snapshot_settings_value'")).toEqual([{ name: 'snapshot_settings_value' }]);
    statements.mockRestore();
    await closeDatabase();
    await initDatabase();
    try {
      expect((await querySQL<{ key: string; value: string }>("SELECT key,value FROM settings WHERE key LIKE 'batch-restart-%' ORDER BY key")))
        .toEqual([...rows].sort((a,b) => a.key.localeCompare(b.key)));
    } finally {
      const restored = readDB(); restored.settings = original; writeDB(restored); await flushDBOrThrow();
      await runSQL('DROP INDEX IF EXISTS snapshot_settings_value');
    }
  });

  it('rolls back the entire snapshot on a middle-row constraint failure and supports retry', async () => {
    const state = readDB();
    const original = [...state.settings];
    state.settings.push({ key: 'batch-durable-base', value: 'original' });
    writeDB(state); await flushDBOrThrow();
    const durable = [...state.settings];
    const rows = Array.from({ length: 1200 }, (_, index) => ({ key: `batch-retry-${index}`, value: `${index}` }));
    state.settings = [...durable, ...rows.slice(0,600), rows[12], ...rows.slice(600)];
    writeDB(state);
    try {
      await expect(flushDBOrThrow()).rejects.toThrow(/UNIQUE|constraint/i);
      expect(await querySQL("SELECT value FROM settings WHERE key='batch-durable-base'"))
        .toEqual([{ value: 'original' }]);
      expect(await querySQL("SELECT key FROM settings WHERE key LIKE 'batch-retry-%'"))
        .toEqual([]);
      state.settings = [...durable, ...rows]; writeDB(state); await flushDBOrThrow();
      expect(await querySQL("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'batch-retry-%'"))
        .toEqual([{ n: 1200 }]);
    } finally {
      state.settings = original; writeDB(state); await flushDBOrThrow();
    }
  });

  it('changes only the inserted, edited and deleted chat rows and preserves indexes and restart data', async () => {
    const state = readDB();
    const original = [...state.interactions];
    const rows = Array.from({ length: 250 }, (_, index) => ({ id: `delta-chat-${index}`, userId: 'delta-user', message: `原文${index}`, role: 'user', timestamp: new Date().toISOString() }));
    state.interactions.push(...rows); writeDB(state); await flushDBOrThrow();
    await runSQL('CREATE TABLE delta_audit (action TEXT, id TEXT)');
    for (const [action, ref] of [['INSERT','NEW'], ['UPDATE','NEW'], ['DELETE','OLD']]) {
      await runSQL(`CREATE TRIGGER delta_${action} AFTER ${action} ON interactions BEGIN INSERT INTO delta_audit VALUES ('${action}', ${ref}.id); END`);
    }
    const statements = vi.spyOn(sqlite3.Database.prototype, 'run');
    try {
      state.interactions.find((row: any) => row.id === 'delta-chat-12').message = '已修改的原文';
      state.interactions = state.interactions.filter((row: any) => row.id !== 'delta-chat-13');
      state.interactions.push({ ...rows[0], id: 'delta-chat-new', message: '新消息' });
      writeDB(state); await flushDBOrThrow();
      expect(statements.mock.calls.filter(([sql]) => /CREATE.*INDEX/.test(sql))).toEqual([]);
      statements.mockRestore();
      expect(await querySQL('SELECT action,id FROM delta_audit ORDER BY action')).toEqual([
        { action: 'DELETE', id: 'delta-chat-13' }, { action: 'INSERT', id: 'delta-chat-new' }, { action: 'UPDATE', id: 'delta-chat-12' },
      ]);
      await closeDatabase(); await initDatabase();
      expect(await querySQL("SELECT message FROM interactions WHERE id='delta-chat-12'"))
        .toEqual([{ message: '已修改的原文' }]);
      expect(await querySQL("SELECT id FROM interactions WHERE id='delta-chat-13'"))
        .toEqual([]);
      expect((await querySQL("PRAGMA index_list('interactions')")).length).toBeGreaterThan(1);
    } finally {
      for (const action of ['INSERT','UPDATE','DELETE']) await runSQL(`DROP TRIGGER IF EXISTS delta_${action}`);
      await runSQL('DROP TABLE IF EXISTS delta_audit');
      const restored = readDB(); restored.interactions = original; writeDB(restored); await flushDBOrThrow();
    }
  });

  it('rolls back partial hot-table updates and does not advance fingerprints before a successful retry', async () => {
    const state = readDB();
    const original = [...state.interactions];
    const base = { id: 'delta-rollback-base', userId: 'delta-user', message: 'old', timestamp: new Date().toISOString() };
    state.interactions.push(base); writeDB(state); await flushDBOrThrow();
    base.message = 'new';
    const invalid = { ...base, id: 'delta-rollback-invalid', timestamp: undefined as string | undefined };
    state.interactions.push(invalid); writeDB(state);
    try {
      await expect(flushDBOrThrow()).rejects.toThrow(/NOT NULL|constraint/i);
      expect(await querySQL("SELECT message FROM interactions WHERE id='delta-rollback-base'"))
        .toEqual([{ message: 'old' }]);
      invalid.timestamp = new Date().toISOString(); writeDB(state); await flushDBOrThrow();
      expect(await querySQL("SELECT message FROM interactions WHERE id='delta-rollback-base'"))
        .toEqual([{ message: 'new' }]);
      expect(await querySQL("SELECT COUNT(*) AS n FROM interactions WHERE id LIKE 'delta-rollback-%'"))
        .toEqual([{ n: 2 }]);
    } finally {
      state.interactions = original; writeDB(state); await flushDBOrThrow();
    }
  });

  it('rolls back earlier table changes when a later unique constraint fails, then retries', async () => {
    const state = readDB();
    const conversations = [...state.conversations], turns = [...state.conversationActionTurns];
    const now = new Date().toISOString();
    const conversation = { id: 'index-rollback-conv', userId: 'index-user', title: 'before', createdAt: now, lastActiveAt: now };
    state.conversations.push(conversation); writeDB(state); await flushDBOrThrow();
    const indexes = await querySQL("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name");
    const turn = { id: 'index-turn-1', conversationId: conversation.id, userId: conversation.userId, requestId: 'same-request', createdAt: now, updatedAt: now };
    conversation.title = 'after';
    state.conversationActionTurns.push(turn, { ...turn, id: 'index-turn-2' });
    writeDB(state);
    try {
      await expect(flushDBOrThrow()).rejects.toThrow(/UNIQUE/);
      expect(await querySQL('SELECT title FROM conversations WHERE id=?', [conversation.id])).toEqual([{ title: 'before' }]);
      expect(await querySQL('SELECT id FROM conversation_action_turns WHERE conversationId=?', [conversation.id])).toEqual([]);
      expect(await querySQL("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name")).toEqual(indexes);
      state.conversationActionTurns.pop();
      const statements = vi.spyOn(sqlite3.Database.prototype, 'run');
      writeDB(state); await flushDBOrThrow();
      expect(statements.mock.calls.map(([sql]) => sql).filter(sql => /CREATE.*INDEX/.test(sql)))
        .toEqual([]);
      statements.mockRestore();
      expect(await querySQL('SELECT title FROM conversations WHERE id=?', [conversation.id])).toEqual([{ title: 'after' }]);
      expect(await querySQL('SELECT id FROM conversation_action_turns WHERE conversationId=?', [conversation.id])).toEqual([{ id: turn.id }]);
    } finally {
      state.conversations = conversations; state.conversationActionTurns = turns; writeDB(state); await flushDBOrThrow();
    }
  });

  it.each([
    ['interactions', 'interactions', 'message', (value: string) => ({ message: value })],
    ['memories', 'memories', 'keywords', (value: string) => ({ type: 'fact', content: 'memory', keywords: [value] })],
    ['tokenUsage', 'token_usage', 'model', (value: string) => ({ provider: 'test', model: value, promptTokens: 1, completionTokens: 1, totalTokens: 2 })],
  ] as const)('keeps %s block boundaries, raw aliases, deletions and duplicate rejection durable', async (property, table, column, values) => {
    const state = readDB(), original = state[property], now = new Date().toISOString();
    const rows = Array.from({ length: 1030 }, (_, i) => ({ id: 'block-' + i, userId: 'block-user', timestamp: now, createdAt: now, updatedAt: now, ...values('old') }));
    state[property] = rows; writeDB(state); await flushDBOrThrow();
    try {
      if (property === 'memories') (rows[511] as any).keywords.push('nested');
      else Object.assign(rows[511], values('nested'));
      Object.assign(rows[512], values('next-block'));
      state[property] = rows.slice(0, 1024);
      state[property].push(rows[0]); writeDB(state);
      await expect(flushDBOrThrow()).rejects.toThrow(/UNIQUE/);
      expect(await querySQL('SELECT COUNT(*) AS n FROM ' + table)).toEqual([{ n: 1030 }]);
      state[property].pop(); writeDB(state); await flushDBOrThrow();
      expect(await querySQL('SELECT COUNT(*) AS n FROM ' + table)).toEqual([{ n: 1024 }]);
      const expected = property === 'memories' ? ['["old","nested"]', '["next-block"]'] : ['nested', 'next-block'];
      expect((await querySQL('SELECT ' + column + ' AS value FROM ' + table + " WHERE id IN ('block-511','block-512') ORDER BY id")).map(row => row.value)).toEqual(expected);
      state[property].reverse(); writeDB(state); await flushDBOrThrow();
      expect(getDatabasePersistenceStatus().lastFlushTables).toEqual([]);
      await closeDatabase(); await initDatabase();
      expect(await querySQL('SELECT COUNT(*) AS n FROM ' + table)).toEqual([{ n: 1024 }]);
      // Remove an entire unchanged block; no upserts are needed.
      const reopened = readDB(); reopened[property] = reopened[property].filter((row: any) => Number(row.id.slice(6)) < 512);
      writeDB(reopened); await flushDBOrThrow();
      expect(await querySQL('SELECT COUNT(*) AS n FROM ' + table)).toEqual([{ n: 512 }]);
    } finally { const restored = readDB(); restored[property] = original; writeDB(restored); await flushDBOrThrow(); }
  });

  it('replaces legacy empty keys and safely resumes row updates after repair', async () => {
    const state = readDB(), original = state.interactions;
    const row = { id: '', userId: 'legacy-user', message: 'legacy', timestamp: new Date().toISOString() };
    state.interactions = [row]; writeDB(state); await flushDBOrThrow();
    try {
      expect(await querySQL('SELECT id,message FROM interactions')).toEqual([{ id: '', message: 'legacy' }]);
      row.id = 'repaired'; writeDB(state); await flushDBOrThrow();
      row.message = 'updated'; writeDB(state); await flushDBOrThrow();
      expect(await querySQL('SELECT id,message FROM interactions')).toEqual([{ id: 'repaired', message: 'updated' }]);
    } finally { state.interactions = original; writeDB(state); await flushDBOrThrow(); }
  });

  it('captures nested values before SQL awaits and saves later writes in the next revision', async () => {
    const state = readDB(), original = state.memories, now = new Date().toISOString();
    const row = { id: 'late-mutation', userId: 'late-user', type: 'fact', content: 'first', keywords: ['first'], createdAt: now, updatedAt: now };
    state.memories = [row];
    const run = sqlite3.Database.prototype.run;
    const spy = vi.spyOn(sqlite3.Database.prototype, 'run').mockImplementation(function (this: sqlite3.Database, sql: string, ...args: any[]) {
      if (sql === 'BEGIN IMMEDIATE TRANSACTION') {
        spy.mockRestore(); row.keywords.push('later'); row.content = 'later'; writeDB(state);
      }
      return run.call(this, sql, ...args);
    });
    try {
      writeDB(state); await flushDBOrThrow();
      expect(await querySQL("SELECT content,keywords FROM memories WHERE id='late-mutation'")).toEqual([{ content: 'first', keywords: '["first"]' }]);
      expect(getDatabasePersistenceStatus().pending).toBe(true);
      await flushDBOrThrow(); await closeDatabase(); await initDatabase();
      expect(await querySQL("SELECT content,keywords FROM memories WHERE id='late-mutation'")).toEqual([{ content: 'later', keywords: '["first","later"]' }]);
    } finally { spy.mockRestore(); const restored = readDB(); restored.memories = original; writeDB(restored); await flushDBOrThrow(); }
  });

  it('exchanges unique usernames without rewriting untouched users, and retains all rows on failure', async () => {
    const state = readDB(), original = [...state.users], now = new Date().toISOString();
    const rows = ['a', 'b', 'c'].map(id => ({ uid: 'swap-' + id, username: 'swap-' + id, password: 'fixture', role: 'user', balance: 0, createdAt: now }));
    state.users.push(...rows); writeDB(state); await flushDBOrThrow();
    await runSQL('CREATE TABLE user_delta_audit (uid TEXT, action TEXT)');
    for (const [action, ref] of [['INSERT', 'NEW'], ['DELETE', 'OLD']]) {
      await runSQL(`CREATE TRIGGER user_delta_${action} AFTER ${action} ON users BEGIN INSERT INTO user_delta_audit VALUES (${ref}.uid, '${action}'); END`);
    }
    try {
      rows[0].username = 'swap-b'; rows[1].username = 'swap-a'; writeDB(state); await flushDBOrThrow();
      expect(await querySQL("SELECT uid,username FROM users WHERE uid LIKE 'swap-%' ORDER BY uid")).toEqual([
        { uid: 'swap-a', username: 'swap-b' }, { uid: 'swap-b', username: 'swap-a' }, { uid: 'swap-c', username: 'swap-c' },
      ]);
      expect(await querySQL('SELECT uid,action FROM user_delta_audit ORDER BY uid,action')).toEqual([
        { uid: 'swap-a', action: 'DELETE' }, { uid: 'swap-a', action: 'INSERT' },
        { uid: 'swap-b', action: 'DELETE' }, { uid: 'swap-b', action: 'INSERT' },
      ]);
      await runSQL('DELETE FROM user_delta_audit');
      rows[0].username = 'swap-c'; writeDB(state);
      await expect(flushDBOrThrow()).rejects.toThrow(/UNIQUE/);
      expect(await querySQL('SELECT * FROM user_delta_audit')).toEqual([]);
      expect(await querySQL("SELECT username FROM users WHERE uid='swap-a'")).toEqual([{ username: 'swap-b' }]);
      rows[0].username = 'swap-fixed'; writeDB(state); await flushDBOrThrow();
      await closeDatabase(); await initDatabase();
      expect(await querySQL("SELECT uid,username FROM users WHERE uid LIKE 'swap-%' ORDER BY uid")).toEqual([
        { uid: 'swap-a', username: 'swap-fixed' }, { uid: 'swap-b', username: 'swap-a' }, { uid: 'swap-c', username: 'swap-c' },
      ]);
    } finally {
      for (const action of ['INSERT', 'DELETE']) await runSQL(`DROP TRIGGER IF EXISTS user_delta_${action}`);
      await runSQL('DROP TABLE IF EXISTS user_delta_audit');
      const restored = readDB(); restored.users = original; writeDB(restored); await flushDBOrThrow();
    }
  });

});
