import type { ToolPolicy } from '../personality/types';
import type { ToolExecutionRecord } from '../tools/types';
import { buildActionContract, hasCoreActionEvidence } from './action_contract';

export type ConversationTaskStatus =
  | 'planning'
  | 'executing'
  | 'waiting_confirmation'
  | 'blocked'
  | 'completed'
  | 'cancelled';

export interface ConversationTaskPolicySnapshot {
  allowedTools: string[];
  requireConfirmation: string[];
  forbiddenTools: string[];
  maxIterations: number;
}

export interface ConversationTaskReceipt {
  id: string;
  key: string;
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  /** Exact machine receipt used by capability verification, bounded for persistence. */
  receipt?: unknown;
  error: string;
  /** Handler success and task-level verification are deliberately separate. */
  outcome: 'success' | 'partial' | 'failure';
  terminalVerification?: ToolExecutionRecord['terminalVerification'];
  capability?: ToolExecutionRecord['capability'];
  recordedAt: string;
}

const TERMINAL_FAILURE_STATUSES = new Set([
  'blocked',
  'cancelled',
  'canceled',
  'denied',
  'error',
  'failed',
  'forbidden',
  'incomplete',
  'needs_confirmation',
  'not_found',
  'not_ready',
  'partial',
  'pending',
  'queued',
  'requires_confirmation',
  'requires_setup',
  'submitted_unverified',
  'timed_out',
  'timeout',
  'unverified',
  'uncertain',
  'not_verified',
]);

const SEMANTIC_FALSE_FIELDS = [
  'sent',
  'opened',
  'saved',
  'written',
  'created',
  'generated',
  'submitted',
  'targetMatched',
  'resultVerified',
  'geometryReady',
  'geometryVerified',
  'executableGeometryAvailable',
] as const;

function compact(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function stableValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 40).map(item => stableValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .slice(0, 60)
      .map(key => [key, stableValue((value as Record<string, unknown>)[key], depth + 1)]),
  );
}

const CAPABILITY_LANES = new Set([
  'client', 'files', 'desktop', 'web', 'cad', 'messaging', 'office',
  'media', 'knowledge', 'memory', 'agents', 'system', 'industry', 'general',
]);
const CAPABILITY_OPERATIONS = new Set(['observe', 'test', 'mutate', 'create', 'communicate', 'unknown']);
const CAPABILITY_RISKS = new Set(['none', 'low', 'medium', 'high', 'critical']);
const CAPABILITY_STRATEGIES = new Set([
  'terminal_receipt', 'state_diff', 'artifact', 'provider_ack', 'visual',
  'measured', 'none',
]);
const CAPABILITY_SIDE_EFFECTS = new Set([
  'local_read', 'local_write', 'local_state_change', 'desktop_control',
  'network_read', 'external_state_change', 'external_communication',
  'credential_access', 'process_execution', 'installation', 'none',
]);

function cloneCapability(
  value: unknown,
): ToolExecutionRecord['capability'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, any>;
  const capabilityId = compact(candidate.capabilityId, 240);
  const lane = compact(candidate.lane, 40);
  const operation = compact(candidate.operation, 40);
  const risk = compact(candidate.risk, 40);
  const verification = candidate.verification;
  const strategy = compact(verification?.strategy, 60);
  if (
    !capabilityId
    || !CAPABILITY_LANES.has(lane)
    || !CAPABILITY_OPERATIONS.has(operation)
    || !CAPABILITY_RISKS.has(risk)
    || !verification
    || typeof verification !== 'object'
    || !CAPABILITY_STRATEGIES.has(strategy)
  ) return undefined;

  const sideEffects = (Array.isArray(candidate.sideEffects) ? candidate.sideEffects : [])
    .map((effect: any) => {
      const type = compact(effect?.type, 60);
      if (!CAPABILITY_SIDE_EFFECTS.has(type)) return null;
      return {
        type,
        scope: compact(effect?.scope, 300),
        reversible: effect?.reversible === true,
      };
    })
    .filter(Boolean)
    .slice(0, 30);
  const strings = (input: unknown, limit = 80) => Array.from(new Set(
    (Array.isArray(input) ? input : []).map(item => compact(item, 300)).filter(Boolean),
  )).slice(0, limit);
  const optionalStrings = (input: unknown) => {
    const values = strings(input);
    return values.length > 0 ? values : undefined;
  };

  return {
    capabilityId,
    lane: lane as NonNullable<ToolExecutionRecord['capability']>['lane'],
    operation: operation as NonNullable<ToolExecutionRecord['capability']>['operation'],
    risk: risk as NonNullable<ToolExecutionRecord['capability']>['risk'],
    sideEffects: sideEffects as NonNullable<ToolExecutionRecord['capability']>['sideEffects'],
    verification: {
      strategy: strategy as NonNullable<ToolExecutionRecord['capability']>['verification']['strategy'],
      required: verification.required === true,
      requiredFields: strings(verification.requiredFields),
      ...(verification.requiredValues && typeof verification.requiredValues === 'object'
        ? { requiredValues: stableValue(verification.requiredValues) as Record<string, unknown> }
        : {}),
      ...(optionalStrings(verification.successStatuses)
        ? { successStatuses: optionalStrings(verification.successStatuses) }
        : {}),
      ...(optionalStrings(verification.failureStatuses)
        ? { failureStatuses: optionalStrings(verification.failureStatuses) }
        : {}),
      ...(optionalStrings(verification.requiredArtifacts)
        ? { requiredArtifacts: optionalStrings(verification.requiredArtifacts) }
        : {}),
      ...(optionalStrings(verification.requiredArtifactCollections)
        ? { requiredArtifactCollections: optionalStrings(verification.requiredArtifactCollections) }
        : {}),
      successSignals: strings(verification.successSignals),
      limitations: strings(verification.limitations),
    },
  };
}

function cloneTerminalVerification(
  value: unknown,
): ToolExecutionRecord['terminalVerification'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, any>;
  const status = compact(candidate.status, 40);
  const strategy = compact(candidate.strategy, 60);
  if (!['verified', 'unverified', 'failed'].includes(status) || !CAPABILITY_STRATEGIES.has(strategy)) {
    return undefined;
  }
  return {
    status: status as NonNullable<ToolExecutionRecord['terminalVerification']>['status'],
    strategy: strategy as NonNullable<ToolExecutionRecord['terminalVerification']>['strategy'],
    reason: compact(candidate.reason, 1000),
  };
}

export function normalizeConversationTaskReceipt(value: unknown): ConversationTaskReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, any>;
  const name = compact(candidate.name, 160);
  const key = compact(candidate.key, 1000);
  if (!name || !key) return null;
  return {
    id: compact(candidate.id, 180) || key,
    key,
    name,
    arguments: candidate.arguments && typeof candidate.arguments === 'object' && !Array.isArray(candidate.arguments)
      ? stableValue(candidate.arguments) as Record<string, unknown>
      : {},
    result: compact(candidate.result, 3000),
    ...(candidate.receipt !== undefined ? { receipt: stableValue(candidate.receipt) } : {}),
    error: compact(candidate.error, 700),
    outcome: candidate.outcome === 'success'
      ? 'success'
      : candidate.outcome === 'partial'
      ? 'partial'
      : 'failure',
    terminalVerification: cloneTerminalVerification(candidate.terminalVerification),
    capability: cloneCapability(candidate.capability),
    recordedAt: compact(candidate.recordedAt, 80) || new Date(0).toISOString(),
  };
}

function parseResult(value: unknown): Record<string, any> | null {
  let parsed = value;
  for (let depth = 0; depth < 3 && typeof parsed === 'string' && parsed.trim(); depth += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, any>
    : null;
}

export function toolRecordSucceeded(record: ToolExecutionRecord): boolean {
  if (!record?.name || compact(record.error, 600)) return false;
  if (record.terminalVerification?.status === 'failed') return false;
  const result = compact(record.result, 4000);
  if (!result) return false;
  const payload = parseResult(record.result);
  if (payload) {
    const verification = payload.verification && typeof payload.verification === 'object'
      ? payload.verification as Record<string, any>
      : {};
    const status = compact(
      payload.status
        || payload.verificationStatus
        || verification.status,
      80,
    ).toLowerCase();
    const explicitlyFailedOutcome = SEMANTIC_FALSE_FIELDS.some(field => payload[field] === false);
    if (
      payload.ok === false
      || payload.success === false
      || payload.failed === true
      || payload.completed === false
      || payload.verified === false
      || explicitlyFailedOutcome
      || payload.completionMarkerExists === false
      || payload.requiresConfirmation === true
      || payload.confirmationRequired === true
      || TERMINAL_FAILURE_STATUSES.has(status)
      || compact(payload.error || verification.error, 400)
    ) return false;
  }
  return !/(?:requires? (?:user )?confirmation|permission denied|not allowed|forbidden|timed out|(?:^|\b)(?:failed|error|blocked)(?:\b|:))/i.test(result);
}

export function toolRecordVerifiedForCompletion(record: ToolExecutionRecord): boolean {
  if (!toolRecordSucceeded(record)) return false;
  if (!record.capability?.verification.required) return true;
  return record.terminalVerification?.status === 'verified';
}

export function toolRecordKey(record: Pick<ToolExecutionRecord, 'name' | 'arguments'>): string {
  let args = '';
  try {
    args = JSON.stringify(stableValue(record.arguments || {}));
  } catch {
    args = compact(record.arguments, 800);
  }
  return `${compact(record.name, 160)}:${args}`;
}

/**
 * A retry is one logical step. Once the same tool with the same arguments
 * succeeds, an earlier precondition/transport failure must not poison the
 * final result. The latest outcome remains authoritative when every attempt
 * failed.
 */
export function coalesceToolExecutionRecords(
  records: ToolExecutionRecord[] = [],
): ToolExecutionRecord[] {
  const output: ToolExecutionRecord[] = [];
  const latestIndexByKey = new Map<string, number>();
  for (const record of records) {
    if (!record?.name) continue;
    const key = toolRecordKey(record);
    const previousIndex = latestIndexByKey.get(key);
    if (previousIndex === undefined) {
      latestIndexByKey.set(key, output.length);
      output.push(record);
      continue;
    }
    const previous = output[previousIndex];
    const previousSucceeded = toolRecordSucceeded(previous);
    const currentSucceeded = toolRecordSucceeded(record);
    if (!previousSucceeded) {
      // A later retry is authoritative over an earlier failure, including a
      // more informative later failure.
      output[previousIndex] = record;
      continue;
    }
    if (currentSucceeded) {
      // Repeated successful observations/actions may be pre/post evidence for
      // one UI step. Preserve their sequence instead of collapsing them.
      latestIndexByKey.set(key, output.length);
      output.push(record);
    }
  }
  return output;
}

export function toolRecordFailureDetail(record: ToolExecutionRecord): string {
  const explicit = compact(record.error, 700);
  if (explicit) return explicit;
  const payload = parseResult(record.result);
  const verification = payload?.verification && typeof payload.verification === 'object'
    ? payload.verification as Record<string, any>
    : {};
  return compact(
    payload?.error
      || payload?.parseError
      || payload?.reason
      || payload?.blocker
      || payload?.verificationReason
      || verification.error
      || verification.reason
      || payload?.status
      || record.result,
    700,
  );
}

export function snapshotTaskPolicy(policy?: ToolPolicy | null): ConversationTaskPolicySnapshot | undefined {
  if (!policy) return undefined;
  const allowedTools = Array.from(new Set(policy.allowedTools || [])).filter(Boolean).slice(0, 160);
  if (allowedTools.length === 0) return undefined;
  return {
    allowedTools,
    requireConfirmation: Array.from(new Set(policy.requireConfirmation || [])).filter(Boolean).slice(0, 160),
    forbiddenTools: Array.from(new Set(policy.forbiddenTools || [])).filter(Boolean).slice(0, 160),
    maxIterations: Math.max(1, Math.min(Number(policy.maxIterations) || 5, 40)),
  };
}

/**
 * Keep the task's original capability envelope while honoring newer denies.
 * An explicit continuation may add capabilities required by the user's new
 * instruction; terse confirmations can therefore never shrink the task, and
 * genuine corrections/extensions can grow it deliberately.
 */
export function applyTaskPolicySnapshot(
  current: ToolPolicy,
  snapshot?: ConversationTaskPolicySnapshot | null,
): ToolPolicy {
  if (!snapshot?.allowedTools?.length) return current;
  const forbiddenTools = Array.from(new Set([
    ...(snapshot.forbiddenTools || []),
    ...(current.forbiddenTools || []),
  ])).filter(Boolean);
  const forbidden = new Set(forbiddenTools);
  const allowedTools = Array.from(new Set([
    ...snapshot.allowedTools,
    ...(current.allowedTools || []),
  ])).filter(name => !forbidden.has('*') && !forbidden.has(name));
  return {
    ...current,
    allowedTools,
    requireConfirmation: Array.from(new Set([
      ...(snapshot.requireConfirmation || []),
      ...(current.requireConfirmation || []),
    ])).filter(name => allowedTools.includes('*') || allowedTools.includes(name)),
    forbiddenTools,
    maxIterations: Math.max(1, Math.min(
      Math.max(snapshot.maxIterations || 0, current.maxIterations || 0, 5),
      40,
    )),
  };
}

export function recordsToTaskReceipts(
  records: ToolExecutionRecord[] = [],
  recordedAt = new Date().toISOString(),
): ConversationTaskReceipt[] {
  return coalesceToolExecutionRecords(records).map((record, index) => ({
    id: compact(record.id, 180) || `receipt_${Date.now()}_${index}`,
    key: toolRecordKey(record),
    name: compact(record.name, 160),
    arguments: stableValue(record.arguments || {}) as Record<string, unknown>,
    result: compact(record.result, 3000),
    ...(record.receipt !== undefined ? { receipt: stableValue(record.receipt) } : {}),
    error: toolRecordSucceeded(record) ? '' : toolRecordFailureDetail(record),
    outcome: !toolRecordSucceeded(record)
      ? 'failure'
      : record.capability?.verification.required
        && record.terminalVerification?.status !== 'verified'
      ? 'partial'
      : 'success',
    terminalVerification: cloneTerminalVerification(record.terminalVerification),
    capability: cloneCapability(record.capability),
    recordedAt,
  }));
}

export function mergeTaskReceipts(
  previous: ConversationTaskReceipt[] = [],
  records: ToolExecutionRecord[] = [],
  recordedAt = new Date().toISOString(),
): ConversationTaskReceipt[] {
  const merged = new Map<string, ConversationTaskReceipt>();
  const order: string[] = [];
  for (const receipt of [...previous, ...recordsToTaskReceipts(records, recordedAt)]) {
    if (!receipt?.key || !receipt.name) continue;
    if (!merged.has(receipt.key)) order.push(receipt.key);
    const prior = merged.get(receipt.key);
    const rank = { failure: 0, partial: 1, success: 2 } as const;
    if (!prior || rank[receipt.outcome] >= rank[prior.outcome]) merged.set(receipt.key, receipt);
  }
  return order
    .map(key => merged.get(key))
    .filter((receipt): receipt is ConversationTaskReceipt => Boolean(receipt))
    .slice(-40);
}

export function taskReceiptsToRecords(receipts: ConversationTaskReceipt[] = []): ToolExecutionRecord[] {
  return receipts.map((rawReceipt): ToolExecutionRecord | null => {
    const receipt = normalizeConversationTaskReceipt(rawReceipt);
    if (!receipt) return null;
    return {
    id: receipt.id,
    name: receipt.name,
    arguments: receipt.arguments || {},
    result: receipt.result || '',
    ...(receipt.receipt !== undefined ? { receipt: stableValue(receipt.receipt) } : {}),
    error: receipt.outcome === 'failure' ? receipt.error || 'Tool execution failed.' : undefined,
    terminalVerification: cloneTerminalVerification(receipt.terminalVerification),
    capability: cloneCapability(receipt.capability),
    };
  }).filter((record): record is ToolExecutionRecord => Boolean(record));
}

export function taskCompletionFromReceipts(
  goal: string,
  receipts: ConversationTaskReceipt[] = [],
): { complete: boolean; blocker: string; records: ToolExecutionRecord[] } {
  const records = coalesceToolExecutionRecords(taskReceiptsToRecords(receipts));
  const contract = buildActionContract(goal);
  // Legacy desktop builds emitted this terminal adapter name before the
  // verified `wps_create_document_with_text` receipt was introduced. Keep
  // already-persisted tasks resumable without weakening generic UI evidence.
  const legacyVerifiedWpsCreate = records.some(record => (
    record.name === 'wps_create_document' && toolRecordSucceeded(record)
  ));
  const complete = contract.applies
    ? hasCoreActionEvidence(contract, records, goal) || legacyVerifiedWpsCreate
    : records.some(toolRecordVerifiedForCompletion);
  const failures = [...records].reverse().filter(record => !toolRecordSucceeded(record));
  // A later policy/routing rejection is useful diagnostic evidence, but it
  // must not replace the domain failure that actually stopped the task. Keep
  // permission drift visible only when it is the sole blocker.
  const substantiveFailure = failures.find(record => !/(?:forbidden|not\s+(?:present|included)\s+in\s+allowedTools|not\s+allowed|permission\s+denied|prohibited)/i.test(
    compact(record.error, 700),
  ));
  const latestFailure = substantiveFailure || failures[0];
  const latestUnverified = [...records].reverse().find(record => (
    toolRecordSucceeded(record)
    && record.capability?.verification.required
    && record.terminalVerification?.status !== 'verified'
  ));
  return {
    complete,
    blocker: complete
      ? ''
      : compact(
          latestFailure?.error
            || latestUnverified?.terminalVerification?.reason
            || 'The task has no verified completion receipt.',
          500,
        ),
    records,
  };
}

/**
 * A confirmed action may be only one boundary inside a larger task. Continue
 * automatically when the exact confirmed receipt succeeded but the original
 * action contract is still incomplete.
 */
export function confirmedStepNeedsContinuation(
  goal: string,
  records: ToolExecutionRecord[] = [],
): boolean {
  if (records.length === 0 || !toolRecordSucceeded(records[records.length - 1])) return false;
  return !taskCompletionFromReceipts(goal, recordsToTaskReceipts(records)).complete;
}

export function buildConfirmedStepContinuationNote(
  record: ToolExecutionRecord,
): string {
  return [
    'The user-confirmed step below already executed successfully in this turn.',
    `Tool: ${compact(record.name, 160)}`,
    `Arguments: ${compact(JSON.stringify(record.arguments || {}), 1200)}`,
    `Result: ${compact(record.result, 1600)}`,
    'Do not repeat this step. Continue the original task until its acceptance criteria are complete, a real blocker is proven, or another confirmation boundary is reached.',
  ].join('\n');
}
