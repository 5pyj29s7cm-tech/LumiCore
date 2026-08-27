import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  portableEvidenceSha256,
  verifyPortableEvidenceRecord,
} from '../scripts/lib/portable-external-evidence.mjs';
import {
  PORTABLE_PAIRED_RUNNER_HOOK_CONTRACT,
  appendPortablePhaseMarkerToUserText,
  createPortablePairedManifestCores,
  createPortablePairedRunnerHooks,
  matchPortableProviderPayloadPhase,
  portablePairedHmacKeyId,
  projectSignedPortableTaskRegressionBuildIdentity,
} from '../scripts/lib/portable-paired-runner.mjs';
import {
  TASK_REGRESSION_BUILD_IDENTITY_KIND,
  taskRegressionBuildIdentityDigest,
} from '../scripts/lib/task-regression-matrix.mjs';

const BASELINE_KEY = Buffer.alloc(32, 0x61);
const CANDIDATE_KEY = Buffer.alloc(32, 0x62);
const NODE_MAJOR = Number.parseInt(process.versions.node.split('.')[0], 10);
const CLEANUP_USER_TEXT = '清理一下';
const DISPLAY_USER_TEXT = '读取隔离文件并显示结果';

function digest(value: unknown) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function regressionBuildIdentity(role: 'baseline' | 'candidate', sourceDirty = false) {
  return {
    kind: TASK_REGRESSION_BUILD_IDENTITY_KIND,
    revision: (role === 'baseline' ? '1' : '2').repeat(40),
    sourceFingerprintSha256: digest(`${role}-task-regression-source`),
    sourceDirty,
    runtimeFingerprintSha256: digest(`${role}-task-regression-runtime`),
    collectedAt: role === 'baseline'
      ? '2026-08-27T11:00:00.000Z'
      : '2026-08-27T11:01:00.000Z',
  };
}

function buildProjections() {
  const baselineSource = regressionBuildIdentity('baseline');
  const candidateSource = regressionBuildIdentity('candidate');
  return {
    baseline: projectSignedPortableTaskRegressionBuildIdentity(baselineSource, {
      role: 'baseline',
      hmacKey: BASELINE_KEY,
      expectedTaskRegressionBuildIdentityDigest: taskRegressionBuildIdentityDigest(baselineSource),
    }),
    candidate: projectSignedPortableTaskRegressionBuildIdentity(candidateSource, {
      role: 'candidate',
      hmacKey: CANDIDATE_KEY,
      expectedTaskRegressionBuildIdentityDigest: taskRegressionBuildIdentityDigest(candidateSource),
    }),
  };
}

function pairedPlanInput() {
  const projections = buildProjections();
  return {
    parity: {
      profileSha256: digest('portable-paired-profile-v1'),
      collectorBundleSha256: digest('portable-paired-collector-v1'),
      fixturePlanSha256: digest('portable-paired-fixture-v1'),
      timeoutPolicy: {
        turnMs: 30_000,
        providerMs: 20_000,
        passiveStoreMs: 10_000,
        settleMs: 100,
      },
      platform: process.platform,
      nodeMajor: NODE_MAJOR,
    },
    baseline: {
      runId: 'portable-paired-baseline-run',
      buildIdentityDigest: projections.baseline.portableBuildIdentity.buildIdentityDigest,
      dataRootIdentitySha256: digest('portable-paired-baseline-root'),
      hmacKeyId: portablePairedHmacKeyId(BASELINE_KEY),
    },
    candidate: {
      runId: 'portable-paired-candidate-run',
      buildIdentityDigest: projections.candidate.portableBuildIdentity.buildIdentityDigest,
      dataRootIdentitySha256: digest('portable-paired-candidate-root'),
      hmacKeyId: portablePairedHmacKeyId(CANDIDATE_KEY),
    },
    phases: [
      {
        scenarioId: 'cleanup_offer_then_cleanup',
        phaseId: 'cleanup',
        turnOrdinal: 2,
        unmarkedUserTextSha256: digest(CLEANUP_USER_TEXT),
        expectedToolName: 'runtime_work_cancel',
        requirements: { passiveStore: true, providerWitness: true },
        baseline: {
          requestId: 'baseline-cleanup-request',
          phaseNonce: 'baseline-cleanup-phase-nonce-0001',
          conversationId: 'baseline-cleanup-conversation',
          userId: 'baseline-user',
        },
        candidate: {
          requestId: 'candidate-cleanup-request',
          phaseNonce: 'candidate-cleanup-phase-nonce-0001',
          conversationId: 'candidate-cleanup-conversation',
          userId: 'candidate-user',
        },
      },
      {
        scenarioId: 'displayed_result_stale_receipt',
        phaseId: 'display',
        turnOrdinal: 1,
        unmarkedUserTextSha256: digest(DISPLAY_USER_TEXT),
        expectedToolName: 'read_file',
        requirements: { passiveStore: true, providerWitness: true },
        baseline: {
          requestId: 'baseline-display-request',
          phaseNonce: 'baseline-display-phase-nonce-0001',
          conversationId: 'baseline-display-conversation',
          userId: 'baseline-user',
          channelId: 'baseline-display-channel',
        },
        candidate: {
          requestId: 'candidate-display-request',
          phaseNonce: 'candidate-display-phase-nonce-0001',
          conversationId: 'candidate-display-conversation',
          userId: 'candidate-user',
          channelId: 'candidate-display-channel',
        },
      },
    ],
  };
}

function createPlan() {
  return createPortablePairedManifestCores(pairedPlanInput());
}

function fixtureBinding(pair: any) {
  return {
    turnOrdinal: pair.turnOrdinal,
    unmarkedUserTextSha256: pair.unmarkedUserTextSha256,
  };
}

describe('portable paired manifest planning', () => {
  it('creates deterministic parity manifests with role-specific exact selectors and markers', () => {
    const first = createPlan();
    const second = createPlan();

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.baselineManifest.role).toBe('baseline');
    expect(first.candidateManifest.role).toBe('candidate');
    for (const field of [
      'profileSha256', 'collectorBundleSha256', 'fixturePlanSha256',
      'timeoutPolicy', 'platform', 'nodeMajor',
    ]) {
      expect(first.baselineManifest[field]).toEqual(first.candidateManifest[field]);
    }
    expect(first.phasePairs).toHaveLength(2);
    expect(first.phasePairs[0].baseline.selector).toEqual({
      scenarioId: 'cleanup_offer_then_cleanup',
      phaseId: 'cleanup',
      requestId: 'baseline-cleanup-request',
      phaseNonce: 'baseline-cleanup-phase-nonce-0001',
    });
    expect(first.phasePairs[0].candidate.selector.requestId).toBe('candidate-cleanup-request');
    expect(first.phasePairs[0]).toMatchObject({
      turnOrdinal: 2,
      unmarkedUserTextSha256: digest(CLEANUP_USER_TEXT),
    });
    expect(first.phasePairs[0].baseline.providerMarker).not.toBe(
      first.phasePairs[0].candidate.providerMarker,
    );
    expect(first.phasePairs[0].baseline.providerMarker).toContain(
      first.phasePairs[0].baseline.bindingDigest,
    );
    expect(first.coverageSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.paritySha256).toMatch(/^[a-f0-9]{64}$/u);

    const changedOrdinalInput = pairedPlanInput() as any;
    changedOrdinalInput.phases[0].turnOrdinal = 3;
    const changedOrdinal = createPortablePairedManifestCores(changedOrdinalInput);
    expect(changedOrdinal.coverageSha256).not.toBe(first.coverageSha256);
    expect(changedOrdinal.paritySha256).not.toBe(first.paritySha256);

    const changedTextInput = pairedPlanInput() as any;
    changedTextInput.phases[0].unmarkedUserTextSha256 = digest('清理全部后台任务');
    const changedText = createPortablePairedManifestCores(changedTextInput);
    expect(changedText.coverageSha256).not.toBe(first.coverageSha256);
    expect(changedText.paritySha256).not.toBe(first.paritySha256);
  });

  it('rejects implicit fields and cross-role request/nonce reuse', () => {
    const unexpected = pairedPlanInput() as any;
    unexpected.phases[0].baseline.providerMarker = 'caller-supplied-marker';
    expect(() => createPortablePairedManifestCores(unexpected))
      .toThrowError('portable_paired_baseline_phase_binding_invalid');

    const duplicateRequest = pairedPlanInput() as any;
    duplicateRequest.phases[0].candidate.requestId = duplicateRequest.phases[0].baseline.requestId;
    expect(() => createPortablePairedManifestCores(duplicateRequest))
      .toThrowError('portable_paired_cross_role_request_id_reuse');

    const duplicateNonce = pairedPlanInput() as any;
    duplicateNonce.phases[0].candidate.phaseNonce = duplicateNonce.phases[0].baseline.phaseNonce;
    expect(() => createPortablePairedManifestCores(duplicateNonce))
      .toThrowError('portable_paired_cross_role_phase_nonce_reuse');

    const duplicateBuild = pairedPlanInput() as any;
    duplicateBuild.candidate.buildIdentityDigest = duplicateBuild.baseline.buildIdentityDigest;
    expect(() => createPortablePairedManifestCores(duplicateBuild))
      .toThrowError('portable_paired_distinct_build_identities_required');

    const duplicateRoot = pairedPlanInput() as any;
    duplicateRoot.candidate.dataRootIdentitySha256 = duplicateRoot.baseline.dataRootIdentitySha256;
    expect(() => createPortablePairedManifestCores(duplicateRoot))
      .toThrowError('portable_paired_distinct_data_roots_required');

    const missingTurnOrdinal = pairedPlanInput() as any;
    delete missingTurnOrdinal.phases[0].turnOrdinal;
    expect(() => createPortablePairedManifestCores(missingTurnOrdinal))
      .toThrowError('portable_paired_phase_plan_invalid');

    const invalidTextDigest = pairedPlanInput() as any;
    invalidTextDigest.phases[0].unmarkedUserTextSha256 = 'not-a-digest';
    expect(() => createPortablePairedManifestCores(invalidTextDigest))
      .toThrowError('portable_paired_phase_user_text_digest_invalid');

    const duplicateScenarioTurn = pairedPlanInput() as any;
    duplicateScenarioTurn.phases[1].scenarioId = duplicateScenarioTurn.phases[0].scenarioId;
    duplicateScenarioTurn.phases[1].turnOrdinal = duplicateScenarioTurn.phases[0].turnOrdinal;
    expect(() => createPortablePairedManifestCores(duplicateScenarioTurn))
      .toThrowError('portable_paired_duplicate_scenario_turn_ordinal');
  });
});

describe('portable user turn marker binding', () => {
  it('appends exactly one marker for an exact selector without changing the original text', () => {
    const plan = createPlan();
    const phase = plan.phasePairs[0];
    const pair = phase.baseline;
    const original = CLEANUP_USER_TEXT;
    const prepared = appendPortablePhaseMarkerToUserText(
      plan.baselineManifest,
      pair.selector,
      original,
      fixtureBinding(phase),
    );

    expect(original).toBe(CLEANUP_USER_TEXT);
    expect(prepared.text.startsWith(original)).toBe(true);
    expect(prepared.text.split(pair.providerMarker)).toHaveLength(2);
    expect(prepared.bindingDigest).toBe(pair.bindingDigest);
    expect(prepared.turnOrdinal).toBe(2);
    expect(prepared.unmarkedUserTextSha256).toBe(digest(CLEANUP_USER_TEXT));
    expect(prepared.providerMarkerSha256).toBe(portableEvidenceSha256(pair.providerMarker));
  });

  it('rejects repeated, cross-phase, injected, empty, and unknown-selector text', () => {
    const plan = createPlan();
    const phase = plan.phasePairs[0];
    const pair = phase.baseline;
    const prepared = appendPortablePhaseMarkerToUserText(
      plan.baselineManifest,
      pair.selector,
      CLEANUP_USER_TEXT,
      fixtureBinding(phase),
    );
    expect(() => appendPortablePhaseMarkerToUserText(
      plan.baselineManifest,
      pair.selector,
      prepared.text,
      fixtureBinding(phase),
    )).toThrowError('portable_paired_user_text_already_marked');
    expect(() => appendPortablePhaseMarkerToUserText(
      plan.baselineManifest,
      pair.selector,
      `错误串入另一阶段 ${plan.phasePairs[1].baseline.providerMarker}`,
      fixtureBinding(phase),
    )).toThrowError('portable_paired_user_text_already_marked');
    expect(() => appendPortablePhaseMarkerToUserText(
      plan.baselineManifest,
      pair.selector,
      '注入 [[LUMI_PORTABLE_EVIDENCE_V1:unknown:phase]]',
      fixtureBinding(phase),
    )).toThrowError('portable_paired_user_text_already_marked');
    expect(() => appendPortablePhaseMarkerToUserText(
      plan.baselineManifest,
      pair.selector,
      '   ',
      fixtureBinding(phase),
    )).toThrowError('portable_paired_user_text_required');
    expect(() => appendPortablePhaseMarkerToUserText(
      plan.baselineManifest,
      { ...pair.selector, requestId: 'unknown-request' },
      CLEANUP_USER_TEXT,
      fixtureBinding(phase),
    )).toThrowError('portable_paired_phase_selector_unknown');
    expect(() => appendPortablePhaseMarkerToUserText(
      plan.baselineManifest,
      pair.selector,
      '清理其他任务',
      fixtureBinding(phase),
    )).toThrowError('portable_paired_user_turn_text_digest_mismatch');
    expect(() => appendPortablePhaseMarkerToUserText(
      plan.baselineManifest,
      pair.selector,
      CLEANUP_USER_TEXT,
      undefined,
    )).toThrowError('portable_paired_user_turn_fixture_required');
  });
});

describe('portable raw provider payload matching', () => {
  it('maps a raw payload to one exact phase selector and retains model/tool identifiers', () => {
    const plan = createPlan();
    const phase = plan.phasePairs[0];
    const pair = phase.candidate;
    const prepared = appendPortablePhaseMarkerToUserText(
      plan.candidateManifest,
      pair.selector,
      CLEANUP_USER_TEXT,
      fixtureBinding(phase),
    );
    const payload = {
      model: 'portable-stub-v1',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: '先提出清理建议' },
        { role: 'user', content: [{ type: 'text', text: prepared.text }] },
      ],
      tools: [
        { type: 'function', function: { name: 'runtime_work_cancel' } },
      ],
    };
    const fromObject = matchPortableProviderPayloadPhase(plan.candidateManifest, payload);
    const fromBuffer = matchPortableProviderPayloadPhase(
      plan.candidateManifest,
      Buffer.from(JSON.stringify(payload), 'utf8'),
    );

    expect(fromObject.selector).toEqual(pair.selector);
    expect(fromObject.bindingDigest).toBe(pair.bindingDigest);
    expect(fromObject.matchedUserMessageIndex).toBe(2);
    expect(fromObject.latestUserMessageIndex).toBe(2);
    expect(fromObject.model).toBe('portable-stub-v1');
    expect(fromObject.declaredTools).toEqual(['runtime_work_cancel']);
    expect(fromBuffer.selector).toEqual(pair.selector);
    expect(fromBuffer.rawPayloadSha256).toBe(
      portableEvidenceSha256(Buffer.from(JSON.stringify(payload), 'utf8')),
    );
  });

  it('fails closed for zero, multiple, repeated, unknown-extra, or non-user markers', () => {
    const plan = createPlan();
    const first = plan.phasePairs[0].baseline.providerMarker;
    const second = plan.phasePairs[1].baseline.providerMarker;
    const payload = (role: string, content: string) => ({
      model: 'portable-stub-v1',
      messages: [{ role, content }],
    });

    expect(() => matchPortableProviderPayloadPhase(
      plan.baselineManifest,
      payload('user', 'no marker'),
    )).toThrowError('portable_paired_provider_phase_marker_missing');
    expect(() => matchPortableProviderPayloadPhase(
      plan.baselineManifest,
      payload('user', `${first}\n${second}`),
    )).toThrowError('portable_paired_provider_phase_marker_ambiguous');
    expect(() => matchPortableProviderPayloadPhase(
      plan.baselineManifest,
      payload('user', `${first}\n${first}`),
    )).toThrowError('portable_paired_provider_phase_marker_repeated');
    expect(() => matchPortableProviderPayloadPhase(
      plan.baselineManifest,
      payload('user', `${first}\n[[LUMI_PORTABLE_EVIDENCE_V1:unknown:phase]]`),
    )).toThrowError('portable_paired_provider_unknown_or_extra_marker');
    expect(() => matchPortableProviderPayloadPhase(
      plan.baselineManifest,
      payload('assistant', first),
    )).toThrowError('portable_paired_provider_marker_not_exact_user_interaction');
    expect(() => matchPortableProviderPayloadPhase(
      plan.baselineManifest,
      {
        model: 'portable-stub-v1',
        messages: [
          { role: 'user', content: first },
          { role: 'assistant', content: 'intermediate response' },
          { role: 'user', content: 'later unmarked user interaction' },
        ],
      },
    )).toThrowError('portable_paired_provider_marker_not_latest_user_message');
  });

  it('rejects malformed provider payloads instead of guessing', () => {
    const plan = createPlan();
    let malformed: any;
    try {
      matchPortableProviderPayloadPhase(
        plan.baselineManifest,
        '{bad-json SECRET_PROVIDER_BODY_SENTINEL',
      );
    } catch (error) {
      malformed = error;
    }
    expect(malformed?.code).toBe('portable_paired_provider_payload_invalid');
    expect(malformed?.cause).toBeUndefined();
    expect(JSON.stringify(malformed)).not.toContain('SECRET_PROVIDER_BODY_SENTINEL');
    expect(() => matchPortableProviderPayloadPhase(plan.baselineManifest, { messages: [] }))
      .toThrowError('portable_paired_provider_messages_required');
  });
});

describe('task-regression build identity projection', () => {
  it('projects and signs a clean baseline identity without reading a worktree', () => {
    const source = regressionBuildIdentity('baseline');
    const projection = projectSignedPortableTaskRegressionBuildIdentity(source, {
      role: 'baseline',
      hmacKey: BASELINE_KEY,
      expectedTaskRegressionBuildIdentityDigest: taskRegressionBuildIdentityDigest(source),
    });

    expect(projection.sourceBuildIdentityDigest).toBe(taskRegressionBuildIdentityDigest(source));
    expect(projection.portableBuildIdentity).toMatchObject({
      role: 'baseline',
      revision: source.revision,
      sourceDirty: false,
      sourceFingerprintSha256: source.sourceFingerprintSha256,
      runtimeFingerprintSha256: source.runtimeFingerprintSha256,
    });
    expect(verifyPortableEvidenceRecord(projection.portableBuildIdentity, BASELINE_KEY)).toBe(true);
  });

  it('rejects a dirty baseline but allows a signed dirty candidate projection', () => {
    const dirtyBaseline = regressionBuildIdentity('baseline', true);
    expect(() => projectSignedPortableTaskRegressionBuildIdentity(dirtyBaseline, {
      role: 'baseline', hmacKey: BASELINE_KEY,
    })).toThrowError('portable_paired_clean_baseline_required');

    const dirtyCandidate = regressionBuildIdentity('candidate', true);
    const candidate = projectSignedPortableTaskRegressionBuildIdentity(dirtyCandidate, {
      role: 'candidate', hmacKey: CANDIDATE_KEY,
    });
    expect(candidate.portableBuildIdentity.sourceDirty).toBe(true);
    expect(verifyPortableEvidenceRecord(candidate.portableBuildIdentity, CANDIDATE_KEY)).toBe(true);
  });

  it('rejects invalid source identities and mismatched expected source digests', () => {
    const source = regressionBuildIdentity('baseline') as any;
    expect(() => projectSignedPortableTaskRegressionBuildIdentity(
      { ...source, unexpected: true },
      { role: 'baseline', hmacKey: BASELINE_KEY },
    )).toThrowError('portable_paired_task_regression_build_identity_invalid');
    expect(() => projectSignedPortableTaskRegressionBuildIdentity(source, {
      role: 'baseline',
      hmacKey: BASELINE_KEY,
      expectedTaskRegressionBuildIdentityDigest: digest('wrong-source-digest'),
    })).toThrowError('portable_paired_task_regression_build_digest_mismatch');
  });
});

describe('future runner hook surface', () => {
  it('exposes only the pure per-turn hooks and documents the two lifecycle handoff points', () => {
    const plan = createPlan();
    const hooks = createPortablePairedRunnerHooks(plan);
    const pair = plan.phasePairs[0].candidate;
    const prepared = hooks.prepareUserTurn({
      role: 'candidate', selector: pair.selector, turnOrdinal: 2, text: CLEANUP_USER_TEXT,
    });
    const matched = hooks.observeProviderPayload({
      role: 'candidate',
      payload: {
        model: 'portable-stub-v1',
        messages: [{ role: 'user', content: prepared.text }],
      },
    });

    expect(hooks.manifestFor('candidate').manifestDigest).toBe(
      plan.candidateManifest.manifestDigest,
    );
    expect(matched.selector).toEqual(pair.selector);
    expect(PORTABLE_PAIRED_RUNNER_HOOK_CONTRACT.integrationPoints.map((item: any) => item.id))
      .toEqual([
        'after_exact_bindings_before_first_user_turn',
        'before_user_turn_emit',
        'at_raw_provider_dispatch_boundary',
        'after_scenarios_before_sandbox_cleanup',
      ]);
    expect(Object.isFrozen(PORTABLE_PAIRED_RUNNER_HOOK_CONTRACT)).toBe(true);
    expect(() => hooks.manifestFor('unknown')).toThrowError('portable_paired_role_invalid');
    expect(() => hooks.prepareUserTurn({
      role: 'candidate', selector: pair.selector, turnOrdinal: 1, text: CLEANUP_USER_TEXT,
    })).toThrowError('portable_paired_user_turn_ordinal_mismatch');
    expect(() => hooks.prepareUserTurn({
      role: 'candidate', selector: pair.selector, turnOrdinal: 2, text: '清理其他任务',
    })).toThrowError('portable_paired_user_turn_text_digest_mismatch');
  });

  it('recomputes and rejects tampered parity, coverage, phase pairs, or hand-built plans', () => {
    const plan = createPlan();

    const parityTampered = JSON.parse(JSON.stringify(plan));
    parityTampered.paritySha256 = digest('tampered-parity');
    expect(() => createPortablePairedRunnerHooks(parityTampered))
      .toThrowError('portable_paired_run_plan_integrity_invalid');

    const coverageTampered = JSON.parse(JSON.stringify(plan));
    coverageTampered.coverageSha256 = digest('tampered-coverage');
    expect(() => createPortablePairedRunnerHooks(coverageTampered))
      .toThrowError('portable_paired_run_plan_integrity_invalid');

    const pairTampered = JSON.parse(JSON.stringify(plan));
    pairTampered.phasePairs[0].baseline.selector.requestId = 'manually-spliced-request';
    expect(() => createPortablePairedRunnerHooks(pairTampered))
      .toThrowError('portable_paired_run_plan_integrity_invalid');

    const fixtureTampered = JSON.parse(JSON.stringify(plan));
    fixtureTampered.phasePairs[0].unmarkedUserTextSha256 = digest('different-fixture');
    expect(() => createPortablePairedRunnerHooks(fixtureTampered))
      .toThrowError('portable_paired_run_plan_integrity_invalid');

    expect(() => createPortablePairedRunnerHooks({
      kind: plan.kind,
      schemaVersion: plan.schemaVersion,
      paritySha256: plan.paritySha256,
      coverageSha256: plan.coverageSha256,
      baselineManifest: plan.baselineManifest,
      candidateManifest: plan.candidateManifest,
      phasePairs: [],
    })).toThrowError('portable_paired_run_plan_integrity_invalid');
  });
});
