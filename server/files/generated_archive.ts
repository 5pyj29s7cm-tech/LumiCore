import { setImmediate as yieldArchiveRows } from 'node:timers/promises';
import { runSerializedMutation } from '../persistence/durable_scope_mutation';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readDB, querySQL, withDatabaseSqlWriteLock } from '../../db_layer';
import { getDataPath, resolveMigratedDataFile } from '../config/data_path';
import { ensurePrivateRuntimeDirectory } from '../config/runtime_file_security';
import { generatedKnowledgeDirectory } from './knowledge_directory';
import { collectChatArtifacts } from '../conversation/chat_artifacts';
import { parseNestedJson } from '../tools/receipt_payload';
import type { ToolContext, ToolExecutionRecord } from '../tools/types';
import { getMember, getOrgById } from '../org/db';
import { isTestLearningSource, isTestMemory } from '../memory/provenance';
import { chatArtifactKind } from '../../shared/chat_artifacts';

export type GeneratedArchiveScope = { userId: string; domain: 'personal' | 'work'; orgId?: string };
export interface GeneratedArchiveEntry {
  id: string; filename: string; displayName: string; kind: string; size: number; sha256: string;
  userId: string; domain: 'personal' | 'work'; orgId: string;
  sourcePath: string; sourceSize: number; sourceMtimeMs: number; sourceConversationId: string;
  sourceTaskId: string; sourceRequestId: string; sourceTool: string; createdAt: string; deletedAt?: string;
}
function key(scope: GeneratedArchiveScope) { return createHash('sha256').update(JSON.stringify([scope.domain, scope.domain === 'work' ? scope.orgId : scope.userId])).digest('hex'); }
function indexPath(scope: GeneratedArchiveScope) { return path.join(ensurePrivateRuntimeDirectory(getDataPath('generated-library')), `${key(scope)}.json`); }
const archiveColumns = ['id', 'filename', 'sourcePath', 'sourceSize', 'sourceMtimeMs', 'createdAt', 'deletedAt', 'payload'];
async function saveEntries(scope: GeneratedArchiveScope, entries: GeneratedArchiveEntry[], assertAuthorized: () => void, migration = false, replaceFilename?: string): Promise<void> {
  const scopeId = key(scope);
  await withDatabaseSqlWriteLock(async ({ run, query }) => {
    assertAuthorized();
    await run('BEGIN IMMEDIATE');
    try {
      const cacheKey = path.join(getDataPath('generated-library'), key(scope)), cached = archiveLists.get(cacheKey);
      const [before] = cached ? await query<{ revision: string }>('SELECT revision FROM generated_archive_scopes WHERE scope=?', [scopeId]) : [];
      if (replaceFilename) await run('DELETE FROM generated_archive WHERE scope=? AND filename=?', [scopeId, replaceFilename]);
      for (let offset = 0; offset < entries.length; offset += 40) {
        const batch = entries.slice(offset, offset + 40);
        await run('INSERT INTO generated_archive(scope,' + archiveColumns.join(',') + ') VALUES '
          + batch.map(() => '(' + Array(archiveColumns.length + 1).fill('?').join(',') + ')').join(',')
          + ' ON CONFLICT(scope,id) DO UPDATE SET ' + archiveColumns.slice(1).map(column => column + '=excluded.' + column).join(','),
          batch.flatMap(entry => [scopeId, ...archiveColumns.map(column => column === 'payload' ? JSON.stringify(entry) : column === 'deletedAt' ? entry.deletedAt || null : entry[column as keyof GeneratedArchiveEntry] ?? null)]));
      }
      if (migration) await run('INSERT INTO generated_archive_scopes(scope,revision) VALUES(?,?)', [scopeId, randomUUID()]);
      let next: ArchiveList | undefined;
      if (cached && before?.revision === cached.revision) {
        const changed = new Map(entries.map(entry => [entry.id, entry]));
        let bytes = cached.bytes;
        const retained = cached.entries.filter(entry => {
          const remove = changed.has(entry.id) || entry.filename === replaceFilename;
          if (remove) bytes -= JSON.stringify(entry).length * 2 + 384;
          return !remove;
        });
        for (const entry of changed.values()) if (!entry.deletedAt) {
          retained.push({ ...entry }); bytes += JSON.stringify(entry).length * 2 + 384;
        }
        retained.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const [after] = await query<{ revision: string }>('SELECT revision FROM generated_archive_scopes WHERE scope=?', [scopeId]);
        next = { revision: after.revision, entries: retained, bytes };
      }
      assertAuthorized();
      await run('COMMIT');
      if (next) rememberArchiveList(cacheKey, next);
    } catch (error) { await run('ROLLBACK').catch(() => {}); throw error; }
  });
}
async function ensureArchiveImported(scope: GeneratedArchiveScope): Promise<string> {
  return runSerializedMutation('generated-archive-import:' + key(scope), async () => {
    const [state] = await querySQL<{ revision: string }>('SELECT revision FROM generated_archive_scopes WHERE scope=?', [key(scope)]);
    if (state) return state.revision;
    const assertAuthorized = scopeAuthorization(scope, true), file = indexPath(scope);
    const stat = await fsp.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink()) throw new Error('Archive index cannot be a symbolic link.');
    const data = stat ? JSON.parse(await fsp.readFile(file, 'utf8')) : { version: 1, entries: [] };
    if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('Invalid generated library index.');
    const entries = data.entries.filter((entry: GeneratedArchiveEntry) => entry.domain === scope.domain
      && entry.orgId === (scope.orgId || '') && (scope.domain === 'work' || entry.userId === scope.userId)
      && entry.filename === path.basename(entry.filename) && /^[a-f0-9]{64}$/.test(entry.id));
    // The marker and rows commit together. Legacy JSON is never read again after success.
    await saveEntries(scope, entries, assertAuthorized, true);
    return (await querySQL<{ revision: string }>('SELECT revision FROM generated_archive_scopes WHERE scope=?', [key(scope)]))[0].revision;
  });
}
async function readIndex(scope: GeneratedArchiveScope, condition = '', values: unknown[] = [], countBytes?: (bytes: number) => void): Promise<GeneratedArchiveEntry[]> {
  // One SQL snapshot, at most 256 records per JSON parse. The scope index also
  // orders rowids: each cursor skips other accounts and earlier batches.
  const rows = await querySQL<{ payload: string | null }>(countBytes ?
    `WITH RECURSIVE batches(first) AS (
      SELECT MIN(rowid) FROM generated_archive WHERE scope=?1
      UNION ALL SELECT (SELECT rowid FROM generated_archive WHERE scope=?1 AND rowid>=b.first ORDER BY rowid LIMIT 1 OFFSET 256)
        FROM batches b WHERE b.first IS NOT NULL
    ) SELECT (SELECT '[' || group_concat('[' || payload || ']', ',') || ']' FROM (
        SELECT payload,deletedAt FROM generated_archive WHERE scope=?1 AND rowid>=b.first ORDER BY rowid LIMIT 256
      ) WHERE deletedAt IS NULL) AS payload FROM batches b WHERE b.first IS NOT NULL`
    : 'SELECT payload FROM generated_archive WHERE scope=?' + condition, [key(scope), ...values]);
  const entries: GeneratedArchiveEntry[] = [];
  let bytes = 0;
  for (const [index, row] of rows.entries()) {
    const batch: GeneratedArchiveEntry[] = countBytes ? JSON.parse(row.payload || '[]').map((item: GeneratedArchiveEntry[]) => {
      if (item.length !== 1) throw new Error('Invalid generated library record.');
      return item[0];
    }) : [JSON.parse(row.payload!)];
    entries.push(...batch);
    bytes += (row.payload?.length || 0) * 2 + batch.length * 384;
    if (countBytes || (index + 1) % 256 === 0) await yieldArchiveRows();
  }
  countBytes?.(bytes);
  return entries;
}
function noLinks(file: string): void {
  let current = path.resolve(file);
  while (true) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Generated library sources cannot traverse symbolic links.');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function scopeAuthorization(scope: GeneratedArchiveScope, readOnly = false): () => void {
  if (!scope.userId || ['system', 'anonymous'].includes(scope.userId)) throw new Error('Generated library requires an account owner.');
  if (scope.domain !== 'work') return () => {};
  const member = scope.orgId ? getMember(scope.orgId, scope.userId) : null;
  if (!member || member.status !== 'active' || (!readOnly && !['owner', 'admin', 'member'].includes(member.role))) throw new Error('Knowledge write access is unavailable.');
  const membershipId = member.id, role = member.role;
  return () => {
    const current = getMember(scope.orgId!, scope.userId);
    if (!getOrgById(scope.orgId!) || current?.status !== 'active' || current.id !== membershipId || current.role !== role) throw new Error('Archive organization access changed.');
  };
}
// Derived, bounded cache only: SQLite revisions invalidate it even for another connection's writes.
type ArchiveList = { revision: string; entries: GeneratedArchiveEntry[]; bytes: number };
const archiveLists = new Map<string, ArchiveList>();
const ARCHIVE_LIST_BUDGET = 64 * 1024 * 1024;
function rememberArchiveList(cacheKey: string, cached: ArchiveList): void {
  archiveLists.delete(cacheKey);
  if (cached.bytes > ARCHIVE_LIST_BUDGET) return;
  archiveLists.set(cacheKey, cached);
  let used = [...archiveLists.values()].reduce((sum, item) => sum + item.bytes, 0);
  for (const [id, item] of archiveLists) { if (used <= ARCHIVE_LIST_BUDGET && archiveLists.size <= 8) break; archiveLists.delete(id); used -= item.bytes; }
}
export async function listGeneratedArchive(scope: GeneratedArchiveScope, filename?: string): Promise<GeneratedArchiveEntry[]> {
  const revision = await ensureArchiveImported(scope), dir = generatedKnowledgeDirectory(scope);
  if (filename !== undefined) return (await readIndex(scope, ' AND deletedAt IS NULL AND filename=?', [filename]))
    .filter(entry => fs.existsSync(path.join(dir, entry.filename))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const cacheKey = path.join(getDataPath('generated-library'), key(scope));
  const previous = archiveLists.get(cacheKey);
  const [names, cached] = await Promise.all([fsp.readdir(dir), (async () => {
    if (previous?.revision === revision) return previous;
    let bytes = 0;
    const entries = await readIndex(scope, '', [], count => { bytes += count; });
    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { revision, entries, bytes };
  })()]);
  if (archiveLists.get(cacheKey) === previous) rememberArchiveList(cacheKey, cached);
  const present = new Set(names);
  // Do not leak cached objects to callers, or cache filesystem existence.
  return cached.entries.filter(entry => present.has(entry.filename)).map(entry => ({ ...entry }));
}
export async function mutateGeneratedArchiveFile(scope: GeneratedArchiveScope, filename: string, newFilename?: string): Promise<void> {
  await runSerializedMutation('generated-archive:' + key(scope), async () => {
    const assertAuthorized = scopeAuthorization(scope); assertAuthorized();
    const dir = generatedKnowledgeDirectory(scope);
    if (filename !== path.basename(filename) || (newFilename && newFilename !== path.basename(newFilename))) throw new Error('Invalid archive filename.');
    const original = path.join(dir, filename);
    await ensureArchiveImported(scope);
    const [entry] = await readIndex(scope, ' AND filename=? AND deletedAt IS NULL', [filename]);
    assertAuthorized(); noLinks(original);
    if (newFilename) {
      const target = path.join(dir, newFilename);
      if (fs.existsSync(target)) throw Object.assign(new Error('Name already taken'), { status: 409 });
      fs.renameSync(original, target);
      if (entry) {
        entry.filename = newFilename; entry.displayName = newFilename;
        try { await saveEntries(scope, [entry], assertAuthorized); } catch (error) { fs.renameSync(target, original); throw error; }
      }
    } else {
      if (entry) { entry.deletedAt = new Date().toISOString(); await saveEntries(scope, [entry], assertAuthorized); }
      try { fs.unlinkSync(original); } catch (error) {
        if (entry) { delete entry.deletedAt; await saveEntries(scope, [entry], assertAuthorized); } throw error;
      }
    }
  });
}

/** Copy a verified output into the existing knowledge vault. The independent
 * content snapshot survives conversation deletion and later source edits. */
export async function archiveGeneratedOutputs(records: ToolExecutionRecord[], context: ToolContext): Promise<GeneratedArchiveEntry[]> {
  if (!context.userId || isTestLearningSource(context.source)) return [];
  const scope: GeneratedArchiveScope = { userId: context.userId, domain: context.domain === 'work' ? 'work' : 'personal', orgId: context.domain === 'work' ? context.orgId || '' : '' };
  const artifacts = records.flatMap(record => collectChatArtifacts([record], context.conversationId).map(artifact => ({ artifact, record })));
  if (!artifacts.length) return [];
  const run = async () => {
    const assertAuthorized = scopeAuthorization(scope); assertAuthorized();
    const dir = generatedKnowledgeDirectory(scope); noLinks(dir);
    await ensureArchiveImported(scope);
    const saved: GeneratedArchiveEntry[] = [], changed = new Map<string, GeneratedArchiveEntry>();
    try { for (const { artifact, record } of artifacts) {
      const source = resolveMigratedDataFile(artifact.path); noLinks(source);
      // A library item reused as an input/output is already a persistent copy.
      if (path.dirname(source) === dir && (await readIndex(scope, ' AND filename=? AND deletedAt IS NULL', [path.basename(source)])).length) continue;
      const stat = await fsp.stat(source);
      if (!stat.isFile()) continue;
      const same = [...changed.values()].find(entry => entry.sourcePath === source && entry.sourceSize === stat.size && entry.sourceMtimeMs === stat.mtimeMs)
        || (await readIndex(scope, ' AND sourcePath=? AND sourceSize=? AND sourceMtimeMs=?', [source, stat.size, stat.mtimeMs]))[0];
      if (same && (same.deletedAt || fs.existsSync(path.join(dir, same.filename)))) { if (!same.deletedAt) saved.push(same); continue; }
      const temporary = path.join(dir, `.archive-${randomUUID()}.tmp`);
      try {
        await fsp.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
        const after = await fsp.stat(source); noLinks(source);
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino) throw new Error('Generated output changed while archiving.');
        const hash = createHash('sha256');
        for await (const chunk of fs.createReadStream(temporary)) hash.update(chunk);
        const sha256 = hash.digest('hex');
        const id = createHash('sha256').update(`${key(scope)}\n${source}\n${sha256}`).digest('hex');
        const prior = changed.get(id) || (await readIndex(scope, ' AND id=?', [id]))[0];
        if (prior?.deletedAt) continue;
        const displayName = path.basename(source);
        const ext = path.extname(displayName).slice(0, 16);
        const stem = path.basename(displayName, path.extname(displayName)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || 'output';
        const filename = prior?.filename || `generated-${stem}.lumi-${id.slice(0, 16)}${ext}`;
        assertAuthorized();
        await fsp.chmod(temporary, 0o600);
        await fsp.rename(temporary, path.join(dir, filename));
        assertAuthorized();
        const entry: GeneratedArchiveEntry = { id, filename, displayName, kind: artifact.kind, size: stat.size, sha256,
          ...scope, orgId: scope.orgId || '', sourcePath: source, sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs,
          sourceConversationId: context.conversationId || '', sourceTaskId: record.taskId || context.taskId || '',
          sourceRequestId: record.requestId || context.requestId || '', sourceTool: record.name, createdAt: new Date().toISOString() };
        if (prior) entry.createdAt = prior.createdAt;
        changed.set(id, entry);
        saved.push(entry);
      } finally { await fsp.unlink(temporary).catch(() => {}); }
    } } finally { if (changed.size) await saveEntries(scope, [...changed.values()], assertAuthorized); }
    return saved;
  };
  return runSerializedMutation('generated-archive:' + key(scope), run);
}

/** Explicit Save already writes into the vault; persist its generated provenance. */
export async function registerGeneratedKnowledgeFile(scope: GeneratedArchiveScope, filename: string): Promise<GeneratedArchiveEntry> {
  return runSerializedMutation('generated-archive:' + key(scope), async () => {
    const assertAuthorized = scopeAuthorization(scope); assertAuthorized();
    if (filename !== path.basename(filename)) throw new Error('Invalid archive filename.');
    const source = path.join(generatedKnowledgeDirectory(scope), filename); noLinks(source);
    const stat = fs.statSync(source), hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(source)) hash.update(chunk);
    const sha256 = hash.digest('hex'), id = createHash('sha256').update(`${key(scope)}\n${source}\n${sha256}`).digest('hex');
    await ensureArchiveImported(scope);
    noLinks(source);
    const after = fs.statSync(source); if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('Generated file changed while saving.');
    assertAuthorized();
    const entry: GeneratedArchiveEntry = { id, filename, displayName: filename, kind: chatArtifactKind(filename), size: stat.size, sha256,
      ...scope, orgId: scope.orgId || '', sourcePath: source, sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs,
      sourceConversationId: '', sourceTaskId: '', sourceRequestId: '', sourceTool: 'files/save', createdAt: new Date().toISOString() };
    await saveEntries(scope, [entry], assertAuthorized, false, filename);
    return entry;
  });
}

const reconciliations = new Map<string, Promise<{ archived: number; unavailable: number }>>();
export async function reconcileGeneratedArchive(scope: GeneratedArchiveScope) {
  const queueKey = `${key(scope)}:${scope.userId}`; const existing = reconciliations.get(queueKey); if (existing) return existing;
  const operation = (async () => {
    const db = readDB();
    const conversations = new Set((db.conversations || []).filter((row: any) => row.userId === scope.userId
      && (row.domain || 'personal') === scope.domain && (row.orgId || '') === (scope.orgId || '')).map((row: any) => row.id));
    let archived = 0, unavailable = 0;
    for (const message of db.interactions || []) {
      if (message.userId !== scope.userId || !conversations.has(message.conversationId) || isTestLearningSource(message.source)
        || isTestMemory({ sourceInteractionId: message.source || '', content: message.content || message.message || '' })) continue;
      const records = parseNestedJson(message.toolCalls);
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        try { archived += (await archiveGeneratedOutputs([record], { ...scope, conversationId: message.conversationId, source: message.source })).length; }
        catch { unavailable++; }
      }
    }
    return { archived, unavailable };
  })();
  reconciliations.set(queueKey, operation);
  try { return await operation; } finally { reconciliations.delete(queueKey); }
}
