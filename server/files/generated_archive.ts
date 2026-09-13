import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readDB } from '../../db_layer';
import { getDataPath } from '../config/data_path';
import { ensurePrivateRuntimeDirectory } from '../config/runtime_file_security';
import { generatedKnowledgeDirectory } from './knowledge_directory';
import { collectChatArtifacts } from '../conversation/chat_artifacts';
import { parseNestedJson } from '../tools/receipt_payload';
import type { ToolContext, ToolExecutionRecord } from '../tools/types';
import { getMember } from '../org/db';
import { captureOrganizationMembershipAuthorization, isOrganizationMembershipAuthorizationCurrent } from '../org/membership_authorization';
import { isTestLearningSource, isTestMemory } from '../memory/provenance';
import { chatArtifactKind } from '../../shared/chat_artifacts';

export type GeneratedArchiveScope = { userId: string; domain: 'personal' | 'work'; orgId?: string };
export interface GeneratedArchiveEntry {
  id: string; filename: string; displayName: string; kind: string; size: number; sha256: string;
  userId: string; domain: 'personal' | 'work'; orgId: string;
  sourcePath: string; sourceSize: number; sourceMtimeMs: number; sourceConversationId: string;
  sourceTaskId: string; sourceRequestId: string; sourceTool: string; createdAt: string; deletedAt?: string;
}
const queues = new Map<string, Promise<unknown>>();
function key(scope: GeneratedArchiveScope) { return createHash('sha256').update(JSON.stringify([scope.domain, scope.domain === 'work' ? scope.orgId : scope.userId])).digest('hex'); }
function indexPath(scope: GeneratedArchiveScope) { return path.join(ensurePrivateRuntimeDirectory(getDataPath('generated-library')), `${key(scope)}.json`); }
function readIndex(scope: GeneratedArchiveScope): GeneratedArchiveEntry[] {
  const file = indexPath(scope);
  if (!fs.existsSync(file)) return [];
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Archive index cannot be a symbolic link.');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('Invalid generated library index.');
  return data.entries.filter((entry: GeneratedArchiveEntry) => entry.domain === scope.domain
    && entry.orgId === (scope.orgId || '') && (scope.domain === 'work' || entry.userId === scope.userId)
    && entry.filename === path.basename(entry.filename) && /^[a-f0-9]{64}$/.test(entry.id));
}
function saveIndex(scope: GeneratedArchiveScope, entries: GeneratedArchiveEntry[]): void {
  const file = indexPath(scope), temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ version: 1, entries })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function noLinks(file: string): void {
  let current = path.resolve(file);
  while (true) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Generated library sources cannot traverse symbolic links.');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function scopeAuthorization(scope: GeneratedArchiveScope): () => void {
  if (!scope.userId || ['system', 'anonymous'].includes(scope.userId)) throw new Error('Generated library requires an account owner.');
  if (scope.domain !== 'work') return () => {};
  const member = scope.orgId ? getMember(scope.orgId, scope.userId) : null;
  if (!member || member.status !== 'active' || !['owner', 'admin', 'member'].includes(member.role)) throw new Error('Knowledge write access is unavailable.');
  const membership = captureOrganizationMembershipAuthorization(scope.orgId!, scope.userId);
  return () => { if (!isOrganizationMembershipAuthorizationCurrent(membership, scope.orgId!, scope.userId)) throw new Error('Archive organization access changed.'); };
}
export function listGeneratedArchive(scope: GeneratedArchiveScope): GeneratedArchiveEntry[] {
  const dir = generatedKnowledgeDirectory(scope);
  return readIndex(scope).filter(entry => !entry.deletedAt && fs.existsSync(path.join(dir, entry.filename)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function serialize<T>(scope: GeneratedArchiveScope, run: () => Promise<T>): Promise<T> {
  const queueKey = key(scope), operation = (queues.get(queueKey) || Promise.resolve()).catch(() => {}).then(run);
  queues.set(queueKey, operation);
  try { return await operation; } finally { if (queues.get(queueKey) === operation) queues.delete(queueKey); }
}
export async function mutateGeneratedArchiveFile(scope: GeneratedArchiveScope, filename: string, newFilename?: string): Promise<void> {
  await serialize(scope, async () => {
    const assertAuthorized = scopeAuthorization(scope); assertAuthorized();
    const dir = generatedKnowledgeDirectory(scope);
    if (filename !== path.basename(filename) || (newFilename && newFilename !== path.basename(newFilename))) throw new Error('Invalid archive filename.');
    const original = path.join(dir, filename); noLinks(original);
    const entries = readIndex(scope), entry = entries.find(item => item.filename === filename && !item.deletedAt);
    if (newFilename) {
      const target = path.join(dir, newFilename);
      if (fs.existsSync(target)) throw Object.assign(new Error('Name already taken'), { status: 409 });
      fs.renameSync(original, target);
      if (entry) {
        entry.filename = newFilename; entry.displayName = newFilename;
        try { saveIndex(scope, entries); } catch (error) { fs.renameSync(target, original); throw error; }
      }
    } else {
      if (entry) { entry.deletedAt = new Date().toISOString(); saveIndex(scope, entries); }
      try { fs.unlinkSync(original); } catch (error) {
        if (entry) { delete entry.deletedAt; saveIndex(scope, entries); } throw error;
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
    const entries = readIndex(scope), saved: GeneratedArchiveEntry[] = [];
    for (const { artifact, record } of artifacts) {
      const source = path.resolve(artifact.path); noLinks(source);
      // A library item reused as an input/output is already a persistent copy.
      if (entries.some(entry => !entry.deletedAt && path.join(dir, entry.filename) === source)) continue;
      const stat = await fsp.stat(source);
      if (!stat.isFile()) continue;
      const same = entries.find(entry => entry.sourcePath === source && entry.sourceSize === stat.size && entry.sourceMtimeMs === stat.mtimeMs);
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
        const prior = entries.find(entry => entry.id === id);
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
        const index = entries.findIndex(item => item.id === id);
        if (index >= 0) entries[index] = { ...entry, createdAt: entries[index].createdAt }; else entries.push(entry);
        saveIndex(scope, entries); saved.push(entry);
      } finally { await fsp.unlink(temporary).catch(() => {}); }
    }
    return saved;
  };
  return serialize(scope, run);
}

/** Explicit Save already writes into the vault; persist its generated provenance. */
export async function registerGeneratedKnowledgeFile(scope: GeneratedArchiveScope, filename: string): Promise<void> {
  await serialize(scope, async () => {
    const assertAuthorized = scopeAuthorization(scope); assertAuthorized();
    if (filename !== path.basename(filename)) throw new Error('Invalid archive filename.');
    const source = path.join(generatedKnowledgeDirectory(scope), filename); noLinks(source);
    const stat = fs.statSync(source), hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(source)) hash.update(chunk);
    const after = fs.statSync(source); if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('Generated file changed while saving.');
    const sha256 = hash.digest('hex'), id = createHash('sha256').update(`${key(scope)}\n${source}\n${sha256}`).digest('hex');
    const entries = readIndex(scope).filter(entry => entry.filename !== filename);
    assertAuthorized();
    entries.push({ id, filename, displayName: filename, kind: chatArtifactKind(filename), size: stat.size, sha256,
      ...scope, orgId: scope.orgId || '', sourcePath: source, sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs,
      sourceConversationId: '', sourceTaskId: '', sourceRequestId: '', sourceTool: 'files/save', createdAt: new Date().toISOString() });
    saveIndex(scope, entries);
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
        if (!collectChatArtifacts([record]).length) continue;
        try { archived += (await archiveGeneratedOutputs([record], { ...scope, conversationId: message.conversationId, source: message.source })).length; }
        catch { unavailable++; }
      }
    }
    return { archived, unavailable };
  })();
  reconciliations.set(queueKey, operation);
  try { return await operation; } finally { reconciliations.delete(queueKey); }
}
