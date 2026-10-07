import { sanitizeToolRecordsForPersistence } from '../cognition/user_output_protection';

export const SYSTEM_FLAGS_SETTING = '__lumi_system_flags';

export const SYSTEM_SNAPSHOTS_SETTING = '__lumi_system_snapshots';

// One-version compatibility snapshot. Legacy continuation data can be read and
// migrated, but new task state is persisted only in conversation_action_*.
// Keeping the original value outside the mutable conversation projection stops
// normal database flushes from writing new state back into the legacy column.
export const legacyActionContinuationStates = new WeakMap<object, Record<string, any> | undefined>();

export interface LegacySummaryPersistenceRepair {
  id: string;
  summary: string;
  summaryChain: string[];
  lastSummaryMessageCount: number;
}

export type LegacySummaryRepairWriter = (
  repair: LegacySummaryPersistenceRepair,
  complete: (error?: Error | null) => void,
) => void;

function parseScheduledDeliveryMetadata(value: unknown): Record<string, unknown> | undefined {
  let parsed = value;
  try { if (typeof parsed === 'string') parsed = JSON.parse(parsed); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const metadata = parsed as Record<string, any>;
  const safeId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 512;
  if (!safeId(metadata.executionId) || !safeId(metadata.scheduledTaskId)) return undefined;
  const result: Record<string, unknown> = { executionId: metadata.executionId, scheduledTaskId: metadata.scheduledTaskId };
  if (metadata.reminderIds !== undefined) {
    if (!Array.isArray(metadata.reminderIds) || !metadata.reminderIds.length || metadata.reminderIds.length > 10
      || !metadata.reminderIds.every(safeId) || new Set(metadata.reminderIds).size !== metadata.reminderIds.length) return undefined;
    result.reminderIds = metadata.reminderIds;
  }
  if (metadata.proactiveVoiceDispatch !== undefined) {
    const dispatch = metadata.proactiveVoiceDispatch;
    if (!dispatch || !safeId(dispatch.reservation) || typeof dispatch.reservedAt !== 'string'
      || !Number.isFinite(Date.parse(dispatch.reservedAt))) return undefined;
    result.proactiveVoiceDispatch = { reservation: dispatch.reservation, reservedAt: dispatch.reservedAt };
  }
  return result;
}

export function parseStoredToolCalls(value: unknown, mode?: string): any[] | string | undefined {
  if (mode === 'proactive') {
    const metadata = parseScheduledDeliveryMetadata(value);
    if (metadata) return JSON.stringify(metadata);
  }
  let current = value;
  for (let depth = 0; depth < 2 && typeof current === 'string' && current.trim(); depth += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      return undefined;
    }
  }
  return Array.isArray(current) ? current : undefined;
}

export function serializeStoredToolCalls(value: unknown, mode?: string): string {
  if (mode === 'proactive') {
    const metadata = parseScheduledDeliveryMetadata(value);
    if (metadata) return JSON.stringify(metadata);
  }
  const records = sanitizeToolRecordsForPersistence(value);
  return records?.length ? JSON.stringify(records) : '';
}

function compactStoredContinuationValue(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * Persist the conversation-scoped task ledger. V2 deliberately includes the
 * pre-tool planning/confirmation state so a restart cannot erase the task or
 * turn the user's later “确认/继续” into an unrelated chat message.
 */
export function parseStoredActionContinuationState(value: unknown): Record<string, any> | undefined {
  let parsed = value;
  if (typeof parsed === 'string') {
    if (!parsed.trim()) return undefined;
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const raw = parsed as Record<string, any>;
  const goal = compactStoredContinuationValue(raw.goal, 700);
  const evidenceTools = Array.from(new Set(
    (Array.isArray(raw.evidenceTools) ? raw.evidenceTools : [])
      .map((name: unknown) => compactStoredContinuationValue(name, 120))
      .filter(Boolean),
  )).slice(-10);
  const version = Number(raw.version);
  if ((version !== 1 && version !== 2) || !goal) return undefined;
  // Legacy v1 pointers were evidence-only. V2 also persists planning and
  // confirmation state before the first tool runs, so an empty evidence list
  // is valid and necessary for cross-turn task continuity.
  if (version === 1 && evidenceTools.length === 0) return undefined;

  const sourcePaths = Array.from(new Set(
    (Array.isArray(raw.sourcePaths) ? raw.sourcePaths : [])
      .map((item: unknown) => compactStoredContinuationValue(item, 500))
      .filter(Boolean),
  )).slice(0, 8);
  const toolSummaries = Array.from(new Set(
    (Array.isArray(raw.toolSummaries) ? raw.toolSummaries : [])
      .map((item: unknown) => compactStoredContinuationValue(item, 700))
      .filter(Boolean),
  )).slice(-10);

  const policy = raw.policySnapshot && typeof raw.policySnapshot === 'object'
    ? raw.policySnapshot as Record<string, any>
    : null;
  const policySnapshot = policy
    ? {
        allowedTools: Array.from(new Set(
          (Array.isArray(policy.allowedTools) ? policy.allowedTools : [])
            .map((item: unknown) => compactStoredContinuationValue(item, 160))
            .filter(Boolean),
        )).slice(0, 160),
        requireConfirmation: Array.from(new Set(
          (Array.isArray(policy.requireConfirmation) ? policy.requireConfirmation : [])
            .map((item: unknown) => compactStoredContinuationValue(item, 160))
            .filter(Boolean),
        )).slice(0, 160),
        forbiddenTools: Array.from(new Set(
          (Array.isArray(policy.forbiddenTools) ? policy.forbiddenTools : [])
            .map((item: unknown) => compactStoredContinuationValue(item, 160))
            .filter(Boolean),
        )).slice(0, 160),
        maxIterations: Math.max(1, Math.min(Number(policy.maxIterations) || 5, 40)),
      }
    : undefined;
  const receipts = (Array.isArray(raw.receipts) ? raw.receipts : [])
    .map((receipt: any) => {
      const name = compactStoredContinuationValue(receipt?.name, 160);
      const key = compactStoredContinuationValue(receipt?.key, 1000);
      if (!name || !key) return null;
      return {
        id: compactStoredContinuationValue(receipt?.id, 180) || key,
        key,
        name,
        arguments: receipt?.arguments && typeof receipt.arguments === 'object' && !Array.isArray(receipt.arguments)
          ? receipt.arguments
          : {},
        result: compactStoredContinuationValue(receipt?.result, 3000),
        error: compactStoredContinuationValue(receipt?.error, 700),
        outcome: receipt?.outcome === 'success' ? 'success' : 'failure',
        recordedAt: compactStoredContinuationValue(receipt?.recordedAt, 80) || new Date(0).toISOString(),
      };
    })
    .filter(Boolean)
    .slice(-40);
  const status = ['planning', 'executing', 'waiting_confirmation', 'blocked', 'completed', 'cancelled']
    .includes(compactStoredContinuationValue(raw.status, 40))
    ? compactStoredContinuationValue(raw.status, 40)
    : Boolean(raw.unfinished) ? 'blocked' : 'completed';

  return {
    version,
    ...(version === 2 ? {
      taskId: compactStoredContinuationValue(raw.taskId, 180) || undefined,
      status,
      policySnapshot,
      receipts,
      activeRequestId: compactStoredContinuationValue(raw.activeRequestId, 180) || undefined,
      supersededTaskId: compactStoredContinuationValue(raw.supersededTaskId, 180) || undefined,
      revision: Math.max(0, Math.trunc(Number(raw.revision) || 0)),
    } : {}),
    goal,
    latestInstruction: compactStoredContinuationValue(raw.latestInstruction || goal, 700),
    ...(compactStoredContinuationValue(raw.latestInstructionRef, 180)
      ? { latestInstructionRef: compactStoredContinuationValue(raw.latestInstructionRef, 180) }
      : {}),
    appTarget: compactStoredContinuationValue(raw.appTarget, 160),
    sourcePaths,
    latestBlocker: compactStoredContinuationValue(raw.latestBlocker, 380),
    unfinished: Boolean(raw.unfinished),
    evidenceTools,
    assistantState: compactStoredContinuationValue(raw.assistantState, 700),
    toolSummaries,
    updatedAt: compactStoredContinuationValue(raw.updatedAt, 80) || new Date(0).toISOString(),
    ...(compactStoredContinuationValue(raw.evidenceMessageId, 160)
      ? { evidenceMessageId: compactStoredContinuationValue(raw.evidenceMessageId, 160) }
      : {}),
  };
}

export function serializeStoredActionContinuationState(value: unknown): string {
  const state = parseStoredActionContinuationState(value);
  return state ? JSON.stringify(state) : '{}';
}

export function parseJsonSetting<T>(settings: any[], key: string, fallback: T): T {
  const row = settings.find((s: any) => s.key === key);
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}
