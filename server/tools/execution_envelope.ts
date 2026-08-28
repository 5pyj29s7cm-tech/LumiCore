import crypto from 'node:crypto';
import { isConfirmationBlockedToolRecord } from './confirmation_block';
import type { ToolExecutionEnvelope, ToolExecutionRecord } from './types';
import { toolRecordSucceeded } from '../cognition/task_execution_ledger';
import { toolRecordTerminalPayload } from './receipt_payload';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => [key, stableValue((value as Record<string, unknown>)[key])]),
  );
}

export function toolRecordIdempotencyKey(record: ToolExecutionRecord): string {
  if (record.idempotencyKey) return record.idempotencyKey;
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue({ name: record.name, arguments: record.arguments || {} })))
    .digest('hex');
}

function cleanObservedTarget(value: unknown): string {
  const target = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!target || /^(?:none|null|undefined|unknown|n\/a|unavailable)$/i.test(target)) return '';
  return target.slice(0, 500);
}

function looksLikeObservedDocumentPath(value: string): boolean {
  return /^(?:~[\\/]|[a-z]:[\\/]|\\\\|\/)/i.test(value)
    || /[\\/]/u.test(value)
    || /\.(?:pptx?|docx?|xlsx?|pdf|rtf|txt|md|csv|json|wps|et|dps)$/i.test(value);
}

function verifiedObservedWindowTarget(record: ToolExecutionRecord): string {
  if (
    record.terminalVerification?.status !== 'verified'
    || !toolRecordSucceeded(record)
  ) return '';
  const parsed = toolRecordTerminalPayload(record);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const payload = parsed as Record<string, any>;
  const currentDocument = payload.currentDocument
    && typeof payload.currentDocument === 'object'
    && !Array.isArray(payload.currentDocument)
    ? payload.currentDocument as Record<string, any>
    : {};
  const pathStatus = cleanObservedTarget(
    currentDocument.pathStatus
    || currentDocument.path_status
    || payload.documentPathStatus
    || payload.document_path_status,
  ).toLowerCase();
  const path = cleanObservedTarget(currentDocument.path || payload.documentPath);
  const pathIsUnknown = /^(?:unknown|unresolved|missing|not_found|unavailable|null|none)$/i.test(pathStatus);
  if (path && !pathIsUnknown && looksLikeObservedDocumentPath(path)) return path;

  return cleanObservedTarget(
    currentDocument.name
    || payload.documentName
    || payload.windowTitle
    || payload.title,
  );
}

function runtimeWorkCancelTaskSetIdentity(record: ToolExecutionRecord): string {
  if (record.name !== 'runtime_work_cancel') return '';
  const rawTaskIds = record.arguments?.taskIds;
  if (
    !Array.isArray(rawTaskIds)
    || rawTaskIds.length === 0
    || rawTaskIds.some(taskId => typeof taskId !== 'string' || !taskId.trim())
  ) return '';
  const taskIds = Array.from(new Set(rawTaskIds.map(taskId => taskId.trim()))).sort();
  if (taskIds.length === 0) return '';
  const digest = crypto.createHash('sha256').update(JSON.stringify(taskIds)).digest('hex');
  return `runtime_work_cancel:taskIds:sha256:${digest}:count:${taskIds.length}`;
}

export function toolRecordTargetIdentity(record: ToolExecutionRecord): string {
  // Foreground observation tools accept no semantic target argument. Ignore
  // caller/model-supplied compatibility arguments even when present: only the
  // explicitly verified native result may establish the durable identity.
  if (/^(?:desktop_active_window|get_active_window_info)$/i.test(record.name)) {
    return verifiedObservedWindowTarget(record);
  }

  // Batch runtime cleanup has no generic `target` argument by design: the
  // immutable target is the exact non-empty taskIds set. Persist only a
  // deterministic identity of its sorted/deduplicated members; never add an
  // argument or reinterpret an empty array as cancel-all authority.
  const runtimeWorkTaskSet = runtimeWorkCancelTaskSetIdentity(record);
  if (runtimeWorkTaskSet) return runtimeWorkTaskSet;

  const args = record.arguments || {};
  const argumentTarget = String(
    args.contact
    || args.recipient
    || args.target
    || args.filePath
    || args.path
    || args.url
    || args.applicationTarget
    || '',
  ).trim();
  if (argumentTarget) return argumentTarget.slice(0, 500);
  return '';
}

export function buildToolExecutionEnvelope(
  record: ToolExecutionRecord,
  correlation: {
    taskId?: string;
    turnId?: string;
    requestId?: string;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
  } = {},
): ToolExecutionEnvelope {
  const parsed = toolRecordTerminalPayload(record);
  const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, any>
    : {};
  const rawError = String(record.error || '').trim();
  const timeout = /timed?\s*out|timeout/i.test(rawError);
  const unknownOutcome = /unknown (?:prior )?(?:external commit )?outcome|external commit outcome is unknown|automatic resend was stopped/i.test(rawError);
  const forbidden = /forbidden|not exposed|outside .*policy|permission denied|adapter circuit is open/i.test(rawError);
  const targetMismatch = payload.targetMatched === false
    || payload.conversationVerified === false
    || /target mismatch|conversation was not verified/i.test(rawError);
  const waitingConfirmation = isConfirmationBlockedToolRecord(record);
  const externalCommit = record.capability?.sideEffects?.some(effect =>
    effect.type === 'external_communication' || effect.type === 'external_state_change',
  ) || /(?:send|submit|publish|post|comment|reply|payment|purchase|sign)/i.test(record.name);
  const unverifiedExternalResult = externalCommit && (
    /^(?:uncertain|unknown|submitted_unverified|unverified)$/i.test(String(payload.verificationStatus || payload.status || ''))
    || payload.outcomeUnknown === true
  );
  const succeeded = toolRecordSucceeded(record);
  const verificationRequired = record.capability?.verification.required === true;
  const terminalVerificationStatus = record.terminalVerification?.status;
  const terminalVerified = terminalVerificationStatus === 'verified';
  const compatibilitySuccess = terminalVerificationStatus === undefined
    && !verificationRequired
    && succeeded;
  const verificationStatus = terminalVerificationStatus
    || (succeeded ? 'unverified' : 'failed');

  let status: ToolExecutionEnvelope['status'];
  if (waitingConfirmation) status = 'waiting_confirmation';
  else if (targetMismatch) status = 'target_mismatch';
  else if (forbidden) status = 'forbidden';
  else if (((timeout || unknownOutcome) && externalCommit) || unverifiedExternalResult) status = 'unknown_outcome';
  else if (timeout) status = 'timeout';
  else status = succeeded && (terminalVerified || compatibilitySuccess) ? 'verified_success' : 'failed';

  return {
    version: 1,
    status,
    toolName: record.name,
    taskId: String(record.taskId || correlation.taskId || ''),
    turnId: String(record.turnId || correlation.turnId || ''),
    requestId: String(record.requestId || correlation.requestId || ''),
    idempotencyKey: toolRecordIdempotencyKey(record),
    targetIdentity: toolRecordTargetIdentity(record),
    ...(correlation.startedAt ? { startedAt: correlation.startedAt } : {}),
    completedAt: correlation.completedAt || new Date().toISOString(),
    ...(correlation.durationMs !== undefined ? { durationMs: correlation.durationMs } : {}),
    ...(parsed !== undefined ? { result: parsed } : {}),
    ...(rawError ? { error: rawError } : {}),
    verification: {
      status: verificationStatus,
      basis: terminalVerificationStatus === undefined
        ? 'compatibility_inference'
        : 'terminal_verification',
      reason: record.terminalVerification?.reason
        || (succeeded
          ? 'Successful result recorded without explicit terminal verification.'
          : rawError || status),
    },
  };
}
