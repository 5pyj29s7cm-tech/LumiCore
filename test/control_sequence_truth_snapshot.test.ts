import { describe, expect, it } from 'vitest';
import {
  buildControlSequenceTruthSnapshotFromSources,
  CONTROL_SEQUENCE_TRUTH_SNAPSHOT_KIND,
} from '../server/evidence/control_sequence_truth_snapshot';
import { buildProviderOutboundMessagesEvidence } from '../server/llm/outbound_message_evidence';
import { validateTaskTruthSnapshot } from '../scripts/lib/task-regression-matrix.mjs';

const times = {
  long: '2026-08-27T10:00:00.000Z',
  providerStart: '2026-08-27T10:00:00.050Z',
  stopUser: '2026-08-27T10:00:00.300Z',
  providerDone: '2026-08-27T10:00:00.390Z',
  cancelled: '2026-08-27T10:00:00.400Z',
  stop: '2026-08-27T10:00:00.500Z',
  statusUser: '2026-08-27T10:00:00.600Z',
  status: '2026-08-27T10:00:00.700Z',
  repeatUser: '2026-08-27T10:00:00.800Z',
  repeat: '2026-08-27T10:00:00.900Z',
  captured: '2026-08-27T10:00:01.000Z',
};

const requests = {
  long: 'request-s5-long',
  status: 'request-s5-status',
  stop: 'request-s5-stop',
  repeat: 'request-s5-repeat',
};

const stoppedText = '已停止当前任务，未完成的步骤不会继续执行。';
const statusText = '当前任务仍在执行，暂时还没有终态回执。';

function interaction(
  id: string,
  requestId: string,
  role: 'user' | 'assistant',
  message: string,
  timestamp: string,
  cognitiveIntent = '',
) {
  return {
    id,
    userId: 'user-s5',
    conversationId: 'conversation-s5',
    requestId,
    role,
    message,
    timestamp,
    cognitiveIntent,
    toolCalls: [],
  };
}

function terminalReceipt(input: {
  requestId: string;
  status: 'cancelled' | 'completed';
  sidecar: boolean;
  reason: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  controlIntent?: 'cancel' | 'status';
  targetRequestId?: string;
}) {
  return {
    userId: 'user-s5',
    domain: 'personal',
    orgId: '',
    source: 'task-regression-black-box',
    conversationId: 'conversation-s5',
    requestId: input.requestId,
    status: input.status,
    event: 'agent:response',
    payload: {
      requestId: input.requestId,
      conversationId: 'conversation-s5',
      source: 'task-regression-black-box',
      sidecar: input.sidecar,
      finalized: true,
      blocked: false,
      reason: input.reason,
      text: input.text,
      ...(input.controlIntent ? { controlIntent: input.controlIntent } : {}),
      ...(input.targetRequestId ? { targetRequestId: input.targetRequestId } : {}),
    },
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    expiresAt: '2026-08-27T10:30:00.000Z',
  };
}

function fixture() {
  const mainOutbound = buildProviderOutboundMessagesEvidence({
    provider: 'openai',
    model: 'lumi-regression-stub-v1',
    requestFormat: 'openai_compatible',
    messages: [
      { role: 'system', content: 'isolated regression system' },
      { role: 'user', content: '[LUMI_REGRESSION:S5:LONG] long task' },
    ],
    sourceMessageId: 'message-long-user',
    sourceMessageIndex: 1,
  });
  const classifierOutbound = buildProviderOutboundMessagesEvidence({
    provider: 'openai',
    model: 'lumi-regression-stub-v1',
    requestFormat: 'openai_compatible',
    messages: [{ role: 'user', content: '开始一个新任务' }],
  });
  const db = {
    conversations: [{
      id: 'conversation-s5',
      userId: 'user-s5',
      actionContinuationState: null,
    }],
    conversationActionTasks: [],
    conversationActionTurns: Object.values(requests).map(requestId => ({
      userId: 'user-s5',
      conversationId: 'conversation-s5',
      requestId,
      taskId: '',
    })),
    conversationActionReceipts: [],
    interactions: [
      interaction('message-long-user', requests.long, 'user', '[LUMI_REGRESSION:S5:LONG] long task', times.long),
      interaction('message-stop-user', requests.stop, 'user', '停止', times.stopUser, 'task_cancel'),
      interaction('message-long-assistant', requests.long, 'assistant', stoppedText, times.cancelled, 'task_cancelled'),
      interaction('message-stop-assistant', requests.stop, 'assistant', stoppedText, times.stop, 'task_cancel'),
      interaction('message-status-user', requests.status, 'user', '你在干嘛', times.statusUser, 'task_status'),
      interaction('message-status-assistant', requests.status, 'assistant', statusText, times.status, 'task_status'),
      interaction('message-repeat-user', requests.repeat, 'user', '怎么说', times.repeatUser),
      interaction('message-repeat-assistant', requests.repeat, 'assistant', statusText, times.repeat, 'task_repeat'),
    ],
    modelRoutingReceipts: [{
      id: 'routing-classifier',
      userId: 'user-s5',
      conversationId: 'conversation-s5',
      requestId: requests.long,
      source: 'chat_intent_classifier',
      status: 'failed',
      completedAt: '2026-08-27T10:00:00.080Z',
      attempts: [{
        provider: 'openai',
        model: 'lumi-regression-stub-v1',
        status: 'failed',
        errorCategory: 'cancelled',
        startedAt: times.long,
        outboundMessagesEvidence: classifierOutbound,
      }],
    }, {
      id: 'routing-main',
      userId: 'user-s5',
      conversationId: 'conversation-s5',
      requestId: requests.long,
      source: 'chat',
      status: 'failed',
      completedAt: times.providerDone,
      attempts: [{
        provider: 'openai',
        model: 'lumi-regression-stub-v1',
        status: 'failed',
        errorCategory: 'cancelled',
        startedAt: times.providerStart,
        completedAt: times.providerDone,
        outboundMessagesEvidence: mainOutbound,
      }],
    }],
  };
  const chatExecutionReceipts = [
    terminalReceipt({
      requestId: requests.long,
      status: 'cancelled',
      sidecar: false,
      reason: 'request_cancelled',
      text: stoppedText,
      createdAt: times.long,
      updatedAt: times.cancelled,
    }),
    terminalReceipt({
      requestId: requests.status,
      status: 'completed',
      sidecar: true,
      reason: 'target_execution_status',
      text: statusText,
      createdAt: times.statusUser,
      updatedAt: times.status,
      controlIntent: 'status',
      targetRequestId: requests.long,
    }),
    terminalReceipt({
      requestId: requests.stop,
      status: 'completed',
      sidecar: true,
      reason: 'cancelled_by_user',
      text: stoppedText,
      createdAt: times.stopUser,
      updatedAt: times.stop,
      controlIntent: 'cancel',
      targetRequestId: requests.long,
    }),
    terminalReceipt({
      requestId: requests.repeat,
      status: 'completed',
      sidecar: false,
      reason: 'repeat_previous_reply',
      text: statusText,
      createdAt: times.repeatUser,
      updatedAt: times.repeat,
    }),
  ];
  return { db, chatExecutionReceipts };
}

function input(value = fixture()) {
  return {
    ...value,
    snapshotId: 'control-truth-snapshot-1',
    scenarioId: 'control_stop_status_repeat',
    acceptanceRunId: 'task_regression_candidate_s5',
    buildIdentityDigest: 'a'.repeat(64),
    userId: 'user-s5',
    conversationId: 'conversation-s5',
    requestId: requests.long,
    phaseRequestIds: requests,
    capturedAt: times.captured,
  };
}

describe('S5 request-only control sequence truth', () => {
  it('binds four manifest phases without inventing a task or tool receipt', () => {
    const snapshot = buildControlSequenceTruthSnapshotFromSources(input());
    expect(snapshot.kind).toBe(CONTROL_SEQUENCE_TRUTH_SNAPSHOT_KIND);
    expect(snapshot.conversation).toMatchObject({
      livePointerState: 'cleared',
      durableActionTaskCount: 0,
    });
    expect(snapshot.longExecution.providerOutbound).toMatchObject({
      requestId: requests.long,
      turnNonce: 'message-long-user',
      routingSource: 'chat',
      digestProtection: 'installation_hmac_sha256_v1',
      routingStatus: 'failed',
      errorCategory: 'cancelled',
      totalExecutionMs: 350,
      cancellationLatencyMs: 100,
      maximumCancellationLatencyMs: 5_000,
    });
    expect(snapshot.controls.stop.terminal).toMatchObject({
      controlIntent: 'cancel',
      targetRequestId: requests.long,
    });
    expect(snapshot.controls.repeat.noExecution).toEqual({
      modelRoutingReceiptCount: 0,
      actionTurnCount: 1,
      taskBoundActionTurnCount: 0,
      actionReceiptCount: 0,
      assistantToolCallCount: 0,
    });
    expect(snapshot.repeatEquality).toMatchObject({ exact: true, sourceRequestId: requests.status });
    expect(validateTaskTruthSnapshot(snapshot)).toEqual({ ok: true, value: snapshot });
  });

  it('rejects a caller-style duplicate phase request id', () => {
    const value = input();
    value.phaseRequestIds = { ...requests, repeat: requests.stop };
    expect(() => buildControlSequenceTruthSnapshotFromSources(value)).toThrow(
      'task_truth_snapshot_control_request_binding_ambiguous',
    );
  });

  it('rejects a stop receipt not durably fenced to the long request', () => {
    const value = fixture();
    value.chatExecutionReceipts[2].payload.targetRequestId = 'another-request';
    expect(() => buildControlSequenceTruthSnapshotFromSources(input(value)))
      .toThrow('task_truth_snapshot_control_stop_target_mismatch');
  });

  it('rejects any model or tool execution in repeat', () => {
    const value = fixture();
    value.db.modelRoutingReceipts.push({
      id: 'routing-repeat-forbidden',
      userId: 'user-s5',
      conversationId: 'conversation-s5',
      requestId: requests.repeat,
      source: 'chat',
      status: 'failed',
      completedAt: times.repeat,
      attempts: [],
    });
    expect(() => buildControlSequenceTruthSnapshotFromSources(input(value)))
      .toThrow('task_truth_snapshot_control_unexpected_execution');
  });

  it('rejects non-adjacent repeat and an over-budget cancellation', () => {
    const nonAdjacent = fixture();
    nonAdjacent.db.interactions.splice(6, 0, interaction(
      'message-interloper',
      'request-interloper',
      'assistant',
      'intervening answer',
      '2026-08-27T10:00:00.550Z',
    ));
    expect(() => buildControlSequenceTruthSnapshotFromSources(input(nonAdjacent)))
      .toThrow('task_truth_snapshot_control_repeat_not_adjacent');

    const statusNotAdjacent = fixture();
    statusNotAdjacent.db.interactions.splice(4, 0, interaction(
      'message-status-interloper',
      'request-status-interloper',
      'assistant',
      'intervening answer',
      '2026-08-27T10:00:00.550Z',
    ));
    expect(() => buildControlSequenceTruthSnapshotFromSources(input(statusNotAdjacent)))
      .toThrow('task_truth_snapshot_control_status_not_adjacent_to_stop');

    const slow = fixture();
    slow.chatExecutionReceipts[2].createdAt = '2026-08-27T09:59:50.000Z';
    expect(() => buildControlSequenceTruthSnapshotFromSources(input(slow)))
      .toThrow('task_truth_snapshot_control_cancellation_latency_exceeded');
  });

  it('rejects a tampered provider attestation instead of treating it as a nonce witness', () => {
    const value = fixture();
    value.db.modelRoutingReceipts[1].attempts[0]
      .outboundMessagesEvidence.attestationSha256 = 'f'.repeat(64);
    expect(() => buildControlSequenceTruthSnapshotFromSources(input(value)))
      .toThrow('task_truth_snapshot_control_provider_binding_missing');
  });
});
