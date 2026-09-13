import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

describe('Generated libraries across conversations', () => {
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
    expect(archive.listGeneratedArchive(scope).some(entry => entry.displayName === 'canonical.txt')).toBe(true);
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
    expect(archive.listGeneratedArchive(scope).some(item => item.id === entry.id)).toBe(false);
  });

  it('excludes reads, failed outputs, unverified paths, and explicit acceptance traffic', async () => {
    const source = create('excluded.txt');
    expect(await archive.archiveGeneratedOutputs([record(source, 'read_file')], scope)).toEqual([]);
    expect(await archive.archiveGeneratedOutputs([{ ...record(source), error: 'failed' }], scope)).toEqual([]);
    expect(await archive.archiveGeneratedOutputs([{ ...record(source), terminalVerification: undefined }], scope)).toEqual([]);
    expect(await archive.archiveGeneratedOutputs([record(source)], { ...scope, source: 'e2e-formal-client' })).toEqual([]);
  });

  it('separates personal owners and rejects organization writes without membership', async () => {
    const entries = archive.listGeneratedArchive(scope);
    expect((await api('/files/list', { headers: { Cookie: cookie('other-owner') } })).status).toBe(200);
    expect((await (await api('/files/list', { headers: { Cookie: cookie('other-owner') } })).json()).files).toEqual([]);
    expect((await api(`/files/download/${entries[0].filename}`, { headers: { Cookie: cookie('other-owner') } })).status).toBe(404);
    expect((await api('/files/list', { headers: {} })).status).toBe(401);
    await expect(archive.archiveGeneratedOutputs([record(create('org-private.txt'))], { ...scope, domain: 'work', orgId: 'unjoined' })).rejects.toThrow('access');
  });

  it('backfills verified historical results without copying unrelated conversations or failed outputs', async () => {
    const source = create('historical.txt'), excluded = create('historical-failed.txt');
    const db = database.readDB();
    db.conversations.push({ id: 'history-owner', userId: scope.userId, domain: 'personal', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() } as any);
    db.interactions.push({ id: 'history-receipt', userId: scope.userId, conversationId: 'history-owner', source: 'desktop-chat', timestamp: new Date().toISOString(), toolCalls: JSON.stringify([record(source), { ...record(excluded), error: 'failed' }]) } as any);
    expect((await api('/files/archive-generated', { method: 'POST' })).status).toBe(200);
    const entries = archive.listGeneratedArchive(scope);
    expect(entries.some(entry => entry.displayName === 'historical.txt')).toBe(true);
    expect(entries.some(entry => entry.displayName === 'historical-failed.txt')).toBe(false);
  });
});
