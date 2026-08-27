import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { portableEvidenceSha256 } from '../scripts/lib/portable-external-evidence.mjs';
import { createPortablePairedPreparedBarrier } from '../scripts/lib/portable-paired-barrier.mjs';
import {
  PORTABLE_PAIRED_CONTROLLER_REPORT_KIND,
  PORTABLE_PAIRED_CONTROLLER_REPORT_SCHEMA_VERSION,
  portablePostCancelStatusBindingObserved,
  portableCancellationTerminalObserved,
  portableProviderPrecursorBoundedObserved,
  portablePairedControllerCollectorBundleSha256,
  portablePairedControllerModulePath,
  validatePortablePairedControllerReport,
  validatePortablePairedControllerReportStructure,
} from '../scripts/lib/portable-paired-controller.mjs';
import {
  PORTABLE_PAIRED_CONTROLLER_PLAN_KIND,
  PORTABLE_PAIRED_CONTROLLER_SCENARIO_ID,
  buildPortablePairedBackendEnvironment,
  buildPortablePairedBackendLaunch,
  createPortablePairedControllerFrozenPlan,
  portablePairedRuntimeModulePath,
  startPortablePairedProviderStub,
} from '../scripts/lib/portable-paired-controller-runtime.mjs';
import { REQUIRED_FORMAL_DATA_ROOT_DENYLIST } from '../scripts/lib/portable-external-evidence.mjs';
import { TASK_REGRESSION_BUILD_IDENTITY_KIND } from '../scripts/lib/task-regression-matrix.mjs';
import {
  parsePortablePairedControllerCliArgs,
} from '../scripts/run-portable-paired-controller.mjs';

const BASELINE_KEY = Buffer.alloc(32, 0x31);
const CANDIDATE_KEY = Buffer.alloc(32, 0x32);
const stubs: Array<{ close(): Promise<void> }> = [];

function digest(value: unknown) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function plan() {
  return createPortablePairedControllerFrozenPlan({
    runNonce: 'portable-controller-test-0001',
    providerMs: 1_000,
    longProviderDelayMs: 1_100,
    settleMs: 0,
  });
}

function buildIdentity(role: 'baseline' | 'candidate') {
  return {
    kind: TASK_REGRESSION_BUILD_IDENTITY_KIND,
    revision: (role === 'baseline' ? '1' : '2').repeat(40),
    sourceFingerprintSha256: digest(`${role}-controller-source`),
    sourceDirty: role === 'candidate',
    runtimeFingerprintSha256: digest(`${role}-controller-runtime`),
    collectedAt: role === 'baseline'
      ? '2026-08-27T13:00:00.000Z'
      : '2026-08-27T13:01:00.000Z',
  };
}

async function pairedKits() {
  const frozen = plan();
  const barrier = createPortablePairedPreparedBarrier({
    parity: {
      profileSha256: frozen.profileSha256,
      collectorBundleSha256: digest('controller-test-collector'),
      timeoutPolicy: frozen.timeoutPolicy,
      platform: process.platform,
      nodeMajor: Number.parseInt(process.versions.node.split('.')[0], 10),
    },
    fixture: { phases: frozen.phases },
    hmacKeys: { baseline: BASELINE_KEY, candidate: CANDIDATE_KEY },
    timeoutMs: 1_000,
  });
  const prepared = (role: 'baseline' | 'candidate') => ({
    role,
    runId: `${role}-controller-test-run`,
    taskRegressionBuildIdentity: buildIdentity(role),
    dataRootIdentitySha256: digest(`${role}-controller-data-root`),
    userId: `${role}-controller-user`,
    conversationId: `${role}-controller-conversation`,
    phases: frozen.phases.map((phase: any, index: number) => ({
      scenarioId: phase.scenarioId,
      phaseId: phase.phaseId,
      requestId: `${role}-controller-request-${index + 1}`,
      phaseNonce: `${role}-controller-phase-nonce-${index + 1}-0001`,
      turnOrdinal: phase.turnOrdinal,
      unmarkedUserTextSha256: phase.unmarkedUserTextSha256,
    })),
  });
  const [baseline, candidate] = await Promise.all([
    barrier.prepare(prepared('baseline')),
    barrier.prepare(prepared('candidate')),
  ]);
  return { frozen, baseline, candidate };
}

afterEach(async () => {
  for (const stub of stubs.splice(0)) await stub.close();
});

describe('portable paired controller frozen plan', () => {
  it('seals one complete four-phase Truth V2 control scenario without serializing raw fixture data', () => {
    const first = plan();
    const second = plan();

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.kind).toBe(PORTABLE_PAIRED_CONTROLLER_PLAN_KIND);
    expect(first.scenarioId).toBe(PORTABLE_PAIRED_CONTROLLER_SCENARIO_ID);
    expect(first.scenarioCoverage).toBe('complete_four_phase_truth_v2_profile');
    expect(first.phases.map((phase: any) => phase.phaseId)).toEqual([
      'long_start', 'stop', 'status_after_cancel', 'repeat_status',
    ]);
    expect(first.phases.map((phase: any) => phase.turnOrdinal)).toEqual([1, 2, 3, 4]);
    expect(first.phases.map((phase: any) => phase.requirements.providerWitness))
      .toEqual([true, false, false, false]);
    for (const field of [
      'profileSha256', 'fixturePlanSha256', 'fixturePayloadSha256',
      'timeoutPolicySha256', 'coverageSha256', 'planSha256',
    ]) expect(first[field]).toMatch(/^[a-f0-9]{64}$/u);

    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain('PORTABLE_CONTROL_SENTINEL_portable-controller-test-0001');
    expect(serialized).not.toContain('这是一个可取消的隔离长任务');
    expect(first.phaseInputs.stop).toBe('停止');
    expect(first.fixtureContent).toContain('portable-controller-test-0001');
  });

  it('binds fixture, timeout, and phase drift into independent public digests', () => {
    const original = plan();
    const differentFixture = createPortablePairedControllerFrozenPlan({
      runNonce: 'portable-controller-test-0002',
      providerMs: 1_000,
      longProviderDelayMs: 1_100,
      settleMs: 0,
    });
    const differentTimeout = createPortablePairedControllerFrozenPlan({
      runNonce: 'portable-controller-test-0001',
      providerMs: 1_200,
      longProviderDelayMs: 1_300,
      settleMs: 0,
    });

    expect(differentFixture.fixturePayloadSha256).not.toBe(original.fixturePayloadSha256);
    expect(differentFixture.fixturePlanSha256).toBe(original.fixturePlanSha256);
    expect(differentTimeout.timeoutPolicySha256).not.toBe(original.timeoutPolicySha256);
    expect(differentTimeout.planSha256).not.toBe(original.planSha256);
  });
});

describe('portable paired controller post-cancel status binding', () => {
  function terminals() {
    const targetRequestId = 'controller-cancelled-foreground';
    const rawText = 'The exact foreground request was cancelled.';
    const textSha256 = portableEvidenceSha256(rawText);
    return {
      targetRequestId,
      targetTerminal: {
        requestId: targetRequestId,
        event: 'agent:response',
        finalized: true,
        rawText,
        textSha256,
      },
      statusTerminal: {
        requestId: 'controller-status-sidecar',
        event: 'agent:response',
        finalized: true,
        reason: 'target_execution_status',
        controlIntent: 'status',
        targetRequestId,
        rawText,
        textSha256,
      },
    };
  }

  it('requires every exact status field and the cancelled target terminal text digest', () => {
    const fixture = terminals();
    expect(portablePostCancelStatusBindingObserved({
      expectedTargetRequestId: fixture.targetRequestId,
      statusTerminal: fixture.statusTerminal,
      targetTerminal: fixture.targetTerminal,
    })).toBe(true);

    for (const statusTerminal of [
      { ...fixture.statusTerminal, finalized: false },
      { ...fixture.statusTerminal, reason: 'some_status' },
      { ...fixture.statusTerminal, controlIntent: '' },
      { ...fixture.statusTerminal, targetRequestId: 'wrong-foreground' },
    ]) {
      expect(portablePostCancelStatusBindingObserved({
        expectedTargetRequestId: fixture.targetRequestId,
        statusTerminal,
        targetTerminal: fixture.targetTerminal,
      })).toBe(false);
    }
  });

  it('rejects arbitrary status text even when every status label names the exact target', () => {
    const fixture = terminals();
    const arbitraryText = 'An unrelated task completed successfully.';
    expect(portablePostCancelStatusBindingObserved({
      expectedTargetRequestId: fixture.targetRequestId,
      statusTerminal: {
        ...fixture.statusTerminal,
        rawText: arbitraryText,
        textSha256: portableEvidenceSha256(arbitraryText),
      },
      targetTerminal: fixture.targetTerminal,
    })).toBe(false);
  });
});

describe('portable paired controller execution-fact checks', () => {
  it('does not mistake a negative stop reply for a completed cancellation', () => {
    expect(portableCancellationTerminalObserved({
      stopTerminal: {
        finalized: true,
        reason: 'missing_control_target',
        rawText: '找不到可停止的任务。',
      },
      targetTerminal: { finalized: true, reason: '', status: '' },
    })).toBe(false);
    expect(portableCancellationTerminalObserved({
      stopTerminal: { finalized: true, reason: 'cancelled_by_user' },
      targetTerminal: { finalized: true, reason: 'request_cancelled' },
    })).toBe(true);
  });

  it('rejects an armed unbound provider call as a control-path model leak', () => {
    const classifier = { deliveredAt: '2026-08-27T00:00:00.000Z' };
    const answer = {
      abortedAt: '2026-08-27T00:00:01.000Z',
      deliveredAt: '',
      scheduledDelayMs: 15_000,
    };
    const input = {
      longClassifierCaptures: [classifier],
      longAnswerCaptures: [answer],
      controlCaptures: [],
      armedUnboundCaptures: [],
      protocolViolations: [],
      longProviderDelayMs: 15_000,
    };
    expect(portableProviderPrecursorBoundedObserved(input)).toBe(true);
    expect(portableProviderPrecursorBoundedObserved({
      ...input,
      armedUnboundCaptures: [{ auxiliary: true }],
    })).toBe(false);
  });
});

describe('portable paired controller runtime boundary', () => {
  it('builds a secret-stripped loopback-only production environment without candidate evidence flags', () => {
    const previous = process.env.UNRELATED_API_KEY;
    process.env.UNRELATED_API_KEY = 'must-not-leak';
    try {
      const base = path.resolve('D:/portable-controller-unit');
      const env = buildPortablePairedBackendEnvironment({
        role: 'candidate',
        port: 34567,
        providerBaseUrl: 'http://127.0.0.1:45678',
        sandbox: {
          home: path.join(base, 'home'),
          appData: path.join(base, 'appdata'),
          localAppData: path.join(base, 'localappdata'),
          temporary: path.join(base, 'tmp'),
          dataRoot: path.join(base, 'profile'),
          logs: path.join(base, 'logs'),
          dotenvPath: path.join(base, 'empty.env'),
          emptyDist: path.join(base, 'empty-dist'),
        },
      });
      expect(env.OPENAI_BASE_URL).toBe('http://127.0.0.1:45678/v1');
      expect(env.HOST).toBe('127.0.0.1');
      expect(env.PORT).toBe('34567');
      expect(env.UNRELATED_API_KEY).toBeUndefined();
      expect(env.LUMI_TASK_REGRESSION_EVIDENCE_MODE).toBeUndefined();
      expect(env.LUMI_TASK_REGRESSION_PROOF_SHA256).toBeUndefined();
      expect(env.LUMI_TASK_REGRESSION_DESKTOP_RELAY_PROOF_SHA256).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.UNRELATED_API_KEY;
      else process.env.UNRELATED_API_KEY = previous;
    }
  });

  it('rejects a cloud provider endpoint and formal product data roots before startup', () => {
    const base = path.resolve('D:/portable-controller-unit');
    const sandbox = {
      home: path.join(base, 'home'), appData: path.join(base, 'appdata'),
      localAppData: path.join(base, 'local'), temporary: path.join(base, 'tmp'),
      dataRoot: path.join(base, 'profile'), logs: path.join(base, 'logs'),
      dotenvPath: path.join(base, 'empty.env'), emptyDist: path.join(base, 'empty-dist'),
    };
    expect(() => buildPortablePairedBackendEnvironment({
      role: 'baseline', port: 34567, providerBaseUrl: 'https://api.openai.com', sandbox,
    })).toThrowError('portable_paired_controller_provider_url_invalid');
    if (process.platform === 'win32') {
      expect(() => buildPortablePairedBackendEnvironment({
        role: 'baseline', port: 34567, providerBaseUrl: 'http://127.0.0.1:45678',
        sandbox: {
          ...sandbox,
          dataRoot: path.join(REQUIRED_FORMAL_DATA_ROOT_DENYLIST[1], 'controller-test'),
        },
      })).toThrowError('portable_paired_controller_formal_data_path_forbidden');
    }
  });

  it('starts from the owned sandbox cwd and cannot load a worktree dotenv marker', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-controller-dotenv-'));
    try {
      const worktree = path.join(tempRoot, 'worktree');
      const sandboxRoot = path.join(tempRoot, 'sandbox');
      const sandbox = {
        root: sandboxRoot,
        home: path.join(sandboxRoot, 'home'),
        appData: path.join(sandboxRoot, 'appdata'),
        localAppData: path.join(sandboxRoot, 'localappdata'),
        temporary: path.join(sandboxRoot, 'tmp'),
        dataRoot: path.join(sandboxRoot, 'profile'),
        logs: path.join(sandboxRoot, 'logs'),
        dotenvPath: path.join(sandboxRoot, 'empty.env'),
        emptyDist: path.join(sandboxRoot, 'empty-dist'),
      };
      fs.mkdirSync(worktree, { recursive: true });
      for (const directory of [
        sandbox.root,
        sandbox.home,
        sandbox.appData,
        sandbox.localAppData,
        sandbox.temporary,
        sandbox.dataRoot,
        sandbox.logs,
        sandbox.emptyDist,
      ]) fs.mkdirSync(directory, { recursive: true });
      const markerName = 'PORTABLE_PAIRED_WORKTREE_DOTENV_MARKER';
      fs.writeFileSync(path.join(worktree, '.env'), `${markerName}=must-not-load\n`, 'utf8');
      fs.writeFileSync(sandbox.dotenvPath, '', 'utf8');
      const entry = path.join(worktree, 'server-entry.mjs');
      fs.writeFileSync(entry, '', 'utf8');
      const require = createRequire(import.meta.url);
      const launch = buildPortablePairedBackendLaunch({
        role: 'candidate',
        target: { entry, tsxLoader: require.resolve('tsx') },
        sandbox,
        port: 34567,
        providerBaseUrl: 'http://127.0.0.1:45678',
      });

      expect(path.resolve(launch.cwd)).toBe(fs.realpathSync.native(sandbox.root));
      expect(fs.realpathSync.native(path.resolve(launch.env.DOTENV_CONFIG_PATH)))
        .toBe(fs.realpathSync.native(sandbox.dotenvPath));
      expect(launch.isolation).toMatchObject({
        sandboxCwd: true,
        worktreeCwdUsed: false,
        ownedEmptyDotenv: true,
      });
      const dotenvConfig = require.resolve('dotenv/config');
      const childEnv: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(launch.env).map(([key, value]) => [key, String(value)]),
      );
      const probe = JSON.parse(execFileSync(process.execPath, [
        '--import', pathToFileURL(dotenvConfig).href,
        '--eval', `process.stdout.write(JSON.stringify({ marker: process.env.${markerName} || null, cwd: process.cwd(), dotenvPath: process.env.DOTENV_CONFIG_PATH }))`,
      ], {
        cwd: launch.cwd,
        env: childEnv,
        encoding: 'utf8',
        windowsHide: true,
      }));
      expect(probe).toEqual({
        marker: null,
        cwd: launch.cwd,
        dotenvPath: launch.env.DOTENV_CONFIG_PATH,
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('captures classifier and answer payloads separately, then records answer cancellation', async () => {
    const { frozen, candidate } = await pairedKits();
    const stub = await startPortablePairedProviderStub({ role: 'candidate' });
    stubs.push(stub);
    stub.arm({ kit: candidate, plan: frozen });
    const phase = candidate.manifest.phases.find((item: any) => item.phaseId === 'long_start');
    const selector = {
      scenarioId: phase.scenarioId,
      phaseId: phase.phaseId,
      requestId: phase.requestId,
      phaseNonce: phase.phaseNonce,
    };
    const marked = candidate.hooks.prepareUserTurn({
      role: 'candidate', selector, turnOrdinal: 1, text: frozen.phaseInputs.long_start,
    });
    const classifierStartedAt = Date.now();
    const classifierResponse = await fetch(`${stub.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'lumi-portable-paired-stub-v1',
        stream: false,
        messages: [{ role: 'user', content: marked.text }],
      }),
    });
    const classifierBody = await classifierResponse.json() as any;
    expect(Date.now() - classifierStartedAt).toBeLessThan(1_000);
    expect(JSON.parse(classifierBody.choices[0].message.content)).toMatchObject({
      category: 'command', confidence: 0.99,
    });
    const abort = new AbortController();
    const pending = fetch(`${stub.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'lumi-portable-paired-stub-v1',
        stream: true,
        messages: [{ role: 'user', content: marked.text }],
      }),
      signal: abort.signal,
    }).catch(() => null);
    await stub.waitForDelayedPhase('long_start', 1_000);
    abort.abort();
    await pending;
    await new Promise(resolve => setTimeout(resolve, 20));

    const captures = stub.requests.filter((item: any) => item.phaseId === 'long_start');
    expect(captures).toHaveLength(2);
    expect(captures[0]).toMatchObject({
      auxiliary: false,
      phaseId: 'long_start',
      providerStage: 'intent_classifier',
      deliveredAt: expect.any(String),
    });
    const capture = captures[1];
    expect(capture).toMatchObject({
      auxiliary: false,
      phaseId: 'long_start',
      providerStage: 'answer',
      scheduledDelayMs: 1_100,
    });
    expect(capture.bindingDigest).toBe(phase.bindingDigest);
    expect(capture.abortedAt).toBeTruthy();
    expect(capture.deliveredAt).toBeUndefined();
    expect(stub.protocolViolations).toEqual([]);
    expect(candidate.collector.buildBundle().phaseEvidence[0].providerCaptures).toHaveLength(2);
  });

  it('keeps controller collectors external and independent of the black-box runner', () => {
    const sources = [portablePairedControllerModulePath(), portablePairedRuntimeModulePath()]
      .map(filename => fs.readFileSync(filename, 'utf8'))
      .join('\n');
    expect(sources).not.toContain('task-regression-black-box-runner');
    expect(sources).not.toContain('/task-regression/');
    expect(sources).not.toContain('task_truth_snapshot');
    expect(sources).not.toContain('desktop_relay');
    expect(portablePairedControllerCollectorBundleSha256()).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe('portable paired controller CLI and report validation', () => {
  it('requires explicit worktrees/output and rejects unknown or newest selectors', () => {
    const parsed = parsePortablePairedControllerCliArgs([
      '--baseline-worktree', 'D:/baseline',
      '--candidate-worktree', 'D:/candidate',
      '--output', 'D:/report.json',
    ]);
    expect(parsed).toMatchObject({ command: 'run' });
    expect(parsed.options.baselineWorktree).toBe(path.resolve('D:/baseline'));
    expect(() => parsePortablePairedControllerCliArgs([
      '--baseline-worktree', 'D:/baseline',
      '--candidate-worktree', 'D:/candidate',
      '--output', 'D:/report.json',
      '--latest', 'true',
    ])).toThrowError('portable_paired_controller_cli_flag_invalid');
    expect(() => parsePortablePairedControllerCliArgs([
      '--baseline-worktree', 'D:/baseline',
      '--candidate-worktree', 'D:/candidate',
    ])).toThrowError('portable_paired_controller_cli_flag_required');
  });

  it('keeps an unproven formal boundary structurally diagnostic but ineligible for acceptance', () => {
    const core: any = {
      kind: PORTABLE_PAIRED_CONTROLLER_REPORT_KIND,
      schemaVersion: PORTABLE_PAIRED_CONTROLLER_REPORT_SCHEMA_VERSION,
      forbiddenCandidateEvidenceEndpointsUsed: false,
      formalClientStartedOrTouched: 'not_observed',
      formalDataReadOrWritten: 'not_observed',
      formalRuntimeBoundaryProof: 'not_proven',
      formalRuntimeBoundary: {
        observationScope: 'launch_environment_configuration_only',
        formalClientAccess: 'not_observed',
        formalDataAccess: 'not_observed',
        osLevelAccessEnforcement: 'not_proven',
        launchBoundaryObserved: true,
        evidenceEligible: false,
      },
      cleanup: {
        baselineBackendStopped: true,
        candidateBackendStopped: true,
        baselineProviderStopped: true,
        candidateProviderStopped: true,
        sandboxRemoved: true,
      },
      behaviorPassed: true,
      nonFormalEvidenceComplete: true,
      complete: false,
      evidenceComplete: false,
    };
    const report = { ...core, reportSha256: portableEvidenceSha256(core) };
    expect(validatePortablePairedControllerReportStructure(report)).toEqual({ ok: true, issues: [] });
    expect(validatePortablePairedControllerReport(report)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        'formal_runtime_boundary_unproven',
        'evidence_incomplete',
      ]),
    });

    const formalClaimCore = { ...core, formalDataReadOrWritten: false };
    const formalClaim = {
      ...formalClaimCore,
      reportSha256: portableEvidenceSha256(formalClaimCore),
    };
    expect(validatePortablePairedControllerReportStructure(formalClaim).issues)
      .toContain('formal_runtime_observation_invalid');

    const cleanupCore = {
      ...core,
      cleanup: { ...core.cleanup, sandboxRemoved: false },
    };
    expect(validatePortablePairedControllerReport({
      ...cleanupCore,
      reportSha256: portableEvidenceSha256(cleanupCore),
    }).issues).toContain('cleanup_incomplete');
  });

  it('rejects reports whose behavior result is missing or false', () => {
    const base: any = {
      kind: PORTABLE_PAIRED_CONTROLLER_REPORT_KIND,
      schemaVersion: PORTABLE_PAIRED_CONTROLLER_REPORT_SCHEMA_VERSION,
      forbiddenCandidateEvidenceEndpointsUsed: false,
      formalClientStartedOrTouched: 'not_observed',
      formalDataReadOrWritten: 'not_observed',
      formalRuntimeBoundaryProof: 'not_proven',
      formalRuntimeBoundary: {
        observationScope: 'launch_environment_configuration_only',
        formalClientAccess: 'not_observed',
        formalDataAccess: 'not_observed',
        osLevelAccessEnforcement: 'not_proven',
        launchBoundaryObserved: true,
        evidenceEligible: false,
      },
      cleanup: {
        baselineBackendStopped: true,
        candidateBackendStopped: true,
        baselineProviderStopped: true,
        candidateProviderStopped: true,
        sandboxRemoved: true,
      },
      complete: false,
      evidenceComplete: false,
    };
    for (const behaviorPassed of [undefined, false]) {
      const core = behaviorPassed === undefined ? base : { ...base, behaviorPassed };
      const report = { ...core, reportSha256: portableEvidenceSha256(core) };
      expect(validatePortablePairedControllerReport(report).issues)
        .toContain('behavior_not_passed');
    }
  });
});
