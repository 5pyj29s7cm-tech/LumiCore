import crypto from "node:crypto";
import type { ConversationActionContinuationState } from "../../cognition/action_continuation";
import type { NormalizedActionIntent } from "../../cognition/normalized_action_intent";
import { parseReceiptObject } from "../../tools/receipt_payload";
import type { PersistedCapabilityExecutionPlan, ConversationActionTaskRow } from './contracts';

/** Keep the current plan once; history contains only prior revisions. */
export function contextWithExecutionPlan(context: Record<string, any>, plan: PersistedCapabilityExecutionPlan) {
  const history = new Map<string, PersistedCapabilityExecutionPlan>();
  for (const prior of [...(Array.isArray(context.executionPlans) ? context.executionPlans : []), context.executionPlan]) {
    if (prior?.planId && prior.planId !== plan.planId) history.set(prior.planId, prior);
  }
  return { ...context, executionPlan: plan, executionPlans: [...history.values()].slice(-11) };
}

export function stableValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => stableValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [
    key,
    stableValue((value as Record<string, unknown>)[key], depth + 1),
  ]));
}

export function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

export function parseObject(value: unknown): Record<string, any> {
  return parseReceiptObject(value) || {};
}

export function taskPersistenceUnknownMarker(
  task: ConversationActionTaskRow | null | undefined,
): ConversationActionContinuationState['terminalPersistence'] | undefined {
  if (!task) return undefined;
  const context = parseObject(task.context);
  const taskMarker = context.terminalPersistence;
  const stateMarker = parseObject(context.actionState).terminalPersistence;
  const marker = taskMarker?.status === 'persistence_unknown' ? taskMarker : stateMarker;
  if (marker?.status !== 'persistence_unknown') return undefined;
  return {
    status: 'persistence_unknown',
    requestId: String(marker.requestId || '').trim().slice(0, 180),
    quarantinedAt: String(marker.quarantinedAt || '').trim().slice(0, 80),
  };
}

export function redactArguments(args: Record<string, any>): Record<string, any> {
  const sensitive = /^(?:message|text|content|body|payload|draft|password|secret|token|api.?key)$/i;
  return Object.fromEntries(Object.entries(args || {}).map(([key, value]) => (
    sensitive.test(key)
      ? [key, { digest: digest(value), length: typeof value === 'string' ? value.length : undefined }]
      : [key, stableValue(value)]
  )));
}

export function redactGoal(goal: string, intent: NormalizedActionIntent): string {
  if (intent.sideEffectClass !== 'external_commit' || !intent.payload) return String(goal || '').trim();
  return `${intent.kind}:${intent.target || '(unresolved target)'} payload_sha256=${digest(intent.payload)}`;
}

export function sanitizeState(state: ConversationActionContinuationState): ConversationActionContinuationState {
  return {
    ...state,
    receipts: (state.receipts || []).map(receipt => ({
      ...receipt,
      arguments: redactArguments(receipt.arguments || {}),
    })),
  };
}

export function ensureTables(db: any): void {
  if (!Array.isArray(db.conversationActionTasks)) db.conversationActionTasks = [];
  if (!Array.isArray(db.conversationActionReceipts)) db.conversationActionReceipts = [];
}
