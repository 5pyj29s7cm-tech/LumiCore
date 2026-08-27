import crypto from 'node:crypto';
import { readDB } from '../../db_layer';
import {
  conversationTaskStatusOwnsExecutionLease,
  isTerminalConversationTaskStatus,
} from '../cognition/task_execution_ledger';
import type { ToolExecutionRecord } from '../tools/types';
import { classifyConversationReceiptOwnership } from '../conversation/receipt_ownership';

export const TASK_REGRESSION_STALE_RECEIPT_EVIDENCE_KIND =
  'lumi.task-regression-stale-receipt-evidence' as const;
export const TASK_REGRESSION_STALE_RECEIPT_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const DISPLAYED_RESULT_STALE_RECEIPT_SCENARIO =
  'displayed_result_stale_receipt' as const;

const SHA256_RE = /^[a-f0-9]{64}$/u;

export interface ReclassifyManifestBoundStaleReceiptInput {
  acceptanceRunId: string;
  buildIdentityDigest: string;
  scenarioId: typeof DISPLAYED_RESULT_STALE_RECEIPT_SCENARIO;
  userId: string;
  conversationId: string;
  displayRequestId: string;
  continueRequestId: string;
}

interface StaleReceiptReclassificationDependencies {
  readDb?: () => any;
  persistLateAssistant?: (message: Record<string, unknown>) => string | Promise<string>;
  now?: () => Date;
}

export interface TaskRegressionStaleReceiptEvidence {
  kind: typeof TASK_REGRESSION_STALE_RECEIPT_EVIDENCE_KIND;
  schemaVersion: typeof TASK_REGRESSION_STALE_RECEIPT_EVIDENCE_SCHEMA_VERSION;
  evidenceId: string;
  scenarioId: typeof DISPLAYED_RESULT_STALE_RECEIPT_SCENARIO;
  acceptanceRunId: string;
  buildIdentityDigest: string;
  capturedAt: string;
  conversationId: string;
  sourceReceipt: {
    recordId: string;
    taskId: string;
    requestId: string;
    toolName: string;
    recordSha256Before: string;
    recordSha256After: string;
    inputSha256: string;
    idempotencyKeySha256: string;
  };
  archive: {
    recordId: string;
    taskId: string;
    requestId: string;
    toolName: string;
    recordSha256: string;
    idempotencyKeySha256: string;
    createdAt: string;
    lateAssistantMessageId: string;
  };
  oldOwner: {
    taskId: string;
    requestId: string;
    taskStatus: string;
    turnStatus: string;
    leaseReleased: true;
  };
  liveOwnerBefore: {
    taskId: string;
    requestId: string;
    status: string;
    taskSha256: string;
    pointerSha256: string;
    pendingSha256: string;
  };
  liveOwnerAfter: {
    taskId: string;
    requestId: string;
    status: string;
    taskSha256: string;
    pointerSha256: string;
    pendingSha256: string;
  };
  liveTaskAudit: {
    recordSha256Before: string;
    recordSha256After: string;
    changedFields: Array<'context.focusThread.updatedAt' | 'updatedAt'>;
    semanticSha256Before: string;
    semanticSha256After: string;
  };
  staleReclassification: {
    observationKind: 'stale_reclassification';
    sourceReceiptRef: string;
    classifierInputSha256: string;
    mismatchDimension: 'task_id';
    classification: 'stale';
    archiveRef: string;
    sourceReceiptUnchanged: true;
    leaseReleased: true;
  };
  invariants: {
    sourceReceiptUnchanged: true;
    newLiveTaskUnchanged: true;
    newLivePointerUnchanged: true;
    newPendingPointerUnchanged: true;
    archiveBoundToSourceTask: true;
  };
}

function staleEvidenceError(code: string): Error {
  const error = new Error(code);
  error.name = 'TaskRegressionStaleReceiptEvidenceError';
  return error;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [
    key,
    stableValue((value as Record<string, unknown>)[key]),
  ]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function digest(value: unknown): string {
  return sha256(stableJson(value));
}

function taskSemanticProjection(value: Record<string, any>): Record<string, any> {
  const task = clone(value);
  delete task.updatedAt;
  const context = parseObject(task.context, 'task_regression_stale_live_task_context_invalid');
  if (context.focusThread && typeof context.focusThread === 'object' && !Array.isArray(context.focusThread)) {
    context.focusThread = { ...context.focusThread };
    delete context.focusThread.updatedAt;
  }
  task.context = context;
  return task;
}

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseObject(value: unknown, code: string): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
    } catch {}
  }
  throw staleEvidenceError(code);
}

function parseToolCalls(value: unknown): ToolExecutionRecord[] {
  let parsed = value;
  for (let depth = 0; depth < 2 && typeof parsed === 'string' && parsed.trim(); depth += 1) {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  return Array.isArray(parsed) ? parsed as ToolExecutionRecord[] : [];
}

function exactRow<T>(
  rows: unknown,
  predicate: (row: T) => boolean,
  code: string,
): T {
  const matches = (Array.isArray(rows) ? rows : []).filter(row => predicate(row as T)) as T[];
  if (matches.length !== 1) throw staleEvidenceError(code);
  return matches[0];
}

function nonempty(value: unknown, code: string): string {
  const text = String(value || '').trim();
  if (!text || text.length > 500 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw staleEvidenceError(code);
  }
  return text;
}

function liveOwnerProjection(db: any, conversation: any, continueRequestId: string): {
  taskId: string;
  requestId: string;
  status: string;
  taskSha256: string;
  pointerSha256: string;
  pendingSha256: string;
} {
  const pointer = parseObject(
    conversation.actionContinuationState,
    'task_regression_stale_live_pointer_missing',
  );
  const pending = conversation.pendingActionContinuation == null
    ? null
    : parseObject(
      conversation.pendingActionContinuation,
      'task_regression_stale_pending_pointer_invalid',
    );
  const taskId = nonempty(pointer.taskId, 'task_regression_stale_live_task_missing');
  const status = nonempty(pointer.status, 'task_regression_stale_live_status_missing');
  if (
    pointer.unfinished !== true
    || isTerminalConversationTaskStatus(status)
  ) throw staleEvidenceError('task_regression_stale_live_owner_not_current');
  const task = exactRow<Record<string, any>>(
    db.conversationActionTasks,
    row => row.id === taskId
      && row.conversationId === conversation.id
      && row.userId === conversation.userId,
    'task_regression_stale_live_task_ambiguous',
  );
  const turn = exactRow<Record<string, any>>(
    db.conversationActionTurns,
    row => row.requestId === continueRequestId
      && row.conversationId === conversation.id
      && row.userId === conversation.userId,
    'task_regression_stale_live_turn_ambiguous',
  );
  const terminalAssistant = exactRow<Record<string, any>>(
    db.interactions,
    row => row.id === turn.terminalMessageId
      && row.userId === conversation.userId
      && row.conversationId === conversation.id
      && row.role === 'assistant'
      && row.requestId === continueRequestId,
    'task_regression_stale_live_terminal_assistant_ambiguous',
  );
  const pendingMessage = exactRow<Record<string, any>>(
    db.interactions,
    row => row.id === turn.userMessageId
      && row.userId === conversation.userId
      && row.conversationId === conversation.id
      && row.role === 'user'
      && row.requestId === continueRequestId,
    'task_regression_stale_live_user_message_ambiguous',
  );
  const taskContext = parseObject(
    task.context,
    'task_regression_stale_live_task_context_invalid',
  );
  const durableState = parseObject(
    taskContext.actionState,
    'task_regression_stale_live_task_state_invalid',
  );
  const ownsExecutionLease = conversationTaskStatusOwnsExecutionLease(status);
  if (
    status !== 'waiting_confirmation'
    || String(task.status || '') !== status
    || String(turn.taskId || '') !== taskId
    || String(turn.userMessageId || '') !== String(pendingMessage.id || '')
    || String(task.rootUserMessageId || '') !== String(pendingMessage.id || '')
    || String(pointer.latestInstruction || '') !== String(pendingMessage.message || '')
    || String(durableState.taskId || '') !== taskId
    || String(durableState.status || '') !== status
    || durableState.unfinished !== true
    || ownsExecutionLease
    || String(pointer.activeRequestId || '')
    || String(task.activeRequestId || '')
    || String(durableState.activeRequestId || '')
    || turn.status !== 'terminal'
    || !String(turn.terminalMessageId || '')
    || String(terminalAssistant.id || '') !== String(turn.terminalMessageId || '')
    || (pending !== null && (
      String(pending.requestId || '') !== continueRequestId
      || String(pending.messageId || '') !== String(pendingMessage.id || '')
      || String(pending.userText || '') !== String(pendingMessage.message || '')
    ))
  ) throw staleEvidenceError('task_regression_stale_live_owner_binding_invalid');
  return {
    taskId,
    requestId: continueRequestId,
    status,
    taskSha256: digest(taskSemanticProjection(task)),
    pointerSha256: digest(pointer),
    pendingSha256: digest(pending),
  };
}

async function defaultPersistLateAssistant(message: Record<string, unknown>): Promise<string> {
  const manager = await import('../conversation/manager');
  return manager.addMessageIdempotent(
    message as Parameters<typeof manager.addMessageIdempotent>[0],
  );
}

/**
 * Isolated acceptance seam for S4. Every task/request/receipt field comes from
 * the startup manifest plus runtime-owned rows. The HTTP caller never selects
 * or supplies a task id, receipt id, tool argument, tool result, or archive.
 * The late delivery is replayed through addMessageIdempotent, matching the
 * Socket terminal boundary. It reuses the visible assistant row while the
 * shared receipt classifier and archive path consume only stale records.
 */
export async function reclassifyManifestBoundStaleReceipt(
  input: ReclassifyManifestBoundStaleReceiptInput,
  dependencies: StaleReceiptReclassificationDependencies = {},
): Promise<TaskRegressionStaleReceiptEvidence> {
  if (
    input.scenarioId !== DISPLAYED_RESULT_STALE_RECEIPT_SCENARIO
    || !input.acceptanceRunId
    || !SHA256_RE.test(input.buildIdentityDigest)
    || !input.userId
    || !input.conversationId
    || !input.displayRequestId
    || !input.continueRequestId
    || input.displayRequestId === input.continueRequestId
  ) throw staleEvidenceError('task_regression_stale_binding_invalid');

  const readDb = dependencies.readDb || readDB;
  const persistLateAssistant = dependencies.persistLateAssistant || defaultPersistLateAssistant;
  const beforeDb = clone(readDb());
  const conversation = exactRow<Record<string, any>>(
    beforeDb.conversations,
    row => row.id === input.conversationId && row.userId === input.userId,
    'task_regression_stale_conversation_ambiguous',
  );
  const displayTurn = exactRow<Record<string, any>>(
    beforeDb.conversationActionTurns,
    row => row.requestId === input.displayRequestId
      && row.conversationId === input.conversationId
      && row.userId === input.userId,
    'task_regression_stale_display_turn_ambiguous',
  );
  const sourceTaskId = nonempty(
    displayTurn.taskId,
    'task_regression_stale_source_task_missing',
  );
  const sourceTask = exactRow<Record<string, any>>(
    beforeDb.conversationActionTasks,
    row => row.id === sourceTaskId
      && row.conversationId === input.conversationId
      && row.userId === input.userId,
    'task_regression_stale_source_task_ambiguous',
  );
  const liveBefore = liveOwnerProjection(beforeDb, conversation, input.continueRequestId);
  if (liveBefore.taskId === sourceTaskId) {
    throw staleEvidenceError('task_regression_stale_task_mismatch_not_observed');
  }

  const sourceReceipt = exactRow<Record<string, any>>(
    beforeDb.conversationActionReceipts,
    row => row.taskId === sourceTaskId
      && row.conversationId === input.conversationId
      && row.requestId === input.displayRequestId
      && row.toolName === 'read_file',
    'task_regression_stale_source_receipt_ambiguous',
  );
  const sourceReceiptId = nonempty(
    sourceReceipt.id,
    'task_regression_stale_source_receipt_missing',
  );
  const sourceAssistant = exactRow<Record<string, any>>(
    beforeDb.interactions,
    row => row.id === displayTurn.terminalMessageId
      && row.userId === input.userId
      && row.conversationId === input.conversationId
      && row.role === 'assistant'
      && row.requestId === input.displayRequestId,
    'task_regression_stale_source_assistant_ambiguous',
  );
  const sourceCalls = parseToolCalls(sourceAssistant.toolCalls).filter(record => (
    record.id === sourceReceiptId
    && record.name === sourceReceipt.toolName
    && record.taskId === sourceTaskId
    && record.requestId === input.displayRequestId
    && digest(record.arguments || {}) === sourceReceipt.inputDigest
  ));
  if (sourceCalls.length !== 1) {
    throw staleEvidenceError('task_regression_stale_source_tool_record_ambiguous');
  }
  const sourceCall = clone(sourceCalls[0]);
  const sourceEnvelope = parseObject(
    sourceReceipt.envelope,
    'task_regression_stale_source_envelope_invalid',
  );
  if (
    sourceEnvelope.taskId !== sourceTaskId
    || sourceEnvelope.requestId !== input.displayRequestId
    || sourceEnvelope.toolName !== sourceReceipt.toolName
    || sourceEnvelope.idempotencyKey !== sourceReceipt.idempotencyKey
  ) throw staleEvidenceError('task_regression_stale_source_envelope_mismatch');

  const sourceReceiptBeforeSha256 = digest(sourceReceipt);
  const sourceAssistantBeforeSha256 = digest(sourceAssistant);
  const interactionCountBefore = Array.isArray(beforeDb.interactions)
    ? beforeDb.interactions.length
    : 0;
  const deliverySeed = [
    input.acceptanceRunId,
    input.conversationId,
    input.displayRequestId,
    input.continueRequestId,
    sourceReceiptId,
    liveBefore.taskId,
  ].join(':');
  const lateRecordId = `stale_${sha256(`record:${deliverySeed}`).slice(0, 48)}`;
  const lateIdempotencyKey = sha256(`idempotency:${deliverySeed}`);
  const preexistingLateReceipt = (Array.isArray(beforeDb.conversationActionReceipts)
    ? beforeDb.conversationActionReceipts
    : []).some((row: any) => (
    row.id === lateRecordId || row.idempotencyKey === lateIdempotencyKey
  ));
  if (preexistingLateReceipt) {
    throw staleEvidenceError('task_regression_stale_replay_already_consumed');
  }
  const { envelope: _sourceEnvelope, ...sourceWithoutEnvelope } = sourceCall as ToolExecutionRecord;
  const lateRecord: ToolExecutionRecord = {
    ...sourceWithoutEnvelope,
    id: lateRecordId,
    taskId: sourceTaskId,
    turnId: input.displayRequestId,
    requestId: input.displayRequestId,
    idempotencyKey: lateIdempotencyKey,
  };
  const ownership = classifyConversationReceiptOwnership(lateRecord, {
    taskId: liveBefore.taskId,
    requestId: input.continueRequestId,
  });
  if (
    ownership.classification !== 'stale'
    || !ownership.mismatchDimensions.includes('task_id')
  ) throw staleEvidenceError('task_regression_stale_classifier_rejected');
  const classifierInputSha256 = digest({
    activeTaskId: liveBefore.taskId,
    activeRequestId: input.continueRequestId,
    record: lateRecord,
    sourceReceiptSha256: sourceReceiptBeforeSha256,
    ownership,
  });

  const lateAssistantMessageId = await persistLateAssistant({
    userId: input.userId,
    agentId: String(sourceAssistant.agentId || 'lumi'),
    conversationId: input.conversationId,
    role: 'assistant',
    content: String(sourceAssistant.message || sourceAssistant.content || ''),
    domain: String(sourceAssistant.domain || conversation.domain || 'personal'),
    orgId: String(sourceAssistant.orgId || conversation.orgId || ''),
    source: String(sourceAssistant.source || ''),
    channel: String(sourceAssistant.channel || ''),
    requestId: input.displayRequestId,
    toolCalls: [lateRecord],
  });
  const afterDb = clone(readDb());
  const conversationAfter = exactRow<Record<string, any>>(
    afterDb.conversations,
    row => row.id === input.conversationId && row.userId === input.userId,
    'task_regression_stale_conversation_changed',
  );
  const liveAfter = liveOwnerProjection(afterDb, conversationAfter, input.continueRequestId);
  const sourceReceiptAfter = exactRow<Record<string, any>>(
    afterDb.conversationActionReceipts,
    row => row.id === sourceReceiptId
      && row.taskId === sourceTaskId
      && row.conversationId === input.conversationId
      && row.requestId === input.displayRequestId,
    'task_regression_stale_source_receipt_changed',
  );
  const archive = exactRow<Record<string, any>>(
    afterDb.conversationActionReceipts,
    row => row.id === lateRecordId
      && row.idempotencyKey === lateIdempotencyKey
      && row.taskId === sourceTaskId
      && row.conversationId === input.conversationId
      && row.requestId === input.displayRequestId
      && row.toolName === sourceReceipt.toolName,
    'task_regression_stale_archive_missing',
  );
  const lateAssistant = exactRow<Record<string, any>>(
    afterDb.interactions,
    row => row.id === lateAssistantMessageId
      && row.userId === input.userId
      && row.conversationId === input.conversationId
      && row.role === 'assistant'
      && row.requestId === input.displayRequestId
      && String(row.source || '') === String(sourceAssistant.source || '')
      && String(row.channel || '') === String(sourceAssistant.channel || ''),
    'task_regression_stale_idempotent_assistant_missing',
  );
  const persistedLateCalls = parseToolCalls(lateAssistant.toolCalls).filter(record => (
    record.id === lateRecordId
  ));
  if (
    lateAssistantMessageId !== sourceAssistant.id
    || (Array.isArray(afterDb.interactions) ? afterDb.interactions.length : 0) !== interactionCountBefore
    || digest(lateAssistant) !== sourceAssistantBeforeSha256
    || persistedLateCalls.length !== 0
  ) {
    throw staleEvidenceError('task_regression_stale_idempotent_transcript_mutated');
  }
  const sourceReceiptAfterSha256 = digest(sourceReceiptAfter);
  if (sourceReceiptAfterSha256 !== sourceReceiptBeforeSha256) {
    throw staleEvidenceError('task_regression_stale_source_receipt_mutated');
  }
  if (
    liveAfter.taskId !== liveBefore.taskId
    || liveAfter.requestId !== liveBefore.requestId
    || liveAfter.status !== liveBefore.status
  ) throw staleEvidenceError('task_regression_stale_live_owner_identity_mutated');
  const beforeLiveTask = exactRow<Record<string, any>>(
    beforeDb.conversationActionTasks,
    row => row.id === liveBefore.taskId,
    'task_regression_stale_live_task_before_missing',
  );
  const afterLiveTask = exactRow<Record<string, any>>(
    afterDb.conversationActionTasks,
    row => row.id === liveAfter.taskId,
    'task_regression_stale_live_task_after_missing',
  );
  if (liveAfter.taskSha256 !== liveBefore.taskSha256) {
    const changedKeys = [...new Set([...Object.keys(beforeLiveTask), ...Object.keys(afterLiveTask)])]
      .filter(key => stableJson(beforeLiveTask[key]) !== stableJson(afterLiveTask[key]))
      .map(key => key.replace(/[^a-z0-9]+/giu, '_').toLowerCase())
      .filter(Boolean)
      .sort()
      .join('_');
    throw staleEvidenceError(
      `task_regression_stale_live_task_mutated_${changedKeys || 'unknown'}`,
    );
  }
  const changedTaskKeys = [...new Set([
    ...Object.keys(beforeLiveTask),
    ...Object.keys(afterLiveTask),
  ])].filter(key => stableJson(beforeLiveTask[key]) !== stableJson(afterLiveTask[key]));
  if (changedTaskKeys.some(key => key !== 'context' && key !== 'updatedAt')) {
    throw staleEvidenceError('task_regression_stale_live_task_non_audit_field_mutated');
  }
  const beforeLiveContext = parseObject(
    beforeLiveTask.context,
    'task_regression_stale_live_task_context_before_invalid',
  );
  const afterLiveContext = parseObject(
    afterLiveTask.context,
    'task_regression_stale_live_task_context_after_invalid',
  );
  const liveTaskAuditChangedFields: Array<'context.focusThread.updatedAt' | 'updatedAt'> = [];
  if (beforeLiveTask.updatedAt !== afterLiveTask.updatedAt) {
    liveTaskAuditChangedFields.push('updatedAt');
  }
  if (beforeLiveContext.focusThread?.updatedAt !== afterLiveContext.focusThread?.updatedAt) {
    liveTaskAuditChangedFields.push('context.focusThread.updatedAt');
  }
  if (
    digest(beforeLiveTask) !== digest(afterLiveTask)
    && liveTaskAuditChangedFields.length === 0
  ) throw staleEvidenceError('task_regression_stale_live_task_audit_change_unaccounted');
  if (liveAfter.pointerSha256 !== liveBefore.pointerSha256) {
    throw staleEvidenceError('task_regression_stale_live_pointer_mutated');
  }
  if (liveAfter.pendingSha256 !== liveBefore.pendingSha256) {
    throw staleEvidenceError('task_regression_stale_pending_pointer_mutated');
  }
  if (archive.inputDigest !== sourceReceipt.inputDigest) {
    throw staleEvidenceError('task_regression_stale_archive_input_mismatch');
  }

  const sourceTaskAfter = exactRow<Record<string, any>>(
    afterDb.conversationActionTasks,
    row => row.id === sourceTaskId
      && row.conversationId === input.conversationId
      && row.userId === input.userId,
    'task_regression_stale_source_task_changed',
  );
  const displayTurnAfter = exactRow<Record<string, any>>(
    afterDb.conversationActionTurns,
    row => row.requestId === input.displayRequestId
      && row.conversationId === input.conversationId
      && row.userId === input.userId,
    'task_regression_stale_display_turn_changed',
  );
  const oldLeaseReleased = displayTurnAfter.status !== 'leased'
    && !String(sourceTaskAfter.activeRequestId || '').trim()
    && !conversationTaskStatusOwnsExecutionLease(sourceTaskAfter.status)
    && liveAfter.taskId !== sourceTaskId;
  if (!oldLeaseReleased) {
    throw staleEvidenceError('task_regression_stale_old_lease_retained');
  }

  const capturedAt = (dependencies.now || (() => new Date()))().toISOString();
  const archiveRecordSha256 = digest(archive);
  const evidenceId = `stale_evidence_${sha256([
    deliverySeed,
    classifierInputSha256,
    archiveRecordSha256,
  ].join(':')).slice(0, 48)}`;
  return {
    kind: TASK_REGRESSION_STALE_RECEIPT_EVIDENCE_KIND,
    schemaVersion: TASK_REGRESSION_STALE_RECEIPT_EVIDENCE_SCHEMA_VERSION,
    evidenceId,
    scenarioId: DISPLAYED_RESULT_STALE_RECEIPT_SCENARIO,
    acceptanceRunId: input.acceptanceRunId,
    buildIdentityDigest: input.buildIdentityDigest,
    capturedAt,
    conversationId: input.conversationId,
    sourceReceipt: {
      recordId: sourceReceiptId,
      taskId: sourceTaskId,
      requestId: input.displayRequestId,
      toolName: String(sourceReceipt.toolName),
      recordSha256Before: sourceReceiptBeforeSha256,
      recordSha256After: sourceReceiptAfterSha256,
      inputSha256: String(sourceReceipt.inputDigest),
      idempotencyKeySha256: sha256(String(sourceReceipt.idempotencyKey)),
    },
    archive: {
      recordId: String(archive.id),
      taskId: String(archive.taskId),
      requestId: String(archive.requestId),
      toolName: String(archive.toolName),
      recordSha256: archiveRecordSha256,
      idempotencyKeySha256: sha256(String(archive.idempotencyKey)),
      createdAt: String(archive.createdAt),
      lateAssistantMessageId,
    },
    oldOwner: {
      taskId: sourceTaskId,
      requestId: input.displayRequestId,
      taskStatus: String(sourceTaskAfter.status || sourceTask.status || ''),
      turnStatus: String(displayTurnAfter.status || displayTurn.status || ''),
      leaseReleased: true,
    },
    liveOwnerBefore: liveBefore,
    liveOwnerAfter: liveAfter,
    liveTaskAudit: {
      recordSha256Before: digest(beforeLiveTask),
      recordSha256After: digest(afterLiveTask),
      changedFields: liveTaskAuditChangedFields.sort(),
      semanticSha256Before: liveBefore.taskSha256,
      semanticSha256After: liveAfter.taskSha256,
    },
    staleReclassification: {
      observationKind: 'stale_reclassification',
      sourceReceiptRef: sourceReceiptId,
      classifierInputSha256,
      mismatchDimension: 'task_id',
      classification: 'stale',
      archiveRef: String(archive.id),
      sourceReceiptUnchanged: true,
      leaseReleased: true,
    },
    invariants: {
      sourceReceiptUnchanged: true,
      newLiveTaskUnchanged: true,
      newLivePointerUnchanged: true,
      newPendingPointerUnchanged: true,
      archiveBoundToSourceTask: true,
    },
  };
}
