import type { DesktopExecutionReceipt } from '../desktop/execution_plan';
import type { KnowledgeCoverageReport, KnowledgeIngestionStatus } from '../knowledge/ingestion_manifest';

interface CapabilityRuntimeCounters {
  desktop: {
    plans: number;
    receipts: number;
    verified: number;
    blocked: number;
    failed: number;
    unknownOutcomes: number;
    targetMismatches: number;
    identityCertified: number;
    identityConditional: number;
    identityMismatches: number;
    externalCommitCertificationBlocks: number;
    staleObservationBlocks: number;
    unauthorizedToolBlocks: number;
  };
  routing: {
    comparisons: number;
    divergences: number;
    externalCommitBlocks: number;
  };
  knowledge: {
    evaluations: number;
    verified: number;
    unverified: number;
    lastStatus: KnowledgeIngestionStatus | null;
    lastRecallAt5: number | null;
    lastCitationAccuracy: number | null;
    lastExtractionCoverage: number | null;
    lastChunkStorageCoverage: number | null;
    lastEmbeddingCoverage: number | null;
    retrievalCases: number;
    expectedItems: number;
    retrievalHits: number;
    citationChecks: number;
    citationHits: number;
    aggregateRecallAt5: number | null;
    aggregateCitationAccuracy: number | null;
  };
}

function emptyCounters(): CapabilityRuntimeCounters {
  return {
    desktop: {
      plans: 0,
      receipts: 0,
      verified: 0,
      blocked: 0,
      failed: 0,
      unknownOutcomes: 0,
      targetMismatches: 0,
      identityCertified: 0,
      identityConditional: 0,
      identityMismatches: 0,
      externalCommitCertificationBlocks: 0,
      staleObservationBlocks: 0,
      unauthorizedToolBlocks: 0,
    },
    routing: { comparisons: 0, divergences: 0, externalCommitBlocks: 0 },
    knowledge: {
      evaluations: 0,
      verified: 0,
      unverified: 0,
      lastStatus: null,
      lastRecallAt5: null,
      lastCitationAccuracy: null,
      lastExtractionCoverage: null,
      lastChunkStorageCoverage: null,
      lastEmbeddingCoverage: null,
      retrievalCases: 0,
      expectedItems: 0,
      retrievalHits: 0,
      citationChecks: 0,
      citationHits: 0,
      aggregateRecallAt5: null,
      aggregateCitationAccuracy: null,
    },
  };
}

let counters = emptyCounters();

export function recordDesktopPlanCreated(): void {
  counters.desktop.plans += 1;
}

export function recordDesktopAuthorizationBlock(reason: string): void {
  if (/fresh|fingerprint/i.test(reason)) counters.desktop.staleObservationBlocks += 1;
  if (/did not authorize control tool/i.test(reason)) counters.desktop.unauthorizedToolBlocks += 1;
  if (/target application/i.test(reason)) counters.desktop.targetMismatches += 1;
  if (/fully certified application identity/i.test(reason)) counters.desktop.externalCommitCertificationBlocks += 1;
}

export function recordDesktopExecutionReceipt(receipt: DesktopExecutionReceipt): void {
  counters.desktop.receipts += 1;
  if (receipt.completionVerified) counters.desktop.verified += 1;
  if (receipt.finalState === 'blocked') counters.desktop.blocked += 1;
  if (receipt.finalState === 'failed') counters.desktop.failed += 1;
  if (receipt.finalState === 'unknown_outcome') counters.desktop.unknownOutcomes += 1;
  if (receipt.finalState === 'target_mismatch') counters.desktop.targetMismatches += 1;
  if (receipt.applicationCertification === 'certified') counters.desktop.identityCertified += 1;
  if (receipt.applicationCertification === 'conditional') counters.desktop.identityConditional += 1;
  if (receipt.applicationCertification === 'mismatch') counters.desktop.identityMismatches += 1;
}

export function recordRoutingShadowComparison(aligned: boolean, externalCommitBlocked: boolean): void {
  counters.routing.comparisons += 1;
  if (!aligned) counters.routing.divergences += 1;
  if (externalCommitBlocked) counters.routing.externalCommitBlocks += 1;
}

export function recordKnowledgeCoverageEvaluation(
  status: KnowledgeIngestionStatus,
  coverage: KnowledgeCoverageReport,
): void {
  counters.knowledge.evaluations += 1;
  if (coverage.verified) counters.knowledge.verified += 1;
  else counters.knowledge.unverified += 1;
  counters.knowledge.lastStatus = status;
  counters.knowledge.lastRecallAt5 = coverage.retrievalRecallAt5;
  counters.knowledge.lastCitationAccuracy = coverage.citationAccuracy;
  counters.knowledge.lastExtractionCoverage = coverage.extractionCoverage;
  counters.knowledge.lastChunkStorageCoverage = coverage.chunkStorageCoverage;
  counters.knowledge.lastEmbeddingCoverage = coverage.embeddingCoverage;
}

export function recordKnowledgeRetrievalEvaluation(input: {
  cases: number;
  expectedItems: number;
  retrievalHits: number;
  citationChecks: number;
  citationHits: number;
}): void {
  counters.knowledge.retrievalCases += Math.max(0, input.cases);
  counters.knowledge.expectedItems += Math.max(0, input.expectedItems);
  counters.knowledge.retrievalHits += Math.max(0, input.retrievalHits);
  counters.knowledge.citationChecks += Math.max(0, input.citationChecks);
  counters.knowledge.citationHits += Math.max(0, input.citationHits);
  counters.knowledge.aggregateRecallAt5 = counters.knowledge.expectedItems
    ? Number((counters.knowledge.retrievalHits / counters.knowledge.expectedItems).toFixed(4))
    : null;
  counters.knowledge.aggregateCitationAccuracy = counters.knowledge.citationChecks
    ? Number((counters.knowledge.citationHits / counters.knowledge.citationChecks).toFixed(4))
    : null;
}

export function getCapabilityRuntimeMetrics() {
  return {
    generatedAt: new Date().toISOString(),
    desktop: { ...counters.desktop },
    routing: { ...counters.routing },
    knowledge: { ...counters.knowledge },
  };
}

export function resetCapabilityRuntimeMetricsForTests(): void {
  counters = emptyCounters();
}
