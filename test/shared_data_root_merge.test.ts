import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { planLegalDataMerge, applyLegalDataMerge } from '../scripts/merge-legal-data-root';
import { assertLegacyLegalDataMerged, resolveDefaultDataRoot, legalDataMergeReceiptPath, resolveMigratedDataFile } from '../server/config/data_path';
import { claimDataRootForMigration } from '../server/runtime/data_root_lease';

const base = fs.mkdtempSync(path.join(process.env.LUMI_TEST_TMPDIR || os.tmpdir(), 'shared-legal-merge-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
const sha = (filename: string) => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
function fixture(name: string) {
  const home = path.join(base, name); const source = path.join(home, 'LumiCore-Legal'); const target = path.join(home, 'LumiCore');
  for (const root of [source, target]) {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const db = new DatabaseSync(path.join(root, 'data', 'lumi.db'));
    db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT UNIQUE); CREATE TABLE autonomous_tasks (id TEXT PRIMARY KEY, status TEXT, payload TEXT); CREATE TABLE pending_tool_confirmations (id TEXT PRIMARY KEY, status TEXT); CREATE TABLE conversations (id TEXT PRIMARY KEY, actionContinuationState TEXT); CREATE TABLE conversation_action_turns (id TEXT PRIMARY KEY, status TEXT); CREATE TABLE external_commit_journal (idempotencyKey TEXT PRIMARY KEY, state TEXT, replayResult TEXT);");
    db.close();
  }
  const sql = (root: string, text: string) => { const db = new DatabaseSync(path.join(root, 'data', 'lumi.db')); try { db.exec(text); } finally { db.close(); } };
  const rows = (root: string, table: string) => { const db = new DatabaseSync(path.join(root, 'data', 'lumi.db'), { readOnly: true }); try { return db.prepare('SELECT * FROM ' + table).all(); } finally { db.close(); } };
  return { home, source, target, sql, rows, backup: path.join(base, name + '-backup') };
}

describe('shared Main / Legal storage maintenance', () => {
  it('shares the fresh default and explicitly blocks hidden historical Legal data without creating Main', () => {
    const home = path.join(base, 'historical-only'); const legal = path.join(home, 'LumiCore-Legal', 'data');
    fs.mkdirSync(legal, { recursive: true }); fs.writeFileSync(path.join(legal, 'important.txt'), 'historical material');
    expect(resolveDefaultDataRoot(home)).toBe(path.join(home, 'LumiCore'));
    expect(() => assertLegacyLegalDataMerged(home)).toThrow(/explicit reviewed merge/);
    expect(fs.existsSync(path.join(home, 'LumiCore'))).toBe(false);
    expect(fs.readFileSync(path.join(legal, 'important.txt'), 'utf8')).toBe('historical material');
  });

  it('preflights real SQLite read-only and never includes credential values in the plan', () => {
    const f = fixture('readonly'); f.sql(f.source, "INSERT INTO entries VALUES ('legal', 'source material');");
    fs.writeFileSync(path.join(f.source, 'data', 'keys.json'), JSON.stringify({ TEST_ONLY_KEY: 'FAKE-LOCAL-NOT-A-REAL-SECRET' }));
    const before = [sha(path.join(f.source, 'data', 'lumi.db')), sha(path.join(f.target, 'data', 'lumi.db'))];
    const plan = planLegalDataMerge(f.source, f.target);
    expect(plan.tables.find(table => table.name === 'entries')?.insertRows).toBe(1);
    expect(plan.conflicts).toEqual([]); expect(JSON.stringify(plan)).not.toContain('FAKE-LOCAL-NOT-A-REAL-SECRET');
    expect([sha(path.join(f.source, 'data', 'lumi.db')), sha(path.join(f.target, 'data', 'lumi.db'))]).toEqual(before);
    expect(fs.existsSync(path.join(f.target, 'runtime'))).toBe(false);
  });


  it('releases SQLite read locks before hashing files and rejects the resulting stale plan', async () => {
    const f = fixture('preflight-live-writer');
    const material = path.join(f.source, 'data', 'material.txt'); fs.writeFileSync(material, 'material snapshot');
    const openFile = fs.openSync; let writes = 0;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]) === material && writes === 0) {
        for (const root of [f.source, f.target]) {
          const writer = new DatabaseSync(path.join(root, 'data', 'lumi.db'));
          try { writer.exec("PRAGMA busy_timeout=20; INSERT INTO entries VALUES ('during-file-hash', 'live update');"); writes++; } finally { writer.close(); }
        }
      }
      return openFile(...args);
    });
    let plan: ReturnType<typeof planLegalDataMerge>;
    try { plan = planLegalDataMerge(f.source, f.target); } finally { spy.mockRestore(); }
    expect(writes).toBe(2);
    expect(f.rows(f.target, 'entries')).toEqual([{ id: 'during-file-hash', value: 'live update' }]);
    await expect(applyLegalDataMerge(plan!, f.backup)).rejects.toThrow(/changed since preflight/);
    expect(fs.existsSync(f.backup)).toBe(false);
  });

  it('ignores schema layout quoting but preserves meaningful SQL literal differences', () => {
    const f = fixture('schema-layout');
    f.sql(f.source, "CREATE TABLE formatting (id TEXT PRIMARY KEY, content TEXT DEFAULT 'keep literal spaces');");
    f.sql(f.target, 'CREATE TABLE "formatting" (\n id TEXT PRIMARY KEY,\n content TEXT DEFAULT \'keep literal spaces\'\n);');
    expect(planLegalDataMerge(f.source, f.target).conflicts).toEqual([]);
    f.sql(f.target, "DROP TABLE formatting; CREATE TABLE formatting (id TEXT PRIMARY KEY, content TEXT DEFAULT 'keepliteralspaces');");
    expect(planLegalDataMerge(f.source, f.target).conflicts).toEqual([{ kind: 'schema_or_primary_key_mismatch', table: 'formatting' }]);
  });

  it('archives dependency links without following or recreating them in the shared root', async () => {
    const f = fixture('dependency-link'); const outside = path.join(base, 'dependency-original'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'must-not-copy.txt'), 'original dependency');
    fs.mkdirSync(path.join(f.source, 'data', 'skills', 'example'), { recursive: true });
    fs.symlinkSync(outside, path.join(f.source, 'data', 'skills', 'example', 'node_modules'), 'junction');
    const plan = planLegalDataMerge(f.source, f.target); expect(plan.files.find(file => file.link)?.action).toBe('archive');
    await applyLegalDataMerge(plan, f.backup);
    expect(fs.existsSync(path.join(f.target, 'data', 'skills', 'example', 'node_modules'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'must-not-copy.txt'), 'utf8')).toBe('original dependency');
  }, 30000);


  it('blocks copied JSON indexes with historical absolute paths instead of rewriting fileId or SHA references', () => {
    const f = fixture('legacy-file-reference'); const original = JSON.stringify({ outputPath: path.join(f.source, 'data', 'material.mp4'), fileId: 'preserve-file-id', sha256: 'preserve-source-sha' }, null, 2);
    fs.writeFileSync(path.join(f.source, 'data', 'index.json'), original);
    const plan = planLegalDataMerge(f.source, f.target);
    expect(plan.conflicts).toContainEqual({ kind: 'legacy_json_path_reference_requires_review', path: 'index.json' });
    expect(fs.readFileSync(path.join(f.source, 'data', 'index.json'), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(f.target, 'data', 'index.json'))).toBe(false);
  });

  it('refuses conflicting primary keys and same-path files rather than overwriting Main', async () => {
    const f = fixture('conflicts'); f.sql(f.source, "INSERT INTO entries VALUES ('same', 'Legal');"); f.sql(f.target, "INSERT INTO entries VALUES ('same', 'Main');");
    for (const root of [f.source, f.target]) fs.writeFileSync(path.join(root, 'data', 'material.txt'), root === f.source ? 'Legal original' : 'Main original');
    const before = sha(path.join(f.target, 'data', 'lumi.db')); const plan = planLegalDataMerge(f.source, f.target);
    expect(plan.conflicts.map(row => row.kind)).toEqual(expect.arrayContaining(['same_primary_key_different_value', 'same_file_path_different_value']));
    await expect(applyLegalDataMerge(plan, f.backup)).rejects.toThrow(/conflicts/);
    expect(sha(path.join(f.target, 'data', 'lumi.db'))).toBe(before); expect(fs.readFileSync(path.join(f.target, 'data', 'material.txt'), 'utf8')).toBe('Main original');
    expect(fs.existsSync(f.backup)).toBe(false);
  }, 30000);

  it('rejects a stale bound plan when either data root changed', async () => {
    const f = fixture('stale'); f.sql(f.source, "INSERT INTO entries VALUES ('source', 'original');"); const plan = planLegalDataMerge(f.source, f.target);
    f.sql(f.target, "INSERT INTO entries VALUES ('later', 'current Main');");
    await expect(applyLegalDataMerge(plan, f.backup)).rejects.toThrow(/changed since preflight/);
    expect(f.rows(f.target, 'entries')).toEqual([{ id: 'later', value: 'current Main' }]); expect(fs.existsSync(f.backup)).toBe(false);
  }, 30000);

  it('backs up transactionally, preserves external truth and archives unsettled work without replay', async () => {
    const f = fixture('apply');
    f.sql(f.source, "INSERT INTO entries VALUES ('legal', 'source material'); INSERT INTO autonomous_tasks VALUES ('pending-task', 'running', '{\"original\":true}'), ('finished-task', 'completed', '{}'); INSERT INTO pending_tool_confirmations VALUES ('exact-unapproved', 'pending'); INSERT INTO conversation_action_turns VALUES ('old-terminal', 'terminal'); INSERT INTO conversations VALUES ('history', '{\"taskId\":\"pending-task\"}'); INSERT INTO external_commit_journal VALUES ('real-commit', 'unknown', 'original raw receipt');");
    fs.writeFileSync(path.join(f.source, 'data', 'keys.json'), JSON.stringify({ SHARED: 'SYNTHETIC-SAME', LEGAL_ONLY: 'SYNTHETIC-NEW' }));
    fs.writeFileSync(path.join(f.target, 'data', 'keys.json'), JSON.stringify({ SHARED: 'SYNTHETIC-SAME', MAIN_ONLY: 'SYNTHETIC-KEEP' }));
    fs.writeFileSync(path.join(f.source, 'data', 'local_identity.json'), 'must never become current native authority');
    fs.mkdirSync(path.join(f.source, 'data', 'media-generation-tasks')); fs.writeFileSync(path.join(f.source, 'data', 'media-generation-tasks', 'old.json'), '{"status":"running"}');
    fs.writeFileSync(path.join(f.source, 'data', 'material.txt'), 'legal content');
    const sourceBefore = sha(path.join(f.source, 'data', 'lumi.db')); const plan = planLegalDataMerge(f.source, f.target);
    expect(plan.deferred).toHaveLength(2); expect(plan.continuationPointers).toHaveLength(1);
    const result = await applyLegalDataMerge(plan, f.backup);
    expect(result.phase).toBe('completed'); expect(f.rows(f.target, 'entries')).toEqual([{ id: 'legal', value: 'source material' }]);
    expect(f.rows(f.target, 'autonomous_tasks')).toEqual([{ id: 'finished-task', status: 'completed', payload: '{}' }]); expect(f.rows(f.target, 'pending_tool_confirmations')).toEqual([]);
    expect(f.rows(f.target, 'conversation_action_turns')).toEqual([{ id: 'old-terminal', status: 'terminal' }]);
    expect(f.rows(f.target, 'conversations')).toEqual([{ id: 'history', actionContinuationState: '{}' }]);
    expect(f.rows(f.target, 'external_commit_journal')).toEqual([{ idempotencyKey: 'real-commit', state: 'unknown', replayResult: 'original raw receipt' }]);
    expect(sha(path.join(f.source, 'data', 'lumi.db'))).toBe(sourceBefore);
    expect(fs.existsSync(path.join(f.target, 'data', 'local_identity.json'))).toBe(false); expect(fs.existsSync(path.join(f.target, 'data', 'media-generation-tasks'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(f.target, 'data', 'keys.json'), 'utf8'))).toEqual({ SHARED: 'SYNTHETIC-SAME', MAIN_ONLY: 'SYNTHETIC-KEEP', LEGAL_ONLY: 'SYNTHETIC-NEW' });
    const archived = new DatabaseSync(path.join(f.backup, 'legal-source.sqlite'), { readOnly: true });
    expect(archived.prepare('SELECT status FROM autonomous_tasks WHERE id=?').get('pending-task')?.status).toBe('running'); expect(archived.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok'); archived.close();
    const manifest = JSON.parse(fs.readFileSync(path.join(f.backup, 'maintenance-manifest.json'), 'utf8')); expect(manifest.deferred).toHaveLength(2); expect(JSON.stringify(manifest)).not.toContain('SYNTHETIC-NEW');
    expect(() => assertLegacyLegalDataMerged(f.home)).not.toThrow();
    expect((await applyLegalDataMerge(plan, f.backup)).phase).toBe('already_applied'); expect(f.rows(f.target, 'entries')).toHaveLength(1);
    fs.writeFileSync(path.join(f.source, 'data', 'later-change.txt'), 'old application changed again'); expect(() => assertLegacyLegalDataMerged(f.home)).toThrow(/explicit reviewed merge/);
  }, 30000);


  it('recovers a committed merge whose final receipt publication failed without importing twice', async () => {
    const f = fixture('receipt-recovery'); f.sql(f.source, "INSERT INTO entries VALUES ('legal', 'only once');");
    const plan = planLegalDataMerge(f.source, f.target); const expectedReceipt = legalDataMergeReceiptPath(f.source, f.target);
    const originalLink = fs.linkSync; const fault = vi.spyOn(fs, 'linkSync').mockImplementation((...args: Parameters<typeof fs.linkSync>) => {
      if (String(args[1]) === expectedReceipt) throw new Error('synthetic receipt publication fault');
      return originalLink(...args);
    });
    try { await expect(applyLegalDataMerge(plan, f.backup)).rejects.toThrow(/synthetic receipt publication fault/); }
    finally { fault.mockRestore(); }
    expect(f.rows(f.target, 'entries')).toHaveLength(1); expect(fs.existsSync(expectedReceipt)).toBe(false);
    expect((await applyLegalDataMerge(plan, f.backup)).phase).toBe('completed'); expect(f.rows(f.target, 'entries')).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(expectedReceipt, 'utf8')).recoveredAfterCommit).toBe(true);
    expect((await applyLegalDataMerge(plan, f.backup)).phase).toBe('already_applied');
  }, 30000);

  it('respects the same exclusive lease used by a live backend', async () => {
    const f = fixture('lease'); const plan = planLegalDataMerge(f.source, f.target); const held = claimDataRootForMigration(f.target, f.source);
    try { await expect(applyLegalDataMerge(plan, f.backup)).rejects.toThrow(); expect(fs.existsSync(f.backup)).toBe(false); }
    finally { expect(held.releaseAt(f.target)).toBe(true); }
  }, 30000);

  it('rolls back the live transaction on an existing UNIQUE constraint conflict', async () => {
    const f = fixture('transaction'); f.sql(f.target, "INSERT INTO entries VALUES ('main', 'same-unique-value');"); f.sql(f.source, "INSERT INTO entries VALUES ('legal', 'same-unique-value');");
    const plan = planLegalDataMerge(f.source, f.target); expect(plan.conflicts).toEqual([]);
    await expect(applyLegalDataMerge(plan, f.backup)).rejects.toThrow(/UNIQUE constraint/);
    expect(f.rows(f.target, 'entries')).toEqual([{ id: 'main', value: 'same-unique-value' }]);
    expect(fs.existsSync(path.join(f.backup, 'legal-source.sqlite'))).toBe(true); expect(fs.existsSync(path.join(f.backup, 'shared-before.sqlite'))).toBe(true);
    expect(() => assertLegacyLegalDataMerged(f.home)).toThrow(/explicit reviewed merge/);
  }, 30000);

  it('resolves reviewed business owners while preserving Main authentication and original task receipts', async () => {
    const f = fixture('reviewed-business');
    for (const root of [f.source, f.target]) f.sql(root, 'CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE users(uid TEXT PRIMARY KEY,password TEXT); CREATE TABLE conversation_action_tasks(id TEXT PRIMARY KEY,conversationId TEXT,userId TEXT,domain TEXT,orgId TEXT,rootUserMessageId TEXT,parentTaskId TEXT,goal TEXT,intentKind TEXT,operation TEXT,target TEXT,status TEXT,revision INTEGER,context TEXT);');
    const setting = (root: string, key: string, value: unknown) => { const db = new DatabaseSync(path.join(root, 'data/lumi.db')); try { db.prepare('INSERT INTO settings VALUES (?,?)').run(key, JSON.stringify(value)); } finally { db.close(); } };
    setting(f.target, '__lumi_collection:knowledgeFiles', [{ filename: 'main.txt', userId: 'owner', domain: 'personal', orgId: '' }]);
    setting(f.source, '__lumi_collection:knowledgeFiles', [{ filename: 'legal.txt', userId: 'owner', domain: 'personal', orgId: '' }]);
    setting(f.source, '__lumi_collection:autonomousWorkflows', [{ id: 'old-enabled', userId: 'owner', enabled: true }]);
    f.sql(f.target, `INSERT INTO users VALUES ('owner','MAIN-AUTH'); INSERT INTO conversation_action_tasks VALUES ('same','conv','owner','personal','','message','','same goal','file','read','target','completed',9,'{"receiptId":"MAIN-RAW"}');`);
    f.sql(f.source, `INSERT INTO users VALUES ('owner','LEGAL-AUTH'); INSERT INTO conversation_action_tasks VALUES ('same','conv','owner','personal','','message','','same goal','file','read','target','completed',2,'{"receiptId":"LEGAL-RAW"}'); INSERT INTO autonomous_tasks VALUES ('old-blocked','blocked','{"status":"blocked"}'),('old-paused','paused','{"status":"paused"}');`);
    const original = JSON.stringify({ path: path.join(f.source, 'data/material.pdf'), text: 'The original contract body remains exact.' });
    const db = new DatabaseSync(path.join(f.source, 'data/lumi.db')); db.prepare('INSERT INTO entries VALUES (?,?)').run('raw-document', original); db.close();
    const strict = planLegalDataMerge(f.source, f.target); expect(strict.conflicts.length).toBeGreaterThan(0);
    const plan = planLegalDataMerge(f.source, f.target, { resolveKnownConflicts: true }); expect(plan.conflicts).toEqual([]);
    expect(plan.deferred).toEqual([]); await applyLegalDataMerge(plan, f.backup);
    expect(f.rows(f.target, 'users')).toEqual([{ uid: 'owner', password: 'MAIN-AUTH' }]);
    expect(f.rows(f.target, 'conversation_action_tasks')[0]).toMatchObject({ revision: 9, context: '{"receiptId":"MAIN-RAW"}' });
    expect(f.rows(f.target, 'entries')).toContainEqual({ id: 'raw-document', value: original });
    const saved = f.rows(f.target, 'settings'); expect(JSON.parse(String(saved.find(row => row.key === '__lumi_collection:knowledgeFiles')?.value))).toHaveLength(2);
    expect(JSON.parse(String(saved.find(row => row.key === '__lumi_collection:autonomousWorkflows')?.value))).toEqual([{ id: 'old-enabled', userId: 'owner', enabled: false }]);
    expect(f.rows(f.target, 'autonomous_tasks').map(row => row.status).sort()).toEqual(['blocked', 'paused']);
    expect((await applyLegalDataMerge(plan, f.backup)).phase).toBe('already_applied');
  }, 30000);

  it('refuses a different task goal, cross-owner item or unreviewed business setting even with the reviewed policy', () => {
    const f = fixture('reviewed-still-denied');
    for (const root of [f.source, f.target]) f.sql(root, 'CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE conversation_action_tasks(id TEXT PRIMARY KEY,goal TEXT,revision INTEGER,status TEXT);');
    f.sql(f.source, `INSERT INTO settings VALUES ('unknown_business','{"important":"Legal"}'),('work_takeover_tasks_v1','[{"id":"same","userId":"other-owner"}]'); INSERT INTO conversation_action_tasks VALUES ('same-task','different goal',9,'completed');`);
    f.sql(f.target, `INSERT INTO settings VALUES ('unknown_business','{"important":"Main"}'),('work_takeover_tasks_v1','[{"id":"same","userId":"owner"}]'); INSERT INTO conversation_action_tasks VALUES ('same-task','original goal',2,'completed');`);
    expect(planLegalDataMerge(f.source, f.target, { resolveKnownConflicts: true }).conflicts).toHaveLength(3);
  });

  it('merges real case identities with tombstones, preserves original bodies and archives old runtime files', async () => {
    const f = fixture('reviewed-case-files');
    const put = (root: string, relative: string, value: unknown) => { const file = path.join(root, 'data', relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
    const baseCase = { id: 'same', orgId: 'personal:owner', updatedAt: '2026-10-20T00:00:00Z', notes: path.join(f.source, 'data/not-a-rewritten-prose.pdf') };
    put(f.target, 'org/legal_cases.json', { cases: [{ ...baseCase, removedMaterialIds: ['deleted'], materials: [{ id: 'main', content: 'MAIN ORIGINAL' }], workflowRuns: [] }] });
    put(f.source, 'org/legal_cases.json', { cases: [{ ...baseCase, materials: [{ id: 'deleted', content: 'STALE DELETED' }, { id: 'legal', content: 'LEGAL ORIGINAL' }], workflowRuns: [{ id: 'current-run', materialIds: ['legal'] }, { id: 'stale-run', materialIds: ['deleted'] }] }, { id: 'unique-legal', orgId: 'personal:owner', materials: [{ id: 'only-legal', content: 'COMPLETE BODY' }] }] });
    put(f.target, 'mcp_config.json', { mcpServers: {} }); put(f.source, 'mcp_config.json', { mcpServers: { oldConnector: { enabled: true, command: 'must-not-start' } } });
    put(f.source, 'skills/old/index.json', { executable: 'old dependency' }); put(f.source, 'web_login/profiles.json', { profiles: ['old browser'] });
    put(f.source, 'generated/.video-assembly-test/progress.json', { status: 'running' });
    const before = sha(path.join(f.source, 'data/org/legal_cases.json'));
    const plan = planLegalDataMerge(f.source, f.target, { resolveKnownConflicts: true }); expect(plan.conflicts).toEqual([]);
    await applyLegalDataMerge(plan, f.backup);
    const cases = JSON.parse(fs.readFileSync(path.join(f.target, 'data/org/legal_cases.json'), 'utf8')).cases;
    expect(cases).toHaveLength(2); expect(cases[0].materials.map((row: { id: string }) => row.id).sort()).toEqual(['legal', 'main']);
    expect(cases[0].workflowRuns.map((row: { id: string }) => row.id)).toEqual(['current-run']); expect(cases[0].notes).toBe(baseCase.notes);
    expect(sha(path.join(f.source, 'data/org/legal_cases.json'))).toBe(before);
    expect(JSON.parse(fs.readFileSync(path.join(f.target, 'data/mcp_config.json'), 'utf8')).mcpServers.oldConnector.enabled).toBe(false);
    for (const name of ['skills/old/index.json', 'web_login/profiles.json', 'generated/.video-assembly-test/progress.json']) {
      expect(fs.existsSync(path.join(f.target, 'data', name))).toBe(false); expect(fs.existsSync(path.join(f.backup, 'source-files', name))).toBe(true);
    }
    expect(JSON.parse(fs.readFileSync(path.join(f.backup, 'shared-files-before/org/legal_cases.json'), 'utf8')).cases).toHaveLength(1);
  }, 30000);

  it('does not import queued messages as fresh inputs or erase an ambiguous material version', () => {
    const f = fixture('reviewed-queued-message');
    for (const root of [f.source, f.target]) { fs.mkdirSync(path.join(root, 'data/messaging')); fs.writeFileSync(path.join(root, 'data/messaging/message_journal.json'), root === f.source ? '[{"key":"received-one","status":"received","inboundMessage":{"text":"must not replay"}}]' : '[]'); }
    expect(planLegalDataMerge(f.source, f.target, { resolveKnownConflicts: true }).conflicts).toContainEqual({ kind: 'same_file_path_different_value', path: 'messaging/message_journal.json' });
  });

  it('resolves original paths only through the completed target receipt and refuses changed or unmerged files', async () => {
    const f = fixture('reviewed-original-path'); const original = path.join(f.source, 'data/material.pdf');
    fs.writeFileSync(original, 'UNCHANGED ORIGINAL PDF BYTES');
    expect(() => resolveMigratedDataFile(original, f.target)).toThrow(/explicit reviewed merge/);
    const plan = planLegalDataMerge(f.source, f.target, { resolveKnownConflicts: true }); await applyLegalDataMerge(plan, f.backup);
    expect(resolveMigratedDataFile(original, f.target)).toBe(path.join(f.target, 'data/material.pdf'));
    fs.writeFileSync(path.join(f.target, 'data/material.pdf'), 'CHANGED TARGET'); expect(() => resolveMigratedDataFile(original, f.target)).toThrow(/changed after merge/);
    fs.writeFileSync(path.join(f.target, 'data/material.pdf'), 'UNCHANGED ORIGINAL PDF BYTES'); fs.writeFileSync(path.join(f.source, 'data/later.txt'), 'OLD APP CHANGED');
    expect(() => resolveMigratedDataFile(original, f.target)).toThrow(/Historical Legal data changed/);
  }, 30000);

  it('keeps ambiguous material versions blocked rather than choosing a convenient snapshot', () => {
    const f = fixture('reviewed-ambiguous-material');
    for (const root of [f.source, f.target]) {
      fs.mkdirSync(path.join(root, 'data/org'));
      fs.writeFileSync(path.join(root, 'data/org/legal_cases.json'), JSON.stringify({ cases: [{ id: 'case', orgId: 'personal:owner', materials: [{ id: 'material', content: root === f.source ? 'LEGAL ORIGINAL' : 'MAIN ORIGINAL' }] }] }));
    }
    expect(planLegalDataMerge(f.source, f.target, { resolveKnownConflicts: true }).conflicts).toContainEqual({ kind: 'same_file_path_different_value', path: 'org/legal_cases.json' });
  });

  it('keeps the newest complete statute check and rejects ambiguous or invalid authority times', async () => {
    const f = fixture('reviewed-statute-owner');
    for (const root of [f.source, f.target]) f.sql(root, 'CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);');
    const older = { title: 'Fixture statute', status: 'verified', checkedAt: '2026-10-10T00:00:00.000Z', fingerprint: 'same-source-version' };
    const newer = { ...older, checkedAt: '2026-10-19T00:00:00.000Z', originalText: { text: 'FULL ORIGINAL STATUTE TEXT — preserve every byte.', sha256: 'source-snapshot-fingerprint' } };
    const put = (root: string, check: unknown, at: string) => { const db = new DatabaseSync(path.join(root, 'data/lumi.db')); try { db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('legal_statute_authority_refresh_v1', JSON.stringify({ version: 1, lastRunAt: at, lastSuccessfulRunAt: at, checks: { fixture: check }, runs: [] })); } finally { db.close(); } };
    put(f.target, older, older.checkedAt); put(f.source, { ...newer, checkedAt: 'not-a-date' }, newer.checkedAt);
    expect(planLegalDataMerge(f.source, f.target, { resolveKnownConflicts: true }).conflicts).toHaveLength(1);
    put(f.source, { ...newer, checkedAt: older.checkedAt }, older.checkedAt);
    expect(planLegalDataMerge(f.source, f.target, { resolveKnownConflicts: true }).conflicts).toHaveLength(1);
    put(f.source, newer, newer.checkedAt);
    const plan = planLegalDataMerge(f.source, f.target, { resolveKnownConflicts: true }); expect(plan.conflicts).toEqual([]);
    await applyLegalDataMerge(plan, f.backup);
    const stored = JSON.parse(String(f.rows(f.target, 'settings')[0].value));
    expect(stored.checks.fixture).toEqual(newer); expect(JSON.stringify(stored.checks.fixture.originalText)).toBe(JSON.stringify(newer.originalText));
    expect(stored.lastRunAt).toBe(newer.checkedAt); expect(stored.lastSuccessfulRunAt).toBe(newer.checkedAt);
  }, 30000);
});
