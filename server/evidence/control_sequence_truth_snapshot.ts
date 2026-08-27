import { createHash, randomUUID } from 'node:crypto';
import { querySQL, readDB } from '../../db_layer';
import {
  normalizeProviderOutboundMessagesEvidence,
} from '../llm/outbound_message_evidence';

export const CONTROL_SEQUENCE_TRUTH_SNAPSHOT_KIND =
  'lumi.control-sequence-truth-snapshot' as const;
export const CONTROL_SEQUENCE_TRUTH_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const CONTROL_STOP_STATUS_REPEAT_SCENARIO = 'control_stop_status_repeat' as const;

export const CONTROL_SEQUENCE_PHASE_IDS = Object.freeze([
  'long',
  'stop',
  'status',
  'repeat',
] as const);

export type ControlSequencePhaseId = typeof CONTROL_SEQUENCE_PHASE_IDS[number];
export type ControlSequenceRequestIds = Record<ControlSequencePhaseId, string>;

type ControlMessageEvidence = {
  recordId: string;
  messageId: string;
  requestId: string;
  role: 'user' | 'assistant';
  cognitiveIntent: string;
  text: string;
  textSha256: string;
  textCharCount: number;
  transcriptIndex: number;
  recordedAt: string;
};

type ControlTerminalEvidence = {
  recordId: string;
  requestId: string;
  status: 'cancelled' | 'completed';
  event: 'agent:response';
  sidecar: boolean;
  finalized: true;
  blocked: false;
  reason: string;
  text: string;
  textSha256: string;
  controlIntent: 'cancel' | 'status' | null;
  targetRequestId: string | null;
  createdAt: string;
  updatedAt: string;
};

type NoExecutionEvidence = {
  modelRoutingReceiptCount: 0;
  /** Every accepted chat request has one durable request ledger row. */
  actionTurnCount: 1;
  /** Request-only controls must never bind that row to an action task. */
  taskBoundActionTurnCount: 0;
  actionReceiptCount: 0;
  assistantToolCallCount: 0;
};

type ControlTurnEvidence = {
  requestId: string;
  relation: 'status' | 'cancel' | 'repeat';
  userMessage: ControlMessageEvidence;
  assistantMessage: ControlMessageEvidence;
  terminal: ControlTerminalEvidence;
  targetRequestId: string;
  targetBinding:
    | 'durable_terminal_status_target'
    | 'durable_cancellation_tombstone'
    | 'exact_adjacent_assistant_replay';
  noExecution: NoExecutionEvidence;
};

export interface ControlSequenceTruthSnapshot {
  kind: typeof CONTROL_SEQUENCE_TRUTH_SNAPSHOT_KIND;
  schemaVersion: typeof CONTROL_SEQUENCE_TRUTH_SNAPSHOT_SCHEMA_VERSION;
  evidenceKind: 'control_sequence';
  snapshotId: string;
  scenarioId: typeof CONTROL_STOP_STATUS_REPEAT_SCENARIO;
  acceptanceRunId: string;
  capturedAt: string;
  buildIdentityDigest: string;
  conversation: {
    recordId: string;
    conversationId: string;
    livePointerState: 'cleared';
    durableActionTaskCount: 0;
  };
  longExecution: {
    requestId: string;
    userMessage: ControlMessageEvidence;
    assistantMessage: ControlMessageEvidence;
    terminal: ControlTerminalEvidence;
    providerOutbound: {
      captureId: string;
      captureOrigin: 'provider_dispatch_boundary';
      recordId: string;
      routingSource: 'chat';
      requestId: string;
      turnNonce: string;
      turnNonceSource: 'accepted_user_message_id_hmac_attested_provider_slot';
      provider: string;
      model: string;
      routingStatus: 'failed';
      attemptStatus: 'failed';
      errorCategory: 'cancelled';
      digestProtection: 'installation_hmac_sha256_v1';
      digestKeyId: string;
      evidenceAttestationSha256: string;
      payloadSha256: string;
      messagesSha256: string;
      messageCount: number;
      messages: Array<{
        index: number;
        role: 'system' | 'user' | 'assistant' | 'tool';
        contentSha256: string;
        textCharCount: number;
        sourceMessageId: string | null;
      }>;
      attemptStartedAt: string;
      totalExecutionMs: number;
      cancellationRequestedAt: string;
      cancellationLatencyMs: number;
      maximumCancellationLatencyMs: 5_000;
      recordedAt: string;
    };
    noToolExecution: Omit<NoExecutionEvidence, 'modelRoutingReceiptCount'>;
  };
  controls: {
    status: ControlTurnEvidence;
    stop: ControlTurnEvidence;
    repeat: ControlTurnEvidence;
  };
  repeatEquality: {
    sourceRequestId: string;
    sourceMessageId: string;
    repeatedRequestId: string;
    repeatedMessageId: string;
    exactTextSha256: string;
    exact: true;
  };
}

export interface BuildControlSequenceTruthSnapshotInput {
  db: any;
  chatExecutionReceipts: unknown[];
  scenarioId: string;
  acceptanceRunId: string;
  buildIdentityDigest: string;
  userId: string;
  conversationId: string;
  requestId: string;
  phaseRequestIds: ControlSequenceRequestIds;
  snapshotId?: string;
  capturedAt?: string;
}

export type CaptureControlSequenceTruthSnapshotInput = Omit<
  BuildControlSequenceTruthSnapshotInput,
  'db' | 'chatExecutionReceipts'
>;

const SHA256_RE = /^[a-f0-9]{64}$/u;

function required(value: unknown, code: string, limit = 500): string {
  const text = String(value ?? '').trim().slice(0, limit);
  if (!text) throw new Error(code);
  return text;
}

function iso(value: unknown, code: string): string {
  const text = required(value, code, 80);
  if (!Number.isFinite(Date.parse(text))) throw new Error(code);
  return new Date(text).toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : {};
  } catch {
    return {};
  }
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function exactRow<T extends Record<string, any>>(
  rows: unknown,
  predicate: (row: T) => boolean,
  code: string,
): T {
  const matches = (Array.isArray(rows) ? rows : []).filter((row): row is T => (
    Boolean(row) && typeof row === 'object' && predicate(row as T)
  ));
  if (matches.length !== 1) throw new Error(matches.length ? `${code}_ambiguous` : code);
  return matches[0];
}

function messageText(row: Record<string, any>): string {
  return required(
    row.message || row.content || row.response,
    'task_truth_snapshot_control_message_text_missing',
    100_000,
  );
}

function messageEvidence(
  row: Record<string, any>,
  requestId: string,
  role: 'user' | 'assistant',
  transcriptIndex: number,
): ControlMessageEvidence {
  const text = messageText(row);
  return {
    recordId: required(row.id, 'task_truth_snapshot_control_message_id_missing', 180),
    messageId: required(row.id, 'task_truth_snapshot_control_message_id_missing', 180),
    requestId,
    role,
    cognitiveIntent: String(row.cognitiveIntent || '').trim().slice(0, 120),
    text,
    textSha256: sha256(text),
    textCharCount: text.length,
    transcriptIndex,
    recordedAt: iso(row.timestamp, 'task_truth_snapshot_control_message_time_invalid'),
  };
}

function terminalEvidence(
  row: Record<string, any>,
  requestId: string,
  expected: {
    status: 'cancelled' | 'completed';
    sidecar: boolean;
    reason: string;
    assistantText: string;
  },
): ControlTerminalEvidence {
  const payload = parseObject(row.payload);
  const text = required(payload.text, 'task_truth_snapshot_control_terminal_text_missing', 100_000);
  if (
    String(row.requestId || '') !== requestId
    || row.status !== expected.status
    || row.event !== 'agent:response'
    || payload.sidecar !== expected.sidecar
    || payload.finalized !== true
    || payload.blocked !== false
    || String(payload.reason || '') !== expected.reason
    || text !== expected.assistantText
    || String(payload.requestId || '') !== requestId
  ) throw new Error('task_truth_snapshot_control_terminal_mismatch');
  const controlIntent = payload.controlIntent === 'cancel' || payload.controlIntent === 'status'
    ? payload.controlIntent
    : null;
  const targetRequestId = payload.targetRequestId
    ? required(payload.targetRequestId, 'task_truth_snapshot_control_target_invalid', 180)
    : null;
  return {
    recordId: `chat-terminal:${required(row.source, 'task_truth_snapshot_control_source_missing', 120)}:${requestId}`,
    requestId,
    status: expected.status,
    event: 'agent:response',
    sidecar: expected.sidecar,
    finalized: true,
    blocked: false,
    reason: expected.reason,
    text,
    textSha256: sha256(text),
    controlIntent,
    targetRequestId,
    createdAt: iso(row.createdAt, 'task_truth_snapshot_control_terminal_time_invalid'),
    updatedAt: iso(row.updatedAt, 'task_truth_snapshot_control_terminal_time_invalid'),
  };
}

function countToolCalls(row: Record<string, any>): number {
  return parseArray(row.toolCalls).length;
}

function assertZeroExecution(
  db: any,
  requestId: string,
  assistant: Record<string, any>,
): NoExecutionEvidence {
  const modelRoutingReceiptCount = (Array.isArray(db.modelRoutingReceipts)
    ? db.modelRoutingReceipts
    : []).filter((row: any) => String(row?.requestId || '') === requestId).length;
  const actionTurns = (Array.isArray(db.conversationActionTurns)
    ? db.conversationActionTurns
    : []).filter((row: any) => String(row?.requestId || '') === requestId);
  const actionTurnCount = actionTurns.length;
  const taskBoundActionTurnCount = actionTurns.filter((row: any) => (
    Boolean(String(row?.taskId || '').trim())
  )).length;
  const actionReceiptCount = (Array.isArray(db.conversationActionReceipts)
    ? db.conversationActionReceipts
    : []).filter((row: any) => String(row?.requestId || '') === requestId).length;
  const assistantToolCallCount = countToolCalls(assistant);
  if (
    modelRoutingReceiptCount !== 0
    || actionTurnCount !== 1
    || taskBoundActionTurnCount !== 0
    || actionReceiptCount !== 0
    || assistantToolCallCount !== 0
  ) throw new Error('task_truth_snapshot_control_unexpected_execution');
  return {
    modelRoutingReceiptCount: 0,
    actionTurnCount: 1,
    taskBoundActionTurnCount: 0,
    actionReceiptCount: 0,
    assistantToolCallCount: 0,
  };
}

function controlTurn(
  input: {
    db: any;
    requestId: string;
    relation: ControlTurnEvidence['relation'];
    user: Record<string, any>;
    assistant: Record<string, any>;
    terminal: ControlTerminalEvidence;
    userIndex: number;
    assistantIndex: number;
    targetRequestId: string;
    targetBinding: ControlTurnEvidence['targetBinding'];
  },
): ControlTurnEvidence {
  return {
    requestId: input.requestId,
    relation: input.relation,
    userMessage: messageEvidence(input.user, input.requestId, 'user', input.userIndex),
    assistantMessage: messageEvidence(input.assistant, input.requestId, 'assistant', input.assistantIndex),
    terminal: input.terminal,
    targetRequestId: input.targetRequestId,
    targetBinding: input.targetBinding,
    noExecution: assertZeroExecution(input.db, input.requestId, input.assistant),
  };
}

/**
 * Builds the request-only S5 truth variant. It deliberately has no taskId,
 * task row, action receipt, or tool target: inventing any of those identities
 * would weaken the action-bearing task snapshot used by S2.
 */
export function buildControlSequenceTruthSnapshotFromSources(
  input: BuildControlSequenceTruthSnapshotInput,
): ControlSequenceTruthSnapshot {
  if (input.scenarioId !== CONTROL_STOP_STATUS_REPEAT_SCENARIO) {
    throw new Error('task_truth_snapshot_control_scenario_invalid');
  }
  const acceptanceRunId = required(input.acceptanceRunId, 'task_truth_snapshot_run_required', 180);
  const buildIdentityDigest = required(
    input.buildIdentityDigest,
    'task_truth_snapshot_build_identity_required',
    64,
  ).toLowerCase();
  if (!SHA256_RE.test(buildIdentityDigest)) {
    throw new Error('task_truth_snapshot_build_identity_invalid');
  }
  const userId = required(input.userId, 'task_truth_snapshot_user_required', 180);
  const conversationId = required(
    input.conversationId,
    'task_truth_snapshot_conversation_required',
    180,
  );
  const capturedAt = iso(input.capturedAt || new Date().toISOString(), 'task_truth_snapshot_time_invalid');
  const snapshotId = required(
    input.snapshotId || `control_truth_${randomUUID()}`,
    'task_truth_snapshot_id_required',
    180,
  );
  const phaseRequestIds = Object.fromEntries(CONTROL_SEQUENCE_PHASE_IDS.map(phaseId => [
    phaseId,
    required(
      input.phaseRequestIds?.[phaseId],
      `task_truth_snapshot_control_${phaseId}_request_missing`,
      180,
    ),
  ])) as ControlSequenceRequestIds;
  if (new Set(Object.values(phaseRequestIds)).size !== CONTROL_SEQUENCE_PHASE_IDS.length) {
    throw new Error('task_truth_snapshot_control_request_binding_ambiguous');
  }
  if (required(input.requestId, 'task_truth_snapshot_request_required', 180) !== phaseRequestIds.long) {
    throw new Error('task_truth_snapshot_control_long_request_mismatch');
  }

  const db = input.db || {};
  const conversation = exactRow<Record<string, any>>(
    db.conversations,
    row => row.id === conversationId && row.userId === userId,
    'task_truth_snapshot_conversation_missing',
  );
  const live = parseObject(conversation.actionContinuationState);
  if (String(live.taskId || '').trim() || live.unfinished === true) {
    throw new Error('task_truth_snapshot_control_live_pointer_not_cleared');
  }
  const durableActionTaskCount = (Array.isArray(db.conversationActionTasks)
    ? db.conversationActionTasks
    : []).filter((row: any) => (
    row?.conversationId === conversationId && row?.userId === userId
  )).length;
  if (durableActionTaskCount !== 0) {
    throw new Error('task_truth_snapshot_control_unexpected_task');
  }

  const interactions = Array.isArray(db.interactions) ? db.interactions : [];
  const findMessage = (requestId: string, role: 'user' | 'assistant') => exactRow<Record<string, any>>(
    interactions,
    row => row.userId === userId
      && row.conversationId === conversationId
      && (row.requestId === requestId || row.externalMessageId === requestId)
      && row.role === role,
    'task_truth_snapshot_control_message_missing',
  );
  const longUser = findMessage(phaseRequestIds.long, 'user');
  const longAssistant = findMessage(phaseRequestIds.long, 'assistant');
  const statusUser = findMessage(phaseRequestIds.status, 'user');
  const statusAssistant = findMessage(phaseRequestIds.status, 'assistant');
  const stopUser = findMessage(phaseRequestIds.stop, 'user');
  const stopAssistant = findMessage(phaseRequestIds.stop, 'assistant');
  const repeatUser = findMessage(phaseRequestIds.repeat, 'user');
  const repeatAssistant = findMessage(phaseRequestIds.repeat, 'assistant');

  if (
    statusUser.cognitiveIntent !== 'task_status'
    || statusAssistant.cognitiveIntent !== 'task_status'
    || stopUser.cognitiveIntent !== 'task_cancel'
    || stopAssistant.cognitiveIntent !== 'task_cancel'
    || longAssistant.cognitiveIntent !== 'task_cancelled'
    || repeatAssistant.cognitiveIntent !== 'task_repeat'
  ) throw new Error('task_truth_snapshot_control_relation_mismatch');

  const orderedMessages = [
    longUser,
    stopUser,
    longAssistant,
    stopAssistant,
    statusUser,
    statusAssistant,
    repeatUser,
    repeatAssistant,
  ];
  const indices = orderedMessages.map(row => interactions.indexOf(row));
  if (indices.some((index, offset) => index < 0 || (offset > 0 && index <= indices[offset - 1]))) {
    throw new Error('task_truth_snapshot_control_transcript_order_invalid');
  }
  if (indices[5] + 1 !== indices[6]) {
    throw new Error('task_truth_snapshot_control_repeat_not_adjacent');
  }
  if (indices[3] + 1 !== indices[4]) {
    throw new Error('task_truth_snapshot_control_status_not_adjacent_to_stop');
  }

  const receiptRows: Record<string, any>[] = Array.isArray(input.chatExecutionReceipts)
    ? input.chatExecutionReceipts.filter((row): row is Record<string, any> => (
      Boolean(row) && typeof row === 'object' && !Array.isArray(row)
    ))
    : [];
  const findTerminal = (requestId: string) => exactRow<Record<string, any>>(
    receiptRows,
    row => row.userId === userId
      && row.conversationId === conversationId
      && row.requestId === requestId,
    'task_truth_snapshot_control_terminal_missing',
  );
  const longTerminal = terminalEvidence(findTerminal(phaseRequestIds.long), phaseRequestIds.long, {
    status: 'cancelled',
    sidecar: false,
    reason: 'request_cancelled',
    assistantText: messageText(longAssistant),
  });
  const statusTerminal = terminalEvidence(findTerminal(phaseRequestIds.status), phaseRequestIds.status, {
    status: 'completed',
    sidecar: true,
    reason: 'target_execution_status',
    assistantText: messageText(statusAssistant),
  });
  const stopTerminal = terminalEvidence(findTerminal(phaseRequestIds.stop), phaseRequestIds.stop, {
    status: 'completed',
    sidecar: true,
    reason: 'cancelled_by_user',
    assistantText: messageText(stopAssistant),
  });
  const repeatTerminal = terminalEvidence(findTerminal(phaseRequestIds.repeat), phaseRequestIds.repeat, {
    status: 'completed',
    sidecar: false,
    reason: 'repeat_previous_reply',
    assistantText: messageText(repeatAssistant),
  });

  if (
    stopTerminal.controlIntent !== 'cancel'
    || stopTerminal.targetRequestId !== phaseRequestIds.long
  ) throw new Error('task_truth_snapshot_control_stop_target_mismatch');
  if (
    statusTerminal.controlIntent !== 'status'
    || statusTerminal.targetRequestId !== phaseRequestIds.long
    || Date.parse(statusTerminal.createdAt) < Date.parse(longTerminal.updatedAt)
  ) throw new Error('task_truth_snapshot_control_status_target_mismatch');

  const statusText = messageText(statusAssistant);
  const repeatText = messageText(repeatAssistant);
  if (repeatText !== statusText) {
    throw new Error('task_truth_snapshot_control_repeat_text_mismatch');
  }

  const longActionTurns = (Array.isArray(db.conversationActionTurns)
    ? db.conversationActionTurns
    : []).filter((row: any) => row?.requestId === phaseRequestIds.long);
  const longActionTurnCount = longActionTurns.length;
  const longTaskBoundActionTurnCount = longActionTurns.filter((row: any) => (
    Boolean(String(row?.taskId || '').trim())
  )).length;
  const longActionReceiptCount = (Array.isArray(db.conversationActionReceipts)
    ? db.conversationActionReceipts
    : []).filter((row: any) => row?.requestId === phaseRequestIds.long).length;
  const longAssistantToolCallCount = countToolCalls(longAssistant);
  if (
    longActionTurnCount !== 1
    || longTaskBoundActionTurnCount !== 0
    || longActionReceiptCount !== 0
    || longAssistantToolCallCount !== 0
  ) {
    throw new Error('task_truth_snapshot_control_long_tool_execution_present');
  }

  const routingCandidates: Array<{
    receipt: Record<string, any>;
    attempt: Record<string, any>;
    attemptIndex: number;
    outbound: NonNullable<ReturnType<typeof normalizeProviderOutboundMessagesEvidence>>;
  }> = [];
  for (const receipt of Array.isArray(db.modelRoutingReceipts) ? db.modelRoutingReceipts : []) {
    if (
      receipt?.userId !== userId
      || receipt?.conversationId !== conversationId
      || receipt?.requestId !== phaseRequestIds.long
      || receipt?.source !== 'chat'
    ) continue;
    for (const [attemptIndex, attempt] of (Array.isArray(receipt.attempts) ? receipt.attempts : []).entries()) {
      const outbound = normalizeProviderOutboundMessagesEvidence(attempt?.outboundMessagesEvidence);
      if (!outbound) continue;
      if (
        receipt.status !== 'failed'
        || attempt.status !== 'failed'
        || attempt.errorCategory !== 'cancelled'
      ) continue;
      const sourceIds = outbound.messages
        .map(message => message.sourceMessageId)
        .filter((value): value is string => Boolean(value));
      if (sourceIds.length === 1 && sourceIds[0] === String(longUser.id || '')) {
        routingCandidates.push({ receipt, attempt, attemptIndex, outbound });
      }
    }
  }
  if (routingCandidates.length !== 1) {
    throw new Error(routingCandidates.length
      ? 'task_truth_snapshot_control_provider_binding_ambiguous'
      : 'task_truth_snapshot_control_provider_binding_missing');
  }
  const provider = routingCandidates[0];
  const providerRecordedAt = iso(
    provider.receipt.completedAt,
    'task_truth_snapshot_control_provider_time_invalid',
  );
  if (Date.parse(providerRecordedAt) > Date.parse(longTerminal.updatedAt)) {
    throw new Error('task_truth_snapshot_control_provider_after_terminal');
  }
  const providerAttemptStartedAt = iso(
    provider.attempt.startedAt,
    'task_truth_snapshot_control_provider_time_invalid',
  );
  const totalExecutionMs = Date.parse(longTerminal.updatedAt) - Date.parse(providerAttemptStartedAt);
  const cancellationRequestedAt = stopTerminal.createdAt;
  const cancellationLatencyMs = Date.parse(longTerminal.updatedAt) - Date.parse(cancellationRequestedAt);
  if (
    !Number.isSafeInteger(totalExecutionMs)
    || totalExecutionMs < 0
    ||
    !Number.isSafeInteger(cancellationLatencyMs)
    || cancellationLatencyMs < 0
    || cancellationLatencyMs > 5_000
  ) throw new Error('task_truth_snapshot_control_cancellation_latency_exceeded');

  return {
    kind: CONTROL_SEQUENCE_TRUTH_SNAPSHOT_KIND,
    schemaVersion: CONTROL_SEQUENCE_TRUTH_SNAPSHOT_SCHEMA_VERSION,
    evidenceKind: 'control_sequence',
    snapshotId,
    scenarioId: CONTROL_STOP_STATUS_REPEAT_SCENARIO,
    acceptanceRunId,
    capturedAt,
    buildIdentityDigest,
    conversation: {
      recordId: required(conversation.id, 'task_truth_snapshot_conversation_missing', 180),
      conversationId,
      livePointerState: 'cleared',
      durableActionTaskCount: 0,
    },
    longExecution: {
      requestId: phaseRequestIds.long,
      userMessage: messageEvidence(longUser, phaseRequestIds.long, 'user', indices[0]),
      assistantMessage: messageEvidence(longAssistant, phaseRequestIds.long, 'assistant', indices[2]),
      terminal: longTerminal,
      providerOutbound: {
        captureId: `${required(provider.receipt.id, 'task_truth_snapshot_control_provider_id_missing', 180)}:attempt:${provider.attemptIndex}`,
        captureOrigin: 'provider_dispatch_boundary',
        recordId: required(provider.receipt.id, 'task_truth_snapshot_control_provider_id_missing', 180),
        routingSource: 'chat',
        requestId: phaseRequestIds.long,
        turnNonce: required(longUser.id, 'task_truth_snapshot_control_nonce_missing', 180),
        turnNonceSource: 'accepted_user_message_id_hmac_attested_provider_slot',
        provider: required(provider.attempt.provider, 'task_truth_snapshot_model_provider_missing', 120),
        model: required(provider.attempt.model, 'task_truth_snapshot_model_name_missing', 240),
        routingStatus: 'failed',
        attemptStatus: 'failed',
        errorCategory: 'cancelled',
        digestProtection: provider.outbound.digestProtection,
        digestKeyId: provider.outbound.digestKeyId,
        evidenceAttestationSha256: provider.outbound.attestationSha256,
        payloadSha256: provider.outbound.providerRequestShapeSha256,
        messagesSha256: provider.outbound.messagesSha256,
        messageCount: provider.outbound.messageCount,
        messages: provider.outbound.messages.map(message => ({
          index: message.index,
          role: message.role,
          contentSha256: message.contentSha256,
          textCharCount: message.textCharCount,
          sourceMessageId: message.sourceMessageId,
        })),
        attemptStartedAt: providerAttemptStartedAt,
        totalExecutionMs,
        cancellationRequestedAt,
        cancellationLatencyMs,
        maximumCancellationLatencyMs: 5_000,
        recordedAt: providerRecordedAt,
      },
      noToolExecution: {
        actionTurnCount: 1,
        taskBoundActionTurnCount: 0,
        actionReceiptCount: 0,
        assistantToolCallCount: 0,
      },
    },
    controls: {
      status: controlTurn({
        db,
        requestId: phaseRequestIds.status,
        relation: 'status',
        user: statusUser,
        assistant: statusAssistant,
        userIndex: indices[4],
        assistantIndex: indices[5],
        terminal: statusTerminal,
        targetRequestId: phaseRequestIds.long,
        targetBinding: 'durable_terminal_status_target',
      }),
      stop: controlTurn({
        db,
        requestId: phaseRequestIds.stop,
        relation: 'cancel',
        user: stopUser,
        assistant: stopAssistant,
        userIndex: indices[1],
        assistantIndex: indices[3],
        terminal: stopTerminal,
        targetRequestId: phaseRequestIds.long,
        targetBinding: 'durable_cancellation_tombstone',
      }),
      repeat: controlTurn({
        db,
        requestId: phaseRequestIds.repeat,
        relation: 'repeat',
        user: repeatUser,
        assistant: repeatAssistant,
        userIndex: indices[6],
        assistantIndex: indices[7],
        terminal: repeatTerminal,
        targetRequestId: phaseRequestIds.status,
        targetBinding: 'exact_adjacent_assistant_replay',
      }),
    },
    repeatEquality: {
      sourceRequestId: phaseRequestIds.status,
      sourceMessageId: required(statusAssistant.id, 'task_truth_snapshot_control_message_id_missing', 180),
      repeatedRequestId: phaseRequestIds.repeat,
      repeatedMessageId: required(repeatAssistant.id, 'task_truth_snapshot_control_message_id_missing', 180),
      exactTextSha256: sha256(statusText),
      exact: true,
    },
  };
}

function cloneDb(value: any): any {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/** Read-only collector over the isolated runtime's durable stores. */
export async function captureControlSequenceTruthSnapshot(
  input: CaptureControlSequenceTruthSnapshotInput,
): Promise<ControlSequenceTruthSnapshot> {
  const chatExecutionReceipts = await querySQL<Record<string, any>>(
    `SELECT userId, domain, orgId, source, conversationId, requestId,
            status, event, payload, createdAt, updatedAt, expiresAt
       FROM chat_execution_terminal_receipts
      WHERE userId = ? AND conversationId = ?`,
    [input.userId, input.conversationId],
  );
  return buildControlSequenceTruthSnapshotFromSources({
    ...input,
    db: cloneDb(readDB()),
    chatExecutionReceipts,
  });
}
