import crypto from 'crypto';
import { recordKnowledgeCoverageEvaluation, recordKnowledgeRetrievalEvaluation } from '../runtime/capability_metrics';

export const KNOWLEDGE_GOLDEN_TOP_K = 5 as const;
export const KNOWLEDGE_RECALL_AT_5_MIN = 0.95;
export const KNOWLEDGE_CITATION_ACCURACY_MIN = 0.98;

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
  /** Sensitive golden prompts and answers are represented by immutable digests only. */
  questionDigest: string;
  referenceAnswerDigest: string;
  expectedChunkIndexes: number[];
  expectedCitationChunkIndexes: number[];
  retrievedMemoryIds: string[];
  citedChunkHashes: string[];
}

export interface KnowledgeRetrievalEvaluation {
  evaluatedAt: string;
  method: 'golden_qa_v1';
  caseDefinitionDigest: string;
  topK: number;
  caseCount: number;
  recallAtK: number;
  citationAccuracy: number;
  passed: boolean;
  cases: KnowledgeRetrievalCaseEvidence[];
}

export interface KnowledgeGoldenCaseDefinition {
  caseId: string;
  question: string;
  referenceAnswer: string;
  expectedChunkIndexes: number[];
  /** Defaults to expectedChunkIndexes when the reference answer uses the same evidence. */
  expectedCitationChunkIndexes?: number[];
}

export interface KnowledgeGoldenRetrievalResult {
  memoryId: string;
  chunkContentHash: string;
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
    failureKind?: 'empty_extraction' | 'encrypted_or_password_required' | 'corrupt_source' | 'provider_unavailable' | 'unsupported_format' | 'extraction_error';
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
    failureKind?: KnowledgeIngestionManifest['extraction']['failureKind'];
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
    if (manifest.retrieval.method !== 'golden_qa_v1') blockers.push('retrieval_not_golden_qa');
    if (!/^[a-f0-9]{64}$/i.test(manifest.retrieval.caseDefinitionDigest || '')) blockers.push('golden_case_digest_missing');
    if (manifest.retrieval.topK !== KNOWLEDGE_GOLDEN_TOP_K) blockers.push('retrieval_top_k_not_5');
    if (manifest.retrieval.caseCount <= 0) blockers.push('retrieval_cases_missing');
    if (manifest.retrieval.recallAtK < KNOWLEDGE_RECALL_AT_5_MIN) blockers.push('recall_below_threshold');
    if (manifest.retrieval.citationAccuracy < KNOWLEDGE_CITATION_ACCURACY_MIN) blockers.push('citation_below_threshold');
    if (!manifest.retrieval.passed) blockers.push('retrieval_evaluation_failed');
  }

  const verified = blockers.length === 0;
  let status: KnowledgeIngestionStatus = 'indexed_unverified';
  if (!sourceRevisionCurrent) status = 'stale';
  else if (manifest.extraction.status === 'unsupported') status = 'unsupported';
  else if (manifest.extraction.status === 'failed' || chunkCount === 0 || storedCount === 0) status = 'failed';
  else if (verified) status = 'verified';
  else if (extractionCoverage < 1 || chunkStorageCoverage < 1) status = 'partial';

  const evaluation = {
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
  recordKnowledgeCoverageEvaluation(evaluation.status, evaluation.coverage);
  return evaluation;
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
      failureKind: input.extraction?.failureKind || undefined,
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
  const topK = Math.max(1, Math.min(20, Number(input.topK) || KNOWLEDGE_GOLDEN_TOP_K));
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
    const chunkHashByIndex = new Map(input.chunks.map(chunk => [chunk.index, chunk.contentHash]));
    const expectedCitationIndexes = evidence.expectedCitationChunkIndexes?.length
      ? evidence.expectedCitationChunkIndexes
      : evidence.expectedChunkIndexes;
    const expectedCitationHashes = new Set(
      expectedCitationIndexes
        .map(index => chunkHashByIndex.get(index) || `missing_chunk_${index}`),
    );
    const actualCitationHashes = new Set(evidence.citedChunkHashes.filter(Boolean));
    citationTotal += Math.max(expectedCitationHashes.size, actualCitationHashes.size);
    for (const citationHash of actualCitationHashes) {
      if (expectedCitationHashes.has(citationHash)) correctCitations += 1;
    }
  }

  const recallAtK = ratio(recallHits, recallTotal);
  const citationAccuracy = ratio(correctCitations, citationTotal);
  const evidenceComplete = input.cases.every(evidence => (
    /^[a-f0-9]{64}$/i.test(evidence.questionDigest || '')
    && /^[a-f0-9]{64}$/i.test(evidence.referenceAnswerDigest || '')
    && evidence.expectedChunkIndexes.length > 0
    && (evidence.expectedCitationChunkIndexes?.length || 0) > 0
  ));
  const caseDefinitionDigest = digest(JSON.stringify(input.cases.map(evidence => ({
    caseId: evidence.caseId,
    questionDigest: evidence.questionDigest,
    referenceAnswerDigest: evidence.referenceAnswerDigest,
    expectedChunkIndexes: evidence.expectedChunkIndexes,
    expectedCitationChunkIndexes: evidence.expectedCitationChunkIndexes,
  }))));
  const evaluation = {
    evaluatedAt: input.now || new Date().toISOString(),
    method: 'golden_qa_v1' as const,
    caseDefinitionDigest,
    topK,
    caseCount: input.cases.length,
    recallAtK,
    citationAccuracy,
    passed: input.cases.length > 0
      && evidenceComplete
      && recallTotal > 0
      && citationTotal > 0
      && topK === KNOWLEDGE_GOLDEN_TOP_K
      && recallAtK >= KNOWLEDGE_RECALL_AT_5_MIN
      && citationAccuracy >= KNOWLEDGE_CITATION_ACCURACY_MIN,
    cases: input.cases,
  };
  recordKnowledgeRetrievalEvaluation({
    cases: input.cases.length,
    expectedItems: recallTotal,
    retrievalHits: recallHits,
    citationChecks: citationTotal,
    citationHits: correctCitations,
  });
  return evaluation;
}

function normalizeGoldenIndexes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map(index => Number(index))
    .filter(index => Number.isInteger(index) && index >= 0)))
    .sort((a, b) => a - b);
}

/**
 * Execute user/owner supplied golden questions against the real retrieval path.
 * The first N retrieved chunks are treated as the deterministic citation selection,
 * where N is the number of citations in the reference answer. Plaintext questions
 * and reference answers are never persisted in the manifest.
 */
export async function runKnowledgeGoldenEvaluation(input: {
  cases: KnowledgeGoldenCaseDefinition[];
  chunks: KnowledgeChunkManifest[];
  retrieve: (question: string, topK: number) => Promise<KnowledgeGoldenRetrievalResult[]>;
  now?: string;
}): Promise<KnowledgeRetrievalEvaluation> {
  if (!Array.isArray(input.cases) || input.cases.length === 0) {
    throw new Error('At least one golden knowledge question is required.');
  }
  if (input.cases.length > 500) throw new Error('Golden knowledge evaluation is limited to 500 cases per run.');
  const availableIndexes = new Set(input.chunks.map(chunk => chunk.index));
  const caseIds = new Set<string>();
  const evidence: KnowledgeRetrievalCaseEvidence[] = [];

  for (const raw of input.cases) {
    const caseId = String(raw?.caseId || '').trim().slice(0, 160);
    const question = String(raw?.question || '').trim();
    const referenceAnswer = String(raw?.referenceAnswer || '').trim();
    const expectedChunkIndexes = normalizeGoldenIndexes(raw?.expectedChunkIndexes);
    const expectedCitationChunkIndexes = normalizeGoldenIndexes(
      raw?.expectedCitationChunkIndexes?.length
        ? raw.expectedCitationChunkIndexes
        : raw?.expectedChunkIndexes,
    );
    if (!caseId || caseIds.has(caseId)) throw new Error('Golden knowledge case IDs must be non-empty and unique.');
    if (!question || question.length > 10_000) throw new Error(`Golden case ${caseId} has an invalid question.`);
    if (!referenceAnswer || referenceAnswer.length > 50_000) throw new Error(`Golden case ${caseId} has an invalid reference answer.`);
    if (expectedChunkIndexes.length === 0 || expectedChunkIndexes.some(index => !availableIndexes.has(index))) {
      throw new Error(`Golden case ${caseId} references an unavailable retrieval chunk.`);
    }
    if (expectedCitationChunkIndexes.length === 0 || expectedCitationChunkIndexes.some(index => !availableIndexes.has(index))) {
      throw new Error(`Golden case ${caseId} references an unavailable citation chunk.`);
    }
    caseIds.add(caseId);
    const retrieved = (await input.retrieve(question, KNOWLEDGE_GOLDEN_TOP_K)).slice(0, KNOWLEDGE_GOLDEN_TOP_K);
    evidence.push({
      caseId,
      questionDigest: hashKnowledgeContent(question),
      referenceAnswerDigest: hashKnowledgeContent(referenceAnswer),
      expectedChunkIndexes,
      expectedCitationChunkIndexes,
      retrievedMemoryIds: retrieved.map(result => String(result.memoryId || '')).filter(Boolean),
      citedChunkHashes: retrieved
        .slice(0, expectedCitationChunkIndexes.length)
        .map(result => String(result.chunkContentHash || ''))
        .filter(Boolean),
    });
  }

  return evaluateKnowledgeRetrievalCases({
    cases: evidence,
    chunks: input.chunks,
    topK: KNOWLEDGE_GOLDEN_TOP_K,
    now: input.now,
  });
}

export function markKnowledgeManifestStale(
  manifest: KnowledgeIngestionManifest,
  currentContent: string,
): KnowledgeIngestionManifest {
  const currentRevision = hashKnowledgeContent(currentContent);
  const base = { ...manifest, updatedAt: new Date().toISOString() };
  return { ...base, ...evaluateKnowledgeManifest(base, currentRevision) };
}
