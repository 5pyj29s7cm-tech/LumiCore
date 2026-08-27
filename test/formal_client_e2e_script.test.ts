import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORMAL_SCENARIO_EVIDENCE_CATEGORIES,
  FORMAL_STAGE9_REQUIREMENTS,
  FORMAL_STAGE9_SCENARIOS,
  buildLifecycleTurnEvidence,
  buildOwnedArtifactLayout,
  cleanOwnedArtifactLayout,
  containsInternalExecutionBlock,
  evidenceTextHash,
  evaluateFormalStage9Coverage,
  evaluateFormalScenarioEvidenceCoverage,
  formalGateExitCode,
  findRuntimeTaskByMarker,
  isVerifiedForcedFailoverProbe,
  isPathInside,
  isLoopbackBaseUrl,
  parseWorkerReceiptCount,
  parseScenarioScreenshotBinding,
  prepareOwnedArtifactLayout,
  runtimeReceiptSignature,
  runtimeTaskStateSignature,
  selectFormalE2ENativeClientEvidence,
  selectFormalNativeClientEvidence,
  validateCancellationLeaseRelease,
  validateConfirmationRejectionEvidence,
  validateCorrectionLifecycleEvidence,
  validateManualVoiceConfirmationEvidence,
  validateManualVoiceConversationEvidence,
  validatePersistedConversationScope,
  validateRepeatedConfirmationIdempotencyEvidence,
  validateRoutingTrace,
  validateStatusQueryNoReplay,
  validateVoiceToTextContinuationEvidence,
} from '../scripts/formal-client-e2e.mjs';

describe('formal native-client E2E safety helpers', () => {
  it('creates a non-activating isolated conversation and cleans it by exact returned id', () => {
    const source = fs.readFileSync(path.resolve('scripts/formal-client-e2e.mjs'), 'utf8');
    expect(source).toContain("activation: 'isolated'");
    expect(source).toContain('/conversations/${encodeURIComponent(conversationId)}');
    expect(source).not.toMatch(/conversations\/\$\{encodeURIComponent\(conversationId\)\}\/activate/u);
  });

  it('keeps the main E2E as an evidence producer that can never exit zero', () => {
    expect(formalGateExitCode({ ok: true, fullAcceptance: false })).toBe(1);
    expect(formalGateExitCode({ ok: false, fullAcceptance: true })).toBe(1);
    expect(formalGateExitCode({ ok: true, fullAcceptance: true })).toBe(1);
    expect(formalGateExitCode({
      ok: true,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      fullAcceptance: false,
    })).toBe(1);
    expect(formalGateExitCode({
      ok: true,
      packageComplete: true,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      fullAcceptance: false,
    })).toBe(2);
    expect(formalGateExitCode({
      ok: true,
      coverageComplete: true,
      identityVerified: true,
      acceptanceDecision: 'accepted',
      acceptancePassed: true,
      fullAcceptance: true,
    })).toBe(1);
  });

  it('uses authenticated /devices Tauri identity as evidence, never the harness or CLI claim', () => {
    const startedAtUnixMs = Date.UTC(2026, 7, 27, 5, 0, 0);
    const buildId = 'a'.repeat(40);
    const identity = {
      schemaVersion: 1,
      clientKind: 'tauri',
      pid: 8200,
      startedAtUnixMs,
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
    };
    const expected = { pid: 8200, startedAtUnixMs, buildId };
    const devices = [{
      id: 'tauri-device-1',
      type: 'desktop',
      status: 'online',
      socketId: 'tauri-socket-1',
      nativeClientIdentity: identity,
    }];
    const selected = selectFormalE2ENativeClientEvidence(devices, expected, buildId);
    expect(selected).toMatchObject({
      ok: true,
      evidence: {
        clientKind: 'tauri',
        pid: 8200,
        deviceId: 'tauri-device-1',
        executableSha256: 'b'.repeat(64),
        sourceFingerprint: 'c'.repeat(64),
        sourceDirty: false,
        identitySource: 'authenticated_devices_registry_proof_bound_tauri',
        identityVerified: true,
        osAttested: false,
        webviewProfileTrustLevel: 'unbound',
        webviewProfileBound: false,
        formalAcceptanceEligible: false,
      },
    });
    expect(selectFormalNativeClientEvidence([{
      id: 'harness-device',
      type: 'desktop',
      status: 'online',
      socketId: 'harness-socket',
      nativeClientIdentity: { ...identity, clientKind: 'local_acceptance_harness' },
    }], expected)).toMatchObject({ ok: false, code: 'native_device_not_tauri' });
    expect(selectFormalE2ENativeClientEvidence(devices, expected, 'd'.repeat(40)))
      .toMatchObject({ ok: false, code: 'native_client_build_mismatch' });
  });

  it('cannot claim stage 9 from one voice gate or a partial automated run', () => {
    const partial = evaluateFormalStage9Coverage({
      task_correction_three_times: true,
      physical_microphone_20_turns: true,
      confirmation_waiting: true,
      task_status_query: true,
      multi_agent_durable_completion: true,
    });
    expect(partial.stage9Complete).toBe(false);
    expect(partial.missingChecks).toEqual(expect.arrayContaining([
      'voice_to_text_same_task_continuation',
      'confirmation_rejection',
      'repeated_confirmation_idempotency',
      'production_primary_failure_lmstudio_same_task_continuation',
      'native_client_restart_formal_profile',
      'backend_restart_task_recovery',
      'active_wps_document_workflow',
      'four_variant_business_loops',
      'screenshots_receipts_timeline_routing_artifacts_feedback',
    ]));
    expect(evaluateFormalStage9Coverage(Object.fromEntries(
      FORMAL_STAGE9_REQUIREMENTS.map(id => [id, true]),
    ))).toMatchObject({ stage9Complete: true, missingChecks: [] });
  });

  it('requires every evidence category to be bound to every individual Stage 9 scenario', () => {
    const checks = Object.fromEntries(FORMAL_STAGE9_SCENARIOS.map(id => [id, true]));
    const evidence = Object.fromEntries(FORMAL_STAGE9_SCENARIOS.map(id => [id, Object.fromEntries(
      FORMAL_SCENARIO_EVIDENCE_CATEGORIES.map(category => [category, 1]),
    )]));
    expect(evaluateFormalScenarioEvidenceCoverage({ checks, evidence })).toMatchObject({
      complete: true,
      incompleteScenarios: [],
    });

    evidence.physical_microphone_20_turns.screenshots = 0;
    const missingOne = evaluateFormalScenarioEvidenceCoverage({ checks, evidence });
    expect(missingOne.complete).toBe(false);
    expect(missingOne.incompleteScenarios).toContain('physical_microphone_20_turns');
    expect(missingOne.scenarios.physical_microphone_20_turns.missingCategories).toContain('screenshots');

    expect(evaluateFormalScenarioEvidenceCoverage({
      checks,
      evidence: Object.fromEntries(FORMAL_SCENARIO_EVIDENCE_CATEGORIES.map(category => [category, 99])),
    }).complete).toBe(false);
  });

  it('accepts only an explicit Stage 9 scenario binding for evidence screenshots', () => {
    const screenshot = path.resolve(os.tmpdir(), 'formal-screen.png');
    expect(parseScenarioScreenshotBinding(`task_status_query=${screenshot}`)).toEqual({
      scenarioId: 'task_status_query',
      sourcePath: screenshot,
    });
    expect(() => parseScenarioScreenshotBinding(screenshot))
      .toThrow('scenario_evidence_screenshot_binding_required');
    expect(() => parseScenarioScreenshotBinding(`unknown_scenario=${screenshot}`))
      .toThrow('invalid_evidence_screenshot_scenario');
    expect(() => parseScenarioScreenshotBinding('task_status_query=relative.png'))
      .toThrow('absolute_evidence_screenshot_required');
  });

  it('allows only loopback API targets', () => {
    expect(isLoopbackBaseUrl('http://127.0.0.1:3000/api')).toBe(true);
    expect(isLoopbackBaseUrl('http://localhost:3000/api')).toBe(true);
    expect(isLoopbackBaseUrl('http://[::1]:3000/api')).toBe(true);
    expect(isLoopbackBaseUrl('https://example.com/api')).toBe(false);
    expect(isLoopbackBaseUrl('file:///tmp/proof')).toBe(false);
  });

  it('detects internal execution-guard copy in natural replies', () => {
    expect(containsInternalExecutionBlock('这一轮没有记录到成功的真实工具执行。')).toBe(true);
    expect(containsInternalExecutionBlock('No successful current-turn tool execution was recorded.')).toBe(true);
    expect(containsInternalExecutionBlock('已经帮你看完了。')).toBe(false);
  });

  it('counts only durable worker evidence', () => {
    expect(parseWorkerReceiptCount({ evidence: ['Worker receipts: 3'] })).toBe(3);
    expect(parseWorkerReceiptCount({ evidence: ['Assigned workers: 5'] })).toBe(0);
  });

  it('requires selected successful route attempts and a fallback reason', () => {
    expect(validateRoutingTrace({
      ok: true,
      provider: 'pinned-provider',
      model: 'pinned-model',
      latencyMs: 12,
      verification: 'live_model_call',
    }, { allowProviderProbe: true }).ok).toBe(true);
    expect(validateRoutingTrace({
      ok: true,
      latencyMs: 12,
      selectedProvider: 'b',
      selectedModel: 'm2',
      fallbackReason: 'primary_failed',
      attempts: [
        { provider: 'a', model: 'm1', status: 'failed' },
        { provider: 'b', model: 'm2', status: 'succeeded' },
      ],
    })).toEqual({ ok: true, fallbackObserved: true, attemptCount: 2 });
    expect(validateRoutingTrace({
      ok: true,
      latencyMs: 12,
      selectedProvider: 'b',
      selectedModel: 'm2',
      fallbackReason: '',
      attempts: [
        { provider: 'a', model: 'm1', status: 'failed' },
        { provider: 'b', model: 'm2', status: 'succeeded' },
      ],
    }).ok).toBe(false);
    expect(validateRoutingTrace({
      ok: true,
      verification: 'live_anything',
      provider: '',
      model: '',
      latencyMs: 0,
    }, { allowProviderProbe: true }).ok).toBe(false);
    expect(validateRoutingTrace({
      ok: true,
      latencyMs: 1,
      selectedProvider: '',
      selectedModel: '',
      attempts: [{ provider: '', model: '', status: 'succeeded' }],
    }).ok).toBe(false);
    expect(validateRoutingTrace({
      ok: true,
      latencyMs: 1,
      selectedProvider: 'b',
      selectedModel: 'm2',
      attempts: [
        { provider: 'a', model: 'm1', status: 'succeeded' },
        { provider: 'b', model: 'm2', status: 'succeeded' },
      ],
    }).ok).toBe(false);
  });

  it('accepts only a deterministic failed-primary to successful-alternate probe', () => {
    const probe = {
      ok: true,
      latencyMs: 12,
      verification: 'live_forced_primary_failure_failover',
      selectedProvider: 'openai',
      selectedModel: 'fallback-model',
      fallbackReason: 'unsupported_provider_or_model',
      attempts: [
        {
          provider: '__lumi_forced_unavailable_primary__',
          model: '__lumi_forced_unavailable_model__',
          status: 'failed',
          reason: 'unsupported_provider_or_model',
        },
        { provider: 'openai', model: 'fallback-model', status: 'succeeded' },
      ],
    };
    expect(isVerifiedForcedFailoverProbe(probe)).toBe(true);
    expect(isVerifiedForcedFailoverProbe({ ...probe, fallbackReason: '' })).toBe(false);
    expect(isVerifiedForcedFailoverProbe({
      ...probe,
      attempts: [{ provider: 'openai', model: 'fallback-model', status: 'succeeded' }],
    })).toBe(false);
  });

  it('keeps every formal artifact inside one data-root-owned directory', () => {
    const dataRoot = path.resolve(path.parse(process.cwd()).root, 'LumiE2EData');
    const layout = buildOwnedArtifactLayout(dataRoot, 'LUMI-E2E-safe_01');
    expect(layout.root).toBe(path.join(dataRoot, 'formal-client-e2e-artifacts', 'LUMI-E2E-safe_01'));
    expect(layout.files).toHaveLength(5);
    expect(layout.files.every((file: string) => isPathInside(layout.root, file))).toBe(true);
    expect(isPathInside(layout.root, path.join(dataRoot, 'outside.txt'))).toBe(false);
    expect(() => buildOwnedArtifactLayout('', 'LUMI-E2E-safe_01')).toThrow('e2e_artifact_root_invalid');
    expect(() => buildOwnedArtifactLayout('relative-data-root', 'LUMI-E2E-safe_01')).toThrow('e2e_artifact_root_invalid');
  });

  it('cleans only exact files owned by the dedicated formal artifact directory', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-formal-e2e-layout-'));
    const layout = prepareOwnedArtifactLayout(
      buildOwnedArtifactLayout(dataRoot, 'LUMI-E2E-cleanup_01'),
    );
    fs.writeFileSync(layout.files[0], 'owned-evidence', 'utf8');
    expect(cleanOwnedArtifactLayout(layout)).toEqual({ ok: true, failedCount: 0 });
    expect(fs.existsSync(layout.files[0])).toBe(false);
    expect(fs.existsSync(layout.root)).toBe(false);
    expect(fs.existsSync(layout.parent)).toBe(false);
    fs.rmdirSync(dataRoot);
  });

  it('refuses a pre-existing non-directory artifact parent and never cleans an unowned root', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-formal-e2e-unsafe-'));
    const parent = path.join(dataRoot, 'formal-client-e2e-artifacts');
    fs.writeFileSync(parent, 'not a directory', 'utf8');
    const layout = buildOwnedArtifactLayout(dataRoot, 'LUMI-E2E-unsafe_01');
    expect(() => prepareOwnedArtifactLayout(layout)).toThrow('e2e_artifact_parent_not_safe');
    expect(cleanOwnedArtifactLayout(layout)).toEqual({ ok: true, failedCount: 0 });
    expect(fs.readFileSync(parent, 'utf8')).toBe('not a directory');
    fs.unlinkSync(parent);
    fs.rmdirSync(dataRoot);
  });

  it('builds request/task/receipt/reply evidence from persisted records', () => {
    const messages = [
      { id: 'user-1', role: 'user', requestId: 'request-1', message: '纠正目标。' },
      { id: 'assistant-1', role: 'assistant', requestId: 'request-1', message: '已更新，等待确认。' },
    ];
    const task = {
      taskId: 'task-1',
      revision: 4,
      status: 'waiting_confirmation',
      activeRequest: false,
      target: 'D:\\formal\\target.txt',
      evidence: {
        latest: [{
          receiptId: 'receipt-1',
          requestId: 'request-1',
          toolName: 'write_file',
          targetIdentity: 'D:\\formal\\target.txt',
          outcome: 'waiting_confirmation',
          verification: 'unverified',
        }],
      },
    };
    expect(buildLifecycleTurnEvidence({ messages, requestId: 'request-1', runtimeTask: task })).toEqual({
      requestId: 'request-1',
      taskId: 'task-1',
      taskRevision: 4,
      taskStatus: 'waiting_confirmation',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      receiptIds: ['receipt-1'],
      receiptTools: ['write_file'],
      taskTarget: 'D:\\formal\\target.txt',
      receiptTargets: ['D:\\formal\\target.txt'],
      taskStateSignature: runtimeTaskStateSignature(task),
      receiptLedger: {
        signature: 'receipt-1:request-1:write_file:D:\\formal\\target.txt:waiting_confirmation:unverified',
        total: 1,
      },
      userFacingReply: {
        persisted: true,
        sha256: evidenceTextHash('已更新，等待确认。'),
        characterCount: 9,
        internalGuardLeaked: false,
      },
    });
  });

  it('requires one task identity and a revision advance across three corrections', () => {
    const targets = [1, 2, 3, 4].map(index => `D:\\formal\\target-${index}.txt`);
    const evidence = [1, 2, 3, 4].map((revision, index) => ({
      requestId: `request-${revision}`,
      taskId: 'task-stable',
      taskRevision: revision,
      taskTarget: targets[index],
      receiptTargets: [targets[index]],
      userMessageId: `user-${revision}`,
      assistantMessageId: `assistant-${revision}`,
      userFacingReply: { persisted: true, internalGuardLeaked: false },
    }));
    expect(validateCorrectionLifecycleEvidence(evidence, targets)).toEqual({
      ok: true,
      code: '',
      taskId: 'task-stable',
      corrections: 3,
    });
    expect(validateCorrectionLifecycleEvidence([
      ...evidence.slice(0, 3),
      { ...evidence[3], taskId: 'task-replaced' },
    ], targets)).toMatchObject({ ok: false, code: 'task_correction_identity_changed' });
    expect(validateCorrectionLifecycleEvidence([
      ...evidence.slice(0, 3),
      { ...evidence[3], taskRevision: 3 },
    ], targets)).toMatchObject({ ok: false, code: 'task_correction_revision_not_advanced' });
    expect(validateCorrectionLifecycleEvidence([
      ...evidence.slice(0, 3),
      { ...evidence[3], taskTarget: targets[2], receiptTargets: [targets[2]] },
    ], targets)).toMatchObject({ ok: false, code: 'task_correction_target_not_updated' });
  });

  it('proves a status query did not create or replay a receipt', () => {
    const task = {
      taskId: 'task-status',
      target: 'D:\\formal\\status.txt',
      status: 'waiting_confirmation',
      activeRequest: false,
      revision: 2,
      evidence: {
        latest: [{
          receiptId: 'receipt-pending',
          requestId: 'request-create',
          toolName: 'write_file',
          targetIdentity: 'D:\\formal\\status.txt',
          outcome: 'waiting_confirmation',
          verification: 'unverified',
        }],
      },
    };
    const turnEvidence = {
      receiptIds: [],
      taskStateSignature: runtimeTaskStateSignature(task),
      userFacingReply: { persisted: true, internalGuardLeaked: false },
    };
    expect(runtimeReceiptSignature(task)).toContain('receipt-pending');
    expect(validateStatusQueryNoReplay({
      beforeTask: task,
      afterTask: structuredClone(task),
      turnEvidence,
      toolEventCount: 0,
    })).toEqual({ ok: true, code: '' });
    expect(validateStatusQueryNoReplay({
      beforeTask: task,
      afterTask: {
        ...task,
        evidence: { latest: [...task.evidence.latest, { receiptId: 'replayed' }] },
      },
      turnEvidence,
      toolEventCount: 0,
    })).toMatchObject({ ok: false, code: 'status_query_replayed_receipt' });
    expect(validateStatusQueryNoReplay({
      beforeTask: task,
      afterTask: { ...structuredClone(task), target: 'D:\\formal\\wrong.txt' },
      turnEvidence,
      toolEventCount: 0,
    })).toMatchObject({ ok: false, code: 'status_query_mutated_task_state' });
  });

  it('requires cancellation terminal state and a released request lease', () => {
    const evidence = { userFacingReply: { persisted: true, internalGuardLeaked: false } };
    expect(validateCancellationLeaseRelease({
      beforeTask: { taskId: 'task-cancel', target: 'D:\\formal\\cancel.txt', revision: 2 },
      afterTask: { taskId: 'task-cancel', target: 'D:\\formal\\cancel.txt', revision: 3, status: 'cancelled', activeRequest: false },
      turnEvidence: evidence,
    })).toEqual({ ok: true, code: '' });
    expect(validateCancellationLeaseRelease({
      beforeTask: { taskId: 'task-cancel', target: 'D:\\formal\\cancel.txt', revision: 2 },
      afterTask: { taskId: 'task-cancel', target: 'D:\\formal\\cancel.txt', revision: 3, status: 'cancelled', activeRequest: true },
      turnEvidence: evidence,
    })).toMatchObject({ ok: false, code: 'task_cancel_lease_not_released' });
  });

  it('accepts cross-channel confirmation only from persisted real voice records and the same task receipt', () => {
    const task = {
      taskId: 'task-voice',
      status: 'completed',
      activeRequest: false,
      evidence: {
        latest: [{
        receiptId: 'receipt-voice',
        taskId: 'task-voice',
        requestId: 'voice-request',
        toolName: 'write_file',
        verification: 'verified',
        createdAt: '2026-08-27T04:00:03.000Z',
        }],
      },
    };
    const messages = [
      {
        id: 'voice-user',
        role: 'user',
        requestId: 'voice-request',
        source: 'voice',
        channel: 'voice',
        message: '确认',
        timestamp: '2026-08-27T04:00:01.000Z',
      },
      {
        id: 'voice-assistant',
        role: 'assistant',
        requestId: 'voice-request',
        source: 'voice_confirmation',
        message: '已执行并验证。',
        timestamp: '2026-08-27T04:00:02.000Z',
        toolCalls: [{
          name: 'write_file',
          taskId: 'task-voice',
          arguments: { path: 'D:\\LumiE2EData\\manual.txt' },
          result: 'verified',
          terminalVerification: { status: 'verified' },
        }],
      },
    ];
    expect(validateManualVoiceConfirmationEvidence({
      messages,
      task,
      taskId: 'task-voice',
      toolName: 'write_file',
      expectedPath: 'D:\\LumiE2EData\\manual.txt',
      since: '2026-08-27T04:00:00.000Z',
    })).toMatchObject({
      ok: true,
      evidence: {
        taskId: 'task-voice',
        voiceUserMessageId: 'voice-user',
        voiceAssistantMessageId: 'voice-assistant',
        requestId: 'voice-request',
        receiptId: 'receipt-voice',
      },
    });
    expect(validateManualVoiceConfirmationEvidence({
      messages: messages.map(message => ({ ...message, channel: 'chat', source: 'chat' })),
      task,
      taskId: 'task-voice',
      toolName: 'write_file',
      expectedPath: 'D:\\LumiE2EData\\manual.txt',
      since: '2026-08-27T04:00:00.000Z',
    })).toMatchObject({ ok: false, code: 'manual_voice_confirmation_user_evidence_missing' });
    expect(validateManualVoiceConfirmationEvidence({
      messages: [messages[0], { ...messages[1], requestId: 'different-request' }],
      task: {
        ...task,
        evidence: {
          latest: [{
            ...task.evidence.latest[0],
            requestId: 'different-request',
          }],
        },
      },
      taskId: 'task-voice',
      toolName: 'write_file',
      expectedPath: 'D:\\LumiE2EData\\manual.txt',
      since: '2026-08-27T04:00:00.000Z',
    })).toMatchObject({ ok: false, code: 'manual_voice_confirmation_assistant_evidence_missing' });
    expect(validateManualVoiceConfirmationEvidence({
      messages,
      task: {
        ...task,
        evidence: {
          latest: [{ ...task.evidence.latest[0], createdAt: '2026-08-27T04:00:01.500Z' }],
        },
      },
      taskId: 'task-voice',
      toolName: 'write_file',
      expectedPath: 'D:\\LumiE2EData\\manual.txt',
      since: '2026-08-27T04:00:00.000Z',
    })).toMatchObject({ ok: false, code: 'manual_voice_confirmation_receipt_missing' });
  });

  it('requires the durable activation API and active-scope API to name the same conversation', () => {
    expect(validatePersistedConversationScope({
      conversationId: 'conversation-voice-gate',
      activated: { conversation: { id: 'conversation-voice-gate' } },
      active: { activeConversation: { id: 'conversation-voice-gate' } },
    })).toEqual({
      ok: true,
      code: '',
      evidence: {
        domain: 'personal',
        conversationId: 'conversation-voice-gate',
        activatedConversationId: 'conversation-voice-gate',
        activeApiConversationId: 'conversation-voice-gate',
      },
    });
    expect(validatePersistedConversationScope({
      conversationId: 'conversation-voice-gate',
      activated: { conversation: { id: 'conversation-voice-gate' } },
      active: { activeConversation: { id: 'another-conversation' } },
    })).toEqual({ ok: false, code: 'manual_voice_conversation_scope_not_active' });
  });

  it('requires twenty request-bound physical-microphone transcript pairs with real routing receipts', () => {
    const base = Date.parse('2026-08-27T05:00:00.000Z');
    const messages = Array.from({ length: 20 }, (_, index) => {
      const requestId = `voice-round-${index + 1}`;
      return [
        {
          id: `voice-user-${index + 1}`,
          role: 'user',
          requestId,
          source: 'voice',
          channel: 'voice',
          message: `physical microphone transcript ${index + 1}`,
          timestamp: new Date(base + index * 2_000).toISOString(),
          audioInputKind: 'physical_microphone',
          syntheticAudio: false,
          captureSessionId: 'capture-session-1',
          nativeDeviceId: 'native-device-1',
          sttReceiptId: `stt-${index + 1}`,
          contextChainId: 'voice-context-chain-1',
          previousRequestId: index === 0 ? '' : `voice-round-${index}`,
        },
        {
          id: `voice-assistant-${index + 1}`,
          role: 'assistant',
          requestId,
          source: 'voice',
          channel: 'voice',
          message: `natural reply ${index + 1}`,
          timestamp: new Date(base + index * 2_000 + 1_000).toISOString(),
          captureSessionId: 'capture-session-1',
          nativeDeviceId: 'native-device-1',
          contextChainId: 'voice-context-chain-1',
        },
      ];
    }).flat();
    const routingReceipts = Array.from({ length: 20 }, (_, index) => ({
      id: `route-${index + 1}`,
      requestId: `voice-round-${index + 1}`,
      source: 'voice',
      status: 'succeeded',
      latencyMs: 1_000,
      selectedProvider: 'lmstudio',
      selectedModel: 'local-model',
      fallbackReason: '',
      attempts: [{ provider: 'lmstudio', model: 'local-model', status: 'succeeded' }],
      captureSessionId: 'capture-session-1',
      nativeDeviceId: 'native-device-1',
      sttReceiptId: `stt-${index + 1}`,
      contextChainId: 'voice-context-chain-1',
    }));

    expect(validateManualVoiceConversationEvidence({
      messages,
      routingReceipts,
      since: '2026-08-27T05:00:00.000Z',
      expectedTurns: 20,
    })).toMatchObject({
      ok: true,
      evidence: { requiredTurns: 20, observedTurns: 20, syntheticSttEmitted: false },
    });
    expect(validateManualVoiceConversationEvidence({
      messages,
      routingReceipts: routingReceipts.slice(0, 19),
      since: '2026-08-27T05:00:00.000Z',
      expectedTurns: 20,
    })).toMatchObject({
      ok: false,
      code: 'manual_voice_routing_receipt_invalid',
      failedTurn: 20,
    });
    expect(validateManualVoiceConversationEvidence({
      messages,
      routingReceipts,
      since: '2026-08-27T05:00:00.000Z',
      expectedTurns: 19,
    })).toMatchObject({ ok: false, code: 'manual_voice_turn_requirement_below_formal_minimum' });
    expect(validateManualVoiceConversationEvidence({
      messages: messages.map(message => {
        if (message.role !== 'user') return message;
        const { captureSessionId: _captureSessionId, ...withoutCapture } = message;
        return withoutCapture;
      }),
      routingReceipts,
      since: '2026-08-27T05:00:00.000Z',
      expectedTurns: 20,
    })).toMatchObject({ ok: false, code: 'manual_voice_turn_count_incomplete' });
    expect(validateManualVoiceConversationEvidence({
      messages: messages.map(message => (
        message.role === 'assistant'
          ? { ...message, timestamp: new Date(base + 60_000).toISOString() }
          : message
      )),
      routingReceipts,
      since: '2026-08-27T05:00:00.000Z',
      expectedTurns: 20,
    })).toMatchObject({ ok: false, code: 'manual_voice_turns_overlap', failedTurn: 1 });
  });

  it('proves that a typed turn continues the same non-terminal voice task', () => {
    const messages = [
      { id: 'vu', role: 'user', requestId: 'voice-1', source: 'voice', channel: 'voice', message: 'start it', timestamp: '2026-08-27T06:00:00.000Z' },
      { id: 'va', role: 'assistant', requestId: 'voice-1', source: 'voice', channel: 'voice', message: 'waiting for the next detail', timestamp: '2026-08-27T06:00:01.000Z' },
      { id: 'tu', role: 'user', requestId: 'text-1', source: 'chat', channel: 'chat', message: 'continue with the corrected target', timestamp: '2026-08-27T06:00:02.000Z' },
      { id: 'ta', role: 'assistant', requestId: 'text-1', source: 'chat', channel: 'chat', message: 'continued and verified', timestamp: '2026-08-27T06:00:03.000Z' },
    ];
    const beforeTask = {
      taskId: 'task-cross-channel',
      conversationId: 'conversation-1',
      status: 'waiting_confirmation',
      revision: 4,
      evidence: { latest: [{ receiptId: 'voice-pending', requestId: 'voice-1', toolName: 'write_file' }] },
    };
    const afterTask = {
      taskId: 'task-cross-channel',
      conversationId: 'conversation-1',
      status: 'completed',
      revision: 5,
      evidence: { latest: [
        { receiptId: 'voice-pending', requestId: 'voice-1', toolName: 'write_file' },
        { receiptId: 'text-verified', requestId: 'text-1', toolName: 'write_file', verification: 'verified' },
      ] },
    };
    expect(validateVoiceToTextContinuationEvidence({
      messages,
      voiceRequestId: 'voice-1',
      textRequestId: 'text-1',
      beforeTask,
      afterTask,
    })).toMatchObject({
      ok: true,
      evidence: { taskId: 'task-cross-channel', revisionBefore: 4, revisionAfter: 5 },
    });
    expect(validateVoiceToTextContinuationEvidence({
      messages,
      voiceRequestId: 'voice-1',
      textRequestId: 'text-1',
      beforeTask,
      afterTask: { ...afterTask, taskId: 'replacement-task' },
    })).toMatchObject({ ok: false, code: 'cross_channel_task_identity_changed' });
  });

  it('proves a rejected confirmation settles without executing its side effect', () => {
    const messages = [{
      id: 'rejection-assistant',
      role: 'assistant',
      requestId: 'reject-request',
      source: 'chat',
      channel: 'chat',
      message: 'The pending operation was cancelled and was not executed.',
      timestamp: '2026-08-27T07:00:00.000Z',
    }];
    const beforeTask = { taskId: 'task-reject', status: 'waiting_confirmation', activeRequest: false };
    const afterTask = {
      taskId: 'task-reject',
      status: 'cancelled',
      activeRequest: false,
      evidence: { latest: [{ receiptId: 'pending', requestId: 'proposal', toolName: 'write_file', verification: 'pending' }] },
    };
    expect(validateConfirmationRejectionEvidence({
      messages,
      beforeTask,
      afterTask,
      rejectionRequestId: 'reject-request',
      toolName: 'write_file',
      artifactExists: false,
    })).toMatchObject({ ok: true, evidence: { sideEffectObserved: false } });
    expect(validateConfirmationRejectionEvidence({
      messages,
      beforeTask,
      afterTask,
      rejectionRequestId: 'reject-request',
      toolName: 'write_file',
      artifactExists: true,
    })).toMatchObject({ ok: false, code: 'confirmation_rejection_side_effect_observed' });
    expect(validateConfirmationRejectionEvidence({
      messages,
      beforeTask,
      afterTask: {
        ...afterTask,
        evidence: {
          latest: [{
            receiptId: 'executed-despite-rejection',
            requestId: 'reject-request',
            toolName: 'write_file',
            verification: 'unverified',
            outcome: 'succeeded',
          }],
        },
      },
      rejectionRequestId: 'reject-request',
      toolName: 'write_file',
      artifactExists: false,
    })).toMatchObject({ ok: false, code: 'confirmation_rejection_executed_tool' });
  });

  it('proves a repeated confirmation cannot execute the exact action twice', () => {
    const receipt = {
      receiptId: 'verified-once',
      requestId: 'confirm-first',
      toolName: 'write_file',
      outcome: 'succeeded',
      verification: 'verified',
    };
    const afterFirstTask = {
      taskId: 'task-confirm-once',
      status: 'completed',
      activeRequest: false,
      evidence: { latest: [receipt] },
    };
    const afterRepeatedTask = structuredClone(afterFirstTask);
    const messages = [{
      id: 'repeat-assistant',
      role: 'assistant',
      requestId: 'confirm-repeat',
      source: 'chat',
      channel: 'chat',
      message: 'There is no pending operation to execute again.',
      timestamp: '2026-08-27T08:00:00.000Z',
    }];
    expect(validateRepeatedConfirmationIdempotencyEvidence({
      messages,
      afterFirstTask,
      afterRepeatedTask,
      firstRequestId: 'confirm-first',
      repeatedRequestId: 'confirm-repeat',
      toolName: 'write_file',
      artifactSha256Before: 'same-digest',
      artifactSha256After: 'same-digest',
      artifactMtimeMsBefore: 1234,
      artifactMtimeMsAfter: 1234,
      artifactSizeBefore: 42,
      artifactSizeAfter: 42,
    })).toMatchObject({ ok: true, evidence: { verifiedExecutions: 1 } });

    expect(validateRepeatedConfirmationIdempotencyEvidence({
      messages,
      afterFirstTask,
      afterRepeatedTask,
      firstRequestId: 'confirm-first',
      repeatedRequestId: 'confirm-repeat',
      toolName: 'write_file',
      artifactSha256Before: 'same-digest',
      artifactSha256After: 'same-digest',
      artifactMtimeMsBefore: 1234,
      artifactMtimeMsAfter: 1235,
      artifactSizeBefore: 42,
      artifactSizeAfter: 42,
    })).toMatchObject({ ok: false, code: 'confirmation_repeat_artifact_metadata_changed' });

    expect(validateRepeatedConfirmationIdempotencyEvidence({
      messages,
      afterFirstTask,
      afterRepeatedTask: {
        ...afterRepeatedTask,
        evidence: { latest: [receipt, { ...receipt, receiptId: 'second', requestId: 'confirm-repeat' }] },
      },
      firstRequestId: 'confirm-first',
      repeatedRequestId: 'confirm-repeat',
      toolName: 'write_file',
      artifactSha256Before: 'same-digest',
      artifactSha256After: 'same-digest',
      artifactMtimeMsBefore: 1234,
      artifactMtimeMsAfter: 1234,
      artifactSizeBefore: 42,
      artifactSizeAfter: 42,
    })).toMatchObject({ ok: false, code: 'confirmation_repeat_executed_twice' });
  });

  it('finds only a runtime task with the exact run marker in its durable goal', () => {
    expect(findRuntimeTaskByMarker({ tasks: [
      { taskId: 'other', goal: 'unrelated' },
      { taskId: 'owned', goal: '[LUMI-E2E-owned] create file' },
    ] }, 'LUMI-E2E-owned')).toMatchObject({ taskId: 'owned' });
    expect(findRuntimeTaskByMarker({ tasks: [] }, 'missing')).toBeNull();
  });
});
