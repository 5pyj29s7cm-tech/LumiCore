import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFormalLocationBindings,
  buildSanitizedRestartEvidence,
  classifyRestartScope,
  isValidFormalNativeClientEvidence,
  normalizeFormalNativeClientEvidence,
  parseRestartRecoveryArgs,
  removeOwnedRestartCheckpoint,
  restartEvidenceCliExitCode,
  restartEvidencePath,
  selectRestartNativeClientEvidence,
  sealRestartCheckpoint,
  validateRestartCheckpoint,
  validateRestartContinuationEvidence,
  validateRestartRecoveryEvidence,
  writeCheckpointExclusive,
  writeRestartEvidenceExclusive,
} from '../scripts/formal-client-restart-recovery.mjs';
import {
  buildOwnedArtifactLayout,
  evidenceTextHash,
  runtimeReceiptSignature,
} from '../scripts/formal-client-e2e.mjs';

const MARKER = 'LUMI-E2E-RESTART-0123456789abcdef';
const BUILD_ID = 'a'.repeat(40);
const DATA_ROOT = path.resolve(path.parse(process.cwd()).root, 'LumiE2ERestartData');
const WEBVIEW2_ROOT = path.join(DATA_ROOT, 'WebView2');
const WEBVIEW2_PROFILE = path.join(WEBVIEW2_ROOT, 'Default');
const EVIDENCE_ROOT = path.join(DATA_ROOT, 'formal-evidence');
const LOCATIONS = buildFormalLocationBindings({
  dataRoot: DATA_ROOT,
  webview2UserDataDir: WEBVIEW2_ROOT,
  webview2ProfileDir: WEBVIEW2_PROFILE,
});

type RestartScope = 'backend-only' | 'client-only' | 'both';

function normalizedPath(value: string) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

const evidenceHash = evidenceTextHash;

describe('formal restart producer exit contract', () => {
  it('does not label a successful phase as a complete producer package', () => {
    expect(restartEvidenceCliExitCode({
      ok: true,
      phaseComplete: true,
      packageComplete: false,
      phase: 'verify',
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
    })).toBe(1);
    expect(restartEvidenceCliExitCode({
      ok: true,
      packageComplete: true,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
    })).toBe(2);
  });
});

function nativeClientEvidence(
  pid: number,
  startAt: string,
  identityOverrides: Record<string, unknown> = {},
) {
  const buildId = String(identityOverrides.buildId || BUILD_ID);
  const identity = {
    schemaVersion: 1,
    clientKind: 'tauri',
    pid,
    startedAtUnixMs: Date.parse(startAt),
    executablePath: 'D:\\LumiCore\\LumiCore.exe',
    executableSha256: 'b'.repeat(64),
    binaryHashUnavailable: false,
    buildId,
    buildIdSemantics: 'baseline_commit',
    sourceFingerprint: 'c'.repeat(64),
    sourceDirty: false,
    appVersion: '1.2.3',
    trustLevel: 'proof_bound_local_claim',
    osAttested: false,
    webviewProfileTrustLevel: 'unbound',
    ...identityOverrides,
  };
  const selected = selectRestartNativeClientEvidence([{
    id: 'formal-tauri-device',
    type: 'desktop',
    status: 'online',
    socketId: `socket-${pid}`,
    nativeClientIdentity: identity,
  }], { pid, startedAt: startAt, buildId });
  if (!selected.ok) throw new Error(`invalid native client fixture: ${selected.code}`);
  return normalizeFormalNativeClientEvidence(selected.evidence);
}

function fixture(scope: RestartScope = 'both') {
  const layout = buildOwnedArtifactLayout(DATA_ROOT, MARKER);
  const task = {
    taskId: 'task-restart-1',
    conversationId: 'conversation-restart-1',
    goal: `${MARKER} formal restart recovery`,
    target: layout.files[0],
    revision: 3,
    status: 'waiting_confirmation',
    activeRequest: false,
    evidence: {
      latest: [{
        receiptId: 'receipt-pending-1',
        requestId: 'request-prepare-1',
        toolName: 'write_file',
        targetIdentity: layout.files[0],
        outcome: 'waiting_confirmation',
        verification: 'unverified',
      }],
    },
  };
  const previousBackend = {
    pid: 100,
    startAt: '2026-08-27T04:00:00.000Z',
    buildId: BUILD_ID,
  };
  const previousNativeClient = nativeClientEvidence(300, '2026-08-27T03:59:00.000Z');
  const currentBackend = scope === 'client-only'
    ? previousBackend
    : { ...previousBackend, pid: 200, startAt: '2026-08-27T04:02:00.000Z' };
  const currentNativeClient = scope === 'backend-only'
    ? previousNativeClient
    : nativeClientEvidence(400, '2026-08-27T04:03:00.000Z');
  const content = `${MARKER}:pending-across-restart`;
  const checkpoint = sealRestartCheckpoint({
    schemaVersion: 4,
    marker: MARKER,
    conversationId: 'conversation-restart-1',
    taskId: task.taskId,
    requestId: 'request-prepare-1',
    targetRelativePath: path.relative(DATA_ROOT, layout.files[0]),
    contentSha256: evidenceHash(content),
    expectedRestart: scope,
    backend: previousBackend,
    nativeClient: previousNativeClient,
    locations: LOCATIONS,
    receiptSignature: runtimeReceiptSignature(task),
    taskRevision: task.revision,
    taskTargetSha256: evidenceHash(normalizedPath(layout.files[0])),
    preparedAt: '2026-08-27T04:01:00.000Z',
  });
  const messages = [
    {
      id: 'message-user-prepare',
      role: 'user',
      requestId: checkpoint.requestId,
      message: `[${MARKER}] Create the confirmation-gated file ${layout.files[0]} with ${content}.`,
    },
    {
      id: 'message-assistant-prepare',
      role: 'assistant',
      requestId: checkpoint.requestId,
      message: 'The action is waiting for confirmation.',
    },
  ];
  const health = {
    runtime: {
      buildId: currentBackend.buildId,
      pid: currentBackend.pid,
      startedAt: currentBackend.startAt,
    },
  };
  return {
    checkpoint,
    currentBackend,
    currentNativeClient,
    health,
    layout,
    messages,
    previousBackend,
    previousNativeClient,
    task,
  };
}

function locationContext() {
  return {
    dataRoot: DATA_ROOT,
    webview2UserDataDir: WEBVIEW2_ROOT,
    webview2ProfileDir: WEBVIEW2_PROFILE,
  };
}

function cliArgs(overrides: string[] = []) {
  return [
    'prepare',
    '--confirm-live-e2e',
    '--data-root', DATA_ROOT,
    '--restart-scope', 'both',
    '--client-pid', '300',
    '--client-start-at', '2026-08-27T03:59:00.000Z',
    '--client-build-id', BUILD_ID,
    '--webview2-user-data-dir', WEBVIEW2_ROOT,
    '--webview2-profile-dir', WEBVIEW2_PROFILE,
    '--evidence-root', EVIDENCE_ROOT,
    ...overrides,
  ];
}

describe('formal restart-recovery E2E protocol', () => {
  it('accepts only a bounded credential-free checkpoint bound to formal locations', () => {
    const { checkpoint, layout } = fixture();
    const validation = validateRestartCheckpoint({
      ...checkpoint,
      token: 'must-not-survive',
      cookie: 'must-not-survive',
      desktopSessionProof: 'must-not-survive',
      payload: 'must-not-survive',
    }, locationContext());
    expect(validation.ok).toBe(true);
    expect(validation.layout?.root).toBe(layout.root);
    expect(validation.targetPath).toBe(layout.files[0]);
    expect(validation.checkpoint.nativeClient).toMatchObject({
      clientKind: 'tauri',
      deviceId: 'formal-tauri-device',
      executableSha256: 'b'.repeat(64),
      sourceFingerprint: 'c'.repeat(64),
      sourceDirty: false,
      identitySource: 'authenticated_devices_registry_proof_bound_tauri',
      identityVerified: true,
      osAttested: false,
      webviewProfileTrustLevel: 'unbound',
      webviewProfileBound: false,
      formalAcceptanceEligible: false,
    });
    expect(Object.keys(validation.checkpoint)).not.toEqual(expect.arrayContaining([
      'token',
      'cookie',
      'desktopSessionProof',
      'payload',
      'toolResult',
      'targetPath',
    ]));
    expect(validateRestartCheckpoint({
      ...checkpoint,
      targetRelativePath: '../outside.txt',
    }, locationContext()).ok).toBe(false);
    expect(validateRestartCheckpoint({
      ...checkpoint,
      nativeClient: {
        pid: checkpoint.nativeClient.pid,
        startAt: checkpoint.nativeClient.startAt,
        buildId: checkpoint.nativeClient.buildId,
      },
    }, locationContext()).ok).toBe(false);
    expect(validateRestartCheckpoint(checkpoint, {
      ...locationContext(),
      dataRoot: `${DATA_ROOT}-wrong`,
    }).ok).toBe(false);
    expect(validateRestartCheckpoint(checkpoint, {
      ...locationContext(),
      webview2ProfileDir: path.join(WEBVIEW2_ROOT, 'Profile 2'),
    }).ok).toBe(false);
  });

  it.each<RestartScope>(['backend-only', 'client-only', 'both'])(
    'distinguishes and verifies an exact %s restart',
    (scope) => {
      const { checkpoint, currentNativeClient, health, layout, messages, task } = fixture(scope);
      expect(validateRestartRecoveryEvidence({
        checkpoint,
        health,
        nativeClient: currentNativeClient,
        locationBindings: LOCATIONS,
        task,
        messages,
        targetPath: layout.files[0],
      })).toMatchObject({
        ok: true,
        evidence: {
          restartScope: scope,
          previousBackend: { buildId: BUILD_ID },
          recoveredBackend: { buildId: BUILD_ID },
          previousNativeClient: {
            clientKind: 'tauri',
            deviceId: 'formal-tauri-device',
            buildId: BUILD_ID,
            identitySource: 'authenticated_devices_registry_proof_bound_tauri',
            identityVerified: true,
            osAttested: false,
            webviewProfileTrustLevel: 'unbound',
            webviewProfileBound: false,
          },
          recoveredNativeClient: {
            clientKind: 'tauri',
            deviceId: 'formal-tauri-device',
            buildId: BUILD_ID,
            identitySource: 'authenticated_devices_registry_proof_bound_tauri',
            identityVerified: true,
            osAttested: false,
            webviewProfileTrustLevel: 'unbound',
            webviewProfileBound: false,
          },
          turn: {
            taskId: 'task-restart-1',
            userMessageId: 'message-user-prepare',
            assistantMessageId: 'message-assistant-prepare',
            receiptIds: ['receipt-pending-1'],
          },
        },
      });
    },
  );

  it('fails closed when no restart, the wrong component, a build, or a location changes', () => {
    const { checkpoint, layout, previousBackend, previousNativeClient, messages, task } = fixture('both');
    const unchangedHealth = {
      runtime: {
        ...previousBackend,
        startedAt: previousBackend.startAt,
      },
    };
    expect(validateRestartRecoveryEvidence({
      checkpoint,
      health: unchangedHealth,
      nativeClient: previousNativeClient,
      locationBindings: LOCATIONS,
      task,
      messages,
      targetPath: layout.files[0],
    })).toMatchObject({ ok: false, code: 'restart_not_observed', observedRestart: 'none' });
    expect(validateRestartRecoveryEvidence({
      checkpoint,
      health: {
        runtime: { ...previousBackend, pid: 201, startedAt: '2026-08-27T04:05:00.000Z' },
      },
      nativeClient: previousNativeClient,
      locationBindings: LOCATIONS,
      task,
      messages,
      targetPath: layout.files[0],
    })).toMatchObject({ ok: false, code: 'restart_scope_mismatch', observedRestart: 'backend-only' });
    expect(validateRestartRecoveryEvidence({
      checkpoint,
      health: unchangedHealth,
      nativeClient: nativeClientEvidence(
        previousNativeClient.pid,
        previousNativeClient.startAt,
        { buildId: 'd'.repeat(40) },
      ),
      locationBindings: LOCATIONS,
      task,
      messages,
      targetPath: layout.files[0],
    })).toEqual({ ok: false, code: 'restart_native_client_build_mismatch' });
    expect(validateRestartRecoveryEvidence({
      checkpoint,
      health: unchangedHealth,
      nativeClient: previousNativeClient,
      locationBindings: { ...LOCATIONS, dataRootSha256: 'd'.repeat(64) },
      task,
      messages,
      targetPath: layout.files[0],
    })).toEqual({ ok: false, code: 'restart_formal_location_mismatch' });
    expect(validateRestartRecoveryEvidence({
      checkpoint,
      health: unchangedHealth,
      nativeClient: { ...previousNativeClient, deviceId: 'different-tauri-device' },
      locationBindings: LOCATIONS,
      task,
      messages,
      targetPath: layout.files[0],
    })).toMatchObject({ ok: false, code: 'restart_not_observed', observedRestart: 'none' });
    expect(validateRestartRecoveryEvidence({
      checkpoint,
      health: unchangedHealth,
      nativeClient: nativeClientEvidence(
        previousNativeClient.pid,
        previousNativeClient.startAt,
        { executableSha256: 'e'.repeat(64) },
      ),
      locationBindings: LOCATIONS,
      task,
      messages,
      targetPath: layout.files[0],
    })).toEqual({ ok: false, code: 'restart_native_client_binary_identity_changed' });
  });

  it('requires absolute scoped paths and rejects checkpoint/profile escape', () => {
    const parsed = parseRestartRecoveryArgs(cliArgs());
    expect(parsed.restartScope).toBe('both');
    expect(parsed.nativeClientExpectation).toMatchObject({ pid: 300, buildId: BUILD_ID });
    expect(parsed.nativeClient).toBeUndefined();
    expect(parsed.checkpoint).toBe(path.join(EVIDENCE_ROOT, 'formal-client-e2e-restart-checkpoint.json'));
    expect(() => parseRestartRecoveryArgs(cliArgs([
      '--checkpoint', path.join(DATA_ROOT, 'outside-evidence.json'),
    ]))).toThrowError('restart_checkpoint_outside_evidence_root');
    expect(() => parseRestartRecoveryArgs(cliArgs([
      '--webview2-profile-dir', path.join(DATA_ROOT, 'wrong-profile'),
    ]))).toThrowError('webview2_profile_outside_user_data_dir');
    expect(() => parseRestartRecoveryArgs(cliArgs([
      '--evidence-root', 'relative-evidence',
    ]))).toThrowError('absolute_evidence_root_required');
  });

  it('offers exact-owned cleanup only in verify mode and never re-activates the diagnostic conversation', () => {
    const verifyArgs = cliArgs();
    verifyArgs[0] = 'verify';
    verifyArgs.push('--cleanup-owned-after-verify');
    expect(parseRestartRecoveryArgs(verifyArgs).cleanupOwnedAfterVerify).toBe(true);
    expect(() => parseRestartRecoveryArgs(cliArgs(['--cleanup-owned-after-verify'])))
      .toThrowError('restart_cleanup_requires_verify');

    const source = fs.readFileSync(path.resolve('scripts/formal-client-restart-recovery.mjs'), 'utf8');
    expect(source).toContain("activation: 'isolated'");
    expect(source).not.toMatch(/conversations\/\$\{encodeURIComponent\(checkpoint\.conversationId\)\}\/activate/u);
    expect(source).toContain('explicit_exact_owned_cleanup_completed');
  });

  it('rejects CLI-only or harness identities as restart evidence', () => {
    expect(isValidFormalNativeClientEvidence({
      pid: 300,
      startAt: '2026-08-27T03:59:00.000Z',
      buildId: BUILD_ID,
    })).toBe(false);
    const valid = nativeClientEvidence(300, '2026-08-27T03:59:00.000Z');
    expect(isValidFormalNativeClientEvidence(valid)).toBe(true);
    const posixValid = nativeClientEvidence(300, '2026-08-27T03:59:00.000Z', {
      executablePath: '/Applications/LumiCore.app/Contents/MacOS/lumi-core',
    });
    expect(isValidFormalNativeClientEvidence(posixValid)).toBe(true);
    expect(isValidFormalNativeClientEvidence({
      ...valid,
      executablePath: 'relative/lumi-core',
    })).toBe(false);
    expect(isValidFormalNativeClientEvidence({
      ...valid,
      clientKind: 'local_acceptance_harness',
    })).toBe(false);
    expect(isValidFormalNativeClientEvidence({
      ...valid,
      executableSha256: '',
      binaryHashUnavailable: true,
    })).toBe(false);
  });

  it('accepts restart recovery only after the exact pending action completes once on the same task', () => {
    const { checkpoint, layout, messages, task } = fixture('both');
    const confirmationRequestId = 'request-confirm-after-restart';
    const afterTask = {
      ...task,
      revision: task.revision + 1,
      status: 'completed',
      evidence: {
        latest: [
          ...task.evidence.latest,
          {
            receiptId: 'receipt-completed-after-restart',
            taskId: task.taskId,
            requestId: confirmationRequestId,
            toolName: 'write_file',
            targetIdentity: layout.files[0],
            outcome: 'verified_success',
            verification: 'verified',
          },
        ],
      },
    };
    const completionMessages = [
      ...messages,
      {
        id: 'message-user-confirm',
        role: 'user',
        requestId: confirmationRequestId,
        message: '确认',
      },
      {
        id: 'message-assistant-completed',
        role: 'assistant',
        requestId: confirmationRequestId,
        message: 'The exact pending action completed and the artifact was verified.',
      },
    ];
    const artifactContent = `${MARKER}:pending-across-restart`;
    expect(validateRestartContinuationEvidence({
      checkpoint,
      beforeTask: task,
      afterTask,
      messages: completionMessages,
      confirmationRequestId,
      targetPath: layout.files[0],
      artifactContent,
    })).toMatchObject({
      ok: true,
      evidence: {
        taskId: task.taskId,
        confirmationRequestId,
        receiptId: 'receipt-completed-after-restart',
        artifactSha256: checkpoint.contentSha256,
      },
    });
    expect(validateRestartContinuationEvidence({
      checkpoint,
      beforeTask: task,
      afterTask: { ...afterTask, status: 'cancelled' },
      messages: completionMessages,
      confirmationRequestId,
      targetPath: layout.files[0],
      artifactContent,
    })).toMatchObject({ ok: false, code: 'restart_continuation_not_completed' });
    expect(validateRestartContinuationEvidence({
      checkpoint,
      beforeTask: task,
      afterTask: { ...afterTask, target: layout.files[1] },
      messages: completionMessages,
      confirmationRequestId,
      targetPath: layout.files[0],
      artifactContent,
    })).toMatchObject({ ok: false, code: 'restart_continuation_target_changed' });
  });

  it('writes only a sanitized evidence projection to a fixed child path', () => {
    const { checkpoint } = fixture();
    const record = buildSanitizedRestartEvidence({
      ok: true,
      phase: 'prepare',
      runMarker: MARKER,
      expectedRestart: 'both',
      checkpointPath: path.join(DATA_ROOT, 'secret-checkpoint.json'),
      token: 'secret-token',
      cookie: 'secret-cookie',
      evidence: {
        taskId: checkpoint.taskId,
        requestId: checkpoint.requestId,
        backend: checkpoint.backend,
        nativeClient: checkpoint.nativeClient,
        locationBindings: checkpoint.locations,
        payload: 'secret-payload',
      },
    });
    const serialized = JSON.stringify(record);
    expect(record.restart).toEqual({ expected: 'both', observed: '' });
    expect(serialized).not.toContain(DATA_ROOT);
    expect(serialized).not.toMatch(/secret-(?:token|cookie|payload|checkpoint)/);
    const verifyRecord = buildSanitizedRestartEvidence({
      ok: true,
      phase: 'verify',
      runMarker: MARKER,
      expectedRestart: 'both',
      cookie: 'secret-cookie',
      evidence: {
        restartScope: 'both',
        previousBackend: checkpoint.backend,
        recoveredBackend: { ...checkpoint.backend, pid: 101 },
        previousNativeClient: checkpoint.nativeClient,
        recoveredNativeClient: nativeClientEvidence(301, '2026-08-27T04:03:00.000Z'),
        locationBindings: checkpoint.locations,
        turn: { taskId: checkpoint.taskId, requestId: checkpoint.requestId },
        statusQuery: { taskId: checkpoint.taskId, requestId: 'status-request' },
        continuation: {
          confirmationRequestId: 'confirm-request',
          artifactSha256: checkpoint.contentSha256,
          turn: { taskId: checkpoint.taskId, requestId: 'confirm-request' },
        },
        payload: 'secret-payload',
      },
      retention: {
        conversationRetained: true,
        checkpointRetained: true,
        ownedArtifactRetained: true,
        reason: 'formal_stage9_evidence_pending_unified_adjudication',
      },
    });
    expect(verifyRecord).toMatchObject({
      phase: 'verify',
      restart: { expected: 'both', observed: 'both' },
      identities: {
        previousBackend: { pid: 100 },
        recoveredBackend: { pid: 101 },
        previousNativeClient: {
          pid: 300,
          clientKind: 'tauri',
          deviceId: 'formal-tauri-device',
          executableSha256: 'b'.repeat(64),
          sourceFingerprint: 'c'.repeat(64),
          sourceDirty: false,
          identitySource: 'authenticated_devices_registry_proof_bound_tauri',
          osAttested: false,
          webviewProfileTrustLevel: 'unbound',
          webviewProfileBound: false,
        },
        recoveredNativeClient: {
          pid: 301,
          clientKind: 'tauri',
          deviceId: 'formal-tauri-device',
          executableSha256: 'b'.repeat(64),
          sourceFingerprint: 'c'.repeat(64),
          sourceDirty: false,
          identitySource: 'authenticated_devices_registry_proof_bound_tauri',
          osAttested: false,
          webviewProfileTrustLevel: 'unbound',
          webviewProfileBound: false,
        },
      },
      retention: {
        conversationRetained: true,
        checkpointRetained: true,
        ownedArtifactRetained: true,
      },
      profileBinding: {
        pathHashBound: true,
        identitySource: 'operator_path_binding_unverified',
        identityVerified: false,
        webviewProfileTrustLevel: 'unbound',
        webviewProfileBound: false,
      },
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      evidenceClassification: 'restricted_private_local',
      publishable: false,
    });
    expect(JSON.stringify(verifyRecord)).not.toMatch(/secret-(?:cookie|payload)/);
    expect(restartEvidencePath(EVIDENCE_ROOT, MARKER, 'prepare')).toBe(
      path.join(EVIDENCE_ROOT, `formal-client-restart-recovery-${MARKER}-prepare.json`),
    );
    expect(() => restartEvidencePath('relative-evidence', MARKER, 'prepare')).toThrowError(
      'absolute_evidence_root_required',
    );

    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-restart-evidence-'));
    try {
      const written = writeRestartEvidenceExclusive(temporaryRoot, {
        ok: true,
        phase: 'prepare',
        runMarker: MARKER,
        expectedRestart: 'both',
        token: 'must-not-be-written',
        evidence: {
          backend: checkpoint.backend,
          nativeClient: checkpoint.nativeClient,
          locationBindings: checkpoint.locations,
        },
      });
      const persisted = fs.readFileSync(written, 'utf8');
      expect(fs.realpathSync.native(path.dirname(written))).toBe(
        fs.realpathSync.native(temporaryRoot),
      );
      expect(persisted).not.toContain('must-not-be-written');
      expect(JSON.parse(persisted)).toMatchObject({
        kind: 'formal-client-restart-recovery',
        phase: 'prepare',
        restart: { expected: 'both' },
      });
      expect(() => writeRestartEvidenceExclusive(temporaryRoot, {
        ok: true,
        phase: 'prepare',
        runMarker: MARKER,
      })).toThrowError('restart_evidence_write_failed');
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('classifies backend and client process-instance changes independently', () => {
    const { previousBackend, previousNativeClient } = fixture();
    expect(classifyRestartScope({
      previousBackend,
      currentBackend: { ...previousBackend, pid: 101 },
      previousClient: previousNativeClient,
      currentClient: { ...previousNativeClient, pid: 301 },
    })).toBe('both');
  });

  it('refuses to delete a checkpoint unless the canonical path and sealed content still match', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-restart-checkpoint-'));
    const checkpointPath = path.join(temporaryRoot, 'checkpoint.json');
    const checkpoint = fixture().checkpoint;
    try {
      fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
      const canonical = fs.realpathSync.native(checkpointPath);
      fs.writeFileSync(checkpointPath, `${JSON.stringify({ ...checkpoint, marker: 'tampered' })}\n`, 'utf8');
      expect(removeOwnedRestartCheckpoint(checkpointPath, canonical, checkpoint)).toBe(false);
      expect(fs.existsSync(checkpointPath)).toBe(true);

      fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
      expect(removeOwnedRestartCheckpoint(checkpointPath, `${canonical}.different`, checkpoint)).toBe(false);
      expect(fs.existsSync(checkpointPath)).toBe(true);
      expect(removeOwnedRestartCheckpoint(checkpointPath, canonical, checkpoint)).toBe(true);
      expect(fs.existsSync(checkpointPath)).toBe(false);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('creates checkpoints atomically without replacing an existing invocation checkpoint', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-restart-exclusive-'));
    const checkpointPath = path.join(temporaryRoot, 'checkpoint.json');
    const checkpoint = fixture().checkpoint;
    try {
      const created = writeCheckpointExclusive(checkpointPath, checkpoint);
      expect(created).toBe(fs.realpathSync.native(checkpointPath));
      expect(JSON.parse(fs.readFileSync(created, 'utf8'))).toEqual(checkpoint);

      const foreign = `${JSON.stringify({ owner: 'another-acceptance-run' })}\n`;
      fs.unlinkSync(checkpointPath);
      fs.writeFileSync(checkpointPath, foreign, { encoding: 'utf8', flag: 'wx' });
      expect(() => writeCheckpointExclusive(checkpointPath, checkpoint))
        .toThrowError('restart_checkpoint_exists');
      expect(fs.readFileSync(checkpointPath, 'utf8')).toBe(foreign);
      expect(fs.readdirSync(temporaryRoot)).toEqual(['checkpoint.json']);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('contains no process-launch or service-restart primitive and documents the two manual stages', () => {
    const script = path.resolve('scripts/formal-client-restart-recovery.mjs');
    const source = fs.readFileSync(script, 'utf8');
    expect(source).not.toMatch(/\b(?:execFileSync|execSync|spawn|fork|Start-Process|Restart-Service|Stop-Process)\s*\(/u);
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(1);
    expect(help.stdout).toContain('Prepare:');
    expect(help.stdout).toContain('Verify:');
    expect(help.stdout).toContain('backend-only|client-only|both');
    expect(help.stdout).toContain('This script never restarts it.');
    expect(help.stdout).toContain('authenticated /devices registry');
    expect(help.stdout).toMatch(/contain(?:s)? no token, cookie, desktop proof, file payload, or tool result/i);
  });

  it('keeps importable E2E modules free of Windows CRLF shebang parsing hazards', () => {
    for (const script of [
      path.resolve('scripts/formal-client-e2e.mjs'),
      path.resolve('scripts/formal-client-restart-recovery.mjs'),
    ]) {
      expect(fs.readFileSync(script, 'utf8')).not.toMatch(/^#!/u);
    }
  });
});
