import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TASK_REGRESSION_BUILD_IDENTITY_KIND,
  TASK_REGRESSION_RUN_KIND,
  TASK_REGRESSION_RUN_SCHEMA,
  TASK_REGRESSION_RUN_SCHEMA_VERSION,
  TASK_REGRESSION_SCENARIOS,
  TASK_TRUTH_SNAPSHOT_KIND,
  TASK_TRUTH_SNAPSHOT_SCHEMA,
  TASK_TRUTH_SNAPSHOT_SCHEMA_VERSION,
  assertTaskRegressionRun,
  assertTaskTruthSnapshot,
  compareTaskRegressionRuns,
  stableTaskRegressionJson,
  summarizeTaskRegressionRun,
  taskRegressionBuildIdentityDigest,
  validateTaskRegressionRun,
  validateTaskTruthSnapshot,
} from '../scripts/lib/task-regression-matrix.mjs';
import {
  parseTaskRegressionComparisonArgs,
  runTaskRegressionComparisonCli,
  taskRegressionComparisonExitCode,
} from '../scripts/compare-task-regression-runs.mjs';

const BASELINE_REVISION = `28c08cd${'0'.repeat(33)}`;
const CANDIDATE_REVISION = `0d1180d${'1'.repeat(33)}`;
const STARTED_AT = '2026-08-27T12:00:00.000Z';
const RECORDED_AT = '2026-08-27T12:01:00.000Z';
const CAPTURED_AT = '2026-08-27T12:02:00.000Z';
const COMPLETED_AT = '2026-08-27T12:03:00.000Z';

function hash(character: string) {
  return character.repeat(64);
}

function buildIdentity(role: 'baseline' | 'candidate') {
  return {
    kind: TASK_REGRESSION_BUILD_IDENTITY_KIND,
    revision: role === 'baseline' ? BASELINE_REVISION : CANDIDATE_REVISION,
    sourceFingerprintSha256: role === 'baseline' ? hash('a') : hash('b'),
    sourceDirty: role === 'candidate',
    runtimeFingerprintSha256: role === 'baseline' ? hash('c') : hash('d'),
    collectedAt: STARTED_AT,
  };
}

function truthSnapshot(
  scenarioId: string,
  runId: string,
  identityDigest: string,
  ordinal: number,
) {
  const taskId = `task-${ordinal}`;
  const requestId = `request-${ordinal}`;
  const toolName = `tool_${ordinal}`;
  return {
    kind: TASK_TRUTH_SNAPSHOT_KIND,
    schemaVersion: TASK_TRUTH_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: `snapshot-${ordinal}`,
    scenarioId,
    acceptanceRunId: runId,
    capturedAt: CAPTURED_AT,
    buildIdentityDigest: identityDigest,
    userVisibleReply: {
      messageId: `assistant-message-${ordinal}`,
      text: `用户实际看到的第 ${ordinal} 个场景结果`,
      recordedAt: RECORDED_AT,
    },
    task: {
      recordId: `task-record-${ordinal}`,
      taskId,
      status: 'completed',
      goal: `完成独立场景 ${scenarioId}`,
      updatedAt: RECORDED_AT,
    },
    pointers: {
      pending: {
        state: 'cleared',
        taskId: null,
        requestId: null,
        recordId: `pending-pointer-record-${ordinal}`,
        observedAt: CAPTURED_AT,
      },
      live: {
        state: 'cleared',
        taskId: null,
        requestId: null,
        recordId: `live-pointer-record-${ordinal}`,
        observedAt: CAPTURED_AT,
      },
    },
    request: {
      recordId: `request-record-${ordinal}`,
      requestId,
      taskId,
      status: 'succeeded',
      recordedAt: RECORDED_AT,
    },
    receipt: {
      recordId: `receipt-record-${ordinal}`,
      receiptId: `receipt-${ordinal}`,
      requestId,
      taskId,
      status: 'succeeded',
      toolName,
      recordedAt: RECORDED_AT,
    },
    toolTarget: {
      recordId: `target-record-${ordinal}`,
      requestId,
      taskId,
      toolName,
      targetType: 'test_fixture_target',
      targetId: `target-${ordinal}`,
      displayName: `场景目标 ${ordinal}`,
      source: 'independent_matrix_harness',
      normalizedTargetSha256: hash('e'),
      recordedAt: RECORDED_AT,
    },
    modelActualInput: {
      captureId: `provider-capture-${ordinal}`,
      captureOrigin: 'provider_dispatch_boundary',
      modelInvoked: true,
      recordId: `provider-capture-record-${ordinal}`,
      requestId,
      taskId,
      provider: 'fixture-provider',
      model: 'fixture-model',
      digestProtection: 'installation_hmac_sha256_v1',
      digestKeyId: hash('4'),
      evidenceAttestationSha256: hash('5'),
      payloadSha256: hash('f'),
      messagesSha256: hash('1'),
      messageCount: 2,
      messages: [
        {
          index: 0,
          role: 'system',
          contentSha256: hash('2'),
          textCharCount: 100,
          sourceMessageId: null,
        },
        {
          index: 1,
          role: 'user',
          contentSha256: hash('3'),
          textCharCount: 12,
          sourceMessageId: `user-message-${ordinal}`,
        },
      ],
      recordedAt: RECORDED_AT,
    },
  };
}

function regressionRun(role: 'baseline' | 'candidate') {
  const identity = buildIdentity(role);
  const runId = `${role}-run-001`;
  const identityDigest = taskRegressionBuildIdentityDigest(identity);
  return {
    kind: TASK_REGRESSION_RUN_KIND,
    schemaVersion: TASK_REGRESSION_RUN_SCHEMA_VERSION,
    runId,
    role,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    buildIdentity: identity,
    scenarioResults: TASK_REGRESSION_SCENARIOS.map(scenario => {
      const snapshot = truthSnapshot(scenario.id, runId, identityDigest, scenario.ordinal);
      return {
        scenarioId: scenario.id,
        snapshots: [snapshot],
        checks: scenario.checks.map(checkId => ({
          checkId,
          passed: true,
          evidenceSnapshotIds: [snapshot.snapshotId],
        })),
      };
    }),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function memoryWriter() {
  let contents = '';
  return {
    stream: { write(chunk: string) { contents += chunk; return true; } },
    read() { return contents; },
  };
}

describe('task regression matrix contract', () => {
  it('defines the eight objective scenarios outside the tested runtime', () => {
    expect(TASK_REGRESSION_SCENARIOS).toHaveLength(8);
    expect(TASK_REGRESSION_SCENARIOS.map(item => item.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(TASK_REGRESSION_SCENARIOS.map(item => item.id)).toEqual([
      'cleanup_offer_then_cleanup',
      'repeated_confirmation_exactly_once',
      'wps_wrong_file_correction',
      'displayed_result_stale_receipt',
      'control_stop_status_repeat',
      'voice_to_text_continuation',
      'mid_task_restart_recovery',
      'primary_model_failover_lmstudio',
    ]);
    for (const scenario of TASK_REGRESSION_SCENARIOS) {
      expect(scenario.requiredEvidence).toEqual([
        'user_visible_reply', 'task', 'pending_pointer', 'live_pointer', 'request',
        'receipt', 'tool_target', 'model_actual_input',
      ]);
      expect(scenario.checks.length).toBeGreaterThan(0);
      expect(Object.isFrozen(scenario)).toBe(true);
    }
    expect(Object.isFrozen(TASK_REGRESSION_SCENARIOS)).toBe(true);
  });

  it('exports closed artifact schemas', () => {
    expect(TASK_TRUTH_SNAPSHOT_SCHEMA.additionalProperties).toBe(false);
    expect(TASK_TRUTH_SNAPSHOT_SCHEMA.properties.modelActualInput.oneOf)
      .toSatisfy((variants: any[]) => variants.every(variant => variant.additionalProperties === false));
    expect(TASK_REGRESSION_RUN_SCHEMA.additionalProperties).toBe(false);
    expect(TASK_REGRESSION_RUN_SCHEMA.properties.buildIdentity.additionalProperties).toBe(false);
  });

  it('accepts a fully bound truth snapshot and rejects unknown fields', () => {
    const run = regressionRun('candidate');
    const snapshot = run.scenarioResults[0].snapshots[0];
    expect(validateTaskTruthSnapshot(snapshot, {
      expectedScenarioId: snapshot.scenarioId,
      expectedAcceptanceRunId: run.runId,
      expectedBuildIdentityDigest: taskRegressionBuildIdentityDigest(run.buildIdentity),
    })).toEqual({ ok: true, value: snapshot });
    expect(assertTaskTruthSnapshot(snapshot)).toBe(snapshot);

    const withUnknown = { ...snapshot, untrustedClaim: true };
    const validation = validateTaskTruthSnapshot(withUnknown);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.issues).toContainEqual(expect.objectContaining({
      path: '$.untrustedClaim', code: 'unknown_property',
    }));
  });

  it.each([
    ['user visible reply', (snapshot: any) => { delete snapshot.userVisibleReply; }],
    ['task', (snapshot: any) => { delete snapshot.task; }],
    ['pending pointer', (snapshot: any) => { delete snapshot.pointers.pending; }],
    ['live pointer', (snapshot: any) => { delete snapshot.pointers.live; }],
    ['requestId', (snapshot: any) => { delete snapshot.request.requestId; }],
    ['taskId', (snapshot: any) => { delete snapshot.request.taskId; }],
    ['receipt', (snapshot: any) => { delete snapshot.receipt; }],
    ['tool target', (snapshot: any) => { delete snapshot.toolTarget; }],
    ['model actual input', (snapshot: any) => { delete snapshot.modelActualInput; }],
  ])('fails closed when %s evidence is missing', (_label, mutate) => {
    const run = regressionRun('candidate');
    const snapshot = clone(run.scenarioResults[0].snapshots[0]);
    mutate(snapshot);
    expect(validateTaskTruthSnapshot(snapshot).ok).toBe(false);
    expect(() => assertTaskTruthSnapshot(snapshot)).toThrow('task_truth_snapshot_invalid');
  });

  it('rejects caller-labelled model evidence and broken task/request/tool bindings', () => {
    const run = regressionRun('candidate');
    const original = run.scenarioResults[0].snapshots[0];

    const callerLabelled = clone(original);
    callerLabelled.modelActualInput.captureOrigin = 'caller_self_report';
    expect(validateTaskTruthSnapshot(callerLabelled).ok).toBe(false);

    const noSourceUser = clone(original);
    noSourceUser.modelActualInput.messages[1].sourceMessageId = null;
    expect(validateTaskTruthSnapshot(noSourceUser).ok).toBe(false);

    const wrongTask = clone(original);
    wrongTask.receipt.taskId = 'different-task';
    expect(validateTaskTruthSnapshot(wrongTask).ok).toBe(false);

    const wrongRequest = clone(original);
    wrongRequest.toolTarget.requestId = 'different-request';
    expect(validateTaskTruthSnapshot(wrongRequest).ok).toBe(false);

    const wrongTool = clone(original);
    wrongTool.toolTarget.toolName = 'different_tool';
    expect(validateTaskTruthSnapshot(wrongTool).ok).toBe(false);
  });

  it('enforces pointer truth for terminal and waiting-confirmation task states', () => {
    const run = regressionRun('candidate');
    const terminalWithLiveOwner = clone(run.scenarioResults[0].snapshots[0]);
    terminalWithLiveOwner.pointers.live = {
      ...terminalWithLiveOwner.pointers.live,
      state: 'set',
      taskId: terminalWithLiveOwner.task.taskId,
      requestId: terminalWithLiveOwner.request.requestId,
    };
    expect(validateTaskTruthSnapshot(terminalWithLiveOwner).ok).toBe(false);

    const waiting = clone(run.scenarioResults[0].snapshots[0]);
    waiting.task.status = 'waiting_confirmation';
    waiting.request.status = 'waiting_confirmation';
    waiting.receipt.status = 'waiting_confirmation';
    waiting.pointers.pending = {
      ...waiting.pointers.pending,
      state: 'set',
      taskId: waiting.task.taskId,
      requestId: waiting.request.requestId,
    };
    waiting.pointers.live = {
      ...waiting.pointers.live,
      state: 'set',
      taskId: waiting.task.taskId,
      requestId: waiting.request.requestId,
    };
    expect(validateTaskTruthSnapshot(waiting).ok).toBe(true);
  });

  it('allows a resumable blocked task to retain only its live focus pointer', () => {
    const run = regressionRun('candidate');
    const blocked = clone(run.scenarioResults[0].snapshots[0]);
    blocked.task.status = 'blocked';
    blocked.request.status = 'blocked';
    blocked.receipt.status = 'blocked';
    blocked.pointers.pending = {
      ...blocked.pointers.pending,
      state: 'cleared',
      taskId: null,
      requestId: null,
    };
    blocked.pointers.live = {
      ...blocked.pointers.live,
      state: 'set',
      taskId: blocked.task.taskId,
      requestId: null,
    };

    expect(validateTaskTruthSnapshot(blocked)).toEqual({ ok: true, value: blocked });

    const blockedWithPending = clone(blocked);
    blockedWithPending.pointers.pending = {
      ...blockedWithPending.pointers.pending,
      state: 'set',
      taskId: blocked.task.taskId,
      requestId: blocked.request.requestId,
    };
    expect(validateTaskTruthSnapshot(blockedWithPending).ok).toBe(false);
  });

  it('validates a complete run without trusting a claimed overall status', () => {
    const run = regressionRun('candidate');
    expect(validateTaskRegressionRun(run)).toEqual({ ok: true, value: run });
    expect(assertTaskRegressionRun(run)).toBe(run);
    const summary = summarizeTaskRegressionRun(run);
    expect(summary).toMatchObject({
      artifactValid: true,
      overallPassed: true,
      scenarioCount: 8,
      passedScenarioCount: 8,
      failedScenarioCount: 0,
    });
    expect(summary.scenarios.every(item => item.passed)).toBe(true);
  });

  it('marks only the affected scenario failed when one evidence dimension is absent', () => {
    const run = regressionRun('candidate');
    delete (run.scenarioResults[2].snapshots[0] as any).receipt;
    const summary = summarizeTaskRegressionRun(run);
    expect(summary.artifactValid).toBe(false);
    expect(summary.overallPassed).toBe(false);
    expect(summary.passedScenarioCount).toBe(7);
    expect(summary.scenarios[2]).toMatchObject({
      scenarioId: 'wps_wrong_file_correction',
      passed: false,
    });
    expect(summary.scenarios[2].evidenceFailures).toContain('required');
    expect(summary.scenarios.filter(item => item.ordinal !== 3).every(item => item.passed)).toBe(true);
  });

  it('requires every defined check and a real snapshot reference', () => {
    const missingCheck = regressionRun('candidate');
    missingCheck.scenarioResults[0].checks.pop();
    expect(validateTaskRegressionRun(missingCheck).ok).toBe(false);
    expect(summarizeTaskRegressionRun(missingCheck).scenarios[0].passed).toBe(false);

    const unknownReference = regressionRun('candidate');
    unknownReference.scenarioResults[0].checks[0].evidenceSnapshotIds = ['not-a-snapshot'];
    expect(validateTaskRegressionRun(unknownReference).ok).toBe(false);
  });

  it('derives quantitative baseline/candidate deltas from distinct build identities', () => {
    const baseline = regressionRun('baseline');
    const candidate = regressionRun('candidate');
    baseline.scenarioResults[0].checks[0].passed = false;
    const comparison = compareTaskRegressionRuns(baseline, candidate, {
      expectedBaselineRevision: '28c08cd',
      requireCandidateDirty: true,
      comparedAt: COMPLETED_AT,
    });
    expect(comparison).toMatchObject({
      comparisonValid: true,
      overallPassed: true,
      counts: {
        scenarioCount: 8,
        baselinePassed: 7,
        candidatePassed: 8,
        improved: 1,
        regressed: 0,
        unchangedPass: 7,
        unchangedFail: 0,
      },
    });
    expect(comparison.scenarios[0].delta).toBe('improved');
    expect(taskRegressionComparisonExitCode(comparison)).toBe(0);
  });

  it('rejects identical runtime identities, wrong baseline revisions, and unrequested clean candidates', () => {
    const baseline = regressionRun('baseline');
    const candidate = regressionRun('candidate');
    candidate.buildIdentity.runtimeFingerprintSha256 = baseline.buildIdentity.runtimeFingerprintSha256;
    const sameRuntime = compareTaskRegressionRuns(baseline, candidate, { comparedAt: COMPLETED_AT });
    expect(sameRuntime.comparisonValid).toBe(false);
    expect(sameRuntime.comparisonIssues).toContain('distinct_runtime_fingerprints_required');
    expect(taskRegressionComparisonExitCode(sameRuntime)).toBe(2);

    const wrongRevision = compareTaskRegressionRuns(
      regressionRun('baseline'), regressionRun('candidate'),
      { expectedBaselineRevision: 'deadbee', comparedAt: COMPLETED_AT },
    );
    expect(wrongRevision.comparisonIssues).toContain('baseline_revision_mismatch');

    const cleanCandidate = regressionRun('candidate');
    cleanCandidate.buildIdentity.sourceDirty = false;
    const dirtyRequired = compareTaskRegressionRuns(
      regressionRun('baseline'), cleanCandidate,
      { requireCandidateDirty: true, comparedAt: COMPLETED_AT },
    );
    expect(dirtyRequired.comparisonIssues).toContain('dirty_candidate_required');
  });

  it('is deterministic for canonical build identity hashing', () => {
    const identity = buildIdentity('baseline');
    const reordered = Object.fromEntries(Object.entries(identity).reverse());
    expect(stableTaskRegressionJson(identity)).toBe(stableTaskRegressionJson(reordered));
    expect(taskRegressionBuildIdentityDigest(identity)).toBe(taskRegressionBuildIdentityDigest(reordered));
  });
});

describe('task regression comparison CLI', () => {
  it('parses explicit baseline identity gates', () => {
    expect(parseTaskRegressionComparisonArgs([
      '--baseline', 'old.json',
      '--candidate', 'new.json',
      '--expected-baseline-revision', '28c08cd',
      '--require-candidate-dirty',
      '--pretty',
    ])).toMatchObject({
      baselinePath: 'old.json',
      candidatePath: 'new.json',
      expectedBaselineRevision: '28c08cd',
      requireCandidateDirty: true,
      requireBaselineClean: true,
      pretty: true,
    });
    expect(() => parseTaskRegressionComparisonArgs(['--baseline', 'only.json'])).toThrow(
      'baseline_and_candidate_required',
    );
  });

  it('reads two file-backed runs and emits a machine-readable comparison', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-task-matrix-'));
    try {
      const baselinePath = path.join(temporaryRoot, 'baseline.json');
      const candidatePath = path.join(temporaryRoot, 'candidate.json');
      fs.writeFileSync(baselinePath, JSON.stringify(regressionRun('baseline')), 'utf8');
      fs.writeFileSync(candidatePath, JSON.stringify(regressionRun('candidate')), 'utf8');
      const stdout = memoryWriter();
      const stderr = memoryWriter();
      const exitCode = runTaskRegressionComparisonCli([
        '--baseline', baselinePath,
        '--candidate', candidatePath,
        '--expected-baseline-revision', '28c08cd',
        '--require-candidate-dirty',
      ], { stdout: stdout.stream, stderr: stderr.stream });
      expect(exitCode).toBe(0);
      expect(stderr.read()).toBe('');
      expect(JSON.parse(stdout.read())).toMatchObject({
        kind: 'lumi.task-regression-comparison',
        comparisonValid: true,
        overallPassed: true,
        counts: { baselinePassed: 8, candidatePassed: 8 },
      });
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('returns invalid-evidence exit code instead of comparing partial artifacts', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-task-matrix-invalid-'));
    try {
      const baselinePath = path.join(temporaryRoot, 'baseline.json');
      const candidatePath = path.join(temporaryRoot, 'candidate.json');
      const candidate = regressionRun('candidate');
      delete (candidate.scenarioResults[7].snapshots[0] as any).modelActualInput;
      fs.writeFileSync(baselinePath, JSON.stringify(regressionRun('baseline')), 'utf8');
      fs.writeFileSync(candidatePath, JSON.stringify(candidate), 'utf8');
      const stdout = memoryWriter();
      const stderr = memoryWriter();
      const exitCode = runTaskRegressionComparisonCli([
        '--baseline', baselinePath,
        '--candidate', candidatePath,
      ], { stdout: stdout.stream, stderr: stderr.stream });
      expect(exitCode).toBe(2);
      expect(stderr.read()).toBe('');
      expect(JSON.parse(stdout.read())).toMatchObject({
        comparisonValid: false,
        overallPassed: false,
        candidate: { artifactValid: false, passedScenarioCount: 7 },
      });
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
