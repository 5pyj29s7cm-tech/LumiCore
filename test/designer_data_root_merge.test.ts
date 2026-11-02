import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { applyLegalDataMerge, planLegalDataMerge } from '../scripts/merge-legal-data-root';
import { runDesignerDataMergeCli } from '../scripts/merge-designer-data-root';
import { designerDataMergeReceiptPath, legalDataMergeReceiptPath, resolveMigratedDataFile, assertLegacyDesignerDataMerged } from '../server/config/data_path';
import { claimDataRootForMigration } from '../server/runtime/data_root_lease';

const base = fs.mkdtempSync(path.join(process.env.LUMI_TEST_TMPDIR || os.tmpdir(), 'designer-merge-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const options = { sourceVariant: 'designer' as const, resolveKnownConflicts: true };
let sequence = 0;
function fixture(sourceSql = 'CREATE TABLE entries(id TEXT PRIMARY KEY,value TEXT);', targetSql = sourceSql) {
  const home = path.join(base, String(sequence++)), source = path.join(home, 'LumiCore-Designer'), target = path.join(home, 'LumiCore');
  const sql = (root: string, statement: string) => { const db = new DatabaseSync(path.join(root, 'data/lumi.db')); try { db.exec(statement); } finally { db.close(); } };
  for (const [root, statement] of [[source, sourceSql], [target, targetSql]]) { fs.mkdirSync(path.join(root, 'data'), { recursive: true }); sql(root, statement); }
  const rows = (root: string, table: string) => { const db = new DatabaseSync(path.join(root, 'data/lumi.db'), { readOnly: true }); try { return db.prepare('SELECT * FROM "' + table + '"').all(); } finally { db.close(); } };
  return { home, source, target, sql, rows, backup: path.join(base, 'backup-' + sequence) };
}

describe('explicit Designer offline shared-root maintenance', () => {
  it('accepts all six observed schema-only snapshots without importing user data', () => {
    const schemas = JSON.parse(fs.readFileSync(new URL('./fixtures/designer_legacy_merge_schema.json', import.meta.url), 'utf8')) as Record<string, { sourceSql: string; targetSql: string }>;
    const f = fixture(Object.values(schemas).map(value => value.sourceSql + ';').join('\n'), Object.values(schemas).map(value => value.targetSql + ';').join('\n'));
    const before = sha(path.join(f.source, 'data/lumi.db')), plan = planLegalDataMerge(f.source, f.target, options);
    expect(plan.conflicts).toEqual([]);
    expect(plan.schemaProjections!.map(value => value.table).sort()).toEqual(Object.keys(schemas).sort());
    expect(plan.tables.every(table => table.sourceRows === 0)).toBe(true);
    expect(sha(path.join(f.source, 'data/lumi.db'))).toBe(before);
  });

  it('binds the Designer variant, namespace, backup and unchanged source; old paths resolve only after verified merge', async () => {
    const f = fixture(); f.sql(f.source, "INSERT INTO entries VALUES('history','original');");
    const original = path.join(f.source, 'data/material.txt'); fs.writeFileSync(original, 'SYNTHETIC ORIGINAL');
    const drawing = path.join(f.source, 'data/drawing.dxf'); fs.writeFileSync(drawing, '0\nSECTION\n2\nSYNTHETIC CAD\n0\nENDSEC\n0\nEOF\n');
    const sourceBefore = sha(path.join(f.source, 'data/lumi.db'));
    const plan = planLegalDataMerge(f.source, f.target, options);
    expect(plan.sourceVariant).toBe('designer'); expect(plan.conflicts).toEqual([]);
    const result = await applyLegalDataMerge(plan, f.backup);
    expect(result.receiptPath).toBe(designerDataMergeReceiptPath(f.source, f.target));
    expect(fs.existsSync(legalDataMergeReceiptPath(f.source, f.target))).toBe(false);
    expect(fs.existsSync(path.join(f.backup, 'designer-source.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(f.backup, 'legal-source.sqlite'))).toBe(false);
    const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(f.backup, 'maintenance-manifest.json'), 'utf8'));
    expect(receipt.sourceVariant).toBe('designer'); expect(manifest.sourceVariant).toBe('designer');
    expect(sha(path.join(f.backup, 'source-files/drawing.dxf'))).toBe(sha(drawing));
    expect(sha(path.join(f.backup, 'source-files/material.txt'))).toBe(sha(original));
    expect(manifest.sourceFilesBackup).toHaveLength(2);
    expect(sha(path.join(f.source, 'data/lumi.db'))).toBe(sourceBefore);
    expect(f.rows(f.target, 'entries')).toEqual([{ id: 'history', value: 'original' }]);
    expect(resolveMigratedDataFile(original, f.target)).toBe(path.join(f.target, 'data/material.txt'));
    expect(() => assertLegacyDesignerDataMerged(f.home)).not.toThrow();
    expect((await applyLegalDataMerge(plan, f.backup)).phase).toBe('already_applied');
  });

  it('retains legacy plans and Legal receipt/backup names when no Designer option is supplied', async () => {
    const f = fixture(); f.sql(f.source, "INSERT INTO entries VALUES('old','original');");
    const plan = planLegalDataMerge(f.source, f.target);
    expect(plan).not.toHaveProperty('sourceVariant'); expect(plan).not.toHaveProperty('schemaProjections');
    const result = await applyLegalDataMerge(plan, f.backup);
    expect(result.receiptPath).toBe(legalDataMergeReceiptPath(f.source, f.target));
    expect(fs.existsSync(path.join(f.backup, 'legal-source.sqlite'))).toBe(true);
  });

  it('rejects variant tampering and the Designer CLI refuses a Legal-bound plan', async () => {
    const f = fixture(), legal = planLegalDataMerge(f.source, f.target), planFile = path.join(f.home, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify(legal));
    await expect(applyLegalDataMerge({ ...legal, sourceVariant: 'designer' }, f.backup)).rejects.toThrow(/digest/);
    await expect(runDesignerDataMergeCli(['--source-root', f.source, '--target-root', f.target, '--plan', planFile, '--apply', '--backup-dir', f.backup])).rejects.toThrow(/variant/);
    expect(fs.existsSync(f.backup)).toBe(false);
  });

  it('previews through the Designer CLI without changing either database', async () => {
    const f = fixture(); const before = [f.source, f.target].map(root => sha(path.join(root, 'data/lumi.db')));
    const planFile = path.join(f.home, 'designer-plan.json'), log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { await runDesignerDataMergeCli(['--source-root', f.source, '--target-root', f.target, '--plan', planFile, '--resolve-known-conflicts']); } finally { log.mockRestore(); }
    expect(JSON.parse(fs.readFileSync(planFile, 'utf8')).sourceVariant).toBe('designer');
    expect([f.source, f.target].map(root => sha(path.join(root, 'data/lumi.db')))).toEqual(before);
    expect(fs.existsSync(f.backup)).toBe(false);
  });

  it.each([
    ['command_center_plans', "membershipAuthorization TEXT NOT NULL DEFAULT '',authorizationBlockedReason TEXT NOT NULL DEFAULT ''", { membershipAuthorization: '', authorizationBlockedReason: '' }],
    ['conversation_action_receipts', "turnRowId TEXT NOT NULL DEFAULT '',externalMessageId TEXT NOT NULL DEFAULT ''", { turnRowId: '', externalMessageId: '' }],
    ['conversations', "surface TEXT NOT NULL DEFAULT 'chat'", { surface: 'chat' }],
    ['memories', 'embedding TEXT,embeddingNamespace TEXT,embeddingContentHash TEXT', { embedding: null, embeddingNamespace: null, embeddingContentHash: null }],
    ['reminders', "domain TEXT NOT NULL DEFAULT 'personal',orgId TEXT NOT NULL DEFAULT ''", { domain: 'personal', orgId: '' }],
  ])('projects only reviewed additive defaults for %s and preserves source bytes', async (name, extra, values) => {
    const f = fixture(`CREATE TABLE ${name}(id TEXT PRIMARY KEY,status TEXT,value TEXT);`, `CREATE TABLE ${name}(id TEXT PRIMARY KEY,status TEXT,value TEXT,${extra});`);
    f.sql(f.source, `INSERT INTO ${name} VALUES('old','completed','UNCHANGED');`);
    // Reminders use their actual terminal spelling; no scheduled action is resumed.
    if (name === 'reminders') f.sql(f.source, "UPDATE reminders SET status='fired';");
    const sourceBefore = sha(path.join(f.source, 'data/lumi.db')), plan = planLegalDataMerge(f.source, f.target, options);
    expect(plan.conflicts).toEqual([]); expect(plan.schemaProjections).toHaveLength(1);
    expect(plan.schemaProjections![0].defaults).toEqual(values);
    await applyLegalDataMerge(plan, f.backup);
    expect(f.rows(f.target, String(name))[0]).toMatchObject({ id: 'old', value: 'UNCHANGED', ...values });
    expect(sha(path.join(f.source, 'data/lumi.db'))).toBe(sourceBefore);
  });

  it('reorders named interaction columns without altering content or constraints', async () => {
    const f = fixture('CREATE TABLE interactions(id TEXT PRIMARY KEY,content TEXT NOT NULL,timestamp TEXT);', 'CREATE TABLE interactions(timestamp TEXT,id TEXT PRIMARY KEY,content TEXT NOT NULL);');
    f.sql(f.source, "INSERT INTO interactions VALUES('a','EXACT BODY','yesterday');");
    const plan = planLegalDataMerge(f.source, f.target, options);
    expect(plan.conflicts).toEqual([]); expect(plan.schemaProjections![0].reordered).toBe(true);
    await applyLegalDataMerge(plan, f.backup);
    expect(f.rows(f.target, 'interactions')).toEqual([{ timestamp: 'yesterday', id: 'a', content: 'EXACT BODY' }]);
  });

  it.each([
    ['unknown addition', "id TEXT PRIMARY KEY,value TEXT,surface TEXT NOT NULL DEFAULT 'chat',unknown TEXT"],
    ['required without default', 'id TEXT PRIMARY KEY,value TEXT,surface TEXT NOT NULL'],
    ['changed default literal', "id TEXT PRIMARY KEY,value TEXT,surface TEXT NOT NULL DEFAULT 'other'"],
    ['changed existing type', "id TEXT PRIMARY KEY,value INTEGER,surface TEXT NOT NULL DEFAULT 'chat'"],
    ['changed existing nullability', "id TEXT PRIMARY KEY,value TEXT NOT NULL,surface TEXT NOT NULL DEFAULT 'chat'"],
    ['changed unique constraint', "id TEXT PRIMARY KEY,value TEXT UNIQUE,surface TEXT NOT NULL DEFAULT 'chat'"],
    ['changed check constraint', "id TEXT PRIMARY KEY,value TEXT CHECK(value <> 'bad'),surface TEXT NOT NULL DEFAULT 'chat'"],
    ['dropped field', "id TEXT PRIMARY KEY,surface TEXT NOT NULL DEFAULT 'chat'"],
  ])('rejects %s and never writes a partial merge', async (_name, targetDefinition) => {
    const f = fixture('CREATE TABLE conversations(id TEXT PRIMARY KEY,value TEXT);', `CREATE TABLE conversations(${targetDefinition});`);
    const before = sha(path.join(f.target, 'data/lumi.db')), plan = planLegalDataMerge(f.source, f.target, options);
    expect(plan.conflicts).toContainEqual({ kind: 'schema_or_primary_key_mismatch', table: 'conversations' });
    await expect(applyLegalDataMerge(plan, f.backup)).rejects.toThrow(/conflicts/);
    expect(sha(path.join(f.target, 'data/lumi.db'))).toBe(before); expect(fs.existsSync(f.backup)).toBe(false);
  });

  it('requires both explicit Designer scope and reviewed policy for schema projection', () => {
    const f = fixture('CREATE TABLE conversations(id TEXT PRIMARY KEY);', "CREATE TABLE conversations(id TEXT PRIMARY KEY,surface TEXT NOT NULL DEFAULT 'chat');");
    expect(planLegalDataMerge(f.source, f.target, { resolveKnownConflicts: true }).conflicts).toHaveLength(1);
    expect(planLegalDataMerge(f.source, f.target, { sourceVariant: 'designer' }).conflicts).toHaveLength(1);
  });

  it('retains only the reviewed Main relay conflicts, archives complete old keys and never exposes values in the plan', async () => {
    const f = fixture(), sourceKeys = { RELAY_API_KEY: 'SYNTHETIC-OLD', RELAY_BASE_URL: 'https://old.invalid', EXTRA: 'SYNTHETIC-EXTRA' }, mainKeys = { RELAY_API_KEY: 'SYNTHETIC-MAIN', RELAY_BASE_URL: 'https://main.invalid' };
    fs.writeFileSync(path.join(f.source, 'data/keys.json'), JSON.stringify(sourceKeys)); fs.writeFileSync(path.join(f.target, 'data/keys.json'), JSON.stringify(mainKeys));
    expect(planLegalDataMerge(f.source, f.target, { resolveKnownConflicts: true }).conflicts).toHaveLength(1);
    const plan = planLegalDataMerge(f.source, f.target, options); expect(plan.conflicts).toEqual([]);
    expect(plan.files[0].retainedCurrentKeys).toEqual(['RELAY_API_KEY', 'RELAY_BASE_URL']); expect(JSON.stringify(plan)).not.toContain('SYNTHETIC');
    await applyLegalDataMerge(plan, f.backup);
    expect(JSON.parse(fs.readFileSync(path.join(f.target, 'data/keys.json'), 'utf8'))).toEqual({ ...mainKeys, EXTRA: sourceKeys.EXTRA });
    expect(JSON.parse(fs.readFileSync(path.join(f.backup, 'source-files/keys.json'), 'utf8'))).toEqual(sourceKeys);
  });

  it('keeps an unreviewed credential conflict blocked', () => {
    const f = fixture(); fs.writeFileSync(path.join(f.source, 'data/keys.json'), '{"OTHER":"old"}'); fs.writeFileSync(path.join(f.target, 'data/keys.json'), '{"OTHER":"current"}');
    expect(planLegalDataMerge(f.source, f.target, options).conflicts).toContainEqual({ kind: 'same_file_path_different_value', path: 'keys.json' });
  });

  const receiptFixture = (change: { requestId?: string; outcome?: string; payload?: string; createdAt?: string; completedAt?: string | null } = {}) => {
    const f = fixture('CREATE TABLE conversation_action_receipts(id TEXT PRIMARY KEY,taskId TEXT,requestId TEXT,outcome TEXT,envelope TEXT,createdAt TEXT);');
    const oldTime = '2026-08-14T09:52:38.348Z', currentTime = '2026-08-14T09:52:40.115Z';
    for (const root of [f.source, f.target]) {
      const old = root === f.source, timestamp = old ? change.createdAt ?? oldTime : currentTime;
      const db = new DatabaseSync(path.join(root, 'data/lumi.db'));
      try { db.prepare('INSERT INTO conversation_action_receipts VALUES(?,?,?,?,?,?)').run('same-event', 'same-task', old ? change.requestId ?? 'same-request' : 'same-request', old ? change.outcome ?? 'verified' : 'verified', JSON.stringify({ status: 'verified', result: { text: old ? change.payload ?? 'EXACT ORIGINAL' : 'EXACT ORIGINAL' }, ...(old && change.completedAt === null ? {} : { completedAt: old ? change.completedAt ?? timestamp : timestamp }) }), timestamp); } finally { db.close(); }
    }
    return f;
  };

  it('deduplicates only identical Designer receipts whose self-consistent ISO completion times differ, retaining Main', async () => {
    const f = receiptFixture(), current = f.rows(f.target, 'conversation_action_receipts');
    expect(planLegalDataMerge(f.source, f.target, { resolveKnownConflicts: true }).conflicts).toHaveLength(1);
    expect(planLegalDataMerge(f.source, f.target, { sourceVariant: 'designer' }).conflicts).toHaveLength(1);
    const plan = planLegalDataMerge(f.source, f.target, options); expect(plan.conflicts).toEqual([]);
    expect(plan.resolutions[0].strategy).toBe('retain_current_timestamp_only_receipt_duplicate');
    await applyLegalDataMerge(plan, f.backup);
    expect(f.rows(f.target, 'conversation_action_receipts')).toEqual(current);
    const backup = new DatabaseSync(path.join(f.backup, 'designer-source.sqlite'), { readOnly: true });
    try { expect(backup.prepare('SELECT createdAt FROM conversation_action_receipts').get()?.createdAt).toBe('2026-08-14T09:52:38.348Z'); } finally { backup.close(); }
  });

  it.each([
    ['different request', { requestId: 'another-request' }],
    ['different outcome', { outcome: 'failed' }],
    ['different nested original result', { payload: 'OTHER ORIGINAL' }],
    ['invalid timestamp', { createdAt: 'not-a-date' }],
    ['inconsistent completion time', { completedAt: '2026-08-14T09:52:39.000Z' }],
    ['missing completion time', { completedAt: null }],
  ])('keeps receipt %s conflicting', (_name, change) => {
    const f = receiptFixture(change);
    expect(planLegalDataMerge(f.source, f.target, options).conflicts[0]).toMatchObject({ kind: 'same_primary_key_different_value', table: 'conversation_action_receipts' });
  });

  it('retains stale-plan and active-backend lease fences', async () => {
    const f = fixture(), plan = planLegalDataMerge(f.source, f.target, options), held = claimDataRootForMigration(f.target, f.source);
    try { await expect(applyLegalDataMerge(plan, f.backup)).rejects.toThrow(); } finally { expect(held.releaseAt(f.target)).toBe(true); }
    f.sql(f.target, "INSERT INTO entries VALUES('new','changed');");
    await expect(applyLegalDataMerge(plan, f.backup)).rejects.toThrow(/changed since preflight/); expect(fs.existsSync(f.backup)).toBe(false);
  });

  it('rolls back a Designer UNIQUE failure and leaves both complete database backups', async () => {
    const f = fixture('CREATE TABLE entries(id TEXT PRIMARY KEY,value TEXT UNIQUE);'); f.sql(f.source, "INSERT INTO entries VALUES('old','same');"); f.sql(f.target, "INSERT INTO entries VALUES('main','same');");
    const plan = planLegalDataMerge(f.source, f.target, options); expect(plan.conflicts).toEqual([]);
    await expect(applyLegalDataMerge(plan, f.backup)).rejects.toThrow(/UNIQUE/);
    expect(f.rows(f.target, 'entries')).toEqual([{ id: 'main', value: 'same' }]);
    expect(fs.existsSync(path.join(f.backup, 'designer-source.sqlite'))).toBe(true); expect(fs.existsSync(path.join(f.backup, 'shared-before.sqlite'))).toBe(true);
  });

  it('recovers commit-before-receipt failure without duplicate Designer import', async () => {
    const f = fixture(); f.sql(f.source, "INSERT INTO entries VALUES('old','once');");
    const plan = planLegalDataMerge(f.source, f.target, options), receipt = designerDataMergeReceiptPath(f.source, f.target), originalLink = fs.linkSync;
    const fault = vi.spyOn(fs, 'linkSync').mockImplementation((...args: Parameters<typeof fs.linkSync>) => { if (String(args[1]) === receipt) throw new Error('synthetic publication fault'); return originalLink(...args); });
    try { await expect(applyLegalDataMerge(plan, f.backup)).rejects.toThrow(/synthetic publication/); } finally { fault.mockRestore(); }
    expect(f.rows(f.target, 'entries')).toHaveLength(1);
    expect((await applyLegalDataMerge(plan, f.backup)).phase).toBe('completed');
    expect(JSON.parse(fs.readFileSync(receipt, 'utf8'))).toMatchObject({ sourceVariant: 'designer', recoveredAfterCommit: true });
    expect(f.rows(f.target, 'entries')).toHaveLength(1);
  });
});
