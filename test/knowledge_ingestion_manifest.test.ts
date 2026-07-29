import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeIngestionManifest,
  chunkKnowledgeText,
  evaluateKnowledgeManifest,
  evaluateKnowledgeRetrievalCases,
  hashKnowledgeContent,
  KNOWLEDGE_CITATION_ACCURACY_MIN,
  KNOWLEDGE_GOLDEN_TOP_K,
  KNOWLEDGE_RECALL_AT_5_MIN,
  markKnowledgeManifestStale,
  runKnowledgeGoldenEvaluation,
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
        questionDigest: hashKnowledgeContent(`question-${chunk.index}`),
        referenceAnswerDigest: hashKnowledgeContent(`answer-${chunk.index}`),
        expectedChunkIndexes: [chunk.index],
        expectedCitationChunkIndexes: [chunk.index],
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
      questionDigest: hashKnowledgeContent(`question-${index}`),
      referenceAnswerDigest: hashKnowledgeContent(`answer-${index}`),
      expectedChunkIndexes: [chunk.index],
      expectedCitationChunkIndexes: [chunk.index],
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

  it('rejects a citation to the wrong chunk even when it belongs to the same source', () => {
    const chunks = [storedChunk(0, 'correct evidence'), storedChunk(1, 'wrong evidence')];
    const retrieval = evaluateKnowledgeRetrievalCases({
      chunks,
      cases: [{
        caseId: 'same-source-wrong-citation',
        questionDigest: hashKnowledgeContent('Which evidence is correct?'),
        referenceAnswerDigest: hashKnowledgeContent('The first evidence is correct.'),
        expectedChunkIndexes: [0],
        expectedCitationChunkIndexes: [0],
        retrievedMemoryIds: [chunks[0].memoryId!],
        citedChunkHashes: [chunks[1].contentHash],
      }],
      topK: 5,
    });

    expect(retrieval).toMatchObject({ recallAtK: 1, citationAccuracy: 0, passed: false });
  });

  it('runs plaintext golden questions through retrieval but persists only their digests', async () => {
    const chunks = [storedChunk(0, 'expected launch evidence'), storedChunk(1, 'unrelated evidence')];
    const question = 'What is the verified launch evidence?';
    const referenceAnswer = 'The expected launch evidence is authoritative.';
    const retrieval = await runKnowledgeGoldenEvaluation({
      chunks,
      cases: [{
        caseId: 'launch-evidence',
        question,
        referenceAnswer,
        expectedChunkIndexes: [0],
        expectedCitationChunkIndexes: [0],
      }],
      retrieve: async receivedQuestion => {
        expect(receivedQuestion).toBe(question);
        return [{ memoryId: chunks[0].memoryId!, chunkContentHash: chunks[0].contentHash }];
      },
      now: '2026-01-01T00:00:00.000Z',
    });

    expect(retrieval).toMatchObject({
      method: 'golden_qa_v1',
      recallAtK: 1,
      citationAccuracy: 1,
      passed: true,
    });
    expect(retrieval.caseDefinitionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(retrieval)).not.toContain(question);
    expect(JSON.stringify(retrieval)).not.toContain(referenceAnswer);
  });

  it('invalidates legacy synthetic retrieval evidence that was previously marked verified', () => {
    const chunk = storedChunk(0, 'legacy synthetic probe');
    const golden = evaluateKnowledgeRetrievalCases({
      chunks: [chunk],
      cases: [{
        caseId: 'legacy-probe',
        questionDigest: hashKnowledgeContent('legacy question'),
        referenceAnswerDigest: hashKnowledgeContent('legacy answer'),
        expectedChunkIndexes: [0],
        expectedCitationChunkIndexes: [0],
        retrievedMemoryIds: [chunk.memoryId!],
        citedChunkHashes: [chunk.contentHash],
      }],
    });
    const legacyRetrieval = { ...golden } as any;
    delete legacyRetrieval.method;
    delete legacyRetrieval.caseDefinitionDigest;
    const manifest = buildKnowledgeIngestionManifest({
      sourceId: 'legacy.txt',
      content: 'legacy synthetic probe',
      chunks: [chunk],
      extraction: { status: 'indexed', method: 'text' },
      retrieval: legacyRetrieval,
    });

    expect(manifest.status).toBe('indexed_unverified');
    expect(manifest.coverage.verified).toBe(false);
    expect(manifest.coverage.blockers).toEqual(expect.arrayContaining([
      'retrieval_not_golden_qa',
      'golden_case_digest_missing',
    ]));
  });

  it('does not accept a non-Top-5 evaluation or an empty citation set as verified absorption', () => {
    const chunk = storedChunk(0, 'alpha');
    const nonTopFive = evaluateKnowledgeRetrievalCases({
      chunks: [chunk],
      cases: [{
        caseId: 'case-0',
        questionDigest: hashKnowledgeContent('question-0'),
        referenceAnswerDigest: hashKnowledgeContent('answer-0'),
        expectedChunkIndexes: [0],
        expectedCitationChunkIndexes: [0],
        retrievedMemoryIds: [chunk.memoryId!],
        citedChunkHashes: [chunk.contentHash],
      }],
      topK: 3,
    });
    const noCitations = evaluateKnowledgeRetrievalCases({
      chunks: [chunk],
      cases: [{
        caseId: 'case-0',
        questionDigest: hashKnowledgeContent('question-0'),
        referenceAnswerDigest: hashKnowledgeContent('answer-0'),
        expectedChunkIndexes: [0],
        expectedCitationChunkIndexes: [0],
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
        questionDigest: hashKnowledgeContent('question-0'),
        referenceAnswerDigest: hashKnowledgeContent('answer-0'),
        expectedChunkIndexes: [0],
        expectedCitationChunkIndexes: [0],
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
