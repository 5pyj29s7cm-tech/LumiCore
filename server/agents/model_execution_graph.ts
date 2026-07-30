import crypto from 'node:crypto';
import { isExtensionProviderId, isRegisteredProviderLocal } from '../extensions/registry';

export type ModelGraphNodeType =
  | 'model'
  | 'internal_agent'
  | 'external_agent'
  | 'judge'
  | 'join';

export type ModelGraphPrivacy = 'policy_scoped' | 'local_only';

export interface ModelCandidate {
  provider: string;
  model: string;
  locality: 'local' | 'remote' | 'external_runtime' | 'unknown';
  priority: number;
  /** The worker identity this candidate is compiled for. */
  agentId?: string;
  estimatedCostPer1kTokensUsd?: number;
}

export interface ModelGraphNode {
  nodeId: string;
  type: ModelGraphNodeType;
  role: string;
  candidates: ModelCandidate[];
  dependsOn: string[];
  inputRefs: string[];
  outputSchema: Record<string, unknown>;
  timeoutMs: number;
  maxRetries: number;
  assignedAgentId?: string;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export interface ModelGraphEdge {
  from: string;
  to: string;
  condition: 'success';
}

export interface ModelExecutionBudget {
  maxNodes: number;
  maxParallel: number;
  maxRetriesPerNode: number;
  maxWallTimeMs: number;
  maxInputTokens: number;
  maxEstimatedCostUsd: number;
}

export interface ModelExecutionGraph {
  schemaVersion: 1;
  graphId: string;
  taskId: string;
  nodes: ModelGraphNode[];
  edges: ModelGraphEdge[];
  budgets: ModelExecutionBudget;
  privacyPolicy: ModelGraphPrivacy;
  arbitration: 'aggregate_verified' | 'first_verified' | 'majority_vote' | 'judge';
  compiledAt: string;
}

export interface ModelGraphCompilation {
  ok: boolean;
  graph: ModelExecutionGraph;
  errors: string[];
  waves: string[][];
}

export type ModelGraphNodeStatus = 'succeeded' | 'failed' | 'blocked' | 'cancelled';

export interface ModelGraphNodeReceipt {
  graphId: string;
  taskId: string;
  nodeId: string;
  status: ModelGraphNodeStatus;
  selectedCandidate?: ModelCandidate;
  agentId?: string;
  dependencyReceiptIds: string[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  nodeFingerprint: string;
  outputDigest: string;
  outputSummary?: string;
  verified: boolean;
  reusedFromReceipt?: string;
  error?: string;
  estimatedInputTokens?: number;
  estimatedCostUsd?: number;
}

export interface ModelGraphArbitrationReceipt {
  graphId: string;
  taskId: string;
  policy: ModelExecutionGraph['arbitration'];
  status: 'succeeded' | 'blocked';
  selectedNodeIds: string[];
  consideredNodeIds: string[];
  outputDigest: string;
  completedAt: string;
  reason?: string;
}

export interface CompileModelExecutionGraphInput {
  taskId?: string;
  nodes: ModelGraphNode[];
  budgets?: Partial<ModelExecutionBudget>;
  privacyPolicy?: ModelGraphPrivacy;
  arbitration?: ModelExecutionGraph['arbitration'];
}

export interface ResolveAgentModelCandidatesInput {
  agentId: string;
  agentName: string;
  runtime?: 'internal' | 'external';
  modelPreference?: string;
  runtimeConfig?: string | Record<string, unknown>;
  defaultProvider: string;
  defaultModel: string;
  configuredModels?: Record<string, string>;
  taskCandidates?: Array<Partial<ModelCandidate> & { provider: string; model: string }>;
}

const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'local', 'local-whisper', 'local-cosyvoice', 'gptsovits']);
const REASONING_PROVIDERS = new Set([
  'deepseek', 'gemini', 'openai', 'anthropic', 'qwen', 'ark', 'ollama',
  'lmstudio', 'xiaomi', 'kimi', 'glm', 'relay', 'auto',
]);

export function modelCandidateLocality(provider: string): ModelCandidate['locality'] {
  const normalized = String(provider || '').trim().toLowerCase();
  if (LOCAL_PROVIDERS.has(normalized)) return 'local';
  if (isExtensionProviderId(normalized) && isRegisteredProviderLocal(normalized)) return 'local';
  if (normalized.startsWith('external:')) return 'external_runtime';
  if (!normalized || normalized === 'auto') return 'unknown';
  return 'remote';
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function cleanCandidate(
  value: unknown,
  agentId: string,
  fallbackPriority: number,
): ModelCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const provider = String(record.provider || '').trim().toLowerCase();
  const model = String(record.model || '').trim().slice(0, 200);
  if ((!REASONING_PROVIDERS.has(provider) && !isExtensionProviderId(provider)) || !model) return null;
  const requestedPriority = Number(record.priority);
  return {
    provider,
    model,
    locality: modelCandidateLocality(provider),
    priority: Number.isFinite(requestedPriority)
      ? Math.max(0, Math.min(1000, Math.trunc(requestedPriority)))
      : fallbackPriority,
    agentId,
  };
}

function preferenceCandidate(input: ResolveAgentModelCandidatesInput): ModelCandidate | null {
  const raw = String(input.modelPreference || '').trim();
  if (!raw) return null;

  const objectPreference = cleanCandidate(parseObject(raw), input.agentId, 100);
  if (objectPreference) return objectPreference;

  // Explicit provider/model is unambiguous even for local model names that contain ':'.
  const slash = raw.indexOf('/');
  if (slash > 0) {
    const explicit = cleanCandidate({
      provider: raw.slice(0, slash),
      model: raw.slice(slash + 1),
      priority: 100,
    }, input.agentId, 100);
    if (explicit) return explicit;
  }

  const matchedProvider = Object.entries(input.configuredModels || {})
    .find(([, model]) => String(model || '').trim() === raw)?.[0];
  return cleanCandidate({
    provider: matchedProvider || input.defaultProvider,
    model: raw,
    priority: 100,
  }, input.agentId, 100);
}

/**
 * Compile the model/runtime choices attached to a worker into concrete graph
 * candidates. runtimeConfig.modelCandidates and taskCandidates use
 * [{ provider, model, priority }] and agent modelPreference remains backwards
 * compatible with a bare model name or an explicit "provider/model" value.
 */
export function resolveAgentModelCandidates(
  input: ResolveAgentModelCandidatesInput,
): ModelCandidate[] {
  if (input.runtime === 'external') {
    return [{
      provider: `external:${input.agentId}`,
      model: input.agentName,
      locality: 'external_runtime',
      priority: 0,
      agentId: input.agentId,
    }];
  }

  const runtimeConfig = parseObject(input.runtimeConfig);
  const configured = Array.isArray(runtimeConfig.modelCandidates)
    ? runtimeConfig.modelCandidates
    : [];
  const candidates: ModelCandidate[] = [];
  for (const [index, value] of [
    ...(input.taskCandidates || []),
    ...configured,
  ].entries()) {
    const candidate = cleanCandidate(value, input.agentId, index);
    if (candidate) candidates.push(candidate);
  }
  const preference = preferenceCandidate(input);
  if (preference) candidates.push(preference);
  const fallback = cleanCandidate({
    provider: input.defaultProvider,
    model: input.defaultModel,
    priority: 900,
  }, input.agentId, 900);
  if (fallback) candidates.push(fallback);

  const unique = new Map<string, ModelCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.agentId}\u0000${candidate.provider}\u0000${candidate.model}`;
    const existing = unique.get(key);
    if (!existing || candidate.priority < existing.priority) unique.set(key, candidate);
  }
  return [...unique.values()]
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 6);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => [key, stableValue((value as Record<string, unknown>)[key])]));
}

export function modelGraphDigest(value: unknown): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

export function modelGraphNodeFingerprint(node: ModelGraphNode): string {
  return modelGraphDigest({
    nodeId: node.nodeId,
    type: node.type,
    role: node.role,
    candidates: node.candidates.map(candidate => ({
      provider: candidate.provider,
      model: candidate.model,
      locality: candidate.locality,
      agentId: candidate.agentId || '',
      estimatedCostPer1kTokensUsd: candidate.estimatedCostPer1kTokensUsd || 0,
    })),
    dependsOn: [...node.dependsOn].sort(),
    inputRefs: [...node.inputRefs].sort(),
    outputSchema: node.outputSchema,
    assignedAgentId: node.assignedAgentId || '',
    estimatedInputTokens: node.estimatedInputTokens || 0,
    estimatedOutputTokens: node.estimatedOutputTokens || 0,
  });
}

function summarizeModelNodeOutput(value: string): string {
  return String(value || '')
    .replace(/\b(password|passcode|secret|token|api[ _-]?key|authorization)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

function normalizeBudgets(input?: Partial<ModelExecutionBudget>): ModelExecutionBudget {
  const finiteOr = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    maxNodes: Math.max(1, Math.min(64, Math.trunc(finiteOr(input?.maxNodes, 12)))),
    maxParallel: Math.max(1, Math.min(16, Math.trunc(finiteOr(input?.maxParallel, 4)))),
    maxRetriesPerNode: Math.max(0, Math.min(3, Math.trunc(finiteOr(input?.maxRetriesPerNode, 2)))),
    maxWallTimeMs: Math.max(1_000, Math.min(60 * 60_000, Math.trunc(finiteOr(input?.maxWallTimeMs, 10 * 60_000)))),
    maxInputTokens: Math.max(1_000, Math.min(2_000_000, Math.trunc(finiteOr(input?.maxInputTokens, 256_000)))),
    maxEstimatedCostUsd: Math.max(0, Math.min(10_000, finiteOr(input?.maxEstimatedCostUsd, 20))),
  };
}

function candidateCostPer1k(candidate: ModelCandidate): number {
  if (Number.isFinite(candidate.estimatedCostPer1kTokensUsd)) {
    return Math.max(0, Number(candidate.estimatedCostPer1kTokensUsd));
  }
  return candidate.locality === 'local' ? 0 : 0.02;
}

function estimatedNodeCost(node: ModelGraphNode): number {
  const tokens = Math.max(0, Number(node.estimatedInputTokens || 0))
    + Math.max(0, Number(node.estimatedOutputTokens || 0));
  const highestCandidateRate = Math.max(0, ...node.candidates.map(candidateCostPer1k));
  return (tokens / 1000) * highestCandidateRate;
}

function topologicalWaves(nodes: ModelGraphNode[]): { waves: string[][]; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set(nodes.map(node => node.nodeId));
  const indegree = new Map(nodes.map(node => [node.nodeId, 0]));
  const outgoing = new Map(nodes.map(node => [node.nodeId, [] as string[]]));

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) {
        errors.push(`node ${node.nodeId} depends on missing node ${dependency}`);
        continue;
      }
      if (dependency === node.nodeId) {
        errors.push(`node ${node.nodeId} depends on itself`);
        continue;
      }
      indegree.set(node.nodeId, (indegree.get(node.nodeId) || 0) + 1);
      outgoing.get(dependency)?.push(node.nodeId);
    }
  }

  const waves: string[][] = [];
  let ready = nodes.filter(node => (indegree.get(node.nodeId) || 0) === 0).map(node => node.nodeId);
  let visited = 0;
  while (ready.length > 0) {
    const wave = [...ready];
    waves.push(wave);
    ready = [];
    visited += wave.length;
    for (const nodeId of wave) {
      for (const child of outgoing.get(nodeId) || []) {
        const next = (indegree.get(child) || 0) - 1;
        indegree.set(child, next);
        if (next === 0) ready.push(child);
      }
    }
  }
  if (visited !== nodes.length && !errors.some(error => error.includes('depends on missing'))) {
    errors.push('execution graph contains a dependency cycle');
  }
  return { waves, errors };
}

export function compileModelExecutionGraph(
  input: CompileModelExecutionGraphInput,
): ModelGraphCompilation {
  const budgets = normalizeBudgets(input.budgets);
  const privacyPolicy = input.privacyPolicy || 'policy_scoped';
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const node of input.nodes) {
    if (!node.nodeId.trim()) errors.push('every graph node needs a non-empty nodeId');
    if (seen.has(node.nodeId)) errors.push(`duplicate node id ${node.nodeId}`);
    seen.add(node.nodeId);
    if (node.timeoutMs <= 0 || node.timeoutMs > budgets.maxWallTimeMs) {
      errors.push(`node ${node.nodeId} timeout exceeds graph wall-time budget`);
    }
    if (node.maxRetries > budgets.maxRetriesPerNode) {
      errors.push(`node ${node.nodeId} retry budget exceeds graph policy`);
    }
    if (node.candidates.length === 0) errors.push(`node ${node.nodeId} has no model/agent candidate`);
    if (node.candidates.some(candidate => !candidate.provider.trim() || !candidate.model.trim())) {
      errors.push(`node ${node.nodeId} has an incomplete candidate identity`);
    }
    if (node.candidates.some(candidate => (
      !candidate.provider.startsWith('external:') && !REASONING_PROVIDERS.has(candidate.provider)
    ))) {
      errors.push(`node ${node.nodeId} has an unsupported reasoning provider`);
    }
    const candidateKeys = node.candidates.map(candidate => (
      `${candidate.agentId || ''}\u0000${candidate.provider}\u0000${candidate.model}`
    ));
    if (new Set(candidateKeys).size !== candidateKeys.length) {
      errors.push(`node ${node.nodeId} has duplicate execution candidates`);
    }
    if (privacyPolicy === 'local_only' && node.candidates.some(candidate => candidate.locality !== 'local')) {
      errors.push(`node ${node.nodeId} violates local-only data routing`);
    }
    if (privacyPolicy === 'local_only' && node.type === 'external_agent') {
      errors.push(`node ${node.nodeId} cannot use an external agent in local-only mode`);
    }
    if (/^(?:reflection|reflect|critique)$/i.test(node.role) && node.dependsOn.length === 0) {
      errors.push(`reflection node ${node.nodeId} requires at least one dependency to review`);
    }
  }
  if (input.nodes.length > budgets.maxNodes) {
    errors.push(`graph has ${input.nodes.length} nodes but budget allows ${budgets.maxNodes}`);
  }
  const totalInputTokens = input.nodes.reduce((sum, node) => (
    sum + Math.max(0, Number(node.estimatedInputTokens || 0))
  ), 0);
  if (totalInputTokens > budgets.maxInputTokens) {
    errors.push(`graph input context estimate ${totalInputTokens} exceeds budget ${budgets.maxInputTokens}`);
  }
  const estimatedCostUsd = input.nodes.reduce((sum, node) => sum + estimatedNodeCost(node), 0);
  if (estimatedCostUsd > budgets.maxEstimatedCostUsd) {
    errors.push(`graph estimated cost ${estimatedCostUsd.toFixed(4)} exceeds budget ${budgets.maxEstimatedCostUsd.toFixed(4)}`);
  }
  if (input.arbitration === 'judge') {
    const judges = input.nodes.filter(node => node.type === 'judge');
    if (judges.length !== 1) {
      errors.push('judge arbitration requires exactly one judge node');
    } else {
      const requiredInputs = input.nodes
        .filter(node => node.nodeId !== judges[0].nodeId)
        .map(node => node.nodeId);
      const missingJudgeInputs = requiredInputs.filter(nodeId => !judges[0].dependsOn.includes(nodeId));
      if (missingJudgeInputs.length > 0) {
        errors.push(`judge node must depend on every candidate node: ${missingJudgeInputs.join(', ')}`);
      }
    }
  }
  const sorted = topologicalWaves(input.nodes);
  errors.push(...sorted.errors);
  if (sorted.waves.some(wave => wave.length > budgets.maxParallel)) {
    errors.push(`graph parallel width exceeds budget ${budgets.maxParallel}`);
  }

  const taskId = String(input.taskId || '').trim()
    || `task_${modelGraphDigest(input.nodes).slice(0, 24)}`;
  const arbitration = input.arbitration || 'aggregate_verified';
  const graphId = `graph_${modelGraphDigest({
    taskId,
    nodes: input.nodes,
    budgets,
    privacyPolicy,
    arbitration,
  }).slice(0, 24)}`;
  const graph: ModelExecutionGraph = {
    schemaVersion: 1,
    graphId,
    taskId,
    nodes: input.nodes.map(node => ({
      ...node,
      candidates: node.candidates
        .map(candidate => ({ ...candidate }))
        .sort((a, b) => a.priority - b.priority),
      dependsOn: Array.from(new Set(node.dependsOn)),
      inputRefs: [...node.inputRefs],
      outputSchema: { ...node.outputSchema },
    })),
    edges: input.nodes.flatMap(node => node.dependsOn.map(from => ({
      from,
      to: node.nodeId,
      condition: 'success' as const,
    }))),
    budgets,
    privacyPolicy,
    arbitration,
    compiledAt: new Date().toISOString(),
  };
  return { ok: errors.length === 0, graph, errors, waves: sorted.waves };
}

export function buildModelGraphNodeReceipt(input: {
  graph: ModelExecutionGraph;
  node: ModelGraphNode;
  status: ModelGraphNodeStatus;
  startedAt: string;
  completedAt?: string;
  agentId?: string;
  output?: string;
  error?: string;
  selectedCandidate?: ModelCandidate;
}): ModelGraphNodeReceipt {
  const completedAt = input.completedAt || new Date().toISOString();
  return {
    graphId: input.graph.graphId,
    taskId: input.graph.taskId,
    nodeId: input.node.nodeId,
    status: input.status,
    selectedCandidate: input.status === 'blocked' || input.status === 'cancelled'
      ? undefined
      : input.selectedCandidate
        ? { ...input.selectedCandidate }
        : input.node.candidates[0]
          ? { ...input.node.candidates[0] }
          : undefined,
    agentId: input.agentId || input.node.assignedAgentId,
    dependencyReceiptIds: input.node.dependsOn.map(dependency => `${input.graph.graphId}:${dependency}`),
    startedAt: input.startedAt,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(input.startedAt)),
    nodeFingerprint: modelGraphNodeFingerprint(input.node),
    outputDigest: modelGraphDigest(input.output || ''),
    ...(input.output ? { outputSummary: summarizeModelNodeOutput(input.output) } : {}),
    verified: input.status === 'succeeded',
    ...(input.node.estimatedInputTokens !== undefined
      ? { estimatedInputTokens: input.node.estimatedInputTokens }
      : {}),
    ...(estimatedNodeCost(input.node) > 0
      ? { estimatedCostUsd: Number(estimatedNodeCost(input.node).toFixed(6)) }
      : {}),
    ...(input.error ? { error: input.error.slice(0, 700) } : {}),
  };
}

export function reuseVerifiedModelGraphNodeReceipt(input: {
  graph: ModelExecutionGraph;
  node: ModelGraphNode;
  prior: ModelGraphNodeReceipt;
  recoveredAt?: string;
}): ModelGraphNodeReceipt | null {
  if (
    input.prior.taskId !== input.graph.taskId
    || input.prior.nodeId !== input.node.nodeId
    || input.prior.nodeFingerprint !== modelGraphNodeFingerprint(input.node)
    || input.prior.status !== 'succeeded'
    || input.prior.verified !== true
  ) {
    return null;
  }
  const recoveredAt = input.recoveredAt || new Date().toISOString();
  return {
    ...input.prior,
    graphId: input.graph.graphId,
    taskId: input.graph.taskId,
    dependencyReceiptIds: input.node.dependsOn.map(dependency => `${input.graph.graphId}:${dependency}`),
    startedAt: recoveredAt,
    completedAt: recoveredAt,
    durationMs: 0,
    reusedFromReceipt: `${input.prior.graphId}:${input.prior.nodeId}`,
  };
}

export function arbitrateModelGraphResults(input: {
  graph: ModelExecutionGraph;
  receipts: ModelGraphNodeReceipt[];
  outputByNodeId: ReadonlyMap<string, string>;
  completedAt?: string;
}): ModelGraphArbitrationReceipt {
  const verified = new Map(input.receipts
    .filter(receipt => (
      receipt.graphId === input.graph.graphId
      && receipt.taskId === input.graph.taskId
      && receipt.status === 'succeeded'
      && receipt.verified === true
    ))
    .map(receipt => [receipt.nodeId, receipt]));
  const consideredNodeIds = input.graph.nodes.map(node => node.nodeId);
  let selectedNodeIds: string[] = [];
  let reason = '';
  if (input.graph.arbitration === 'first_verified') {
    const selected = consideredNodeIds.find(nodeId => verified.has(nodeId) && input.outputByNodeId.has(nodeId));
    if (selected) selectedNodeIds = [selected];
    else reason = 'no verified node result was available';
  } else if (input.graph.arbitration === 'majority_vote') {
    const votes = new Map<string, string[]>();
    for (const nodeId of consideredNodeIds) {
      if (!verified.has(nodeId) || !input.outputByNodeId.has(nodeId)) continue;
      const normalizedOutput = String(input.outputByNodeId.get(nodeId) || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const key = modelGraphDigest(normalizedOutput);
      const voters = votes.get(key) || [];
      voters.push(nodeId);
      votes.set(key, voters);
    }
    const ranked = [...votes.values()].sort((left, right) => (
      right.length - left.length
      || consideredNodeIds.indexOf(left[0]) - consideredNodeIds.indexOf(right[0])
    ));
    const verifiedCount = consideredNodeIds.filter(nodeId => verified.has(nodeId)).length;
    if (ranked[0] && ranked[0].length > verifiedCount / 2) {
      selectedNodeIds = [ranked[0][0]];
    } else {
      reason = 'no strict majority of verified node outputs was available';
    }
  } else if (input.graph.arbitration === 'judge') {
    const judge = input.graph.nodes.find(node => node.type === 'judge');
    if (judge && verified.has(judge.nodeId) && input.outputByNodeId.has(judge.nodeId)) {
      selectedNodeIds = [judge.nodeId];
    } else {
      reason = 'the required judge node did not produce a verified result';
    }
  } else {
    selectedNodeIds = consideredNodeIds.filter(nodeId => (
      verified.has(nodeId) && input.outputByNodeId.has(nodeId)
    ));
    if (selectedNodeIds.length === 0) reason = 'no verified node result was available';
  }
  const selectedOutputs = selectedNodeIds.map(nodeId => input.outputByNodeId.get(nodeId) || '');
  return {
    graphId: input.graph.graphId,
    taskId: input.graph.taskId,
    policy: input.graph.arbitration,
    status: selectedNodeIds.length > 0 ? 'succeeded' : 'blocked',
    selectedNodeIds,
    consideredNodeIds,
    outputDigest: modelGraphDigest(selectedOutputs),
    completedAt: input.completedAt || new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };
}
