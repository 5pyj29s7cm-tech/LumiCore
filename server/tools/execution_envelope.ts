import crypto from 'node:crypto';
import { isConfirmationBlockedToolRecord } from './confirmation_block';
import type { ToolExecutionEnvelope, ToolExecutionRecord } from './types';
import { toolRecordSucceeded } from '../cognition/task_execution_ledger';

function parseResult(value: string): unknown {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

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

export function toolRecordTargetIdentity(record: ToolExecutionRecord): string {
  const args = record.arguments || {};
  return String(
    args.contact
    || args.recipient
    || args.target
    || args.filePath
    || args.path
    || args.url
    || args.applicationTarget
    || '',
  ).trim().slice(0, 500);
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
  const parsed = parseResult(record.result);
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
  const verificationStatus = record.terminalVerification?.status
    || (succeeded ? 'verified' : 'failed');

  let status: ToolExecutionEnvelope['status'];
  if (waitingConfirmation) status = 'waiting_confirmation';
  else if (targetMismatch) status = 'target_mismatch';
  else if (forbidden) status = 'forbidden';
  else if (((timeout || unknownOutcome) && externalCommit) || unverifiedExternalResult) status = 'unknown_outcome';
  else if (timeout) status = 'timeout';
  else status = succeeded ? 'verified_success' : 'failed';

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
      reason: record.terminalVerification?.reason
        || (succeeded ? 'Terminal tool receipt satisfied the capability contract.' : rawError || status),
    },
  };
}
