import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFailoverCheckpoint,
  buildLocationBindings,
  buildSanitizedFailoverEvidence,
  containsInternalGuardText,
  failoverEvidenceCliExitCode,
  parseFailoverArgs,
  sha256,
  stableDigest,
  validateAcceptanceHarnessIdentity,
  validateFailoverCheckpoint,
  validateFailoverRecoveryEvidence,
  validateFormalRoutingPolicy,
  validateHealthyPrimaryReceipt,
  validateNativeTauriDeviceEvidence,
  validatePersistedTurn,
  validatePreparedBaselineEvidence,
  validateRealFailoverRoutingReceipt,
} from '../scripts/formal-model-failover-recovery.mjs';

const BUILD_ID = 'a'.repeat(40);
const MARKER = 'LUMI-E2E-FAILOVER-0123456789abcdef';
const CONVERSATION_ID = 'conversation-1';
const TASK_ID = 'task-1';
const BASELINE_REQUEST_ID = 'request-baseline';
const CONTINUATION_REQUEST_ID = 'request-continuation';
const NATIVE_DEVICE_ID = 'native-desktop-1';
const EXECUTION_SESSION_ID = 'd'.repeat(64);

function observerIdentity() {
  const startedAt = '2026-08-27T00:00:00.000Z';
  return {
    schemaVersion: 1,
    clientKind: 'local_acceptance_harness',
    pid: 41001,
    startedAtUnixMs: Date.parse(startedAt),
    startedAt,
    executablePath: 'C:\\Program Files\\LumiCore\\formal-acceptance-observer.exe',
    executableSha256: '1'.repeat(64),
    binaryHashUnavailable: false,
    buildId: BUILD_ID,
    buildIdSemantics: 'baseline_commit',
    sourceFingerprint: '2'.repeat(64),
    sourceDirty: false,
    appVersion: '1.0.0',
    trustLevel: 'proof_bound_local_claim',
    osAttested: false,
    webviewProfileTrustLevel: 'unbound',
  };
}

function nativeIdentity() {
  const startedAt = '2026-08-27T00:00:00.000Z';
  return {
    schemaVersion: 1,
    clientKind: 'tauri',
    pid: 42001,
    startedAtUnixMs: Date.parse(startedAt),
    startedAt,
    executablePath: 'C:\\Program Files\\LumiCore\\LumiCore.exe',
    executableSha256: '3'.repeat(64),
    binaryHashUnavailable: false,
    buildId: BUILD_ID,
    buildIdSemantics: 'baseline_commit',
    sourceFingerprint: '4'.repeat(64),
    sourceDirty: false,
    appVersion: '1.0.0',
    trustLevel: 'proof_bound_local_claim',
    osAttested: false,
    webviewProfileTrustLevel: 'unbound',
  };
}

function nativeBinding() {
  return {
    nativeDeviceId: NATIVE_DEVICE_ID,
    executionSessionId: EXECUTION_SESSION_ID,
    nativeClientIdentitySha256: stableDigest(nativeIdentity()),
  };
}

function nativeDevices(identity: ReturnType<typeof nativeIdentity> | ReturnType<typeof observerIdentity> = nativeIdentity()) {
  return [{
    id: NATIVE_DEVICE_ID,
    type: 'desktop',
    status: 'online',
    socketId: 'socket-tauri-1',
    nativeClientIdentity: identity,
  }];
}

function policy() {
  return {
    schemaVersion: 2,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    selectionMode: 'ordered_fallback',
    fallbackCandidates: [{ provider: 'lmstudio', model: 'qwen-local' }],
    allowCloudFallback: false,
  };
}

function health() {
  return {
    status: 'ok',
    runtime: { buildId: BUILD_ID, sourceDirty: false },
    database: { persistence: { degraded: false } },
    functionalProbes: {
      localModels: {
        lmstudio: { reachable: true, inferenceHealthy: true, modelCount: 1 },
      },
    },
  };
}

function taskReceipt(requestId: string, receiptId: string) {
  return {
    receiptId,
    taskId: TASK_ID,
    requestId,
    toolName: 'write_file',
    outcome: 'waiting_confirmation',
    verification: 'unverified',
  };
}

function baselineTask() {
  return {
    taskId: TASK_ID,
    status: 'waiting_confirmation',
    activeRequest: false,
    revision: 4,
    updatedAt: '2026-08-27T00:00:03.000Z',
    evidence: { latest: [taskReceipt(BASELINE_REQUEST_ID, 'task-receipt-baseline')] },
  };
}

function baselineMessages() {
  return [
    {
      id: 'message-user-baseline',
      conversationId: CONVERSATION_ID,
      requestId: BASELINE_REQUEST_ID,
      role: 'user',
      channel: 'chat',
      message: 'Prepare the real task and wait for confirmation.',
      timestamp: '2026-08-27T00:00:00.000Z',
      ...nativeBinding(),
    },
    {
      id: 'message-assistant-baseline',
      conversationId: CONVERSATION_ID,
      requestId: BASELINE_REQUEST_ID,
      role: 'assistant',
      channel: 'chat',
      message: 'The action is prepared and waiting for confirmation.',
      llmWasCalled: true,
      timestamp: '2026-08-27T00:00:03.000Z',
      ...nativeBinding(),
    },
  ];
}

function baselineRoutingReceipt() {
  return {
    id: 'routing-receipt-baseline',
    conversationId: CONVERSATION_ID,
    requestId: BASELINE_REQUEST_ID,
    interactionId: 'interaction-baseline',
    source: 'chat',
    status: 'succeeded',
    requestedProvider: 'deepseek',
    requestedModel: 'deepseek-v4-flash',
    selectionMode: 'ordered_fallback',
    selectedProvider: 'deepseek',
    selectedModel: 'deepseek-v4-flash',
    fallbackReason: '',
    attempts: [{
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      status: 'succeeded',
      startedAt: '2026-08-27T00:00:01.000Z',
      completedAt: '2026-08-27T00:00:02.000Z',
      durationMs: 1000,
    }],
    startedAt: '2026-08-27T00:00:01.000Z',
    completedAt: '2026-08-27T00:00:02.000Z',
    durationMs: 1000,
    ...nativeBinding(),
  };
}

function locationBindings() {
  return {
    dataRootSha256: sha256('data-root'),
    webview2UserDataDirSha256: sha256('webview-root'),
    webview2ProfileDirSha256: sha256('webview-profile'),
  };
}

function checkpoint() {
  const baseline = validatePreparedBaselineEvidence({
    health: health(),
    policy: policy(),
    runtime: { tasks: [baselineTask()] },
    messages: baselineMessages(),
    routingReceipts: [baselineRoutingReceipt()],
    devices: nativeDevices(),
    observerIdentity: observerIdentity(),
    expectedBuildId: BUILD_ID,
    conversationId: CONVERSATION_ID,
    taskId: TASK_ID,
    baselineRequestId: BASELINE_REQUEST_ID,
  });
  if (!baseline.ok) throw new Error(`invalid baseline fixture: ${baseline.code}`);
  return buildFailoverCheckpoint({
    marker: MARKER,
    preparedAt: '2026-08-27T00:00:10.000Z',
    locationBindings: locationBindings(),
    identities: {
      conversationId: CONVERSATION_ID,
      taskId: TASK_ID,
      baselineRequestId: BASELINE_REQUEST_ID,
    },
    baseline: baseline.evidence,
  });
}

function continuationMessages() {
  return [
    ...baselineMessages(),
    {
      id: 'message-user-continuation',
      conversationId: CONVERSATION_ID,
      requestId: CONTINUATION_REQUEST_ID,
      role: 'user',
      channel: 'chat',
      message: `[${MARKER}] Continue the same task with the corrected target.`,
      timestamp: '2026-08-27T00:00:11.000Z',
      ...nativeBinding(),
    },
    {
      id: 'message-assistant-continuation',
      conversationId: CONVERSATION_ID,
      requestId: CONTINUATION_REQUEST_ID,
      role: 'assistant',
      channel: 'chat',
      message: 'I kept the same task and prepared the corrected action.',
      cognitiveIntent: 'confirmation',
      llmWasCalled: true,
      timestamp: '2026-08-27T00:00:20.000Z',
      ...nativeBinding(),
    },
  ];
}

function recoveredTask() {
  return {
    taskId: TASK_ID,
    status: 'waiting_confirmation',
    activeRequest: false,
    revision: 5,
    updatedAt: '2026-08-27T00:00:20.000Z',
    evidence: {
      latest: [
        taskReceipt(CONTINUATION_REQUEST_ID, 'task-receipt-continuation'),
        taskReceipt(BASELINE_REQUEST_ID, 'task-receipt-baseline'),
      ],
    },
  };
}

function failoverRoutingReceipt() {
  return {
    id: 'routing-receipt-continuation',
    conversationId: CONVERSATION_ID,
    requestId: CONTINUATION_REQUEST_ID,
    interactionId: 'interaction-continuation',
    source: 'chat',
    status: 'succeeded',
    requestedProvider: 'deepseek',
    requestedModel: 'deepseek-v4-flash',
    selectionMode: 'ordered_fallback',
    selectedProvider: 'lmstudio',
    selectedModel: 'qwen-local',
    fallbackReason: 'provider_unreachable',
    attempts: [
      {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        status: 'failed',
        reason: 'provider_unreachable',
        errorCategory: 'provider_unreachable',
        errorDigest: 'b'.repeat(64),
        startedAt: '2026-08-27T00:00:12.000Z',
        completedAt: '2026-08-27T00:00:14.000Z',
        durationMs: 2000,
        visibleOutputCommitted: false,
      },
      {
        provider: 'lmstudio',
        model: 'qwen-local',
        status: 'succeeded',
        startedAt: '2026-08-27T00:00:14.000Z',
        completedAt: '2026-08-27T00:00:19.000Z',
        durationMs: 5000,
        visibleOutputCommitted: true,
      },
    ],
    startedAt: '2026-08-27T00:00:12.000Z',
    completedAt: '2026-08-27T00:00:19.000Z',
    durationMs: 7000,
    ...nativeBinding(),
  };
}

function recoveryInput(overrides: Record<string, unknown> = {}) {
  return {
    checkpoint: checkpoint(),
    locationBindings: locationBindings(),
    health: health(),
    policy: policy(),
    runtime: { tasks: [recoveredTask()] },
    messages: continuationMessages(),
    routingReceipts: [failoverRoutingReceipt()],
    devices: nativeDevices(),
    observerIdentity: observerIdentity(),
    continuationRequestId: CONTINUATION_REQUEST_ID,
    ...overrides,
  };
}

describe('formal real model failover recovery protocol', () => {
  it('requires explicit two-stage lifecycle and absolute formal locations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-failover-args-'));
    const dataRoot = path.join(root, 'data');
    const evidenceRoot = path.join(root, 'evidence');
    const webviewRoot = path.join(root, 'webview');
    const profile = path.join(webviewRoot, 'Default');
    const prepare = parseFailoverArgs([
      'prepare', '--confirm-live-e2e', '--data-root', dataRoot,
      '--evidence-root', evidenceRoot, '--webview2-user-data-dir', webviewRoot,
      '--webview2-profile-dir', profile, '--conversation-id', CONVERSATION_ID,
      '--task-id', TASK_ID, '--baseline-request-id', BASELINE_REQUEST_ID,
    ]);
    expect(prepare).toMatchObject({
      mode: 'prepare', conversationId: CONVERSATION_ID, taskId: TASK_ID,
      baselineRequestId: BASELINE_REQUEST_ID,
    });
    const verify = parseFailoverArgs([
      'verify', '--confirm-live-e2e', '--data-root', dataRoot,
      '--evidence-root', evidenceRoot, '--webview2-user-data-dir', webviewRoot,
      '--webview2-profile-dir', profile, '--continuation-request-id', CONTINUATION_REQUEST_ID,
    ]);
    expect(verify).toMatchObject({ mode: 'verify', continuationRequestId: CONTINUATION_REQUEST_ID });
    expect(() => parseFailoverArgs([
      'prepare', '--data-root', dataRoot, '--evidence-root', evidenceRoot,
      '--webview2-user-data-dir', webviewRoot, '--webview2-profile-dir', profile,
      '--conversation-id', CONVERSATION_ID, '--task-id', TASK_ID,
      '--baseline-request-id', BASELINE_REQUEST_ID,
    ])).toThrow('live_confirmation_required');
    expect(() => parseFailoverArgs([
      'verify', '--confirm-live-e2e', '--data-root', dataRoot,
      '--evidence-root', evidenceRoot, '--webview2-user-data-dir', webviewRoot,
      '--webview2-profile-dir', profile,
    ])).toThrow('continuation_request_id_required');
  });

  it('hash-binds the data root and exact WebView2 profile and rejects an escaped profile', () => {
    const root = path.resolve('C:\\LumiFormal');
    const userData = path.join(root, 'WebView2');
    const profile = path.join(userData, 'Default');
    const bindings = buildLocationBindings({ dataRoot: root, webview2UserDataDir: userData, webview2ProfileDir: profile });
    expect(Object.values(bindings).every(value => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    expect(() => buildLocationBindings({
      dataRoot: root,
      webview2UserDataDir: userData,
      webview2ProfileDir: path.join(root, 'OtherProfile'),
    })).toThrow('webview2_profile_outside_user_data_dir');
  });

  it('accepts only ordered failover with one LM Studio candidate first', () => {
    expect(validateFormalRoutingPolicy(policy())).toMatchObject({
      ok: true,
      lmstudioModel: 'qwen-local',
    });
    expect(validateFormalRoutingPolicy({ ...policy(), selectionMode: 'pinned' })).toMatchObject({
      ok: false, code: 'failover_ordered_policy_required',
    });
    expect(validateFormalRoutingPolicy({
      ...policy(),
      fallbackCandidates: [
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'lmstudio', model: 'qwen-local' },
      ],
    })).toMatchObject({ ok: false, code: 'failover_lmstudio_must_be_first_unique_fallback' });
    expect(validateFormalRoutingPolicy({ ...policy(), provider: '__lumi_forced_unavailable_primary__' }))
      .toMatchObject({ ok: false, code: 'failover_synthetic_primary_rejected' });
  });

  it('keeps the authenticated observer separate from request-bound Tauri evidence', () => {
    expect(validateAcceptanceHarnessIdentity(observerIdentity(), BUILD_ID)).toMatchObject({
      ok: true,
      evidence: {
        clientKind: 'local_acceptance_harness',
        role: 'read_only_authenticated_observer',
        eligibleAsNativeClientEvidence: false,
      },
    });
    expect(validateAcceptanceHarnessIdentity({
      ...observerIdentity(),
      executablePath: '/opt/lumicore/formal-acceptance-observer',
    }, BUILD_ID)).toMatchObject({ ok: true });
    expect(validateAcceptanceHarnessIdentity({
      ...observerIdentity(),
      executablePath: 'relative/formal-acceptance-observer',
    }, BUILD_ID)).toMatchObject({ ok: false });
    expect(validateAcceptanceHarnessIdentity(nativeIdentity(), BUILD_ID)).toMatchObject({
      ok: false,
      code: 'failover_observer_must_be_acceptance_harness',
    });
    expect(validateNativeTauriDeviceEvidence(nativeDevices(), {
      nativeDeviceId: NATIVE_DEVICE_ID,
      nativeClientIdentitySha256: nativeBinding().nativeClientIdentitySha256,
      expectedBuildId: BUILD_ID,
    })).toMatchObject({
      ok: true,
      evidence: {
        clientKind: 'tauri',
        nativeDeviceId: NATIVE_DEVICE_ID,
        evidenceRole: 'request_bound_product_client',
      },
    });
    expect(validateNativeTauriDeviceEvidence(nativeDevices(observerIdentity()), {
      nativeDeviceId: NATIVE_DEVICE_ID,
      nativeClientIdentitySha256: stableDigest(observerIdentity()),
      expectedBuildId: BUILD_ID,
    })).toMatchObject({ ok: false, code: 'failover_native_device_not_tauri' });
  });

  it('requires a healthy direct-primary receipt before preparing the outage', () => {
    expect(validateHealthyPrimaryReceipt(baselineRoutingReceipt(), policy())).toMatchObject({ ok: true });
    const unboundReceipt: Record<string, unknown> = { ...baselineRoutingReceipt() };
    delete unboundReceipt.nativeDeviceId;
    delete unboundReceipt.executionSessionId;
    delete unboundReceipt.nativeClientIdentitySha256;
    expect(validateHealthyPrimaryReceipt(unboundReceipt, policy())).toMatchObject({
      ok: false,
      code: 'failover_baseline_primary_receipt_invalid',
    });
    expect(validateHealthyPrimaryReceipt({
      ...baselineRoutingReceipt(),
      selectedProvider: 'lmstudio',
      fallbackReason: 'provider_unreachable',
    }, policy())).toMatchObject({ ok: false, code: 'failover_baseline_primary_receipt_invalid' });
    const result = validatePreparedBaselineEvidence({
      health: health(),
      policy: policy(),
      runtime: { tasks: [baselineTask()] },
      messages: baselineMessages(),
      routingReceipts: [baselineRoutingReceipt()],
      devices: nativeDevices(),
      observerIdentity: observerIdentity(),
      expectedBuildId: BUILD_ID,
      conversationId: CONVERSATION_ID,
      taskId: TASK_ID,
      baselineRequestId: BASELINE_REQUEST_ID,
    });
    expect(result).toMatchObject({
      ok: true,
      evidence: {
        buildId: BUILD_ID,
        task: { taskId: TASK_ID, revision: 4, status: 'waiting_confirmation' },
        taskReceipt: { requestId: BASELINE_REQUEST_ID },
      },
    });
    expect(validatePreparedBaselineEvidence({
      health: health(), policy: policy(),
      runtime: { tasks: [{ ...baselineTask(), evidence: { latest: [] } }] },
      messages: baselineMessages(), routingReceipts: [baselineRoutingReceipt()],
      devices: nativeDevices(), observerIdentity: observerIdentity(),
      expectedBuildId: BUILD_ID, conversationId: CONVERSATION_ID,
      taskId: TASK_ID, baselineRequestId: BASELINE_REQUEST_ID,
    })).toMatchObject({ ok: false, code: 'failover_baseline_task_request_unbound' });
  });

  it('makes the checkpoint immutable-looking, self-digested and location-bound', () => {
    const value = checkpoint();
    expect(validateFailoverCheckpoint(value, locationBindings())).toMatchObject({
      ok: true,
      checkpoint: {
        observer: {
          clientKind: 'local_acceptance_harness',
          eligibleAsNativeClientEvidence: false,
        },
        nativeClient: {
          clientKind: 'tauri',
          nativeDeviceId: NATIVE_DEVICE_ID,
          executionSessionId: EXECUTION_SESSION_ID,
          identitySha256: nativeBinding().nativeClientIdentitySha256,
        },
      },
    });
    expect(validateFailoverCheckpoint({
      ...value,
      lifecycle: { ...value.lifecycle, baselineRevision: 99 },
    }, locationBindings())).toMatchObject({ ok: false, code: 'failover_checkpoint_digest_invalid' });
    expect(validateFailoverCheckpoint(value, {
      ...locationBindings(), dataRootSha256: sha256('other-root'),
    })).toMatchObject({ ok: false, code: 'failover_checkpoint_location_mismatch' });
  });

  it('accepts a real failed primary call followed directly by LM Studio', () => {
    expect(validateRealFailoverRoutingReceipt(failoverRoutingReceipt(), checkpoint())).toMatchObject({
      ok: true,
      evidence: {
        selectedProvider: 'lmstudio',
        fallbackReason: 'provider_unreachable',
        primaryFailureDigest: 'b'.repeat(64),
      },
    });
    const skipped = failoverRoutingReceipt();
    skipped.attempts[0] = { ...skipped.attempts[0], status: 'skipped' };
    expect(validateRealFailoverRoutingReceipt(skipped, checkpoint()))
      .toMatchObject({ ok: false, code: 'failover_primary_actual_failure_missing' });
    const noDigest = failoverRoutingReceipt();
    delete noDigest.attempts[0].errorDigest;
    expect(validateRealFailoverRoutingReceipt(noDigest, checkpoint()))
      .toMatchObject({ ok: false, code: 'failover_primary_failure_not_real_call_evidence' });
    const syntheticReason: any = failoverRoutingReceipt();
    syntheticReason.attempts[0] = {
      ...syntheticReason.attempts[0],
      reason: 'unsupported_provider_or_model',
    };
    syntheticReason.fallbackReason = 'unsupported_provider_or_model';
    expect(validateRealFailoverRoutingReceipt(syntheticReason, checkpoint()))
      .toMatchObject({ ok: false, code: 'failover_primary_failure_not_real_call_evidence' });
  });

  it('proves the same task advanced with one persisted request, task receipt and natural reply', () => {
    expect(validateFailoverRecoveryEvidence(recoveryInput())).toMatchObject({
      ok: true,
      evidence: {
        buildId: BUILD_ID,
        observer: {
          clientKind: 'local_acceptance_harness',
          eligibleAsNativeClientEvidence: false,
        },
        nativeClient: {
          clientKind: 'tauri',
          nativeDeviceId: NATIVE_DEVICE_ID,
          executionSessionId: EXECUTION_SESSION_ID,
          identitySha256: nativeBinding().nativeClientIdentitySha256,
        },
        lifecycle: {
          conversationId: CONVERSATION_ID,
          taskId: TASK_ID,
          baselineRequestId: BASELINE_REQUEST_ID,
          continuationRequestId: CONTINUATION_REQUEST_ID,
          baselineRevision: 4,
          recoveredRevision: 5,
          taskReceiptId: 'task-receipt-continuation',
          transcript: {
            nativeDeviceId: NATIVE_DEVICE_ID,
            executionSessionId: EXECUTION_SESSION_ID,
            nativeClientIdentitySha256: nativeBinding().nativeClientIdentitySha256,
          },
        },
        routing: { selectedProvider: 'lmstudio' },
      },
    });
    expect(validateFailoverRecoveryEvidence(recoveryInput({
      runtime: { tasks: [{ ...recoveredTask(), revision: 4 }] },
    }))).toMatchObject({ ok: false, code: 'failover_continuation_task_revision_not_advanced' });
    expect(validateFailoverRecoveryEvidence(recoveryInput({
      runtime: { tasks: [{ ...recoveredTask(), evidence: { latest: [] } }] },
    }))).toMatchObject({ ok: false, code: 'failover_continuation_task_receipt_missing' });
    expect(validateFailoverRecoveryEvidence(recoveryInput({
      policy: { ...policy(), model: 'manually-switched-model' },
    }))).toMatchObject({ ok: false, code: 'failover_policy_changed_after_prepare' });

    const routeWithDifferentSession = {
      ...failoverRoutingReceipt(),
      executionSessionId: 'e'.repeat(64),
    };
    expect(validateFailoverRecoveryEvidence(recoveryInput({
      routingReceipts: [routeWithDifferentSession],
    }))).toMatchObject({
      ok: false,
      code: 'failover_routing_native_client_binding_mismatch',
    });
  });

  it('requires marker-bound persisted chat and rejects internal guard leakage', () => {
    expect(validatePersistedTurn({
      messages: continuationMessages(),
      conversationId: CONVERSATION_ID,
      requestId: CONTINUATION_REQUEST_ID,
      requiredMarker: MARKER,
    })).toMatchObject({ ok: true });
    const splitNativeTurn = continuationMessages();
    splitNativeTurn[splitNativeTurn.length - 1] = {
      ...splitNativeTurn[splitNativeTurn.length - 1],
      executionSessionId: 'e'.repeat(64),
    };
    expect(validatePersistedTurn({
      messages: splitNativeTurn,
      conversationId: CONVERSATION_ID,
      requestId: CONTINUATION_REQUEST_ID,
      requiredMarker: MARKER,
    })).toMatchObject({
      ok: false,
      code: 'failover_transcript_native_client_binding_missing',
    });
    expect(containsInternalGuardText('No successful current-turn tool execution was recorded.')).toBe(true);
    expect(containsInternalGuardText('这一轮没有记录到成功的真实工具执行。')).toBe(true);
    const leaking = continuationMessages();
    leaking[leaking.length - 1] = {
      ...leaking[leaking.length - 1],
      message: 'No successful current-turn tool execution was recorded.',
    };
    expect(validateFailoverRecoveryEvidence(recoveryInput({ messages: leaking })))
      .toMatchObject({ ok: false, code: 'failover_internal_guard_leaked' });
    const noMarker = continuationMessages();
    noMarker[noMarker.length - 2] = {
      ...noMarker[noMarker.length - 2],
      message: 'Continue the same task.',
    };
    expect(validateFailoverRecoveryEvidence(recoveryInput({ messages: noMarker })))
      .toMatchObject({ ok: false, code: 'failover_continuation_marker_missing' });
  });

  it('emits only allowlisted, hashed evidence and records the observation boundary', () => {
    const accepted = validateFailoverRecoveryEvidence(recoveryInput());
    expect(accepted.ok).toBe(true);
    const record = buildSanitizedFailoverEvidence({
      ok: true,
      phase: 'verify',
      marker: MARKER,
      checkpointSha256: checkpoint().checkpointSha256,
      evidence: {
        ...accepted.evidence,
        secret: 'PRIVATE-API-KEY',
        rawTranscript: 'sensitive transcript body',
        cookie: 'session-cookie',
      },
      acceptanceDecision: 'passed',
      acceptancePassed: true,
    });
    const serialized = JSON.stringify(record);
    expect(record).toMatchObject({
      ok: true,
      phase: 'verify',
      observationBoundary: {
        failureInducedByScript: false,
        chatTurnSentByScript: false,
        clientOperatedByScript: false,
        modelPreferencesChangedByScript: false,
        networkChangedByScript: false,
        credentialsChangedByScript: false,
      },
      lifecycle: {
        taskId: TASK_ID,
        baselineRevision: 4,
        recoveredRevision: 5,
      },
      observer: {
        clientKind: 'local_acceptance_harness',
        eligibleAsNativeClientEvidence: false,
      },
      nativeClient: {
        clientKind: 'tauri',
        nativeDeviceId: NATIVE_DEVICE_ID,
        executionSessionId: EXECUTION_SESSION_ID,
      },
      routing: { selectedProvider: 'lmstudio' },
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      evidenceClassification: 'restricted_private_local',
      publishable: false,
    });
    expect(serialized).not.toContain('PRIVATE-API-KEY');
    expect(serialized).not.toContain('sensitive transcript body');
    expect(serialized).not.toContain('session-cookie');
    expect(serialized).not.toContain(`[${MARKER}] Continue`);
  });

  it('never turns a successful specialized evidence run into formal acceptance', () => {
    expect(failoverEvidenceCliExitCode({
      ok: true,
      phaseComplete: true,
      packageComplete: false,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
    })).toBe(1);
    expect(failoverEvidenceCliExitCode({
      ok: true,
      packageComplete: true,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
    })).toBe(2);
    expect(failoverEvidenceCliExitCode({
      ok: true,
      acceptanceDecision: 'passed',
      acceptancePassed: true,
    })).toBe(1);
    expect(failoverEvidenceCliExitCode({ ok: false })).toBe(1);

    const record = buildSanitizedFailoverEvidence({
      ok: true,
      phase: 'verify',
      acceptanceDecision: 'passed',
      acceptancePassed: true,
    });
    expect(record).toMatchObject({
      ok: true,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      publishable: false,
    });
  });

  it('contains no client control, chat emission or product-configuration mutation path', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts/formal-model-failover-recovery.mjs'),
      'utf8',
    );
    expect(source).not.toContain("'agent:chat'");
    expect(source).not.toContain('runTurn(');
    expect(source).not.toContain('upsertUserPreferredLLM');
    expect(source).not.toContain('saveLocalModelConfig');
    expect(source).not.toMatch(/method\s*:\s*['\"](?:PUT|PATCH|DELETE)['\"]/i);
    expect(source).toContain('failureInducedByScript: false');
    expect(source).toContain('chatTurnSentByScript: false');
  });
});
