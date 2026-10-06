import path from "path";
import fs from "fs";
import { readKnowledgeFileState } from "../knowledge_state";
import type { KnowledgeIngestionManifest } from "../../knowledge/ingestion_manifest";
import { hasCurrentMemoryEmbedding } from "../../memory/embedding_identity";
import { buildKnowledgeIngestionManifest, evaluateKnowledgeManifest, hashKnowledgeContent } from "../../knowledge/ingestion_manifest";
import type { MarkdownKnowledgeMetadata } from "../../knowledge/markdown";
import type { KnowledgeExtractionResult, KnowledgeFileSource, FileScope, KnowledgeStatus, KnowledgeEntry } from './contracts';
import { repairFilename, formatSize } from './formats';

export function applyExtractionMeta(meta: any, extraction: KnowledgeExtractionResult, content: string | null): void {
  if (!meta) return;
  meta.extractionStatus = extraction.status;
  meta.extractionMethod = extraction.method;
  meta.extractionWarning = extraction.warning || '';
  meta.extractionError = extraction.error || '';
  meta.extractionFailureKind = extraction.failureKind || '';
  meta.extractionProvider = extraction.provider || '';
  meta.extractionModel = extraction.model || '';
  meta.contentChars = content?.length || 0;
  if (extraction.sourceMetadata) {
    meta.sourceTitle = extraction.sourceMetadata.title;
    meta.sourceAliases = extraction.sourceMetadata.aliases;
    meta.sourceTags = extraction.sourceMetadata.tags;
    meta.sourceLinks = extraction.sourceMetadata.links;
    meta.sourceProperties = extraction.sourceMetadata.frontmatter;
  } else {
    delete meta.sourceTitle;
    delete meta.sourceAliases;
    delete meta.sourceTags;
    delete meta.sourceLinks;
    delete meta.sourceProperties;
  }
  meta.updatedAt = new Date().toISOString();
}

export function buildNonIndexedManifest(
  sourceId: string,
  extraction: KnowledgeExtractionResult,
): KnowledgeIngestionManifest {
  return buildKnowledgeIngestionManifest({
    sourceId,
    content: '',
    chunks: [],
    extraction,
  });
}

export function applyIngestionManifest(meta: any, manifest: KnowledgeIngestionManifest): void {
  if (!meta) return;
  meta.ingestionManifest = manifest;
  meta.ingestionManifestId = manifest.manifestId;
  meta.ingestionStatus = manifest.status;
  meta.ingestionCoverage = manifest.coverage;
  meta.chunkCount = manifest.chunks.length;
  meta.sourceRevision = manifest.sourceRevision;
  meta.updatedAt = new Date().toISOString();
}

export function readCurrentIngestionManifest(meta: any): KnowledgeIngestionManifest | null {
  const manifest = meta?.ingestionManifest as KnowledgeIngestionManifest | undefined;
  if (!manifest || manifest.schemaVersion !== 1) return null;
  return { ...manifest, ...evaluateKnowledgeManifest(manifest) };
}

export function hasCurrentVerifiedManifest(meta: any, content: string, existingMemoryIds: string[]): boolean {
  const manifest = meta?.ingestionManifest as KnowledgeIngestionManifest | undefined;
  if (!manifest || manifest.schemaVersion !== 1) return false;
  if (manifest.sourceRevision !== hashKnowledgeContent(content)) return false;
  const existing = new Set(existingMemoryIds);
  const actualMemories = new Map((readKnowledgeFileState().memories || [])
    .filter((memory: any) => existing.has(String(memory.id)))
    .map((memory: any) => [String(memory.id), memory]));
  return manifest.chunks.length > 0
    && manifest.chunks.every(chunk => {
      const memory = actualMemories.get(String(chunk.memoryId));
      return Boolean(memory && hasCurrentMemoryEmbedding(memory as any));
    })
    && manifest.coverage?.chunkStorageCoverage === 1;
}

export function buildOrgArticleTags(filename: string, metadata?: MarkdownKnowledgeMetadata): string[] {
  const ext = path.extname(filename).replace(/^\./, '');
  return [
    'upload',
    ext,
    ...(metadata?.tags || []),
    ...(metadata?.aliases || []).map(alias => `alias:${alias}`),
  ].map(tag => String(tag || '').trim()).filter(Boolean).slice(0, 20);
}

export function sameKnowledgeFileOwnership(current: any, expected: any): boolean {
  return Boolean(current && expected && ['filename', 'userId', 'domain', 'orgId', 'createdAt', 'indexingRevision']
    .every(key => String(current[key] || '') === String(expected[key] || '')));
}

export function buildEntry(filename: string, source: KnowledgeFileSource, agentIds: string[] = [], scope: FileScope, status?: KnowledgeStatus, meta?: any): KnowledgeEntry {
  const filePath = path.join(scope.dir, filename);
  const displayName = repairFilename(meta?.displayName || filename);
  let st: fs.Stats;
  try { st = fs.statSync(filePath); }
  catch { st = { size: 0, mtime: new Date(), birthtime: new Date() } as fs.Stats; }
  const currentManifest = readCurrentIngestionManifest(meta);
  return {
    id: filename,
    name: displayName,
    displayName,
    path: filePath,
    domain: scope.domain,
    orgId: scope.orgId,
    size: formatSize(st.size),
    rawSize: st.size,
    type: 'file',
    source,
    archiveId: meta?.archiveId,
    archiveKind: meta?.archiveKind,
    sourceConversationId: meta?.sourceConversationId,
    agentIds,
    status: status || (agentIds.length > 0 ? 'indexed' : 'ready'),
    extractionStatus: meta?.extractionStatus,
    extractionMethod: meta?.extractionMethod,
    extractionWarning: meta?.extractionWarning || undefined,
    extractionError: meta?.extractionError || undefined,
    extractionFailureKind: meta?.extractionFailureKind || undefined,
    extractionProvider: meta?.extractionProvider || undefined,
    extractionModel: meta?.extractionModel || undefined,
    contentChars: meta?.contentChars || undefined,
    ingestionStatus: currentManifest?.status || meta?.ingestionStatus || (meta?.status === 'indexed' ? 'indexed_unverified' : undefined),
    ingestionManifestId: meta?.ingestionManifestId || undefined,
    ingestionCoverage: currentManifest?.coverage || meta?.ingestionCoverage || undefined,
    sourceTitle: meta?.sourceTitle || undefined,
    sourceAliases: Array.isArray(meta?.sourceAliases) ? meta.sourceAliases : undefined,
    sourceTags: Array.isArray(meta?.sourceTags) ? meta.sourceTags : undefined,
    sourceLinks: Array.isArray(meta?.sourceLinks) ? meta.sourceLinks : undefined,
    sourceBacklinks: Array.isArray(meta?.sourceBacklinks) ? meta.sourceBacklinks : undefined,
    sourceProperties: meta?.sourceProperties || undefined,
    obsidianVaultId: meta?.obsidianVaultId || undefined,
    obsidianVaultName: meta?.obsidianVaultName || undefined,
    obsidianVaultPath: meta?.obsidianVaultPath || undefined,
    obsidianRelativePath: meta?.obsidianRelativePath || undefined,
    obsidianSourcePath: meta?.obsidianSourcePath || undefined,
    updatedAt: st.mtime.toISOString(),
    createdAt: st.birthtime.toISOString(),
  };
}
