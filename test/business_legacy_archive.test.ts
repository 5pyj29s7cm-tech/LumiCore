import './helpers';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, makeApp } from './helpers';
import { mountIndustryWorkflowRoutes } from '../server/routes/industry_workflow_routes';
import { getDataPath } from '../server/config/data_path';
import { importBusinessLegacyArchive, readBusinessLegacyArchive } from '../server/industry/legacy_archive';

describe('retired business profile archive', () => {
  it('imports only the owner personal history, preserves artifacts, and never imports credentials or active tasks', async () => {
    const root = getDataPath('legacy-source-fixture'); fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const artifact = path.join(root, 'report.txt'); fs.writeFileSync(artifact, 'Business report fixture');
    const db = new sqlite3.Database(path.join(root, 'data/lumi.db'));
    const run = (sql: string, args: unknown[] = []) => new Promise<void>((resolve, reject) => db.run(sql, args, error => error ? reject(error) : resolve()));
    await run('CREATE TABLE users (uid TEXT, password TEXT)');
    await run('CREATE TABLE conversations (id TEXT, userId TEXT, domain TEXT, orgId TEXT, title TEXT)');
    await run('CREATE TABLE settings (key TEXT, value TEXT)');
    await run('INSERT INTO users VALUES (?,?)', ['legacy-owner', 'never-copy-this']);
    await run('INSERT INTO conversations VALUES (?,?,?,?,?)', ['mine', 'legacy-owner', 'personal', '', 'My archive']);
    await run('INSERT INTO conversations VALUES (?,?,?,?,?)', ['other', 'other-user', 'personal', '', 'Private']);
    await run('INSERT INTO conversations VALUES (?,?,?,?,?)', ['org', 'legacy-owner', 'work', 'org-a', 'Work']);
    await run('INSERT INTO settings VALUES (?,?)', ['work_takeover_tasks_v1', JSON.stringify([{ id: 'old-task', userId: 'legacy-owner', domain: 'personal', orgId: '', status: 'in_progress', artifacts: [{ path: artifact }] }])]);
    await run('INSERT INTO settings VALUES (?,?)', ['industry_workspace_contexts_v1', JSON.stringify({ items: [] })]);
    await run('INSERT INTO settings VALUES (?,?)', ['apiKey', 'never-copy-this-either']);
    await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    const imported = await importBusinessLegacyArchive('legacy-owner', 'finance', root);
    expect(imported.tables.conversations.map(row => row.id)).toEqual(['mine']);
    expect(JSON.stringify(imported)).not.toContain('never-copy');
    expect(imported.tasks[0].status).toBe('in_progress'); // historical state only
    expect(fs.readFileSync(imported.artifacts[0].path, 'utf8')).toBe('Business report fixture');
    expect((await importBusinessLegacyArchive('legacy-owner', 'finance', root)).importedAt).toBe(imported.importedAt);
    expect(readBusinessLegacyArchive('another-user', 'finance')).toBeNull();
    await expect(importBusinessLegacyArchive('another-user', 'finance', root)).rejects.toThrow('matching local account');
    const app = await makeApp(); mountIndustryWorkflowRoutes(app.apiRouter);
    try {
      const resource = `${app.url}/api/files/business-archive/finance/${imported.artifacts[0].sha256}?preview=1`;
      const auth = (uid: string) => ({ Authorization: `Bearer ${jwt.sign({ uid, role: 'user' }, JWT_SECRET)}` });
      const own = await fetch(resource, { headers: auth('legacy-owner') });
      expect(own.status).toBe(200);
      expect((await own.json()).text).toContain('Business report fixture');
      expect((await fetch(resource, { headers: auth('another-user') })).status).toBe(404);
      expect((await fetch(resource)).status).toBe(401);
    } finally { app.cleanup(); }
  });
});
