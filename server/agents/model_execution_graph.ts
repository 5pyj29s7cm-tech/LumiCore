import crypto from 'node:crypto';
import { isExtensionProviderId, isRegisteredProviderLocal } from '../extensions/registry';
import { redactDiagnosticSecrets } from '../client/diagnostic_sanitizer';
import { normalizeActionIntent } from '../cognition/normalized_action_intent';

export type ModelGraphNodeType =
  | 'model'
  | 'internal_agent'
  | 'external_agent'
  | 'judge'
  | 'join';

export type ModelGraphPrivacy = 'policy_scoped' | 'local_only';

export type ModelGraphNodeAcceptanceMode =
  | 'tool_terminal'
  | 'validated_model_output';

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
  /**
   * Bounded private execution hand-off retained so restart recovery can run
   * the exact compiled plan instead of asking a model to decompose it again.
   */
  taskDescription?: string;
  executionMode?: 'lumi' | 'scholar' | 'founder';
  /**
   * Explicitly identifies nodes that are semantically interchangeable for
   * first-result or voting arbitration. The identifier is an assertion made
   * by the compiler caller; it is never inferred from model prose.
   */
  equivalenceGroupId?: string;
  /** True only when abandoning or duplicating this node cannot mutate state. */
  sideEffectFree?: boolean;
  /**
   * Declares what can prove this node complete. The default remains
   * tool_terminal. validated_model_output is deliberately restricted to
   * bounded, side-effect-free analysis/writing nodes whose task text contains
   * no real-world action intent.
   */
  acceptanceMode?: ModelGraphNodeAcceptanceMode;
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
  /** SHA-256 binding to the canonical root task text, when supplied. */
  rootTaskDigest?: string;
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

/**
 * A model/runtime can produce a useful result without proving that the
 * requested real-world work completed. Only a verified terminal tool receipt
 * is currently accepted as machine evidence. External process exit codes and
 * model prose remain useful, but explicitly unverified.
 */
export type ModelGraphNodeEvidenceKind =
  | 'none'
  | 'reasoning_only'
  | 'external_runtime_unverified'
  | 'validated_model_output'
  | 'tool_terminal_verification';

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
  evidenceKind: ModelGraphNodeEvidenceKind;
  evidenceRefs: string[];
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
  /** Result availability is separate from machine-verifiable completion. */
  verification: 'verified' | 'unverified';
  selectedNodeIds: string[];
  verifiedNodeIds: string[];
  consideredNodeIds: string[];
  outputDigest: string;
  completedAt: string;
  reason?: string;
}

export interface CompileModelExecutionGraphInput {
  taskId?: string;
  /** User scope used to verify ownership/locality of extension providers. */
  userId?: string;
  /** The private root task text. Only its canonical digest is persisted. */
  rootTaskText?: string;
  /** Precomputed digest from modelGraphRootTaskDigest when text is unavailable. */
  rootTaskDigest?: string;
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

export function modelCandidateLocality(provider: string, userId?: string): ModelCandidate['locality'] {
  const normalized = String(provider || '').trim().toLowerCase();
  if (LOCAL_PROVIDERS.has(normalized)) return 'local';
  if (isExtensionProviderId(normalized) && isRegisteredProviderLocal(normalized, userId)) return 'local';
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

const MODEL_GRAPH_ROOT_TASK_DIGEST_DOMAIN = 'lumi:model-graph-root-task:v1\u0000';

function canonicalModelGraphRootTaskText(value: string): string {
  return String(value || '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/**
 * Produce the stable root-task binding used by durable execution graphs.
 * Internal whitespace is significant; only Unicode form, line endings, and
 * outer whitespace are canonicalized.
 */
export function modelGraphRootTaskDigest(rootTaskText: string): string {
  return crypto.createHash('sha256')
    .update(MODEL_GRAPH_ROOT_TASK_DIGEST_DOMAIN)
    .update(canonicalModelGraphRootTaskText(rootTaskText))
    .digest('hex');
}

/** Fail-closed helper for recovery callers validating a graph against a task. */
export function modelExecutionGraphMatchesRootTask(
  graph: Pick<ModelExecutionGraph, 'rootTaskDigest'>,
  rootTaskText: string,
): boolean {
  const actual = String(graph.rootTaskDigest || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(actual)
    && actual === modelGraphRootTaskDigest(rootTaskText);
}

export function modelGraphNodeFingerprint(node: ModelGraphNode): string {
  return modelGraphDigest({
    nodeId: node.nodeId,
    type: node.type,
    role: node.role,
    ...(node.taskDescription ? { taskDescription: node.taskDescription } : {}),
    ...(node.executionMode ? { executionMode: node.executionMode } : {}),
    ...(node.equivalenceGroupId ? { equivalenceGroupId: node.equivalenceGroupId } : {}),
    ...(node.sideEffectFree !== undefined ? { sideEffectFree: node.sideEffectFree } : {}),
    acceptanceMode: node.acceptanceMode || 'tool_terminal',
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

const MODEL_OUTPUT_SAFE_ROLES = new Set(['analysis', 'writing', 'reasoning']);
// i18n-allow -- bilingual action-intent recognition; this regular expression is not user-visible copy.
const MODEL_OUTPUT_ACTION_INTENT_RE = /\b(?:delete|remove|rename|move|copy|create\s+(?:a\s+)?(?:file|folder|directory|account|task)|write\s+(?:to|into|a\s+file)|save\s+(?:to|as|the\s+file)|edit\s+(?:a\s+)?(?:file|setting|configuration)|modify\s+(?:a\s+)?(?:file|setting|configuration)|patch|commit|push|merge|deploy|publish|send|post|upload|download|install|uninstall|execute\s+(?:a\s+)?(?:command|script|program)|run\s+(?:a\s+)?(?:command|script|program)|click|open\s+(?:the\s+)?(?:app|application|program|website|page)|change\s+(?:a\s+)?(?:setting|configuration)|purchase|pay|transfer|submit|sign|place\s+(?:an\s+)?order|cancel\s+(?:an\s+)?order|message|email|reply)\b|(?:删除|移除|重命名|移动|复制|新建(?:文件|目录|账号|任务)|创建(?:文件|目录|账号|任务)|写入|另存为|保存(?:文件|到)|编辑(?:文件|设置|配置)|修改(?:文件|设置|配置)|打补丁|提交|推送|合并|部署|发布|发送|回复|评论|上传|下载|安装|卸载|执行(?:命令|脚本|程序)|运行(?:命令|脚本|程序)|点击|打开(?:应用|程序|网页|页面)|更改(?:设置|配置)|支付|付款|转账|购买|下单|取消订单|签署)/iu;
// i18n-allow -- source-bound content recognition; not user-visible copy.
const MODEL_OUTPUT_SOURCE_BOUND_RE = /\b(?:supplied|provided|given|above|following|attached|context|text|material|trace|receipt|prior result|dependency output)\b|(?:给定|已提供|用户提供|上述|以下|附件|上下文|文本|材料|轨迹|回执|前序结果|依赖输出)/iu;
// i18n-allow -- live/external evidence requirement recognition; not user-visible copy.
const MODEL_OUTPUT_LIVE_EVIDENCE_RE = /\b(?:current|latest|today|live|online|website|web page|repository|codebase|filesystem|directory|running process|screen|window|device state)\b|(?:当前|最新|今天|实时|在线|网页|网站|仓库|代码库|文件系统|目录|运行进程|屏幕|窗口|设备状态)/iu;
// i18n-allow -- extra fail-closed mutations not consistently normalized by all legacy intent rules.
const MODEL_OUTPUT_ADDITIONAL_ACTION_INTENT_RE = /\b(?:schedule|book|reserve|approve|authorize|reject|turn\s+(?:on|off)|enable|disable|configure|set|update|restart|reboot|invite|call|dial|subscribe|unsubscribe|log\s*(?:in|out)|sign\s*(?:in|out))\b|(?:安排|排期|预约|预订|批准|审批|授权|拒绝|关闭|开启|关掉|打开|启用|禁用|设置|配置|更新|重启|邀请|拨打|订阅|退订|登录|登出|切换)/iu;
// i18n-allow -- completion claims are evidence-bearing assertions, not bounded prose deliverables.
const MODEL_OUTPUT_ACTION_COMPLETION_CLAIM_RE = /\b(?:i|we)\s+(?:have\s+)?(?:sent|posted|published|uploaded|downloaded|installed|uninstalled|deleted|removed|renamed|moved|copied|created|saved|edited|modified|patched|committed|pushed|merged|deployed|scheduled|booked|reserved|approved|authorized|rejected|enabled|disabled|configured|updated|restarted|invited|called|paid|transferred|submitted|signed|cancelled|canceled)\b|(?:已|已经|刚刚|成功)(?:发送|发布|上传|下载|安装|卸载|删除|移除|重命名|移动|复制|创建|保存|编辑|修改|提交|推送|合并|部署|安排|预约|预订|批准|审批|授权|拒绝|开启|关闭|启用|禁用|设置|配置|更新|重启|邀请|拨打|支付|转账|签署|取消)/iu;
// i18n-allow -- real-time assertions require an observation receipt and cannot self-validate as prose.
const MODEL_OUTPUT_LIVE_FACT_CLAIM_RE = /\b(?:currently|right\s+now|as\s+of\s+(?:today|now)|the\s+latest\s+(?:state|status|version|result)|(?:website|repository|filesystem|screen|window|device)\s+(?:currently\s+)?(?:shows|contains|has|is|reports))\b|(?:目前|当前|现在|截至今天|截至目前|最新(?:状态|结果|版本)|(?:网站|仓库|文件系统|屏幕|窗口|设备)(?:显示|包含|存在|处于))/iu;

function stringOutputSchemaBounds(schema: Record<string, unknown>): {
  valid: boolean;
  minLength: number;
  maxLength: number;
} {
  if (schema.type !== 'string') return { valid: false, minLength: 0, maxLength: 0 };
  const rawMin = Number(schema.minLength);
  const rawMax = schema.maxLength === undefined ? 24_000 : Number(schema.maxLength);
  const minLength = Number.isInteger(rawMin) ? rawMin : 0;
  const maxLength = Number.isInteger(rawMax) ? rawMax : 0;
  return {
    valid: minLength >= 1 && maxLength >= minLength && maxLength <= 100_000,
    minLength,
    maxLength,
  };
}

/**
 * Fail-closed eligibility gate for treating bounded model content itself as
 * completion evidence. This proves delivery against a declared string schema;
 * it never proves an external action, factual claim, or side effect occurred.
 */
export function canAcceptValidatedModelOutput(node: ModelGraphNode): boolean {
  const task = String(node.taskDescription || '').trim();
  const schema = stringOutputSchemaBounds(node.outputSchema);
  const role = String(node.role || '').trim().toLowerCase();
  const normalizedIntent = normalizeActionIntent(task);
  const normalizedIntentNeedsExecutionEvidence = normalizedIntent.kind !== 'none'
    && normalizedIntent.kind !== 'correction_explanation';
  const sourceBound = role === 'writing'
    || node.dependsOn.length > 0
    || MODEL_OUTPUT_SOURCE_BOUND_RE.test(task);
  return node.acceptanceMode === 'validated_model_output'
    && node.sideEffectFree === true
    && node.type !== 'external_agent'
    && MODEL_OUTPUT_SAFE_ROLES.has(role)
    && Boolean(task)
    && !MODEL_OUTPUT_ACTION_INTENT_RE.test(task)
    && !MODEL_OUTPUT_ADDITIONAL_ACTION_INTENT_RE.test(task)
    && !normalizedIntentNeedsExecutionEvidence
    && sourceBound
    && !MODEL_OUTPUT_LIVE_EVIDENCE_RE.test(task)
    && schema.valid;
}

export function validateModelGraphNodeOutput(node: ModelGraphNode, output: string): boolean {
  if (!canAcceptValidatedModelOutput(node)) return false;
  const value = String(output || '').trim();
  const { minLength, maxLength } = stringOutputSchemaBounds(node.outputSchema);
  return value.length >= minLength
    && value.length <= maxLength
    && !MODEL_OUTPUT_ACTION_COMPLETION_CLAIM_RE.test(value)
    && !MODEL_OUTPUT_LIVE_FACT_CLAIM_RE.test(value);
}

function summarizeModelNodeOutput(value: string): string {
  return redactDiagnosticSecrets(value)
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

function modelCandidateBelongsToNode(
  node: ModelGraphNode,
  selectedCandidate: ModelCandidate | null | undefined,
): selectedCandidate is ModelCandidate {
  if (!selectedCandidate) return false;
  return node.candidates.some(candidate => (
    candidate.provider === selectedCandidate.provider
    && candidate.model === selectedCandidate.model
    && (candidate.agentId || '') === (selectedCandidate.agentId || '')
    && candidate.locality === selectedCandidate.locality
  ));
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

function partialResultArbitrationErrors(
  nodes: ModelGraphNode[],
  arbitration: ModelExecutionGraph['arbitration'],
): string[] {
  if (arbitration !== 'first_verified' && arbitration !== 'majority_vote') return [];
  const errors: string[] = [];
  if (nodes.length < 2) {
    errors.push(`${arbitration} arbitration requires at least two equivalent candidate nodes`);
  }
  const groupIds = new Set<string>();
  for (const node of nodes) {
    const groupId = String(node.equivalenceGroupId || '').trim();
    if (!groupId) {
      errors.push(`node ${node.nodeId} must declare an equivalenceGroupId for ${arbitration} arbitration`);
    } else {
      groupIds.add(groupId);
    }
    if (node.sideEffectFree !== true) {
      errors.push(`node ${node.nodeId} must be explicitly sideEffectFree for ${arbitration} arbitration`);
    }
    if (node.dependsOn.length > 0) {
      errors.push(`node ${node.nodeId} cannot have dependencies under ${arbitration} arbitration`);
    }
  }
  if (groupIds.size > 1) {
    errors.push(`${arbitration} arbitration requires every node to share one equivalenceGroupId`);
  }
  return errors;
}

export function compileModelExecutionGraph(
  input: CompileModelExecutionGraphInput,
): ModelGraphCompilation {
  const budgets = normalizeBudgets(input.budgets);
  const privacyPolicy = input.privacyPolicy || 'policy_scoped';
  const arbitration = input.arbitration || 'aggregate_verified';
  const errors: string[] = [];
  const hasRootTaskText = input.rootTaskText !== undefined;
  const canonicalRootTaskText = hasRootTaskText
    ? canonicalModelGraphRootTaskText(String(input.rootTaskText || ''))
    : '';
  const suppliedRootTaskDigest = String(input.rootTaskDigest || '').trim().toLowerCase();
  if (hasRootTaskText && !canonicalRootTaskText) {
    errors.push('rootTaskText must be non-empty when supplied');
  }
  if (input.rootTaskDigest !== undefined && !/^[a-f0-9]{64}$/.test(suppliedRootTaskDigest)) {
    errors.push('rootTaskDigest must be a lowercase or uppercase SHA-256 hex digest');
  }
  const computedRootTaskDigest = canonicalRootTaskText
    ? modelGraphRootTaskDigest(canonicalRootTaskText)
    : '';
  if (
    computedRootTaskDigest
    && suppliedRootTaskDigest
    && computedRootTaskDigest !== suppliedRootTaskDigest
  ) {
    errors.push('rootTaskDigest does not match rootTaskText');
  }
  const rootTaskDigest = computedRootTaskDigest
    || (/^[a-f0-9]{64}$/.test(suppliedRootTaskDigest) ? suppliedRootTaskDigest : '');
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
    if (node.candidates.some(candidate => (
      candidate.locality !== modelCandidateLocality(candidate.provider, input.userId)
    ))) {
      errors.push(`node ${node.nodeId} has candidate locality not backed by the provider registry/configuration`);
    }
    if (privacyPolicy === 'local_only' && node.candidates.some(candidate => (
      modelCandidateLocality(candidate.provider, input.userId) !== 'local'
    ))) {
      errors.push(`node ${node.nodeId} violates local-only data routing`);
    }
    if (privacyPolicy === 'local_only' && node.type === 'external_agent') {
      errors.push(`node ${node.nodeId} cannot use an external agent in local-only mode`);
    }
    if (/^(?:reflection|reflect|critique)$/i.test(node.role) && node.dependsOn.length === 0) {
      errors.push(`reflection node ${node.nodeId} requires at least one dependency to review`);
    }
    if (node.acceptanceMode === 'validated_model_output' && !canAcceptValidatedModelOutput(node)) {
      errors.push(`node ${node.nodeId} is not eligible for validated model-output acceptance`);
    }
    if (node.acceptanceMode && !['tool_terminal', 'validated_model_output'].includes(node.acceptanceMode)) {
      errors.push(`node ${node.nodeId} has an unsupported acceptance mode`);
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
  if (arbitration === 'judge') {
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
  errors.push(...partialResultArbitrationErrors(input.nodes, arbitration));
  const sorted = topologicalWaves(input.nodes);
  errors.push(...sorted.errors);
  if (sorted.waves.some(wave => wave.length > budgets.maxParallel)) {
    errors.push(`graph parallel width exceeds budget ${budgets.maxParallel}`);
  }

  const taskId = String(input.taskId || '').trim()
    || `task_${modelGraphDigest(input.nodes).slice(0, 24)}`;
  const graphId = `graph_${modelGraphDigest({
    taskId,
    ...(rootTaskDigest ? { rootTaskDigest } : {}),
    nodes: input.nodes,
    budgets,
    privacyPolicy,
    arbitration,
  }).slice(0, 24)}`;
  const graph: ModelExecutionGraph = {
    schemaVersion: 1,
    graphId,
    taskId,
    ...(rootTaskDigest ? { rootTaskDigest } : {}),
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
  evidenceKind?: ModelGraphNodeEvidenceKind;
  evidenceRefs?: string[];
}): ModelGraphNodeReceipt {
  const completedAt = input.completedAt || new Date().toISOString();
  const requestedCandidate = input.selectedCandidate || input.node.candidates[0];
  const selectedCandidateAllowed = modelCandidateBelongsToNode(input.node, requestedCandidate);
  const effectiveStatus: ModelGraphNodeStatus = input.selectedCandidate && !selectedCandidateAllowed
    ? 'blocked'
    : input.status;
  const selectedCandidate = effectiveStatus === 'blocked' || effectiveStatus === 'cancelled'
    ? undefined
    : requestedCandidate && selectedCandidateAllowed
      ? { ...requestedCandidate }
      : undefined;
  const requestedEvidenceRefs = Array.from(new Set((input.evidenceRefs || [])
    .map(value => String(value || '').trim())
    .filter(value => /^tool:[A-Za-z0-9._:-]{1,240}$/.test(value))))
    .slice(0, 80);
  const hasVerifiedToolEvidence = effectiveStatus === 'succeeded'
    && selectedCandidateAllowed
    && input.evidenceKind === 'tool_terminal_verification'
    && requestedEvidenceRefs.length > 0;
  const outputDigest = modelGraphDigest(input.output || '');
  const hasValidatedModelOutput = effectiveStatus === 'succeeded'
    && selectedCandidateAllowed
    && input.evidenceKind === 'validated_model_output'
    && validateModelGraphNodeOutput(input.node, input.output || '');
  const evidenceKind: ModelGraphNodeEvidenceKind = hasVerifiedToolEvidence
    ? 'tool_terminal_verification'
    : hasValidatedModelOutput
      ? 'validated_model_output'
    : effectiveStatus !== 'succeeded'
      ? 'none'
      : input.evidenceKind === 'external_runtime_unverified'
        || input.node.type === 'external_agent'
        || selectedCandidate?.locality === 'external_runtime'
        ? 'external_runtime_unverified'
        : 'reasoning_only';
  return {
    graphId: input.graph.graphId,
    taskId: input.graph.taskId,
    nodeId: input.node.nodeId,
    status: effectiveStatus,
    selectedCandidate,
    agentId: input.agentId || input.node.assignedAgentId,
    dependencyReceiptIds: input.node.dependsOn.map(dependency => `${input.graph.graphId}:${dependency}`),
    startedAt: input.startedAt,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(input.startedAt)),
    nodeFingerprint: modelGraphNodeFingerprint(input.node),
    outputDigest,
    ...(input.output ? { outputSummary: summarizeModelNodeOutput(input.output) } : {}),
    evidenceKind,
    evidenceRefs: hasVerifiedToolEvidence
      ? requestedEvidenceRefs
      : hasValidatedModelOutput
        ? [`model_output:${outputDigest}`]
        : [],
    verified: hasVerifiedToolEvidence || hasValidatedModelOutput,
    ...(input.node.estimatedInputTokens !== undefined
      ? { estimatedInputTokens: input.node.estimatedInputTokens }
      : {}),
    ...(estimatedNodeCost(input.node) > 0
      ? { estimatedCostUsd: Number(estimatedNodeCost(input.node).toFixed(6)) }
      : {}),
    ...(input.selectedCandidate && !selectedCandidateAllowed
      ? { error: 'selected model candidate is outside the compiled node candidate set' }
      : input.error
        ? { error: input.error.slice(0, 700) }
        : {}),
  };
}

export function hasVerifiedModelGraphNodeEvidence(
  receipt: ModelGraphNodeReceipt | null | undefined,
): receipt is ModelGraphNodeReceipt {
  return Boolean(
    receipt
    && receipt.status === 'succeeded'
    && receipt.verified === true
    && (receipt.evidenceKind === 'tool_terminal_verification'
      || receipt.evidenceKind === 'validated_model_output')
    && Array.isArray(receipt.evidenceRefs)
    && receipt.evidenceRefs.length > 0
    && (receipt.evidenceKind === 'tool_terminal_verification'
      ? receipt.evidenceRefs.every(value => /^tool:[A-Za-z0-9._:-]{1,240}$/.test(value))
      : receipt.evidenceRefs.length === 1
        && receipt.evidenceRefs[0] === `model_output:${receipt.outputDigest}`
        && /^model_output:[a-f0-9]{64}$/.test(receipt.evidenceRefs[0])),
  );
}

export function reuseVerifiedModelGraphNodeReceipt(input: {
  graph: ModelExecutionGraph;
  node: ModelGraphNode;
  prior: ModelGraphNodeReceipt;
  recoveredAt?: string;
}): ModelGraphNodeReceipt | null {
  if (
    input.prior.graphId !== input.graph.graphId
    || input.prior.taskId !== input.graph.taskId
    || input.prior.nodeId !== input.node.nodeId
    || input.prior.nodeFingerprint !== modelGraphNodeFingerprint(input.node)
    || !modelCandidateBelongsToNode(input.node, input.prior.selectedCandidate)
    || !hasVerifiedModelGraphNodeEvidence(input.prior)
  ) {
    return null;
  }
  const recoveredAt = input.recoveredAt || new Date().toISOString();
  return {
    ...input.prior,
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
  const graphNodes = new Map(input.graph.nodes.map(node => [node.nodeId, node]));
  const consideredNodeIds = input.graph.nodes.map(node => node.nodeId);
  const arbitrationErrors = compileModelExecutionGraph({
    taskId: input.graph.taskId,
    ...(input.graph.rootTaskDigest !== undefined
      ? { rootTaskDigest: input.graph.rootTaskDigest }
      : {}),
    nodes: input.graph.nodes,
    budgets: input.graph.budgets,
    privacyPolicy: input.graph.privacyPolicy,
    arbitration: input.graph.arbitration,
  }).errors;
  if (arbitrationErrors.length > 0) {
    return {
      graphId: input.graph.graphId,
      taskId: input.graph.taskId,
      policy: input.graph.arbitration,
      status: 'blocked',
      verification: 'unverified',
      selectedNodeIds: [],
      verifiedNodeIds: [],
      consideredNodeIds,
      outputDigest: modelGraphDigest([]),
      completedAt: input.completedAt || new Date().toISOString(),
      reason: `execution graph is not eligible for arbitration: ${arbitrationErrors.join('; ')}`,
    };
  }
  const matchesCurrentGraphNode = (receipt: ModelGraphNodeReceipt): boolean => {
    const node = graphNodes.get(receipt.nodeId);
    return Boolean(
      node
      && receipt.nodeFingerprint === modelGraphNodeFingerprint(node)
      && modelCandidateBelongsToNode(node, receipt.selectedCandidate),
    );
  };
  const successful = new Map(input.receipts
    .filter(receipt => (
      receipt.graphId === input.graph.graphId
      && receipt.taskId === input.graph.taskId
      && receipt.status === 'succeeded'
      && matchesCurrentGraphNode(receipt)
    ))
    .map(receipt => [receipt.nodeId, receipt]));
  const verified = new Map(input.receipts
    .filter(receipt => (
      receipt.graphId === input.graph.graphId
      && receipt.taskId === input.graph.taskId
      && hasVerifiedModelGraphNodeEvidence(receipt)
      && matchesCurrentGraphNode(receipt)
    ))
    .map(receipt => [receipt.nodeId, receipt]));
  let selectedNodeIds: string[] = [];
  let verifiedNodeIds: string[] = [];
  let verification: ModelGraphArbitrationReceipt['verification'] = 'unverified';
  let reason = '';
  if (input.graph.arbitration === 'first_verified') {
    const selectedVerified = consideredNodeIds.find(nodeId => (
      verified.has(nodeId) && input.outputByNodeId.has(nodeId)
    ));
    const selectedUseful = selectedVerified || consideredNodeIds.find(nodeId => (
      successful.has(nodeId) && input.outputByNodeId.has(nodeId)
    ));
    if (selectedUseful) {
      selectedNodeIds = [selectedUseful];
      verification = selectedVerified ? 'verified' : 'unverified';
      verifiedNodeIds = selectedVerified ? [selectedVerified] : [];
    } else {
      reason = 'no successful node result was available';
    }
  } else if (input.graph.arbitration === 'majority_vote') {
    const votes = new Map<string, string[]>();
    for (const nodeId of consideredNodeIds) {
      if (!successful.has(nodeId) || !input.outputByNodeId.has(nodeId)) continue;
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
    const winningVoters = ranked[0] && ranked[0].length > consideredNodeIds.length / 2
      ? ranked[0]
      : [];
    if (winningVoters.length > 0) {
      selectedNodeIds = [winningVoters[0]];
      verification = winningVoters.every(nodeId => verified.has(nodeId))
        ? 'verified'
        : 'unverified';
      verifiedNodeIds = winningVoters.filter(nodeId => verified.has(nodeId));
    } else {
      reason = 'no strict majority of successful node outputs was available';
    }
  } else if (input.graph.arbitration === 'judge') {
    const judge = input.graph.nodes.find(node => node.type === 'judge');
    if (judge && successful.has(judge.nodeId) && input.outputByNodeId.has(judge.nodeId)) {
      selectedNodeIds = [judge.nodeId];
      const judgeEvidenceNodeIds = [judge.nodeId, ...judge.dependsOn];
      verification = judgeEvidenceNodeIds.every(nodeId => verified.has(nodeId))
        ? 'verified'
        : 'unverified';
      verifiedNodeIds = judgeEvidenceNodeIds.filter(nodeId => verified.has(nodeId));
    } else {
      reason = 'the required judge node did not produce a successful result';
    }
  } else {
    const incompleteNodeIds = consideredNodeIds.filter(nodeId => (
      !successful.has(nodeId) || !input.outputByNodeId.has(nodeId)
    ));
    if (consideredNodeIds.length > 0 && incompleteNodeIds.length === 0) {
      selectedNodeIds = [...consideredNodeIds];
      verification = selectedNodeIds.every(nodeId => verified.has(nodeId))
        ? 'verified'
        : 'unverified';
      verifiedNodeIds = selectedNodeIds.filter(nodeId => verified.has(nodeId));
    } else {
      reason = incompleteNodeIds.length > 0
        ? `required graph nodes did not complete successfully: ${incompleteNodeIds.join(', ')}`
        : 'no successful node result was available';
    }
  }
  if (selectedNodeIds.length > 0 && verification === 'unverified') {
    reason = 'Useful reasoning/runtime output was selected, but it has no verified terminal machine evidence.';
  }
  const selectedOutputs = selectedNodeIds.map(nodeId => input.outputByNodeId.get(nodeId) || '');
  return {
    graphId: input.graph.graphId,
    taskId: input.graph.taskId,
    policy: input.graph.arbitration,
    status: selectedNodeIds.length > 0 ? 'succeeded' : 'blocked',
    verification,
    selectedNodeIds,
    verifiedNodeIds,
    consideredNodeIds,
    outputDigest: modelGraphDigest(selectedOutputs),
    completedAt: input.completedAt || new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };
}
