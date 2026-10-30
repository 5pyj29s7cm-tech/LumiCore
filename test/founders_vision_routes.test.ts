import jwt from 'jsonwebtoken';
import sqlite3 from 'sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';
import { mountMiscRoutes } from '../server/routes/misc_routes';
import { requireLocalRequest } from '../server/middleware/auth';
import * as database from '../db_layer';
import { getDataPath } from '../server/config/data_path';

const admin = jwt.sign({ uid: 'founder-admin-fixture', username: 'fixture', role: 'admin' }, JWT_SECRET);
const member = jwt.sign({ uid: 'founder-member-fixture', username: 'fixture', role: 'user' }, JWT_SECRET);
const branch = jwt.sign({ uid: 'founder-branch-fixture', role: 'admin', tokenType: 'organization_branch', orgId: 'synthetic-org', branchId: 'synthetic-branch' }, JWT_SECRET);
let url = '';
let close = () => {};
const auth = (token = admin) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const write = (body: unknown, token = admin, extra = {}) => fetch(`${url}/api/founder/vision`, { method: 'POST', headers: { ...auth(token), ...extra }, body: JSON.stringify(body) });
const read = async () => (await fetch(`${url}/api/founder/vision`, { headers: auth() })).json();
const readPersisted = () => new Promise<Array<{ content: string; updatedAt: string }>>((resolve, reject) => {
  const reader = new sqlite3.Database(getDataPath('lumi.db'), sqlite3.OPEN_READONLY);
  reader.all('SELECT content,updatedAt FROM founder_vision', (error, rows: Array<{ content: string; updatedAt: string }>) => {
    reader.close(closeError => error || closeError ? reject(error || closeError) : resolve(rows));
  });
});

beforeAll(async () => {
  const app = await makeApp();
  url = app.url; close = app.cleanup;
  mountMiscRoutes(app.apiRouter, JWT_SECRET, LLM_GETTERS);
});
afterAll(() => close());

describe('founder vision API on isolated fixture database', () => {
  it('requires a user session and system administrator for both reads and writes', async () => {
    for (const method of ['GET', 'POST']) {
      const anonymous = await fetch(`${url}/api/founder/vision`, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ vision: 'synthetic' }) } : {}) });
      expect(anonymous.status).toBe(401);
      const nonAdmin = await fetch(`${url}/api/founder/vision`, { method, headers: auth(member), ...(method === 'POST' ? { body: JSON.stringify({ vision: 'synthetic' }) } : {}) });
      expect(nonAdmin.status).toBe(403);
    }
  });

  it('rejects branch credentials even if they claim system administrator role', async () => {
    expect((await fetch(`${url}/api/founder/vision`, { headers: auth(branch) })).status).toBe(403);
    expect((await write({ vision: 'must not persist' }, branch)).status).toBe(403);
  });

  it('rejects a remote socket instead of trusting forwarded loopback headers', () => {
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    requireLocalRequest({ socket: { remoteAddress: '203.0.113.10' }, headers: { 'x-forwarded-for': '127.0.0.1' } } as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('persists exact Unicode text and reads it back after successful flush', async () => {
    const vision = 'Synthetic founder fixture\n\u7ec4\u7ec7\u613f\u666f \ud83c\udf31';
    const response = await write({ vision });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(await read()).toEqual({ vision });
    const rows = await readPersisted();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(vision);
    expect(Number.isNaN(Date.parse(String(rows[0].updatedAt)))).toBe(false);
  });

  it.each([{}, { vision: null }, { vision: 42 }, { vision: 'x'.repeat(20_001) }])('rejects invalid input without replacing saved vision: %#', async body => {
    const before = await read();
    expect((await write(body)).status).toBe(400);
    expect(await read()).toEqual(before);
  });

  it('accepts the exact text length boundary and an explicit empty value', async () => {
    const vision = 'x'.repeat(20_000);
    expect((await write({ vision })).status).toBe(200);
    expect(await read()).toEqual({ vision });
    expect((await write({ vision: '' })).status).toBe(200);
    expect(await read()).toEqual({ vision: '' });
  });

  it('rejects an untrusted browser mutation before persistence', async () => {
    const before = await read();
    const response = await write({ vision: 'untrusted fixture' }, admin, { Origin: 'https://untrusted.example.test' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'UNTRUSTED_ORIGIN' });
    expect(await read()).toEqual(before);
  });

  it('reports a persistence failure instead of returning a successful receipt', async () => {
    const flush = vi.spyOn(database, 'flushDBOrThrow').mockRejectedValueOnce(new Error('synthetic persistence failure'));
    try {
      const response = await write({ vision: 'failed persistence fixture' });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'synthetic persistence failure' });
    } finally { flush.mockRestore(); }
  });
});
