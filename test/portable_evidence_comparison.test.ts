import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PORTABLE_EVIDENCE_BUNDLE_KIND,
  PORTABLE_EXTERNAL_EVIDENCE_MANIFEST_KIND,
  PORTABLE_STORE_SNAPSHOT_KIND,
  PortableExternalEvidenceCollector,
  normalizePortableEvidenceManifest,
  phaseBindingFromManifest,
  portableEvidenceHmacKeyId,
  portableEvidenceSha256,
  signPortableEvidenceRecord,
} from '../scripts/lib/portable-external-evidence.mjs';
import {
  PORTABLE_BUILD_IDENTITY_KIND,
  PORTABLE_FORMAL_NATIVE_EVIDENCE_KIND,
  REQUIRED_FORMAL_NATIVE_CHECKS,
  comparePortableEvidencePairs,
  createSignedPortableBuildIdentity,
  createSignedPortableFormalNativeEvidence,
  createSignedPortableManifest,
} from '../scripts/lib/portable-evidence-comparison.mjs';
import {
  parsePortableEvidenceComparisonArgs,
  runPortableEvidenceComparisonCli,
} from '../scripts/compare-portable-evidence.mjs';

const roots: string[] = [];
const BASELINE_KEY = Buffer.alloc(32, 0x51);
const CANDIDATE_KEY = Buffer.alloc(32, 0x52);
const PROFILE_SHA256 = digest('portable-profile-v1');
const COLLECTOR_SHA256 = digest('portable-collector-bundle-v1');
const FIXTURE_SHA256 = digest('portable-fixture-plan-v1');
const TIMEOUT_POLICY = Object.freeze({
  turnMs: 30_000,
  providerMs: 20_000,
  passiveStoreMs: 10_000,
  settleMs: 100,
});
const NODE_MAJOR = Number.parseInt(process.versions.node.split('.')[0], 10);

function digest(value: unknown) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-portable-comparison-'));
  roots.push(root);
  return root;
}

function resign(record: any, key: Buffer, changes: Record<string, unknown> = {}) {
  const { attestation: _attestation, ...unsigned } = record;
  return signPortableEvidenceRecord({ ...unsigned, ...changes }, key);
}

type SideOptions = {
  build?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  expectedToolName?: string;
  model?: string;
  phaseIssues?: string[];
  phaseClaims?: Record<string, unknown>;
  bundleClaims?: Record<string, unknown>;
  mutateObservations?: (observations: any, context: any) => void;
  structuralIssues?: string[];
};

function createSide(role: 'baseline' | 'candidate', options: SideOptions = {}) {
  const key = role === 'baseline' ? BASELINE_KEY : CANDIDATE_KEY;
  const ordinal = role === 'baseline' ? '1' : '2';
  const buildIdentity = createSignedPortableBuildIdentity({
    kind: PORTABLE_BUILD_IDENTITY_KIND,
    schemaVersion: 1,
    role,
    revision: ordinal.repeat(40),
    sourceDirty: false,
    sourceFingerprintSha256: digest(`${role}-source`),
    runtimeFingerprintSha256: digest(`${role}-runtime`),
    collectedAt: role === 'baseline'
      ? '2026-08-27T08:00:00.000Z'
      : '2026-08-27T08:01:00.000Z',
    ...options.build,
  }, key);
  const requestId = `${role}-request-cleanup`;
  const conversationId = `${role}-conversation`;
  const userId = `${role}-user`;
  const expectedToolName = options.expectedToolName === undefined
    ? 'runtime_work_cancel'
    : options.expectedToolName;
  const manifest = normalizePortableEvidenceManifest({
    kind: PORTABLE_EXTERNAL_EVIDENCE_MANIFEST_KIND,
    schemaVersion: 1,
    runId: `${role}-portable-run`,
    role,
    buildIdentityDigest: buildIdentity.buildIdentityDigest,
    profileSha256: PROFILE_SHA256,
    collectorBundleSha256: COLLECTOR_SHA256,
    fixturePlanSha256: FIXTURE_SHA256,
    timeoutPolicy: TIMEOUT_POLICY,
    platform: process.platform,
    nodeMajor: NODE_MAJOR,
    dataRootIdentitySha256: digest(`${role}-isolated-data-root`),
    hmacKeyId: portableEvidenceHmacKeyId(key),
    ...options.manifest,
    phases: [
      {
        scenarioId: 'cleanup_offer_then_cleanup',
        phaseId: 'cleanup',
        requestId,
        phaseNonce: `${role}-phase-nonce-00000001`,
        conversationId,
        userId,
        expectedToolName,
        requirements: { passiveStore: true, providerWitness: true },
      },
    ],
  });
  const phase = manifest.phases[0];
  const { binding } = phaseBindingFromManifest(manifest, {
    scenarioId: phase.scenarioId,
    phaseId: phase.phaseId,
    requestId: phase.requestId,
    phaseNonce: phase.phaseNonce,
  });
  const userRow = {
    id: `${role}-user-row`,
    requestId,
    conversationId,
    userId,
    role: 'user',
    providerMarkerCount: 1,
  };
  const assistantRow = {
    id: `${role}-assistant-row`,
    requestId,
    conversationId,
    userId,
    role: 'assistant',
    displayedText: {
      characters: 4,
      sha256: portableEvidenceSha256('done'),
    },
  };
  const observations: any = {
    interactions: { state: 'present', rowCount: 2, rows: [userRow, assistantRow] },
    acceptedUserRow: {
      state: 'present',
      rowCount: 1,
      rows: [userRow],
      providerMarkerCount: 1,
      providerMarkerSha256: portableEvidenceSha256(phase.providerMarker),
      phaseNonceSha256: portableEvidenceSha256(phase.phaseNonce),
    },
    assistantReplies: { state: 'present', rowCount: 1, rows: [assistantRow] },
    conversation: {
      state: 'present',
      rowCount: 1,
      rows: [{ id: conversationId, userId }],
    },
    livePointer: { state: 'cleared' },
    turn: {
      state: 'present',
      rowCount: 1,
      rows: [{
        id: `${role}-turn`,
        requestId,
        conversationId,
        userId,
        taskId: '',
        status: 'succeeded',
      }],
    },
    task: { state: 'cleared', rowCount: 0, rows: [] },
    receipts: expectedToolName
      ? {
          state: 'present',
          rowCount: 1,
          rows: [{
            receiptId: `${role}-receipt`,
            taskId: requestId,
            requestId,
            conversationId,
            toolName: expectedToolName,
            outcome: 'succeeded',
          }],
        }
      : { state: 'cleared', rowCount: 0, rows: [] },
    pending: { state: 'cleared', rowCount: 0, rows: [] },
    routing: {
      state: 'present',
      rowCount: 1,
      rows: [{
        id: `${role}-routing`,
        requestId,
        conversationId,
        status: 'succeeded',
        selectedModel: options.model || 'portable-stub-v1',
      }],
    },
  };
  options.mutateObservations?.(observations, {
    phase, binding, requestId, conversationId, userId, expectedToolName,
  });
  const structuralIssues = options.structuralIssues || [];
  const storeSnapshot = signPortableEvidenceRecord({
    kind: PORTABLE_STORE_SNAPSHOT_KIND,
    schemaVersion: 1,
    manifestDigest: manifest.manifestDigest,
    binding,
    capturedAt: '2026-08-27T08:02:00.000Z',
    source: {
      kind: 'portable-test-store',
      dataRootIdentitySha256: manifest.dataRootIdentitySha256,
    },
    selectionPolicy: 'exact_conversation_user_request_only_no_latest_wins',
    observations,
    expectedToolName,
    expectedToolReceiptCount: expectedToolName && observations.receipts.state === 'present'
      ? observations.receipts.rows.filter((row: any) => row.toolName === expectedToolName).length
      : null,
    structurallyComplete: structuralIssues.length === 0,
    structuralIssues,
  }, key);
  const collector = new PortableExternalEvidenceCollector({
    manifest,
    hmacKey: key,
    now: () => new Date('2026-08-27T08:03:00.000Z'),
  });
  collector.addStoreSnapshot(storeSnapshot);
  collector.captureProviderRequest({
    scenarioId: phase.scenarioId,
    phaseId: phase.phaseId,
    requestId: phase.requestId,
    phaseNonce: phase.phaseNonce,
  }, {
    model: options.model || 'portable-stub-v1',
    messages: [{ role: 'user', content: `execute ${phase.providerMarker}` }],
    tools: expectedToolName
      ? [{ type: 'function', function: { name: expectedToolName } }]
      : [],
  }, { providerRequestNonce: `${role}-provider-nonce-00000001` });
  const collectedBundle = collector.buildBundle();
  const phaseEvidence = collectedBundle.phaseEvidence.map((item: any) => ({
    ...item,
    complete: true,
    passed: true,
    internalIntegrityPassed: true,
    issues: options.phaseIssues || item.issues,
    ...options.phaseClaims,
  }));
  const bundle = resign(collectedBundle, key, {
    kind: PORTABLE_EVIDENCE_BUNDLE_KIND,
    complete: true,
    passed: true,
    phaseEvidence,
    ...options.bundleClaims,
  });
  return {
    key,
    manifest,
    buildIdentity,
    bundle,
    phase,
    input: {
      hmacKey: key,
      manifest: createSignedPortableManifest(manifest, key),
      buildIdentity,
      bundle,
      formalNativeEvidence: undefined as any,
    },
  };
}

function createPair(options: { baseline?: SideOptions; candidate?: SideOptions } = {}) {
  const baseline = createSide('baseline', options.baseline);
  const candidate = createSide('candidate', options.candidate);
  return {
    baseline,
    candidate,
    input: { baseline: baseline.input, candidate: candidate.input },
  };
}

function replaceFirstProviderCapture(
  side: ReturnType<typeof createSide>,
  changes: Record<string, unknown>,
) {
  const phaseEvidence = side.input.bundle.phaseEvidence.map((phase: any, phaseIndex: number) => ({
    ...phase,
    providerCaptures: phase.providerCaptures.map((capture: any, captureIndex: number) => (
      phaseIndex === 0 && captureIndex === 0
        ? resign(capture, side.key, changes)
        : capture
    )),
  }));
  side.input.bundle = resign(side.input.bundle, side.key, { phaseEvidence });
}

function replaceFirstStoreSource(
  side: ReturnType<typeof createSide>,
  source: Record<string, unknown>,
) {
  const phaseEvidence = side.input.bundle.phaseEvidence.map((phase: any, phaseIndex: number) => {
    if (phaseIndex !== 0 || !phase.storeSnapshot) return phase;
    return {
      ...phase,
      storeSnapshot: resign(phase.storeSnapshot, side.key, { source }),
    };
  });
  side.input.bundle = resign(side.input.bundle, side.key, { phaseEvidence });
}

function createFormalNative(side: ReturnType<typeof createSide>, options: {
  executionStatus?: 'completed' | 'not_run';
  failedCheckId?: string;
  claimedPassed?: boolean;
} = {}) {
  const executionStatus = options.executionStatus || 'completed';
  let record = createSignedPortableFormalNativeEvidence({
    kind: PORTABLE_FORMAL_NATIVE_EVIDENCE_KIND,
    schemaVersion: 1,
    runId: `${side.manifest.runId}-formal-native`,
    buildIdentityDigest: side.buildIdentity.buildIdentityDigest,
    profileSha256: side.manifest.profileSha256,
    executionStatus,
    startedAt: executionStatus === 'completed' ? '2026-08-27T09:00:00.000Z' : undefined,
    completedAt: executionStatus === 'completed' ? '2026-08-27T09:05:00.000Z' : undefined,
    checks: executionStatus === 'completed'
      ? REQUIRED_FORMAL_NATIVE_CHECKS.map(id => ({
          id,
          status: id === options.failedCheckId ? 'failed' : 'passed',
          observed: id !== options.failedCheckId,
          evidenceSha256: digest(`native-${id}`),
        }))
      : [],
  }, side.key);
  if (options.claimedPassed !== undefined) {
    record = resign(record, side.key, { passed: options.claimedPassed });
  }
  return record;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('portable baseline/candidate evidence comparison', () => {
  it('passes portable behavior and candidate integrity but reports absent native evidence as not_run', () => {
    const pair = createPair();
    const result = comparePortableEvidencePairs(pair.input, {
      comparedAt: '2026-08-27T10:00:00.000Z',
    });

    expect(result.comparisonValid).toBe(true);
    expect(result.comparisonIssues).toEqual([]);
    expect(result.portableBehaviorPassed).toBe(true);
    expect(result.candidateInternalIntegrityPassed).toBe(true);
    expect(result.formalNativePassed).toBe('not_run');
    expect(result.releaseEligible).toBe(false);
    expect(result.releaseBlockers).toEqual(['formal_native_not_run']);
    expect(result.phaseComparisons[0]).toMatchObject({
      key: 'cleanup_offer_then_cleanup/cleanup',
      baselinePassed: true,
      candidatePassed: true,
      delta: 'unchanged_pass',
    });
  });

  it('becomes release eligible only with recomputed successful formal native checks', () => {
    const pair = createPair();
    pair.input.candidate.formalNativeEvidence = createFormalNative(pair.candidate, {
      claimedPassed: false,
    });
    const result = comparePortableEvidencePairs(pair.input);

    expect(result.formalNativePassed).toBe(true);
    expect(result.releaseEligible).toBe(true);
    expect(result.releaseBlockers).toEqual([]);
    expect(result.formalNative.checks.every((check: any) => check.passed)).toBe(true);
  });

  it('does not trust positive phase passed flags when the expected tool receipt is absent', () => {
    const pair = createPair({
      candidate: {
        mutateObservations: observations => {
          observations.receipts = { state: 'cleared', rowCount: 0, rows: [] };
        },
        phaseClaims: { passed: true, complete: true },
      },
    });
    const result = comparePortableEvidencePairs(pair.input);

    expect(result.comparisonValid).toBe(true);
    expect(result.phaseComparisons[0].candidate.behaviorIssues).toContain(
      'expected_tool_receipt_missing',
    );
    expect(result.portableBehaviorPassed).toBe(false);
    expect(result.candidateInternalIntegrityPassed).toBe(true);
  });

  it('does not trust negative complete/passed flags when exact signed phase evidence succeeds', () => {
    const pair = createPair({
      candidate: {
        phaseClaims: { complete: false, passed: false, internalIntegrityPassed: false },
        bundleClaims: { complete: false, passed: false },
      },
    });
    const result = comparePortableEvidencePairs(pair.input);

    expect(result.comparisonValid).toBe(true);
    expect(result.portableBehaviorPassed).toBe(true);
    expect(result.candidateInternalIntegrityPassed).toBe(true);
  });

  it('requires the exact phase nonce and one marker in the accepted user interaction', () => {
    const pair = createPair({
      candidate: {
        mutateObservations: observations => {
          observations.acceptedUserRow.phaseNonceSha256 = digest('wrong-phase-nonce');
        },
        phaseClaims: { passed: true },
      },
    });
    const result = comparePortableEvidencePairs(pair.input);

    expect(result.comparisonValid).toBe(true);
    expect(result.portableBehaviorPassed).toBe(false);
    expect(result.phaseComparisons[0].candidate.behaviorIssues).toContain(
      'accepted_user_row_marker_join_failed',
    );
  });

  it('rejects provider captures that do not attest one current-phase marker in the latest user message', () => {
    const staleUserPair = createPair();
    replaceFirstProviderCapture(staleUserPair.candidate, {
      latestUserMessageIndex: 1,
    });
    const staleUserResult = comparePortableEvidencePairs(staleUserPair.input);
    expect(staleUserResult.comparisonValid).toBe(false);
    expect(staleUserResult.phaseComparisons[0].candidate.evidenceIssues).toContain(
      'provider[0]:marker_cardinality_or_latest_user_invalid',
    );

    const crossBindingPair = createPair();
    replaceFirstProviderCapture(crossBindingPair.candidate, {
      markerCardinality: {
        portablePayload: 2,
        selectedPhasePayload: 1,
        latestUserMessage: 1,
      },
      observedPhaseBindingDigests: [
        crossBindingPair.candidate.phase.bindingDigest,
        digest('different-phase-binding'),
      ].sort(),
    });
    const crossBindingResult = comparePortableEvidencePairs(crossBindingPair.input);
    expect(crossBindingResult.comparisonValid).toBe(false);
    expect(crossBindingResult.phaseComparisons[0].candidate.evidenceIssues).toEqual(
      expect.arrayContaining([
        'provider[0]:marker_cardinality_or_latest_user_invalid',
        'provider[0]:phase_marker_binding_failed',
      ]),
    );
    expect(crossBindingResult.releaseEligible).toBe(false);
  });

  it('does not trust positive integrity flags when task references are internally unresolved', () => {
    const pair = createPair({
      candidate: {
        mutateObservations: observations => {
          observations.turn.rows[0].taskId = 'candidate-orphan-task';
          observations.task = { state: 'missing', rowCount: 0, rows: [] };
        },
        phaseClaims: { internalIntegrityPassed: true },
      },
    });
    pair.input.candidate.formalNativeEvidence = createFormalNative(pair.candidate);
    const result = comparePortableEvidencePairs(pair.input);

    expect(result.portableBehaviorPassed).toBe(true);
    expect(result.candidateInternalIntegrityPassed).toBe(false);
    expect(result.phaseComparisons[0].candidate.internalIssues).toContain(
      'turn_task_reference_unresolved',
    );
    expect(result.releaseEligible).toBe(false);
  });

  it('uses signed phase issues as evidence instead of trusting bundle complete/passed claims', () => {
    const pair = createPair({
      candidate: {
        phaseIssues: ['accepted_user_row_provider_witness_join_missing'],
        phaseClaims: { complete: true, passed: true },
      },
    });
    const result = comparePortableEvidencePairs(pair.input);

    expect(result.comparisonValid).toBe(false);
    expect(result.comparisonIssues).toContain('candidate_bundle_phase_evidence_invalid');
    expect(result.phaseComparisons[0].candidate.evidenceIssues).toContain(
      'phase_declared:accepted_user_row_provider_witness_join_missing',
    );
    expect(result.portableBehaviorPassed).toBe(false);
  });

  const parityCases: Array<[string, SideOptions, string]> = [
    ['profile', { manifest: { profileSha256: digest('other-profile') } }, 'profileSha256_parity_mismatch'],
    ['collector', { manifest: { collectorBundleSha256: digest('other-collector') } }, 'collectorBundleSha256_parity_mismatch'],
    ['fixture', { manifest: { fixturePlanSha256: digest('other-fixture') } }, 'fixturePlanSha256_parity_mismatch'],
    ['coverage', { expectedToolName: 'runtime_work_status' }, 'coverage_parity_mismatch'],
    ['timeout', {
      manifest: { timeoutPolicy: { ...TIMEOUT_POLICY, turnMs: TIMEOUT_POLICY.turnMs + 1 } },
    }, 'timeout_policy_parity_mismatch'],
    ['platform', {
      manifest: { platform: process.platform === 'win32' ? 'linux' : 'win32' },
    }, 'platform_parity_mismatch'],
    ['Node major', { manifest: { nodeMajor: NODE_MAJOR + 1 } }, 'nodeMajor_parity_mismatch'],
    ['model stub set', { model: 'portable-stub-v2' }, 'model_stub_set_parity_mismatch'],
  ];

  it.each(parityCases)('rejects %s parity mismatches', (_name, candidate, expectedIssue) => {
    const pair = createPair({ candidate });
    const result = comparePortableEvidencePairs(pair.input);

    expect(result.comparisonValid).toBe(false);
    expect(result.comparisonIssues).toContain(expectedIssue);
    expect(result.portableBehaviorPassed).toBe(false);
    expect(result.releaseEligible).toBe(false);
  });

  it('requires a clean baseline and distinct content identity while allowing shared revision or runtime', () => {
    const dirtyPair = createPair({ baseline: { build: { sourceDirty: true } } });
    const dirtyResult = comparePortableEvidencePairs(dirtyPair.input);
    expect(dirtyResult.comparisonIssues).toContain('clean_baseline_required');
    expect(dirtyResult.comparisonValid).toBe(false);

    const sameRevisionPair = createPair({
      candidate: {
        build: {
          revision: '1'.repeat(40),
        },
      },
    });
    expect(comparePortableEvidencePairs(sameRevisionPair.input).comparisonValid).toBe(true);

    const sharedRuntimePair = createPair({
      candidate: {
        build: { runtimeFingerprintSha256: digest('baseline-runtime') },
      },
    });
    expect(comparePortableEvidencePairs(sharedRuntimePair.input).comparisonValid).toBe(true);

    const sharedSourcePair = createPair({
      candidate: {
        build: { sourceFingerprintSha256: digest('baseline-source') },
      },
    });
    expect(comparePortableEvidencePairs(sharedSourcePair.input).comparisonValid).toBe(true);

    const sameContentPair = createPair({
      candidate: {
        build: {
          sourceFingerprintSha256: digest('baseline-source'),
          runtimeFingerprintSha256: digest('baseline-runtime'),
        },
      },
    });
    const sameContentResult = comparePortableEvidencePairs(sameContentPair.input);
    expect(sameContentResult.comparisonIssues).toContain('distinct_build_identities_required');
    expect(sameContentResult.comparisonValid).toBe(false);
  });

  it('accepts only exact 40- or 64-hex Git revisions', () => {
    for (const length of [41, 63]) {
      expect(() => createSignedPortableBuildIdentity({
        kind: PORTABLE_BUILD_IDENTITY_KIND,
        schemaVersion: 1,
        role: 'candidate',
        revision: 'a'.repeat(length),
        sourceDirty: false,
        sourceFingerprintSha256: digest(`source-${length}`),
        runtimeFingerprintSha256: digest(`runtime-${length}`),
        collectedAt: '2026-08-27T08:00:00.000Z',
      }, CANDIDATE_KEY)).toThrowError('portable_comparison_revision_invalid');
    }
    for (const length of [40, 64]) {
      expect(createSignedPortableBuildIdentity({
        kind: PORTABLE_BUILD_IDENTITY_KIND,
        schemaVersion: 1,
        role: 'candidate',
        revision: 'a'.repeat(length),
        sourceDirty: false,
        sourceFingerprintSha256: digest(`source-valid-${length}`),
        runtimeFingerprintSha256: digest(`runtime-valid-${length}`),
        collectedAt: '2026-08-27T08:00:00.000Z',
      }, CANDIDATE_KEY).revision).toHaveLength(length);
    }
  });

  it('keeps portable results separate while blocking release for a dirty candidate', () => {
    const pair = createPair({ candidate: { build: { sourceDirty: true } } });
    pair.input.candidate.formalNativeEvidence = createFormalNative(pair.candidate);
    const result = comparePortableEvidencePairs(pair.input);

    expect(result.comparisonValid).toBe(true);
    expect(result.portableBehaviorPassed).toBe(true);
    expect(result.candidateInternalIntegrityPassed).toBe(true);
    expect(result.formalNativePassed).toBe(true);
    expect(result.releaseEligible).toBe(false);
    expect(result.releaseBlockers).toContain('candidate_clean_build_required_for_release');
  });

  it('distinguishes explicit not_run, failed, and tampered formal native evidence', () => {
    const notRunPair = createPair();
    notRunPair.input.candidate.formalNativeEvidence = createFormalNative(notRunPair.candidate, {
      executionStatus: 'not_run',
      claimedPassed: true,
    });
    expect(comparePortableEvidencePairs(notRunPair.input).formalNativePassed).toBe('not_run');

    const failedPair = createPair();
    failedPair.input.candidate.formalNativeEvidence = createFormalNative(failedPair.candidate, {
      failedCheckId: REQUIRED_FORMAL_NATIVE_CHECKS[0],
      claimedPassed: true,
    });
    const failed = comparePortableEvidencePairs(failedPair.input);
    expect(failed.formalNativePassed).toBe(false);
    expect(failed.formalNative.issues).toContain('formal_native_required_check_failed');

    const tamperedPair = createPair();
    const signed = createFormalNative(tamperedPair.candidate);
    tamperedPair.input.candidate.formalNativeEvidence = {
      ...signed,
      profileSha256: digest('tampered-profile'),
    };
    const tampered = comparePortableEvidencePairs(tamperedPair.input);
    expect(tampered.formalNativePassed).toBe(false);
    expect(tampered.formalNative.issues).toContain('formal_native_attestation_invalid');
  });

  it('fails closed after tampering with a signed candidate bundle', () => {
    const pair = createPair();
    pair.input.candidate.bundle = { ...pair.input.candidate.bundle, passed: false };
    const result = comparePortableEvidencePairs(pair.input);

    expect(result.comparisonValid).toBe(false);
    expect(result.comparisonIssues).toContain('candidate_bundle_attestation_invalid');
    expect(result.portableBehaviorPassed).toBe(false);
  });

  it('binds both the bundle and passive store source to the manifest data root', () => {
    const bundlePair = createPair();
    bundlePair.candidate.input.bundle = resign(bundlePair.candidate.input.bundle, CANDIDATE_KEY, {
      dataRootIdentitySha256: digest('wrong-candidate-data-root'),
    });
    const bundleResult = comparePortableEvidencePairs(bundlePair.input);
    expect(bundleResult.comparisonValid).toBe(false);
    expect(bundleResult.comparisonIssues).toContain('candidate_bundle_manifest_binding_invalid');

    const storePair = createPair();
    replaceFirstStoreSource(storePair.candidate, {
      kind: 'portable-test-store',
      dataRootIdentitySha256: digest('wrong-store-data-root'),
    });
    const storeResult = comparePortableEvidencePairs(storePair.input);
    expect(storeResult.comparisonValid).toBe(false);
    expect(storeResult.phaseComparisons[0].candidate.evidenceIssues).toEqual(
      expect.arrayContaining([
        'store:store_data_root_identity_mismatch',
        'store_data_root_identity_mismatch',
      ]),
    );
    expect(storeResult.releaseEligible).toBe(false);
  });
});

describe('portable comparison CLI contract', () => {
  it('rejects latest/newest selectors', () => {
    expect(() => parsePortableEvidenceComparisonArgs(['--latest']))
      .toThrowError('portable_comparison_cli_flag_invalid');
    expect(() => parsePortableEvidenceComparisonArgs(['--newest']))
      .toThrowError('portable_comparison_cli_flag_invalid');
  });

  it('reads only explicit signed inputs and emits not_run without native evidence', async () => {
    const pair = createPair();
    const root = makeRoot();
    const paths = {
      baselineManifest: path.join(root, 'baseline-manifest.json'),
      baselineBundle: path.join(root, 'baseline-bundle.json'),
      baselineBuild: path.join(root, 'baseline-build.json'),
      baselineKey: path.join(root, 'baseline.key'),
      candidateManifest: path.join(root, 'candidate-manifest.json'),
      candidateBundle: path.join(root, 'candidate-bundle.json'),
      candidateBuild: path.join(root, 'candidate-build.json'),
      candidateKey: path.join(root, 'candidate.key'),
    };
    fs.writeFileSync(paths.baselineManifest, JSON.stringify(pair.input.baseline.manifest));
    fs.writeFileSync(paths.baselineBundle, JSON.stringify(pair.input.baseline.bundle));
    fs.writeFileSync(paths.baselineBuild, JSON.stringify(pair.input.baseline.buildIdentity));
    fs.writeFileSync(paths.baselineKey, BASELINE_KEY);
    fs.writeFileSync(paths.candidateManifest, JSON.stringify(pair.input.candidate.manifest));
    fs.writeFileSync(paths.candidateBundle, JSON.stringify(pair.input.candidate.bundle));
    fs.writeFileSync(paths.candidateBuild, JSON.stringify(pair.input.candidate.buildIdentity));
    fs.writeFileSync(paths.candidateKey, CANDIDATE_KEY);

    let output = '';
    const code = await runPortableEvidenceComparisonCli([
      '--baseline-manifest', paths.baselineManifest,
      '--baseline-bundle', paths.baselineBundle,
      '--baseline-build', paths.baselineBuild,
      '--baseline-key', paths.baselineKey,
      '--candidate-manifest', paths.candidateManifest,
      '--candidate-bundle', paths.candidateBundle,
      '--candidate-build', paths.candidateBuild,
      '--candidate-key', paths.candidateKey,
      '--compared-at', '2026-08-27T10:00:00.000Z',
    ], { write: (value: string) => { output += value; } });
    const result = JSON.parse(output);

    expect(code).toBe(2);
    expect(result.comparisonValid).toBe(true);
    expect(result.portableBehaviorPassed).toBe(true);
    expect(result.candidateInternalIntegrityPassed).toBe(true);
    expect(result.formalNativePassed).toBe('not_run');
    expect(result.releaseEligible).toBe(false);
  });
});
