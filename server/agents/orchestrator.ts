/**
 * Lumi Master Brain Orchestrator
 *
 * Lumi receives tasks → judges complexity → handles simple ones directly →
 * decomposes complex ones into sub-tasks → dispatches to worker agents →
 * aggregates results → optionally distills pattern into a reusable skill.
 *
 * Anti-entropy design:
 * - Each worker loads only its own memory + sub-task context (context isolation)
 * - Complex reusable patterns are auto-distilled into MCP skills (skill distillation)
 * - Valuable outputs crystallize into growth-tier memories (memory crystallization)
 */

import fs from "fs";
import { readDB, writeDB } from "../../db_layer";
import { NormalizedMessage, makeLLMCall } from "../llm/providers";
import { runWithTools } from "../llm/adapter";
import { toolRegistry } from "../tools/registry";
import { queryMemories, addMemory } from "../memory/store";
import { Memory } from "../memory/types";
import { AgentRecord } from "./runtime";
import { recordWorkflow } from "../skills/worklog";
import { personalityRegistry } from "../personality";
import { recordTokenUsage } from "../llm/token_tracker";
import { executeExternalAgent, validateExternalCommand } from "./external_runtime";
import { ToolExecutionRecord } from "../tools/types";
import { buildResponseLanguageInstruction } from "../utils/language";
import { canAutoApproveAction } from "../tools/action_constitution";

type LLMProvider = 'deepseek' | 'gemini' | 'openai' | 'anthropic' | 'qwen' | 'ark' | 'ollama' | 'lmstudio' | 'xiaomi' | 'kimi' | 'glm' | 'relay' | 'auto';
type ScopedLLMConfig = {
  provider: LLMProvider;
  model: string;
  userId?: string;
  domain?: string;
  orgId?: string;
};

export interface LlmGetters {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
  getOllama?: () => any;
  getLmStudio?: () => any;
  getArk?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
}

// ── Types ──

export type TaskComplexity = 'simple' | 'moderate' | 'complex';

export interface SubTask {
  id: string;
  description: string;
  requiredSkill: 'code' | 'writing' | 'analysis' | 'search' | 'general';
  executionMode: 'lumi' | 'scholar' | 'founder';
  dependsOn?: string[];
  assignedAgentId?: string;
}

export interface WorkerAssignment {
  subTask: SubTask;
  agent: AgentRecord;
}

export interface WorkflowResult {
  subTaskResults: Array<{ subTaskId: string; output: string; agentId: string }>;
  aggregatedOutput: string;
  totalAgentsUsed: number;
}

export interface OrchestrationContext {
  userId: string;
  personalityId?: string;
  domain?: string;
  orgId?: string;
  availableAgentIds?: string[];
  desktopRelay?: (toolName: string, args: Record<string, any>) => Promise<string>;
  isCancelled?: () => boolean;
}

export interface OrchestrationToolMeta {
  subTaskId: string;
  agentId: string;
  agentName: string;
}

export type OrchestrationToolEvent = Omit<ToolExecutionRecord, 'result'> & {
  result?: string;
  error?: string;
};

export type OrchestrationToolCallback = (
  record: OrchestrationToolEvent,
  meta: OrchestrationToolMeta,
) => void;

function compactTextBlock(value: string, limit: number, label = 'context'): string {
  const text = value || '';
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.72);
  const tail = Math.max(500, limit - head - 220);
  return [
    text.slice(0, head),
    `\n\n[${label} compacted: ${text.length} characters total. Use referenced files/tools for full content.]\n\n`,
    text.slice(-tail),
  ].join('');
}

function compactTaskForPlanning(text: string, limit = 8000): string {
  const marker = '\n\n## Work Context';
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return compactTextBlock(text, limit, 'task');

  const request = text.slice(0, markerIndex).trim();
  const context = text.slice(markerIndex + marker.length).trim();
  const contextLimit = Math.max(1200, limit - request.length - 260);
  return [
    request,
    '',
    '## Work Context',
    compactTextBlock(context, contextLimit, 'work context'),
  ].join('\n');
}

function collectArtifactRefs(text: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /[A-Za-z]:\\[^\n\r"'<>|]+?\.(?:dxf|dwg|svg|pdf|docx|xlsx|pptx|md|txt|json|csv|png|jpe?g|webp|html)/gi,
    /https?:\/\/[^\s"'<>]+/gi,
  ];
  for (const re of patterns) {
    for (const match of text.match(re) || []) refs.add(match.trim());
  }
  return Array.from(refs).slice(0, 10);
}

const ARTIFACT_PRODUCER_TOOL_RE =
  /^(write_file|create_ppt|create_docx|create_pdf|cad_generate_dxf|transcribe_audio_to_text_file|generate_.*(?:dxf|ppt|file)|export_|save_|document_|image_generate)/i;

function isVerifiedArtifactRef(ref: string): boolean {
  if (/^https?:\/\//i.test(ref)) return true;
  try {
    const stat = fs.statSync(ref);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function buildWorkerOutput(text: string, toolCalls: ToolExecutionRecord[] = []): string {
  const artifacts = new Set<string>();
  for (const call of toolCalls) {
    if (call.error || !ARTIFACT_PRODUCER_TOOL_RE.test(call.name)) continue;
    for (const ref of collectArtifactRefs(call.result || '')) {
      if (isVerifiedArtifactRef(ref)) artifacts.add(ref);
    }
  }

  if (!/Maximum tool call iterations reached/i.test(text) && artifacts.size === 0) {
    return compactTextBlock(text, 12000, 'worker output');
  }

  const toolSummary = toolCalls.slice(-8).map((call, index) => {
    const status = call.error ? `failed: ${call.error}` : 'done';
    return `${index + 1}. ${call.name} - ${status}`;
  });

  return [
    compactTextBlock(text, 4000, 'worker output'),
    toolSummary.length ? '\nRecent tool steps:' : '',
    ...toolSummary,
    artifacts.size ? '\nGenerated/referenced files:' : '',
    ...Array.from(artifacts).map(ref => `- ${ref}`),
  ].filter(Boolean).join('\n');
}

function agentAvailableForContext(agent: AgentRecord, context: OrchestrationContext): boolean {
  if (!agent || agent.status === 'offline' || agent.status === 'terminated') return false;
  if ((agent as any).isFrozen === true) return false;
  if (agent.runtime === 'external' && agent.healthStatus !== 'online') return false;
  if (context.availableAgentIds?.length && !context.availableAgentIds.includes(agent.id)) return false;

  const domain = context.domain || (context.orgId ? 'work' : 'personal');
  if (domain === 'work') {
    return !!context.orgId && (agent.orgId || '') === context.orgId && (agent.domain || 'work') === 'work';
  }

  if (agent.domain === 'work' || agent.orgId) return false;
  if (agent.ownerUid && agent.ownerUid !== context.userId) return false;
  return true;
}

function recordExternalAgentRun(agentId: string, result: { success: boolean; output: string; exitCode: number | null; durationMs: number }) {
  try {
    const db = readDB();
    const agent = (db.agents || []).find((item: any) => item.id === agentId);
    if (!agent) return;
    Object.assign(agent, {
      healthStatus: result.success ? 'online' : 'error',
      lastRunAt: new Date().toISOString(),
      lastRunStatus: result.success ? 'success' : 'failed',
      lastRunOutput: result.output.slice(0, 1200),
      lastRunDurationMs: result.durationMs,
      lastRunExitCode: result.exitCode,
      lastActiveAt: new Date().toISOString(),
    });
    writeDB(db);
  } catch {}
}

function throwIfCancelled(context: OrchestrationContext): void {
  if (context.isCancelled?.()) {
    throw new Error('Workflow cancelled');
  }
}

// ── Complexity classification ──

/**
 * Signals are organized by WHAT they reveal about task structure,
 * not just keyword matching.
 */

// Multi-step sequential markers: the user is describing a chain of actions
const SEQUENTIAL_MARKERS = [
  '先', '再', '然后', '接着', '之后', '最后',
  '第一步', '第二步', '第三步', '首先', '其次', '最后',
  'first', 'then', 'next', 'finally', 'after that',
  'step 1', 'step 2', 'step 3',
];

// Parallel markers: the user explicitly wants things done concurrently
const PARALLEL_MARKERS = [
  '同时', '并行', '一边', '各自', '分别', '分开',
  'simultaneously', 'in parallel', 'at the same time', 'concurrently',
  'both', 'each', 'separately',
];

// Numbered/bulleted list: user already decomposed the task themselves
const LIST_PATTERN = /(?:^|\n)\s*(?:\d+[.、)]|[-*+•])\s+/gm;

// Cross-domain verb pairs: one message touching fundamentally different domains
// Each pair = [domain1_verb, domain2_verb] — both must appear
const CROSS_DOMAIN_PAIRS: [string[], string[]][] = [
  [['写', '开发', '实现', 'build', 'code', 'implement', 'create'], ['部署', '上线', '发布', 'deploy', 'release', 'publish']],
  [['分析', '研究', 'analyze', 'research', 'investigate'], ['写', '生成', '报告', 'write', 'generate', 'report']],
  [['设计', 'design', 'plan'], ['实现', '开发', '搭建', 'implement', 'build', 'code']],
  [['修复', '排查', 'debug', 'fix', 'troubleshoot'], ['测试', '验证', '部署', 'test', 'verify', 'deploy']],
  [['查', '搜索', 'search', 'find', 'look up'], ['整理', '汇总', '对比', 'organize', 'summarize', 'compare']],
];

// High-depth verbs: these verbs imply multiple implicit sub-steps
const DEEP_VERBS = [
  '搭建', '重构', '架构', '迁移', '集成', '部署方案',
  'build a', 'set up a', 'architect', 'refactor', 'migrate', 'bootstrap',
  '从零', 'from scratch', '整套', '完整的', '完整的',
  'end-to-end', 'full stack', 'pipeline', 'workflow',
];

// Team/orchestration triggers — user explicitly wants multi-agent work
const TEAM_TRIGGERS = [
  '组个团队', '组建团队', '创建团队', '组个队', '找几个', '组队',
  'assemble a team', 'create a team', 'form a team', 'team up',
  '多个agent', '多个智能体', 'multi-agent', 'crew',
];

// Tool-requiring action verbs: user wants Lumi to DO something with tools.
// These imply at least moderate complexity — dispatch to worker for execution.
const ACTION_VERBS = [
  '做', '帮我做', '制作', '创建', '生成', '写', '编写', '画', '绘制',
  '打开', '启动', '运行', '执行', '关闭', '停止',
  '搜索', '查', '查找', '找', '下载', '安装', '部署',
  '删除', '移除', '清理', '整理',
  '发送', '发', '推送', '上传', '分享',
  '翻译', '转换', '导出', '导入', '提取',
  'create', 'make', 'generate', 'build', 'write', 'draw', 'design',
  'open', 'start', 'launch', 'run', 'execute', 'close', 'stop',
  'search', 'find', 'look up', 'download', 'install', 'deploy',
  'delete', 'remove', 'clean', 'organize',
  'send', 'push', 'upload', 'share',
  'translate', 'convert', 'export', 'import', 'extract',
];

// Pure Q&A / single-step verbs — these stay with Lumi directly
const SIMPLE_VERBS = [
  '是什么', '什么是', '什么意思', '怎么用', '用法',
  'what is', 'how do i', 'how to', 'why is',
  '解释一下', 'explain', '查一下', 'find', 'search for',
  '哪个', 'which', 'when', 'where',
];

/**
 * Classify task complexity using structural heuristics.
 *
 * The goal: only send a task to the orchestrator when it genuinely
 * benefits from decomposition + parallel worker execution.
 *
 * Simple: single question or action, one domain, one step.
 * Moderate: 2-3 related steps, possible tool use but single domain.
 * Complex: multi-step + multi-domain, or explicit parallelism, or deep-task verbs.
 */
export function classifyComplexity(
  text: string,
  _context: OrchestrationContext,
): TaskComplexity {
  const lower = text.toLowerCase();
  const trimmed = text.trim();

  // ── Structural checks ──

  // 1. Explicit list: user already broke it down → complex
  const listMatches = trimmed.match(LIST_PATTERN);
  if (listMatches && listMatches.length >= 3) return 'complex';
  if (listMatches && listMatches.length >= 2) return 'moderate';

  // 2. Sequential chain: "先X, 再Y, 然后Z" → complex
  const seqMatches = SEQUENTIAL_MARKERS.filter(s => lower.includes(s));
  if (seqMatches.length >= 3) return 'complex';
  if (seqMatches.length >= 2) return 'moderate';

  // 3. Explicit parallelism → at least moderate, usually complex
  const paraMatches = PARALLEL_MARKERS.filter(s => lower.includes(s));
  if (paraMatches.length >= 2) return 'complex';
  if (paraMatches.length >= 1) return 'moderate';

  // 4. Cross-domain detection: e.g., "写代码" + "部署"
  let crossDomainHits = 0;
  for (const [domain1, domain2] of CROSS_DOMAIN_PAIRS) {
    const hit1 = domain1.some(v => lower.includes(v));
    const hit2 = domain2.some(v => lower.includes(v));
    if (hit1 && hit2) crossDomainHits++;
  }
  if (crossDomainHits >= 2) return 'complex';
  if (crossDomainHits >= 1) return 'moderate';

  // 5. Deep verbs that imply multi-step work
  const deepHits = DEEP_VERBS.filter(s => lower.includes(s));
  if (deepHits.length >= 1) return 'complex';

  // 6. Team/orchestration triggers → explicit multi-agent intent
  const teamHits = TEAM_TRIGGERS.filter(s => lower.includes(s));
  if (teamHits.length >= 1) return 'complex';

  // 7. Question detection — short questions with question markers are always simple.
  //    "你能帮我做什么" is a question about capabilities, not an action request.
  const QUESTION_MARKERS = [
    '吗', '呢', '什么', '怎么', '谁', '哪', '干嘛', '干什么',
    '能不能', '可不可以', '会不会', '可以吗', '行吗', '如何',
    'what', 'how', 'why', 'when', 'where', 'who', 'can you', 'could you',
  ];
  const isQuestion = QUESTION_MARKERS.some(q => lower.includes(q));
  const chChars = (text.match(/[一-鿿]/g) || []).length;
  if (isQuestion && chChars < 30 && text.split(/\s+/).length < 20) return 'simple';

  // 8. Action verbs: user wants something DONE with tools → at least moderate, dispatch to worker
  const actionHits = ACTION_VERBS.filter(s => lower.includes(s));
  if (actionHits.length >= 1) return 'moderate';

  // 9. Pure Q&A — single question, single domain → simple
  const simpleHits = SIMPLE_VERBS.filter(s => lower.includes(s));
  const clauseCount = trimmed.split(/[.。!！?？\n]+/).filter(s => s.trim().length > 0).length;
  if (simpleHits.length >= 1 && clauseCount <= 1) return 'simple';

  // ── Fallback size-based heuristics ──
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const wordCount = text.split(/\s+/).length;

  // Very short → simple
  if (chineseChars < 20 && wordCount < 15) return 'simple';

  // Very long → at least moderate
  if (chineseChars > 200 || wordCount > 80) return 'complex';
  if (chineseChars > 80 || wordCount > 40) return 'moderate';

  return 'simple';
}

// ── Task decomposition (LLM-powered) ──

const DECOMPOSE_PROMPT = `You are a task decomposition engine. Break the user's request into independent sub-tasks that can be executed by separate worker agents.

Rules:
- Each sub-task should be self-contained and independently executable
- If sub-tasks have dependencies, mark them with dependsOn
- Assign each sub-task a requiredSkill: code, writing, analysis, search, or general
- Assign an executionMode: scholar (technical/analytical), founder (creative/strategic), or lumi (default)
- Produce 2-5 sub-tasks. Do NOT over-decompose.
- Output ONLY valid JSON array — no explanation, no markdown fences.

User request: {task}

Output format:
[
  {
    "id": "sub_1",
    "description": "what this worker should do",
    "requiredSkill": "code",
    "executionMode": "scholar",
    "dependsOn": []
  }
]`;

/**
 * Decompose a complex task into sub-tasks via LLM.
 */
export async function decomposeTask(
  text: string,
  config: ScopedLLMConfig,
  context: OrchestrationContext,
  llmGetters: LlmGetters,
): Promise<SubTask[]> {
  const prompt = DECOMPOSE_PROMPT.replace('{task}', compactTaskForPlanning(text));

  try {
    const messages: NormalizedMessage[] = [{ role: 'user', content: prompt }];
    const result = await makeLLMCall(
      messages,
      [],
      {
        provider: config.provider,
        model: config.model,
        maxTokens: 2000,
        userId: config.userId || context.userId,
        domain: config.domain || context.domain,
        orgId: config.orgId || context.orgId,
      },
      llmGetters.getDeepSeek,
      llmGetters.getGemini,
      llmGetters.getOpenAI,
      llmGetters.getAnthropic,
      llmGetters.getQwen,
      llmGetters.getOllama,
      llmGetters.getLmStudio,
      llmGetters.getArk,
      llmGetters.getXiaomi,
      llmGetters.getKimi,
      llmGetters.getGlm,
      llmGetters.getRelay,
    );

    if (context?.userId) {
      recordTokenUsage(context.userId, config.provider, config.model, result.usage, `orch_decompose_${Date.now()}`, 'orchestrator');
    }

    // Parse JSON from the response (handle markdown code fences)
    let json = result.text.trim();
    if (json.startsWith('```')) {
      json = json.replace(/```(?:json)?\n?/g, '').trim();
    }
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error('Expected array');

    return parsed.map((item: any, idx: number) => ({
      id: item.id || `sub_${idx + 1}`,
      description: item.description || '',
      requiredSkill: item.requiredSkill || 'general',
      executionMode: item.executionMode || 'lumi',
      dependsOn: item.dependsOn || [],
    }));
  } catch (err) {
    console.error('[Orchestrator] Decomposition failed, treating as simple:', err);
    // Fallback: single sub-task = the original request
    return [{
      id: 'sub_1',
      description: text,
      requiredSkill: 'general',
      executionMode: 'lumi',
    }];
  }
}

// ── Worker matching ──

const SKILL_TO_CATEGORY: Record<string, string> = {
  code: 'code',
  writing: 'content',
  analysis: 'analysis',
  search: 'search',
  general: 'general',
};

// ── Smart routing cache: remembers which agent succeeded at which skill ──
// skillTag → { agentId → successCount }
const routingCache = new Map<string, Map<string, number>>();
const ROUTING_CACHE_MAX_AGE_MS = 7 * 86400000; // 7 days

let onAgentPromoted: ((agent: AgentRecord) => void) | null = null;
export function setOnAgentPromoted(cb: (agent: AgentRecord) => void) { onAgentPromoted = cb; }

const PROMOTION_THRESHOLD = 5; // Same skill successfully executed N times → promote

let lastCacheEviction = Date.now();

function evictStaleRoutingCache(now: number): void {
  if (now - lastCacheEviction < 3600_000) return;
  lastCacheEviction = now;
  // Purge entire cache if last-used > 7 days (coarse, but bounded)
  if (now - routingCacheLastUsed > ROUTING_CACHE_MAX_AGE_MS) {
    routingCache.clear();
  }
}
let routingCacheLastUsed = Date.now();

function recordRoutingSuccess(skillTag: string, agentId: string): void {
  evictStaleRoutingCache(Date.now());
  if (!routingCache.has(skillTag)) {
    routingCache.set(skillTag, new Map());
  }
  const agentScores = routingCache.get(skillTag)!;
  const newCount = (agentScores.get(agentId) || 0) + 1;
  agentScores.set(agentId, newCount);
  routingCacheLastUsed = Date.now();

  // Check if this ephemeral agent should be promoted to permanent
  if (agentId.startsWith('ephemeral_') && newCount >= PROMOTION_THRESHOLD) {
    promoteEphemeralAgent(agentId, skillTag);
  }
}

function promoteEphemeralAgent(agentId: string, skillTag: string): void {
  const db = readDB();
  const idx = db.agents.findIndex((a: any) => a.id === agentId);
  if (idx === -1) return;

  const agent = db.agents[idx];
  const newId = `worker_${skillTag}_${Date.now().toString(36)}`;
  agent.id = newId;
  agent.name = `${skillTag}-specialist`;
  agent.status = 'active';
  agent.autoCreated = true;
  agent.promotedAt = new Date().toISOString();

  // Update routing cache to point to new ID
  for (const [, agentScores] of routingCache) {
    if (agentScores.has(agentId)) {
      const score = agentScores.get(agentId)!;
      agentScores.delete(agentId);
      agentScores.set(newId, score);
    }
  }

  writeDB(db);
  console.log(`[Orchestrator] Promoted ephemeral agent "${agentId}" → "${newId}" (${skillTag} specialist)`);
  if (onAgentPromoted) onAgentPromoted(agent);
}

function getRoutingScore(skillTag: string, agentId: string): number {
  const agentScores = routingCache.get(skillTag);
  return agentScores?.get(agentId) || 0;
}

/** Export routing cache stats for MCP management tools */
export function getRoutingCacheStats(): { totalSkillTags: number; totalRoutes: number; agents: Record<string, Record<string, number>> } {
  const agents: Record<string, Record<string, number>> = {};
  let totalRoutes = 0;
  for (const [skillTag, agentScores] of routingCache.entries()) {
    for (const [agentId, count] of agentScores.entries()) {
      if (!agents[agentId]) agents[agentId] = {};
      agents[agentId][skillTag] = count;
      totalRoutes += count;
    }
  }
  return {
    totalSkillTags: routingCache.size,
    totalRoutes,
    agents,
  };
}

/**
 * Match sub-tasks to available worker agents by skill compatibility.
 * If no suitable agent exists, returns the best generalist agent.
 */
export function matchWorkers(
  subTasks: SubTask[],
  availableAgents: AgentRecord[],
): WorkerAssignment[] {
  const assignments: WorkerAssignment[] = [];

  for (const subTask of subTasks) {
    const targetCategory = SKILL_TO_CATEGORY[subTask.requiredSkill] || 'general';
    const taskTokens = subTask.description.toLowerCase().split(/\s+/);

    // Score every available agent, pick the best
    let bestAgent: AgentRecord | null = null;
    let bestScore = -1;

    for (const agent of availableAgents) {
      let score = 0;

      // Category match (primary, weight 10)
      if (agent.category === targetCategory) score += 10;
      // Idle bonus
      if (agent.status === 'idle') score += 3;

      // Skill tag overlap (secondary, weight 5 per match)
      if (agent.skillTags && agent.skillTags.length > 0) {
        for (const tag of agent.skillTags) {
          for (const token of taskTokens) {
            if (tag.toLowerCase().includes(token) || token.includes(tag.toLowerCase())) {
              score += 5;
            }
          }
        }
      }

      // Routing cache bonus: prefer agents that succeeded at this skill before
      const routingBonus = getRoutingScore(subTask.requiredSkill, agent.id);
      if (routingBonus > 0) score += Math.min(routingBonus * 2, 8);

      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
      }
    }

    if (!bestAgent) {
      // Auto-create ephemeral worker agent when none matches
      bestAgent = createEphemeralAgent(targetCategory, subTask.requiredSkill);
    }

    if (bestAgent) {
      assignments.push({ subTask, agent: bestAgent });
    }
  }

  return assignments;
}

/** Auto-create or reuse a minimal ephemeral agent for a one-shot task */
function createEphemeralAgent(category: string, skillTag: string): AgentRecord {
  // Reuse existing idle ephemeral with same category+skill if available
  try {
    const db = readDB();
    const reusable = (db.agents || []).find((a: any) =>
      a.id.startsWith('ephemeral_') &&
      a.status === 'idle' &&
      a.category === category &&
      (a.skillTags || []).includes(skillTag)
    );
    if (reusable) {
      reusable.lastActiveAt = new Date().toISOString();
      return reusable as AgentRecord;
    }
  } catch {}

  const id = `ephemeral_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const agent: AgentRecord = {
    id,
    name: `${category}-worker`,
    category,
    config: '{}',
    data: '{}',
    createdAt: new Date().toISOString(),
    status: 'idle',
    modelPreference: 'deepseek-v4-flash',
    memoryScope: 'private',
    autonomyLevel: 'reactive',
    runtimeConfig: '{}',
    skillTags: [skillTag],
    executionMode: 'lumi',
    allowCrossPollination: false,
  };
  try {
    const db = readDB();
    if (!db.agents) db.agents = [];
    db.agents.push(agent as any);
  } catch {}
  return agent;
}

// ── Workflow execution ──

/**
 * Resolve a topological execution order respecting dependsOn.
 * Returns groups of sub-tasks that can run in parallel.
 */
function topologicalGroups(assignments: WorkerAssignment[]): WorkerAssignment[][] {
  const completed = new Set<string>();
  const remaining = [...assignments];
  const groups: WorkerAssignment[][] = [];

  while (remaining.length > 0) {
    const ready: WorkerAssignment[] = [];
    const stillWaiting: WorkerAssignment[] = [];

    for (const a of remaining) {
      const deps = a.subTask.dependsOn || [];
      if (deps.every(d => completed.has(d))) {
        ready.push(a);
      } else {
        stillWaiting.push(a);
      }
    }

    if (ready.length === 0 && stillWaiting.length > 0) {
      // Circular dependency or all deps unresolved — execute remaining as a batch
      groups.push(stillWaiting);
      break;
    }

    groups.push(ready);
    for (const a of ready) completed.add(a.subTask.id);
    remaining.length = 0;
    remaining.push(...stillWaiting);
  }

  return groups;
}

/**
 * Execute a task on an external agent via CLI (OpenClaw, Hermes, etc.).
 */
async function executeExternalWorkerTask(
  assignment: WorkerAssignment,
): Promise<{ subTaskId: string; output: string; agentId: string }> {
  const { subTask, agent } = assignment;

  const validationError = validateExternalCommand(agent.externalCommand!);
  if (validationError) {
    return {
      subTaskId: subTask.id,
      output: `[External agent config error: ${validationError}]`,
      agentId: agent.id,
    };
  }

  const result = await executeExternalAgent(
    { command: agent.externalCommand!, timeout: 180_000 },
    subTask.description,
  );
  recordExternalAgentRun(agent.id, result);

  return {
    subTaskId: subTask.id,
    output: result.success
      ? result.output
      : `[External agent '${agent.name}' failed (exit ${result.exitCode}): ${result.output.slice(0, 500)}]`,
    agentId: agent.id,
  };
}

/**
 * Execute a single worker task with retry and fallback.
 * - Attempt 1: primary agent
 * - Attempt 2: retry same agent (transient errors)
 * - Attempt 3: try a different fallback agent
 * Each worker loads only its own context (anti-entropy: context isolation).
 */
async function executeWorkerTask(
  assignment: WorkerAssignment,
  context: OrchestrationContext,
  llmConfig: ScopedLLMConfig,
  llmGetters: LlmGetters,
  fallbackAgents: AgentRecord[],
  onTool?: OrchestrationToolCallback,
): Promise<{ subTaskId: string; output: string; agentId: string }> {
  const { subTask, agent } = assignment;
  throwIfCancelled(context);

  // External agents: dispatch via CLI (OpenClaw, Hermes, etc.)
  if (agent.runtime === 'external' && agent.externalCommand) {
    const result = await executeExternalWorkerTask(assignment);
    throwIfCancelled(context);
    return result;
  }

  const agentsToTry = [
    agent,
    ...fallbackAgents.filter(a => a.id !== agent.id).slice(0, 2),
  ];

  for (let attempt = 0; attempt < agentsToTry.length; attempt++) {
    throwIfCancelled(context);
    const currentAgent = agentsToTry[attempt];
    const isRetry = attempt > 0;

    const workerMemories = queryMemories({
      userId: context.userId,
      query: subTask.description,
      limit: 3,
      minConfidence: 0.3,
      agentId: currentAgent.id,
      domain: context.domain,
      orgId: context.orgId,
    });

    const memoryContext = workerMemories.length > 0
      ? workerMemories.map(m => `- ${m.content.slice(0, 200)}`).join('\n')
      : '';

    let modeDirective = '';
    if (subTask.executionMode !== 'lumi') {
      const lumiConfig = personalityRegistry.get('lumi');
      const mode = lumiConfig?.executionModes?.[subTask.executionMode];
      if (mode?.promptExtension) {
        modeDirective = mode.promptExtension;
      }
    }

    const retryHint = isRetry
      ? `\n(Retry attempt ${attempt + 1}/${agentsToTry.length} — previous attempt failed. Try a different approach or be more concise.)`
      : '';

    const workerPrompt = [
      `You are worker agent "${currentAgent.name}" (${currentAgent.category}). You have tool access — use tools to complete the task, don't just describe what to do.`,
      `Task: ${compactTaskForPlanning(subTask.description, 7000)}${retryHint}`,
      'Context boundary: use only the task inputs and referenced paths. Do not inspect the clipboard, unrelated files, databases, usage logs, or unrelated application state unless the task explicitly requests that source.',
      modeDirective,
      memoryContext ? `Relevant memories:\n${memoryContext}` : '',
      'Complete this sub-task using available tools. Output the final result.',
    ].filter(Boolean).join('\n\n');

    try {
      const messages: NormalizedMessage[] = [{ role: 'user', content: workerPrompt }];
      // Workers inherit the task intent: ordinary tool use stays low-friction, while
      // high-consequence actions cannot bypass the Action Constitution.
      const workerContext = {
        userId: context.userId,
        requestConfirmation: async (toolName: string, args: Record<string, any>) =>
          canAutoApproveAction(toolName, args, { actionIntent: subTask.description }),
        actionIntent: subTask.description,
        source: 'orchestrator',
        desktopRelay: context.desktopRelay,
        isCancelled: context.isCancelled,
        llmGetters,
        onToolStart: (record: { id: string; name: string; arguments: Record<string, any> }) => {
          onTool?.({
            id: record.id,
            name: record.name,
            arguments: record.arguments,
          }, {
            subTaskId: subTask.id,
            agentId: currentAgent.id,
            agentName: currentAgent.name,
          });
        },
      };
      const WORKER_TIMEOUT_MS = 240_000;
      const timeoutPromise = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('Worker timed out after 4 minutes')), WORKER_TIMEOUT_MS),
      );
      const result = await Promise.race([
        runWithTools(
          messages,
          toolRegistry,
          {
            provider: llmConfig.provider,
            model: llmConfig.model,
            maxTokens: 4000,
            userId: llmConfig.userId || context.userId,
            domain: llmConfig.domain || context.domain,
            orgId: llmConfig.orgId || context.orgId,
          },
          (record) => onTool?.(record, {
            subTaskId: subTask.id,
            agentId: currentAgent.id,
            agentName: currentAgent.name,
          }),
          isRetry ? 12 : 8,
          llmGetters.getDeepSeek,
          llmGetters.getGemini,
          llmGetters.getOpenAI,
          llmGetters.getAnthropic,
          llmGetters.getQwen,
          undefined,
          workerContext,
          llmGetters.getOllama,
          llmGetters.getLmStudio,
          llmGetters.getArk,
          llmGetters.getXiaomi,
          llmGetters.getKimi,
          llmGetters.getGlm,
          llmGetters.getRelay,
        ),
        timeoutPromise,
      ]);
      throwIfCancelled(context);

      // Record token usage for each LLM call within this worker
      for (const u of (result.usageRecords || [])) {
        recordTokenUsage(context.userId, u.provider, u.model, { promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.totalTokens }, `orch_worker_${Date.now()}`, 'orchestrator');
      }

      if (isRetry) {
        console.log(`[Orchestrator] Worker '${agent.name}' failed on attempt ${attempt}, succeeded with '${currentAgent.name}'`);
      }

      return {
        subTaskId: subTask.id,
        output: buildWorkerOutput(result.text.trim(), result.toolCalls),
        agentId: currentAgent.id,
      };
    } catch (err) {
      throwIfCancelled(context);
      if (attempt < agentsToTry.length - 1) {
        console.warn(`[Orchestrator] Worker '${currentAgent.name}' failed (attempt ${attempt + 1}/${agentsToTry.length}), trying next...`, String(err).slice(0, 80));
        continue;
      }
      return {
        subTaskId: subTask.id,
        output: `[Worker failed after ${agentsToTry.length} attempt(s): ${String(err).slice(0, 200)}]`,
        agentId: agent.id,
      };
    }
  }

  // Unreachable but TypeScript needs it
  return {
    subTaskId: subTask.id,
    output: '[Worker failed: all agents exhausted]',
    agentId: agent.id,
  };
}

/**
 * Execute the full workflow: topological sort → parallel groups → aggregate.
 * Workers that fail are automatically retried with fallback agents.
 */
export async function executeWorkflow(
  assignments: WorkerAssignment[],
  context: OrchestrationContext,
  llmConfig: ScopedLLMConfig,
  llmGetters: LlmGetters,
  fallbackAgents: AgentRecord[] = [],
  onTool?: OrchestrationToolCallback,
): Promise<WorkflowResult> {
  const groups = topologicalGroups(assignments);

  const allResults: Array<{ subTaskId: string; output: string; agentId: string }> = [];
  const usedAgentIds = new Set<string>();

  for (const group of groups) {
    throwIfCancelled(context);
    // Execute group in parallel
    const groupResults = await Promise.all(
      group.map(a => {
        usedAgentIds.add(a.agent.id);
        return executeWorkerTask(a, context, llmConfig, llmGetters, fallbackAgents, onTool);
      }),
    );
    // Only record routing success if worker actually succeeded (not error string)
    for (let k = 0; k < group.length; k++) {
      const a = group[k];
      const result = groupResults[k];
      if (!result.output || !result.output.startsWith('[Worker failed')) {
        recordRoutingSuccess(a.subTask.requiredSkill, a.agent.id);
      }
    }
    allResults.push(...groupResults);
    throwIfCancelled(context);
  }

  // Aggregate results
  throwIfCancelled(context);
  const aggregatedOutput = aggregateResults(allResults, assignments);

  // Crystallize workflow result as a growth memory for future reuse
  try {
    const usedAgentIdsArr = Array.from(usedAgentIds);
    const mem = addMemory({
      userId: context.userId,
      type: 'knowledge',
      content: `[Orchestrated Workflow] ${aggregatedOutput.slice(0, 400)}`,
      keywords: ['orchestrated', 'workflow', ...assignments.map(a => a.subTask.requiredSkill)],
      confidence: 0.75,
      sourceInteractionId: `orch_${Date.now()}`,
    }, {
      tier: 'growth',
      perspective: 'lumi_growth',
      importance: 0.7,
      domain: context.domain,
      orgId: context.orgId,
    });
    // Mark for cross-agent sharing so other agents can learn from this workflow
    mem.crossAgentShare = true;
    mem.sharedToAgentIds = usedAgentIdsArr;
  } catch (err) {
    // Non-critical — workflow succeeded even if crystallization fails
  }

  return {
    subTaskResults: allResults,
    aggregatedOutput,
    totalAgentsUsed: usedAgentIds.size,
  };
}

// ── Result aggregation ──

const AGGREGATE_PROMPT = `You are Lumi, the master orchestrator. Synthesize the following worker outputs into a single, coherent response for the user.

Original task: {task}

Worker outputs:
{workerOutputs}

Synthesize these results. Fill in gaps. Resolve contradictions. Output the final answer directly — no meta-commentary about workers or aggregation.`;

function aggregateResults(
  results: Array<{ subTaskId: string; output: string; agentId: string }>,
  assignments: WorkerAssignment[],
): string {
  if (results.length === 0) return 'No results produced.';
  if (results.length === 1) return results[0].output;

  // For now, concatenate with clear separation. LLM aggregation happens in the chat pipeline.
  return results
    .map((r) => {
      const subTask = assignments.find(a => a.subTask.id === r.subTaskId)?.subTask;
      return `### ${subTask?.description?.slice(0, 60) || r.subTaskId}\n${compactTextBlock(r.output, 9000, 'worker output')}`;
    })
    .join('\n\n');
}

/**
 * Full LLM aggregation — call this from the chat pipeline after executeWorkflow.
 */
export async function aggregateWithLLM(
  workflowResult: WorkflowResult,
  originalTask: string,
  llmConfig: ScopedLLMConfig,
  llmGetters: LlmGetters,
  userId?: string,
  scope?: { domain?: string; orgId?: string },
): Promise<string> {
  const workerOutputs = workflowResult.subTaskResults
    .map(r => `[${r.subTaskId}] ${compactTextBlock(r.output, 3500, 'worker output')}`)
    .join('\n\n---\n\n');

  const prompt = AGGREGATE_PROMPT
    .replace('{task}', compactTaskForPlanning(originalTask, 6000))
    .replace('{workerOutputs}', workerOutputs);

  try {
    const messages: NormalizedMessage[] = [
      { role: 'system', content: buildResponseLanguageInstruction(originalTask) },
      { role: 'user', content: prompt },
    ];
    const result = await makeLLMCall(
      messages,
      [],
      {
        provider: llmConfig.provider,
        model: llmConfig.model,
        maxTokens: 4000,
        userId,
        domain: llmConfig.domain || scope?.domain,
        orgId: llmConfig.orgId || scope?.orgId,
      },
      llmGetters.getDeepSeek,
      llmGetters.getGemini,
      llmGetters.getOpenAI,
      llmGetters.getAnthropic,
      llmGetters.getQwen,
      llmGetters.getOllama,
      llmGetters.getLmStudio,
      llmGetters.getArk,
      llmGetters.getXiaomi,
      llmGetters.getKimi,
      llmGetters.getGlm,
      llmGetters.getRelay,
    );
    if (userId) {
      recordTokenUsage(userId, llmConfig.provider, llmConfig.model, result.usage, `orch_aggregate_${Date.now()}`, 'orchestrator');
    }
    return result.text.trim();
  } catch (err) {
    console.error('[Orchestrator] LLM aggregation failed:', err);
    return workflowResult.aggregatedOutput;
  }
}

// ── Skill distillation ──

interface WorkflowPattern {
  taskPrefix: string;
  subTaskCount: number;
  skillTags: string[];
  timestamp: string;
}

/** In-memory store of recent workflow patterns for distillation heuristics */
const recentPatterns: WorkflowPattern[] = [];

/**
 * After a complex workflow completes, record it to the worklog for pattern detection
 * and check if the pattern is reusable (≥ 2 times in 7 days = candidate for skill generation).
 */
export function recordWorkflowPattern(
  task: string,
  subTaskCount: number,
  skillTags: string[],
  userId?: string,
  domain: string = 'personal',
  orgId: string = '',
): void {
  // Feed the worklog-based skill distillation pipeline
  if (userId && subTaskCount >= 2) {
    try {
      recordWorkflow({
        userId,
        domain: domain === 'work' ? 'work' : 'personal',
        orgId: domain === 'work' ? orgId : '',
        userIntent: task.slice(0, 120),
        toolSequence: skillTags.map(tag => ({
          name: `orchestrator_${tag}`,
          args: { skillTag: tag },
          resultSummary: `Worker executed ${tag} sub-task`,
        })),
        conversationExcerpt: task.slice(0, 200),
      });
    } catch (err) {
      // Worklog recording is non-critical
    }
  }

  const prefix = task.slice(0, 80).toLowerCase();
  recentPatterns.push({
    taskPrefix: prefix,
    subTaskCount,
    skillTags,
    timestamp: new Date().toISOString(),
  });

  // Keep only last 30 days
  const cutoff = Date.now() - 30 * 86400000;
  while (recentPatterns.length > 0 && new Date(recentPatterns[0].timestamp).getTime() < cutoff) {
    recentPatterns.shift();
  }

  // Cap at 100 entries
  while (recentPatterns.length > 100) {
    recentPatterns.shift();
  }
}

/**
 * Check if the current task pattern has been seen recently.
 * Uses word-level Jaccard similarity (≥ 60% overlap = similar).
 * Returns true if ≥ 2 similar patterns appeared in the last 7 days.
 */
export function shouldDistillSkill(task: string): boolean {
  const words = new Set(task.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  const sevenDaysAgo = Date.now() - 7 * 86400000;

  let similarCount = 0;
  for (const p of recentPatterns) {
    if (new Date(p.timestamp).getTime() < sevenDaysAgo) continue;
    const pWords = new Set(p.taskPrefix.split(/\s+/).filter(w => w.length > 1));
    const intersection = [...words].filter(w => pWords.has(w)).length;
    const union = new Set([...words, ...pWords]).size;
    if (union > 0 && intersection / union >= 0.6) {
      similarCount++;
    }
  }

  return similarCount >= 2;
}

/**
 * Build a skill description suitable for passing to autoGenerateSkill().
 */
export function buildSkillDescription(
  task: string,
  workflowResult: WorkflowResult,
): string {
  const subTaskDescriptions = workflowResult.subTaskResults
    .map(r => `- ${r.subTaskId}: ${compactTextBlock(r.output, 500, 'worker output').slice(0, 500)}`)
    .join('\n');

  return [
    `Auto-generated skill for recurring task pattern.`,
    `Task: ${task}`,
    `Sub-tasks (${workflowResult.totalAgentsUsed} agents used):`,
    subTaskDescriptions,
    `\nThis skill automates the full workflow. Input: task description. Output: aggregated result.`,
  ].join('\n');
}

// ── Shared orchestration pipeline (used by both chat.ts and voice.ts) ──

export interface OrchestratedResult {
  responseText: string;
  workflowResult: WorkflowResult;
}

/**
 * Run the full orchestrator pipeline: classify → decompose → match → execute → aggregate.
 * Returns null if the task is too simple or no agents are available (caller should fall
 * back to normal LLM path).
 */
export async function runOrchestratedTask(
  text: string,
  context: OrchestrationContext,
  llmConfig: ScopedLLMConfig,
  llmGetters: LlmGetters,
  onProgress?: (message: string) => void,
  onTool?: OrchestrationToolCallback,
): Promise<OrchestratedResult | null> {
  throwIfCancelled(context);
  const complexity = classifyComplexity(text, context);
  if (complexity !== 'complex' && complexity !== 'moderate') return null;

  const db = readDB();
  const availableAgents = (db.agents || []).filter((a: any) => agentAvailableForContext(a, context));
  if (availableAgents.length < 1) return null;

  throwIfCancelled(context);
  const subTasks = await decomposeTask(text, llmConfig, context, llmGetters);
  throwIfCancelled(context);
  const capped = complexity === 'moderate'
    ? subTasks.slice(0, Math.min(2, subTasks.length))
    : subTasks;

  onProgress?.(`[Orchestrator] Decomposed into ${capped.length} sub-tasks\n`);

  const assignments = matchWorkers(capped, availableAgents);
  onProgress?.(`[Orchestrator] Assigned to ${assignments.length} worker(s)\n`);

  throwIfCancelled(context);
  const workflowResult = await executeWorkflow(assignments, context, llmConfig, llmGetters, availableAgents, onTool);
  throwIfCancelled(context);

  const aggregated = complexity === 'moderate' && capped.length <= 2
    ? workflowResult.aggregatedOutput
    : await aggregateWithLLM(workflowResult, text, llmConfig, llmGetters, context.userId, { domain: context.domain, orgId: context.orgId });
  throwIfCancelled(context);

  // Record workflow pattern for future skill distillation
  const skillTags = capped.map(s => s.requiredSkill);
  recordWorkflowPattern(text, capped.length, skillTags, context.userId, context.domain || 'personal', context.orgId || '');

  onProgress?.(`\n[Orchestrator] Workflow complete — ${workflowResult.totalAgentsUsed} agent(s) used\n`);

  return { responseText: aggregated, workflowResult };
}

/** Clean up ephemeral agents older than the TTL (default 6 hours) */
export function cleanupEphemeralAgents(ttlHours: number = 6): number {
  try {
    const db = readDB();
    if (!db.agents || db.agents.length === 0) return 0;

    const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
    const before = db.agents.length;

    db.agents = db.agents.filter((a: any) => {
      if (!a.id || !a.id.startsWith('ephemeral_')) return true;
      const created = new Date(a.createdAt || 0).getTime();
      return created > cutoff;
    });

    const removed = before - db.agents.length;
    if (removed > 0) {
      // Clean up orphaned interactions for removed agents
      const removedIds = new Set<string>();
      // We already filtered, so we'd need to track removed IDs differently
      if (db.interactions) {
        db.interactions = db.interactions.filter((i: any) => {
          if (!i.agentId || !i.agentId.startsWith('ephemeral_')) return true;
          const created = new Date(i.timestamp || 0).getTime();
          return created > cutoff;
        });
      }
      // Clean up orphaned memories
      if (db.memories) {
        db.memories = db.memories.filter((m: any) => {
          if (!m.agentId || !m.agentId.startsWith('ephemeral_')) return true;
          const created = new Date(m.createdAt || 0).getTime();
          return created > cutoff;
        });
      }
      writeDB(db);
      console.log(`[Orchestrator] Cleaned up ${removed} ephemeral agents`);
    }
    return removed;
  } catch (err) {
    console.warn('[Orchestrator] Ephemeral cleanup failed:', err);
    return 0;
  }
}
