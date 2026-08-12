import { createHash, randomUUID } from 'node:crypto';
import { readDB, writeDB } from '../../db_layer';
import { runWithVision } from '../llm/adapter';
import {
  DEFAULT_MODELS,
  getUserPreferredLLM,
  type UserLLMProvider,
} from '../llm/user_preferences';
import type { ToolContext } from '../tools/types';
import type { CapabilityManifestEntry } from '../tools/types';
import {
  desktopAiAsk,
  desktopAiCollectAnswer,
  isDesktopAiTargetRegistered,
} from '../tools/definitions/desktop_ai_tools';
import { executeExternalAgent, validateExternalCommand } from './external_runtime';

export type ExternalAiRouteKind = 'api' | 'mcp' | 'cli' | 'structured_browser' | 'desktop_visual';
export type ExternalAiDispatchStatus =
  | 'planned'
  | 'submitting'
  | 'submitted'
  | 'pending'
  | 'answered'
  | 'blocked'
  | 'failed'
  | 'unknown';
export type ExternalAiSessionStatus = 'active' | 'waiting' | 'answered' | 'partial' | 'blocked' | 'failed';

export interface ExternalAiSourceEvidence {
  routeKind: ExternalAiRouteKind;
  targetId: string;
  provider?: string;
  model?: string;
  toolName?: string;
  externalSessionId?: string;
  externalMessageId?: string;
  responseDigest?: string;
  observedAt: string;
  limitations: string[];
}

export interface ExternalAiCollaborationSession {
  id: string;
  userId: string;
  taskId: string;
  conversationId: string;
  domain: 'personal' | 'work';
  orgId: string;
  question: string;
  questionDigest: string;
  targetIds: string[];
  status: ExternalAiSessionStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ExternalAiDispatch {
  id: string;
  sessionId: string;
  userId: string;
  targetId: string;
  targetLabel: string;
  status: ExternalAiDispatchStatus;
  routeKind: ExternalAiRouteKind;
  idempotencyKey: string;
  routeAttempts: Array<{ routeKind: ExternalAiRouteKind; available: boolean; reason: string }>;
  sourceEvidence: ExternalAiSourceEvidence;
  collectorToolName?: string;
  externalSessionId?: string;
  externalMessageId?: string;
  answerId?: string;
  answerDigest?: string;
  blocker?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  completedAt?: string;
}

export interface ExternalAiAnswerArchive {
  id: string;
  sessionId: string;
  dispatchId: string;
  userId: string;
  targetId: string;
  targetLabel: string;
  answerText: string;
  answerDigest: string;
  sourceEvidence: ExternalAiSourceEvidence;
  late: boolean;
  receivedAt: string;
}

interface PlannedRoute {
  routeKind: ExternalAiRouteKind;
  targetId: string;
  targetLabel: string;
  provider?: Exclude<UserLLMProvider, 'auto'>;
  model?: string;
  toolName?: string;
  collectorToolName?: string;
  externalCommand?: string;
  routeAttempts: ExternalAiDispatch['routeAttempts'];
}

interface RouteExecutionResult {
  status: Exclude<ExternalAiDispatchStatus, 'planned' | 'submitting'>;
  answerText?: string;
  externalSessionId?: string;
  externalMessageId?: string;
  blocker?: string;
  error?: string;
  evidence: ExternalAiSourceEvidence;
}

type ApiExecutor = (input: {
  targetId: string;
  provider: Exclude<UserLLMProvider, 'auto'>;
  model: string;
  question: string;
  context?: ToolContext;
}) => Promise<string>;

type CliExecutor = typeof executeExternalAgent;

interface ExternalAiRuntimeOverrides {
  api?: ApiExecutor;
  cli?: CliExecutor;
}

const ROUTE_PRIORITY: ExternalAiRouteKind[] = ['api', 'mcp', 'cli', 'structured_browser', 'desktop_visual'];
const dispatchExecutions = new Map<string, Promise<ExternalAiDispatch>>();
let runtimeOverrides: ExternalAiRuntimeOverrides | null = null;

const TARGET_ALIASES: Record<string, { label: string; aliases: string[] }> = {
  chatgpt: { label: 'ChatGPT', aliases: ['openai', 'gpt'] },
  claude: { label: 'Claude', aliases: ['anthropic'] },
  gemini: { label: 'Gemini', aliases: ['google'] },
  deepseek: { label: 'DeepSeek', aliases: ['deep seek'] },
  kimi: { label: 'Kimi', aliases: ['moonshot'] },
  tongyi: { label: 'Tongyi Qwen', aliases: ['qwen', 'tongyi'] },
  doubao: { label: 'Doubao', aliases: ['ark', 'volcengine'] },
  ollama: { label: 'Ollama', aliases: [] },
  lmstudio: { label: 'LM Studio', aliases: ['lm studio'] },
  codex: { label: 'Codex', aliases: ['openai codex'] },
  workbuddy: { label: 'WorkBuddy', aliases: ['work buddy'] },
  cursor: { label: 'Cursor', aliases: [] },
  copilot: { label: 'GitHub Copilot', aliases: ['github copilot'] },
};

const API_PROVIDER_BY_TARGET: Partial<Record<string, Exclude<UserLLMProvider, 'auto'>>> = {
  chatgpt: 'openai',
  claude: 'anthropic',
  gemini: 'gemini',
  deepseek: 'deepseek',
  kimi: 'kimi',
  tongyi: 'qwen',
  doubao: 'ark',
  ollama: 'ollama',
  lmstudio: 'lmstudio',
};

function nowIso(): string {
  return new Date().toISOString();
}

function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function normalizeTargetId(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function targetIdentity(value: unknown): { id: string; label: string; aliases: string[] } {
  const requestedId = normalizeTargetId(value);
  const id = Object.entries(TARGET_ALIASES).find(([candidateId, candidate]) => (
    candidateId === requestedId
    || candidate.aliases.some(alias => normalizeTargetId(alias) === requestedId)
  ))?.[0] || requestedId;
  const known = TARGET_ALIASES[id];
  return {
    id,
    label: known?.label || String(value || id).trim() || id,
    aliases: known?.aliases || [],
  };
}

function arrays(db: any): {
  sessions: ExternalAiCollaborationSession[];
  dispatches: ExternalAiDispatch[];
  answers: ExternalAiAnswerArchive[];
} {
  if (!Array.isArray(db.externalAiSessions)) db.externalAiSessions = [];
  if (!Array.isArray(db.externalAiDispatches)) db.externalAiDispatches = [];
  if (!Array.isArray(db.externalAiAnswers)) db.externalAiAnswers = [];
  return {
    sessions: db.externalAiSessions,
    dispatches: db.externalAiDispatches,
    answers: db.externalAiAnswers,
  };
}

function updateSessionStatus(db: any, sessionId: string): ExternalAiCollaborationSession | null {
  const { sessions, dispatches } = arrays(db);
  const session = sessions.find(item => item.id === sessionId);
  if (!session) return null;
  const scoped = dispatches.filter(item => item.sessionId === sessionId);
  const answered = scoped.filter(item => item.status === 'answered').length;
  const waiting = scoped.filter(item => ['planned', 'submitting', 'submitted', 'pending', 'unknown'].includes(item.status)).length;
  const blocked = scoped.filter(item => item.status === 'blocked').length;
  const failed = scoped.filter(item => item.status === 'failed').length;
  session.status = scoped.length > 0 && answered === scoped.length
    ? 'answered'
    : answered > 0
      ? (waiting > 0 ? 'waiting' : 'partial')
      : waiting > 0
        ? 'waiting'
        : blocked === scoped.length && scoped.length > 0
          ? 'blocked'
          : failed > 0 ? 'failed' : 'active';
  session.updatedAt = nowIso();
  if (waiting === 0 && scoped.length > 0) session.completedAt = session.updatedAt;
  else delete session.completedAt;
  return session;
}

function persistSession(session: ExternalAiCollaborationSession): void {
  const db = readDB();
  const { sessions } = arrays(db);
  const index = sessions.findIndex(item => item.id === session.id);
  if (index >= 0) sessions[index] = session;
  else sessions.push(session);
  writeDB(db);
}

function persistDispatch(dispatch: ExternalAiDispatch): ExternalAiDispatch {
  const db = readDB();
  const { dispatches } = arrays(db);
  const index = dispatches.findIndex(item => item.id === dispatch.id);
  if (index >= 0) dispatches[index] = dispatch;
  else dispatches.push(dispatch);
  updateSessionStatus(db, dispatch.sessionId);
  writeDB(db);
  return dispatch;
}

export function configureExternalAiCollaborationRuntimeForTests(
  overrides: ExternalAiRuntimeOverrides | null,
): void {
  runtimeOverrides = overrides;
}

export function resetExternalAiCollaborationForTests(options: { clearPersisted?: boolean } = {}): void {
  dispatchExecutions.clear();
  runtimeOverrides = null;
  if (!options.clearPersisted) return;
  const db = readDB();
  db.externalAiSessions = [];
  db.externalAiDispatches = [];
  db.externalAiAnswers = [];
  writeDB(db);
}

function deterministicSessionId(input: {
  userId: string;
  taskId: string;
  conversationId: string;
  questionDigest: string;
  targetIds: string[];
}): string {
  return `external-ai-${digest({ ...input, targetIds: [...input.targetIds].sort() }).slice(0, 28)}`;
}

function createOrLoadSession(
  question: string,
  targetIds: string[],
  args: Record<string, any>,
  context?: ToolContext,
): ExternalAiCollaborationSession {
  const userId = String(context?.userId || 'anonymous');
  const taskId = String(context?.taskId || context?.requestId || context?.turnId || `external-ai-task-${digest(question).slice(0, 16)}`);
  const conversationId = String(context?.conversationId || '');
  const questionDigest = digest(question);
  const requestedId = String(args.sessionId || '').trim();
  const id = requestedId || deterministicSessionId({ userId, taskId, conversationId, questionDigest, targetIds });
  const db = readDB();
  const { sessions } = arrays(db);
  const existing = sessions.find(session => session.id === id);
  if (existing) {
    if (
      existing.userId !== userId
      || existing.taskId !== taskId
      || existing.conversationId !== conversationId
      || existing.domain !== (context?.domain === 'work' ? 'work' : 'personal')
      || existing.orgId !== (context?.domain === 'work' ? String(context?.orgId || '') : '')
      || existing.questionDigest !== questionDigest
      || JSON.stringify([...existing.targetIds].sort()) !== JSON.stringify([...targetIds].sort())
    ) {
      throw new Error('External AI session target mismatch: the session is bound to another user, task, question, or target set.');
    }
    return existing;
  }
  const createdAt = nowIso();
  const session: ExternalAiCollaborationSession = {
    id,
    userId,
    taskId,
    conversationId,
    domain: context?.domain === 'work' ? 'work' : 'personal',
    orgId: context?.domain === 'work' ? String(context?.orgId || '') : '',
    question,
    questionDigest,
    targetIds,
    status: 'active',
    createdAt,
    updatedAt: createdAt,
  };
  persistSession(session);
  return session;
}

function providerGetterAvailable(provider: Exclude<UserLLMProvider, 'auto'>, context?: ToolContext): boolean {
  if (runtimeOverrides?.api) return true;
  const getters = context?.llmGetters;
  if (!getters) return false;
  const getter = ({
    deepseek: getters.getDeepSeek,
    gemini: getters.getGemini,
    openai: getters.getOpenAI,
    anthropic: getters.getAnthropic,
    qwen: getters.getQwen,
    ark: getters.getArk,
    ollama: getters.getOllama,
    lmstudio: getters.getLmStudio,
    xiaomi: getters.getXiaomi,
    kimi: getters.getKimi,
    glm: getters.getGlm,
    relay: getters.getRelay,
  } as Partial<Record<Exclude<UserLLMProvider, 'auto'>, (() => any) | undefined>>)[provider];
  if (!getter) return false;
  try { return Boolean(getter()); } catch { return false; }
}

function targetHaystack(target: ReturnType<typeof targetIdentity>): string[] {
  return [target.id, target.label, ...target.aliases].map(value => value.toLowerCase()).filter(value => value.length >= 3);
}

function adapterMatchesTarget(entry: CapabilityManifestEntry, target: ReturnType<typeof targetIdentity>): boolean {
  const haystack = [
    entry.toolName,
    entry.capabilityId,
    entry.family,
    entry.provider || '',
    entry.description,
    ...entry.domains,
    ...entry.routingTerms,
  ].join(' ').toLowerCase();
  return targetHaystack(target).some(term => haystack.includes(term));
}

function promptParameter(entry: CapabilityManifestEntry): string | null {
  return ['question', 'prompt', 'message', 'task', 'input'].find(name => entry.parameterNames.includes(name)) || null;
}

function findAdapter(
  target: ReturnType<typeof targetIdentity>,
  context: ToolContext | undefined,
  routeKind: 'mcp' | 'structured_browser',
): { toolName: string; collectorToolName?: string } | null {
  const registry = context?.toolRegistry;
  if (!registry) return null;
  const entries = registry.getCapabilityManifest(context?.toolPolicy, { executableOnly: true });
  const candidates = entries.filter(entry => {
    if (/^external_ai_(?:collaborate|collect_answers|session_status|route_plan)$/i.test(entry.toolName)) return false;
    if (!promptParameter(entry) || !adapterMatchesTarget(entry, target)) return false;
    if (entry.operation !== 'communicate') return false;
    if (!entry.sideEffects.some(effect => effect.type === 'external_communication')) return false;
    if (entry.sideEffects.some(effect => [
      'installation',
      'process_execution',
      'local_write',
      'local_state_change',
      'external_state_change',
    ].includes(effect.type))) return false;
    if (routeKind === 'mcp') return entry.source === 'mcp';
    return entry.source === 'adapter'
      && /browser|playwright|dom/i.test(`${entry.family} ${entry.provider || ''} ${entry.routingTerms.join(' ')}`);
  });
  const selected = candidates.sort((left, right) => left.toolName.localeCompare(right.toolName))[0];
  if (!selected) return null;
  const collector = entries.find(entry => (
    entry.toolName !== selected.toolName
    && entry.source === selected.source
    && entry.provider === selected.provider
    && adapterMatchesTarget(entry, target)
    && /(?:collect|answer|result|status)/i.test(entry.toolName)
    && entry.operation === 'observe'
  ));
  return { toolName: selected.toolName, collectorToolName: collector?.toolName };
}

function findCliAgent(target: ReturnType<typeof targetIdentity>, context?: ToolContext): any | null {
  const db = readDB();
  const terms = targetHaystack(target);
  return (db.agents || []).find((agent: any) => {
    if (agent.runtime !== 'external' || !String(agent.externalCommand || '').trim()) return false;
    if (validateExternalCommand(String(agent.externalCommand || ''))) return false;
    if (agent.status && agent.status !== 'active') return false;
    if (agent.healthStatus && agent.healthStatus !== 'online') return false;
    const owner = String(agent.ownerUid || agent.userId || '');
    if (owner && owner !== String(context?.userId || 'anonymous')) return false;
    const haystack = [agent.id, agent.name, agent.category, ...(agent.skillTags || [])].join(' ').toLowerCase();
    return terms.some(term => haystack.includes(term));
  }) || null;
}

export function planExternalAiRoute(
  targetValue: string,
  context?: ToolContext,
): PlannedRoute | null {
  const target = targetIdentity(targetValue);
  const attempts: ExternalAiDispatch['routeAttempts'] = [];
  const provider = API_PROVIDER_BY_TARGET[target.id];
  if (provider && providerGetterAvailable(provider, context)) {
    const prefs = getUserPreferredLLM(context?.userId || 'anonymous');
    const model = prefs.models[provider] || DEFAULT_MODELS[provider];
    attempts.push({ routeKind: 'api', available: true, reason: `configured_${provider}_api` });
    return { routeKind: 'api', targetId: target.id, targetLabel: target.label, provider, model, routeAttempts: attempts };
  }
  attempts.push({ routeKind: 'api', available: false, reason: provider ? `provider_${provider}_unavailable` : 'no_target_api_mapping' });

  const mcp = findAdapter(target, context, 'mcp');
  if (mcp) {
    attempts.push({ routeKind: 'mcp', available: true, reason: `adapter_${mcp.toolName}` });
    return { routeKind: 'mcp', targetId: target.id, targetLabel: target.label, ...mcp, routeAttempts: attempts };
  }
  attempts.push({ routeKind: 'mcp', available: false, reason: 'no_matching_mcp_adapter' });

  const cli = findCliAgent(target, context);
  if (cli) {
    attempts.push({ routeKind: 'cli', available: true, reason: `agent_${cli.id}` });
    return {
      routeKind: 'cli',
      targetId: target.id,
      targetLabel: target.label,
      externalCommand: String(cli.externalCommand),
      routeAttempts: attempts,
    };
  }
  attempts.push({ routeKind: 'cli', available: false, reason: 'no_healthy_matching_cli_agent' });

  const structured = findAdapter(target, context, 'structured_browser');
  if (structured) {
    attempts.push({ routeKind: 'structured_browser', available: true, reason: `adapter_${structured.toolName}` });
    return {
      routeKind: 'structured_browser',
      targetId: target.id,
      targetLabel: target.label,
      ...structured,
      routeAttempts: attempts,
    };
  }
  attempts.push({ routeKind: 'structured_browser', available: false, reason: 'no_matching_structured_browser_adapter' });

  if (context?.desktopRelay && isDesktopAiTargetRegistered(target.id, context?.userId || 'anonymous')) {
    attempts.push({ routeKind: 'desktop_visual', available: true, reason: 'desktop_relay_available' });
    return { routeKind: 'desktop_visual', targetId: target.id, targetLabel: target.label, routeAttempts: attempts };
  }
  attempts.push({ routeKind: 'desktop_visual', available: false, reason: 'desktop_relay_unavailable' });
  return null;
}

async function defaultApiExecutor(input: Parameters<ApiExecutor>[0]): Promise<string> {
  const getters = input.context?.llmGetters;
  if (!getters) throw new Error(`No LLM getters are available for ${input.provider}.`);
  return runWithVision(
    [
      {
        role: 'system',
        content: 'You are an independent external AI collaborator. Answer the task directly. State uncertainty and do not claim access to tools or files that were not provided.',
      },
      { role: 'user', content: input.question },
    ],
    {
      provider: input.provider,
      model: input.model,
      maxTokens: 2400,
      userId: input.context?.userId,
      domain: input.context?.domain,
      orgId: input.context?.orgId,
      requestId: input.context?.requestId,
      interactionId: input.context?.turnId,
      source: 'external_ai_collaboration',
      selectionMode: 'pinned',
      allowCloudFallback: false,
      signal: input.context?.isCancelled?.() ? AbortSignal.abort() : undefined,
    },
    getters.getDeepSeek,
    getters.getGemini,
    getters.getOpenAI,
    getters.getAnthropic,
    getters.getQwen,
    getters.getOllama,
    getters.getLmStudio,
    getters.getArk,
    getters.getXiaomi,
    getters.getKimi,
    getters.getGlm,
    getters.getRelay,
  );
}

function parseAdapterResult(raw: string, route: PlannedRoute): RouteExecutionResult {
  const observedAt = nowIso();
  let payload: any = null;
  try { payload = JSON.parse(raw || '{}'); } catch {}
  const answerText = String(
    payload?.answerText
    || payload?.answer
    || payload?.response
    || payload?.output
    || payload?.text
    || (!payload ? raw : ''),
  ).trim();
  const externalSessionId = String(payload?.sessionId || payload?.conversationId || '').trim() || undefined;
  const externalMessageId = String(payload?.messageId || payload?.requestId || payload?.submissionId || '').trim() || undefined;
  const status = String(payload?.status || '').toLowerCase();
  const evidence: ExternalAiSourceEvidence = {
    routeKind: route.routeKind,
    targetId: route.targetId,
    toolName: route.toolName,
    externalSessionId,
    externalMessageId,
    ...(answerText ? { responseDigest: digest(answerText) } : {}),
    observedAt,
    limitations: route.routeKind === 'structured_browser'
      ? ['Structured browser evidence covers the active authorized session and may omit content outside the adapter response.']
      : ['The adapter response is attributed to the selected target adapter; provider-side hidden state is not inferred.'],
  };
  if (answerText) return { status: 'answered', answerText, externalSessionId, externalMessageId, evidence };
  if (/pending|queued|submitted|running|accepted/.test(status) || externalMessageId) {
    return { status: status === 'submitted' ? 'submitted' : 'pending', externalSessionId, externalMessageId, evidence };
  }
  if (/blocked|login|captcha|verification/.test(status) || payload?.blocked === true) {
    return { status: 'blocked', blocker: String(payload?.reason || payload?.error || status || 'adapter_blocked'), evidence };
  }
  if (payload?.ok === false || payload?.success === false || payload?.error) {
    return { status: 'failed', error: String(payload?.error || payload?.reason || 'adapter_failed'), evidence };
  }
  return { status: 'unknown', error: 'Adapter returned no attributable answer or pending receipt.', evidence };
}

function buildAdapterArguments(
  toolName: string,
  question: string,
  session: ExternalAiCollaborationSession,
  dispatch: ExternalAiDispatch,
  context?: ToolContext,
): Record<string, any> {
  const definition = context?.toolRegistry?.get(toolName);
  const properties = definition?.parameters?.properties || definition?.parameters || {};
  const args: Record<string, any> = {};
  const promptName = ['question', 'prompt', 'message', 'task', 'input'].find(name => properties[name]);
  if (promptName) args[promptName] = question;
  if (properties.sessionId) args.sessionId = dispatch.externalSessionId || session.id;
  if (properties.conversationId) args.conversationId = dispatch.externalSessionId || session.id;
  if (properties.requestId && dispatch.externalMessageId) args.requestId = dispatch.externalMessageId;
  if (properties.messageId && dispatch.externalMessageId) args.messageId = dispatch.externalMessageId;
  if (properties.idempotencyKey) args.idempotencyKey = dispatch.idempotencyKey;
  if (properties.target) args.target = dispatch.targetId;
  return args;
}

async function executeRoute(
  route: PlannedRoute,
  session: ExternalAiCollaborationSession,
  dispatch: ExternalAiDispatch,
  context?: ToolContext,
): Promise<RouteExecutionResult> {
  if (route.routeKind === 'api' && route.provider && route.model) {
    const executor = runtimeOverrides?.api || defaultApiExecutor;
    const answerText = String(await executor({
      targetId: route.targetId,
      provider: route.provider,
      model: route.model,
      question: session.question,
      context,
    })).trim();
    if (!answerText) throw new Error('External AI API returned an empty answer.');
    return {
      status: 'answered',
      answerText,
      evidence: {
        routeKind: 'api',
        targetId: route.targetId,
        provider: route.provider,
        model: route.model,
        responseDigest: digest(answerText),
        observedAt: nowIso(),
        limitations: ['The response proves this API model answered the prompt; it is not the same as an existing consumer chat-session history.'],
      },
    };
  }

  if ((route.routeKind === 'mcp' || route.routeKind === 'structured_browser') && route.toolName) {
    const registry = context?.toolRegistry;
    if (!registry) throw new Error(`${route.routeKind} adapter registry is unavailable.`);
    const raw = await registry.execute(
      route.toolName,
      buildAdapterArguments(route.toolName, session.question, session, dispatch, context),
      {
        ...(context || {}),
        taskId: session.taskId,
        idempotencyKey: dispatch.idempotencyKey,
        userConfirmed: true,
      },
    );
    return parseAdapterResult(raw, route);
  }

  if (route.routeKind === 'cli' && route.externalCommand) {
    const executor = runtimeOverrides?.cli || executeExternalAgent;
    const result = await executor({ command: route.externalCommand, timeout: 120_000 }, session.question);
    const answerText = result.success ? String(result.output || '').trim() : '';
    const evidence: ExternalAiSourceEvidence = {
      routeKind: 'cli',
      targetId: route.targetId,
      ...(answerText ? { responseDigest: digest(answerText) } : {}),
      observedAt: nowIso(),
      limitations: ['CLI output is attributed to the configured local external-agent command and does not imply access to a consumer chat session.'],
    };
    if (answerText) return { status: 'answered', answerText, evidence };
    return {
      status: result.exitCode === null ? 'unknown' : 'failed',
      error: `External CLI exited with ${result.exitCode === null ? 'unknown outcome' : `code ${result.exitCode}`}.`,
      evidence,
    };
  }

  if (route.routeKind === 'desktop_visual') {
    const ask = JSON.parse(await desktopAiAsk({
      question: session.question,
      targets: [route.targetId],
      send: true,
      collectAfterMs: 0,
    }, context));
    const targetResult = (ask.results || []).find((item: any) => item.target === route.targetId) || ask.results?.[0];
    const evidence: ExternalAiSourceEvidence = {
      routeKind: 'desktop_visual',
      targetId: route.targetId,
      observedAt: nowIso(),
      limitations: ['A visible submit action is not provider delivery acknowledgement; answer collection remains pending until screen evidence is archived.'],
    };
    if (targetResult?.status === 'submitted_unverified') return { status: 'submitted', evidence };
    if (targetResult?.status === 'blocked') {
      return { status: 'blocked', blocker: String(targetResult.note || 'desktop_target_blocked'), evidence };
    }
    return { status: 'unknown', error: 'Desktop submission did not produce an attributable acknowledgement.', evidence };
  }

  throw new Error(`Unsupported external AI route: ${route.routeKind}.`);
}

export function archiveExternalAiAnswer(input: {
  sessionId: string;
  dispatchId: string;
  answerText: string;
  sourceEvidence: ExternalAiSourceEvidence;
  late?: boolean;
}): ExternalAiAnswerArchive {
  const answerText = String(input.answerText || '').trim();
  if (!answerText) throw new Error('Cannot archive an empty external AI answer.');
  const db = readDB();
  const { dispatches, answers } = arrays(db);
  const dispatch = dispatches.find(item => item.id === input.dispatchId && item.sessionId === input.sessionId);
  if (!dispatch) throw new Error('External AI dispatch was not found for answer archival.');
  const answerDigest = digest(answerText);
  const existing = answers.find(item => item.dispatchId === dispatch.id && item.answerDigest === answerDigest);
  if (existing) return existing;
  const receivedAt = nowIso();
  const answer: ExternalAiAnswerArchive = {
    id: randomUUID(),
    sessionId: dispatch.sessionId,
    dispatchId: dispatch.id,
    userId: dispatch.userId,
    targetId: dispatch.targetId,
    targetLabel: dispatch.targetLabel,
    answerText,
    answerDigest,
    sourceEvidence: { ...input.sourceEvidence, responseDigest: answerDigest, observedAt: input.sourceEvidence.observedAt || receivedAt },
    late: input.late === true,
    receivedAt,
  };
  answers.push(answer);
  dispatch.status = 'answered';
  dispatch.answerId = answer.id;
  dispatch.answerDigest = answerDigest;
  dispatch.sourceEvidence = answer.sourceEvidence;
  dispatch.externalSessionId = answer.sourceEvidence.externalSessionId || dispatch.externalSessionId;
  dispatch.externalMessageId = answer.sourceEvidence.externalMessageId || dispatch.externalMessageId;
  dispatch.updatedAt = receivedAt;
  dispatch.completedAt = receivedAt;
  delete dispatch.error;
  delete dispatch.blocker;
  updateSessionStatus(db, dispatch.sessionId);
  writeDB(db);
  return answer;
}

function settleRouteResult(
  dispatch: ExternalAiDispatch,
  result: RouteExecutionResult,
  late = false,
): ExternalAiDispatch {
  const current = getExternalAiDispatch(dispatch.id);
  if (current?.status === 'answered' && !result.answerText) return current;
  const base = current || dispatch;
  if (result.answerText) {
    archiveExternalAiAnswer({
      sessionId: base.sessionId,
      dispatchId: base.id,
      answerText: result.answerText,
      sourceEvidence: result.evidence,
      late,
    });
    return getExternalAiDispatch(base.id) || base;
  }
  const updated: ExternalAiDispatch = {
    ...base,
    status: result.status,
    sourceEvidence: result.evidence,
    externalSessionId: result.externalSessionId,
    externalMessageId: result.externalMessageId,
    blocker: result.blocker,
    error: result.error,
    updatedAt: nowIso(),
    ...(result.status === 'submitted' || result.status === 'pending' ? { submittedAt: nowIso() } : {}),
    ...(['blocked', 'failed'].includes(result.status) ? { completedAt: nowIso() } : {}),
  };
  return persistDispatch(updated);
}

export function getExternalAiDispatch(dispatchId: string): ExternalAiDispatch | null {
  const db = readDB();
  return arrays(db).dispatches.find(dispatch => dispatch.id === dispatchId) || null;
}

function existingDispatch(sessionId: string, targetId: string): ExternalAiDispatch | null {
  const db = readDB();
  return arrays(db).dispatches.find(dispatch => dispatch.sessionId === sessionId && dispatch.targetId === targetId) || null;
}

async function executeTarget(
  session: ExternalAiCollaborationSession,
  route: PlannedRoute,
  timeoutMs: number,
  context?: ToolContext,
): Promise<ExternalAiDispatch> {
  const idempotencyKey = digest({ sessionId: session.id, targetId: route.targetId, questionDigest: session.questionDigest });
  const running = dispatchExecutions.get(idempotencyKey);
  if (running) return running;
  const previous = existingDispatch(session.id, route.targetId);
  if (previous && previous.status !== 'planned') {
    if (previous.status === 'submitting') {
      return persistDispatch({
        ...previous,
        status: 'unknown',
        error: 'A prior submission was interrupted; automatic resend is blocked until read-only collection resolves it.',
        updatedAt: nowIso(),
      });
    }
    return previous;
  }
  const createdAt = previous?.createdAt || nowIso();
  const dispatch: ExternalAiDispatch = persistDispatch({
    id: previous?.id || `external-ai-dispatch-${digest(`${session.id}:${route.targetId}`).slice(0, 28)}`,
    sessionId: session.id,
    userId: session.userId,
    targetId: route.targetId,
    targetLabel: route.targetLabel,
    status: 'submitting',
    routeKind: route.routeKind,
    idempotencyKey,
    routeAttempts: route.routeAttempts,
    sourceEvidence: {
      routeKind: route.routeKind,
      targetId: route.targetId,
      provider: route.provider,
      model: route.model,
      toolName: route.toolName,
      observedAt: nowIso(),
      limitations: ['Submission is in progress; no answer has been verified yet.'],
    },
    collectorToolName: route.collectorToolName,
    createdAt,
    updatedAt: nowIso(),
  });
  const execution = (async () => {
    let timedOut = false;
    const routeExecution = executeRoute(route, session, dispatch, context);
    routeExecution.then(result => {
      if (timedOut && result.answerText) settleRouteResult(dispatch, result, true);
    }).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        routeExecution,
        new Promise<RouteExecutionResult>(resolve => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve({
              status: 'unknown',
              error: `External AI ${route.routeKind} route timed out; automatic fallback and resend were stopped.`,
              evidence: {
                routeKind: route.routeKind,
                targetId: route.targetId,
                provider: route.provider,
                model: route.model,
                toolName: route.toolName,
                observedAt: nowIso(),
                limitations: ['The result may arrive later and will be archived if this process receives it.'],
              },
            });
          }, timeoutMs);
        }),
      ]);
      return settleRouteResult(dispatch, result);
    } catch (error: any) {
      return persistDispatch({
        ...dispatch,
        status: 'unknown',
        error: String(error?.message || error || 'External AI route failed with an unknown outcome.'),
        updatedAt: nowIso(),
        sourceEvidence: {
          ...dispatch.sourceEvidence,
          observedAt: nowIso(),
          limitations: ['The route failed after selection; no lower-priority route was attempted to avoid duplicate external communication.'],
        },
      });
    } finally {
      if (timer) clearTimeout(timer);
      dispatchExecutions.delete(idempotencyKey);
    }
  })();
  dispatchExecutions.set(idempotencyKey, execution);
  return execution;
}

function sessionSnapshot(sessionId: string, userId?: string): any | null {
  const db = readDB();
  const { sessions, dispatches, answers } = arrays(db);
  const session = sessions.find(item => item.id === sessionId && (!userId || item.userId === userId));
  if (!session) return null;
  const scopedDispatches = dispatches.filter(item => item.sessionId === session.id);
  const scopedAnswers = answers.filter(item => item.sessionId === session.id);
  return {
    session: { ...session },
    dispatches: scopedDispatches.map(dispatch => ({ ...dispatch })),
    answers: scopedAnswers.map(answer => ({ ...answer })),
    counts: {
      targets: scopedDispatches.length,
      answered: scopedDispatches.filter(item => item.status === 'answered').length,
      pending: scopedDispatches.filter(item => ['submitted', 'pending', 'unknown', 'submitting'].includes(item.status)).length,
      blocked: scopedDispatches.filter(item => item.status === 'blocked').length,
      failed: scopedDispatches.filter(item => item.status === 'failed').length,
      lateAnswers: scopedAnswers.filter(item => item.late).length,
    },
  };
}

export function getExternalAiSessionSnapshot(sessionId: string, userId?: string): any | null {
  return sessionSnapshot(sessionId, userId);
}

export function listExternalAiSessionSnapshots(input: {
  userId: string;
  domain?: 'personal' | 'work';
  orgId?: string;
  limit?: number;
}): any[] {
  const db = readDB();
  const { sessions } = arrays(db);
  const domain = input.domain === 'work' ? 'work' : 'personal';
  const orgId = domain === 'work' ? String(input.orgId || '') : '';
  const limit = Math.max(1, Math.min(Number(input.limit) || 20, 100));
  return sessions
    .filter(session => session.userId === input.userId && session.domain === domain && session.orgId === orgId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit)
    .map(session => sessionSnapshot(session.id, input.userId))
    .filter(Boolean);
}

export function recoverInterruptedExternalAiCollaborations(): number {
  const db = readDB();
  const { dispatches, sessions } = arrays(db);
  const interrupted = dispatches.filter(dispatch => dispatch.status === 'submitting');
  if (interrupted.length === 0) return 0;
  const recoveredAt = nowIso();
  for (const dispatch of interrupted) {
    dispatch.status = 'unknown';
    dispatch.error = 'Backend restart interrupted an in-flight external AI submission; automatic resend is blocked.';
    dispatch.updatedAt = recoveredAt;
    dispatch.sourceEvidence = {
      ...dispatch.sourceEvidence,
      observedAt: recoveredAt,
      limitations: [
        ...dispatch.sourceEvidence.limitations,
        'Restart recovery cannot prove whether the external target received the submission.',
      ],
    };
  }
  for (const session of sessions) updateSessionStatus(db, session.id);
  writeDB(db);
  return interrupted.length;
}

export async function executeExternalAiCollaboration(
  args: Record<string, any>,
  context?: ToolContext,
): Promise<string> {
  const question = String(args.question || args.prompt || args.message || '').trim();
  if (!question) throw new Error('question is required.');
  const rawTargets = Array.isArray(args.targets) ? args.targets : args.target ? [args.target] : [];
  const targetIds = Array.from(new Set(rawTargets.map(value => targetIdentity(value).id).filter(Boolean))).slice(0, 8);
  if (targetIds.length === 0) throw new Error('At least one external AI target is required.');
  const session = createOrLoadSession(question, targetIds, args, context);
  const timeoutMs = Math.max(1_000, Math.min(Number(args.targetTimeoutMs) || 45_000, 120_000));
  const planned = targetIds.map(targetId => ({ targetId, route: planExternalAiRoute(targetId, context) }));

  for (const item of planned.filter(item => !item.route)) {
    const target = targetIdentity(item.targetId);
    const dispatchId = `external-ai-dispatch-${digest(`${session.id}:${target.id}`).slice(0, 28)}`;
    if (!existingDispatch(session.id, target.id)) {
      persistDispatch({
        id: dispatchId,
        sessionId: session.id,
        userId: session.userId,
        targetId: target.id,
        targetLabel: target.label,
        status: 'blocked',
        routeKind: 'desktop_visual',
        idempotencyKey: digest({ sessionId: session.id, targetId: target.id, questionDigest: session.questionDigest }),
        routeAttempts: ROUTE_PRIORITY.map(routeKind => ({ routeKind, available: false, reason: 'route_unavailable' })),
        sourceEvidence: {
          routeKind: 'desktop_visual',
          targetId: target.id,
          observedAt: nowIso(),
          limitations: ['No API, MCP, healthy CLI, structured browser, or desktop route was available.'],
        },
        blocker: 'no_external_ai_route_available',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        completedAt: nowIso(),
      });
    }
  }

  const nonDesktop = planned.filter(item => item.route && item.route.routeKind !== 'desktop_visual') as Array<{ targetId: string; route: PlannedRoute }>;
  const desktop = planned.filter(item => item.route?.routeKind === 'desktop_visual') as Array<{ targetId: string; route: PlannedRoute }>;
  const nonDesktopPromise = Promise.allSettled(nonDesktop.map(item => executeTarget(session, item.route, timeoutMs, context)));
  const desktopPromise = (async () => {
    const results: ExternalAiDispatch[] = [];
    for (const item of desktop) results.push(await executeTarget(session, item.route, timeoutMs, context));
    return results;
  })();
  await Promise.allSettled([nonDesktopPromise, desktopPromise]);

  const snapshot = sessionSnapshot(session.id, session.userId)!;
  return JSON.stringify({
    ok: snapshot.counts.answered > 0,
    verified: true,
    verificationStatus: 'verified',
    status: snapshot.session.status,
    sessionId: session.id,
    taskId: session.taskId,
    questionDigest: session.questionDigest,
    routePriority: ROUTE_PRIORITY,
    results: snapshot.dispatches.map((dispatch: ExternalAiDispatch) => ({
      ...dispatch,
      answerText: snapshot.answers.find((answer: ExternalAiAnswerArchive) => answer.dispatchId === dispatch.id)?.answerText || null,
    })),
    counts: snapshot.counts,
    note: 'Each target is independently attributed. A failed or pending target does not erase verified answers from other targets, and no lower-priority route is used after an uncertain submission.',
  }, null, 2);
}

async function collectAdapterAnswer(
  dispatch: ExternalAiDispatch,
  session: ExternalAiCollaborationSession,
  context?: ToolContext,
): Promise<RouteExecutionResult | null> {
  if (!dispatch.collectorToolName || !context?.toolRegistry) return null;
  const route: PlannedRoute = {
    routeKind: dispatch.routeKind,
    targetId: dispatch.targetId,
    targetLabel: dispatch.targetLabel,
    toolName: dispatch.collectorToolName,
    routeAttempts: dispatch.routeAttempts,
  };
  const raw = await context.toolRegistry.execute(
    dispatch.collectorToolName,
    buildAdapterArguments(dispatch.collectorToolName, '', session, dispatch, context),
    {
      ...(context || {}),
      taskId: session.taskId,
      idempotencyKey: `${dispatch.idempotencyKey}:collect`,
      userConfirmed: true,
    },
  );
  return parseAdapterResult(raw, route);
}

export async function collectExternalAiAnswers(
  args: Record<string, any>,
  context?: ToolContext,
): Promise<string> {
  const sessionId = String(args.sessionId || '').trim();
  if (!sessionId) throw new Error('sessionId is required.');
  const initial = sessionSnapshot(sessionId, context?.userId);
  if (!initial) throw new Error('External AI collaboration session was not found for this user.');
  const targetFilter = new Set(
    (Array.isArray(args.targets) ? args.targets : []).map(value => targetIdentity(value).id).filter(Boolean),
  );
  const waitMs = Math.max(0, Math.min(Number(args.waitMs) || 0, 60_000));
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
  const pending = (initial.dispatches as ExternalAiDispatch[]).filter(dispatch => (
    dispatch.status !== 'answered'
    && dispatch.status !== 'blocked'
    && dispatch.status !== 'failed'
    && (targetFilter.size === 0 || targetFilter.has(dispatch.targetId))
  ));

  for (const dispatch of pending) {
    try {
      let result: RouteExecutionResult | null = null;
      if (dispatch.routeKind === 'desktop_visual') {
        const raw = await desktopAiCollectAnswer({
          target: dispatch.targetId,
          question: initial.session.question,
          waitMs: 0,
        }, context);
        const parsed = JSON.parse(raw);
        const answerText = String(parsed.answerText || '').trim();
        const evidence: ExternalAiSourceEvidence = {
          routeKind: 'desktop_visual',
          targetId: dispatch.targetId,
          provider: parsed.provider,
          model: parsed.model,
          ...(answerText ? { responseDigest: digest(answerText) } : {}),
          observedAt: nowIso(),
          limitations: ['Visible-screen answer evidence may be partial when response content is off-screen.'],
        };
        result = answerText
          ? { status: 'answered', answerText, evidence }
          : parsed.status === 'blocked'
            ? { status: 'blocked', blocker: String(parsed.blocker || parsed.note || 'desktop_collection_blocked'), evidence }
            : { status: 'pending', evidence };
      } else {
        result = await collectAdapterAnswer(dispatch, initial.session, context);
      }
      if (result) settleRouteResult(dispatch, result, dispatch.status === 'unknown');
    } catch (error: any) {
      persistDispatch({
        ...dispatch,
        status: dispatch.status === 'unknown' ? 'unknown' : 'pending',
        error: String(error?.message || error),
        updatedAt: nowIso(),
      });
    }
  }
  const snapshot = sessionSnapshot(sessionId, context?.userId)!;
  return JSON.stringify({
    ok: snapshot.counts.answered > 0,
    status: snapshot.session.status,
    sessionId,
    answers: snapshot.answers,
    dispatches: snapshot.dispatches,
    counts: snapshot.counts,
    completeness: snapshot.counts.answered === snapshot.counts.targets ? 'complete' : 'partial',
  }, null, 2);
}

export function externalAiSessionStatus(args: Record<string, any>, context?: ToolContext): string {
  const sessionId = String(args.sessionId || '').trim();
  if (!sessionId) throw new Error('sessionId is required.');
  const snapshot = sessionSnapshot(sessionId, context?.userId);
  if (!snapshot) throw new Error('External AI collaboration session was not found for this user.');
  return JSON.stringify({
    ok: true,
    status: snapshot.session.status,
    sessionId,
    ...snapshot,
  }, null, 2);
}

export function reconcileExternalAiCollaboration(
  args: Record<string, any>,
  context?: ToolContext,
): string | null {
  const question = String(args.question || args.prompt || args.message || '').trim();
  const rawTargets = Array.isArray(args.targets) ? args.targets : args.target ? [args.target] : [];
  const targetIds = Array.from(new Set(rawTargets.map(value => targetIdentity(value).id).filter(Boolean))).slice(0, 8);
  if (!question || targetIds.length === 0) return null;
  const userId = String(context?.userId || 'anonymous');
  const taskId = String(context?.taskId || context?.requestId || context?.turnId || `external-ai-task-${digest(question).slice(0, 16)}`);
  const conversationId = String(context?.conversationId || '');
  const sessionId = String(args.sessionId || '').trim() || deterministicSessionId({
    userId,
    taskId,
    conversationId,
    questionDigest: digest(question),
    targetIds,
  });
  const snapshot = sessionSnapshot(sessionId, userId);
  if (!snapshot || snapshot.dispatches.length === 0) return null;
  return JSON.stringify({
    ok: snapshot.counts.answered > 0,
    verified: true,
    verificationStatus: 'verified',
    status: snapshot.session.status,
    sessionId,
    counts: snapshot.counts,
    reconciled: true,
  });
}
