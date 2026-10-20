import { stableValue } from '../../shared/stable_json';
import crypto from 'node:crypto';
import type { NormalizedActionIntent, NormalizedSideEffectClass } from './normalized_action_intent';
import type {
  CapabilityLane,
  CapabilityManifestEntry,
  CapabilityOperation,
  CapabilityRisk,
  CapabilitySideEffect,
  CapabilityVerification,
  ToolExecutionRecord,
} from '../tools/types';
import { evaluateCapabilityRollout } from './capability_rollout';

export type CapabilityNodeType =
  | 'model'
  | 'internal_agent'
  | 'external_agent'
  | 'skill'
  | 'tool'
  | 'desktop_action'
  | 'judge'
  | 'join';

export type CapabilityNodeState = 'candidate' | 'selected' | 'running' | 'terminal';

export interface ExecutionEdge {
  from: string;
  to: string;
  condition?: 'selected' | 'success' | 'failure' | 'verified' | 'always';
}

export interface CapabilityNode {
  nodeId: string;
  type: CapabilityNodeType;
  state: CapabilityNodeState;
  terminalStatus?: NonNullable<ToolExecutionRecord['envelope']>['status'];
  capabilityId: string;
  toolName?: string;
  lane: CapabilityLane;
  operation: CapabilityOperation;
  risk: CapabilityRisk;
  sideEffects: CapabilitySideEffect[];
  requiresConfirmation: boolean;
  verification: CapabilityVerification;
  provenance: {
    source: CapabilityManifestEntry['source'];
    provider: string;
    trust: CapabilityManifestEntry['trust'];
  };
  executionRole: 'planner' | 'adapter' | 'verifier' | 'join';
  selectionGroup?: string;
  selectionRank?: number;
}

export interface EvidenceRequirement {
  nodeId: string;
  capabilityId: string;
  strategy: CapabilityVerification['strategy'];
  required: boolean;
  requiredFields: string[];
  requiredValues?: Record<string, unknown>;
  requiredArtifacts: string[];
  successStatuses: string[];
}

export interface ConfirmationBinding {
  taskId: string;
  target: string;
  payloadDigest: string;
  /** Filled with the selected terminal tool before the confirmation is shown. */
  tool: string;
}

export interface RiskDecision {
  sideEffectClass: NormalizedSideEffectClass;
  requiresConfirmation: boolean;
  failClosed: boolean;
  confirmationBinding?: ConfirmationBinding;
  reasons: string[];
}

export interface FallbackPolicy {
  retryClass: 'none' | 'idempotent_only';
  maxRetries: number;
  jitter: boolean;
  reconcileUnknownOutcome: boolean;
  allowLegacyRoute: false;
  onTargetMismatch: 'stop';
  onUnknownOutcome: 'stop_and_report' | 'reconcile_then_stop';
}

export interface ArtifactReference {
  kind: 'source' | 'artifact' | 'receipt' | 'task';
  value: string;
}

/**
 * Actual call observations and separately declared scheduler policies share
 * this historical container. Exposed candidates are not selected actions.
 * Registry policy, bound arguments and exact confirmation own admission;
 * node state never upgrades the canonical receipt outcome.
 */
export interface CapabilityExecutionPlan {
  schemaVersion: 1;
  planId: string;
  taskId: string;
  intent: NormalizedActionIntent;
  nodes: CapabilityNode[];
  edges: ExecutionEdge[];
  risk: RiskDecision;
  expectedEvidence: EvidenceRequirement[];
  fallbackPolicy: FallbackPolicy;
  contextRefs: ArtifactReference[];
  decisionAuthority: 'semantic_planner' | 'registry_bound_call';
  scriptAuthority: 'adapter_only';
}

export interface BuildCapabilityExecutionPlanInput {
  record: ToolExecutionRecord;
  capability: CapabilityManifestEntry;
  taskId: string;
  previousPlan?: CapabilityExecutionPlan;
}

export interface BuildScheduledCapabilityExecutionPlanInput {
  taskId: string;
  scheduledTaskId: string;
  lane: CapabilityLane;
  operation: CapabilityOperation;
  sideEffectClass: Exclude<NormalizedSideEffectClass, 'external_commit'>;
  sideEffects: CapabilitySideEffect[];
}

function digest(value: unknown): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function nodeType(entry: CapabilityManifestEntry): CapabilityNodeType {
  if (entry.lane === 'desktop' || entry.lane === 'client') return 'desktop_action';
  if (entry.source === 'skill') return 'skill';
  if (entry.lane === 'agents' && /external/i.test(`${entry.capabilityId} ${entry.toolName}`)) {
    return 'external_agent';
  }
  if (entry.lane === 'agents') return 'internal_agent';
  return 'tool';
}

function buildEvidence(node: CapabilityNode): EvidenceRequirement {
  return {
    nodeId: node.nodeId,
    capabilityId: node.capabilityId,
    strategy: node.verification.strategy,
    required: node.verification.required,
    requiredFields: [...node.verification.requiredFields],
    ...(node.verification.requiredValues
      ? { requiredValues: { ...node.verification.requiredValues } }
      : {}),
    requiredArtifacts: [...(node.verification.requiredArtifacts || [])],
    successStatuses: [...(node.verification.successStatuses || [])],
  };
}

function syntheticNode(input: {
  nodeId: string;
  type: 'model' | 'judge' | 'join';
  role: 'planner' | 'verifier' | 'join';
  capabilityId: string;
  lane: CapabilityLane;
  operation: CapabilityOperation;
  selectionGroup?: string;
}): CapabilityNode {
  return {
    nodeId: input.nodeId,
    type: input.type,
    state: 'selected',
    capabilityId: input.capabilityId,
    lane: input.lane,
    operation: input.operation,
    risk: 'none',
    sideEffects: [],
    requiresConfirmation: false,
    verification: {
      strategy: 'none',
      required: false,
      requiredFields: [],
      requiredArtifacts: [],
      requiredArtifactCollections: [],
      successStatuses: [],
      failureStatuses: [],
      successSignals: [],
      limitations: [],
    },
    provenance: { source: 'builtin', provider: 'lumi-core', trust: 'core' },
    executionRole: input.role,
    ...(input.selectionGroup ? { selectionGroup: input.selectionGroup } : {}),
  };
}

function buildRiskDecision(
  intent: NormalizedActionIntent,
  nodes: CapabilityNode[],
  taskId: string,
): RiskDecision {
  const externalCommit = intent.sideEffectClass === 'external_commit';
  const nodeRequiresConfirmation = nodes.some(node => node.requiresConfirmation);
  const requiresConfirmation = externalCommit || nodeRequiresConfirmation;
  const reasons = [
    `normalized intent side effect is ${intent.sideEffectClass}`,
    ...(externalCommit ? ['external commits require an immutable confirmation binding'] : []),
    ...(nodeRequiresConfirmation ? ['one or more candidate capabilities are confirmation-gated'] : []),
  ];
  return {
    sideEffectClass: intent.sideEffectClass,
    requiresConfirmation,
    failClosed: externalCommit,
    ...(requiresConfirmation ? {
      confirmationBinding: {
        taskId,
        tool: '',
        target: intent.target,
        payloadDigest: digest(intent.payload),
      },
    } : {}),
    reasons,
  };
}

function buildFallbackPolicy(intent: NormalizedActionIntent): FallbackPolicy {
  const idempotent = intent.sideEffectClass === 'none'
    && (intent.operation === 'read' || intent.operation === 'status');
  const externalCommit = intent.sideEffectClass === 'external_commit';
  return {
    retryClass: idempotent ? 'idempotent_only' : 'none',
    maxRetries: idempotent ? 2 : 0,
    jitter: idempotent,
    reconcileUnknownOutcome: externalCommit,
    allowLegacyRoute: false,
    onTargetMismatch: 'stop',
    onUnknownOutcome: externalCommit ? 'reconcile_then_stop' : 'stop_and_report',
  };
}

export function resolveCapabilitySideEffectClass(nodes: ReadonlyArray<Pick<CapabilityManifestEntry, 'operation' | 'sideEffects'>>): NormalizedSideEffectClass {
  const externalCommit = nodes.some(item => item.sideEffects.some(effect => (
    effect.type === 'external_state_change' || effect.type === 'external_communication'
  )));
  const localWrite = nodes.some(item => ['create', 'mutate', 'communicate', 'unknown'].includes(item.operation)
    || item.sideEffects.some(effect => !['none', 'local_read', 'network_read'].includes(effect.type)));
  return externalCommit ? 'external_commit' : localWrite ? 'local_write' : 'none';
}

/** Observation of actual bound calls; authorization remains in the registry and exact confirmation. */
export function buildCapabilityExecutionPlan(
  input: BuildCapabilityExecutionPlanInput,
): CapabilityExecutionPlan {
  const { record, capability: entry, taskId } = input;
  if (!record.envelope) throw new Error('A bound-call observation requires its canonical outcome envelope');
  const node: CapabilityNode = {
    nodeId: 'call_' + digest({ taskId, id: record.id, name: record.name }).slice(0, 20),
    type: nodeType(entry), state: record.envelope.status === 'waiting_confirmation' ? 'selected' : 'terminal',
    terminalStatus: record.envelope.status, capabilityId: entry.capabilityId, toolName: record.name,
    lane: entry.lane, operation: entry.operation, risk: entry.risk,
    sideEffects: entry.sideEffects.map(effect => ({ ...effect })),
    requiresConfirmation: entry.requiresConfirmation || record.envelope.status === 'waiting_confirmation', verification: entry.verification,
    provenance: { source: entry.source, provider: entry.provenance.provider, trust: entry.trust },
    executionRole: 'adapter',
  };
  const prior = input.previousPlan?.decisionAuthority === 'registry_bound_call'
    && input.previousPlan.taskId === taskId ? input.previousPlan : undefined;
  const nodes = [...(prior?.nodes || []).filter(item => item.nodeId !== node.nodeId), node];
  const sideEffectClass = resolveCapabilitySideEffectClass(nodes);
  const externalCommit = sideEffectClass === 'external_commit';
  const intent: NormalizedActionIntent = {
    kind: 'work_task', operation: sideEffectClass === 'none' ? 'read' : 'mutate',
    subject: entry.provenance.provider, target: record.name, payload: '', sideEffectClass,
    relation: prior ? 'continue' : 'new', confidence: 1, rule: 'registry-bound-call',
  };
  return {
    schemaVersion: 1, planId: 'plan_' + digest({ taskId, nodes: nodes.map(item => item.nodeId) }).slice(0, 24),
    taskId, intent, nodes, edges: [],
    risk: { sideEffectClass, requiresConfirmation: externalCommit || nodes.some(item => item.requiresConfirmation),
      failClosed: externalCommit, reasons: ['Observed bound tool calls; exact registry grants remain authoritative.'] },
    expectedEvidence: nodes.map(buildEvidence), fallbackPolicy: buildFallbackPolicy(intent),
    contextRefs: [...(prior?.contextRefs || []), ...(record.id ? [{ kind: 'receipt' as const, value: record.id }] : [])],
    decisionAuthority: 'registry_bound_call', scriptAuthority: 'adapter_only',
  };
}

/**
 * Compiles an already-declared scheduler policy into the same semantic graph
 * used by interactive entrances. Scheduler handlers remain adapters: they do
 * not get to infer intent, widen their target, or introduce external commits.
 */
export function buildScheduledCapabilityExecutionPlan(
  input: BuildScheduledCapabilityExecutionPlanInput,
): CapabilityExecutionPlan {
  const intent: NormalizedActionIntent = {
    kind: 'scheduled_task',
    operation: input.operation === 'observe' ? 'read' : 'mutate',
    subject: 'lumi_scheduler',
    target: input.scheduledTaskId,
    payload: '',
    sideEffectClass: input.sideEffectClass,
    relation: 'new',
    confidence: 1,
    rule: 'declared-scheduler-policy',
  };
  const groupId = `group_${digest({
    task: input.scheduledTaskId,
    lane: input.lane,
    operation: input.operation,
  }).slice(0, 12)}`;
  const selectorId = `select_${groupId}`;
  const adapterId = `scheduled_${digest(input.scheduledTaskId).slice(0, 16)}`;
  const verifierId = `verify_${groupId}`;
  const joinId = `join_${digest([groupId]).slice(0, 12)}`;
  const capabilityId = `lumi.scheduler.${input.scheduledTaskId}`;
  const adapter: CapabilityNode = {
    nodeId: adapterId,
    type: 'internal_agent',
    state: 'candidate',
    capabilityId,
    toolName: 'scheduler_task_handler',
    lane: input.lane,
    operation: input.operation,
    risk: input.sideEffectClass === 'none' ? 'none' : 'low',
    sideEffects: input.sideEffects.map(effect => ({ ...effect })),
    requiresConfirmation: false,
    verification: {
      strategy: 'terminal_receipt',
      required: true,
      requiredFields: ['status', 'verified', 'scheduledTaskId'],
      requiredValues: {
        status: 'verified',
        verified: true,
        scheduledTaskId: input.scheduledTaskId,
      },
      requiredArtifacts: [],
      requiredArtifactCollections: [],
      successStatuses: ['verified'],
      failureStatuses: ['failed', 'blocked', 'unknown'],
      successSignals: ['declared scheduler handler completed and its local delivery persistence was recorded'],
      limitations: ['The scheduler adapter cannot execute an external commit or change its declared task target.'],
    },
    provenance: { source: 'adapter', provider: 'lumi-scheduler', trust: 'core' },
    executionRole: 'adapter',
    selectionGroup: groupId,
    selectionRank: 0,
  };
  const nodes: CapabilityNode[] = [
    syntheticNode({
      nodeId: selectorId,
      type: 'model',
      role: 'planner',
      capabilityId: `lumi.semantic_selector.${groupId}`,
      lane: input.lane,
      operation: input.operation,
      selectionGroup: groupId,
    }),
    adapter,
    syntheticNode({
      nodeId: verifierId,
      type: 'judge',
      role: 'verifier',
      capabilityId: `lumi.receipt_verifier.${groupId}`,
      lane: input.lane,
      operation: input.operation,
      selectionGroup: groupId,
    }),
    syntheticNode({
      nodeId: joinId,
      type: 'join',
      role: 'join',
      capabilityId: 'lumi.verified_receipt_join',
      lane: input.lane,
      operation: input.operation,
    }),
  ];
  return {
    schemaVersion: 1,
    planId: `plan_${digest({ taskId: input.taskId, intent, capabilityId }).slice(0, 24)}`,
    taskId: input.taskId,
    intent,
    nodes,
    edges: [
      { from: selectorId, to: adapterId, condition: 'selected' },
      { from: adapterId, to: verifierId, condition: 'success' },
      { from: verifierId, to: joinId, condition: 'verified' },
    ],
    risk: buildRiskDecision(intent, nodes, input.taskId),
    expectedEvidence: [buildEvidence(adapter)],
    fallbackPolicy: buildFallbackPolicy(intent),
    contextRefs: [{ kind: 'task', value: input.scheduledTaskId }],
    decisionAuthority: 'semantic_planner',
    scriptAuthority: 'adapter_only',
  };
}

export function authorizeCapabilityPlanTool(
  plan: CapabilityExecutionPlan,
  toolName: string,
): { allowed: boolean; reason: string; node?: CapabilityNode } {
  const node = plan.nodes.find(candidate => (
    candidate.executionRole === 'adapter'
    && candidate.toolName === toolName
  ));
  if (!node) {
    return { allowed: false, reason: `Capability plan did not authorize adapter '${toolName}'.` };
  }
  const selectedEdge = plan.edges.some(edge => (
    edge.to === node.nodeId && edge.condition === 'selected'
  ));
  const verificationEdge = plan.edges.some(edge => (
    edge.from === node.nodeId && edge.condition === 'success'
  ));
  if (!selectedEdge || !verificationEdge) {
    return {
      allowed: false,
      reason: `Capability adapter '${toolName}' is missing selection or receipt-verification graph edges.`,
    };
  }
  const rollout = evaluateCapabilityRollout(plan, node);
  if (!rollout.allowed) {
    return { allowed: false, reason: rollout.reason, node };
  }
  return { allowed: true, reason: 'authorized_by_capability_plan', node };
}

/** Rebinds the pre-routing plan to the durable task created by the ledger. */
export function bindCapabilityExecutionPlanTask(
  plan: CapabilityExecutionPlan,
  taskId: string | null | undefined,
): CapabilityExecutionPlan {
  const durableTaskId = String(taskId || '').trim();
  if (!durableTaskId || durableTaskId === plan.taskId) return plan;
  return {
    ...plan,
    taskId: durableTaskId,
    planId: `plan_${digest({
      taskId: durableTaskId,
      intent: plan.intent,
      nodes: plan.nodes.map(node => node.capabilityId),
    }).slice(0, 24)}`,
    risk: {
      ...plan.risk,
      ...(plan.risk.confirmationBinding ? {
        confirmationBinding: {
          ...plan.risk.confirmationBinding,
          taskId: durableTaskId,
        },
      } : {}),
    },
  };
}

