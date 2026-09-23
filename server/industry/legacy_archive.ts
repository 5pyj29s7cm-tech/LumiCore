import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import sqlite3 from 'sqlite3';
import { getDataPath } from '../config/data_path';
import { ensurePrivateRuntimeDirectory, restrictOwnerAccess } from '../config/runtime_file_security';
import { BUSINESS_LINES, type BusinessLine } from './business_catalog';

export interface BusinessLegacyArchive {
  schemaVersion: 1; line: BusinessLine; owner: string; importedAt: string; digest: string;
  tables: Record<string, any[]>; tasks: any[]; workspaces: any[];
  artifacts: Array<{ originalPath: string; path: string; sha256: string; bytes: number }>;
  missingArtifacts: string[];
}
function location(userId: string, line: BusinessLine) {
  if (!userId || userId === 'anonymous' || !BUSINESS_LINES.includes(line)) throw new Error('Authenticated business archive owner required');
  return path.join(getDataPath('business-archive'), crypto.createHash('sha256').update(`${userId}:${line}`).digest('hex'));
}
export function readBusinessLegacyArchive(userId: string, line: BusinessLine): BusinessLegacyArchive | null {
  const file = path.join(location(userId, line), 'archive.json');
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.owner !== userId || data.line !== line) throw new Error('Archive owner mismatch');
  return data;
}
export function businessLegacySummary(archive: BusinessLegacyArchive) {
  return { line: archive.line, importedAt: archive.importedAt, digest: archive.digest, tasks: archive.tasks.length, conversations: archive.tables.conversations?.length || 0, artifacts: archive.artifacts.length, missingArtifacts: archive.missingArtifacts.length };
}
export function resolveBusinessLegacyArtifact(userId: string, line: BusinessLine, sha256: string) {
  const item = readBusinessLegacyArchive(userId, line)?.artifacts.find(artifact => artifact.sha256 === sha256);
  if (!item) return null;
  const directory = fs.realpathSync(location(userId, line));
  if (fs.lstatSync(item.path).isSymbolicLink() || path.dirname(fs.realpathSync(item.path)) !== directory) throw new Error('Archive artifact escaped its owner directory');
  if (crypto.createHash('sha256').update(fs.readFileSync(item.path)).digest('hex') !== item.sha256) throw new Error('Archive artifact changed after import');
  return item;
}
/** Reads only this signed-in local user's records. Credentials and active tasks are never imported into runtime state. */
export async function importBusinessLegacyArchive(userId: string, line: BusinessLine, sourceRoot?: string): Promise<BusinessLegacyArchive> {
  const destination = location(userId, line);
  // sourceRoot is an internal test seam, never exposed through the HTTP API.
  const root = sourceRoot || path.join(os.homedir(), line === 'ecommerce' ? 'LumiCore-Ecommerce' : 'LumiCore-Finance');
  const database = path.join(root, 'data', 'lumi.db');
  const db = await new Promise<sqlite3.Database>((resolve, reject) => { const connection = new sqlite3.Database(database, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(connection)); });
  const all = (sql: string, args: unknown[] = []) => new Promise<any[]>((resolve, reject) => db.all(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));
  try {
    const owners = await all('SELECT uid FROM users WHERE uid=?', [userId]);
    if (!owners.length) throw new Error('No matching local account in the retired edition');
    const tables: Record<string, any[]> = {};
    const available = new Set((await all("SELECT name FROM sqlite_master WHERE type='table'")).map(row => row.name));
    await all('BEGIN');
    for (const table of ['conversations', 'interactions', 'memories', 'conversation_action_tasks', 'conversation_action_receipts', 'conversation_action_turns']) {
      if (!available.has(table)) continue;
      const columns = (await all(`PRAGMA table_info(${table})`)).map(row => row.name);
      if (!columns.includes('userId')) continue;
      tables[table] = await all(`SELECT * FROM ${table} WHERE userId=?${columns.includes('domain') ? " AND (domain='personal' OR domain IS NULL OR domain='')" : ''}${columns.includes('orgId') ? " AND (orgId='' OR orgId IS NULL)" : ''}`, [userId]);
    }
    const setting = async (key: string, fallback: unknown) => {
      const value = (await all('SELECT value FROM settings WHERE key=?', [key]))[0]?.value;
      return value ? JSON.parse(value) : fallback;
    };
    const scoped = (row: any) => (row.userId || row.ownerUserId) === userId && (!row.domain || row.domain === 'personal') && !row.orgId;
    const tasks = (await setting('work_takeover_tasks_v1', []) as any[]).filter(scoped);
    const workspaces = (await setting('industry_workspace_contexts_v1', { items: [] }) as any).items.filter((row: any) => scoped(row) && row.scopeId === `personal:${userId}`);
    await all('COMMIT');
    const digest = crypto.createHash('sha256').update(JSON.stringify({ archiveRevision: 2, tables, tasks, workspaces })).digest('hex');
    const prior = readBusinessLegacyArchive(userId, line);
    if (prior?.digest === digest && prior.artifacts.every(item => fs.existsSync(item.path) && crypto.createHash('sha256').update(fs.readFileSync(item.path)).digest('hex') === item.sha256)) return prior;
    await ensurePrivateRuntimeDirectory(destination);
    const artifacts: BusinessLegacyArchive['artifacts'] = []; const missingArtifacts: string[] = [];
    const paths = [...new Set<string>(tasks.flatMap((task: any) => (task.artifacts || []).map((artifact: any) => String(artifact.path || '')).filter(Boolean)))];
    for (const originalPath of paths) {
      // Source-code inventory entries are not generated business deliverables.
      if (!/\.(pdf|docx?|xlsx?|csv|tsv|txt|png|jpe?g|mp4|pptx?)$/i.test(originalPath)) continue;
      // Never fetch URLs/network shares referenced by a historical model reply.
      if (!path.isAbsolute(originalPath) || originalPath.startsWith('\\\\') || /^[a-z]+:\/\//i.test(originalPath)) { missingArtifacts.push(originalPath); continue; }
      try {
        const legacyRoot = path.join(path.dirname(root), path.basename(root).replace(/^LumiCore-/, 'LumiOS-'));
        const legacyRelative = path.relative(legacyRoot, originalPath);
        const resolvedPath = !fs.existsSync(originalPath) && !legacyRelative.startsWith('..') && !path.isAbsolute(legacyRelative) ? path.join(root, legacyRelative) : originalPath;
        const relative = path.relative(fs.realpathSync(root), fs.realpathSync(resolvedPath));
        if (relative.startsWith('..') || path.isAbsolute(relative)) { missingArtifacts.push(originalPath); continue; }
        const stat = fs.lstatSync(resolvedPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 30 * 1024 * 1024) { missingArtifacts.push(originalPath); continue; }
        const bytes = fs.readFileSync(resolvedPath); const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        const saved = path.join(destination, hash + path.extname(originalPath).slice(0, 12));
        fs.writeFileSync(saved, bytes); await restrictOwnerAccess(saved);
        artifacts.push({ originalPath, path: saved, sha256: hash, bytes: bytes.length });
      } catch { missingArtifacts.push(originalPath); }
    }
    const archive: BusinessLegacyArchive = { schemaVersion: 1, line, owner: userId, digest, importedAt: new Date().toISOString(), tables, tasks, workspaces, artifacts, missingArtifacts };
    const file = path.join(destination, 'archive.json'); const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(archive)); await restrictOwnerAccess(temp); fs.renameSync(temp, file);
    return archive;
  } finally { await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }
}
