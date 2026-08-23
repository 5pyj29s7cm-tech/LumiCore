import crypto from 'node:crypto';
import { readDB, writeDB } from '../../db_layer';
import type { UserLLMSelectionMode } from './user_preferences';

export type ModelRouteAttemptStatus = 'succeeded' | 'failed' | 'skipped';

export interface ModelRouteAttempt {
  provider: string;
  model: string;
  status: ModelRouteAttemptStatus;
  reason?: string;
  errorCategory?: string;
  errorDigest?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  visibleOutputCommitted?: boolean;
}

export interface ModelRoutingTrace {
  requestedProvider: string;
  requestedModel: string;
  selectionMode: UserLLMSelectionMode;
  selectedProvider: string;
  selectedModel: string;
  fallbackReason: string;
  attempts: ModelRouteAttempt[];
}

export interface ModelRoutingReceipt extends ModelRoutingTrace {
  id: string;
  userId: string;
  domain: string;
  orgId: string;
  conversationId: string;
  requestId: string;
  interactionId: string;
  source: string;
  status: 'succeeded' | 'failed';
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

function compact(value: unknown, limit = 200): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function modelRoutingErrorReason(error: unknown): string {
  const message = compact((error as any)?.message || error, 500).toLowerCase();
  if (!message) return 'unknown_error';
  if (/abort|cancel/.test(message)) return 'cancelled';
  if (/circuit/.test(message)) return 'circuit_open';
  if (/insufficient balance|payment required|quota|rate.?limit|too many requests|\b429\b|\b402\b/.test(message)) return 'quota_or_billing';
  if (/unauthorized|authentication|invalid api key|\b401\b|\b403\b/.test(message)) return 'provider_auth_failed';
  if (/timeout|timed out/.test(message)) return 'timeout';
  if (/not reachable|connection|fetch failed|econnrefused|socket/.test(message)) return 'provider_unreachable';
  if (/not loaded|no text-generation model|model.*unavailable/.test(message)) return 'model_unavailable';
  if (/not configured|missing.*key|api key/.test(message)) return 'provider_not_configured';
  if (/privacy|local-only|local only/.test(message)) return 'privacy_policy_blocked';
  if (/unsupported/.test(message)) return 'unsupported_provider_or_model';
  return 'provider_call_failed';
}

export function modelRoutingErrorDigest(error: unknown): string {
  const message = compact((error as any)?.message || error, 1000);
  return message ? crypto.createHash('sha256').update(message).digest('hex') : '';
}

function normalizeAttempt(value: ModelRouteAttempt): ModelRouteAttempt {
  return {
    provider: compact(value.provider),
    model: compact(value.model),
    status: value.status,
    ...(value.reason ? { reason: compact(value.reason) } : {}),
    ...(value.errorCategory ? { errorCategory: compact(value.errorCategory, 64) } : {}),
    ...(value.errorDigest ? { errorDigest: compact(value.errorDigest, 64) } : {}),
    ...(value.startedAt ? { startedAt: compact(value.startedAt, 40) } : {}),
    ...(value.completedAt ? { completedAt: compact(value.completedAt, 40) } : {}),
    ...(value.durationMs !== undefined ? { durationMs: Math.max(0, Math.trunc(Number(value.durationMs) || 0)) } : {}),
    ...(value.visibleOutputCommitted !== undefined ? { visibleOutputCommitted: value.visibleOutputCommitted === true } : {}),
  };
}

const MAX_RECEIPTS_PER_USER = 5_000;

export function persistModelRoutingReceipt(input: Omit<ModelRoutingReceipt, 'id'> & { id?: string }): ModelRoutingReceipt {
  const receipt: ModelRoutingReceipt = {
    id: input.id || crypto.randomUUID(),
    userId: compact(input.userId || 'anonymous'),
    domain: compact(input.domain || 'personal'),
    orgId: compact(input.orgId),
    conversationId: compact(input.conversationId),
    requestId: compact(input.requestId),
    interactionId: compact(input.interactionId),
    source: compact(input.source),
    status: input.status,
    requestedProvider: compact(input.requestedProvider),
    requestedModel: compact(input.requestedModel),
    selectionMode: input.selectionMode,
    selectedProvider: compact(input.selectedProvider),
    selectedModel: compact(input.selectedModel),
    fallbackReason: compact(input.fallbackReason),
    attempts: (input.attempts || []).map(normalizeAttempt).slice(0, 12),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: Math.max(0, Math.trunc(Number(input.durationMs) || 0)),
  };
  const db = readDB();
  if (!Array.isArray(db.modelRoutingReceipts)) db.modelRoutingReceipts = [];
  db.modelRoutingReceipts.push(receipt);
  let remainingForUser = MAX_RECEIPTS_PER_USER;
  const retained: ModelRoutingReceipt[] = [];
  for (let index = db.modelRoutingReceipts.length - 1; index >= 0; index -= 1) {
    const candidate = db.modelRoutingReceipts[index] as ModelRoutingReceipt;
    if (candidate.userId === receipt.userId) {
      if (remainingForUser <= 0) continue;
      remainingForUser -= 1;
    }
    retained.push(candidate);
  }
  db.modelRoutingReceipts = retained.reverse();
  writeDB(db);
  return { ...receipt, attempts: receipt.attempts.map(attempt => ({ ...attempt })) };
}

export function listModelRoutingReceipts(
  userId: string,
  limit = 100,
  filter: { conversationId?: string; requestId?: string; interactionId?: string } = {},
): ModelRoutingReceipt[] {
  const uid = compact(userId || 'anonymous');
  const conversationId = compact(filter.conversationId);
  const requestId = compact(filter.requestId);
  const interactionId = compact(filter.interactionId);
  const db = readDB();
  return (Array.isArray(db.modelRoutingReceipts) ? db.modelRoutingReceipts : [])
    .filter((receipt: ModelRoutingReceipt) => receipt.userId === uid)
    .filter((receipt: ModelRoutingReceipt) => !conversationId || receipt.conversationId === conversationId)
    .filter((receipt: ModelRoutingReceipt) => !requestId || receipt.requestId === requestId)
    .filter((receipt: ModelRoutingReceipt) => !interactionId || receipt.interactionId === interactionId)
    .sort((left: ModelRoutingReceipt, right: ModelRoutingReceipt) => (
      Date.parse(right.completedAt || '') - Date.parse(left.completedAt || '')
    ))
    .slice(0, Math.max(1, Math.min(Math.trunc(limit) || 100, 1000)))
    .map((receipt: ModelRoutingReceipt) => ({
      ...receipt,
      attempts: (receipt.attempts || []).map(attempt => ({ ...attempt })),
    }));
}
