import { beforeEach, describe, expect, it } from 'vitest';
import {
  getCapabilityRuntimeMetrics,
  recordDesktopAuthorizationBlock,
  recordDesktopExecutionReceipt,
  recordDesktopPlanCreated,
  recordKnowledgeCoverageEvaluation,
  recordKnowledgeRetrievalEvaluation,
  recordModelArbitration,
  recordModelFallback,
  recordModelFallbackSuppressedAfterSideEffect,
  recordModelGraphCompilation,
  recordModelNodeRecovery,
  recordRoutingShadowComparison,
  resetCapabilityRuntimeMetricsForTests,
} from '../server/runtime/capability_metrics';

describe('capability runtime metrics', () => {
  beforeEach(() => resetCapabilityRuntimeMetricsForTests());

  it('reports desktop safety and routing divergence without payload content', () => {
    recordDesktopPlanCreated();
    recordDesktopAuthorizationBlock('Desktop action requires a fresh, unused foreground-window fingerprint.');
    recordDesktopAuthorizationBlock('External desktop commit requires a fully certified application identity observation.');
    recordDesktopExecutionReceipt({
      planId: 'plan-1',
      taskId: 'task-1',
      applicationMatched: false,
      applicationCertification: 'mismatch',
      steps: [],
      finalState: 'target_mismatch',
      evidence: [],
      completionVerified: false,
    });
    recordRoutingShadowComparison(false, true);

    const metrics = getCapabilityRuntimeMetrics();
    expect(metrics.desktop).toMatchObject({
      plans: 1,
      receipts: 1,
      staleObservationBlocks: 1,
      targetMismatches: 1,
      identityMismatches: 1,
      externalCommitCertificationBlocks: 1,
    });
    expect(metrics.routing).toEqual({ comparisons: 1, divergences: 1, externalCommitBlocks: 1 });
    expect(JSON.stringify(metrics)).not.toContain('task-1');
  });

  it('reports model graph recovery, fallback and arbitration outcomes', () => {
    recordModelGraphCompilation(false);
    recordModelFallback();
    recordModelFallbackSuppressedAfterSideEffect();
    recordModelNodeRecovery();
    recordModelArbitration({
      graphId: 'graph-1',
      taskId: 'task-1',
      policy: 'majority_vote',
      status: 'blocked',
      selectedNodeIds: [],
      consideredNodeIds: [],
      outputDigest: '',
      completedAt: new Date(0).toISOString(),
    });

    expect(getCapabilityRuntimeMetrics().modelGraph).toEqual({
      compilations: 1,
      invalidGraphs: 1,
      fallbacks: 1,
      fallbackSuppressedAfterSideEffect: 1,
      recoveredNodes: 1,
      arbitrations: 1,
      blockedArbitrations: 1,
    });
  });

  it('reports the latest knowledge acceptance coverage', () => {
    recordKnowledgeCoverageEvaluation('verified', {
      extractionCoverage: 1,
      chunkStorageCoverage: 1,
      embeddingCoverage: 1,
      retrievalRecallAt5: 0.95,
      citationAccuracy: 0.98,
      sourceRevisionCurrent: true,
      verified: true,
      blockers: [],
    });
    recordKnowledgeRetrievalEvaluation({
      cases: 100,
      expectedItems: 100,
      retrievalHits: 95,
      citationChecks: 100,
      citationHits: 98,
    });

    expect(getCapabilityRuntimeMetrics().knowledge).toMatchObject({
      evaluations: 1,
      verified: 1,
      unverified: 0,
      lastStatus: 'verified',
      lastRecallAt5: 0.95,
      lastCitationAccuracy: 0.98,
      retrievalCases: 100,
      aggregateRecallAt5: 0.95,
      aggregateCitationAccuracy: 0.98,
    });
  });
});
