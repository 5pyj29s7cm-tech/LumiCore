import { normalizeCompletionFeedbackForPersistence } from '../../conversation/completion_feedback';
import { sanitizeMediaArtifactReceipt } from '../media_artifact_receipt';

import { type ChatExecutionStatus, type ChatExecutionScope, type ChatExecutionEvent, type StoredExecution, type PersistedChatExecutionReceipt, TERMINAL_RETENTION_MS, CONTROL_INTENT_RETENTION_MS, MAX_TERMINAL_TEXT_CHARS, MAX_TERMINAL_ERROR_CHARS } from './contracts';

export function compactString(value: unknown, limit: number): string {
  return typeof value === 'string'
    ? value.replace(/\0/g, '').trim().slice(0, limit)
    : '';
}

export function finiteRevision(value: unknown): number | undefined {
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0 ? Math.trunc(revision) : undefined;
}

export function exactTerminalTaskBinding(
  value: unknown,
  requestId: string,
): { taskId: string; revision: number; targetRequestId: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const taskId = compactString(candidate.taskId, 180);
  const targetRequestId = compactString(candidate.targetRequestId, 180);
  const revision = finiteRevision(candidate.revision);
  if (!taskId || revision === undefined || targetRequestId !== compactString(requestId, 180)) {
    return undefined;
  }
  return { taskId, revision, targetRequestId };
}

function sanitizeTerminalPayload(
  scope: ChatExecutionScope,
  record: StoredExecution,
): Record<string, any> {
  const terminal = record.terminalEvent;
  if (!terminal) return {};
  const payload = terminal.payload || {};
  const sanitized: Record<string, any> = {
    source: record.source,
    requestId: record.requestId,
    conversationId: compactString(scope.conversationId, 180),
    sidecar: record.sidecar === true,
    finalized: payload.finalized === true,
    blocked: payload.blocked === true,
  };

  // Recovery needs the final user-visible receipt, not the complete execution
  // payload. Persist only an allowlisted, bounded subset: never tool inputs,
  // attachments, history, provider traces, or arbitrary nested metadata.
  const reason = compactString(payload.reason, 80);
  const agentName = compactString(payload.agentName, 120);
  if (reason) sanitized.reason = reason;
  if (agentName) sanitized.agentName = agentName;
  const completionFeedback = normalizeCompletionFeedbackForPersistence(payload.completionFeedback);
  if (completionFeedback) sanitized.completionFeedback = completionFeedback;
  const artifactReceipt = sanitizeMediaArtifactReceipt(payload.artifactReceipt);
  if (artifactReceipt) sanitized.artifactReceipt = artifactReceipt;
  const taskBinding = exactTerminalTaskBinding(payload.taskRelation, record.requestId);
  if (taskBinding) sanitized.taskBinding = taskBinding;
  if (record.sidecar === true && record.controlIntentTarget) {
    sanitized.controlIntent = 'cancel';
    sanitized.targetRequestId = compactString(record.controlIntentTarget, 180);
  } else if (
    record.sidecar === true
    && payload.controlIntent === 'status'
    && compactString(payload.targetRequestId, 180)
  ) {
    // A post-terminal status sidecar is a read-only exact-target query. Keep
    // only its bounded target fence so acceptance/reconnect readers can prove
    // it did not silently drift to a newer or merely "latest" execution.
    sanitized.controlIntent = 'status';
    sanitized.targetRequestId = compactString(payload.targetRequestId, 180);
  }
  if (terminal.event === 'agent:response') {
    const text = compactString(payload.text, MAX_TERMINAL_TEXT_CHARS);
    if (text) sanitized.text = text;
  } else if (terminal.event === 'agent:error') {
    const message = compactString(payload.message, MAX_TERMINAL_ERROR_CHARS);
    if (message) sanitized.message = message;
    const code = compactString(payload.code, 120);
    if (code) sanitized.code = code;
  }
  return sanitized;
}

export function persistedReceipt(
  scope: ChatExecutionScope,
  record: StoredExecution,
): PersistedChatExecutionReceipt | null {
  if (!record.terminal || !record.terminalEvent) return null;
  if (!['completed', 'cancelled', 'failed'].includes(record.status)) return null;
  if (!['agent:response', 'agent:error'].includes(record.terminalEvent.event)) return null;
  return {
    userId: compactString(scope.userId, 180),
    domain: scope.domain === 'work' ? 'work' : 'personal',
    orgId: scope.domain === 'work' ? compactString(scope.orgId, 180) : '',
    source: compactString(scope.source || record.source || 'chat', 120) || 'chat',
    conversationId: compactString(scope.conversationId, 180),
    requestId: compactString(record.requestId, 180),
    status: record.status as PersistedChatExecutionReceipt['status'],
    event: compactString(record.terminalEvent.event, 120),
    payload: sanitizeTerminalPayload(scope, record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: new Date(
      Date.parse(record.updatedAt)
      + (record.sidecar === true ? CONTROL_INTENT_RETENTION_MS : TERMINAL_RETENTION_MS),
    ).toISOString(),
  };
}

export function terminalStatusForEvent(
  event: string,
  payload: Record<string, any>,
): 'completed' | 'cancelled' | 'failed' | null {
  if (event === 'agent:error') return 'failed';
  if (event !== 'agent:response') return null;
  const reason = String(payload.reason || '').trim().toLowerCase();
  if (
    reason === 'cancelled'
    || reason === 'canceled'
    || reason === 'request_cancelled'
  ) return 'cancelled';
  if (payload.blocked === true || payload.finalized !== true) return 'failed';
  return 'completed';
}

export function statusForEvent(
  current: ChatExecutionStatus,
  event: string,
  payload: Record<string, any>,
): ChatExecutionStatus {
  const terminalStatus = terminalStatusForEvent(event, payload);
  if (terminalStatus) return terminalStatus;
  if (event === 'agent:confirm_tool') return 'waiting_confirmation';
  if (event === 'agent:tool' || event === 'agent:tool_call') return 'executing';
  if (event === 'agent:status') {
    const status = String(payload.status || '').trim().toLowerCase();
    if (status === 'thinking' || status === 'responding') return 'planning';
    // A model composing its answer is not task execution. Explicit execution
    // status is accepted only when the server emitter attaches its own proof;
    // model-authored text or an untrusted status frame cannot promote the
    // durable request to `executing`.
    if (status === 'executing' && payload.executionAccepted === true) return 'executing';
    if (status === 'waiting_confirmation') return 'waiting_confirmation';
    if (status === 'cancelling') return 'cancelling';
  }
  return current;
}

export function unknownTerminalEvent(
  scope: ChatExecutionScope, record: StoredExecution, requestId: string, payload: Record<string, any>,
): ChatExecutionEvent {
  const completionFeedback = normalizeCompletionFeedbackForPersistence(payload.completionFeedback);
  return { event: 'agent:response', payload: {
    text: compactString(payload.text, MAX_TERMINAL_TEXT_CHARS),
    agentName: compactString(payload.agentName, 120) || 'Lumi',
    source: record.source, requestId, conversationId: compactString(scope.conversationId, 180),
    sidecar: record.sidecar === true, finalized: true, blocked: true, reason: 'persistence_unknown',
    ...(completionFeedback ? { completionFeedback } : {}),
  } };
}
