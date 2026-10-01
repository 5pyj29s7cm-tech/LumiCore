import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import type { ToolExecutionRecord } from '../server/tools/types';

let base: string;
let output: string;
let archive: typeof import('../server/files/generated_archive');
let database: typeof import('../db_layer');
const scope = { userId: 'library-owner', domain: 'personal' as const };
const cookie = (uid = scope.userId) => `token=${jwt.sign({ uid, username: uid, role: 'admin' }, JWT_SECRET)}`;
const headers = { Cookie: cookie(), 'Content-Type': 'application/json' };
const record = (source: string, name = 'write_file'): ToolExecutionRecord => ({
  id: source, name, arguments: { path: source },
  result: JSON.stringify({ ok: true, path: source, outputPath: source, verified: true, verificationStatus: 'verified' }),
  terminalVerification: { status: 'verified', strategy: 'artifact', reason: 'Verified test fixture' },
});
const create = (name: string, value: string | Buffer = 'original content') => {
  const file = path.join(output, name); fs.writeFileSync(file, value); return file;
};
const api = (url: string, init: RequestInit = {}) => fetch(`${base}/api${url}`, { ...init, headers: init.headers || headers });

beforeAll(async () => {
  const app = await makeApp(); base = app.url;
  app.server.unref();
  database = await import('../db_layer');
  const db = database.readDB(); db.users.push({ uid: scope.userId, role: 'admin', username: scope.userId, password: 'fixture', balance: 0, createdAt: new Date().toISOString() } as any);
  database.writeDB(db);
  archive = await import('../server/files/generated_archive');
  const { getGeneratedOutputDir } = await import('../server/config/data_path');
  output = getGeneratedOutputDir(); fs.mkdirSync(output, { recursive: true });
  app.apiRouter.use((await import('../routes/files')).default);
});

const scopeKey = (owner: typeof scope) => createHash('sha256').update(JSON.stringify([owner.domain, owner.userId])).digest('hex');
async function legacyIndex(owner: typeof scope, entries: unknown[]) {
  const { getDataPath } = await import('../server/config/data_path');
  const dir = getDataPath('generated-library'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, scopeKey(owner) + '.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries })); return file;
}
function interceptArchiveSql(intercept: (sql: string, proceed: () => Promise<void>) => Promise<void>) {
  const lock = database.withDatabaseSqlWriteLock;
  return vi.spyOn(database, 'withDatabaseSqlWriteLock').mockImplementation(operation => lock(session => operation({
    ...session, run: (sql, values) => intercept(sql, () => session.run(sql, values)),
  })));
}

describe('Generated libraries across conversations', () => {
  it('commits one durable index for a multi-file archive batch and preserves its entries on retry', async () => {
    const files = ['batch-a.txt', 'batch-b.txt', 'batch-c.txt'].map(name => path.join(output, name));
    files.forEach(file => fs.writeFileSync(file, 'Batch archive fixture'));
    await archive.listGeneratedArchive(scope);
    const sync = vi.fn();
    const opens = interceptArchiveSql(async (sql, proceed) => { await proceed(); if (sql === 'COMMIT') sync(); });
    try {
      const saved = await archive.archiveGeneratedOutputs(files.map(file => record(file)), { ...scope, source: 'chat' });
      expect(saved).toHaveLength(3);
      const existence = vi.spyOn(fs, 'existsSync');
      try {
        expect(await archive.listGeneratedArchive(scope, saved[1].filename)).toEqual([saved[1]]);
        expect(existence.mock.calls.filter(([file]) => saved.some(entry => String(file).endsWith(entry.filename)))).toHaveLength(1);
        expect(await archive.listGeneratedArchive(scope, '')).toEqual([]);
        existence.mockClear();
        const listed = await archive.listGeneratedArchive(scope);
        expect(listed.map(entry => entry.id).sort()).toEqual(saved.map(entry => entry.id).sort());
        expect(existence.mock.calls.filter(([file]) => saved.some(entry => String(file).endsWith(entry.filename)))).toHaveLength(0);
      } finally { existence.mockRestore(); }
      expect(sync).toHaveBeenCalledTimes(1);
      expect(await archive.archiveGeneratedOutputs(files.map(file => record(file)), { ...scope, source: 'chat' })).toHaveLength(3);
      expect(sync).toHaveBeenCalledTimes(1);
    } finally { opens.mockRestore(); }
  });
  it('recovers old data paths only after a verified product-root migration', async () => {
    const { migrateLegacyProductDataRoot, markLegacyProductDataMigrationVerified, resolveMigratedDataFile } = await import('../server/config/data_path');
    const home = path.join(output, 'migration-home'), oldData = path.join(home, 'LumiOS', 'data');
    fs.mkdirSync(oldData, { recursive: true });
    const original = path.join(oldData, 'old-result.txt'); fs.writeFileSync(original, 'historical output');
    fs.writeFileSync(path.join(oldData, 'lumi.db'), 'isolated fixture');
    const migrated = migrateLegacyProductDataRoot(() => ({ releaseAt: () => true }), home);
    expect(resolveMigratedDataFile(original, migrated)).toBe(original);
    markLegacyProductDataMigrationVerified({ quickCheck: 'ok', userCount: 1, conversationCount: 1, interactionCount: 1 }, migrated);
    const resolved = resolveMigratedDataFile(original, migrated);
    expect(resolved).toBe(path.join(migrated, 'data', 'old-result.txt'));
    expect(fs.readFileSync(resolved, 'utf8')).toBe('historical output');
    const unrelated = path.join(home, 'OtherAccount', 'data', 'old-result.txt');
    expect(resolveMigratedDataFile(unrelated, migrated)).toBe(unrelated);
  });
  it('archives canonical tool outputs without a separate conversation-specific execution path', async () => {
    const { ToolRegistry } = await import('../server/tools/registry');
    const { executeToolCall } = await import('../server/tools/execution_engine');
    const registry = new ToolRegistry(), file = path.join(output, 'canonical.txt');
    registry.register({ name: 'write_file', description: 'Write file', permission: 'public', securityLevel: 'safe',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      capability: { id: 'write_file', family: 'files', lane: 'files', operation: 'create', risk: 'low',
        sideEffects: [{ type: 'local_write', scope: 'file', reversible: true }],
        verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'path'], requiredValues: { ok: true }, successSignals: ['file saved'], limitations: [] } },
      handler: async () => { create('canonical.txt'); return JSON.stringify({ ok: true, path: file }); },
    });
    const result = await executeToolCall({ registry, name: 'write_file', arguments: { path: file }, context: { ...scope, allowLocalFileWrites: true, authenticated: true, localExecution: true, authRole: 'admin', conversationId: 'chat-one', source: 'desktop-chat' } });
    expect(result.error).toBeUndefined();
    expect(result.terminalVerification?.status).toBe('verified');
    expect((await archive.listGeneratedArchive(scope)).some(entry => entry.displayName === 'canonical.txt')).toBe(true);
  });

  it('lists and previews image, video and files from two conversations without their conversation IDs', async () => {
    const image = create('portrait.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
    const video = create('clip.mp4', 'video-fixture-bytes');
    const [imageEntry] = await archive.archiveGeneratedOutputs([record(image, 'generate_image')], { ...scope, conversationId: 'one' });
    const [videoEntry] = await archive.archiveGeneratedOutputs([record(video, 'generate_video')], { ...scope, conversationId: 'two' });
    const files = (await (await api('/files/list?domain=personal')).json()).files;
    expect(files.find((file: any) => file.archiveId === imageEntry.id)).toMatchObject({ displayName: 'portrait.png', archiveKind: 'image', sourceConversationId: 'one' });
    expect(files.find((file: any) => file.archiveId === videoEntry.id)).toMatchObject({ archiveKind: 'video', sourceConversationId: 'two' });
    const preview = await api(`/files/download/${encodeURIComponent(imageEntry.filename)}?inline=1&domain=personal`);
    expect(preview.status).toBe(200); expect(preview.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(fs.readFileSync(image));
    const range = await api(`/files/download/${encodeURIComponent(videoEntry.filename)}?inline=1`, { headers: { ...headers, Range: 'bytes=0-4' } });
    expect(range.status).toBe(206); expect(await range.text()).toBe('video');
  });

  it('preserves archived bytes after source changes or conversation deletion and retains separate versions', async () => {
    const source = create('versions.txt');
    const [first] = await archive.archiveGeneratedOutputs([record(source)], { ...scope, conversationId: 'deleted-chat' });
    fs.writeFileSync(source, 'modified and different length');
    const [second] = await archive.archiveGeneratedOutputs([record(source)], { ...scope, conversationId: 'another-chat' });
    expect(first.id).not.toBe(second.id);
    fs.unlinkSync(source);
    database.readDB().conversations = [];
    expect(await (await api(`/files/download/${first.filename}`)).text()).toBe('original content');
    expect(await (await api(`/files/download/${second.filename}`)).text()).toBe('modified and different length');
    database.readDB().knowledgeFiles = [];
    const files = (await (await api('/files/list')).json()).files;
    expect(files.find((file: any) => file.id === first.filename).displayName).toBe('versions.txt');
  });

  it('deduplicates concurrent receipts, supports rename and remembers an explicit deletion during backfill', async () => {
    const source = create('dedup.txt');
    const results = await Promise.all(Array.from({ length: 4 }, () => archive.archiveGeneratedOutputs([record(source)], scope)));
    expect(new Set(results.map(entries => entries[0].id)).size).toBe(1);
    const entry = results[0][0];
    expect((await api('/files/rename', { method: 'POST', body: JSON.stringify({ id: entry.filename, newName: 'renamed.txt' }) })).status).toBe(200);
    expect((await archive.archiveGeneratedOutputs([record(source)], scope))[0].filename).toBe('renamed.txt');
    expect((await api('/files/delete/renamed.txt', { method: 'DELETE' })).status).toBe(200);
    expect(await archive.archiveGeneratedOutputs([record(source)], scope)).toEqual([]);
    expect((await archive.listGeneratedArchive(scope)).some(item => item.id === entry.id)).toBe(false);
  });

  it('excludes reads, failed outputs, unverified paths, and explicit acceptance traffic', async () => {
    const source = create('excluded.txt');
    expect(await archive.archiveGeneratedOutputs([record(source, 'read_file')], scope)).toEqual([]);
    expect(await archive.archiveGeneratedOutputs([{ ...record(source), error: 'failed' }], scope)).toEqual([]);
    expect(await archive.archiveGeneratedOutputs([{ ...record(source), terminalVerification: undefined }], scope)).toEqual([]);
    expect(await archive.archiveGeneratedOutputs([record(source)], { ...scope, source: 'e2e-formal-client' })).toEqual([]);
  });

  it('separates personal owners and rejects organization writes without membership', async () => {
    const entries = await archive.listGeneratedArchive(scope);
    expect((await api('/files/list', { headers: { Cookie: cookie('other-owner') } })).status).toBe(200);
    expect((await (await api('/files/list', { headers: { Cookie: cookie('other-owner') } })).json()).files).toEqual([]);
    expect((await api(`/files/download/${entries[0].filename}`, { headers: { Cookie: cookie('other-owner') } })).status).toBe(404);
    expect((await api('/files/list', { headers: {} })).status).toBe(401);
    await expect(archive.archiveGeneratedOutputs([record(create('org-private.txt'))], { ...scope, domain: 'work', orgId: 'unjoined' })).rejects.toThrow('access');
    const { createOrg, addMember } = await import('../server/org/db');
    const org = createOrg('Read-only migration', 'read-only-migration', scope.userId);
    addMember(org.id, 'archive-viewer', 'viewer');
    const viewer = { userId: 'archive-viewer', domain: 'work' as const, orgId: org.id };
    expect(await archive.listGeneratedArchive(viewer)).toEqual([]);
    await expect(archive.archiveGeneratedOutputs([record(create('viewer-write.txt'))], viewer)).rejects.toThrow('access');
  });

  it('backfills verified historical results without copying unrelated conversations or failed outputs', async () => {
    const source = create('historical.txt'), excluded = create('historical-failed.txt');
    const db = database.readDB();
    db.conversations.push({ id: 'history-owner', userId: scope.userId, domain: 'personal', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() } as any);
    db.interactions.push({ id: 'history-receipt', userId: scope.userId, conversationId: 'history-owner', source: 'desktop-chat', timestamp: new Date().toISOString(), toolCalls: JSON.stringify([record(source), { ...record(excluded), error: 'failed' }]) } as any);
    expect((await api('/files/archive-generated', { method: 'POST' })).status).toBe(200);
    const entries = await archive.listGeneratedArchive(scope);
    expect(entries.some(entry => entry.displayName === 'historical.txt')).toBe(true);
    expect(entries.some(entry => entry.displayName === 'historical-failed.txt')).toBe(false);
  });

  it('does not publish an index after membership is revoked and rejoined during its async write', async () => {
    const { createOrg, addMember, removeMember } = await import('../server/org/db');
    const org = createOrg('Archive fixture', 'archive-fixture', scope.userId);
    addMember(org.id, scope.userId, 'owner');
    const work = { ...scope, domain: 'work' as const, orgId: org.id };
    const source = create('revoked-index.txt');
    await archive.listGeneratedArchive(work);
    const writes = interceptArchiveSql(async (sql, proceed) => {
      await proceed();
      if (sql.startsWith('INSERT INTO generated_archive(')) { removeMember(org.id, scope.userId); addMember(org.id, scope.userId, 'owner'); }
    });
    try {
      await expect(archive.archiveGeneratedOutputs([record(source)], work)).rejects.toThrow('Archive organization access changed.');
      expect(await archive.listGeneratedArchive(work)).toEqual([]);
    } finally { writes.mockRestore(); }
    expect(await archive.archiveGeneratedOutputs([record(source)], work)).toHaveLength(1);
  });

  it('keeps the committed index intact after an async sync failure and cleans the uncommitted file', async () => {
    const source = create('index-sync-retry.txt');
    const before = await archive.listGeneratedArchive(scope);
    const writes = interceptArchiveSql(async (sql, proceed) => {
      if (sql === 'COMMIT') throw new Error('synthetic index sync failure');
      await proceed();
    });
    try {
      await expect(archive.archiveGeneratedOutputs([record(source)], scope)).rejects.toThrow('synthetic index sync failure');
      expect(await archive.listGeneratedArchive(scope)).toEqual(before);
      const { generatedKnowledgeDirectory } = await import('../server/files/knowledge_directory');
      expect(fs.readdirSync(generatedKnowledgeDirectory(scope)).some(name => name.endsWith('.tmp'))).toBe(false);
    } finally { writes.mockRestore(); }
    const saved = await archive.archiveGeneratedOutputs([record(source)], scope);
    expect(saved).toHaveLength(1);
    expect(await archive.listGeneratedArchive(scope, saved[0].filename)).toEqual(saved);
  });
  it('rejects a stale organization list when membership changes during its async read', async () => {
    const { createOrg, addMember, removeMember } = await import('../server/org/db');
    const org = createOrg('Read boundary', 'archive-read-boundary', scope.userId);
    addMember(org.id, scope.userId, 'owner');
    const work = { ...scope, domain: 'work' as const, orgId: org.id };
    await archive.archiveGeneratedOutputs([record(create('private-list.txt'))], work);
    const query = database.querySQL;
    const spy = vi.spyOn(database, 'querySQL').mockImplementation(async (sql, values) => {
      const result = await query(sql, values);
      if (sql.includes(' FROM generated_archive WHERE')) { removeMember(org.id, scope.userId); addMember(org.id, scope.userId, 'owner'); }
      return result;
    });
    try {
      const token = jwt.sign({ uid: scope.userId, username: scope.userId, role: 'admin', orgId: org.id }, JWT_SECRET);
      const response = await api('/files/list?domain=work', { headers: { Cookie: 'token=' + token } });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('private-list.txt');
    } finally { spy.mockRestore(); }
  });

  it('does not hide index corruption or IO failure, and performs no synchronous index read', async () => {
    const owner = { ...scope, userId: 'legacy-read-failure' }, file = await legacyIndex(owner, []);
    const read = fsp.readFile.bind(fsp), sync = vi.spyOn(fs, 'readFileSync');
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation(async (...args: Parameters<typeof fsp.readFile>) => {
      if (String(args[0]).includes('generated-library')) return '{"version":1,"entries":null}';
      return read(...args);
    });
    try {
      await expect(archive.listGeneratedArchive(owner)).rejects.toThrow('Invalid generated library index');
      spy.mockImplementation(async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
      await expect(archive.listGeneratedArchive(owner)).rejects.toThrow('denied');
      expect(sync.mock.calls.filter(([file]) => String(file).includes('generated-library'))).toEqual([]);
    } finally { spy.mockRestore(); sync.mockRestore(); }
    expect(await archive.listGeneratedArchive(owner)).toEqual([]);
  });

  it('imports legacy rows once, retains tombstones, and survives snapshot flush and restart', async () => {
    const owner = { ...scope, userId: 'legacy-migration' }, seed = (await archive.listGeneratedArchive(scope))[0];
    const entries = Array.from({ length: 85 }, (_, i) => ({ ...seed, userId: owner.userId,
      id: createHash('sha256').update('legacy-' + i).digest('hex'), filename: 'legacy-' + i + '.txt',
      ...(i === 84 ? { deletedAt: '2026-10-01T00:00:00Z' } : {}) }));
    const file = await legacyIndex(owner, entries);
    const { generatedKnowledgeDirectory } = await import('../server/files/knowledge_directory');
    const dir = generatedKnowledgeDirectory(owner);
    for (const entry of entries) fs.writeFileSync(path.join(dir, entry.filename), 'archive fixture');
    let batches = 0;
    const writes = interceptArchiveSql(async (sql, proceed) => {
      if (sql.startsWith('INSERT INTO generated_archive(') && ++batches === 2) throw new Error('migration interrupted');
      await proceed();
    });
    try {
      await expect(archive.listGeneratedArchive(owner)).rejects.toThrow('migration interrupted');
      expect(await database.querySQL('SELECT id FROM generated_archive WHERE scope=?', [scopeKey(owner)])).toEqual([]);
      expect(await database.querySQL('SELECT scope FROM generated_archive_scopes WHERE scope=?', [scopeKey(owner)])).toEqual([]);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).entries).toEqual(entries);
    } finally { writes.mockRestore(); }
    expect(await archive.listGeneratedArchive(owner)).toHaveLength(84);
    const durable = await database.querySQL('SELECT * FROM generated_archive WHERE scope=? ORDER BY id', [scopeKey(owner)]);
    expect(durable).toHaveLength(85);
    fs.writeFileSync(file, 'obsolete JSON must not be read');
    const db = database.readDB(); db.settings.push({ key: 'archive-independent', value: 'updated' }); database.writeDB(db);
    await database.runSQL('CREATE INDEX IF NOT EXISTS idx_generated_archive_created ON generated_archive(scope,createdAt DESC)');
    await database.flushDBOrThrow(); await database.closeDatabase(); await database.initDatabase();
    const indexes = await database.querySQL<{ name: string }>("PRAGMA index_list('generated_archive')");
    expect(indexes.map(index => index.name)).toContain('idx_generated_archive_scope');
    expect(indexes.map(index => index.name)).not.toContain('idx_generated_archive_created');
    expect(await database.querySQL('SELECT * FROM generated_archive WHERE scope=? ORDER BY id', [scopeKey(owner)])).toEqual(durable);
    expect(await archive.listGeneratedArchive(owner, entries[42].filename)).toEqual([entries[42]]);
    expect(await archive.listGeneratedArchive(owner, entries[84].filename)).toEqual([]);
    const plan = await database.querySQL('EXPLAIN QUERY PLAN SELECT id FROM generated_archive WHERE scope=? AND filename=?', [scopeKey(owner), entries[42].filename]);
    expect(JSON.stringify(plan)).toContain('idx_generated_archive_filename');
  });

  it('rejects malformed SQL payloads without caching a truncated list', async () => {
    const owner = { ...scope, userId: 'corrupt-sql-payload' };
    const [entry] = await archive.archiveGeneratedOutputs([record(create('corrupt-payload.txt'))], owner);
    for (const payload of ['', '  \n', '{},{}', '{', '{"x":1},']) {
      await database.runSQL('UPDATE generated_archive SET payload=? WHERE scope=? AND id=?', [payload, scopeKey(owner), entry.id]);
      await expect(archive.listGeneratedArchive(owner)).rejects.toThrow();
      await expect(archive.listGeneratedArchive(owner, entry.filename)).rejects.toThrow();
    }
    await database.runSQL('UPDATE generated_archive SET payload=? WHERE scope=? AND id=?', [JSON.stringify(entry), scopeKey(owner), entry.id]);
    expect(await archive.listGeneratedArchive(owner)).toEqual([entry]);
  });

  it('reads every scoped row across empty and partial batches with interleaved accounts', async () => {
    const owner = { ...scope, userId: 'batch-boundaries' }, other = { ...scope, userId: 'interleaved-owner' };
    const seed = (await archive.listGeneratedArchive(scope))[0];
    const { generatedKnowledgeDirectory } = await import('../server/files/knowledge_directory');
    const dir = generatedKnowledgeDirectory(owner), otherDir = generatedKnowledgeDirectory(other);
    expect(await archive.listGeneratedArchive(owner)).toEqual([]);
    expect(await archive.listGeneratedArchive(other)).toEqual([]);
    const entries = Array.from({ length: 769 }, (_, i) => ({ ...seed, userId: owner.userId,
      id: createHash('sha256').update('boundary-' + i).digest('hex'), filename: 'boundary-' + i + '.txt',
      displayName: '中文\n引号"与\\路径 ' + i, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i % 17)).toISOString(),
      extra: { note: 'preserve legacy metadata', values: [false, null, ''] },
      ...(i < 256 || i === 512 ? { deletedAt: '2026-10-01T00:00:00Z' } : {}) }));
    for (const entry of entries) fs.writeFileSync(path.join(dir, entry.filename), 'boundary');
    fs.writeFileSync(path.join(otherDir, 'foreign.txt'), 'foreign');
    const rows = entries.flatMap(entry => [entry, { ...entry, userId: other.userId, filename: 'foreign.txt' }]);
    await database.withDatabaseSqlWriteLock(async ({ run }) => {
      await run('BEGIN IMMEDIATE');
      try {
        for (let i = 0; i < rows.length; i += 40) {
          const batch = rows.slice(i, i + 40);
          await run('INSERT INTO generated_archive(scope,id,filename,sourcePath,sourceSize,sourceMtimeMs,createdAt,deletedAt,payload) VALUES '
            + batch.map(() => '(?,?,?,?,?,?,?,?,?)').join(','), batch.flatMap(entry => [scopeKey({ ...scope, userId: entry.userId }),
              entry.id, entry.filename, entry.sourcePath, entry.sourceSize, entry.sourceMtimeMs, entry.createdAt,
              entry.deletedAt || null, JSON.stringify(entry, null, 2)]));
        }
        await run('COMMIT');
      } catch (error) { await run('ROLLBACK'); throw error; }
    });
    const expected = entries.filter(entry => !entry.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    expect(expected).toHaveLength(512);
    const queries = vi.spyOn(database, 'querySQL');
    try {
      expect(await archive.listGeneratedArchive(owner)).toEqual(expected);
      const request = queries.mock.calls.find(([sql]) => sql.startsWith('WITH RECURSIVE batches'));
      expect(request).toBeDefined();
      const chunks = await database.querySQL<{ payload: string | null }>(request![0], request![1]);
      expect(chunks.map(row => JSON.parse(row.payload || '[]').length)).toEqual([0, 256, 255, 1]);
      const plan = await database.querySQL('EXPLAIN QUERY PLAN ' + request![0], request![1]);
      expect(JSON.stringify(plan)).toContain('idx_generated_archive_scope');
      expect(JSON.stringify(plan)).not.toContain('USE TEMP B-TREE');
      expect(await archive.listGeneratedArchive(owner)).toEqual(expected);
      expect(await archive.listGeneratedArchive(owner, entries[768].filename)).toEqual([entries[768]]);
      expect(await archive.listGeneratedArchive(owner, entries[255].filename)).toEqual([]);
      expect((await archive.listGeneratedArchive(other)).every(entry => entry.userId === other.userId)).toBe(true);
    } finally { queries.mockRestore(); }
    await database.runSQL('DELETE FROM generated_archive WHERE scope=?', [scopeKey(owner)]);
    expect(await archive.listGeneratedArchive(owner)).toEqual([]);
    expect(await archive.listGeneratedArchive(other)).toHaveLength(expected.length);
  });

  it('invalidates full lists after SQL changes and rollback, and never caches file existence or caller edits', async () => {
    const first = await archive.listGeneratedArchive(scope);
    expect(first.length).toBeGreaterThan(0);
    const selected = first[0], originalName = selected.displayName;
    selected.displayName = 'caller mutation';
    expect((await archive.listGeneratedArchive(scope)).find(item => item.id === selected.id)?.displayName).toBe(originalName);
    const params = [scopeKey(scope), selected.id];
    await database.withDatabaseSqlWriteLock(async ({ run }) => {
      await run('BEGIN IMMEDIATE');
      await run("UPDATE generated_archive SET payload=json_set(payload,'$.displayName','rolled back') WHERE scope=? AND id=?", params);
      await run('ROLLBACK');
    });
    expect((await archive.listGeneratedArchive(scope)).find(item => item.id === selected.id)?.displayName).toBe(originalName);
    await database.runSQL("UPDATE generated_archive SET payload=json_set(payload,'$.displayName','SQL update') WHERE scope=? AND id=?", params);
    expect((await archive.listGeneratedArchive(scope)).find(item => item.id === selected.id)?.displayName).toBe('SQL update');
    const { generatedKnowledgeDirectory } = await import('../server/files/knowledge_directory');
    const file = path.join(generatedKnowledgeDirectory(scope), selected.filename), bytes = fs.readFileSync(file);
    fs.unlinkSync(file);
    expect((await archive.listGeneratedArchive(scope)).some(item => item.id === selected.id)).toBe(false);
    fs.writeFileSync(file, bytes);
    expect((await archive.listGeneratedArchive(scope)).some(item => item.id === selected.id)).toBe(true);
  });
});
