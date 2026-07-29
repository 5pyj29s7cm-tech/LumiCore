import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { readDB } from '../../../db_layer';
import { getDataPath } from '../../config/data_path';
import { ToolRegistry } from '../registry';
import {
  evaluateKnowledgeManifest,
  type KnowledgeIngestionManifest,
  type KnowledgeIngestionStatus,
} from '../../knowledge/ingestion_manifest';

function scopeDirectory(userId: string, domain: string, orgId: string): string {
  if (domain === 'work' && orgId) return getDataPath(path.join('org', orgId, 'knowledge'));
  const db = readDB();
  const primaryAdmin = (db.users || []).find((user: any) => user?.role === 'admin');
  if (primaryAdmin?.uid === userId) return getDataPath('knowledge');
  const directoryId = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24);
  return getDataPath(path.join('knowledge', '_users', directoryId));
}

function metaMatchesScope(meta: any, userId: string, domain: string, orgId: string, primaryOwner: boolean): boolean {
  const metaDomain = String(meta?.domain || (meta?.orgId ? 'work' : 'personal')).toLowerCase();
  if (metaDomain !== domain) return false;
  if (domain === 'work') return String(meta?.orgId || '') === orgId;
  if (meta?.orgId) return false;
  if (meta?.userId) return String(meta.userId) === userId;
  return primaryOwner;
}

function memoryMatchesFile(memory: any, name: string, userId: string, domain: string, orgId: string): boolean {
  if (memory?.type !== 'knowledge' || String(memory?.userId || '') !== userId) return false;
  if (String(memory?.domain || 'personal') !== domain || String(memory?.orgId || '') !== orgId) return false;
  const target = name.normalize('NFC').toLowerCase();
  const source = String(memory?.sourceInteractionId || '');
  if (source && path.basename(source).normalize('NFC').toLowerCase() === target) return true;
  const keywords = Array.isArray(memory?.keywords) ? memory.keywords : [];
  if (keywords.some((keyword: unknown) => String(keyword || '').normalize('NFC').toLowerCase() === `source:${target}`)) return true;
  return String(memory?.content || '').normalize('NFC').startsWith(`[${name} #`);
}

interface KnowledgeCoverageFile {
  name: string;
  status: KnowledgeIngestionStatus;
  legacyStatus: string;
  contentChars: number;
  manifestId?: string;
  sourceRevision?: string;
  coverage?: KnowledgeIngestionManifest['coverage'];
  blockers: string[];
}

function buildKnowledgeCoverageSnapshot(context: any, filename = ''): Record<string, any> {
  const userId = String(context?.userId || 'anonymous');
  const domain = context?.domain === 'work' ? 'work' : 'personal';
  const orgId = domain === 'work' ? String(context?.orgId || '') : '';
  if (domain === 'work' && !orgId) throw new Error('Organization context is required for work knowledge statistics.');

  const db = readDB();
  const primaryAdmin = (db.users || []).find((user: any) => user?.role === 'admin');
  const primaryOwner = Boolean(primaryAdmin?.uid && primaryAdmin.uid === userId);
  const dir = scopeDirectory(userId, domain, orgId);
  fs.mkdirSync(dir, { recursive: true });
  const requested = String(filename || '').trim().normalize('NFC').toLowerCase();
  const names = fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
    .map(entry => entry.name)
    .filter(name => !requested || name.normalize('NFC').toLowerCase() === requested)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const metas = (db.knowledgeFiles || []).filter((meta: any) => metaMatchesScope(meta, userId, domain, orgId, primaryOwner));
  const metaByName = new Map(metas.map((meta: any) => [String(meta.filename || ''), meta]));
  const files: KnowledgeCoverageFile[] = names.map(name => {
    const meta: any = metaByName.get(name) || {};
    const inferredMemories = (db.memories || []).filter((memory: any) => memoryMatchesFile(memory, name, userId, domain, orgId));
    const legacyStatus = String(meta.extractionStatus || meta.status || 'ready');
    const storedManifest = meta.ingestionManifest && meta.ingestionManifest.schemaVersion === 1
      ? meta.ingestionManifest as KnowledgeIngestionManifest
      : undefined;
    const manifest = storedManifest
      ? { ...storedManifest, ...evaluateKnowledgeManifest(storedManifest) }
      : undefined;
    let status: KnowledgeIngestionStatus;
    const blockers = Array.isArray(manifest?.coverage?.blockers) ? [...manifest!.coverage.blockers] : [];
    if (manifest) {
      status = manifest.status;
      try {
        const modifiedAt = fs.statSync(path.join(dir, name)).mtimeMs;
        const manifestedAt = new Date(manifest.updatedAt || manifest.createdAt).getTime();
        if (Number.isFinite(modifiedAt) && Number.isFinite(manifestedAt) && modifiedAt > manifestedAt + 1_000) {
          status = 'stale';
          if (!blockers.includes('source_file_changed')) blockers.push('source_file_changed');
        }
      } catch {}
    } else if (['failed'].includes(legacyStatus)) status = 'failed';
    else if (legacyStatus === 'unsupported') status = 'unsupported';
    else if (legacyStatus === 'partial') status = 'partial';
    else if (inferredMemories.length > 0 || legacyStatus === 'indexed') status = 'indexed_unverified';
    else status = 'pending';

    if (!manifest && status === 'indexed_unverified') blockers.push('legacy_index_has_no_verification_manifest');
    if (domain === 'work' && !manifest && meta.orgArticleId) blockers.push('organization_index_has_no_file_manifest');
    return {
      name,
      status,
      legacyStatus,
      contentChars: Number(meta.contentChars || inferredMemories.reduce((sum: number, memory: any) => sum + String(memory?.content || '').length, 0)),
      manifestId: manifest?.manifestId,
      sourceRevision: manifest?.sourceRevision,
      coverage: manifest?.coverage,
      blockers,
    };
  });

  return {
    domain,
    orgId: orgId || undefined,
    totalFiles: files.length,
    indexedFiles: files.filter(file => ['verified', 'indexed_unverified', 'partial'].includes(file.status)).length,
    verifiedFiles: files.filter(file => file.status === 'verified').length,
    indexedUnverifiedFiles: files.filter(file => file.status === 'indexed_unverified').length,
    partialFiles: files.filter(file => file.status === 'partial').length,
    staleFiles: files.filter(file => file.status === 'stale').length,
    failedFiles: files.filter(file => ['failed', 'unsupported'].includes(file.status)).length,
    fullyAbsorbed: files.length > 0 && files.every(file => file.status === 'verified'),
    files,
  };
}

export function registerKnowledgeTools(registry: ToolRegistry): void {
  registry.register({
    name: 'knowledge_file_stats',
    description: 'Return the exact current-workspace Lumi knowledge-file count, indexing status, and visible filenames. Use this for questions about how many files are currently in the knowledge base; do not substitute client_get_state.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args, context) => {
      return JSON.stringify(buildKnowledgeCoverageSnapshot(context));
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'knowledge_coverage_report',
    description: 'Return verifiable extraction, chunk-storage, embedding, Recall@5, citation, revision, and blocker evidence for one or all current-workspace knowledge files. Only status=verified may be described as fully absorbed.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Optional exact visible filename. Omit for every file in the current workspace.' },
      },
      required: [],
    },
    handler: async (args, context) => JSON.stringify(buildKnowledgeCoverageSnapshot(context, String(args?.filename || ''))),
    permission: 'user',
    securityLevel: 'safe',
  });
}
