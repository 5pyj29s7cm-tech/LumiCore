import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  verifyPortableEvidenceRecord,
} from '../scripts/lib/portable-external-evidence.mjs';
import {
  createPortablePairedPreparedBarrier,
  portablePairedFixturePlanSha256,
} from '../scripts/lib/portable-paired-barrier.mjs';
import {
  TASK_REGRESSION_BUILD_IDENTITY_KIND,
} from '../scripts/lib/task-regression-matrix.mjs';

const BASELINE_KEY = Buffer.alloc(32, 0x71);
const CANDIDATE_KEY = Buffer.alloc(32, 0x72);
const NODE_MAJOR = Number.parseInt(process.versions.node.split('.')[0], 10);

function digest(value: unknown) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function fixture() {
  return {
    phases: [
      {
        scenarioId: 'cleanup_offer_then_cleanup',
        phaseId: 'cleanup',
        turnOrdinal: 2,
        unmarkedUserTextSha256: digest('清理一下'),
        expectedToolName: 'runtime_work_cancel',
        requirements: { passiveStore: true, providerWitness: true },
      },
      {
        scenarioId: 'displayed_result_stale_receipt',
        phaseId: 'display',
        turnOrdinal: 1,
        unmarkedUserTextSha256: digest('读取隔离文件并显示结果'),
        expectedToolName: 'read_file',
        requirements: { passiveStore: true, providerWitness: true },
      },
    ],
  };
}

function config(timeoutMs = 1_000) {
  return {
    parity: {
      profileSha256: digest('paired-barrier-profile-v1'),
      collectorBundleSha256: digest('paired-barrier-collector-v1'),
      timeoutPolicy: {
        turnMs: 30_000,
        providerMs: 20_000,
        passiveStoreMs: 10_000,
        settleMs: 100,
      },
      platform: process.platform,
      nodeMajor: NODE_MAJOR,
    },
    fixture: fixture(),
    hmacKeys: {
      baseline: Buffer.from(BASELINE_KEY),
      candidate: Buffer.from(CANDIDATE_KEY),
    },
    timeoutMs,
  };
}

function buildIdentity(role: 'baseline' | 'candidate', sourceDirty = false) {
  return {
    kind: TASK_REGRESSION_BUILD_IDENTITY_KIND,
    revision: (role === 'baseline' ? '1' : '2').repeat(40),
    sourceFingerprintSha256: digest(`${role}-source-fingerprint`),
    sourceDirty,
    runtimeFingerprintSha256: digest(`${role}-runtime-fingerprint`),
    collectedAt: role === 'baseline'
      ? '2026-08-27T12:00:00.000Z'
      : '2026-08-27T12:01:00.000Z',
  };
}

function prepared(role: 'baseline' | 'candidate') {
  const side = role === 'baseline' ? 'base' : 'cand';
  return {
    role,
    runId: `${side}-run-20260827`,
    taskRegressionBuildIdentity: buildIdentity(role),
    dataRootIdentitySha256: digest(`${side}-isolated-data-root`),
    userId: `${side}-user-secret-value`,
    conversationId: `${side}-conversation-secret-value`,
    phases: fixture().phases.map((phase, index) => ({
      scenarioId: phase.scenarioId,
      phaseId: phase.phaseId,
      requestId: `${side}-request-${index + 1}`,
      phaseNonce: `${side}-phase-nonce-${index + 1}-20260827`,
      turnOrdinal: phase.turnOrdinal,
      unmarkedUserTextSha256: phase.unmarkedUserTextSha256,
    })),
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('portable paired prepared barrier release', () => {
  it('waits for both roles, then returns signed in-memory role kits', async () => {
    const barrier = createPortablePairedPreparedBarrier(config());
    const baselinePromise = barrier.prepare(prepared('baseline'));

    expect(barrier.state).toBe('waiting');
    expect(barrier.summary().roles).toMatchObject({
      baseline: { prepared: true },
      candidate: { prepared: false },
    });

    const candidatePromise = barrier.prepare(prepared('candidate'));
    const [baseline, candidate] = await Promise.all([baselinePromise, candidatePromise]);

    expect(barrier.state).toBe('released');
    expect(barrier.summary().paritySha256).toBe(baseline.summary.paritySha256);
    expect(barrier.summary().coverageSha256).toBe(baseline.summary.coverageSha256);
    expect(barrier.kitFor('baseline')).toBe(baseline);
    expect(barrier.kitFor('candidate')).toBe(candidate);
    expect(baseline.role).toBe('baseline');
    expect(candidate.role).toBe('candidate');
    expect(baseline.pairedPlan).toBe(candidate.pairedPlan);
    expect(baseline.hooks).toBe(candidate.hooks);
    expect(baseline.manifest.role).toBe('baseline');
    expect(candidate.manifest.role).toBe('candidate');
    expect(baseline.collector.manifest.manifestDigest).toBe(baseline.manifest.manifestDigest);
    expect(candidate.collector.manifest.manifestDigest).toBe(candidate.manifest.manifestDigest);
    expect(verifyPortableEvidenceRecord(baseline.portableBuildIdentity, BASELINE_KEY)).toBe(true);
    expect(verifyPortableEvidenceRecord(candidate.portableBuildIdentity, CANDIDATE_KEY)).toBe(true);
    expect(verifyPortableEvidenceRecord(baseline.signedManifest, BASELINE_KEY)).toBe(true);
    expect(verifyPortableEvidenceRecord(candidate.signedManifest, CANDIDATE_KEY)).toBe(true);
    expect(baseline.manifest.fixturePlanSha256).toBe(
      portablePairedFixturePlanSha256(fixture()),
    );
    expect(baseline.manifest.fixturePlanSha256).toBe(candidate.manifest.fixturePlanSha256);
    expect(baseline.manifest.profileSha256).toBe(candidate.manifest.profileSha256);
    expect(baseline.manifest.collectorBundleSha256).toBe(
      candidate.manifest.collectorBundleSha256,
    );

    const serialized = JSON.stringify({ barrier, baseline, candidate });
    expect(serialized).not.toContain('base-user-secret-value');
    expect(serialized).not.toContain('cand-user-secret-value');
    expect(serialized).not.toContain('base-conversation-secret-value');
    expect(serialized).not.toContain('cand-conversation-secret-value');
    expect(serialized).not.toContain('base-phase-nonce');
    expect(serialized).not.toContain('cand-phase-nonce');
    expect(serialized).not.toContain('"data":[113,113,113');
    expect(serialized).not.toContain('"data":[114,114,114');
    expect(serialized).not.toContain('sourceFingerprintSha256');
    expect(serialized).not.toContain('runtimeFingerprintSha256');
    expect(serialized).not.toContain('"revision"');
    expect(Object.keys(baseline)).toEqual(['kind', 'schemaVersion', 'role', 'summary']);

    await expectCode(
      barrier.prepare(prepared('baseline')),
      'portable_paired_barrier_late_arrival',
    );
  });

  it('copies configuration and prepared identities before release', async () => {
    const inputConfig = config();
    const baselineInput = prepared('baseline');
    const barrier = createPortablePairedPreparedBarrier(inputConfig);
    const baselinePromise = barrier.prepare(baselineInput);

    inputConfig.hmacKeys.baseline.fill(0x00);
    inputConfig.fixture.phases[0].scenarioId = 'mutated-fixture';
    baselineInput.userId = 'mutated-user';
    baselineInput.phases[0].requestId = 'mutated-request';
    baselineInput.taskRegressionBuildIdentity.revision = 'f'.repeat(40);

    const candidatePromise = barrier.prepare(prepared('candidate'));
    const [baseline] = await Promise.all([baselinePromise, candidatePromise]);
    expect(baseline.manifest.phases[0].scenarioId).toBe('cleanup_offer_then_cleanup');
    expect(baseline.manifest.phases[0].requestId).toBe('base-request-1');
    expect(baseline.manifest.phases[0].userId).toBe('base-user-secret-value');
    expect(verifyPortableEvidenceRecord(baseline.portableBuildIdentity, BASELINE_KEY)).toBe(true);
  });
});

describe('portable paired prepared barrier fail-closed lifecycle', () => {
  it('fails both arrivals on a duplicate role and rejects all later arrivals', async () => {
    const barrier = createPortablePairedPreparedBarrier(config());
    const first = barrier.prepare(prepared('baseline'));
    const firstRejected = expectCode(first, 'portable_paired_barrier_duplicate_role');
    const duplicate = barrier.prepare(prepared('baseline'));

    await Promise.all([
      firstRejected,
      expectCode(duplicate, 'portable_paired_barrier_duplicate_role'),
    ]);
    expect(barrier.state).toBe('failed');
    await expectCode(
      barrier.prepare(prepared('candidate')),
      'portable_paired_barrier_late_arrival',
    );
  });

  it('has a bounded timeout and permanently rejects a late counterpart', async () => {
    vi.useFakeTimers();
    try {
      const barrier = createPortablePairedPreparedBarrier(config(25));
      const first = barrier.prepare(prepared('baseline'));
      const firstRejected = expectCode(first, 'portable_paired_barrier_timeout');

      await vi.advanceTimersByTimeAsync(25);
      await firstRejected;
      expect(barrier.state).toBe('timed_out');
      expect(barrier.summary().terminalCode).toBe('portable_paired_barrier_timeout');
      await expectCode(
        barrier.prepare(prepared('candidate')),
        'portable_paired_barrier_late_arrival',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels outstanding waiters once and rejects both roles afterwards', async () => {
    const barrier = createPortablePairedPreparedBarrier(config());
    const first = barrier.prepare(prepared('candidate'));
    const firstRejected = expectCode(first, 'portable_paired_barrier_cancelled');

    expect(barrier.cancel()).toBe(true);
    await firstRejected;
    expect(barrier.cancel()).toBe(false);
    expect(barrier.state).toBe('cancelled');
    await expectCode(
      barrier.prepare(prepared('baseline')),
      'portable_paired_barrier_late_arrival',
    );
  });

  it('fails both waiters when cross-role identities are reused', async () => {
    const barrier = createPortablePairedPreparedBarrier(config());
    const baselineInput = prepared('baseline');
    const candidateInput = prepared('candidate');
    candidateInput.dataRootIdentitySha256 = baselineInput.dataRootIdentitySha256;
    const first = barrier.prepare(baselineInput);
    const firstRejected = expectCode(first, 'portable_paired_barrier_identity_mismatch');
    const second = barrier.prepare(candidateInput);

    await Promise.all([
      firstRejected,
      expectCode(second, 'portable_paired_barrier_identity_mismatch'),
    ]);
    expect(barrier.state).toBe('failed');
    expect(() => barrier.kitFor('baseline'))
      .toThrowError('portable_paired_barrier_kit_not_ready');
  });

  it('rejects fixture drift and fails an already waiting counterpart', async () => {
    const barrier = createPortablePairedPreparedBarrier(config());
    const first = barrier.prepare(prepared('baseline'));
    const firstRejected = expectCode(first, 'portable_paired_barrier_identity_mismatch');
    const drifted = prepared('candidate');
    drifted.phases[0].unmarkedUserTextSha256 = digest('different fixture text');
    const second = barrier.prepare(drifted);

    await Promise.all([
      firstRejected,
      expectCode(second, 'portable_paired_barrier_identity_mismatch'),
    ]);
    expect(barrier.state).toBe('failed');
  });
});

describe('portable paired prepared barrier configuration validation', () => {
  it('rejects unbounded timeouts and shared signing keys', () => {
    expect(() => createPortablePairedPreparedBarrier(config(9)))
      .toThrowError('portable_paired_barrier_timeout_invalid');
    expect(() => createPortablePairedPreparedBarrier(config(600_001)))
      .toThrowError('portable_paired_barrier_timeout_invalid');

    const sharedKeyConfig = config();
    sharedKeyConfig.hmacKeys.candidate = Buffer.from(sharedKeyConfig.hmacKeys.baseline);
    expect(() => createPortablePairedPreparedBarrier(sharedKeyConfig))
      .toThrowError('portable_paired_barrier_distinct_hmac_keys_required');
  });

  it('rejects shared parity or fixture fields smuggled into a prepared arrival', async () => {
    const barrier = createPortablePairedPreparedBarrier(config());
    const smuggled = {
      ...prepared('baseline'),
      parity: config().parity,
    };
    await expectCode(
      barrier.prepare(smuggled as any),
      'portable_paired_barrier_prepared_invalid',
    );
    expect(barrier.state).toBe('failed');
  });

  it('requires a clean baseline but permits a dirty candidate identity', async () => {
    const dirtyBaselineBarrier = createPortablePairedPreparedBarrier(config());
    const dirtyBaseline = prepared('baseline');
    dirtyBaseline.taskRegressionBuildIdentity.sourceDirty = true;
    await expectCode(
      dirtyBaselineBarrier.prepare(dirtyBaseline),
      'portable_paired_barrier_build_identity_invalid',
    );

    const candidateDirtyBarrier = createPortablePairedPreparedBarrier(config());
    const baselinePromise = candidateDirtyBarrier.prepare(prepared('baseline'));
    const dirtyCandidate = prepared('candidate');
    dirtyCandidate.taskRegressionBuildIdentity.sourceDirty = true;
    const candidatePromise = candidateDirtyBarrier.prepare(dirtyCandidate);
    const [, candidate] = await Promise.all([baselinePromise, candidatePromise]);
    expect(candidate.portableBuildIdentity.sourceDirty).toBe(true);
    expect(candidate.summary.paritySha256).toBe(candidate.pairedPlan.paritySha256);
  });
});
