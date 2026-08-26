import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildLifecycleTurnEvidence,
  buildOwnedArtifactLayout,
  cleanOwnedArtifactLayout,
  containsInternalExecutionBlock,
  evidenceTextHash,
  findRuntimeTaskByMarker,
  isVerifiedForcedFailoverProbe,
  isPathInside,
  isLoopbackBaseUrl,
  parseWorkerReceiptCount,
  runtimeReceiptSignature,
  validateCancellationLeaseRelease,
  validateCorrectionLifecycleEvidence,
  validateManualVoiceConfirmationEvidence,
  validatePersistedConversationScope,
  validateRoutingTrace,
  validateStatusQueryNoReplay,
} from '../scripts/formal-client-e2e.mjs';

describe('formal native-client E2E safety helpers', () => {
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
    }, { allowProviderProbe: true }).ok).toBe(true);
    expect(validateRoutingTrace({
      ok: true,
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
      selectedProvider: 'b',
      selectedModel: 'm2',
      fallbackReason: '',
      attempts: [
        { provider: 'a', model: 'm1', status: 'failed' },
        { provider: 'b', model: 'm2', status: 'succeeded' },
      ],
    }).ok).toBe(false);
  });

  it('accepts only a deterministic failed-primary to successful-alternate probe', () => {
    const probe = {
      ok: true,
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
    const layout = buildOwnedArtifactLayout(dataRoot, 'LUMI-E2E-cleanup_01');
    fs.mkdirSync(layout.root, { recursive: true });
    fs.writeFileSync(layout.files[0], 'owned-evidence', 'utf8');
    expect(cleanOwnedArtifactLayout(layout)).toEqual({ ok: true, failedCount: 0 });
    expect(fs.existsSync(layout.files[0])).toBe(false);
    expect(fs.existsSync(layout.root)).toBe(false);
    expect(fs.existsSync(layout.parent)).toBe(false);
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
      evidence: {
        latest: [{
          receiptId: 'receipt-1',
          requestId: 'request-1',
          toolName: 'write_file',
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
      receiptLedger: {
        signature: 'receipt-1:request-1:write_file:waiting_confirmation:unverified',
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
    const evidence = [1, 2, 3, 4].map(revision => ({
      requestId: `request-${revision}`,
      taskId: 'task-stable',
      taskRevision: revision,
      userMessageId: `user-${revision}`,
      assistantMessageId: `assistant-${revision}`,
      userFacingReply: { persisted: true, internalGuardLeaked: false },
    }));
    expect(validateCorrectionLifecycleEvidence(evidence)).toEqual({
      ok: true,
      code: '',
      taskId: 'task-stable',
      corrections: 3,
    });
    expect(validateCorrectionLifecycleEvidence([
      ...evidence.slice(0, 3),
      { ...evidence[3], taskId: 'task-replaced' },
    ])).toMatchObject({ ok: false, code: 'task_correction_identity_changed' });
    expect(validateCorrectionLifecycleEvidence([
      ...evidence.slice(0, 3),
      { ...evidence[3], taskRevision: 3 },
    ])).toMatchObject({ ok: false, code: 'task_correction_revision_not_advanced' });
  });

  it('proves a status query did not create or replay a receipt', () => {
    const task = {
      taskId: 'task-status',
      evidence: {
        latest: [{
          receiptId: 'receipt-pending',
          requestId: 'request-create',
          toolName: 'write_file',
          outcome: 'waiting_confirmation',
          verification: 'unverified',
        }],
      },
    };
    const turnEvidence = {
      receiptIds: [],
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
  });

  it('requires cancellation terminal state and a released request lease', () => {
    const evidence = { userFacingReply: { persisted: true, internalGuardLeaked: false } };
    expect(validateCancellationLeaseRelease({
      beforeTask: { taskId: 'task-cancel' },
      afterTask: { taskId: 'task-cancel', status: 'cancelled', activeRequest: false },
      turnEvidence: evidence,
    })).toEqual({ ok: true, code: '' });
    expect(validateCancellationLeaseRelease({
      beforeTask: { taskId: 'task-cancel' },
      afterTask: { taskId: 'task-cancel', status: 'cancelled', activeRequest: true },
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
        }],
      },
    };
    const messages = [
      {
        id: 'voice-user',
        role: 'user',
        requestId: 'voice-request',
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

  it('finds only a runtime task with the exact run marker in its durable goal', () => {
    expect(findRuntimeTaskByMarker({ tasks: [
      { taskId: 'other', goal: 'unrelated' },
      { taskId: 'owned', goal: '[LUMI-E2E-owned] create file' },
    ] }, 'LUMI-E2E-owned')).toMatchObject({ taskId: 'owned' });
    expect(findRuntimeTaskByMarker({ tasks: [] }, 'missing')).toBeNull();
  });
});
