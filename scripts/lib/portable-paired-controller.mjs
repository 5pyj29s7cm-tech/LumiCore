import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computePortableCollectorBundleSha256,
  portableEvidenceHmacKeyId,
  portableEvidenceSha256,
  portablePhaseNonceRequestTag,
  stablePortableEvidenceJson,
  verifyPortableEvidenceRecord,
} from './portable-external-evidence.mjs';
import { createPortablePairedPreparedBarrier } from './portable-paired-barrier.mjs';
import { probePortablePassiveStore } from './portable-passive-store-probe.mjs';
import {
  computeTaskRegressionBuildIdentity,
  projectTaskRegressionMatrixBuildIdentity,
} from './task-regression-build-identity.mjs';
import {
  PORTABLE_PAIRED_CONTROLLER_BASELINE_REVISION,
  PORTABLE_PAIRED_CONTROLLER_PLAN_KIND,
  PORTABLE_PAIRED_CONTROLLER_SCENARIO_ID,
  PortablePairedControllerRuntimeError,
  capturePortableFilesystemFixture,
  configurePortablePairedModel,
  createPortablePairedControllerFrozenPlan,
  createPortablePairedConversation,
  createPortablePairedSandbox,
  createPortablePairedSocketSession,
  createSignedPortableFilesystemWitness,
  createSignedPortableSocketWitness,
  inspectPortablePairedWorktree,
  portablePairedRuntimeModulePath,
  registerPortablePairedUser,
  removePortablePairedSandbox,
  reservePortableLoopbackPort,
  startPortablePairedBackend,
  startPortablePairedProviderStub,
  stopPortablePairedBackend,
} from './portable-paired-controller-runtime.mjs';

export const PORTABLE_PAIRED_CONTROLLER_REPORT_KIND = 'lumi.portable-paired-controller-report';
export const PORTABLE_PAIRED_CONTROLLER_REPORT_SCHEMA_VERSION = 1;

const ROLES = Object.freeze(['baseline', 'candidate']);
const SHA256_RE = /^[a-f0-9]{64}$/u;

export class PortablePairedControllerError extends Error {
  constructor(code, details = {}, cause) {
    super(code, cause ? { cause } : undefined);
    this.name = 'PortablePairedControllerError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details, cause) {
  throw new PortablePairedControllerError(code, details, cause);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, required, code) {
  if (!isPlainObject(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !keys.includes(key))) {
    fail(code, { keys: keys.sort() });
  }
  return value;
}

function cloneJson(value, code) {
  try { return JSON.parse(stablePortableEvidenceJson(value)); } catch { fail(code); }
}

function exactJson(left, right) {
  return stablePortableEvidenceJson(left) === stablePortableEvidenceJson(right);
}

function sourceIdentityStable(before, after) {
  return before?.candidate?.headCommit === after?.candidate?.headCommit
    && before?.candidate?.dirty === after?.candidate?.dirty
    && before?.sourceFingerprint === after?.sourceFingerprint
    && before?.buildIdentity === after?.buildIdentity;
}

function safeError(error) {
  return {
    code: String(error?.code || 'portable_paired_controller_unexpected_failure'),
    name: String(error?.name || 'Error'),
    messageSha256: portableEvidenceSha256(String(error?.message || error || '')),
  };
}

function check(checkId, observed, evidence = []) {
  return {
    checkId,
    observed: observed === true,
    evidence: evidence.map(value => String(value || '')).filter(Boolean),
  };
}

function normalizedReply(text) {
  return String(text || '').replace(/\s+/gu, ' ').trim();
}

function publicTerminal(turn) {
  const terminal = turn?.terminal || {};
  return {
    requestId: String(turn?.requestId || ''),
    event: String(terminal.event || ''),
    observedAt: String(terminal.observedAt || ''),
    targetRequestId: String(terminal.targetRequestId || ''),
    taskId: String(terminal.taskId || ''),
    status: String(terminal.status || ''),
    reason: String(terminal.reason || ''),
    controlIntent: String(terminal.controlIntent || ''),
    finalized: terminal.finalized === true,
    blocked: terminal.blocked === true,
    textCharCount: Number(terminal.textCharCount || 0),
    textSha256: String(terminal.textSha256 || ''),
  };
}

/**
 * Accept a post-cancellation status answer only when its public terminal is an
 * exact projection of the cancelled foreground terminal. The runtime observer
 * computes both text digests from the raw Socket.IO frames, so this comparison
 * does not trust a status-sidecar label by itself.
 */
export function portablePostCancelStatusBindingObserved(input) {
  if (!isPlainObject(input)) return false;
  const expectedTargetRequestId = String(input.expectedTargetRequestId || '');
  const statusTerminal = input.statusTerminal;
  const targetTerminal = input.targetTerminal;
  if (!expectedTargetRequestId
    || !isPlainObject(statusTerminal)
    || !isPlainObject(targetTerminal)) return false;

  const statusText = typeof statusTerminal.rawText === 'string' ? statusTerminal.rawText : '';
  const targetText = typeof targetTerminal.rawText === 'string' ? targetTerminal.rawText : '';
  const statusTextSha256 = String(statusTerminal.textSha256 || '');
  const targetTextSha256 = String(targetTerminal.textSha256 || '');
  return statusTerminal.finalized === true
    && statusTerminal.event === 'agent:response'
    && statusTerminal.reason === 'target_execution_status'
    && statusTerminal.controlIntent === 'status'
    && statusTerminal.targetRequestId === expectedTargetRequestId
    && targetTerminal.requestId === expectedTargetRequestId
    && targetTerminal.finalized === true
    && targetTerminal.event === 'agent:response'
    && statusText.length > 0
    && statusText === targetText
    && SHA256_RE.test(statusTextSha256)
    && statusTextSha256 === targetTextSha256
    && statusTextSha256 === portableEvidenceSha256(statusText);
}

/**
 * Cancellation is an execution fact, not a substring match.  In particular,
 * baseline replies such as "找不到可停止的任务" contain the word "停止" but
 * prove that no cancellation happened.
 */
export function portableCancellationTerminalObserved(input) {
  if (!isPlainObject(input)) return false;
  const stopTerminal = input.stopTerminal;
  const targetTerminal = input.targetTerminal;
  if (!isPlainObject(stopTerminal) || !isPlainObject(targetTerminal)) return false;
  const stopReason = String(stopTerminal.reason || '').trim().toLowerCase();
  const targetReason = String(targetTerminal.reason || '').trim().toLowerCase();
  const targetStatus = String(targetTerminal.status || '').trim().toLowerCase();
  return stopTerminal.finalized === true
    && targetTerminal.finalized === true
    && ['cancelled_by_user', 'cancelled', 'canceled', 'stopped'].includes(stopReason)
    && (
      ['request_cancelled', 'cancelled', 'canceled', 'stopped'].includes(targetReason)
      || ['cancelled', 'canceled', 'stopped'].includes(targetStatus)
    );
}

/** Any unbound provider request after the stub is armed is a control leak. */
export function portableProviderPrecursorBoundedObserved(input) {
  if (!isPlainObject(input)) return false;
  const longClassifierCaptures = Array.isArray(input.longClassifierCaptures)
    ? input.longClassifierCaptures : [];
  const longAnswerCaptures = Array.isArray(input.longAnswerCaptures)
    ? input.longAnswerCaptures : [];
  const controlCaptures = Array.isArray(input.controlCaptures) ? input.controlCaptures : [];
  const armedUnboundCaptures = Array.isArray(input.armedUnboundCaptures)
    ? input.armedUnboundCaptures : [];
  const protocolViolations = Array.isArray(input.protocolViolations)
    ? input.protocolViolations : [];
  const longCapture = longAnswerCaptures[0];
  return longClassifierCaptures.length === 1
    && longAnswerCaptures.length === 1
    && controlCaptures.length === 0
    && armedUnboundCaptures.length === 0
    && protocolViolations.length === 0
    && Boolean(longClassifierCaptures[0]?.deliveredAt)
    && Boolean(longCapture?.abortedAt)
    && !longCapture?.deliveredAt
    && longCapture?.scheduledDelayMs === Number(input.longProviderDelayMs);
}

function phaseSelector(manifest, phaseId) {
  const phase = manifest.phases.find(item => item.phaseId === phaseId);
  if (!phase) fail('portable_paired_controller_phase_binding_missing', { phaseId });
  return {
    scenarioId: phase.scenarioId,
    phaseId: phase.phaseId,
    requestId: phase.requestId,
    phaseNonce: phase.phaseNonce,
  };
}

function preparedSide(role, values) {
  return {
    role,
    runId: values.runId,
    taskRegressionBuildIdentity: values.matrixBuildIdentity,
    dataRootIdentitySha256: values.sandbox.dataRootIdentity.sha256,
    userId: values.user.userId,
    conversationId: values.conversationId,
    phases: values.plan.phases.map(phase => ({
      scenarioId: phase.scenarioId,
      phaseId: phase.phaseId,
      requestId: values.phaseBindings[phase.phaseId].requestId,
      phaseNonce: values.phaseBindings[phase.phaseId].phaseNonce,
      turnOrdinal: phase.turnOrdinal,
      unmarkedUserTextSha256: phase.unmarkedUserTextSha256,
    })),
  };
}

function rolePhaseBindings(role, plan) {
  return Object.fromEntries(plan.phases.map(phase => {
    const phaseNonce = `phase_${role}_${phase.phaseId}_${crypto.randomBytes(12).toString('hex')}`;
    return [phase.phaseId, {
      requestId: `pp_${role}_${phase.phaseId}_${portablePhaseNonceRequestTag(phaseNonce)}`,
      phaseNonce,
    }];
  }));
}

async function runControlScenarioSide(context) {
  const { role, kit, session, stub, plan, conversationId, phaseBindings } = context;
  const preparedText = phaseId => {
    const phase = plan.phases.find(item => item.phaseId === phaseId);
    if (phase.requirements.providerWitness !== true) return plan.phaseInputs[phaseId];
    return kit.hooks.prepareUserTurn({
      role,
      selector: phaseSelector(kit.manifest, phaseId),
      turnOrdinal: phase.turnOrdinal,
      text: plan.phaseInputs[phaseId],
    }).text;
  };
  const longBinding = phaseBindings.long_start;
  const long = session.startTurn({
    requestId: longBinding.requestId,
    conversationId,
    text: preparedText('long_start'),
    timeoutMs: Math.max(plan.timeoutPolicy.turnMs, 25_000),
  });
  const longAckPromise = long.ackPromise;
  await stub.waitForDelayedPhase('long_start', plan.timeoutPolicy.providerMs);
  const stop = await session.runTurn({
    requestId: phaseBindings.stop.requestId,
    conversationId,
    text: preparedText('stop'),
    timeoutMs: plan.timeoutPolicy.turnMs,
  });
  const [longAck, longTerminal] = await Promise.all([longAckPromise, long.done()]);
  const status = await session.runTurn({
    requestId: phaseBindings.status_after_cancel.requestId,
    conversationId,
    text: preparedText('status_after_cancel'),
    timeoutMs: plan.timeoutPolicy.turnMs,
  });
  const repeat = await session.runTurn({
    requestId: phaseBindings.repeat_status.requestId,
    conversationId,
    text: preparedText('repeat_status'),
    timeoutMs: plan.timeoutPolicy.turnMs,
  });
  await new Promise(resolve => setTimeout(resolve, plan.timeoutPolicy.settleMs));
  const knownProvider = stub.requests.filter(item => item.auxiliary === false);
  const longCaptures = knownProvider.filter(item => item.phaseId === 'long_start');
  const controlCaptures = knownProvider.filter(item => item.phaseId !== 'long_start');
  const longClassifierCaptures = longCaptures.filter(item => item.providerStage === 'intent_classifier');
  const longAnswerCaptures = longCaptures.filter(item => item.providerStage === 'answer');
  const armedUnboundCaptures = stub.requests.filter(
    item => item.auxiliary === true && item.preArm !== true,
  );
  const longCapture = longAnswerCaptures[0] || null;
  const repeatSame = normalizedReply(repeat.terminal.rawText)
    === normalizedReply(status.terminal.rawText)
    && Boolean(normalizedReply(status.terminal.rawText));
  const cancellationVisible = portableCancellationTerminalObserved({
    stopTerminal: stop.terminal,
    targetTerminal: longTerminal,
  });
  const statusBound = portablePostCancelStatusBindingObserved({
    expectedTargetRequestId: longBinding.requestId,
    statusTerminal: status.terminal,
    targetTerminal: longTerminal,
  });
  const providerBounded = portableProviderPrecursorBoundedObserved({
    longClassifierCaptures,
    longAnswerCaptures,
    controlCaptures,
    armedUnboundCaptures,
    protocolViolations: stub.protocolViolations,
    longProviderDelayMs: plan.executionPolicy.longProviderDelayMs,
  });
  const behaviorChecks = [
    check('cancel_bypassed_busy_gate', cancellationVisible, [
      phaseBindings.stop.requestId,
      longBinding.requestId,
    ]),
    check('status_reflected_target_task_terminal', statusBound, [
      phaseBindings.status_after_cancel.requestId,
      status.terminal.targetRequestId,
      longTerminal.textSha256,
      status.terminal.textSha256,
    ]),
    check('repeat_used_last_assistant_answer', repeatSame, [
      phaseBindings.repeat_status.requestId,
      status.terminal.textSha256,
      repeat.terminal.textSha256,
    ]),
    check('provider_precursor_cancelled_without_control_model_calls', providerBounded, [
      longCapture?.rawPayloadSha256,
      longCapture?.bindingDigest,
      armedUnboundCaptures.length,
    ]),
  ];
  return {
    role,
    ack: {
      long: longAck,
      stop: stop.ack,
      status: status.ack,
      repeat: repeat.ack,
    },
    turns: {
      long_start: { requestId: longBinding.requestId, terminal: longTerminal },
      stop,
      status_after_cancel: status,
      repeat_status: repeat,
    },
    publicTurns: {
      long_start: publicTerminal({ requestId: longBinding.requestId, terminal: longTerminal }),
      stop: publicTerminal(stop),
      status_after_cancel: publicTerminal(status),
      repeat_status: publicTerminal(repeat),
    },
    behaviorChecks,
    behaviorPassed: behaviorChecks.every(item => item.observed),
    provider: {
      exactKnownPhaseCallCount: knownProvider.length,
      auxiliaryCallCount: stub.requests.filter(item => item.auxiliary === true).length,
      armedUnboundCallCount: armedUnboundCaptures.length,
      longStartCallCount: longCaptures.length,
      longStartClassifierCallCount: longClassifierCaptures.length,
      longStartAnswerCallCount: longAnswerCaptures.length,
      forbiddenControlCallCount: controlCaptures.length,
      protocolViolationCount: stub.protocolViolations.length,
      requests: cloneJson(stub.requests, 'portable_paired_controller_provider_projection_invalid'),
      protocolViolations: cloneJson(
        stub.protocolViolations,
        'portable_paired_controller_provider_projection_invalid',
      ),
    },
    sessionEvents: cloneJson(
      session.events,
      'portable_paired_controller_socket_projection_invalid',
    ),
  };
}

function summarizeStoreProbe(probe) {
  return {
    source: probe.source,
    selectionPolicy: probe.selectionPolicy,
    snapshotCount: probe.snapshots.length,
    snapshotsSha256: probe.snapshotsSha256,
    phases: probe.snapshots.map(snapshot => ({
      phaseId: snapshot.binding.phaseId,
      requestId: snapshot.binding.requestId,
      bindingDigest: snapshot.binding.bindingDigest,
      structurallyComplete: snapshot.structurallyComplete === true,
      structuralIssues: snapshot.structuralIssues,
      acceptedUserRowState: String(snapshot.observations?.acceptedUserRow?.state || ''),
      turnState: String(snapshot.observations?.turn?.state || ''),
      taskState: String(snapshot.observations?.task?.state || ''),
      receiptState: String(snapshot.observations?.receipts?.state || ''),
      routingState: String(snapshot.observations?.routing?.state || ''),
      pendingState: String(snapshot.observations?.pending?.state || ''),
    })),
  };
}

async function collectRoleEvidence(context) {
  const startedAt = Date.now();
  const probe = await probePortablePassiveStore({
    manifest: context.kit.manifest,
    dataRoot: context.sandbox.dataRoot,
    hmacKey: context.hmacKey,
    capturedAt: new Date().toISOString(),
  });
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > context.plan.timeoutPolicy.passiveStoreMs) {
    fail('portable_paired_controller_passive_store_timeout', {
      role: context.role,
      elapsedMs,
      maximumMs: context.plan.timeoutPolicy.passiveStoreMs,
    });
  }
  for (const snapshot of probe.snapshots) context.kit.collector.addStoreSnapshot(snapshot);
  const bundle = context.kit.collector.buildBundle();
  const filesystemAfter = capturePortableFilesystemFixture(context.sandbox.fixturePath);
  const filesystemWitness = createSignedPortableFilesystemWitness({
    role: context.role,
    runId: context.runId,
    fixturePlanSha256: context.plan.fixturePlanSha256,
    fixturePayloadSha256: context.plan.fixturePayloadSha256,
    logicalPath: context.plan.fixture.logicalPath,
    before: context.filesystemBefore,
    after: filesystemAfter,
  }, context.hmacKey);
  const socketWitness = createSignedPortableSocketWitness({
    role: context.role,
    runId: context.runId,
    events: context.sessionEvents,
  }, context.hmacKey);
  const storeSummary = summarizeStoreProbe(probe);
  const exactRequests = new Set(context.kit.manifest.phases.map(phase => phase.requestId));
  const observedRequests = new Set(storeSummary.phases.map(phase => phase.requestId));
  const exactRequestIds = [...exactRequests].sort();
  const observedRequestIds = [...observedRequests].sort();
  const longPhaseEvidence = bundle.phaseEvidence.find(
    phase => phase.selector?.phaseId === 'long_start',
  );
  const providerRecords = longPhaseEvidence?.providerCaptures || [];
  const terminalRequestIds = new Set(socketWitness.events
    .filter(event => ['agent:response', 'agent:error'].includes(event.event))
    .map(event => event.requestId)
    .filter(Boolean));
  const evidenceChecks = [
    check('signed_external_bundle_attested', verifyPortableEvidenceRecord(bundle, context.hmacKey)
      && providerRecords.length >= 2
      && providerRecords.every(record => verifyPortableEvidenceRecord(record, context.hmacKey)), [
      bundle.attestation?.digest,
    ]),
    check('passive_store_exact_phase_coverage', storeSummary.snapshotCount === context.plan.phases.length
      && exactJson(exactRequestIds, observedRequestIds)
      && probe.snapshots.every(snapshot => verifyPortableEvidenceRecord(snapshot, context.hmacKey)), [
      probe.snapshotsSha256,
    ]),
    check('filesystem_fixture_unchanged', filesystemWitness.unchanged === true
      && verifyPortableEvidenceRecord(filesystemWitness, context.hmacKey), [
      filesystemWitness.before?.contentSha256,
      filesystemWitness.after?.contentSha256,
    ]),
    check('socket_witness_attested', verifyPortableEvidenceRecord(socketWitness, context.hmacKey)
      && exactRequestIds.every(requestId => terminalRequestIds.has(requestId)), [
      socketWitness.attestation?.digest,
    ]),
  ];
  const productObservationChecks = [
    check('portable_store_structure_supported', storeSummary.phases.every(
      phase => phase.structurallyComplete,
    ), [probe.snapshotsSha256]),
    check('accepted_user_turn_bindings_observable', storeSummary.phases.every(
      phase => phase.acceptedUserRowState === 'present',
    ), storeSummary.phases.map(phase => phase.bindingDigest)),
    check('provider_store_join_complete', bundle.complete === true, [bundle.attestation?.digest]),
  ];
  return {
    bundle,
    probe,
    storeSummary,
    filesystemWitness,
    socketWitness,
    elapsedMs,
    evidenceChecks,
    productObservationChecks,
    evidenceComplete: evidenceChecks.every(item => item.observed),
  };
}

function collectorFiles() {
  const controllerPath = fileURLToPath(import.meta.url);
  const directory = path.dirname(controllerPath);
  return [
    { name: 'portable-paired-controller.mjs', path: controllerPath },
    { name: 'portable-paired-controller-runtime.mjs', path: portablePairedRuntimeModulePath() },
    { name: 'portable-paired-runner.mjs', path: path.join(directory, 'portable-paired-runner.mjs') },
    { name: 'portable-paired-barrier.mjs', path: path.join(directory, 'portable-paired-barrier.mjs') },
    { name: 'portable-passive-store-probe.mjs', path: path.join(directory, 'portable-passive-store-probe.mjs') },
    { name: 'portable-external-evidence.mjs', path: path.join(directory, 'portable-external-evidence.mjs') },
    { name: 'task-regression-build-identity.mjs', path: path.join(directory, 'task-regression-build-identity.mjs') },
    { name: 'task-regression-truth-v2.mjs', path: path.join(directory, 'task-regression-truth-v2.mjs') },
  ];
}

export function portablePairedControllerCollectorBundleSha256() {
  return computePortableCollectorBundleSha256(collectorFiles());
}

function normalizeOptions(input) {
  const value = exactKeys(
    input,
    [
      'baselineWorktree', 'candidateWorktree', 'expectedBaselineRevision', 'tempBase',
      'runNonce', 'turnMs', 'providerMs', 'passiveStoreMs', 'settleMs',
      'startupMs', 'longProviderDelayMs',
    ],
    ['baselineWorktree', 'candidateWorktree'],
    'portable_paired_controller_options_invalid',
  );
  const runNonce = value.runNonce || crypto.randomBytes(18).toString('base64url');
  return {
    baselineWorktree: String(value.baselineWorktree || ''),
    candidateWorktree: String(value.candidateWorktree || ''),
    expectedBaselineRevision: String(
      value.expectedBaselineRevision || PORTABLE_PAIRED_CONTROLLER_BASELINE_REVISION,
    ).toLowerCase(),
    tempBase: value.tempBase ? String(value.tempBase) : undefined,
    planOptions: {
      runNonce,
      ...(value.turnMs === undefined ? {} : { turnMs: value.turnMs }),
      ...(value.providerMs === undefined ? {} : { providerMs: value.providerMs }),
      ...(value.passiveStoreMs === undefined ? {} : { passiveStoreMs: value.passiveStoreMs }),
      ...(value.settleMs === undefined ? {} : { settleMs: value.settleMs }),
      ...(value.startupMs === undefined ? {} : { startupMs: value.startupMs }),
      ...(value.longProviderDelayMs === undefined ? {} : { longProviderDelayMs: value.longProviderDelayMs }),
    },
  };
}

export async function runPortablePairedController(input) {
  const options = normalizeOptions(input);
  const plan = createPortablePairedControllerFrozenPlan(options.planOptions);
  if (plan.kind !== PORTABLE_PAIRED_CONTROLLER_PLAN_KIND
    || !SHA256_RE.test(plan.planSha256)) {
    fail('portable_paired_controller_plan_invalid');
  }
  const collectorBundleSha256 = portablePairedControllerCollectorBundleSha256();
  const controllerArtifactSha256 = portableEvidenceSha256(fs.readFileSync(fileURLToPath(import.meta.url)));
  const startedAt = new Date().toISOString();
  const targets = {
    baseline: inspectPortablePairedWorktree({
      role: 'baseline',
      worktree: options.baselineWorktree,
      expectedRevision: options.expectedBaselineRevision,
    }),
    candidate: inspectPortablePairedWorktree({
      role: 'candidate',
      worktree: options.candidateWorktree,
    }),
  };
  if (targets.baseline.root === targets.candidate.root) {
    fail('portable_paired_controller_distinct_worktrees_required');
  }
  const sourceBefore = {
    baseline: computeTaskRegressionBuildIdentity(targets.baseline.root),
    candidate: computeTaskRegressionBuildIdentity(targets.candidate.root),
  };
  if (sourceBefore.baseline.candidate.dirty !== false) {
    fail('portable_paired_controller_clean_baseline_required');
  }
  const matrixBuildIdentities = Object.fromEntries(ROLES.map(role => [role,
    projectTaskRegressionMatrixBuildIdentity(sourceBefore[role], {
      runtimeArtifactPath: targets[role].entry,
      runtimeArtifactSha256: targets[role].entrySha256,
      collectedAt: new Date().toISOString(),
    }),
  ]));
  const hmacKeys = {
    baseline: crypto.randomBytes(32),
    candidate: crypto.randomBytes(32),
  };
  if (portableEvidenceHmacKeyId(hmacKeys.baseline) === portableEvidenceHmacKeyId(hmacKeys.candidate)) {
    fail('portable_paired_controller_distinct_hmac_keys_required');
  }
  let sandbox = null;
  const stubs = { baseline: null, candidate: null };
  const runtimes = { baseline: null, candidate: null };
  const sessions = { baseline: null, candidate: null };
  const cleanup = {
    baselineBackendStopped: false,
    candidateBackendStopped: false,
    baselineProviderStopped: false,
    candidateProviderStopped: false,
    sandboxRemoved: false,
  };
  let reportCore = null;
  let thrown = null;
  try {
    sandbox = createPortablePairedSandbox({ tempBase: options.tempBase, plan });
    const filesystemBefore = {
      baseline: capturePortableFilesystemFixture(sandbox.sides.baseline.fixturePath),
      candidate: capturePortableFilesystemFixture(sandbox.sides.candidate.fixturePath),
    };
    if (filesystemBefore.baseline.contentSha256 !== plan.fixture.contentSha256
      || filesystemBefore.candidate.contentSha256 !== plan.fixture.contentSha256) {
      fail('portable_paired_controller_fixture_seed_mismatch');
    }
    [stubs.baseline, stubs.candidate] = await Promise.all(ROLES.map(role => (
      startPortablePairedProviderStub({ role })
    )));
    const backendPorts = await Promise.all(ROLES.map(() => reservePortableLoopbackPort()));
    const allPorts = [stubs.baseline.port, stubs.candidate.port, ...backendPorts];
    if (new Set(allPorts).size !== allPorts.length) {
      fail('portable_paired_controller_distinct_ports_required');
    }
    [runtimes.baseline, runtimes.candidate] = await Promise.all(ROLES.map((role, index) => (
      startPortablePairedBackend({
        role,
        target: targets[role],
        sandbox: sandbox.sides[role],
        providerBaseUrl: stubs[role].baseUrl,
        port: backendPorts[index],
        startupMs: plan.executionPolicy.startupMs,
      })
    )));
    const users = Object.fromEntries(await Promise.all(ROLES.map(async role => [
      role,
      await registerPortablePairedUser(runtimes[role], role),
    ])));
    const preferences = Object.fromEntries(await Promise.all(ROLES.map(async role => [
      role,
      await configurePortablePairedModel(runtimes[role], users[role].token),
    ])));
    const conversations = Object.fromEntries(await Promise.all(ROLES.map(async role => [
      role,
      await createPortablePairedConversation(runtimes[role], users[role].token),
    ])));
    const runIds = {
      baseline: `portable_paired_baseline_${crypto.randomBytes(10).toString('hex')}`,
      candidate: `portable_paired_candidate_${crypto.randomBytes(10).toString('hex')}`,
    };
    const phaseBindings = {
      baseline: rolePhaseBindings('baseline', plan),
      candidate: rolePhaseBindings('candidate', plan),
    };
    const barrier = createPortablePairedPreparedBarrier({
      parity: {
        profileSha256: plan.profileSha256,
        collectorBundleSha256,
        timeoutPolicy: plan.timeoutPolicy,
        platform: process.platform,
        nodeMajor: Number.parseInt(process.versions.node.split('.')[0], 10),
      },
      fixture: { phases: plan.phases },
      hmacKeys,
      timeoutMs: Math.min(plan.executionPolicy.startupMs, 120_000),
    });
    const prepared = Object.fromEntries(ROLES.map(role => [role, preparedSide(role, {
      runId: runIds[role],
      matrixBuildIdentity: matrixBuildIdentities[role],
      sandbox: sandbox.sides[role],
      user: users[role],
      conversationId: conversations[role],
      phaseBindings: phaseBindings[role],
      plan,
    })]));
    const [baselineKit, candidateKit] = await Promise.all([
      barrier.prepare(prepared.baseline),
      barrier.prepare(prepared.candidate),
    ]);
    const kits = { baseline: baselineKit, candidate: candidateKit };
    if (baselineKit.pairedPlan !== candidateKit.pairedPlan
      || baselineKit.summary.paritySha256 !== candidateKit.summary.paritySha256
      || baselineKit.summary.coverageSha256 !== plan.coverageSha256
      || baselineKit.manifest.fixturePlanSha256 !== plan.fixturePlanSha256
      || candidateKit.manifest.fixturePlanSha256 !== plan.fixturePlanSha256) {
      fail('portable_paired_controller_barrier_plan_mismatch');
    }
    for (const role of ROLES) stubs[role].arm({ kit: kits[role], plan });
    for (const role of ROLES) {
      sessions[role] = await createPortablePairedSocketSession({
        runtime: runtimes[role],
        token: users[role].token,
        turnMs: plan.timeoutPolicy.turnMs,
      });
    }
    const scenarioRuns = {};
    for (const role of ROLES) {
      scenarioRuns[role] = await runControlScenarioSide({
        role,
        kit: kits[role],
        session: sessions[role],
        stub: stubs[role],
        plan,
        conversationId: conversations[role],
        phaseBindings: phaseBindings[role],
      });
      sessions[role].close();
      sessions[role] = null;
    }
    cleanup.baselineBackendStopped = await stopPortablePairedBackend(runtimes.baseline);
    cleanup.candidateBackendStopped = await stopPortablePairedBackend(runtimes.candidate);
    await stubs.baseline.close();
    cleanup.baselineProviderStopped = true;
    await stubs.candidate.close();
    cleanup.candidateProviderStopped = true;
    const evidence = {};
    for (const role of ROLES) {
      evidence[role] = await collectRoleEvidence({
        role,
        kit: kits[role],
        hmacKey: hmacKeys[role],
        sandbox: sandbox.sides[role],
        plan,
        runId: runIds[role],
        filesystemBefore: filesystemBefore[role],
        sessionEvents: scenarioRuns[role].sessionEvents,
      });
    }
    const sourceAfter = {
      baseline: computeTaskRegressionBuildIdentity(targets.baseline.root),
      candidate: computeTaskRegressionBuildIdentity(targets.candidate.root),
    };
    const targetAfter = {
      baseline: inspectPortablePairedWorktree({
        role: 'baseline', worktree: targets.baseline.root,
        expectedRevision: options.expectedBaselineRevision,
      }),
      candidate: inspectPortablePairedWorktree({
        role: 'candidate', worktree: targets.candidate.root,
      }),
    };
    const sourceStability = Object.fromEntries(ROLES.map(role => [role, {
      stable: sourceIdentityStable(sourceBefore[role], sourceAfter[role])
        && targets[role].entrySha256 === targetAfter[role].entrySha256,
      sourceFingerprintSha256: sourceBefore[role].sourceFingerprint,
      endingSourceFingerprintSha256: sourceAfter[role].sourceFingerprint,
      runtimeFingerprintSha256: targets[role].entrySha256,
      endingRuntimeFingerprintSha256: targetAfter[role].entrySha256,
      revision: targets[role].revision,
      endingRevision: targetAfter[role].revision,
      clean: targetAfter[role].clean,
    }]));
    const sides = Object.fromEntries(ROLES.map(role => {
      const sideEvidenceChecks = [
        ...scenarioRuns[role].behaviorChecks,
        ...evidence[role].evidenceChecks,
        ...evidence[role].productObservationChecks,
        check('source_identity_stable', sourceStability[role].stable, [
          sourceStability[role].sourceFingerprintSha256,
          sourceStability[role].endingSourceFingerprintSha256,
        ]),
      ];
      return [role, {
        role,
        runId: runIds[role],
        buildIdentity: kits[role].portableBuildIdentity,
        signedManifest: kits[role].signedManifest,
        dataRootIdentitySha256: sandbox.sides[role].dataRootIdentity.sha256,
        processIdentity: runtimes[role].processIdentity,
        launchIsolation: runtimes[role].launchIsolation,
        modelPreference: preferences[role],
        sourceStability: sourceStability[role],
        turns: scenarioRuns[role].publicTurns,
        provider: scenarioRuns[role].provider,
        passiveStore: evidence[role].storeSummary,
        externalEvidenceBundle: evidence[role].bundle,
        filesystemWitness: evidence[role].filesystemWitness,
        socketWitness: evidence[role].socketWitness,
        checks: sideEvidenceChecks,
        behaviorPassed: scenarioRuns[role].behaviorPassed,
        evidenceComplete: evidence[role].evidenceComplete && sourceStability[role].stable,
      }];
    }));
    const sandboxLaunchBoundaryObserved = ROLES.every(role => (
      runtimes[role].launchIsolation?.sandboxCwd === true
      && runtimes[role].launchIsolation?.worktreeCwdUsed === false
      && runtimes[role].launchIsolation?.ownedEmptyDotenv === true
    ));
    const parityChecks = [
      check('same_frozen_plan', kits.baseline.summary.paritySha256 === kits.candidate.summary.paritySha256
        && kits.baseline.summary.coverageSha256 === kits.candidate.summary.coverageSha256
        && plan.planSha256.length === 64, [plan.planSha256]),
      check('same_profile_fixture_timeout_coverage_digests', [
        'profileSha256', 'fixturePlanSha256', 'timeoutPolicySha256', 'coverageSha256',
      ].every(field => (
        field === 'timeoutPolicySha256'
          ? portableEvidenceSha256(kits.baseline.manifest.timeoutPolicy) === plan[field]
            && portableEvidenceSha256(kits.candidate.manifest.timeoutPolicy) === plan[field]
          : field === 'coverageSha256'
            ? kits.baseline.summary.coverageSha256 === plan[field]
              && kits.candidate.summary.coverageSha256 === plan[field]
            : kits.baseline.manifest[field] === plan[field]
              && kits.candidate.manifest[field] === plan[field]
      )), [
        plan.profileSha256,
        plan.fixturePlanSha256,
        plan.timeoutPolicySha256,
        plan.coverageSha256,
      ]),
      check('distinct_worktrees_data_roots_ports_processes',
        targets.baseline.root !== targets.candidate.root
        && sandbox.sides.baseline.dataRootIdentity.sha256 !== sandbox.sides.candidate.dataRootIdentity.sha256
        && runtimes.baseline.port !== runtimes.candidate.port
        && stubs.baseline.port !== stubs.candidate.port
        && runtimes.baseline.processIdentity.pid !== runtimes.candidate.processIdentity.pid, [
        runtimes.baseline.processIdentity.identitySha256,
        runtimes.candidate.processIdentity.identitySha256,
      ]),
      check('clean_28c_baseline_preserved',
        sourceStability.baseline.stable
        && sourceStability.baseline.clean
        && sourceStability.baseline.revision === options.expectedBaselineRevision, [
        sourceStability.baseline.revision,
      ]),
      check('sandbox_cwd_and_owned_empty_dotenv', sandboxLaunchBoundaryObserved, ROLES.flatMap(role => [
        runtimes[role].launchIsolation?.cwdSha256,
        runtimes[role].launchIsolation?.dotenvConfigPathSha256,
      ])),
    ];
    const nonFormalEvidenceComplete = parityChecks.every(item => item.observed)
      && sides.baseline.evidenceComplete
      && sides.candidate.evidenceComplete;
    const formalRuntimeBoundary = {
      observationScope: 'launch_environment_configuration_only',
      formalClientAccess: 'not_observed',
      formalDataAccess: 'not_observed',
      osLevelAccessEnforcement: 'not_proven',
      launchBoundaryObserved: sandboxLaunchBoundaryObserved,
      evidenceEligible: false,
    };
    reportCore = {
      kind: PORTABLE_PAIRED_CONTROLLER_REPORT_KIND,
      schemaVersion: PORTABLE_PAIRED_CONTROLLER_REPORT_SCHEMA_VERSION,
      startedAt,
      completedAt: new Date().toISOString(),
      scenarioId: PORTABLE_PAIRED_CONTROLLER_SCENARIO_ID,
      executionBoundary: 'ordinary_production_http_and_socket_protocols_only',
      forbiddenCandidateEvidenceEndpointsUsed: false,
      // The controller proves its launch/environment configuration, but it
      // does not have an OS access monitor. Do not turn absence of an observed
      // access into a claim that no access occurred.
      formalClientStartedOrTouched: 'not_observed',
      formalDataReadOrWritten: 'not_observed',
      formalRuntimeBoundaryProof: 'not_proven',
      formalRuntimeBoundary,
      controllerArtifactSha256,
      collectorBundleSha256,
      plan: corePlanProjection(plan),
      pairedPlan: kits.baseline.pairedPlan,
      barrier: barrier.summary(),
      parityChecks,
      sides,
      behaviorComparison: {
        baselinePassed: sides.baseline.behaviorPassed,
        candidatePassed: sides.candidate.behaviorPassed,
        sameOutcome: sides.baseline.behaviorPassed === sides.candidate.behaviorPassed,
      },
      nonFormalEvidenceComplete,
      evidenceComplete: nonFormalEvidenceComplete && formalRuntimeBoundary.evidenceEligible,
      behaviorPassed: sides.baseline.behaviorPassed && sides.candidate.behaviorPassed,
      truthV2Projection: {
        status: 'one_complete_profile_collected_adapter_full_eight_scenario_projection_pending',
        scenarioCoverageComplete: true,
        fullEightScenarioCoverageComplete: false,
      },
    };
  } catch (error) {
    thrown = error;
  } finally {
    for (const role of ROLES) {
      try { sessions[role]?.close(); } catch {}
    }
    for (const role of ROLES) {
      if (!cleanup[`${role}BackendStopped`]) {
        try { cleanup[`${role}BackendStopped`] = await stopPortablePairedBackend(runtimes[role]); } catch {}
      }
      if (!cleanup[`${role}ProviderStopped`] && stubs[role]) {
        try {
          await stubs[role].close();
          cleanup[`${role}ProviderStopped`] = true;
        } catch {}
      }
    }
    if (sandbox) {
      try { cleanup.sandboxRemoved = removePortablePairedSandbox(sandbox); } catch {}
    }
  }
  if (thrown) {
    const error = thrown instanceof PortablePairedControllerError
      || thrown instanceof PortablePairedControllerRuntimeError
      ? thrown
      : new PortablePairedControllerError('portable_paired_controller_unexpected_failure', {}, thrown);
    error.details = { ...(error.details || {}), cleanup };
    throw error;
  }
  const cleanupComplete = Object.values(cleanup).every(value => value === true);
  const complete = reportCore.evidenceComplete
    && reportCore.behaviorPassed
    && cleanupComplete;
  const finalCore = {
    ...reportCore,
    cleanup,
    complete,
  };
  return {
    ...finalCore,
    reportSha256: portableEvidenceSha256(finalCore),
  };
}

function corePlanProjection(plan) {
  return Object.fromEntries(Object.entries(plan));
}

/** Validate a diagnostic report without treating it as acceptance evidence. */
export function validatePortablePairedControllerReportStructure(report) {
  const issues = [];
  if (!isPlainObject(report)
    || report.kind !== PORTABLE_PAIRED_CONTROLLER_REPORT_KIND
    || report.schemaVersion !== PORTABLE_PAIRED_CONTROLLER_REPORT_SCHEMA_VERSION) {
    return { ok: false, issues: ['report_header_invalid'] };
  }
  const { reportSha256, ...core } = report;
  if (!SHA256_RE.test(String(reportSha256 || ''))
    || reportSha256 !== portableEvidenceSha256(core)) issues.push('report_digest_invalid');
  const formalBoundary = report.formalRuntimeBoundary;
  if (report.formalClientStartedOrTouched !== 'not_observed'
    || report.formalDataReadOrWritten !== 'not_observed'
    || report.formalRuntimeBoundaryProof !== 'not_proven'
    || !isPlainObject(formalBoundary)
    || formalBoundary.observationScope !== 'launch_environment_configuration_only'
    || formalBoundary.formalClientAccess !== 'not_observed'
    || formalBoundary.formalDataAccess !== 'not_observed'
    || formalBoundary.osLevelAccessEnforcement !== 'not_proven'
    || typeof formalBoundary.launchBoundaryObserved !== 'boolean'
    || formalBoundary.evidenceEligible !== false) {
    issues.push('formal_runtime_observation_invalid');
  }
  return { ok: issues.length === 0, issues };
}

/** Fail-closed acceptance validation; diagnostic structure alone is not proof. */
export function validatePortablePairedControllerReport(report) {
  const structural = validatePortablePairedControllerReportStructure(report);
  if (!isPlainObject(report)) return structural;
  const issues = [...structural.issues];
  if (report.forbiddenCandidateEvidenceEndpointsUsed !== false) {
    issues.push('candidate_evidence_endpoint_boundary_invalid');
  }
  if (report.formalRuntimeBoundaryProof !== 'proven'
    || report.formalRuntimeBoundary?.evidenceEligible !== true) {
    issues.push('formal_runtime_boundary_unproven');
  }
  if (!report.cleanup || !Object.values(report.cleanup).every(value => value === true)) {
    issues.push('cleanup_incomplete');
  }
  if (report.behaviorPassed !== true) issues.push('behavior_not_passed');
  if (report.complete !== true || report.evidenceComplete !== true) issues.push('evidence_incomplete');
  const uniqueIssues = [...new Set(issues)];
  return { ok: uniqueIssues.length === 0, issues: uniqueIssues };
}

export function portablePairedControllerModulePath() {
  return fileURLToPath(import.meta.url);
}
