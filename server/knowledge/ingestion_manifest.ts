import crypto from 'crypto';

export type KnowledgeIngestionStatus =
  | 'pending'
  | 'indexed_unverified'
  | 'verified'
  | 'partial'
  | 'stale'
  | 'failed'
  | 'unsupported';

export type KnowledgeStageStatus = 'pending' | 'verified' | 'partial' | 'failed' | 'unsupported';

export interface KnowledgeChunkDescriptor {
  index: number;
  start: number;
  end: number;
  charCount: number;
  contentHash: string;
  text: string;
}

export interface KnowledgeChunkManifest extends Omit<KnowledgeChunkDescriptor, 'text'> {
  memoryId?: string;
  stored: boolean;
  embeddingStatus: 'pending' | 'verified' | 'failed' | 'skipped';
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  citationKey: string;
  error?: string;
}

export interface KnowledgeRetrievalCaseEvidence {
  caseId: string;
  expectedChunkIndexes: number[];
  retrievedMemoryIds: string[];
  citedChunkHashes: string[];
}

export interface KnowledgeRetrievalEvaluation {
  evaluatedAt: string;
  topK: number;
  caseCount: number;
  recallAtK: number;
  citationAccuracy: number;
  passed: boolean;
  cases: KnowledgeRetrievalCaseEvidence[];
}

export interface KnowledgeCoverageReport {
  extractionCoverage: number;
  chunkStorageCoverage: number;
  embeddingCoverage: number;
  retrievalRecallAt5: number | null;
  citationAccuracy: number | null;
  sourceRevisionCurrent: boolean;
  verified: boolean;
  blockers: string[];
}

export interface KnowledgeIngestionManifest {
  schemaVersion: 1;
  manifestId: string;
  sourceId: string;
  sourceRevision: string;
  sourceContentHash: string;
  sourceCharCount: number;
  createdAt: string;
  updatedAt: string;
  extraction: {
    status: KnowledgeStageStatus;
    method: string;
    contentHash: string;
    contentChars: number;
    warning?: string;
    error?: string;
  };
  chunks: KnowledgeChunkManifest[];
  retrieval?: KnowledgeRetrievalEvaluation;
  coverage: KnowledgeCoverageReport;
  status: KnowledgeIngestionStatus;
}

export interface KnowledgeManifestInput {
  sourceId: string;
  content: string;
  chunks: KnowledgeChunkManifest[];
  extraction?: {
    status?: string;
    method?: string;
    warning?: string;
    error?: string;
  };
  retrieval?: KnowledgeRetrievalEvaluation;
  previousSourceRevision?: string;
  now?: string;
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function normalizeExtractionStatus(value: string | undefined, hasContent: boolean): KnowledgeStageStatus {
  const status = String(value || '').toLowerCase();
  if (status === 'unsupported') return 'unsupported';
  if (status === 'failed') return 'failed';
  if (status === 'partial') return 'partial';
  if (!hasContent) return 'failed';
  return 'verified';
}

export function hashKnowledgeContent(value: string): string {
  return digest(String(value || '').normalize('NFC'));
}

/** Split source text while retaining exact source offsets and immutable hashes. */
export function chunkKnowledgeText(
  text: string,
  options: { maxChunkSize?: number; overlapSize?: number } = {},
): KnowledgeChunkDescriptor[] {
  const source = String(text || '');
  const maxChunkSize = Math.max(100, Math.min(12_000, Number(options.maxChunkSize) || 500));
  const overlapSize = Math.max(0, Math.min(maxChunkSize - 1, Number(options.overlapSize) || 50));
  const step = maxChunkSize - overlapSize;
  const chunks: KnowledgeChunkDescriptor[] = [];

  for (let offset = 0; offset < source.length; offset += step) {
    const raw = source.slice(offset, offset + maxChunkSize);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const start = offset + leading;
    const end = offset + raw.length - trailing;
    if (end <= start) continue;
    const chunk = source.slice(start, end);
    chunks.push({
      index: chunks.length,
      start,
      end,
      charCount: chunk.length,
      contentHash: hashKnowledgeContent(chunk),
      text: chunk,
    });
  }
  return chunks;
}

export function evaluateKnowledgeManifest(
  manifest: Omit<KnowledgeIngestionManifest, 'coverage' | 'status'>,
  currentSourceRevision = manifest.sourceRevision,
): Pick<KnowledgeIngestionManifest, 'coverage' | 'status'> {
  const chunkCount = manifest.chunks.length;
  const storedCount = manifest.chunks.filter(chunk => chunk.stored && Boolean(chunk.memoryId)).length;
  const embeddedCount = manifest.chunks.filter(chunk => chunk.embeddingStatus === 'verified').length;
  const extractionCoverage = manifest.extraction.status === 'verified'
    ? 1
    : manifest.extraction.status === 'partial' ? 0.5 : 0;
  const chunkStorageCoverage = ratio(storedCount, chunkCount);
  const embeddingCoverage = ratio(embeddedCount, chunkCount);
  const sourceRevisionCurrent = currentSourceRevision === manifest.sourceRevision;
  const retrievalRecallAt5 = manifest.retrieval?.recallAtK ?? null;
  const citationAccuracy = manifest.retrieval?.citationAccuracy ?? null;
  const blockers: string[] = [];

  if (!sourceRevisionCurrent) blockers.push('source_revision_changed');
  if (extractionCoverage < 1) blockers.push(`extraction_${manifest.extraction.status}`);
  if (chunkCount === 0) blockers.push('no_chunks');
  if (chunkStorageCoverage < 1) blockers.push('chunk_storage_incomplete');
  if (embeddingCoverage < 1) blockers.push('embedding_incomplete');
  if (!manifest.retrieval) blockers.push('retrieval_not_evaluated');
  else {
    if (manifest.retrieval.recallAtK < 0.8) blockers.push('recall_below_threshold');
    if (manifest.retrieval.citationAccuracy < 1) blockers.push('citation_inaccurate');
  }

  const verified = blockers.length === 0;
  let status: KnowledgeIngestionStatus = 'indexed_unverified';
  if (!sourceRevisionCurrent) status = 'stale';
  else if (manifest.extraction.status === 'unsupported') status = 'unsupported';
  else if (manifest.extraction.status === 'failed' || chunkCount === 0 || storedCount === 0) status = 'failed';
  else if (verified) status = 'verified';
  else if (extractionCoverage < 1 || chunkStorageCoverage < 1) status = 'partial';

  return {
    status,
    coverage: {
      extractionCoverage,
      chunkStorageCoverage,
      embeddingCoverage,
      retrievalRecallAt5,
      citationAccuracy,
      sourceRevisionCurrent,
      verified,
      blockers,
    },
  };
}

export function buildKnowledgeIngestionManifest(input: KnowledgeManifestInput): KnowledgeIngestionManifest {
  const now = input.now || new Date().toISOString();
  const sourceContentHash = hashKnowledgeContent(input.content);
  const sourceRevision = sourceContentHash;
  const extractionStatus = normalizeExtractionStatus(input.extraction?.status, Boolean(input.content.trim()));
  const base: Omit<KnowledgeIngestionManifest, 'coverage' | 'status'> = {
    schemaVersion: 1,
    manifestId: `knowledge_manifest_${digest(`${input.sourceId}\u0000${sourceRevision}`).slice(0, 24)}`,
    sourceId: input.sourceId,
    sourceRevision,
    sourceContentHash,
    sourceCharCount: input.content.length,
    createdAt: now,
    updatedAt: now,
    extraction: {
      status: extractionStatus,
      method: String(input.extraction?.method || 'text'),
      contentHash: sourceContentHash,
      contentChars: input.content.length,
      warning: input.extraction?.warning || undefined,
      error: input.extraction?.error || undefined,
    },
    chunks: input.chunks,
    retrieval: input.retrieval,
  };
  return { ...base, ...evaluateKnowledgeManifest(base, input.previousSourceRevision || sourceRevision) };
}

export function evaluateKnowledgeRetrievalCases(input: {
  topK?: number;
  cases: KnowledgeRetrievalCaseEvidence[];
  chunks: KnowledgeChunkManifest[];
  now?: string;
}): KnowledgeRetrievalEvaluation {
  const topK = Math.max(1, Math.min(20, Number(input.topK) || 5));
  const memoryToChunk = new Map(input.chunks.map(chunk => [chunk.memoryId || '', chunk.index]));
  let recallHits = 0;
  let recallTotal = 0;
  let correctCitations = 0;
  let citationTotal = 0;

  for (const evidence of input.cases) {
    const retrievedIndexes = new Set(
      evidence.retrievedMemoryIds.slice(0, topK)
        .map(memoryId => memoryToChunk.get(memoryId))
        .filter((index): index is number => typeof index === 'number'),
    );
    for (const expected of evidence.expectedChunkIndexes) {
      recallTotal += 1;
      if (retrievedIndexes.has(expected)) recallHits += 1;
    }
    const validHashes = new Set(input.chunks.map(chunk => chunk.contentHash));
    for (const citationHash of evidence.citedChunkHashes) {
      citationTotal += 1;
      if (validHashes.has(citationHash)) correctCitations += 1;
    }
  }

  const recallAtK = ratio(recallHits, recallTotal);
  const citationAccuracy = ratio(correctCitations, citationTotal);
  return {
    evaluatedAt: input.now || new Date().toISOString(),
    topK,
    caseCount: input.cases.length,
    recallAtK,
    citationAccuracy,
    passed: input.cases.length > 0 && recallAtK >= 0.8 && citationAccuracy === 1,
    cases: input.cases,
  };
}

export function markKnowledgeManifestStale(
  manifest: KnowledgeIngestionManifest,
  currentContent: string,
): KnowledgeIngestionManifest {
  const currentRevision = hashKnowledgeContent(currentContent);
  const base = { ...manifest, updatedAt: new Date().toISOString() };
  return { ...base, ...evaluateKnowledgeManifest(base, currentRevision) };
}
