import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeIngestionManifest,
  chunkKnowledgeText,
  evaluateKnowledgeManifest,
  evaluateKnowledgeRetrievalCases,
  KNOWLEDGE_CITATION_ACCURACY_MIN,
  KNOWLEDGE_GOLDEN_TOP_K,
  KNOWLEDGE_RECALL_AT_5_MIN,
  markKnowledgeManifestStale,
  type KnowledgeChunkManifest,
} from '../server/knowledge/ingestion_manifest';

function storedChunk(index: number, text: string): KnowledgeChunkManifest {
  return {
    index,
    start: index * text.length,
    end: (index + 1) * text.length,
    charCount: text.length,
    contentHash: chunkKnowledgeText(text, { maxChunkSize: 500 })[0].contentHash,
    memoryId: `memory-${index}`,
    stored: true,
    embeddingStatus: 'verified',
    embeddingProvider: 'test',
    embeddingModel: 'test-embedding',
    embeddingDimensions: 3,
    citationKey: `source:test#chunk:${index + 1}`,
  };
}

describe('knowledge ingestion manifests', () => {
  it('retains exact normalized source offsets and stable content hashes', () => {
    const source = '  alpha beta gamma  delta epsilon  ';
    const first = chunkKnowledgeText(source, { maxChunkSize: 100, overlapSize: 10 });
    const second = chunkKnowledgeText(source, { maxChunkSize: 100, overlapSize: 10 });

    expect(first).toHaveLength(1);
    expect(source.slice(first[0].start, first[0].end)).toBe(first[0].text);
    expect(first[0].text).toBe('alpha beta gamma  delta epsilon');
    expect(first[0].contentHash).toBe(second[0].contentHash);
  });

  it('does not call stored chunks fully absorbed without embedding and retrieval evidence', () => {
    const chunk = storedChunk(0, 'Evidence must be verified.');
    chunk.embeddingStatus = 'failed';
    const manifest = buildKnowledgeIngestionManifest({
      sourceId: 'test.txt',
      content: 'Evidence must be verified.',
      chunks: [chunk],
      extraction: { status: 'indexed', method: 'text' },
      now: '2026-01-01T00:00:00.000Z',
    });

    expect(manifest.status).toBe('indexed_unverified');
    expect(manifest.coverage.verified).toBe(false);
    expect(manifest.coverage.blockers).toEqual(expect.arrayContaining([
      'embedding_incomplete',
      'retrieval_not_evaluated',
    ]));
  });

  it('requires Recall@5 and exact citation provenance before verified status', () => {
    const chunks = [storedChunk(0, 'alpha'), storedChunk(1, 'beta')];
    const retrieval = evaluateKnowledgeRetrievalCases({
      chunks,
      cases: chunks.map(chunk => ({
        caseId: `case-${chunk.index}`,
        expectedChunkIndexes: [chunk.index],
        retrievedMemoryIds: [chunk.memoryId!],
        citedChunkHashes: [chunk.contentHash],
      })),
      topK: 5,
      now: '2026-01-01T00:01:00.000Z',
    });
    const manifest = buildKnowledgeIngestionManifest({
      sourceId: 'test.txt',
      content: 'alpha beta',
      chunks,
      extraction: { status: 'indexed', method: 'text' },
      retrieval,
      now: '2026-01-01T00:00:00.000Z',
    });

    expect(retrieval).toMatchObject({ recallAtK: 1, citationAccuracy: 1, passed: true });
    expect(manifest.status).toBe('verified');
    expect(manifest.coverage.verified).toBe(true);
  });

  it('enforces the product Recall@5 and citation thresholds at their boundaries', () => {
    const chunks = Array.from({ length: 100 }, (_, index) => storedChunk(index, `chunk-${index}`));
    const passingCases = chunks.map((chunk, index) => ({
      caseId: `case-${index}`,
      expectedChunkIndexes: [chunk.index],
      retrievedMemoryIds: index < 95 ? [chunk.memoryId!] : [],
      citedChunkHashes: index < 98 ? [chunk.contentHash] : ['not-a-source-chunk'],
    }));
    const passing = evaluateKnowledgeRetrievalCases({ chunks, cases: passingCases, topK: 5 });

    expect(KNOWLEDGE_GOLDEN_TOP_K).toBe(5);
    expect(KNOWLEDGE_RECALL_AT_5_MIN).toBe(0.95);
    expect(KNOWLEDGE_CITATION_ACCURACY_MIN).toBe(0.98);
    expect(passing).toMatchObject({ topK: 5, recallAtK: 0.95, citationAccuracy: 0.98, passed: true });

    const failingRecall = evaluateKnowledgeRetrievalCases({
      chunks,
      cases: passingCases.map((entry, index) => ({
        ...entry,
        retrievedMemoryIds: index < 94 ? entry.retrievedMemoryIds : [],
      })),
      topK: 5,
    });
    const failingCitation = evaluateKnowledgeRetrievalCases({
      chunks,
      cases: passingCases.map((entry, index) => ({
        ...entry,
        citedChunkHashes: index < 97 ? [chunks[index].contentHash] : ['not-a-source-chunk'],
      })),
      topK: 5,
    });

    expect(failingRecall).toMatchObject({ recallAtK: 0.94, passed: false });
    expect(failingCitation).toMatchObject({ citationAccuracy: 0.97, passed: false });
  });

  it('does not accept a non-Top-5 evaluation or an empty citation set as verified absorption', () => {
    const chunk = storedChunk(0, 'alpha');
    const nonTopFive = evaluateKnowledgeRetrievalCases({
      chunks: [chunk],
      cases: [{
        caseId: 'case-0',
        expectedChunkIndexes: [0],
        retrievedMemoryIds: [chunk.memoryId!],
        citedChunkHashes: [chunk.contentHash],
      }],
      topK: 3,
    });
    const noCitations = evaluateKnowledgeRetrievalCases({
      chunks: [chunk],
      cases: [{
        caseId: 'case-0',
        expectedChunkIndexes: [0],
        retrievedMemoryIds: [chunk.memoryId!],
        citedChunkHashes: [],
      }],
      topK: 5,
    });

    expect(nonTopFive.passed).toBe(false);
    expect(noCitations.passed).toBe(false);

    const manifest = buildKnowledgeIngestionManifest({
      sourceId: 'test.txt',
      content: 'alpha',
      chunks: [chunk],
      extraction: { status: 'indexed', method: 'text' },
      retrieval: nonTopFive,
    });
    expect(manifest.coverage.verified).toBe(false);
    expect(manifest.coverage.blockers).toEqual(expect.arrayContaining([
      'retrieval_top_k_not_5',
      'retrieval_evaluation_failed',
    ]));
  });

  it('invalidates a previously verified manifest when the source revision changes', () => {
    const chunk = storedChunk(0, 'alpha');
    const retrieval = evaluateKnowledgeRetrievalCases({
      chunks: [chunk],
      cases: [{
        caseId: 'case-0',
        expectedChunkIndexes: [0],
        retrievedMemoryIds: [chunk.memoryId!],
        citedChunkHashes: [chunk.contentHash],
      }],
    });
    const manifest = buildKnowledgeIngestionManifest({
      sourceId: 'test.txt',
      content: 'alpha',
      chunks: [chunk],
      extraction: { status: 'indexed', method: 'text' },
      retrieval,
    });
    const stale = markKnowledgeManifestStale(manifest, 'alpha changed');

    expect(manifest.status).toBe('verified');
    expect(stale.status).toBe('stale');
    expect(stale.coverage.blockers).toContain('source_revision_changed');
  });

  it('flags incomplete chunk storage independently of extraction success', () => {
    const chunk = storedChunk(0, 'alpha');
    chunk.stored = false;
    delete chunk.memoryId;
    const manifest = buildKnowledgeIngestionManifest({
      sourceId: 'test.txt',
      content: 'alpha',
      chunks: [chunk],
      extraction: { status: 'indexed', method: 'text' },
    });
    const evaluated = evaluateKnowledgeManifest(manifest);

    expect(evaluated.status).toBe('failed');
    expect(evaluated.coverage.chunkStorageCoverage).toBe(0);
  });
});
