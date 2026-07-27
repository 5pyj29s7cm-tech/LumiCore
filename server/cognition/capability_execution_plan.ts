import crypto from 'node:crypto';
import type { LumiExecutionDecision } from './execution_decision';
import type { LumiCapabilityPlan } from './execution_pipeline';
import type { NormalizedActionIntent, NormalizedSideEffectClass } from './normalized_action_intent';
import type {
  CapabilityLane,
  CapabilityManifestEntry,
  CapabilityOperation,
  CapabilityRisk,
  CapabilitySideEffect,
  CapabilityVerification,
} from '../tools/types';

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
  condition?: 'success' | 'failure' | 'always';
}

export interface CapabilityNode {
  nodeId: string;
  type: CapabilityNodeType;
  state: CapabilityNodeState;
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
 * Channel-independent semantic plan. It deliberately records capability
 * candidates rather than pretending that every exposed tool will execute.
 * The model may choose from these nodes, but the registry/policy remains the
 * final authority and every selected node must later produce a receipt.
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
  decisionAuthority: 'semantic_planner';
  scriptAuthority: 'adapter_only';
}

export interface BuildCapabilityExecutionPlanInput {
  intent: NormalizedActionIntent;
  capabilityPlan: LumiCapabilityPlan;
  execution: LumiExecutionDecision;
  manifest: CapabilityManifestEntry[];
  taskId?: string;
  sourcePaths?: string[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => [key, stableValue((value as Record<string, unknown>)[key])]));
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

function makeNodeId(entry: CapabilityManifestEntry): string {
  return `cap_${digest({ capabilityId: entry.capabilityId, toolName: entry.toolName }).slice(0, 16)}`;
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

export function buildCapabilityExecutionPlan(
  input: BuildCapabilityExecutionPlanInput,
): CapabilityExecutionPlan {
  const routedTools = new Set(input.execution.toolRoute?.toolNames || []);
  const allowedTools = new Set(input.execution.toolPolicy.allowedTools || []);
  const wildcard = allowedTools.has('*');
  const forbidden = new Set(input.execution.toolPolicy.forbiddenTools || []);
  const preferred = new Set(input.capabilityPlan.preferredTools || []);
  const eligible = input.manifest.filter(entry => (
    (routedTools.has(entry.toolName) || preferred.has(entry.toolName))
    && (wildcard || allowedTools.has(entry.toolName))
    && !forbidden.has('*')
    && !forbidden.has(entry.toolName)
    && entry.executable
    && !entry.deprecated
  ));
  const nodes = eligible.map(entry => ({
    nodeId: makeNodeId(entry),
    type: nodeType(entry),
    state: 'candidate' as const,
    capabilityId: entry.capabilityId,
    toolName: entry.toolName,
    lane: entry.lane,
    operation: entry.operation,
    risk: entry.risk,
    sideEffects: entry.sideEffects.map(effect => ({ ...effect })),
    requiresConfirmation: entry.requiresConfirmation
      || input.execution.toolPolicy.requireConfirmation.includes(entry.toolName),
    verification: {
      ...entry.verification,
      requiredFields: [...entry.verification.requiredFields],
      requiredValues: entry.verification.requiredValues
        ? { ...entry.verification.requiredValues }
        : undefined,
      requiredArtifacts: [...(entry.verification.requiredArtifacts || [])],
      requiredArtifactCollections: [...(entry.verification.requiredArtifactCollections || [])],
      successStatuses: [...(entry.verification.successStatuses || [])],
      failureStatuses: [...(entry.verification.failureStatuses || [])],
      successSignals: [...entry.verification.successSignals],
      limitations: [...entry.verification.limitations],
    },
    provenance: {
      source: entry.source,
      provider: entry.provenance.provider,
      trust: entry.trust,
    },
  }));
  const taskId = String(input.taskId || '').trim()
    || `task_${digest({ intent: input.intent, capabilityIds: input.capabilityPlan.capabilityIds }).slice(0, 24)}`;
  const planId = `plan_${digest({
    taskId,
    intent: input.intent,
    nodes: nodes.map(node => node.capabilityId),
  }).slice(0, 24)}`;

  return {
    schemaVersion: 1,
    planId,
    taskId,
    intent: { ...input.intent },
    nodes,
    edges: [],
    risk: buildRiskDecision(input.intent, nodes, taskId),
    expectedEvidence: nodes.map(buildEvidence),
    fallbackPolicy: buildFallbackPolicy(input.intent),
    contextRefs: Array.from(new Set(input.sourcePaths || []))
      .filter(Boolean)
      .map(value => ({ kind: 'source' as const, value })),
    decisionAuthority: 'semantic_planner',
    scriptAuthority: 'adapter_only',
  };
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

export function formatCapabilityExecutionPlanPrompt(plan: CapabilityExecutionPlan): string {
  const candidates = plan.nodes
    .map(node => `${node.toolName || node.capabilityId} (${node.capabilityId}; ${node.operation}; verification=${node.verification.strategy})`)
    .join(', ');
  return [
    '## Capability Execution Plan',
    `Plan ${plan.planId}; task ${plan.taskId}; intent=${plan.intent.kind}/${plan.intent.operation}; sideEffect=${plan.risk.sideEffectClass}.`,
    `Eligible capability candidates: ${candidates || 'none'}. These are candidates, not instructions to execute all tools.`,
    'Semantic planning owns intent, decomposition, and capability selection. Workflows and scripts are execution adapters only.',
    plan.risk.requiresConfirmation
      ? 'Bind confirmation to the selected tool, exact target, task id, and payload digest before execution.'
      : 'No confirmation is implied by this plan; the registry remains authoritative for each selected tool.',
    'A completion claim requires the selected terminal node receipt to satisfy its verification contract.',
    'Never fall back to a legacy route. Target mismatch or unknown external outcome stops execution.',
  ].join('\n');
}
