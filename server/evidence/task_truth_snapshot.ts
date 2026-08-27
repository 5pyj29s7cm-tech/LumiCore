import { createHash, randomUUID } from 'node:crypto';
import { readDB } from '../../db_layer';
import {
  buildTransportNeutralConfirmationScope,
  getPendingConfirmationDurably,
  type PendingToolConfirmation,
} from '../tools/pending_confirmation';
import {
  normalizeProviderOutboundMessagesEvidence,
} from '../llm/outbound_message_evidence';

export const TASK_TRUTH_SNAPSHOT_KIND = 'lumi.task-truth-snapshot' as const;
export const TASK_TRUTH_SNAPSHOT_SCHEMA_VERSION = 1 as const;

type PointerObservation = {
  state: 'set' | 'cleared';
  taskId: string | null;
  requestId: string | null;
  recordId: string;
  observedAt: string;
};

export interface TaskTruthSnapshot {
  kind: typeof TASK_TRUTH_SNAPSHOT_KIND;
  schemaVersion: typeof TASK_TRUTH_SNAPSHOT_SCHEMA_VERSION;
  snapshotId: string;
  scenarioId: string;
  acceptanceRunId: string;
  capturedAt: string;
  buildIdentityDigest: string;
  userVisibleReply: {
    messageId: string;
    text: string;
    recordedAt: string;
  };
  task: {
    recordId: string;
    taskId: string;
    status: string;
    goal: string;
    updatedAt: string;
  };
  pointers: {
    pending: PointerObservation;
    live: PointerObservation;
  };
  request: {
    recordId: string;
    requestId: string;
    taskId: string;
    status: string;
    recordedAt: string;
  };
  receipt: {
    recordId: string;
    receiptId: string;
    requestId: string;
    taskId: string;
    status: string;
    toolName: string;
    recordedAt: string;
  };
  toolTarget: {
    recordId: string;
    requestId: string;
    taskId: string;
    toolName: string;
    targetType: string;
    targetId: string;
    displayName: string;
    source: string;
    normalizedTargetSha256: string;
    recordedAt: string;
  };
  modelActualInput: {
    captureId: string;
    captureOrigin: 'provider_dispatch_boundary';
    modelInvoked: true;
    recordId: string;
    requestId: string;
    taskId: string;
    provider: string;
    model: string;
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
    recordedAt: string;
  } | {
    captureId: string;
    captureOrigin: 'deterministic_tool_selection_boundary';
    modelInvoked: false;
    recordId: string;
    requestId: string;
    taskId: string;
    executionOrigin: 'confirmed_action_resume' | 'deterministic_route';
    reason: string;
    recordedAt: string;
  };
}

export interface BuildTaskTruthSnapshotInput {
  db: any;
  scenarioId: string;
  acceptanceRunId: string;
  buildIdentityDigest: string;
  userId: string;
  conversationId: string;
  requestId: string;
  taskId: string;
  pendingConfirmation?: PendingToolConfirmation | null;
  snapshotId?: string;
  replyMessageId?: string;
  receiptId?: string;
  /** Server-owned selector derived from an isolated manifest phase. */
  receiptToolName?: string;
  routingReceiptId?: string;
  modelAttemptIndex?: number;
  capturedAt?: string;
}

export type CaptureTaskTruthSnapshotInput = Omit<
  BuildTaskTruthSnapshotInput,
  'db' | 'pendingConfirmation'
>;

const SHA256_RE = /^[a-f0-9]{64}$/u;

function required(value: unknown, code: string, limit = 500): string {
  const text = String(value ?? '').trim().slice(0, limit);
  if (!text) throw new Error(code);
  return text;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value as object)) throw new Error('task_truth_snapshot_circular_value');
  seen.add(value as object);
  if (Array.isArray(value)) {
    const output = value.map(item => stableValue(item, seen));
    seen.delete(value as object);
    return output;
  }
  const output = Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => [key, stableValue((value as Record<string, unknown>)[key], seen)]));
  seen.delete(value as object);
  return output;
}

function digest(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function iso(value: unknown, code: string): string {
  const text = required(value, code, 80);
  if (!Number.isFinite(Date.parse(text))) throw new Error(code);
  return new Date(text).toISOString();
}

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
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

function latestExactRow<T extends Record<string, any>>(
  rows: unknown,
  predicate: (row: T) => boolean,
  code: string,
  dateKey: keyof T,
): T {
  const matches = (Array.isArray(rows) ? rows : []).filter((row): row is T => (
    Boolean(row) && typeof row === 'object' && predicate(row as T)
  ));
  if (matches.length === 0) throw new Error(code);
  return [...matches].sort((left, right) => (
    String(right[dateKey] || '').localeCompare(String(left[dateKey] || ''))
  ))[0];
}

function replyText(row: Record<string, any>): string {
  return required(row.message || row.content || row.response, 'task_truth_snapshot_reply_text_missing', 100_000);
}

function normalizeModelRole(value: unknown): 'system' | 'user' | 'assistant' | 'tool' {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') return role;
  if (role === 'model') return 'assistant';
  if (role === 'function' || role === 'function_response' || role === 'tool_result') return 'tool';
  throw new Error('task_truth_snapshot_model_role_invalid');
}

function normalizeRequestStatus(
  turnStatus: unknown,
  taskStatus: unknown,
  receiptOutcome: unknown,
): TaskTruthSnapshot['request']['status'] {
  const turn = String(turnStatus || '').trim();
  const task = String(taskStatus || '').trim();
  const receipt = String(receiptOutcome || '').trim();
  if (turn === 'accepted') return 'created';
  if (turn === 'leased') return 'running';
  if (turn === 'cancelled' || task === 'cancelled') return 'cancelled';
  if (turn === 'persistence_unknown') return 'blocked';
  if (task === 'waiting_confirmation' || receipt === 'waiting_confirmation') {
    return 'waiting_confirmation';
  }
  if (task === 'failed') return 'failed';
  if (task === 'blocked') return 'blocked';
  if (turn === 'terminal') {
    return receipt === 'verified_success' || task === 'completed' ? 'succeeded' : 'failed';
  }
  throw new Error('task_truth_snapshot_request_status_invalid');
}

function normalizeReceiptStatus(
  outcome: unknown,
): TaskTruthSnapshot['receipt']['status'] {
  const status = String(outcome || '').trim();
  if (status === 'verified_success') return 'succeeded';
  if (status === 'waiting_confirmation') return 'waiting_confirmation';
  if (status === 'planned' || status === 'running' || status === 'cancelled' || status === 'blocked') {
    return status;
  }
  if (['failed', 'target_mismatch', 'forbidden', 'unknown_outcome', 'timeout'].includes(status)) {
    return 'failed';
  }
  throw new Error('task_truth_snapshot_receipt_status_invalid');
}

function inferTargetType(targetIdentity: string, toolName: string): string {
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/iu.test(targetIdentity)) return 'filesystem_path';
  if (/^https?:\/\//iu.test(targetIdentity)) return 'url';
  if (/(?:window|application|desktop|client_action|wps)/iu.test(toolName)) return 'application_object';
  if (/(?:message|email|wechat|contact|recipient)/iu.test(toolName)) return 'communication_target';
  return 'tool_target';
}

function displayTarget(targetIdentity: string): string {
  const normalized = targetIdentity.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return normalized.split('/').filter(Boolean).at(-1) || targetIdentity;
}

function pointerObservation(input: {
  state: 'set' | 'cleared';
  taskId?: unknown;
  requestId?: unknown;
  recordId: string;
  observedAt: string;
}): PointerObservation {
  if (input.state === 'cleared') {
    return {
      state: 'cleared',
      taskId: null,
      requestId: null,
      recordId: input.recordId,
      observedAt: input.observedAt,
    };
  }
  return {
    state: 'set',
    taskId: required(input.taskId, 'task_truth_snapshot_pointer_task_missing', 180),
    requestId: input.requestId ? required(input.requestId, 'task_truth_snapshot_pointer_request_invalid', 180) : null,
    recordId: input.recordId,
    observedAt: input.observedAt,
  };
}

function assertSame(actual: unknown, expected: string, code: string): void {
  if (String(actual || '').trim() !== expected) throw new Error(code);
}

function selectTaskTruthReceipt(input: {
  rows: unknown;
  receiptId?: string;
  receiptToolName?: string;
  taskId: string;
  conversationId: string;
  requestId: string;
  turn: Record<string, any>;
  terminalReply: Record<string, any> | null;
}): Record<string, any> {
  const scoped = (Array.isArray(input.rows) ? input.rows : [])
    .filter((row): row is Record<string, any> => Boolean(row) && typeof row === 'object')
    .filter(row => row.taskId === input.taskId
      && row.conversationId === input.conversationId
      && row.requestId === input.requestId);
  if (input.receiptId) {
    return exactRow<Record<string, any>>(
      scoped,
      row => row.id === input.receiptId,
      'task_truth_snapshot_receipt_missing',
    );
  }
  if (input.receiptToolName) {
    const expectedTool = required(
      input.receiptToolName,
      'task_truth_snapshot_receipt_tool_selector_invalid',
      240,
    );
    const toolBound = scoped.filter(row => String(row.toolName || '').trim() === expectedTool);
    if (toolBound.length !== 1) {
      throw new Error(toolBound.length === 0
        ? 'task_truth_snapshot_receipt_missing'
        : 'task_truth_snapshot_receipt_binding_ambiguous');
    }
    return toolBound[0];
  }
  if (scoped.length === 0) throw new Error('task_truth_snapshot_receipt_missing');
  if (scoped.length === 1) return scoped[0];

  // Multiple tools may legitimately share one request. Only runtime-owned
  // terminal/turn bindings can select the representative receipt; timestamps
  // are not identity and must never become an implicit latest-wins selector.
  const terminalReceiptIds = new Set(parseArray(input.terminalReply?.toolCalls)
    .map(value => (
      value && typeof value === 'object' && !Array.isArray(value)
        ? String((value as Record<string, unknown>).id || '').trim()
        : ''
    ))
    .filter(Boolean));
  const terminalBound = scoped.filter(row => terminalReceiptIds.has(String(row.id || '').trim()));
  if (terminalBound.length > 1) {
    throw new Error('task_truth_snapshot_receipt_binding_ambiguous');
  }

  const turnAliases = new Set([
    input.turn.id,
    input.turn.userMessageId,
    input.turn.requestId,
  ].map(value => String(value || '').trim()).filter(Boolean));
  const turnBound = scoped.filter(row => {
    const turnId = String(row.turnId || '').trim();
    return Boolean(turnId) && turnAliases.has(turnId);
  });

  if (terminalBound.length === 1) {
    if (turnBound.length > 0 && !turnBound.includes(terminalBound[0])) {
      throw new Error('task_truth_snapshot_receipt_binding_conflict');
    }
    return terminalBound[0];
  }
  if (turnBound.length === 1) return turnBound[0];
  throw new Error('task_truth_snapshot_receipt_binding_ambiguous');
}

export function buildTaskTruthSnapshotFromSources(
  input: BuildTaskTruthSnapshotInput,
): TaskTruthSnapshot {
  const scenarioId = required(input.scenarioId, 'task_truth_snapshot_scenario_required', 120);
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
  const conversationId = required(input.conversationId, 'task_truth_snapshot_conversation_required', 180);
  const requestId = required(input.requestId, 'task_truth_snapshot_request_required', 180);
  const taskId = required(input.taskId, 'task_truth_snapshot_task_required', 180);
  const capturedAt = iso(input.capturedAt || new Date().toISOString(), 'task_truth_snapshot_time_invalid');
  const snapshotId = required(
    input.snapshotId || `truth_${randomUUID()}`,
    'task_truth_snapshot_id_required',
    180,
  );
  const db = input.db || {};

  const conversation = exactRow<Record<string, any>>(
    db.conversations,
    row => row.id === conversationId && row.userId === userId,
    'task_truth_snapshot_conversation_missing',
  );
  const task = exactRow<Record<string, any>>(
    db.conversationActionTasks,
    row => row.id === taskId && row.conversationId === conversationId && row.userId === userId,
    'task_truth_snapshot_task_missing',
  );
  const turn = exactRow<Record<string, any>>(
    db.conversationActionTurns,
    row => row.conversationId === conversationId
      && row.userId === userId
      && row.requestId === requestId,
    'task_truth_snapshot_request_missing',
  );
  assertSame(turn.taskId, taskId, 'task_truth_snapshot_request_task_mismatch');

  const terminalReply = turn.terminalMessageId
    ? exactRow<Record<string, any>>(
      db.interactions,
      row => row.id === turn.terminalMessageId
        && row.userId === userId
        && row.conversationId === conversationId
        && row.role === 'assistant',
      'task_truth_snapshot_reply_missing',
    )
    : null;
  const reply = input.replyMessageId
    ? exactRow<Record<string, any>>(
      db.interactions,
      row => row.id === input.replyMessageId
        && row.userId === userId
        && row.conversationId === conversationId
        && row.role === 'assistant',
      'task_truth_snapshot_reply_missing',
    )
    : terminalReply
      ? terminalReply
      : latestExactRow<Record<string, any>>(
        db.interactions,
        row => row.userId === userId
          && row.conversationId === conversationId
          && row.role === 'assistant'
          && (row.requestId === requestId || row.externalMessageId === requestId),
        'task_truth_snapshot_reply_missing',
        'timestamp',
      );
  assertSame(
    reply.requestId || reply.externalMessageId,
    requestId,
    'task_truth_snapshot_reply_request_mismatch',
  );

  const receipt = selectTaskTruthReceipt({
    rows: db.conversationActionReceipts,
    receiptId: input.receiptId,
    receiptToolName: input.receiptToolName,
    taskId,
    conversationId,
    requestId,
    turn,
    terminalReply,
  });
  assertSame(receipt.taskId, taskId, 'task_truth_snapshot_receipt_task_mismatch');
  assertSame(
    receipt.conversationId,
    conversationId,
    'task_truth_snapshot_receipt_conversation_mismatch',
  );
  assertSame(receipt.requestId, requestId, 'task_truth_snapshot_receipt_request_mismatch');
  const toolName = required(receipt.toolName, 'task_truth_snapshot_tool_name_missing', 240);
  const targetIdentity = required(
    receipt.targetIdentity,
    'task_truth_snapshot_tool_target_missing',
    2_000,
  );

  const receiptAt = iso(receipt.createdAt, 'task_truth_snapshot_receipt_time_invalid');
  const boundRoutingReceiptId = String(
    input.routingReceiptId || receipt.modelRoutingReceiptId || '',
  ).trim().slice(0, 180);
  let modelActualInput: TaskTruthSnapshot['modelActualInput'];
  if (boundRoutingReceiptId) {
    const routingReceipt = exactRow<Record<string, any>>(
      db.modelRoutingReceipts,
      row => row.id === boundRoutingReceiptId,
      'task_truth_snapshot_model_receipt_missing',
    );
    assertSame(routingReceipt.userId, userId, 'task_truth_snapshot_model_user_mismatch');
    assertSame(routingReceipt.conversationId, conversationId, 'task_truth_snapshot_model_conversation_mismatch');
    assertSame(routingReceipt.requestId, requestId, 'task_truth_snapshot_model_request_mismatch');
    const evidenceAttempts = (Array.isArray(routingReceipt.attempts) ? routingReceipt.attempts : [])
      .filter((attempt: any) => attempt?.outboundMessagesEvidence);
    const selectedAttempt = Number.isSafeInteger(input.modelAttemptIndex)
      ? evidenceAttempts[input.modelAttemptIndex as number]
      : [...evidenceAttempts].reverse().find((attempt: any) => attempt.status === 'succeeded')
        || evidenceAttempts.at(-1);
    if (!selectedAttempt) throw new Error('task_truth_snapshot_model_actual_input_missing');
    const outbound = normalizeProviderOutboundMessagesEvidence(
      selectedAttempt.outboundMessagesEvidence,
    );
    if (!outbound) throw new Error('task_truth_snapshot_model_actual_input_invalid');
    const payloadSha256 = outbound.providerRequestShapeSha256.toLowerCase();
    const messagesSha256 = String(outbound.messagesSha256 || '').toLowerCase();
    if (!SHA256_RE.test(payloadSha256) || !SHA256_RE.test(messagesSha256)) {
      throw new Error('task_truth_snapshot_model_digest_invalid');
    }
    assertSame(
      outbound.provider,
      required(selectedAttempt.provider, 'task_truth_snapshot_model_provider_missing', 120),
      'task_truth_snapshot_model_provider_mismatch',
    );
    assertSame(
      outbound.model,
      required(selectedAttempt.model, 'task_truth_snapshot_model_name_missing', 240),
      'task_truth_snapshot_model_name_mismatch',
    );
    const outboundMessages = outbound.messages;
    if (outboundMessages.length < 1 || outboundMessages.length !== Number(outbound.messageCount)) {
      throw new Error('task_truth_snapshot_model_messages_invalid');
    }
    const modelMessages = outboundMessages.map((message: any, index: number) => {
      const contentSha256 = String(message?.contentSha256 || '').toLowerCase();
      if (!SHA256_RE.test(contentSha256)) {
        throw new Error('task_truth_snapshot_model_message_digest_missing');
      }
      const textCharCount = Number(message?.textCharCount ?? message?.textCharacters);
      if (!Number.isSafeInteger(textCharCount) || textCharCount < 0) {
        throw new Error('task_truth_snapshot_model_message_length_invalid');
      }
      return {
        index,
        role: normalizeModelRole(message?.role),
        contentSha256,
        textCharCount,
        sourceMessageId: message?.sourceMessageId
          ? required(message.sourceMessageId, 'task_truth_snapshot_model_source_message_invalid', 180)
          : null,
      };
    });
    const sourceMessageIds = [...new Set(modelMessages
      .map(message => message.sourceMessageId)
      .filter((value): value is string => Boolean(value)))];
    if (sourceMessageIds.length === 0) {
      throw new Error('task_truth_snapshot_model_source_message_missing');
    }
    let currentRequestSourceFound = false;
    for (const sourceMessageId of sourceMessageIds) {
      const sourceMessage = exactRow<Record<string, any>>(
        db.interactions,
        row => row.id === sourceMessageId
          && row.userId === userId
          && row.conversationId === conversationId
          && row.role === 'user',
        'task_truth_snapshot_model_source_record_missing',
      );
      const sourceRequestId = String(
        sourceMessage.requestId || sourceMessage.externalMessageId || '',
      ).trim();
      if (sourceRequestId === requestId) currentRequestSourceFound = true;
    }
    if (!currentRequestSourceFound) {
      throw new Error('task_truth_snapshot_model_source_request_mismatch');
    }
    modelActualInput = {
      captureId: required(
        `${routingReceipt.id}:attempt:${(Array.isArray(routingReceipt.attempts)
          ? routingReceipt.attempts.indexOf(selectedAttempt)
          : -1)}`,
        'task_truth_snapshot_model_capture_id_missing',
        500,
      ),
      captureOrigin: 'provider_dispatch_boundary',
      modelInvoked: true,
      recordId: required(routingReceipt.id, 'task_truth_snapshot_model_record_missing', 180),
      requestId,
      taskId,
      provider: required(selectedAttempt.provider || outbound.provider, 'task_truth_snapshot_model_provider_missing', 120),
      model: required(selectedAttempt.model || outbound.model, 'task_truth_snapshot_model_name_missing', 240),
      digestProtection: outbound.digestProtection,
      digestKeyId: outbound.digestKeyId,
      evidenceAttestationSha256: outbound.attestationSha256,
      payloadSha256,
      messagesSha256,
      messageCount: modelMessages.length,
      messages: modelMessages,
      recordedAt: iso(routingReceipt.completedAt, 'task_truth_snapshot_model_time_invalid'),
    };
  } else {
    const executionOrigin = String(receipt.executionOrigin || '').trim();
    if (executionOrigin !== 'confirmed_action_resume' && executionOrigin !== 'deterministic_route') {
      throw new Error('task_truth_snapshot_model_receipt_binding_missing');
    }
    modelActualInput = {
      captureId: `${required(receipt.id, 'task_truth_snapshot_receipt_id_missing', 180)}:deterministic-selection`,
      captureOrigin: 'deterministic_tool_selection_boundary',
      modelInvoked: false,
      recordId: required(receipt.id, 'task_truth_snapshot_receipt_id_missing', 180),
      requestId,
      taskId,
      executionOrigin,
      reason: executionOrigin === 'confirmed_action_resume'
        ? 'The exact persisted pending action was resumed after one-time confirmation without asking a model to select or rewrite the tool call.'
        : 'A runtime-owned deterministic route selected the exact tool call without model planning.',
      recordedAt: receiptAt,
    };
  }

  const pending = input.pendingConfirmation || null;
  if (pending) {
    assertSame(pending.userId, userId, 'task_truth_snapshot_pending_user_mismatch');
    assertSame(pending.taskId, taskId, 'task_truth_snapshot_pending_task_mismatch');
  }
  const rawLiveState = parseObject(conversation.actionContinuationState);
  const liveTaskId = String(rawLiveState.taskId || '').trim();
  if (liveTaskId && liveTaskId !== taskId) {
    throw new Error('task_truth_snapshot_live_pointer_task_mismatch');
  }

  const targetType = inferTargetType(targetIdentity, toolName);
  const normalizedTargetSha256 = digest({
    targetType,
    targetIdentity,
    toolName,
  });

  return {
    kind: TASK_TRUTH_SNAPSHOT_KIND,
    schemaVersion: TASK_TRUTH_SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    scenarioId,
    acceptanceRunId,
    capturedAt,
    buildIdentityDigest,
    userVisibleReply: {
      messageId: required(reply.id, 'task_truth_snapshot_reply_id_missing', 180),
      text: replyText(reply),
      recordedAt: iso(reply.timestamp, 'task_truth_snapshot_reply_time_invalid'),
    },
    task: {
      recordId: required(task.id, 'task_truth_snapshot_task_record_missing', 180),
      taskId,
      status: required(task.status, 'task_truth_snapshot_task_status_missing', 80),
      goal: required(task.goal, 'task_truth_snapshot_task_goal_missing', 10_000),
      updatedAt: iso(task.updatedAt, 'task_truth_snapshot_task_time_invalid'),
    },
    pointers: {
      pending: pending
        ? pointerObservation({
          state: 'set',
          taskId: pending.taskId,
          requestId: pending.originRequestId || null,
          recordId: required(pending.id, 'task_truth_snapshot_pending_record_missing', 180),
          observedAt: capturedAt,
        })
        : pointerObservation({
          state: 'cleared',
          recordId: `${snapshotId}:pending-observation`,
          observedAt: capturedAt,
        }),
      live: liveTaskId
        ? pointerObservation({
          state: 'set',
          taskId: liveTaskId,
          requestId: rawLiveState.activeRequestId || task.activeRequestId || null,
          recordId: required(conversation.id, 'task_truth_snapshot_live_record_missing', 180),
          observedAt: capturedAt,
        })
        : pointerObservation({
          state: 'cleared',
          recordId: `${snapshotId}:live-observation`,
          observedAt: capturedAt,
        }),
    },
    request: {
      recordId: required(turn.id, 'task_truth_snapshot_request_record_missing', 180),
      requestId,
      taskId,
      status: normalizeRequestStatus(turn.status, task.status, receipt.outcome),
      recordedAt: iso(turn.updatedAt || turn.createdAt, 'task_truth_snapshot_request_time_invalid'),
    },
    receipt: {
      recordId: required(receipt.id, 'task_truth_snapshot_receipt_record_missing', 180),
      receiptId: required(receipt.id, 'task_truth_snapshot_receipt_id_missing', 180),
      requestId,
      taskId,
      status: normalizeReceiptStatus(receipt.outcome),
      toolName,
      recordedAt: receiptAt,
    },
    toolTarget: {
      recordId: required(receipt.id, 'task_truth_snapshot_target_record_missing', 180),
      requestId,
      taskId,
      toolName,
      targetType,
      targetId: targetIdentity,
      displayName: displayTarget(targetIdentity),
      source: 'conversation_action_receipts.targetIdentity',
      normalizedTargetSha256,
      recordedAt: receiptAt,
    },
    modelActualInput,
  };
}

function cloneDb(value: any): any {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Captures only from runtime-owned stores. The caller supplies identities to
 * select an existing chain, never task state, tool output, or model evidence.
 */
export async function captureTaskTruthSnapshot(
  input: CaptureTaskTruthSnapshotInput,
): Promise<TaskTruthSnapshot> {
  const db = cloneDb(readDB());
  const task = exactRow<Record<string, any>>(
    db.conversationActionTasks,
    row => row.id === input.taskId
      && row.conversationId === input.conversationId
      && row.userId === input.userId,
    'task_truth_snapshot_task_missing',
  );
  const turn = exactRow<Record<string, any>>(
    db.conversationActionTurns,
    row => row.requestId === input.requestId
      && row.conversationId === input.conversationId
      && row.userId === input.userId,
    'task_truth_snapshot_request_missing',
  );
  const pendingConfirmation = await getPendingConfirmationDurably(input.userId, {
    ...buildTransportNeutralConfirmationScope({
      domain: String(task.domain || ''),
      orgId: String(task.orgId || ''),
      conversationId: input.conversationId,
      taskId: input.taskId,
    }),
  });
  return buildTaskTruthSnapshotFromSources({
    ...input,
    db,
    pendingConfirmation,
  });
}
