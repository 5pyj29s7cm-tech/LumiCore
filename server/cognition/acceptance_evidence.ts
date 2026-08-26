import crypto from 'node:crypto';
import {
  hasVerifiedModelGraphNodeEvidence,
  type ModelGraphArbitrationReceipt,
  type ModelGraphNodeReceipt,
} from '../agents/model_execution_graph';
import { getJwtSecret } from '../config/local_identity';
import type { CapabilityManifestEntry, ToolExecutionRecord } from '../tools/types';
import {
  inspectPersistedToolExecutionReceipt,
  type PersistedToolExecutionReceiptExpectation,
} from '../tools/persisted_execution_receipt';

export type AcceptanceStage = 'registered' | 'available' | 'exercised' | 'verified';
export type RuntimeSampleStatus = 'not_exercised' | 'unknown' | 'degraded' | 'verified';
export type TaskRuntimeKind = 'background' | 'autonomous' | 'conversation' | 'scheduler';
export type TaskTerminalOutcome = 'completed' | 'failed' | 'blocked' | 'cancelled';

export interface TaskTerminalReceipt {
  schemaVersion: 2;
  receiptId: string;
  taskId: string;
  runtime: TaskRuntimeKind;
  outcome: TaskTerminalOutcome;
  verification: 'verified' | 'unverified' | 'failed';
  evidenceKind: 'tool' | 'model_graph' | 'mixed' | 'none';
  evidenceRefs: string[];
  toolNames: string[];
  workerIds: string[];
  reasonCode: string;
  reason: string;
  createdAt: string;
  /** Installation-bound integrity proof over every other enumerable field. */
  signature: string;
}

export interface CapabilityAcceptanceProjection {
  toolName: string;
  capabilityId: string;
  source: string;
  provider: string;
  stage: AcceptanceStage;
  registered: true;
  availability: 'available' | 'unavailable' | 'unknown';
  availabilityBasis: string;
  exercised: boolean;
  verified: boolean;
  exerciseCount: number;
  verifiedCount: number;
  latestOutcome: string;
  diagnosticCode: string;
}

export interface TaskAcceptanceProjection {
  taskId: string;
  runtime: TaskRuntimeKind;
  status: string;
  accepted: boolean;
  terminalReceiptPresent: boolean;
  terminalVerification: 'verified' | 'unverified' | 'failed' | 'missing';
  diagnosticCode: string;
  diagnosticReason: string;
  updatedAt: string;
  continuity: {
    goalPreserved: boolean;
    planPreserved: boolean;
    receiptLedgerPreserved: boolean;
    blockerPreserved: boolean;
  };
  completionFeedback: TaskCompletionFeedback;
}

export interface TaskCompletionFeedback {
  status: 'completed' | 'blocked' | 'failed' | 'cancelled' | 'working' | 'unknown';
  completed: string[];
  evidence: string[];
  incomplete: string[];
  blockers: string[];
  nextSteps: string[];
}

export interface AcceptanceEvidenceSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  summary: {
    capabilities: {
      registered: number;
      available: number;
      unavailable: number;
      availabilityUnknown: number;
      exercised: number;
      verified: number;
    };
    tasks: {
      total: number;
      completed: number;
      accepted: number;
      completedWithoutTerminalReceipt: number;
      blockedOrFailed: number;
    };
    modelGraph: RuntimeSampleStatus;
    knowledgeQuality: RuntimeSampleStatus;
  };
  capabilities: CapabilityAcceptanceProjection[];
  tasks: TaskAcceptanceProjection[];
  subsystems: {
    modelGraph: {
      status: RuntimeSampleStatus;
      sampleScope: 'current_process';
      compilations: number;
      invalidGraphs: number;
      arbitrations: number;
      verifiedArbitrations: number;
      blockedArbitrations: number;
      diagnosticCode: string;
    };
    knowledgeQuality: {
      status: RuntimeSampleStatus;
      sampleScope: 'current_process';
      evaluations: number;
      verifiedEvaluations: number;
      unverifiedEvaluations: number;
      recallAt5: { status: 'measured' | 'unknown'; value: number | null; sampleSize: number };
      citationAccuracy: { status: 'measured' | 'unknown'; value: number | null; sampleSize: number };
      diagnosticCode: string;
    };
  };
  policy: {
    completionRequiresTerminalReceipt: true;
    verifiedRequiresMachineEvidence: true;
    zeroSamplesAreUnknown: true;
    rawPayloadsExcluded: true;
  };
}

const AVAILABLE_RUNTIME_STATUSES = new Set(['connected', 'idle', 'online', 'ready', 'running']);
const UNAVAILABLE_RUNTIME_STATUSES = new Set(['backoff', 'crashed', 'disconnected', 'error', 'failed', 'stopped', 'unavailable']);
const SECRET_VALUE_RE = /(?:bearer\s+[a-z0-9._~+/=-]{8,}|\bsk-[a-z0-9_-]{8,}\b)/gi;
const SECRET_FIELD_RE = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)\s*[:=]\s*[^\s,;]+/gi;
const TASK_TERMINAL_RECEIPT_KEYS = [
  'createdAt',
  'evidenceKind',
  'evidenceRefs',
  'outcome',
  'reason',
  'reasonCode',
  'receiptId',
  'runtime',
  'schemaVersion',
  'signature',
  'taskId',
  'toolNames',
  'verification',
  'workerIds',
] as const;

function compact(value: unknown, limit = 700): string {
  return String(value || '')
    .replace(SECRET_FIELD_RE, match => `${match.split(/[:=]/, 1)[0]}=[redacted]`)
    .replace(SECRET_VALUE_RE, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [
    key,
    stableValue((value as Record<string, unknown>)[key]),
  ]));
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function terminalReceiptSignature(value: Record<string, unknown>): string {
  return crypto.createHmac('sha256', getJwtSecret())
    .update('lumi:task-terminal-receipt:v2\0')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function hasValidTerminalReceiptSignature(receipt: unknown): receipt is TaskTerminalReceipt {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  try {
    const candidate = receipt as Record<string, unknown>;
    const keys = Object.keys(candidate).sort();
    if (
      keys.length !== TASK_TERMINAL_RECEIPT_KEYS.length
      || keys.some((key, index) => key !== TASK_TERMINAL_RECEIPT_KEYS[index])
    ) return false;
    if (candidate.schemaVersion !== 2 || !/^[a-f0-9]{64}$/.test(String(candidate.signature || ''))) {
      return false;
    }
    const { signature, ...unsigned } = candidate;
    const actual = Buffer.from(String(signature), 'hex');
    const expected = Buffer.from(terminalReceiptSignature(unsigned), 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function boundedUnique(values: unknown[], limit = 80): string[] {
  return Array.from(new Set(values.map(value => compact(value, 240)).filter(Boolean))).slice(0, limit);
}

function verifiedToolRecord(record: ToolExecutionRecord): boolean {
  return !record.error
    && Boolean(String(record.result || '').trim())
    && record.terminalVerification?.status === 'verified';
}

function toolEvidenceRef(record: ToolExecutionRecord): string | null {
  const id = compact(record.id, 180);
  if (!id) return null;
  return /^[A-Za-z0-9._:-]+$/.test(id)
    ? `tool:${id}`
    : `tool:sha256-${digest(id).slice(0, 32)}`;
}

function verifiedModelGraphEvidence(input: {
  taskId: string;
  arbitrationReceipt?: ModelGraphArbitrationReceipt;
  nodeReceipts?: ModelGraphNodeReceipt[];
}): { verified: boolean; evidenceRefs: string[]; workerIds: string[]; reason: string } {
  const arbitration = input.arbitrationReceipt;
  if (
    !arbitration
    || arbitration.taskId !== input.taskId
    || arbitration.status !== 'succeeded'
    || arbitration.verification !== 'verified'
    || !Array.isArray(arbitration.selectedNodeIds)
    || !Array.isArray(arbitration.verifiedNodeIds)
    || arbitration.selectedNodeIds.length === 0
    || arbitration.selectedNodeIds.some(nodeId => !arbitration.verifiedNodeIds.includes(nodeId))
  ) {
    return {
      verified: false,
      evidenceRefs: [],
      workerIds: [],
      reason: compact(arbitration?.reason || 'No successful model-graph arbitration receipt was recorded.'),
    };
  }
  const nodes = input.nodeReceipts || [];
  const verifiedNodes = arbitration.verifiedNodeIds.map(nodeId => nodes.find(receipt => (
    receipt.graphId === arbitration.graphId
    && receipt.taskId === arbitration.taskId
    && receipt.nodeId === nodeId
  )));
  if (verifiedNodes.some(receipt => !hasVerifiedModelGraphNodeEvidence(receipt))) {
    return {
      verified: false,
      evidenceRefs: [],
      workerIds: [],
      reason: 'Model-graph arbitration selected a node without a matching verified terminal receipt.',
    };
  }
  return {
    verified: true,
    evidenceRefs: [
      `model-graph:${arbitration.graphId}:arbitration`,
      ...verifiedNodes.map(receipt => `model-graph:${receipt!.graphId}:${receipt!.nodeId}`),
    ],
    workerIds: boundedUnique(verifiedNodes.map(receipt => receipt?.agentId || receipt?.selectedCandidate?.agentId || '')),
    reason: 'Successful arbitration selected only model nodes with verified terminal receipts.',
  };
}

export function buildTaskTerminalReceipt(input: {
  taskId: string;
  runtime: TaskRuntimeKind;
  outcome: TaskTerminalOutcome;
  toolRecords?: ToolExecutionRecord[];
  nodeReceipts?: ModelGraphNodeReceipt[];
  arbitrationReceipt?: ModelGraphArbitrationReceipt;
  /** Existing durable receipt ids may diagnose non-completion, but never prove completion by themselves. */
  evidenceRefs?: string[];
  reasonCode?: string;
  reason?: string;
  createdAt?: string;
}): TaskTerminalReceipt {
  const taskId = compact(input.taskId, 180);
  const createdAt = input.createdAt || new Date().toISOString();
  const terminalTools = (input.toolRecords || []).filter(record => record.result !== undefined || record.error !== undefined);
  const verifiedTools = terminalTools.filter(record => verifiedToolRecord(record) && toolEvidenceRef(record));
  const toolEvidenceRefs = verifiedTools.map(record => toolEvidenceRef(record)!);
  const graphEvidence = verifiedModelGraphEvidence({
    taskId,
    arbitrationReceipt: input.arbitrationReceipt,
    nodeReceipts: input.nodeReceipts,
  });
  const graphWasAttempted = Boolean(input.arbitrationReceipt || input.nodeReceipts?.length);
  // An orchestration graph is one completion unit. A single verified tool from
  // one node cannot conceal an unverified reasoning/external node selected by
  // that graph. Standalone tasks without a graph may still close on tool proof.
  const acceptedStandaloneToolEvidence = !graphWasAttempted && toolEvidenceRefs.length > 0;
  const verified = input.outcome === 'completed'
    && (acceptedStandaloneToolEvidence || graphEvidence.verified);
  const evidenceRefs = input.outcome === 'completed'
    ? verified
      ? boundedUnique([
          ...(graphEvidence.verified ? toolEvidenceRefs : []),
          ...(acceptedStandaloneToolEvidence ? toolEvidenceRefs : []),
          ...graphEvidence.evidenceRefs,
        ])
      : []
    : boundedUnique([
        ...(input.evidenceRefs || []),
        ...terminalTools.map((record, index) => (
          `tool:${compact(record.id, 180) || digest({ taskId, name: record.name, index }).slice(0, 24)}`
        )),
      ]);
  const evidenceKind: TaskTerminalReceipt['evidenceKind'] = toolEvidenceRefs.length > 0 && graphEvidence.verified
    ? 'mixed'
    : acceptedStandaloneToolEvidence
      ? 'tool'
      : graphEvidence.verified
        ? 'model_graph'
        : 'none';
  const reasonCode = compact(input.reasonCode, 100) || (
    input.outcome !== 'completed'
      ? `task_${input.outcome}`
      : acceptedStandaloneToolEvidence
        ? 'verified_tool_terminal_receipt'
        : graphEvidence.verified
          ? 'verified_model_graph_arbitration'
          : 'missing_verified_terminal_evidence'
  );
  const reason = compact(input.reason, 700) || (
    input.outcome !== 'completed'
      ? `Task ended with status ${input.outcome}.`
      : acceptedStandaloneToolEvidence
        ? `${verifiedTools.length} tool execution(s) produced verified terminal receipts.`
        : graphEvidence.verified
          ? 'Successful arbitration selected only model nodes with verified terminal receipts.'
          : graphWasAttempted
            ? graphEvidence.reason
          : terminalTools.length > 0
            ? `${terminalTools.length} terminal tool execution(s) lacked verified terminal evidence.`
            : graphEvidence.reason
  );
  const receiptIdentity = {
    taskId,
    runtime: input.runtime,
    outcome: input.outcome,
    verification: verified ? 'verified' : input.outcome === 'cancelled' ? 'unverified' : 'failed',
    evidenceRefs,
    reasonCode,
    createdAt,
  };
  const unsignedReceipt: Omit<TaskTerminalReceipt, 'signature'> = {
    schemaVersion: 2 as const,
    receiptId: `task_receipt_${digest(receiptIdentity).slice(0, 32)}`,
    taskId,
    runtime: input.runtime,
    outcome: input.outcome,
    verification: verified ? 'verified' : input.outcome === 'cancelled' ? 'unverified' : 'failed',
    evidenceKind,
    evidenceRefs,
    toolNames: boundedUnique(terminalTools.map(record => record.name)),
    // Worker evidence is derived only from selected, verified graph-node
    // receipts. Assigned worker ids are scheduling metadata, not proof that a
    // worker actually ran or contributed to the accepted result.
    workerIds: graphEvidence.workerIds,
    reasonCode,
    reason,
    createdAt,
  };
  return {
    ...unsignedReceipt,
    signature: terminalReceiptSignature(unsignedReceipt),
  };
}

export function validateCompletionTerminalReceipt(
  receipt: TaskTerminalReceipt | null | undefined,
  expected: { taskId: string; runtime: TaskRuntimeKind },
): { accepted: boolean; diagnosticCode: string; reason: string } {
  if (!receipt) {
    return {
      accepted: false,
      diagnosticCode: 'missing_terminal_receipt',
      reason: 'Task completion requires a terminal acceptance receipt.',
    };
  }
  if (!hasValidTerminalReceiptSignature(receipt)) {
    return {
      accepted: false,
      diagnosticCode: 'terminal_receipt_integrity_invalid',
      reason: 'The terminal receipt is legacy, unsigned, or failed its integrity check.',
    };
  }
  if (
    !Array.isArray(receipt.evidenceRefs)
    || !Array.isArray(receipt.toolNames)
    || !Array.isArray(receipt.workerIds)
    || !['background', 'autonomous', 'conversation', 'scheduler'].includes(receipt.runtime)
    || !['completed', 'failed', 'blocked', 'cancelled'].includes(receipt.outcome)
    || !['verified', 'unverified', 'failed'].includes(receipt.verification)
    || !['tool', 'model_graph', 'mixed', 'none'].includes(receipt.evidenceKind)
  ) {
    return {
      accepted: false,
      diagnosticCode: 'terminal_receipt_malformed',
      reason: 'The terminal receipt has an invalid signed structure.',
    };
  }
  if (receipt.taskId !== expected.taskId || receipt.runtime !== expected.runtime) {
    return {
      accepted: false,
      diagnosticCode: 'terminal_receipt_identity_mismatch',
      reason: 'The terminal receipt does not belong to this task and runtime.',
    };
  }
  if (receipt.outcome !== 'completed' || receipt.verification !== 'verified') {
    return {
      accepted: false,
      diagnosticCode: receipt.reasonCode || 'terminal_receipt_unverified',
      reason: receipt.reason || 'The terminal receipt did not verify completion.',
    };
  }
  if (!receipt.receiptId || receipt.evidenceRefs.length === 0 || receipt.evidenceKind === 'none') {
    return {
      accepted: false,
      diagnosticCode: 'terminal_receipt_missing_evidence_reference',
      reason: 'The completion receipt contains no machine-evidence reference.',
    };
  }
  return { accepted: true, diagnosticCode: 'accepted', reason: receipt.reason };
}

function nextStepForReceipt(receipt: TaskTerminalReceipt | null | undefined): string {
  const code = String(receipt?.reasonCode || '');
  if (/confirmation/i.test(code)) return 'Obtain the required user confirmation, then resume from the preserved receipt ledger.';
  if (/policy|forbidden/i.test(code)) return 'Resolve the policy boundary or select an allowed capability before retrying.';
  if (/runtime|provider|dependency|worker|unavailable/i.test(code)) return 'Restore the unavailable runtime dependency, then resume without replaying verified side effects.';
  if (/missing.*(?:receipt|evidence)|unverified/i.test(code)) return 'Run the missing verification step and produce a terminal machine receipt.';
  if (receipt?.outcome === 'failed' || receipt?.outcome === 'blocked') return 'Inspect the preserved blocker and retry only the unverified portion of the plan.';
  return '';
}

export function buildTaskCompletionFeedback(
  receipt: TaskTerminalReceipt | null | undefined,
  taskLabel = 'Task',
  fallback?: { status?: string; reason?: string; accepted?: boolean },
): TaskCompletionFeedback {
  const trustedReceipt = hasValidTerminalReceiptSignature(receipt) ? receipt : undefined;
  const status = trustedReceipt?.outcome === 'completed' && trustedReceipt.verification === 'verified'
    ? 'completed'
    : fallback?.accepted === true
      ? 'completed'
    : trustedReceipt?.outcome === 'blocked'
      ? 'blocked'
      : trustedReceipt?.outcome === 'failed'
        ? 'failed'
        : trustedReceipt?.outcome === 'cancelled'
          ? 'cancelled'
          : ['queued', 'pending', 'running', 'pausing', 'paused', 'cancelling', 'executing', 'planning', 'waiting_confirmation'].includes(String(fallback?.status || ''))
            ? 'working'
            : fallback?.status === 'blocked'
              ? 'blocked'
              : fallback?.status === 'failed'
                ? 'failed'
                : fallback?.status === 'cancelled'
                  ? 'cancelled'
                  : 'unknown';
  const label = compact(taskLabel, 200) || 'Task';
  const reason = compact(trustedReceipt?.reason || fallback?.reason, 500);
  const evidence = [
    ...(trustedReceipt?.toolNames?.length
      ? [trustedReceipt.verification === 'verified'
          ? `Verified tool receipts: ${trustedReceipt.toolNames.join(', ')}`
          : `Observed terminal tool receipts: ${trustedReceipt.toolNames.join(', ')}`]
      : []),
    ...(trustedReceipt?.workerIds?.length ? [`Worker receipts: ${trustedReceipt.workerIds.length}`] : []),
    ...(trustedReceipt?.evidenceKind === 'model_graph' || trustedReceipt?.evidenceKind === 'mixed'
      ? ['Model-graph arbitration selected verified node receipts.']
      : []),
    ...(!receipt && fallback?.accepted ? ['A verified terminal action receipt was recorded.'] : []),
  ];
  const nextStep = nextStepForReceipt(trustedReceipt);
  return {
    status,
    completed: status === 'completed' ? [`${label} completed with verified terminal evidence.`] : [],
    evidence: boundedUnique(evidence, 20),
    incomplete: status === 'completed' ? [] : [`${label} is not verified complete.`],
    blockers: status === 'blocked' || status === 'failed' ? boundedUnique([reason || trustedReceipt?.reasonCode || 'Unknown blocker.'], 10) : [],
    nextSteps: nextStep ? [nextStep] : [],
  };
}

function isRegisteredBackgroundDelegation(record: ToolExecutionRecord): boolean {
  if (record.name !== 'agent_delegate_background' || record.error) return false;
  try {
    const result = JSON.parse(String(record.result || '{}'));
    return result?.ok === true && result?.status === 'registered' && Boolean(result?.task?.id);
  } catch {
    return false;
  }
}

/**
 * Build a structured foreground result without turning ordinary conversation
 * into a fake task. Only an actual tool receipt, a blocked execution, or an
 * explicit task lifecycle status produces feedback.
 */
export function buildForegroundTaskCompletionFeedback(input: {
  taskId: string;
  taskLabel: string;
  toolRecords?: ToolExecutionRecord[];
  blocked?: boolean;
  reason?: string;
  status?: 'waiting_confirmation' | 'cancelled' | 'persistence_unknown';
}): TaskCompletionFeedback | undefined {
  const records = input.toolRecords || [];
  const label = compact(input.taskLabel, 200) || 'Task';
  // Transport-owned lifecycle state outranks a registration-shaped tool
  // payload. A late/duplicated delegation receipt must not turn cancellation,
  // persistence uncertainty, or a confirmation wait back into "working".
  if (input.status === 'waiting_confirmation') {
    return {
      status: 'working',
      completed: records.length > 0 ? ['The requested action was prepared and recorded.'] : [],
      evidence: boundedUnique(records.map(record => `Observed tool receipt: ${compact(record.name, 120)}`), 20),
      incomplete: [`${label} is waiting for confirmation.`],
      blockers: [],
      nextSteps: ['Approve or reject the pending action to continue.'],
    };
  }
  if (input.status !== 'cancelled' && input.status !== 'persistence_unknown') {
    const registeredDelegation = records.find(isRegisteredBackgroundDelegation);
    if (registeredDelegation) {
      const verified = registeredDelegation.terminalVerification?.status === 'verified';
      return {
        status: 'working',
        completed: [verified
          ? 'Background delegation was registered with a verified durable task identity.'
          : 'Background delegation registration was observed but is not machine-verified.'],
        evidence: [verified
          ? 'Verified tool receipt: agent_delegate_background'
          : 'Observed unverified tool receipt: agent_delegate_background'],
        incomplete: [`${label} is still running in the background.`],
        blockers: [],
        nextSteps: ['Track the delegated task until it publishes a verified terminal receipt.'],
      };
    }
  }
  if (records.length === 0 && !input.blocked && !input.status) return undefined;
  const outcome: TaskTerminalOutcome = input.status === 'cancelled'
    ? 'cancelled'
    : input.blocked || input.status === 'persistence_unknown'
      ? 'blocked'
      : 'completed';
  const receipt = buildTaskTerminalReceipt({
    taskId: input.taskId,
    runtime: 'conversation',
    outcome,
    toolRecords: records,
    reasonCode: input.status === 'persistence_unknown'
      ? 'terminal_persistence_unknown'
      : input.status === 'cancelled'
        ? 'task_cancelled'
        : input.blocked
          ? 'foreground_execution_blocked'
          : undefined,
    reason: input.reason,
  });
  return buildTaskCompletionFeedback(receipt, label, {
    status: outcome,
    reason: input.reason,
    accepted: outcome === 'completed' && receipt.verification === 'verified',
  });
}

function receiptVerification(
  row: any,
  expected: PersistedToolExecutionReceiptExpectation = {},
): string {
  const inspection = inspectPersistedToolExecutionReceipt(row, expected);
  if (!inspection.valid) return 'unverified';
  if (inspection.explicitlyTerminalVerified) return 'verified';
  return inspection.verificationStatus === 'failed' ? 'failed' : 'unverified';
}

function capabilityAvailability(
  entry: CapabilityManifestEntry,
  mcpHealth: Record<string, any>,
): Pick<CapabilityAcceptanceProjection, 'availability' | 'availabilityBasis'> {
  if (!entry.executable) {
    return { availability: 'unavailable', availabilityBasis: entry.deprecated ? 'deprecated' : 'policy_not_executable' };
  }
  if (entry.source !== 'mcp') return { availability: 'available', availabilityBasis: 'registry_executable' };
  const provider = String(entry.provider || '').trim();
  const status = compact(mcpHealth?.[provider]?.status || '', 40).toLowerCase();
  if (AVAILABLE_RUNTIME_STATUSES.has(status)) {
    return { availability: 'available', availabilityBasis: `mcp_${status}` };
  }
  if (UNAVAILABLE_RUNTIME_STATUSES.has(status)) {
    return { availability: 'unavailable', availabilityBasis: `mcp_${status}` };
  }
  return { availability: 'unknown', availabilityBasis: 'mcp_health_unknown' };
}

export function buildCapabilityAcceptanceProjections(input: {
  manifest: CapabilityManifestEntry[];
  actionReceipts?: any[];
  toolMetrics?: Record<string, any>;
  mcpHealth?: Record<string, any>;
}): CapabilityAcceptanceProjection[] {
  const persistedByTool = new Map<string, { exercised: number; verified: number; latestOutcome: string; latestAt: string }>();
  for (const row of input.actionReceipts || []) {
    const toolName = compact(row?.toolName, 160);
    if (!toolName) continue;
    const current = persistedByTool.get(toolName) || { exercised: 0, verified: 0, latestOutcome: '', latestAt: '' };
    current.exercised += 1;
    if (row?.outcome === 'verified_success' && receiptVerification(row) === 'verified') current.verified += 1;
    const createdAt = compact(row?.createdAt, 80);
    if (createdAt >= current.latestAt) {
      current.latestAt = createdAt;
      current.latestOutcome = compact(row?.outcome, 60);
    }
    persistedByTool.set(toolName, current);
  }

  return input.manifest.map(entry => {
    const persisted = persistedByTool.get(entry.toolName) || { exercised: 0, verified: 0, latestOutcome: '', latestAt: '' };
    const metric = input.toolMetrics?.[entry.toolName] || {};
    const metricCalls = Math.max(0, Number(metric.calls) || 0);
    // Current-process metrics and persisted receipts can describe the same
    // execution. Use the larger lower bound instead of double-counting it.
    const exerciseCount = Math.max(persisted.exercised, metricCalls);
    // Process metrics record an outcome label, not the verification source.
    // Only a persisted envelope explicitly produced by a terminal verifier can
    // promote a capability to machine-verified acceptance.
    const verifiedCount = persisted.verified;
    const exercised = exerciseCount > 0;
    const verified = verifiedCount > 0;
    const availability = capabilityAvailability(entry, input.mcpHealth || {});
    const stage: AcceptanceStage = verified
      ? 'verified'
      : exercised
        ? 'exercised'
        : availability.availability === 'available'
          ? 'available'
          : 'registered';
    const diagnosticCode = verified
      ? 'verified_terminal_evidence_present'
      : exercised
        ? `exercised_without_verified_receipt${persisted.latestOutcome ? `:${persisted.latestOutcome}` : ''}`
        : availability.availability === 'available'
          ? 'available_not_exercised'
          : availability.availability === 'unavailable'
            ? availability.availabilityBasis
            : 'availability_unknown';
    return {
      toolName: entry.toolName,
      capabilityId: entry.capabilityId,
      source: entry.source,
      provider: String(entry.provider || ''),
      stage,
      registered: true as const,
      ...availability,
      exercised,
      verified,
      exerciseCount,
      verifiedCount,
      latestOutcome: persisted.latestOutcome,
      diagnosticCode,
    };
  }).sort((left, right) => left.toolName.localeCompare(right.toolName));
}

function latestDurableReason(task: any): string {
  const diagnosis = Array.isArray(task?.recovery?.diagnoses) ? task.recovery.diagnoses.at(-1) : null;
  const terminalReceipt = hasValidTerminalReceiptSignature(task?.terminalReceipt)
    ? task.terminalReceipt as TaskTerminalReceipt
    : undefined;
  return compact(
    terminalReceipt?.reason
      || diagnosis?.reason
      || task?.recovery?.blockedReason
      || task?.verificationReason
      || task?.error,
    700,
  );
}

function projectDurableTask(task: any, runtime: 'background' | 'autonomous'): TaskAcceptanceProjection {
  const status = compact(task?.status || 'unknown', 60);
  const terminalReceipt = task?.terminalReceipt as TaskTerminalReceipt | undefined;
  const terminalReceiptIntegrityValid = hasValidTerminalReceiptSignature(terminalReceipt);
  const trustedTerminalReceipt = terminalReceiptIntegrityValid ? terminalReceipt : undefined;
  const validation = status === 'completed'
    ? validateCompletionTerminalReceipt(terminalReceipt, { taskId: String(task?.id || ''), runtime })
    : null;
  const reason = latestDurableReason(task);
  const terminalVerification = terminalReceiptIntegrityValid
    ? terminalReceipt.verification
    : terminalReceipt
      ? 'failed'
      : 'missing';
  const diagnosticCode = status === 'completed'
    ? validation?.accepted
      ? 'accepted'
      : terminalReceipt
        ? validation?.diagnosticCode || 'terminal_receipt_unverified'
        : 'completed_without_terminal_receipt'
    : status === 'blocked' || status === 'failed'
      ? compact(trustedTerminalReceipt?.reasonCode || task?.recovery?.lastFailureClass || 'durable_task_failed', 100)
      : status === 'cancelled'
        ? compact(trustedTerminalReceipt?.reasonCode || 'task_cancelled', 100)
        : 'not_terminal';
  return {
    taskId: compact(task?.id, 180),
    runtime,
    status,
    accepted: validation?.accepted === true,
    terminalReceiptPresent: Boolean(terminalReceipt?.receiptId),
    terminalVerification,
    diagnosticCode,
    diagnosticReason: reason || validation?.reason || '',
    updatedAt: compact(task?.updatedAt || task?.completedAt || task?.createdAt, 80),
    continuity: {
      goalPreserved: Boolean(compact(task?.prompt || task?.description || task?.title, 20)),
      planPreserved: runtime === 'background'
        ? Boolean(task?.context?.actionTaskId || task?.checkpoint?.completedNodeIds?.length)
        : Boolean(task?.executionPlan?.planId || task?.planId),
      receiptLedgerPreserved: Boolean(
        (terminalReceiptIntegrityValid && terminalReceipt.evidenceRefs.length)
        || task?.checkpoint?.receiptIds?.length
        || task?.checkpoint?.receipts?.length,
      ),
      blockerPreserved: !['blocked', 'failed'].includes(status) || Boolean(reason),
    },
    completionFeedback: buildTaskCompletionFeedback(terminalReceipt, task?.title || 'Task', {
      status,
      reason: reason || validation?.reason,
      accepted: validation?.accepted,
    }),
  };
}

function projectConversationTask(task: any, receipts: any[]): TaskAcceptanceProjection {
  const taskReceipts = receipts.filter(row => row?.taskId === task?.id);
  const verified = taskReceipts.some(row => (
    row?.outcome === 'verified_success' && receiptVerification(row) === 'verified'
  ));
  const status = compact(task?.status || 'unknown', 60);
  const accepted = status === 'completed' && verified;
  const latest = [...taskReceipts].sort((left, right) => (
    String(right?.createdAt || '').localeCompare(String(left?.createdAt || ''))
  ))[0];
  const diagnosticCode = accepted
    ? 'accepted'
    : status === 'completed'
      ? taskReceipts.length > 0
        ? 'completed_with_unverified_terminal_receipt'
        : 'completed_without_terminal_receipt'
      : status === 'blocked'
        ? 'conversation_task_blocked'
        : 'not_terminal';
  const context = parseObject(task?.context);
  const diagnosticReason = compact(task?.blocker || (latest ? `Latest terminal outcome: ${latest.outcome || 'unknown'}.` : ''), 700);
  return {
    taskId: compact(task?.id, 180),
    runtime: 'conversation',
    status,
    accepted,
    terminalReceiptPresent: taskReceipts.length > 0,
    terminalVerification: verified ? 'verified' : latest ? receiptVerification(latest) === 'failed' ? 'failed' : 'unverified' : 'missing',
    diagnosticCode,
    diagnosticReason,
    updatedAt: compact(task?.updatedAt || task?.completedAt || task?.createdAt, 80),
    continuity: {
      goalPreserved: Boolean(compact(task?.goal, 20)),
      planPreserved: Boolean(context?.executionPlan?.planId || context?.planId),
      receiptLedgerPreserved: taskReceipts.length > 0,
      blockerPreserved: status !== 'blocked' || Boolean(compact(task?.blocker, 20)),
    },
    completionFeedback: buildTaskCompletionFeedback(undefined, task?.goal || 'Task', {
      status,
      reason: diagnosticReason,
      accepted,
    }),
  };
}

function isVerifiedCurrentSchedulerCheckpoint(
  row: any,
  task: any,
  context: Record<string, any>,
  currentExecutionId: string,
): boolean {
  const envelope = parseObject(row?.envelope);
  const result = parseObject(envelope.result);
  const plan = parseObject(context.executionPlan);
  const intent = parseObject(plan.intent);
  const nodes = Array.isArray(plan.nodes) ? plan.nodes : [];
  const expectedEvidence = Array.isArray(plan.expectedEvidence) ? plan.expectedEvidence : [];
  const target = compact(context.scheduledTaskId || task?.target, 180);
  const expectedCapabilityId = target ? `lumi.scheduler.${target}` : '';
  const adapter = nodes.find((candidate: any) => (
    compact(candidate?.toolName, 120) === 'scheduler_task_handler'
    && compact(candidate?.capabilityId, 240) === expectedCapabilityId
    && candidate?.executionRole === 'adapter'
  ));
  const evidenceContract = expectedEvidence.find((candidate: any) => (
    compact(candidate?.nodeId, 180) === compact(adapter?.nodeId, 180)
    && compact(candidate?.capabilityId, 240) === expectedCapabilityId
  ));
  const requiredFields = Array.isArray(evidenceContract?.requiredFields)
    ? evidenceContract.requiredFields.map((value: unknown) => compact(value, 120))
    : [];
  const requiredValues = parseObject(evidenceContract?.requiredValues);

  return Boolean(
    currentExecutionId
    && target
    && compact(row?.taskId, 180) === compact(task?.id, 180)
    && compact(row?.turnId, 180) === currentExecutionId
    && compact(row?.requestId, 180) === currentExecutionId
    && compact(row?.toolName, 120) === 'scheduler_task_handler'
    && row?.outcome === 'verified_success'
    && envelope.status === 'verified_success'
    && compact(envelope.toolName, 120) === 'scheduler_task_handler'
    && compact(envelope.taskId, 180) === currentExecutionId
    && compact(envelope.turnId, 180) === currentExecutionId
    && compact(envelope.requestId, 180) === currentExecutionId
    && receiptVerification(row, {
      rowTaskId: compact(task?.id, 180),
      envelopeTaskId: currentExecutionId,
      turnId: currentExecutionId,
      requestId: currentExecutionId,
      toolName: 'scheduler_task_handler',
      outcome: 'verified_success',
    }) === 'verified'
    && compact(plan.taskId, 180) === currentExecutionId
    && intent.kind === 'scheduled_task'
    && compact(intent.target, 180) === target
    && compact(task?.target, 180) === target
    && compact(context.scheduledTaskId, 180) === target
    && compact(task?.conversationId, 240) === `scheduler:${target}`
    && adapter
    && adapter.verificationStrategy === 'terminal_receipt'
    && evidenceContract?.required === true
    && evidenceContract.strategy === 'terminal_receipt'
    && ['status', 'verified', 'scheduledTaskId'].every(field => requiredFields.includes(field))
    && requiredValues.status === 'verified'
    && requiredValues.verified === true
    && compact(requiredValues.scheduledTaskId, 180) === target
    && result.status === 'verified'
    && result.verified === true
    && compact(result.scheduledTaskId, 180) === target
  );
}

function projectCompactSchedulerTask(task: any, receipts: any[], context: Record<string, any>): TaskAcceptanceProjection {
  const taskReceipts = receipts.filter(row => row?.taskId === task?.id);
  const audit = parseObject(context.schedulerAudit);
  const currentExecution = parseObject(audit.currentExecution);
  const currentExecutionId = compact(currentExecution.executionId, 180);
  const currentReceipts = currentExecutionId
    ? taskReceipts.filter(row => (
        compact(row?.turnId, 180) === currentExecutionId
        || compact(row?.requestId, 180) === currentExecutionId
      ))
    : [];
  const verifiedCheckpoint = currentReceipts.some(row => (
    isVerifiedCurrentSchedulerCheckpoint(row, task, context, currentExecutionId)
  ));
  const latest = [...currentReceipts].sort((left, right) => (
    String(right?.createdAt || '').localeCompare(String(left?.createdAt || ''))
  ))[0];
  const currentOutcome = compact(currentExecution.status, 60).toLowerCase();
  const status = currentOutcome === 'verified'
    ? 'completed'
    : currentOutcome || compact(task?.status || 'unknown', 60);
  const accepted = currentOutcome === 'verified' && verifiedCheckpoint;
  const diagnosticCode = accepted
    ? 'scheduler_compact_checkpoint_verified'
    : currentOutcome === 'verified'
      ? currentReceipts.length > 0
        ? 'scheduler_compact_checkpoint_unverified'
        : 'scheduler_compact_checkpoint_missing'
      : currentOutcome === 'executing'
        ? 'not_terminal'
        : currentOutcome
          ? `scheduler_compact_${currentOutcome}`
          : 'scheduler_compact_current_execution_missing';
  const diagnosticReason = accepted
    ? 'The latest compact scheduler execution is verified and the stable audit row has a verified checkpoint receipt.'
    : currentOutcome === 'verified'
      ? currentReceipts.length > 0
        ? 'The latest compact scheduler execution has a checkpoint receipt, but that receipt is not verified.'
        : 'The latest compact scheduler execution has no checkpoint receipt bound to its execution identity; an older checkpoint cannot verify the current run.'
      : currentOutcome
        ? `The latest compact scheduler execution outcome is ${currentOutcome}.`
        : 'The compact scheduler audit row has no current execution identity.';
  const terminalVerification: TaskAcceptanceProjection['terminalVerification'] = accepted
    ? 'verified'
    : ['failed', 'blocked', 'unknown'].includes(currentOutcome)
      ? 'failed'
      : latest
        ? receiptVerification(latest) === 'failed' ? 'failed' : 'unverified'
        : 'missing';
  return {
    taskId: compact(task?.id, 180),
    runtime: 'scheduler',
    status,
    accepted,
    terminalReceiptPresent: currentReceipts.length > 0,
    terminalVerification,
    diagnosticCode,
    diagnosticReason,
    updatedAt: compact(currentExecution.completedAt || currentExecution.startedAt || task?.updatedAt || task?.createdAt, 80),
    continuity: {
      goalPreserved: Boolean(compact(task?.goal || task?.target, 20)),
      planPreserved: Boolean(parseObject(context.executionPlan).planId),
      receiptLedgerPreserved: taskReceipts.length > 0,
      blockerPreserved: !['blocked', 'failed', 'unknown'].includes(currentOutcome)
        || Boolean(compact(task?.blocker || diagnosticReason, 20)),
    },
    completionFeedback: buildTaskCompletionFeedback(undefined, task?.goal || 'Scheduled task', {
      status,
      reason: diagnosticReason,
      accepted,
    }),
  };
}

function scopeMatches(task: any, input: { userId?: string; domain?: 'personal' | 'work'; orgId?: string }): boolean {
  if (input.userId && task?.userId !== input.userId) return false;
  if (!input.domain) return true;
  const taskDomain = task?.domain || task?.context?.domain || 'personal';
  if (taskDomain !== input.domain) return false;
  return input.domain !== 'work' || String(task?.orgId || task?.context?.orgId || '') === String(input.orgId || '');
}

export function buildTaskAcceptanceProjections(db: any, input: {
  userId?: string;
  domain?: 'personal' | 'work';
  orgId?: string;
} = {}): TaskAcceptanceProjection[] {
  const actionReceipts = Array.isArray(db?.conversationActionReceipts) ? db.conversationActionReceipts : [];
  const conversation = (Array.isArray(db?.conversationActionTasks) ? db.conversationActionTasks : [])
    .filter((task: any) => scopeMatches(task, input))
    .map((task: any) => {
      const context = parseObject(task?.context);
      return context.source === 'scheduler' && context.compactAudit === true
        ? projectCompactSchedulerTask(task, actionReceipts, context)
        : projectConversationTask(task, actionReceipts);
    });
  const background = (Array.isArray(db?.backgroundDelegationTasks) ? db.backgroundDelegationTasks : [])
    .filter((task: any) => scopeMatches(task, input))
    .map((task: any) => projectDurableTask(task, 'background'));
  const autonomous = input.domain === 'work'
    ? []
    : (Array.isArray(db?.autonomousTasks) ? db.autonomousTasks : [])
      .filter((task: any) => scopeMatches(task, input))
      .map((task: any) => projectDurableTask(task, 'autonomous'));
  return [...conversation, ...background, ...autonomous]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function evaluateRuntimeAcceptanceSubsystems(capabilityMetrics: any): AcceptanceEvidenceSnapshot['subsystems'] {
  const graph = capabilityMetrics?.modelGraph || {};
  const compilations = Math.max(0, Number(graph.compilations) || 0);
  const invalidGraphs = Math.max(0, Number(graph.invalidGraphs) || 0);
  const arbitrations = Math.max(0, Number(graph.arbitrations) || 0);
  const blockedArbitrations = Math.max(0, Number(graph.blockedArbitrations) || 0);
  const verifiedArbitrations = Math.max(0, arbitrations - blockedArbitrations);
  const modelGraphStatus: RuntimeSampleStatus = compilations === 0 && arbitrations === 0
    ? 'not_exercised'
    : arbitrations === 0
      ? 'unknown'
      : verifiedArbitrations > 0
        ? invalidGraphs > 0 || blockedArbitrations > 0 ? 'degraded' : 'verified'
        : 'degraded';
  const modelGraphDiagnostic = modelGraphStatus === 'not_exercised'
    ? 'no_current_process_model_graph_sample'
    : arbitrations === 0
      ? 'compiled_without_arbitration_sample'
      : verifiedArbitrations === 0
        ? 'no_successful_arbitration_sample'
        : modelGraphStatus === 'degraded'
          ? 'successful_and_failed_graph_samples_present'
          : 'successful_arbitration_sample_present';

  const knowledge = capabilityMetrics?.knowledge || {};
  const evaluations = Math.max(0, Number(knowledge.evaluations) || 0);
  const verifiedEvaluations = Math.max(0, Number(knowledge.verified) || 0);
  const unverifiedEvaluations = Math.max(0, Number(knowledge.unverified) || 0);
  const expectedItems = Math.max(0, Number(knowledge.expectedItems) || 0);
  const citationChecks = Math.max(0, Number(knowledge.citationChecks) || 0);
  const recallValue = expectedItems > 0 && Number.isFinite(Number(knowledge.aggregateRecallAt5))
    ? Number(knowledge.aggregateRecallAt5)
    : null;
  const citationValue = citationChecks > 0 && Number.isFinite(Number(knowledge.aggregateCitationAccuracy))
    ? Number(knowledge.aggregateCitationAccuracy)
    : null;
  const hasAnyKnowledgeSample = evaluations > 0 || expectedItems > 0 || citationChecks > 0;
  const hasQualitySample = evaluations > 0 && recallValue !== null && citationValue !== null;
  const knowledgeStatus: RuntimeSampleStatus = !hasAnyKnowledgeSample
    ? 'not_exercised'
    : !hasQualitySample
      ? 'unknown'
      : verifiedEvaluations > 0 && unverifiedEvaluations === 0
        ? 'verified'
        : 'degraded';
  const knowledgeDiagnostic = knowledgeStatus === 'not_exercised'
    ? 'no_current_process_knowledge_quality_sample'
    : recallValue === null && citationValue === null
      ? 'recall_and_citation_samples_missing'
      : recallValue === null
        ? 'recall_sample_missing'
        : citationValue === null
          ? 'citation_sample_missing'
          : knowledgeStatus === 'verified'
            ? 'knowledge_quality_samples_verified'
            : 'knowledge_quality_samples_degraded';

  return {
    modelGraph: {
      status: modelGraphStatus,
      sampleScope: 'current_process',
      compilations,
      invalidGraphs,
      arbitrations,
      verifiedArbitrations,
      blockedArbitrations,
      diagnosticCode: modelGraphDiagnostic,
    },
    knowledgeQuality: {
      status: knowledgeStatus,
      sampleScope: 'current_process',
      evaluations,
      verifiedEvaluations,
      unverifiedEvaluations,
      recallAt5: {
        status: recallValue === null ? 'unknown' : 'measured',
        value: recallValue,
        sampleSize: expectedItems,
      },
      citationAccuracy: {
        status: citationValue === null ? 'unknown' : 'measured',
        value: citationValue,
        sampleSize: citationChecks,
      },
      diagnosticCode: knowledgeDiagnostic,
    },
  };
}

export function buildAcceptanceEvidenceSnapshot(input: {
  db: any;
  manifest: CapabilityManifestEntry[];
  toolMetrics?: Record<string, any>;
  capabilityMetrics?: any;
  mcpHealth?: Record<string, any>;
  scope?: { userId?: string; domain?: 'personal' | 'work'; orgId?: string };
  generatedAt?: string;
}): AcceptanceEvidenceSnapshot {
  const allActionReceipts = Array.isArray(input.db?.conversationActionReceipts) ? input.db.conversationActionReceipts : [];
  const scopedActionReceipts = input.scope?.userId
    ? (() => {
        const scopedTaskIds = new Set(
          (Array.isArray(input.db?.conversationActionTasks) ? input.db.conversationActionTasks : [])
            .filter((task: any) => scopeMatches(task, input.scope || {}))
            .map((task: any) => task.id),
        );
        return allActionReceipts.filter((receipt: any) => scopedTaskIds.has(receipt?.taskId));
      })()
    : allActionReceipts;
  const capabilities = buildCapabilityAcceptanceProjections({
    manifest: input.manifest,
    actionReceipts: scopedActionReceipts,
    toolMetrics: input.toolMetrics,
    mcpHealth: input.mcpHealth,
  });
  const tasks = buildTaskAcceptanceProjections(input.db, input.scope);
  const subsystems = evaluateRuntimeAcceptanceSubsystems(input.capabilityMetrics);
  const completed = tasks.filter(task => task.status === 'completed');
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt || new Date().toISOString(),
    summary: {
      capabilities: {
        registered: capabilities.length,
        available: capabilities.filter(item => item.availability === 'available').length,
        unavailable: capabilities.filter(item => item.availability === 'unavailable').length,
        availabilityUnknown: capabilities.filter(item => item.availability === 'unknown').length,
        exercised: capabilities.filter(item => item.exercised).length,
        verified: capabilities.filter(item => item.verified).length,
      },
      tasks: {
        total: tasks.length,
        completed: completed.length,
        accepted: tasks.filter(task => task.accepted).length,
        completedWithoutTerminalReceipt: completed.filter(task => !task.terminalReceiptPresent).length,
        blockedOrFailed: tasks.filter(task => task.status === 'blocked' || task.status === 'failed').length,
      },
      modelGraph: subsystems.modelGraph.status,
      knowledgeQuality: subsystems.knowledgeQuality.status,
    },
    capabilities,
    tasks,
    subsystems,
    policy: {
      completionRequiresTerminalReceipt: true,
      verifiedRequiresMachineEvidence: true,
      zeroSamplesAreUnknown: true,
      rawPayloadsExcluded: true,
    },
  };
}

/** Public health projection: no user/task counts, tool names, workers or diagnostic details. */
export function buildPublicAcceptanceSummary(snapshot: AcceptanceEvidenceSnapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    generatedAt: snapshot.generatedAt,
    capabilities: { ...snapshot.summary.capabilities },
    modelGraph: {
      status: snapshot.subsystems.modelGraph.status,
      sampleScope: snapshot.subsystems.modelGraph.sampleScope,
      compilations: snapshot.subsystems.modelGraph.compilations,
      arbitrations: snapshot.subsystems.modelGraph.arbitrations,
      verifiedArbitrations: snapshot.subsystems.modelGraph.verifiedArbitrations,
    },
    knowledgeQuality: {
      status: snapshot.subsystems.knowledgeQuality.status,
      sampleScope: snapshot.subsystems.knowledgeQuality.sampleScope,
      evaluations: snapshot.subsystems.knowledgeQuality.evaluations,
      recallAt5: snapshot.subsystems.knowledgeQuality.recallAt5,
      citationAccuracy: snapshot.subsystems.knowledgeQuality.citationAccuracy,
    },
    policy: { ...snapshot.policy },
  };
}
