import path from "path";
import fs from "fs";
import crypto from "crypto";
import { ingestDocument } from "../../agents/rag";
import * as OrgKB from "../../org/kb";
import type { FileScope, ObsidianVaultConfig, ObsidianNoteFile } from './contracts';
import { resolveLocalImportPath } from './paths';
import { repairFilename, OBSIDIAN_DEFAULT_MAX_FILES, OBSIDIAN_HARD_MAX_FILES, OBSIDIAN_SKIP_DIRS, OBSIDIAN_NOTE_EXTS, OBSIDIAN_MAX_NOTE_BYTES, formatSize, sanitizeKnowledgeFilename } from './formats';
import { findExistingFileMemories } from './memory_references';
import { findFileMeta } from './ownership';
import { buildEntry, applyExtractionMeta, applyIngestionManifest } from './metadata';
import { extractTextKnowledge } from './extraction';
import { ensureOrgArticleFromFile } from './file_ingestion';

export function stableHash(value: string, length = 12): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, length);
}

export function obsidianSettingsKey(userId: string, scope: FileScope): string {
  return `obsidian_vaults:${userId}:${scope.domain}:${scope.orgId || 'personal'}`;
}

export function readObsidianVaults(db: any, userId: string, scope: FileScope): ObsidianVaultConfig[] {
  const key = obsidianSettingsKey(userId, scope);
  const row = (db.settings || []).find((s: any) => s.key === key);
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter(v => v?.id && v?.path) : [];
  } catch {
    return [];
  }
}

export function writeObsidianVaults(db: any, userId: string, scope: FileScope, vaults: ObsidianVaultConfig[]): void {
  if (!db.settings) db.settings = [];
  const key = obsidianSettingsKey(userId, scope);
  const value = JSON.stringify(vaults);
  const idx = db.settings.findIndex((s: any) => s.key === key);
  if (idx >= 0) db.settings[idx].value = value;
  else db.settings.push({ key, value });
}

export function resolveObsidianVaultPath(value: unknown): { path: string; isObsidianVault: boolean } {
  const resolved = resolveLocalImportPath(value);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    const err: any = new Error('Obsidian vault path must be a folder');
    err.status = 400;
    throw err;
  }
  return {
    path: resolved,
    isObsidianVault: fs.existsSync(path.join(resolved, '.obsidian')),
  };
}

export function defaultObsidianVaultName(vaultPath: string): string {
  return repairFilename(path.basename(vaultPath)) || 'Obsidian Vault';
}

export function makeObsidianVaultId(userId: string, scope: FileScope, vaultPath: string): string {
  return `obs_${stableHash(`${userId}|${scope.domain}|${scope.orgId || ''}|${vaultPath}`, 16)}`;
}

export function upsertObsidianVault(
  db: any,
  userId: string,
  scope: FileScope,
  input: { vaultPath: string; name?: string },
): ObsidianVaultConfig {
  const resolved = resolveObsidianVaultPath(input.vaultPath);
  const now = new Date().toISOString();
  const vaults = readObsidianVaults(db, userId, scope);
  const id = makeObsidianVaultId(userId, scope, resolved.path);
  const existing = vaults.find(v => v.id === id || v.path === resolved.path);
  const name = String(input.name || existing?.name || defaultObsidianVaultName(resolved.path)).trim();
  const vault: ObsidianVaultConfig = {
    ...(existing || {}),
    id,
    userId,
    domain: scope.domain,
    orgId: scope.orgId || '',
    name,
    path: resolved.path,
    enabled: true,
    isObsidianVault: resolved.isObsidianVault,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const next = existing
    ? vaults.map(v => (v.id === existing.id ? vault : v))
    : [...vaults, vault];
  writeObsidianVaults(db, userId, scope, next);
  return vault;
}

export function scanObsidianVault(vaultPath: string, maxFiles = OBSIDIAN_DEFAULT_MAX_FILES): {
  notes: ObsidianNoteFile[];
  skipped: Array<{ path: string; error: string }>;
  truncated: boolean;
} {
  const limit = Math.max(1, Math.min(Math.floor(Number(maxFiles) || OBSIDIAN_DEFAULT_MAX_FILES), OBSIDIAN_HARD_MAX_FILES));
  const root = fs.realpathSync.native(vaultPath);
  const notes: ObsidianNoteFile[] = [];
  const skipped: Array<{ path: string; error: string }> = [];
  let truncated = false;

  const walk = (dir: string) => {
    if (notes.length >= limit) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err: any) {
      skipped.push({ path: path.relative(root, dir) || '.', error: err?.message || String(err) });
      return;
    }
    for (const entry of entries) {
      if (notes.length >= limit) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (OBSIDIAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !OBSIDIAN_NOTE_EXTS.test(entry.name)) continue;
      const relativePath = path.relative(root, full).replace(/\\/g, '/');
      try {
        const stat = fs.statSync(full);
        if (stat.size > OBSIDIAN_MAX_NOTE_BYTES) {
          skipped.push({ path: relativePath, error: `Note is larger than ${formatSize(OBSIDIAN_MAX_NOTE_BYTES)}` });
          continue;
        }
        notes.push({
          absolutePath: full,
          relativePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch (err: any) {
        skipped.push({ path: relativePath, error: err?.message || String(err) });
      }
    }
  };

  walk(root);
  notes.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { notes, skipped, truncated };
}

export function obsidianDestinationName(vault: ObsidianVaultConfig, relativePath: string): string {
  const parsed = path.posix.parse(relativePath.replace(/\\/g, '/'));
  const folder = parsed.dir ? `${parsed.dir.replace(/[\\/]+/g, ' - ')} - ` : '';
  const readable = sanitizeKnowledgeFilename(`${folder}${parsed.name}`, 'note')
    .replace(/\s+/g, ' ')
    .slice(0, 110)
    .trim() || 'note';
  const vaultSlug = sanitizeKnowledgeFilename(vault.name || defaultObsidianVaultName(vault.path), 'obsidian')
    .replace(/\s+/g, ' ')
    .slice(0, 48)
    .trim() || 'obsidian';
  const hash = stableHash(`${vault.path}|${relativePath}`, 10);
  return sanitizeKnowledgeFilename(`${vaultSlug} - ${readable} [obsidian-${hash}].md`, `${hash}.md`);
}

export function removeExistingFileMemories(db: any, filename: string, scope: FileScope, options: { userId?: string; agentId?: string } = {}): void {
  const existing = findExistingFileMemories(db, filename, scope, options);
  if (existing.length === 0) return;
  const ids = new Set(existing.map((m: any) => m.id));
  db.memories = (db.memories || []).filter((m: any) => !ids.has(m.id));
}

export async function syncObsidianNote(
  vault: ObsidianVaultConfig,
  note: ObsidianNoteFile,
  userId: string,
  scope: FileScope,
  db: any,
): Promise<{ status: 'synced' | 'skipped'; file?: any }> {
  const finalName = obsidianDestinationName(vault, note.relativePath);
  const dest = path.join(scope.dir, finalName);
  const existingMemories = scope.domain === 'personal'
    ? findExistingFileMemories(db, finalName, scope, { userId, agentId: 'lumi' })
    : [];
  if (fs.existsSync(dest)) {
    const destStat = fs.statSync(dest);
    const unchanged = destStat.mtimeMs >= note.mtimeMs - 1000
      && (scope.domain === 'work' || existingMemories.length > 0);
    if (unchanged) {
      const meta = findFileMeta(db, finalName, scope);
      const agentIds = Array.isArray(meta?.agentIds) && meta.agentIds.length > 0
        ? meta.agentIds
        : scope.domain === 'work' ? ['org-kb'] : ['lumi'];
      return { status: 'skipped', file: buildEntry(finalName, 'obsidian', agentIds, scope, meta?.status || 'indexed', meta) };
    }
  }

  fs.copyFileSync(note.absolutePath, dest);
  const sourceStat = fs.statSync(note.absolutePath);
  try { fs.utimesSync(dest, sourceStat.atime, sourceStat.mtime); } catch {}

  if (!db.knowledgeFiles) db.knowledgeFiles = [];
  let meta = findFileMeta(db, finalName, scope);
  if (!meta) {
    meta = {
      filename: finalName,
      displayName: repairFilename(finalName),
      userId: scope.userId,
      domain: scope.domain,
      orgId: scope.orgId || '',
      source: 'obsidian',
      agentIds: [],
      createdAt: new Date().toISOString(),
    };
    db.knowledgeFiles.push(meta);
  }
  if (!Array.isArray(meta.agentIds)) meta.agentIds = [];
  meta.source = 'obsidian';
  meta.obsidianVaultId = vault.id;
  meta.obsidianVaultName = vault.name;
  meta.obsidianVaultPath = vault.path;
  meta.obsidianRelativePath = note.relativePath;
  meta.obsidianSourcePath = note.absolutePath;
  meta.updatedAt = new Date().toISOString();

  const extraction = extractTextKnowledge(dest);
  const content = extraction.content || '';
  applyExtractionMeta(meta, extraction, content);

  if (scope.domain === 'work') {
    const article = await ensureOrgArticleFromFile(scope, userId, finalName, content, meta.orgArticleId, extraction.sourceMetadata);
    meta.orgArticleId = article?.id;
    if (!meta.agentIds.includes('org-kb')) meta.agentIds.push('org-kb');
    meta.status = 'indexed';
    const manifest = article?.id && scope.orgId
      ? OrgKB.getArticleIngestionManifest(scope.orgId, article.id)
      : null;
    if (manifest) applyIngestionManifest(meta, manifest);
  } else {
    removeExistingFileMemories(db, finalName, scope, { userId, agentId: 'lumi' });
    const result = await ingestDocument(userId, 'lumi', finalName, content, {
      filePath: dest,
      domain: scope.domain,
      orgId: scope.orgId || '',
      sourceMetadata: extraction.sourceMetadata,
      extraction,
    });
    if (!meta.agentIds.includes('lumi')) meta.agentIds.push('lumi');
    meta.status = 'indexed';
    meta.chunkCount = result.chunkCount;
    applyIngestionManifest(meta, result.manifest);
  }

  return { status: 'synced', file: buildEntry(finalName, 'obsidian', meta.agentIds, scope, meta.status, meta) };
}

export async function syncObsidianVault(
  vault: ObsidianVaultConfig,
  userId: string,
  scope: FileScope,
  db: any,
  options: { maxFiles?: number } = {},
): Promise<{
  vault: ObsidianVaultConfig;
  noteCount: number;
  synced: number;
  skipped: number;
  failed: number;
  truncated: boolean;
  files: any[];
  errors: Array<{ path: string; error: string }>;
}> {
  const scan = scanObsidianVault(vault.path, options.maxFiles);
  let synced = 0;
  let skipped = 0;
  let failed = 0;
  const files: any[] = [];
  const errors = [...scan.skipped];

  for (const note of scan.notes) {
    try {
      const result = await syncObsidianNote(vault, note, userId, scope, db);
      if (result.status === 'synced') synced++;
      else skipped++;
      if (result.file) files.push(result.file);
    } catch (err: any) {
      failed++;
      errors.push({ path: note.relativePath, error: err?.message || String(err) });
    }
  }

  const now = new Date().toISOString();
  vault.lastScanAt = now;
  vault.lastSyncAt = now;
  vault.lastNoteCount = scan.notes.length;
  vault.lastSyncResult = { synced, skipped, failed, noteCount: scan.notes.length };
  vault.updatedAt = now;

  return {
    vault,
    noteCount: scan.notes.length,
    synced,
    skipped,
    failed,
    truncated: scan.truncated,
    files,
    errors,
  };
}
