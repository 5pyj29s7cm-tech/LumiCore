/** Offline maintenance only. Never import db_layer or replay application work. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync, backup, type SQLOutputValue, type SQLInputValue } from 'node:sqlite';
import { claimDataRootForMigration, releaseDataRootLease } from '../server/runtime/data_root_lease';
import { legacyLegalDataFingerprint, legalDataMergeReceiptPath } from '../server/config/data_path';
import { ensurePrivateRuntimeDirectory, restrictOwnerAccess } from '../server/config/runtime_file_security';

type Row = Record<string, SQLOutputValue>;
interface Table { name: string; sql: string; schema: string; columns: string[]; pk: string[]; rows: Row[]; digest: string }
interface FileEntry { path: string; sha256: string; bytes: number; link?: boolean; action: 'copy' | 'identical' | 'conflict' | 'archive' | 'merge-keys' | 'merge-owner'; additions?: number }
export interface LegalDataMergePlan {
  version: 1; resolutionPolicy?: 'shared_history_v1'; resolutions: Array<{ table?: string; path?: string; pkDigest?: string; strategy: string }>; sourceRoot: string; targetRoot: string; sourceFingerprint: string; inputDigest: string;
  tables: Array<{ name: string; sourceRows: number; insertRows: number; identicalRows: number; archivedRows: number; conflicts: number; pk: string[] }>;
  conflicts: Array<{ kind: string; table?: string; path?: string; pkDigest?: string }>;
  files: FileEntry[]; deferred: Array<{ table: string; pkDigest: string; originalStatus: string }>;
  continuationPointers: Array<{ table: string; pkDigest: string }>;
  databaseDigests: { source: string; target: string }; expectedDatabaseDigest: string;
}
const schemaTokens = (sql: string) => sql.slice(sql.indexOf('(')).match(/'(?:''|[^'])*'|"(?:""|[^"])*"|\x60(?:\x60\x60|[^\x60])*\x60|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|[^\s]/g) || [];
const terminal = new Set(['completed', 'failed', 'cancelled', 'canceled', 'superseded']);
const workTables = new Set(['autonomous_tasks', 'pending_tool_confirmations', 'reminders', 'external_ai_history_sync_jobs', 'conversation_action_tasks', 'conversation_action_turns', 'command_center_plans', 'org_work_items', 'org_work_approvals', 'org_work_handoffs']);
const archiveFile = (name: string) => /^(?:local_identity\.json|evidence_identity\.json|keys\.json\.bak|\.migration_skip)$/.test(name)
  || /^(?:media-generation-tasks|legal_document_progress|lap)\//.test(name);
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? { sqliteBigInt: String(item) } : item instanceof Uint8Array ? { sqliteBlob: Buffer.from(item).toString('base64') } : item);
const digest = (value: unknown): string => crypto.createHash('sha256').update(stable(value)).digest('hex');
const quote = (name: string) => '"' + name.replace(/"/g, '""') + '"';
const key = (row: Row, table: Table) => stable(table.pk.map(column => row[column]));
const businessDatabaseDigest = (values: Table[]): string => digest(values.filter(table => table.name !== 'generated_archive_scopes').map(table => [table.name, table.sql, [...table.rows].sort((a, b) => stable(a).localeCompare(stable(b)))]));
const fileDigest = (filename: string): string => {
  const hash = crypto.createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filename, 'r');
  try { let length: number; while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
};
function copyPrivateFile(source: string, destination: string): void {
  ensurePrivateRuntimeDirectory(path.dirname(destination));
  const input = fs.openSync(source, 'r'); let output: number | undefined;
  try {
    output = fs.openSync(destination, 'wx', 0o600); const buffer = Buffer.allocUnsafe(1024 * 1024);
    let length: number; while ((length = fs.readSync(input, buffer, 0, buffer.length, null))) {
      for (let offset = 0; offset < length;) offset += fs.writeSync(output, buffer, offset, length - offset);
    }
    fs.fsyncSync(output);
  } catch (error) { if (output !== undefined) { fs.closeSync(output); output = undefined; fs.unlinkSync(destination); } throw error; }
  finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
}
function safeRoot(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('Both data roots must be explicit absolute paths.');
  const root = path.resolve(value); let cursor = root;
  for (;;) { const stat = fs.lstatSync(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Data roots must not cross symbolic links.'); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
  return fs.realpathSync.native(root);
}
function roots(source: string, target: string) {
  const sourceRoot = safeRoot(source); const targetRoot = safeRoot(target);
  const a = sourceRoot.toLowerCase() + path.sep; const b = targetRoot.toLowerCase() + path.sep;
  if (a.startsWith(b) || b.startsWith(a)) throw new Error('Source and target roots must be separate non-nested directories.');
  return { sourceRoot, targetRoot };
}
function open(root: string, readOnly = true): DatabaseSync {
  safeRoot(path.join(root, 'data'));
  const filename = path.join(root, 'data', 'lumi.db'); const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SQLite database must be a real existing regular file.');
  const db = new DatabaseSync(filename, { readOnly }); db.exec('PRAGMA busy_timeout=5000'); return db;
}
function tables(db: DatabaseSync): Table[] {
  return db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(meta => {
    const name = String(meta.name); const columns = db.prepare('PRAGMA table_info(' + quote(name) + ')').all();
    const statement = db.prepare('SELECT * FROM ' + quote(name)); statement.setReadBigInts(true);
    const rows = statement.all() as Row[];
    const table = { name, sql: String(meta.sql), schema: digest(schemaTokens(String(meta.sql))), columns: columns.map(column => String(column.name)), pk: columns.filter(column => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(column => String(column.name)), rows, digest: '' };
    table.rows.sort((a, b) => stable(a).localeCompare(stable(b))); table.digest = digest([table.sql, table.rows]); return table;
  });
}
function reroot(value: string, source: string, target: string): string {
  const normalized = value.replace(/\\/g, '/'); const prefix = source.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalized.toLowerCase() === prefix.toLowerCase() || normalized.toLowerCase().startsWith(prefix.toLowerCase() + '/')) return target + normalized.slice(prefix.length).replace(/\//g, path.sep);
  try { const parsed: unknown = JSON.parse(value); const walk = (node: unknown): unknown => typeof node === 'string' ? reroot(node, source, target) : Array.isArray(node) ? node.map(walk) : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)])) : node; if (parsed && typeof parsed === 'object') { const updated = walk(parsed); if (stable(updated) !== stable(parsed)) return JSON.stringify(updated); } } catch { /* Ordinary text is never rewritten by substring. */ }
  return value;
}
function normalizedRow(row: Row, table: Table, source: string, target: string, policy = false): Row {
  if (policy && table.name === 'settings' && row.key === 'legal_statute_authority_refresh_v1') return { ...row, value: JSON.stringify(mergeSetting(String(row.key), json(row.value), { version: 1, lastRunAt: null, lastSuccessfulRunAt: null, checks: {}, runs: [] })) };
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [column,
    table.name === 'conversations' && column === 'actionContinuationState' ? '{}' : policy && table.name === 'settings' && row.key === '__lumi_collection:autonomousWorkflows' && column === 'value' ? JSON.stringify(mergeOwnedArray(json(value), [], 'autonomousWorkflows')) : !policy && typeof value === 'string' ? reroot(value, source, target) : value]));
}
function defer(table: Table, row: Row, policy = false): boolean {
  const status = String(row.status || '').toLowerCase();
  if (policy && (table.name === 'conversation_action_tasks' && status === 'blocked' || table.name === 'autonomous_tasks' && ['blocked', 'paused'].includes(status))) return false;
  if (table.name === 'conversation_action_turns' && status === 'terminal') return false;
  if (table.name === 'pending_tool_confirmations') return !['consumed', 'expired', 'denied', 'rejected'].includes(status);
  if (table.name === 'reminders') return !['fired', 'cancelled', 'canceled'].includes(status);
  return workTables.has(table.name) && !terminal.has(status);
}
function fileEntries(root: string): Array<{ path: string; sha256: string; bytes: number; link?: boolean }> {
  const found: Array<{ path: string; sha256: string; bytes: number; link?: boolean }> = [];
  const visit = (directory: string) => { for (const name of fs.readdirSync(directory).sort()) { const filename = path.join(directory, name); const stat = fs.lstatSync(filename); if (stat.isSymbolicLink()) { found.push({ path: path.relative(path.join(root, 'data'), filename).replace(/\\/g, '/'), sha256: digest(fs.readlinkSync(filename)), bytes: stat.size, link: true }); continue; } if (stat.isDirectory()) visit(filename); else if (stat.isFile()) { const relative = path.relative(path.join(root, 'data'), filename).replace(/\\/g, '/'); if (!/^lumi\.db(?:-(?:wal|shm|journal))?$/.test(relative)) found.push({ path: relative, sha256: fileDigest(filename), bytes: stat.size }); } else throw new Error('Unsupported data file type.'); } };
  visit(path.join(root, 'data')); return found;
}
function checkedDataFile(root: string, relative: string): string | null {
  const base = path.join(root, 'data'); const filename = path.resolve(base, relative);
  const parts = path.relative(base, filename).split(path.sep);
  if (parts[0] === '..' || path.isAbsolute(path.relative(base, filename))) throw new Error('Data file escaped its root.');
  let cursor = base;
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]); if (!fs.existsSync(cursor)) return null; const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory() || index === parts.length - 1 && !stat.isFile()) throw new Error('Destination file path crosses a link or incompatible file type.');
  }
  return filename;
}
function mergedKeys(source: string, target: string): { value: Record<string, unknown>; additions: number; conflict: boolean } {
  const a: unknown = JSON.parse(fs.readFileSync(source, 'utf8')); const b: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) throw new Error('keys.json must contain an object.');
  const value = { ...b } as Record<string, unknown>; let additions = 0; let conflict = false;
  for (const [name, item] of Object.entries(a)) { if (Object.hasOwn(value, name)) { if (stable(value[name]) !== stable(item)) conflict = true; } else { value[name] = item; additions++; } }
  return { value, additions, conflict };
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const json = (value: unknown): unknown => { try { return JSON.parse(String(value)); } catch { return undefined; } };
function mergeOwnedArray(source: unknown, target: unknown, owner: string): unknown[] {
  if (!Array.isArray(source) || !Array.isArray(target)) throw new Error('Invalid owned collection: ' + owner);
  const identity = (value: unknown): string => {
    if (!object(value)) return digest(value);
    if (owner === 'knowledgeFiles') return stable([value.filename, value.userId, value.domain || 'personal', value.orgId || '']);
    if (owner === 'definitions') return stable([value.workflowId, value.version, value.userId, value.scope]);
    return String(value.id || value.runId || value.key || digest(value));
  };
  const result = new Map(target.map(value => [identity(value), value]));
  for (const incoming of source) {
    const id = identity(incoming), current = result.get(id);
    if (current === undefined) { result.set(id, owner === 'autonomousWorkflows' && object(incoming) ? { ...incoming, enabled: false } : incoming); continue; }
    if (stable(current) === stable(incoming)) continue;
    if (!object(current) || !object(incoming)) throw new Error('Incompatible owned collection: ' + owner);
    for (const field of ['userId', 'ownerUid', 'domain', 'orgId', 'scopeId', 'workflowId']) {
      if (String(current[field] || '') !== String(incoming[field] || '')) throw new Error('Cross-owner collection identity: ' + owner);
    }
    if (owner === 'materials' && current.content !== incoming.content) throw new Error('Incompatible material versions');
    if (owner === 'definitions' && current.hash !== incoming.hash) throw new Error('Workflow definition hash conflict');
    if (owner === 'autonomousWorkflows') continue; // Existing Main enablement remains authoritative.
    const newer = String(incoming.updatedAt || incoming.createdAt || '') > String(current.updatedAt || current.createdAt || '') ? incoming : current;
    result.set(id, newer);
  }
  return [...result.values()];
}
function mergeSetting(name: string, incoming: unknown, current: unknown): unknown {
  const collections: Record<string, string> = {
    '__lumi_collection:knowledgeFiles': 'knowledgeFiles', '__lumi_collection:plans': 'plans',
    '__lumi_collection:autonomousWorkflows': 'autonomousWorkflows', 'lumi.named_workflows.v2': 'namedWorkflows',
    'work_takeover_tasks_v1': 'takeoverTasks', 'capability_learning_records_v1': 'learning', '__lumi_system_snapshots': 'snapshots',
  };
  if (collections[name]) return mergeOwnedArray(incoming, current, collections[name]);
  if (name === 'lumi.workflow_runtime.v1' && object(incoming) && object(current)) return { ...incoming, ...current,
    definitions: mergeOwnedArray(incoming.definitions, current.definitions, 'definitions'), runs: mergeOwnedArray(incoming.runs, current.runs, 'runs') };
  if (name === 'industry_workspace_contexts_v1' && object(incoming) && object(current)) return { ...incoming, ...current, items: mergeOwnedArray(incoming.items, current.items, 'workspaces') };
  if ((name === 'industry_workspace_active_v1' || name.startsWith('scoped_deletion_receipts_')) && object(incoming) && object(current)) return { ...incoming, ...current };
  if (name === 'legal_statute_authority_refresh_v1' && object(incoming) && object(current)) {
    const time = (value: unknown, optional = false): number => {
      if (optional && value === null) return 0;
      const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
      if (!Number.isFinite(timestamp)) throw new Error('Invalid statute authority timestamp');
      return timestamp;
    };
    for (const state of [incoming, current]) { time(state.lastRunAt, true); time(state.lastSuccessfulRunAt, true); }
    if (!object(incoming.checks) || !object(current.checks)) throw new Error('Invalid statute authority checks');
    const checks = { ...current.checks };
    for (const [title, check] of Object.entries(incoming.checks)) {
      if (!object(check)) throw new Error('Invalid statute authority check');
      const checkedAt = time(check.checkedAt), before = checks[title];
      if (before !== undefined) {
        if (!object(before)) throw new Error('Invalid current statute authority check');
        const beforeAt = time(before.checkedAt);
        if (checkedAt === beforeAt && stable(check) !== stable(before)) throw new Error('Ambiguous same-time statute authority versions');
        if (checkedAt <= beforeAt) continue;
      }
      checks[title] = check; // Keep the complete observed snapshot, including its exact original text.
    }
    const latest = time(incoming.lastRunAt, true) > time(current.lastRunAt, true) ? incoming : current;
    return { ...latest, checks, runs: mergeOwnedArray(incoming.runs, current.runs, 'authorityRuns') };
  }
  // Only reviewed runtime settings retain Main. Unknown business settings remain explicit conflicts.
  if (/^(?:emotion_|him_|(?:vision|world|retrieval_model|llm|generation)_prefs_|voice_preference$|(?:ollama|lmstudio)_config$|provider_probe_|scheduler_task_runtime_state_v1$|autonomous_.*_last_run:|lumi_sleep_cycle_state_|memory_test_provenance_repair_v1$|learning_evidence_repair_v2$|__lumi_system_flags$|__lumi_collection:skillDownloads$)/.test(name)) return current;
  throw new Error('Unreviewed setting owner');
}
function resolvedRow(table: Table, incoming: Row, current: Row, policy: boolean): Row | undefined {
  if (!policy) return undefined;
  if (table.name === 'users' || table.name === 'founder_vision' || table.name === 'generated_archive_scopes') return current;
  if (table.name === 'settings') return { ...current, value: JSON.stringify(mergeSetting(String(incoming.key), json(incoming.value), json(current.value))) };
  if (table.name === 'conversation_action_tasks') {
    if (!['conversationId', 'userId', 'domain', 'orgId', 'rootUserMessageId', 'parentTaskId', 'goal', 'intentKind', 'operation', 'target'].every(field => incoming[field] === current[field])) return undefined;
    return Number(incoming.revision) > Number(current.revision) ? incoming : current;
  }
  return undefined;
}
function resolvedJsonFile(relative: string, source: string, target: string): unknown {
  const incoming: unknown = JSON.parse(fs.readFileSync(source, 'utf8')), current: unknown = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : relative === 'org/legal_cases.json' ? { cases: [] } : relative.startsWith('messaging/') ? [] : {};
  if (relative === 'org/legal_cases.json' && object(incoming) && object(current)) {
    if (!Array.isArray(incoming.cases) || !Array.isArray(current.cases)) throw new Error('Invalid case store');
    const cases = new Map(current.cases.map(row => { if (!object(row)) throw new Error('Invalid case'); return [stable([row.orgId, row.id]), row]; }));
    for (const value of incoming.cases) {
      if (!object(value)) throw new Error('Invalid case'); const id = stable([value.orgId, value.id]), previous = cases.get(id);
      if (!previous) { cases.set(id, value); continue; }
      const removed = [...new Set([...(Array.isArray(previous.removedMaterialIds) ? previous.removedMaterialIds : []), ...(Array.isArray(value.removedMaterialIds) ? value.removedMaterialIds : [])])];
      const retained = (items: unknown) => Array.isArray(items) ? items.filter(item => object(item) && !removed.includes(item.id)) : [];
      const materials = mergeOwnedArray(retained(value.materials), retained(previous.materials), 'materials');
      const runs = mergeOwnedArray(value.workflowRuns || [], previous.workflowRuns || [], 'caseRuns').filter(item => object(item) && (!Array.isArray(item.materialIds) || !item.materialIds.some(id => removed.includes(id))));
      const newer = String(value.updatedAt || '') > String(previous.updatedAt || '') ? value : previous;
      cases.set(id, { ...newer, materials, workflowRuns: runs, removedMaterialIds: removed });
    }
    return { ...incoming, ...current, cases: [...cases.values()] };
  }
  if (relative === 'mcp_config.json' && object(incoming) && object(current)) {
    const servers = { ...(object(current.mcpServers) ? current.mcpServers : {}) };
    for (const [name, config] of Object.entries(object(incoming.mcpServers) ? incoming.mcpServers : {})) if (!Object.hasOwn(servers, name)) servers[name] = object(config) ? { ...config, enabled: false } : config;
    return { ...incoming, ...current, mcpServers: servers };
  }
  if (relative === 'messaging.json' && object(incoming) && object(current)) {
    const result = { ...incoming, ...current };
    const configured = (value: unknown) => object(value) && Object.entries(value).some(([name, item]) => /secret|token/iu.test(name) && typeof item === 'string' && item.length > 0);
    for (const [name, value] of Object.entries(incoming)) if (!configured(current[name]) && configured(value)) result[name] = value;
    return result;
  }
  if (new RegExp('^messaging/(?:delivery_receipts|message_journal)[.]json$').test(relative)) {
    if (!Array.isArray(incoming) || !Array.isArray(current)) throw new Error('Invalid message history');
    if (incoming.some(row => !object(row) || ['received', 'processing'].includes(String(row.status)))) throw new Error('Unsettled message history needs reconciliation');
    return mergeOwnedArray(incoming, current, 'messageHistory');
  }
  throw new Error('No reviewed file merge owner');
}

export function planLegalDataMerge(source: string, target: string, options: { resolveKnownConflicts?: boolean } = {}): LegalDataMergePlan {
  const policy = options.resolveKnownConflicts === true;
  const { sourceRoot, targetRoot } = roots(source, target); const sourceDb = open(sourceRoot); const targetDb = open(targetRoot);
  try {
    sourceDb.exec('BEGIN'); targetDb.exec('BEGIN');
    const sourceTables = tables(sourceDb); const targetTables = tables(targetDb);
    // Snapshot rows only; filesystem hashing must never hold the live SQLite read lock.
    sourceDb.exec('ROLLBACK'); targetDb.exec('ROLLBACK');
    const targetByName = new Map(targetTables.map(table => [table.name, table]));
    const expectedTables = targetTables.map(table => ({ ...table, rows: [...table.rows] }));
    const expectedByName = new Map(expectedTables.map(table => [table.name, table]));
    const plan: LegalDataMergePlan = { version: 1, ...(policy ? { resolutionPolicy: 'shared_history_v1' as const } : {}), resolutions: [], sourceRoot, targetRoot, sourceFingerprint: legacyLegalDataFingerprint(sourceRoot), inputDigest: '', tables: [], files: [], conflicts: [], deferred: [], continuationPointers: [], databaseDigests: { source: digest(sourceTables.map(table => [table.name, table.digest])), target: digest(targetTables.map(table => [table.name, table.digest])) }, expectedDatabaseDigest: '' };
    for (const table of sourceTables) {
      const other = targetByName.get(table.name); const stat = { name: table.name, sourceRows: table.rows.length, insertRows: 0, identicalRows: 0, archivedRows: 0, conflicts: 0, pk: table.pk };
      plan.tables.push(stat);
      if (!other || table.schema !== other.schema || table.pk.length === 0) { plan.conflicts.push({ kind: 'schema_or_primary_key_mismatch', table: table.name }); stat.conflicts++; continue; }
      const existing = new Map(other.rows.map(row => [key(row, table), row]));
      for (const original of table.rows) {
        const pkDigest = digest(key(original, table));
        if (defer(table, original, policy)) { stat.archivedRows++; plan.deferred.push({ table: table.name, pkDigest, originalStatus: String(original.status || '') }); continue; }
        let row: Row; try { row = normalizedRow(original, table, sourceRoot, targetRoot, policy); } catch { stat.conflicts++; plan.conflicts.push({ kind: 'invalid_known_owner_record', table: table.name, pkDigest }); continue; }
        const current = existing.get(key(row, table));
        if (current) { if (stable(current) === stable(row)) stat.identicalRows++; else {
          let resolved: Row | undefined; try { resolved = resolvedRow(table, row, current, policy); } catch { /* Invalid business identities remain conflicts. */ }
          if (resolved) { const expected = expectedByName.get(table.name)!; expected.rows[expected.rows.findIndex(item => key(item, table) === key(row, table))] = resolved; stat.identicalRows++; plan.resolutions.push({ table: table.name, pkDigest, strategy: table.name === 'settings' ? 'merge_existing_setting_owner' : 'retain_current_identity_or_newer_compatible_task' }); }
          else { stat.conflicts++; plan.conflicts.push({ kind: 'same_primary_key_different_value', table: table.name, pkDigest }); }
        } }
        else { expectedByName.get(table.name)!.rows.push(row); stat.insertRows++; if (table.name === 'conversations' && String(original.actionContinuationState || '{}') !== '{}') plan.continuationPointers.push({ table: table.name, pkDigest }); }
      }
    }
    for (const file of fileEntries(sourceRoot)) {
      const reviewedArchive = policy && /^(?:web_login|skills|private|runtime|quarantine|generated-library)\//.test(file.path) || policy && /^generated\/\.video-assembly-[^/]+\/progress\.json$/.test(file.path);
      const targetFile = file.link || archiveFile(file.path) || reviewedArchive ? null : checkedDataFile(targetRoot, file.path);
      const other = !file.link && targetFile ? { sha256: fileDigest(targetFile) } : undefined; let action: FileEntry['action'] = file.link || archiveFile(file.path) || reviewedArchive ? 'archive' : !other ? 'copy' : file.sha256 === other.sha256 ? 'identical' : 'conflict'; let additions: number | undefined;
      if (action === 'conflict' && file.path === 'keys.json') { const merged = mergedKeys(path.join(sourceRoot, 'data', file.path), path.join(targetRoot, 'data', file.path)); if (!merged.conflict) { action = 'merge-keys'; additions = merged.additions; } }
      if (policy && ['conflict', 'copy'].includes(action) && /^(?:org\/legal_cases|mcp_config|messaging|messaging\/(?:delivery_receipts|message_journal))\.json$/.test(file.path)) {
        try { resolvedJsonFile(file.path, path.join(sourceRoot, 'data', file.path), path.join(targetRoot, 'data', file.path)); action = 'merge-owner'; plan.resolutions.push({ path: file.path, strategy: 'merge_existing_file_owner' }); } catch { /* Unsettled or incompatible records stay blocked. */ }
      }
      if (!policy && action !== 'archive' && action !== 'conflict' && file.path.endsWith('.json')) {
        const raw = file.bytes <= 64 * 1024 * 1024 ? fs.readFileSync(path.join(sourceRoot, 'data', file.path), 'utf8') : null;
        if (raw === null || reroot(raw, sourceRoot, targetRoot) !== raw) { action = 'conflict'; plan.conflicts.push({ kind: 'legacy_json_path_reference_requires_review', path: file.path }); }
      }
      plan.files.push({ ...file, action, ...(additions === undefined ? {} : { additions }) });
      if (action === 'conflict' && !plan.conflicts.some(conflict => conflict.path === file.path)) plan.conflicts.push({ kind: 'same_file_path_different_value', path: file.path });
    }
    plan.expectedDatabaseDigest = businessDatabaseDigest(expectedTables);
    plan.inputDigest = digest({ ...plan, inputDigest: '' }); return plan;
  } finally { sourceDb.close(); targetDb.close(); }
}
function privateJson(filename: string, value: unknown): void {
  ensurePrivateRuntimeDirectory(path.dirname(filename)); const temporary = filename + '.tmp-' + crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); restrictOwnerAccess(temporary);
  try { fs.linkSync(temporary, filename); } finally { fs.rmSync(temporary, { force: true }); }
}
export async function applyLegalDataMerge(plan: LegalDataMergePlan, backupDirectory: string): Promise<{ phase: string; receiptPath: string }> {
  if (plan.version !== 1 || plan.inputDigest !== digest({ ...plan, inputDigest: '' })) throw new Error('Plan digest is invalid.');
  if (!path.isAbsolute(backupDirectory)) throw new Error('Backup directory must be absolute.');
  const backupRoot = path.resolve(backupDirectory); safeRoot(path.dirname(backupRoot));
  const { sourceRoot, targetRoot } = roots(plan.sourceRoot, plan.targetRoot); const receiptPath = legalDataMergeReceiptPath(sourceRoot, targetRoot);
  if (fs.existsSync(receiptPath)) {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    if (receipt.phase === 'completed' && receipt.inputDigest === plan.inputDigest && receipt.sourceFingerprint === legacyLegalDataFingerprint(sourceRoot)) return { phase: 'already_applied', receiptPath };
    throw new Error('A different or stale merge receipt exists; inspect it before continuing.');
  }
  const leases: Array<{ root: string; lease: ReturnType<typeof claimDataRootForMigration> }> = [];
  const createdFiles: Array<{ path: string; sha256: string }> = []; const changedFiles = new Map<string, Buffer>(); let keyBackup: Buffer | undefined; let committed = false; let sourceDb: DatabaseSync | undefined; let targetDb: DatabaseSync | undefined;
  try {
    for (const root of [sourceRoot, targetRoot].sort()) leases.push({ root, lease: claimDataRootForMigration(root, root === sourceRoot ? targetRoot : sourceRoot) });
    const policy = plan.resolutionPolicy === 'shared_history_v1';
    const current = planLegalDataMerge(sourceRoot, targetRoot, { resolveKnownConflicts: policy });
    if (current.inputDigest !== plan.inputDigest) {
      // A crash after COMMIT but before publishing the immutable receipt must not repeat imports.
      const preparedPath = path.join(backupDirectory, 'maintenance-manifest.json');
      const prepared = fs.existsSync(preparedPath) ? JSON.parse(fs.readFileSync(preparedPath, 'utf8')) as Record<string, unknown> : null;
      const complete = current.conflicts.length === 0 && current.databaseDigests.source === plan.databaseDigests.source
        && current.sourceFingerprint === plan.sourceFingerprint && current.tables.every(table => table.insertRows === 0)
        && current.files.every(file => file.action === 'identical' || file.action === 'archive' || file.action === 'merge-keys' && file.additions === 0 || file.action === 'merge-owner' && stable(resolvedJsonFile(file.path, path.join(sourceRoot, 'data', file.path), path.join(targetRoot, 'data', file.path))) === stable(JSON.parse(fs.readFileSync(path.join(targetRoot, 'data', file.path), 'utf8'))));
      if (!complete || !prepared || prepared.phase !== 'prepared' || prepared.inputDigest !== plan.inputDigest
        || prepared.sourceRoot !== sourceRoot || prepared.targetRoot !== targetRoot
        || prepared.sourceBackup !== path.join(backupDirectory, 'legal-source.sqlite')
        || prepared.sourceBackupSha256 !== fileDigest(path.join(backupDirectory, 'legal-source.sqlite'))
        || prepared.targetBackup !== path.join(backupDirectory, 'shared-before.sqlite')
        || prepared.targetBackupSha256 !== fileDigest(path.join(backupDirectory, 'shared-before.sqlite'))) {
        throw new Error('Source or target changed since preflight; generate a new plan.');
      }
      const verified = open(targetRoot);
      try { if (verified.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || verified.prepare('PRAGMA foreign_key_check').all().length || businessDatabaseDigest(tables(verified)) !== plan.expectedDatabaseDigest) throw new Error('Committed merge recovery failed SQLite verification.'); }
      finally { verified.close(); }
      privateJson(receiptPath, { version: 1, phase: 'completed', sourceRoot, targetRoot, sourceFingerprint: current.sourceFingerprint, inputDigest: plan.inputDigest,
        sourceBackup: prepared.sourceBackup, sourceBackupSha256: prepared.sourceBackupSha256, targetBackup: prepared.targetBackup, targetBackupSha256: prepared.targetBackupSha256,
        maintenanceManifest: preparedPath, maintenanceManifestSha256: fileDigest(preparedPath), deferredWorkCount: plan.deferred.length, recoveredAfterCommit: true, completedAt: new Date().toISOString() });
      return { phase: 'completed', receiptPath };
    }
    if (current.conflicts.length) throw new Error('Merge conflicts require explicit resolution; no existing data was overwritten.');
    for (const unsafe of [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), path.join(sourceRoot, 'data'), path.join(targetRoot, 'data')]) {
      const relative = path.relative(unsafe, backupRoot); if (!relative || !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('Backups must stay outside repository and live data directories.');
    }
    if (fs.existsSync(backupRoot)) throw new Error('Use a fresh backup directory; previous backups are never overwritten.');
    ensurePrivateRuntimeDirectory(backupRoot);
    sourceDb = open(sourceRoot); sourceDb.exec('BEGIN'); targetDb = open(targetRoot, false);
    await backup(sourceDb, path.join(backupRoot, 'legal-source.sqlite')); await backup(targetDb, path.join(backupRoot, 'shared-before.sqlite'));
    for (const name of ['legal-source.sqlite', 'shared-before.sqlite']) restrictOwnerAccess(path.join(backupRoot, name));
    const archive = { sourceBackup: path.join(backupRoot, 'legal-source.sqlite'), sourceBackupSha256: fileDigest(path.join(backupRoot, 'legal-source.sqlite')), targetBackup: path.join(backupRoot, 'shared-before.sqlite'), targetBackupSha256: fileDigest(path.join(backupRoot, 'shared-before.sqlite')) };
    for (const file of plan.files.filter(file => file.action === 'archive' && !file.link)) {
      const original = path.join(sourceRoot, 'data', file.path), saved = path.join(backupRoot, 'source-files', file.path);
      copyPrivateFile(original, saved);
      if (fileDigest(saved) !== file.sha256) throw new Error('An archived source file changed during backup.');
    }
    const migratedFiles = plan.files.filter(file => file.action !== 'archive' && file.action !== 'conflict').map(file => ({ path: file.path, sha256: file.action === 'merge-owner' ? crypto.createHash('sha256').update(JSON.stringify(resolvedJsonFile(file.path, path.join(sourceRoot, 'data', file.path), path.join(targetRoot, 'data', file.path)), null, 2) + '\n').digest('hex') : file.action === 'merge-keys' ? '' : file.sha256 }));
    privateJson(path.join(backupRoot, 'maintenance-manifest.json'), { version: 1, phase: 'prepared', sourceRoot, targetRoot, inputDigest: plan.inputDigest, sourceFingerprint: plan.sourceFingerprint, ...archive, resolutionPolicy: plan.resolutionPolicy, resolutions: plan.resolutions, migratedFiles, deferred: plan.deferred, continuationPointers: plan.continuationPointers, archivedFiles: plan.files.filter(file => file.action === 'archive'), notice: 'Deferred work exists only in the original root and SQLite archive. It was not resumed or changed into a terminal outcome.' });
    targetDb.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const targetByName = new Map(tables(targetDb).map(table => [table.name, table]));
    for (const table of tables(sourceDb)) {
      const existing = new Map(targetByName.get(table.name)!.rows.map(row => [key(row, table), row]));
      const insert = targetDb.prepare('INSERT INTO ' + quote(table.name) + ' (' + table.columns.map(quote).join(',') + ') VALUES (' + table.columns.map(() => '?').join(',') + ')');
      for (const original of table.rows) {
        if (defer(table, original, policy)) continue; const row = normalizedRow(original, table, sourceRoot, targetRoot, policy), before = existing.get(key(row, table));
        if (before) {
          if (stable(before) === stable(row)) continue; const resolved = resolvedRow(table, row, before, policy);
          if (!resolved) throw new Error('A row conflict changed during merge.');
          if (stable(before) !== stable(resolved)) {
            const columns = table.columns.filter(column => !table.pk.includes(column));
            targetDb.prepare('UPDATE ' + quote(table.name) + ' SET ' + columns.map(column => quote(column) + '=?').join(',') + ' WHERE ' + table.pk.map(column => quote(column) + '=?').join(' AND ')).run(...[...columns.map(column => resolved[column]), ...table.pk.map(column => before[column])] as SQLInputValue[]);
          }
          continue;
        }
        insert.run(...table.columns.map(column => row[column] as SQLInputValue));
      }
    }
    for (const file of plan.files) {
      if (file.action === 'copy' || file.action === 'merge-keys' || file.action === 'merge-owner') checkedDataFile(targetRoot, file.path);
      const destination = path.join(targetRoot, 'data', file.path);
      if (file.action === 'copy') { copyPrivateFile(path.join(sourceRoot, 'data', file.path), destination); createdFiles.push({ path: destination, sha256: file.sha256 }); if (fileDigest(destination) !== file.sha256) throw new Error('A source file changed during copying.'); }
      else if (file.action === 'merge-owner') {
        const value = resolvedJsonFile(file.path, path.join(sourceRoot, 'data', file.path), destination), bytes = JSON.stringify(value, null, 2) + '\n';
        if (fs.existsSync(destination)) {
          const saved = path.join(backupRoot, 'shared-files-before', file.path); copyPrivateFile(destination, saved);
          changedFiles.set(destination, fs.readFileSync(destination));
        } else { fs.mkdirSync(path.dirname(destination), { recursive: true }); createdFiles.push({ path: destination, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }); }
        fs.writeFileSync(destination, bytes, { mode: 0o600 }); restrictOwnerAccess(destination);
      }
      else if (file.action === 'merge-keys') { keyBackup = fs.readFileSync(destination); copyPrivateFile(destination, path.join(backupRoot, 'shared-keys-before.json')); const result = mergedKeys(path.join(sourceRoot, 'data', file.path), destination); if (result.conflict) throw new Error('Key conflict changed during merge.'); fs.writeFileSync(destination, JSON.stringify(result.value, null, 2) + '\n', { mode: 0o600 }); restrictOwnerAccess(destination); }
    }
    const quick = targetDb.prepare('PRAGMA quick_check').all(); const fk = targetDb.prepare('PRAGMA foreign_key_check').all();
    if (quick.length !== 1 || Object.values(quick[0])[0] !== 'ok' || fk.length || businessDatabaseDigest(tables(targetDb)) !== plan.expectedDatabaseDigest) throw new Error('Merged SQLite integrity verification failed.');
    targetDb.exec('COMMIT'); committed = true;
    privateJson(receiptPath, { version: 1, phase: 'completed', sourceRoot, targetRoot, sourceFingerprint: legacyLegalDataFingerprint(sourceRoot), inputDigest: plan.inputDigest, ...archive, maintenanceManifest: path.join(backupRoot, 'maintenance-manifest.json'), maintenanceManifestSha256: fileDigest(path.join(backupRoot, 'maintenance-manifest.json')), deferredWorkCount: plan.deferred.length, completedAt: new Date().toISOString() });
    return { phase: 'completed', receiptPath };
  } catch (error) {
    if (!committed) { try { targetDb?.exec('ROLLBACK'); } catch {} for (const file of createdFiles.reverse()) if (fs.existsSync(file.path) && fileDigest(file.path) === file.sha256) fs.unlinkSync(file.path); for (const [filename, contents] of changedFiles) fs.writeFileSync(filename, contents); if (keyBackup) fs.writeFileSync(path.join(targetRoot, 'data', 'keys.json'), keyBackup); }
    throw error;
  } finally { sourceDb?.close(); targetDb?.close(); for (const entry of leases.reverse()) if (!entry.lease.releaseAt(entry.root)) throw new Error('Could not release the exact data migration lease.'); }
}
async function initializeEmptyTarget(source: string, target: string): Promise<void> {
  if (!path.isAbsolute(source) || !path.isAbsolute(target)) throw new Error('Initialization requires explicit absolute source and target roots.');
  const sourceRoot = safeRoot(source), targetRoot = path.resolve(target);
  const a = sourceRoot.toLowerCase() + path.sep, b = targetRoot.toLowerCase() + path.sep;
  if (sourceRoot.toLowerCase() === targetRoot.toLowerCase() || a.startsWith(b) || b.startsWith(a) || targetRoot === path.parse(targetRoot).root) throw new Error('Source and target must be separate non-nested data roots.');
  safeRoot(path.dirname(targetRoot));
  const sourceDb = open(sourceRoot); sourceDb.close();
  if (fs.existsSync(targetRoot)) {
    safeRoot(targetRoot);
    if (fs.readdirSync(targetRoot).some(name => !['data', 'runtime', 'logs'].includes(name))) throw new Error('Target contains unrelated files; initialization was refused.');
    const data = path.join(targetRoot, 'data');
    if (fs.existsSync(data) && (safeRoot(data), fs.readdirSync(data).length > 0)) throw new Error('Target data is not empty; no existing database or files were changed.');
  }
  ensurePrivateRuntimeDirectory(targetRoot);
  const previous = process.env.LUMI_DATA_DIR;
  process.env.LUMI_DATA_DIR = targetRoot;
  try {
    // Reuse the application's schema and lease boundary; do not copy cwd data,
    // start a server, create a new user, or activate any source tasks.
    const database = await import('../db_layer');
    await database.initDatabase();
    await database.closeDatabase();
    if (!releaseDataRootLease()) throw new Error('Could not release the exact initialized target lease.');
  } finally {
    if (previous === undefined) delete process.env.LUMI_DATA_DIR; else process.env.LUMI_DATA_DIR = previous;
  }
  console.log(JSON.stringify({ phase: 'empty_target_initialized', targetRoot, sourceUnchanged: true, next: 'Run a separate read-only plan before applying any merge.' }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2); const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] || '' : ''; };
  const source = value('--source-root'); const target = value('--target-root'); const planPath = value('--plan');
  if (args.includes('--initialize-target')) {
    if (planPath || args.includes('--apply') || args.includes('--resolve-known-conflicts') || value('--backup-dir')) throw new Error('Initialize an empty target separately from plan/apply; existing data is never overwritten.');
    await initializeEmptyTarget(source, target); return;
  }
  if (!source || !target || !planPath || !path.isAbsolute(planPath)) throw new Error('Usage: node <maintenance-entry> --source-root <absolute> --target-root <absolute> (--initialize-target | --plan <absolute-plan.json> [--resolve-known-conflicts | --apply --backup-dir <new-absolute-directory>])');
  if (args.includes('--apply')) { const plan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as LegalDataMergePlan; if (path.resolve(source) !== plan.sourceRoot || path.resolve(target) !== plan.targetRoot) throw new Error('CLI roots do not match the bound plan.'); console.log(JSON.stringify(await applyLegalDataMerge(plan, value('--backup-dir')))); }
  else { const plan = planLegalDataMerge(source, target, { resolveKnownConflicts: args.includes('--resolve-known-conflicts') }); privateJson(planPath, plan); console.log(JSON.stringify({ phase: 'preflight_only', inputDigest: plan.inputDigest, conflicts: plan.conflicts.length, deferredWork: plan.deferred.length, planPath })); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
