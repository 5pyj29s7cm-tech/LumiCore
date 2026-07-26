import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { readDB, writeDB } from '../../../db_layer';
import { validateExternalCommand } from '../../agents/external_runtime';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

function normalizeStringList(value: unknown, max = 20): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return Array.from(new Set(raw
    .map(item => String(item || '').trim().toLowerCase())
    .filter(Boolean)
    .slice(0, max)));
}

const BUILTIN_AGENT_IDS = ['lumi', 'lumi_default', 'scholar_default', 'founder_default', 'incubated'];

function agentInToolScope(agent: any, context?: ToolContext): boolean {
  if (!agent || agent.id?.startsWith?.('ephemeral_')) return false;
  const domain = context?.domain === 'work' ? 'work' : 'personal';
  if (domain === 'work') {
    return !!context?.orgId && (agent.orgId || '') === context.orgId && (agent.domain || 'work') === 'work';
  }
  if (agent.domain === 'work' || agent.orgId) return false;
  if (context?.userId && agent.ownerUid && agent.ownerUid !== context.userId) return false;
  return true;
}

async function agentCreate(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const name = (args.name || '').trim();
  if (!name) throw new Error('Agent name is required.');

  const category = (args.category || 'general').trim().toLowerCase();
  const skillTags = normalizeStringList(args.skillTags);
  const description = (args.description || '').trim();
  const executionMode = args.executionMode || 'lumi';
  const modelPreference = args.model || 'deepseek-v4-flash';
  const knowledgeDomains = normalizeStringList(args.knowledgeDomains);
  const autonomyLevel = args.autonomyLevel || 'reactive';
  const runtime = args.runtime === 'external' ? 'external' : 'internal';
  const externalCommand = (args.externalCommand || '').trim() || undefined;
  const domain = context?.domain === 'work' ? 'work' : 'personal';
  const orgId = domain === 'work' ? (context?.orgId || '') : '';

  if (runtime === 'external' && !externalCommand) {
    throw new Error('External agents must provide an externalCommand.');
  }
  if (runtime === 'external' && externalCommand) {
    const validationError = validateExternalCommand(externalCommand);
    if (validationError) throw new Error(validationError);
  }

  const id = `worker_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const agent: Record<string, any> = {
    id,
    ownerUid: context?.userId || '',
    userId: context?.userId || '',
    name,
    category,
    config: JSON.stringify({ description, knowledgeDomains }),
    data: '{}',
    createdAt: new Date().toISOString(),
    status: 'active',
    modelPreference,
    memoryScope: 'shared',
    autonomyLevel,
    runtimeConfig: '{}',
    skillTags,
    executionMode,
    allowCrossPollination: true,
    territory: 'open',
    runtime,
    ...(externalCommand ? { externalCommand } : {}),
    domain,
    orgId,
    healthStatus: runtime === 'external' ? 'untested' : 'online',
  };

  try {
    const db = readDB();
    if (!db.agents) db.agents = [];
    db.agents.push(agent);
    writeDB(db);
    return JSON.stringify({
      ok: true,
      status: 'created',
      agent: { id, name, category, skillTags, status: 'active' },
      message: `Worker agent "${name}" created and ready. ID: ${id}`,
    });
  } catch (err: any) {
    throw new Error(`Failed to create agent: ${err.message || String(err)}`);
  }
}

async function agentList(_args: Record<string, any>, context?: ToolContext): Promise<string> {
  try {
    const db = readDB();
    const agents = (db.agents || []).filter((a: any) => agentInToolScope(a, context));

    if (agents.length === 0) {
      return 'No active worker agents found. Use agent_create to spawn one when needed.';
    }

    const summary = agents.map((a: any) => ({
      id: a.id,
      name: a.name,
      category: a.category,
      skillTags: a.skillTags || [],
      status: a.status,
      territory: a.territory || 'open',
      runtime: a.runtime || 'internal',
      healthStatus: a.healthStatus || (a.runtime === 'external' ? 'untested' : 'online'),
      isFrozen: a.isFrozen === true,
      createdAt: a.createdAt,
    }));

    return JSON.stringify(summary, null, 2);
  } catch (err: any) {
    return `Failed to list agents: ${err.message || String(err)}`;
  }
}

async function agentTerminate(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const agentId = (args.agentId || '').trim();
  const terminateAll = args.all === true;

  try {
    const db = readDB();
    if (!db.agents) db.agents = [];

    if (terminateAll) {
      const activeAgents = db.agents.filter((a: any) =>
        a.status === 'active' &&
        !BUILTIN_AGENT_IDS.includes(a.id) &&
        agentInToolScope(a, context)
      );
      if (activeAgents.length === 0) {
        return JSON.stringify({ ok: true, status: 'no_op', terminated: 0, reason: 'No active agents in the current scope.' });
      }
      const activeIds = new Set(activeAgents.map((a: any) => a.id));
      const count = activeAgents.length;
      for (const agent of db.agents) {
        if (activeIds.has(agent.id)) {
          agent.status = 'terminated';
          agent.terminatedAt = new Date().toISOString();
        }
      }
      writeDB(db);
      return JSON.stringify({
        ok: true,
        status: 'terminated',
        terminated: count,
        message: `Terminated all ${count} active agents.`,
      });
    }

    if (!agentId) {
      throw new Error('Specify agentId or set all=true to terminate all agents.');
    }

    if (BUILTIN_AGENT_IDS.includes(agentId)) {
      throw new Error(`Cannot terminate built-in agent "${agentId}".`);
    }

    const agent = db.agents.find((a: any) => a.id === agentId && agentInToolScope(a, context));
    if (!agent) {
      throw new Error(`Agent "${agentId}" not found.`);
    }
    if (agent.status === 'terminated') {
      return JSON.stringify({ ok: true, status: 'no_op', terminated: 0, agent: { id: agent.id, name: agent.name, status: 'terminated' } });
    }

    agent.status = 'terminated';
    agent.terminatedAt = new Date().toISOString();
    writeDB(db);

    return JSON.stringify({
      ok: true,
      status: 'terminated',
      terminated: 1,
      agent: { id: agent.id, name: agent.name, status: 'terminated' },
      message: `Agent "${agent.name}" (${agent.id}) terminated.`,
    });
  } catch (err: any) {
    throw new Error(`Failed to terminate agent(s): ${err.message || String(err)}`);
  }
}

export function registerAgentTools(registry: ToolRegistry): void {
  registry.register({
    name: 'agent_create',
    description:
      'Create a new permanent worker agent for Lumi\'s swarm. Use this when the user asks you to make a helper, specialist, or worker for a recurring task. The agent becomes an active member of the hive — it can be assigned sub-tasks by the orchestrator and appears in the user\'s agent list.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A short, memorable name for the agent (e.g. "EmailBot", "CodeReviewer", "DataScout")' },
        category: { type: 'string', description: 'The general domain: coding, writing, research, data, media, automation, etc.' },
        skillTags: { type: 'array', items: { type: 'string' }, description: 'Specific skill tags for task matching (e.g. ["python", "data-analysis"])' },
        description: { type: 'string', description: 'What this agent specializes in — used as its internal config' },
        executionMode: { type: 'string', description: 'Thinking mode: lumi (default), scholar, founder, or zen' },
        model: { type: 'string', description: 'Preferred LLM model (default: deepseek-v4-flash)' },
        knowledgeDomains: { type: 'array', items: { type: 'string' }, description: 'Knowledge domains for RAG routing' },
        autonomyLevel: { type: 'string', description: 'reactive (on-demand only), scheduled (periodic checks), or autonomous (self-triggering)' },
        runtime: { type: 'string', description: '"internal" (LLM-powered, default) or "external" (CLI process like OpenClaw/Hermes)' },
        externalCommand: { type: 'string', description: 'CLI command template for external agents. Use {task} placeholder. e.g. "openclaw send --agent mybot --message \\"{task}\\""' },
      },
      required: ['name'],
    },
    handler: agentCreate,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'agents.worker.create',
      family: 'agent-lifecycle',
      lane: 'agents',
      operation: 'create',
      risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'persistent worker agent registry', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'agent.id', 'agent.status'],
        requiredValues: { ok: true, status: 'created', 'agent.status': 'active' },
        successStatuses: ['created'],
        failureStatuses: ['failed'],
        successSignals: ['persistent agent record exists with active status'],
        limitations: ['Creation does not prove that an external agent runtime is online or capable.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'agents.worker.create',
      operation: 'create',
      subjectArgument: 'name',
      limitations: ['External runtime health remains unverified until a task is accepted and completed.'],
    }),
  });

  registry.register({
    name: 'agent_list',
    description:
      'List all active worker agents in Lumi\'s swarm. Use this to show the user what agents currently exist, their skills, and status.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: agentList,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'agent_terminate',
    description:
      'Terminate one or all active agents. Set agentId to terminate a specific agent, or set all=true to terminate every active agent at once. Terminated agents are marked as status="terminated" and will no longer appear in agent_list.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of the agent to terminate (optional if all=true)' },
        all: { type: 'boolean', description: 'Set to true to terminate ALL active agents at once' },
      },
      required: [],
    },
    handler: agentTerminate,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'agents.worker.terminate',
      family: 'agent-lifecycle',
      lane: 'agents',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'persistent worker agent status', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'terminated'],
        requiredValues: { ok: true },
        successStatuses: ['terminated', 'no_op'],
        failureStatuses: ['failed', 'not_found'],
        successSignals: ['target agents are marked terminated or no active target exists'],
        limitations: ['Termination updates the registry; external runtimes may require separate process shutdown.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'agents.worker.terminate',
      operation: 'mutate',
      subjectArgument: 'agentId',
      limitations: ['External runtime process shutdown is outside this registry-state receipt.'],
    }),
  });
}
