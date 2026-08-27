import { describe, expect, it } from 'vitest';
import {
  buildTaskTruthSnapshotFromSources,
  TASK_TRUTH_SNAPSHOT_KIND,
} from '../server/evidence/task_truth_snapshot';
import {
  buildProviderOutboundMessagesEvidence,
} from '../server/llm/outbound_message_evidence';
import { buildToolExecutionEnvelope } from '../server/tools/execution_envelope';
import { validateTaskTruthSnapshot } from '../scripts/lib/task-regression-matrix.mjs';

const at = '2026-08-27T10:00:00.000Z';
const sha = (digit: string) => digit.repeat(64);

function fixture() {
  const outboundMessagesEvidence = buildProviderOutboundMessagesEvidence({
    provider: 'lmstudio',
    model: 'local-model',
    requestFormat: 'openai_compatible',
    messages: [
      { role: 'system', content: 's'.repeat(20) },
      { role: 'user', content: 'u'.repeat(12) },
    ],
    toolDeclarations: [],
    sourceMessageId: 'user-message-1',
    sourceMessageIndex: 1,
  });
  return {
    conversations: [{
      id: 'conversation-1',
      userId: 'user-1',
      actionContinuationState: {
        taskId: 'task-1',
        activeRequestId: 'request-1',
        status: 'executing',
        unfinished: true,
      },
    }],
    conversationActionTasks: [{
      id: 'task-1',
      conversationId: 'conversation-1',
      userId: 'user-1',
      domain: 'personal',
      orgId: '',
      status: 'executing',
      goal: 'Analyze the confirmed WPS presentation.',
      target: 'D:/Desktop/confirmed.pptx',
      activeRequestId: 'request-1',
      revision: 3,
      updatedAt: at,
    }],
    conversationActionTurns: [{
      id: 'turn-1',
      conversationId: 'conversation-1',
      userId: 'user-1',
      requestId: 'request-1',
      taskId: 'task-1',
      status: 'terminal',
      terminalMessageId: 'assistant-1',
      channel: 'chat',
      updatedAt: at,
      createdAt: at,
    }],
    conversationActionReceipts: [{
      id: 'receipt-1',
      taskId: 'task-1',
      conversationId: 'conversation-1',
      requestId: 'request-1',
      modelRoutingReceiptId: 'routing-1',
      toolName: 'wps_read_active_document',
      targetIdentity: 'D:/Desktop/confirmed.pptx',
      outcome: 'verified_success',
      createdAt: at,
    }],
    interactions: [{
      id: 'user-message-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      requestId: 'request-1',
      role: 'user',
      message: '不是这份，请分析 confirmed.pptx。',
      timestamp: at,
    }, {
      id: 'assistant-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      requestId: 'request-1',
      role: 'assistant',
      message: '已读取并核对 confirmed.pptx。',
      timestamp: at,
    }],
    modelRoutingReceipts: [{
      id: 'routing-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      requestId: 'request-1',
      completedAt: at,
      attempts: [{
        provider: 'lmstudio',
        model: 'local-model',
        status: 'succeeded',
        outboundMessagesEvidence,
      }],
    }],
  };
}

function input(db: any) {
  return {
    db,
    snapshotId: 'snapshot-1',
    scenarioId: 'wps_wrong_file_correction',
    acceptanceRunId: 'run-1',
    buildIdentityDigest: sha('e'),
    userId: 'user-1',
    conversationId: 'conversation-1',
    requestId: 'request-1',
    taskId: 'task-1',
    capturedAt: at,
  };
}

describe('task truth snapshot collector', () => {
  it('cross-binds the persisted transcript, task, turn, receipt, target and provider payload', () => {
    const db = fixture();
    const snapshot = buildTaskTruthSnapshotFromSources(input(db));

    expect(snapshot.kind).toBe(TASK_TRUTH_SNAPSHOT_KIND);
    expect(snapshot.userVisibleReply).toMatchObject({ messageId: 'assistant-1' });
    expect(snapshot.task.taskId).toBe('task-1');
    expect(snapshot.request).toMatchObject({ requestId: 'request-1', taskId: 'task-1' });
    expect(snapshot.receipt).toMatchObject({
      receiptId: 'receipt-1',
      requestId: 'request-1',
      taskId: 'task-1',
      toolName: 'wps_read_active_document',
      status: 'succeeded',
    });
    expect(snapshot.toolTarget).toMatchObject({
      targetType: 'filesystem_path',
      targetId: 'D:/Desktop/confirmed.pptx',
      displayName: 'confirmed.pptx',
    });
    expect(snapshot.pointers.live).toMatchObject({
      state: 'set',
      taskId: 'task-1',
      requestId: 'request-1',
    });
    expect(snapshot.pointers.pending).toMatchObject({ state: 'cleared', taskId: null });
    expect(snapshot.modelActualInput).toMatchObject({
      captureOrigin: 'provider_dispatch_boundary',
      modelInvoked: true,
      requestId: 'request-1',
      taskId: 'task-1',
      provider: 'lmstudio',
      messagesSha256: db.modelRoutingReceipts[0].attempts[0]
        .outboundMessagesEvidence.messagesSha256,
      messageCount: 2,
    });
    expect(JSON.stringify(snapshot.modelActualInput)).not.toContain('Analyze the confirmed');
    expect(validateTaskTruthSnapshot(snapshot)).toEqual({ ok: true, value: snapshot });
  });

  it('records the exact pending confirmation pointer without accepting caller-authored state', () => {
    const snapshot = buildTaskTruthSnapshotFromSources({
      ...input(fixture()),
      pendingConfirmation: {
        id: 'pending-1',
        userId: 'user-1',
        toolName: 'wps_read_active_document',
        argsHash: sha('1'),
        target: 'D:/Desktop/confirmed.pptx',
        payloadDigest: sha('2'),
        exactArgs: {},
        safeArgs: {},
        actionIntent: 'read current WPS file',
        source: 'chat',
        domain: 'personal',
        orgId: '',
        channelId: 'chat',
        taskId: 'task-1',
        originRequestId: 'request-1',
        createdAt: at,
        expiresAt: Date.parse(at) + 60_000,
      },
    });

    expect(snapshot.pointers.pending).toEqual({
      state: 'set',
      taskId: 'task-1',
      requestId: 'request-1',
      recordId: 'pending-1',
      observedAt: at,
    });
  });

  it('fails closed when a turn is bound to another task', () => {
    const db = fixture();
    db.conversationActionTurns[0].taskId = 'task-other';
    expect(() => buildTaskTruthSnapshotFromSources(input(db)))
      .toThrow('task_truth_snapshot_request_task_mismatch');
  });

  it('does not guess the model call from request recency when the tool receipt has no binding', () => {
    const db = fixture();
    delete db.conversationActionReceipts[0].modelRoutingReceiptId;
    expect(() => buildTaskTruthSnapshotFromSources(input(db)))
      .toThrow('task_truth_snapshot_model_receipt_binding_missing');
  });

  it('uses the terminal assistant receipt binding instead of the newest receipt for a multi-tool request', () => {
    const db: any = fixture();
    db.conversationActionReceipts[0].turnId = 'user-message-1';
    db.interactions[1].toolCalls = [{
      id: 'receipt-1',
      name: 'wps_read_active_document',
    }];
    db.conversationActionReceipts.push({
      ...db.conversationActionReceipts[0],
      id: 'receipt-newer-but-not-terminal',
      turnId: 'user-message-1',
      toolName: 'desktop_open',
      targetIdentity: 'D:/Desktop/wrong-newer.pptx',
      createdAt: '2026-08-27T10:00:01.000Z',
    });

    const snapshot = buildTaskTruthSnapshotFromSources(input(db));
    expect(snapshot.receipt).toMatchObject({
      receiptId: 'receipt-1',
      toolName: 'wps_read_active_document',
    });
    expect(snapshot.toolTarget.targetId).toBe('D:/Desktop/confirmed.pptx');
  });

  it('fails closed when a multi-tool request has no unique terminal or turn receipt binding', () => {
    const db: any = fixture();
    db.conversationActionReceipts[0].turnId = 'user-message-1';
    db.interactions[1].toolCalls = [{ id: 'receipt-1' }, { id: 'receipt-2' }];
    db.conversationActionReceipts.push({
      ...db.conversationActionReceipts[0],
      id: 'receipt-2',
      toolName: 'desktop_open',
      targetIdentity: 'D:/Desktop/other.pptx',
      createdAt: '2026-08-27T10:00:01.000Z',
    });

    expect(() => buildTaskTruthSnapshotFromSources(input(db)))
      .toThrow('task_truth_snapshot_receipt_binding_ambiguous');
  });

  it('selects the one manifest-derived logical receipt instead of guessing among request siblings', () => {
    const db: any = fixture();
    db.conversationActionReceipts[0].toolName = 'extract_document_text';
    db.conversationActionReceipts.push({
      ...db.conversationActionReceipts[0],
      id: 'receipt-active-window',
      toolName: 'desktop_active_window',
      targetIdentity: 'WPS-Quarterly-Review-Draft.pptx',
      createdAt: '2026-08-27T09:59:59.000Z',
    });
    db.interactions[1].toolCalls = [{
      id: 'receipt-active-window',
      name: 'desktop_active_window',
    }, {
      id: 'receipt-1',
      name: 'extract_document_text',
    }];

    const snapshot = buildTaskTruthSnapshotFromSources({
      ...input(db),
      receiptToolName: 'extract_document_text',
    });
    expect(snapshot.receipt).toMatchObject({
      receiptId: 'receipt-1',
      toolName: 'extract_document_text',
    });
    expect(snapshot.toolTarget.targetId).toBe('D:/Desktop/confirmed.pptx');
  });

  it('fails closed when the manifest-derived logical receipt selector is not unique', () => {
    const db: any = fixture();
    db.conversationActionReceipts[0].toolName = 'extract_document_text';
    db.conversationActionReceipts.push({
      ...db.conversationActionReceipts[0],
      id: 'receipt-read-file-duplicate',
      targetIdentity: 'D:/Desktop/other-confirmed.pptx',
      createdAt: '2026-08-27T10:00:01.000Z',
    });

    expect(() => buildTaskTruthSnapshotFromSources({
      ...input(db),
      receiptToolName: 'extract_document_text',
    })).toThrow('task_truth_snapshot_receipt_binding_ambiguous');
  });

  it('records a runtime-proved no-model boundary for an exact confirmed action resume', () => {
    const db = fixture();
    delete db.conversationActionReceipts[0].modelRoutingReceiptId;
    (db.conversationActionReceipts[0] as any).executionOrigin = 'confirmed_action_resume';

    const snapshot = buildTaskTruthSnapshotFromSources(input(db));
    expect(snapshot.modelActualInput).toEqual({
      captureId: 'receipt-1:deterministic-selection',
      captureOrigin: 'deterministic_tool_selection_boundary',
      modelInvoked: false,
      recordId: 'receipt-1',
      requestId: 'request-1',
      taskId: 'task-1',
      executionOrigin: 'confirmed_action_resume',
      reason: expect.stringContaining('one-time confirmation'),
      recordedAt: at,
    });
    expect(validateTaskTruthSnapshot(snapshot)).toEqual({ ok: true, value: snapshot });
  });

  it('accepts the deterministic exact-task-set target for runtime cleanup', () => {
    const db = fixture();
    const envelope = buildToolExecutionEnvelope({
      name: 'runtime_work_cancel',
      arguments: { taskIds: ['runtime-b', 'runtime-a', 'runtime-b'] },
      result: JSON.stringify({ ok: true, status: 'cancelled', matchedCount: 2 }),
      terminalVerification: {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: 'Every exact runtime task target is cancelled.',
      },
    });
    delete db.conversationActionReceipts[0].modelRoutingReceiptId;
    (db.conversationActionReceipts[0] as any).executionOrigin = 'deterministic_route';
    db.conversationActionReceipts[0].toolName = 'runtime_work_cancel';
    db.conversationActionReceipts[0].targetIdentity = envelope.targetIdentity;

    const snapshot = buildTaskTruthSnapshotFromSources(input(db));

    expect(snapshot.toolTarget).toMatchObject({
      targetType: 'tool_target',
      targetId: envelope.targetIdentity,
      source: 'conversation_action_receipts.targetIdentity',
    });
    expect(snapshot.modelActualInput).toMatchObject({
      captureOrigin: 'deterministic_tool_selection_boundary',
      modelInvoked: false,
      executionOrigin: 'deterministic_route',
    });
    expect(validateTaskTruthSnapshot(snapshot)).toEqual({ ok: true, value: snapshot });
  });

  it('fails closed when the receipt target is absent', () => {
    const db = fixture();
    db.conversationActionReceipts[0].targetIdentity = '';
    expect(() => buildTaskTruthSnapshotFromSources(input(db)))
      .toThrow('task_truth_snapshot_tool_target_missing');
  });

  it('fails closed when no provider-bound message digest was persisted', () => {
    const db = fixture();
    delete db.modelRoutingReceipts[0].attempts[0].outboundMessagesEvidence.messages[1].contentSha256;
    expect(() => buildTaskTruthSnapshotFromSources(input(db)))
      .toThrow('task_truth_snapshot_model_actual_input_invalid');
  });

  it('rejects incomplete or caller-shaped provider evidence', () => {
    const db = fixture();
    delete db.modelRoutingReceipts[0].attempts[0]
      .outboundMessagesEvidence.kind;
    expect(() => buildTaskTruthSnapshotFromSources(input(db)))
      .toThrow('task_truth_snapshot_model_actual_input_invalid');
  });

  it('rejects a provider source id that is not the current durable user turn', () => {
    const db = fixture();
    db.modelRoutingReceipts[0].attempts[0].outboundMessagesEvidence =
      buildProviderOutboundMessagesEvidence({
        provider: 'lmstudio',
        model: 'local-model',
        requestFormat: 'openai_compatible',
        messages: [
          { role: 'system', content: 's'.repeat(20) },
          { role: 'user', content: 'u'.repeat(12) },
        ],
        sourceMessageId: 'assistant-1',
        sourceMessageIndex: 1,
      });
    expect(() => buildTaskTruthSnapshotFromSources(input(db)))
      .toThrow('task_truth_snapshot_model_source_record_missing');
  });

  it('rejects a live pointer owned by another task instead of hiding contamination', () => {
    const db = fixture();
    db.conversations[0].actionContinuationState.taskId = 'task-other';
    expect(() => buildTaskTruthSnapshotFromSources(input(db)))
      .toThrow('task_truth_snapshot_live_pointer_task_mismatch');
  });
});
