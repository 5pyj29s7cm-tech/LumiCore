import path from "path";
import fs from "fs";
import { invalidateMemoryEmbedding } from "../../memory/embedding_identity";
import { evaluateKnowledgeManifest } from "../../knowledge/ingestion_manifest";
import { normalizeKnowledgeLinkTarget } from "../../knowledge/markdown";
import type { FileScope } from './contracts';
import { findFileMeta, metaMatchesScope } from './ownership';
import { readCurrentIngestionManifest, applyIngestionManifest } from './metadata';
import { repairFilename } from './formats';

// ── GET /files/list — list knowledge base files ──
export function groupExistingFileMemories(
  db: any, filenames: string[], scope: FileScope,
  options: { userId?: string; agentId?: string } = {},
): Map<string, any[]> {
  const grouped = new Map<string, any[]>(), targets = new Map<string, string[]>();
  const names = new Set(filenames);
  let headerLength = 0;
  for (const name of names) {
    const key = name.normalize('NFC').toLowerCase();
    targets.set(key, [...(targets.get(key) || []), name]);
    headerLength = Math.max(headerLength, name.length + 3);
  }
  if (!names.size) return grouped;
  for (const memory of db.memories || []) {
    if (memory?.type !== 'knowledge' || (options.userId && memory.userId !== options.userId)
      || (options.agentId && (memory.agentId || '') !== options.agentId)
      || (memory.domain || 'personal') !== scope.domain || (memory.orgId || '') !== (scope.orgId || '')) continue;
    const matched = new Set<string>();
    const include = (key: string) => { for (const name of targets.get(key) || []) matched.add(name); };
    include(path.basename(String(memory.sourceInteractionId || '')).normalize('NFC').toLowerCase());
    for (const keyword of Array.isArray(memory.keywords) ? memory.keywords : []) {
      const key = String(keyword || '').normalize('NFC').toLowerCase();
      if (key.startsWith('source:')) include(key.slice(7));
    }
    // Preserve every legacy prefix match, including filenames containing " #".
    const header = String(memory.content || '').normalize('NFC').slice(0, headerLength);
    if (header.startsWith('[')) for (let end = header.indexOf(' #', 1); end !== -1; end = header.indexOf(' #', end + 2)) {
      const name = header.slice(1, end);
      if (names.has(name)) matched.add(name);
    }
    for (const name of matched) {
      if (!grouped.has(name)) grouped.set(name, []);
      grouped.get(name)!.push(memory);
    }
  }
  return grouped;
}

export function findExistingFileMemories(
  db: any, filename: string, scope: FileScope,
  options: { userId?: string; agentId?: string } = {},
): any[] {
  return groupExistingFileMemories(db, [filename], scope, options).get(filename) || [];
}

export function removeFileMemoryReferences(db: any, filename: string, scope: FileScope): number {
  if (scope.domain !== 'personal') return 0;
  const ids = new Set(
    findExistingFileMemories(db, filename, scope, { userId: scope.userId })
      .map((memory: any) => memory.id)
      .filter(Boolean),
  );
  if (ids.size === 0) return 0;
  db.memories = (db.memories || []).filter((memory: any) => !ids.has(memory.id));
  return ids.size;
}

export function renameFileMemoryReferences(
  db: any,
  oldName: string,
  newName: string,
  newPath: string,
  scope: FileScope,
): number {
  if (scope.domain !== 'personal') return 0;
  const memories = findExistingFileMemories(db, oldName, scope, { userId: scope.userId });
  const normalizedOldName = oldName.normalize('NFC').toLowerCase();
  const oldSourceKeyword = `source:${oldName}`.normalize('NFC').toLowerCase();
  for (const memory of memories) {
    const content = String(memory.content || '');
    if (content.startsWith(`[${oldName} #`)) {
      memory.content = `[${newName} #${content.slice(oldName.length + 3)}`;
    }
    memory.keywords = (Array.isArray(memory.keywords) ? memory.keywords : []).map((keyword: unknown) => {
      const value = String(keyword || '');
      const normalized = value.normalize('NFC').toLowerCase();
      if (normalized === normalizedOldName) return newName;
      if (normalized === oldSourceKeyword) return `source:${newName}`;
      return value;
    });
    memory.sourceInteractionId = newPath;
    if (memory.knowledgeProvenance) {
      const provenance = memory.knowledgeProvenance;
      provenance.sourcePath = newPath;
      provenance.sourceLabel = newName;
      provenance.citationKey = `source:${newName}#chunk:${provenance.chunkIndex + 1}/${provenance.chunkCount}#sha256:${provenance.chunkContentHash}`;
    }
    invalidateMemoryEmbedding(memory);
    memory.updatedAt = new Date().toISOString();
  }
  const meta = findFileMeta(db, oldName, scope);
  const manifest = readCurrentIngestionManifest(meta);
  if (manifest) {
    const renamed = new Map(memories.map((memory: any) => [String(memory.id), memory]));
    const chunks = manifest.chunks.map(chunk => {
      const memory = renamed.get(String(chunk.memoryId));
      if (!memory) return chunk;
      const updated = {
        ...chunk,
        citationKey: memory.knowledgeProvenance?.citationKey || chunk.citationKey,
        embeddingStatus: 'pending' as const,
      };
      delete updated.embeddingProvider;
      delete updated.embeddingModel;
      delete updated.embeddingDimensions;
      delete updated.error;
      return updated;
    });
    // A source keeps its ingestion identity across a rename, but the new
    // filename changes embedding input and invalidates prior retrieval proof.
    const updated = { ...manifest, chunks, updatedAt: new Date().toISOString() };
    delete updated.retrieval;
    applyIngestionManifest(meta, { ...updated, ...evaluateKnowledgeManifest(updated) });
  }
  return memories.length;
}

export function normalizedKnowledgeFileKeys(filename: string): string[] {
  const repaired = repairFilename(filename);
  const stem = path.basename(repaired, path.extname(repaired));
  return [
    normalizeKnowledgeLinkTarget(repaired),
    normalizeKnowledgeLinkTarget(stem),
  ].filter(Boolean);
}

export function buildSourceBacklinkMap(metaByName: Record<string, any>, filenames: string[]): Map<string, string[]> {
  const filenameByKey = new Map<string, string>();
  for (const filename of filenames) {
    for (const key of normalizedKnowledgeFileKeys(filename)) {
      if (!filenameByKey.has(key)) filenameByKey.set(key, filename);
    }
  }

  const backlinks = new Map<string, Set<string>>();
  for (const sourceName of filenames) {
    const meta = metaByName[sourceName];
    const links = Array.isArray(meta?.sourceLinks) ? meta.sourceLinks : [];
    for (const link of links) {
      const targetName = filenameByKey.get(normalizeKnowledgeLinkTarget(link));
      if (!targetName || targetName === sourceName) continue;
      if (!backlinks.has(targetName)) backlinks.set(targetName, new Set());
      backlinks.get(targetName)!.add(repairFilename(sourceName));
    }
  }

  return new Map([...backlinks.entries()].map(([filename, sources]) => [filename, [...sources].sort()]));
}

export function getSourceBacklinks(db: any, scope: FileScope, filename: string): string[] {
  const scopedMeta: Record<string, any> = {};
  const names = fs.existsSync(scope.dir)
    ? fs.readdirSync(scope.dir).filter(name => !name.startsWith('.') && !name.startsWith('_'))
    : [];
  for (const m of db.knowledgeFiles || []) {
    if (metaMatchesScope(m, scope)) scopedMeta[m.filename] = m;
  }
  return buildSourceBacklinkMap(scopedMeta, names).get(filename) || [];
}
