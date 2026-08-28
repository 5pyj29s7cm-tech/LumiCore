import type { ToolRegistry } from '../tools/registry';
import { getAdapterRegistry } from '../adapters/registry';
import { mcpManager } from '../mcp/client';
import { listSkillWorkflows } from '../skills/workflow_registry';
import { getActiveWorkTakeoverTasksForContinuity } from '../work_takeover/continuity';
import type { CapabilityManifestEntry } from '../tools/types';
import type { LumiTurnFlow } from './turn_flow';

export interface LumiRuntimeCapabilityContextInput {
  userId: string;
  text: string;
  flow: LumiTurnFlow;
  toolRegistry: ToolRegistry;
  domain?: string;
  orgId?: string;
}

function compact(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function groupCapabilities(manifest: CapabilityManifestEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of manifest) {
    const key = `${entry.source}:${entry.family}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}=${count}`);
}

function mcpHealthGateLines(manifest: CapabilityManifestEntry[]): string[] {
  try {
    const config = mcpManager.getConfig();
    const health = mcpManager.getServerHealth();
    const connected = new Set(mcpManager.getConnectedServers());
    const available = new Set(mcpManager.getAvailableServers());
    const enabledNames = Object.entries(config)
      .filter(([, cfg]) => Boolean(cfg.enabled))
      .map(([name]) => name);
    const unavailableEnabled = enabledNames
      .filter(name => !available.has(name))
      .map(name => {
        const cfg = config[name];
        const status = health[name]?.status || 'disconnected';
        const keyHint = cfg.requiresApiKey && cfg.apiKeyEnv ? `, needs ${cfg.apiKeyEnv}` : '';
        return `${name}(${status}${keyHint})`;
      });
    const declaredMcpServers = Array.from(new Set(
      manifest
        .filter(entry => entry.source === 'mcp' || entry.source === 'skill')
        .map(entry => entry.provider)
        .filter(Boolean) as string[],
    ));
    const staleDeclared = available.size
      ? declaredMcpServers.filter(name => !available.has(name))
      : [];
    return [
      `MCP health gate: available=${available.size}/${enabledNames.length} enabled (${connected.size} active, ${Math.max(0, available.size - connected.size)} on demand).`,
      unavailableEnabled.length
        ? `Unavailable enabled MCP/skills: ${unavailableEnabled.slice(0, 8).join(', ')}${unavailableEnabled.length > 8 ? ', ...' : ''}.`
        : 'Unavailable enabled MCP/skills: none.',
      staleDeclared.length
        ? `Do not prefer stale MCP tool declarations from: ${staleDeclared.slice(0, 8).join(', ')}. Use connected fallback, client_repair_skill, open_skills, or ask for missing API/setup.`
        : 'Prefer connected MCP tools; repair/configure before relying on disconnected skills.',
    ];
  } catch (err: any) {
    return [`MCP health gate unavailable: ${String(err?.message || err || 'unknown error')}.`];
  }
}

function relevantAdapters(
  flow: LumiTurnFlow,
  userId: string,
  manifest: CapabilityManifestEntry[],
): string[] {
  try {
    const registry = getAdapterRegistry({ userId, capabilityManifest: manifest });
    const desired = new Set<string>();
    if (flow.workTakeover.activeTasks.length || flow.surface === 'work') desired.add('automation');
    if (flow.workSurfaceRoute.directDesktop || flow.workSurfaceRoute.artifactFirst) desired.add('automation');
    if (flow.workSurfaceRoute.artifactFirst) desired.add('cad_bim');
    if (flow.visionIntent || flow.clientActionOnlyTurn || flow.selfRepairTurn) desired.add('client');
    if (/微信|消息|客户|wechat|message/i.test(flow.routeText)) desired.add('messaging');
    if (/网页|浏览器|搜索|登录|店铺|账号|平台|browser|web|login|store|creator/i.test(flow.routeText)) desired.add('web');
    if (/技能|MCP|工具|agent|能力|接入|skill|tool|adapter/i.test(flow.routeText)) desired.add('ai');
    if (!desired.size) {
      desired.add('client');
      desired.add('automation');
    }
    return registry.adapters
      .filter(adapter => desired.has(adapter.category) || adapter.id.includes('work_takeover') || adapter.id.includes('self_extension'))
      .slice(0, 8)
      .map(adapter => `${adapter.label} (${adapter.id}) status=${adapter.status}${adapter.requiresConfirmation ? ', hard-boundary' : ''}`);
  } catch {
    return ['Adapter registry unavailable.'];
  }
}

function activeTasksForTurn(input: LumiRuntimeCapabilityContextInput) {
  return input.flow.workTakeover.activeTasks.length
    ? input.flow.workTakeover.activeTasks
    : getActiveWorkTakeoverTasksForContinuity(input.userId, {
      domain: input.domain,
      orgId: input.orgId,
      limit: 3,
    });
}

function activeTaskLines(
  input: LumiRuntimeCapabilityContextInput,
  tasks: ReturnType<typeof activeTasksForTurn>,
): string[] {
  const binding = input.flow.workTakeover.shouldResumeTask
    ? 'confirmed-by-current-turn'
    : 'unconfirmed-candidate';
  return tasks.slice(0, 3).map(task => {
    const next = compact(task.nextActions[task.currentActionIndex]) || compact(task.nextActions[0]);
    const artifacts = task.artifacts.filter(a => a.status === 'prepared' || a.status === 'needs_review').map(a => a.label).slice(0, 3);
    return [
      `${task.title} [${task.id}]`,
      'source=persisted work-takeover ledger',
      `binding=${binding}`,
      `status=${task.status}`,
      `category=${task.category}`,
      next ? `next=${next}` : '',
      artifacts.length ? `artifacts=${artifacts.join(', ')}` : '',
      task.confirmationRequired.length ? `confirm=${task.confirmationRequired.slice(0, 2).join('; ')}` : '',
      task.blockedBy.length ? `blocked=${task.blockedBy.slice(0, 2).join('; ')}` : '',
    ].filter(Boolean).join(' | ');
  });
}

function activeTaskContext(input: LumiRuntimeCapabilityContextInput): string {
  const tasks = activeTasksForTurn(input);
  if (tasks.length === 0) return 'Unfinished task inventory: none.';

  if (input.flow.workTakeover.shouldResumeTask) {
    return [
      '## Bound active task evidence',
      'The current turn explicitly refers to the persisted task below. Its fields come from the task ledger; keep current-turn facts separate from old task fields and rely on receipts for execution claims.',
      ...activeTaskLines(input, tasks).map(line => `- ${line}`),
    ].join('\n');
  }

  if (input.flow.workTakeover.strength === 'hint' || input.flow.surface === 'work') {
    return [
      '## Unbound active task candidates',
      'These candidates come from the persisted task ledger, but the current turn has not confirmed that it refers to any of them.',
      'A shared word, similar embedding, name fragment, code prefix, or related topic is retrieval evidence only; it is not entity identity. Do not transfer a candidate\'s customer/project/task type, fields, status, plan, or confirmation boundary onto a current-turn name or code unless the user or same-conversation history explicitly binds them. Ask one short clarification when the distinction matters.',
      ...activeTaskLines(input, tasks).map(line => `- ${line}`),
    ].join('\n');
  }

  return [
    'Unfinished task inventory: available (details disclosed=0).',
    'Task details are intentionally omitted because this turn did not refer to a persisted task. The tasks remain available through task capabilities if the user explicitly asks for them. Do not infer a relationship between this turn and an unfinished task.',
  ].join('\n');
}

function skillLines(flow: LumiTurnFlow): string[] {
  const workflows = listSkillWorkflows();
  const matched = flow.specialWorkflow;
  const relevant = matched
    ? [matched, ...workflows.filter(workflow => workflow.id !== matched.id).slice(0, 3)]
    : workflows.slice(0, 5);
  return relevant.map(workflow => `${workflow.skillId}/${workflow.id}${matched?.id === workflow.id ? ' (matched)' : ''}`);
}

export function buildLumiRuntimeCapabilityContext(input: LumiRuntimeCapabilityContextInput): string {
  const manifest = input.toolRegistry.getCapabilityManifest();
  const taskContext = activeTaskContext(input);
  const adapterLines = relevantAdapters(input.flow, input.userId, manifest);
  const workflows = skillLines(input.flow);
  const capabilityGroups = groupCapabilities(manifest);
  const mcpLines = mcpHealthGateLines(manifest);

  return [
    '## Lumi Runtime Capability Context',
    'This is the compact runtime map for this turn. Lumi is the single execution subject; tools, skills, task center, browser, desktop, and external software are capabilities LumiCore may choose after understanding the user.',
    `Input surface=${input.flow.surface}; mode=${input.flow.operationMode}->${input.flow.effectiveOperationMode}; tools=${input.flow.allowToolUseForTurn ? 'available' : 'not for this turn'}; taskSignal=${input.flow.workTakeover.intent || 'none'}/${input.flow.workTakeover.strength}.`,
    'Per-turn tool access is a mode gate, not an installation inventory. Never claim a capability is absent only because its tools are hidden for this turn; an explicit action in Chat should move the turn to Assistant, while Autonomy remains the continuous 24-hour mode.',
    `Execution governance: verify=${input.flow.executionGovernance.verificationIntent}; capabilityLearning=${input.flow.executionGovernance.capabilityLearningIntent}; inspectCapabilitiesFirst=${input.flow.executionGovernance.shouldInspectCapabilitiesFirst ? 'yes' : 'no'}.`,
    `Capability manifest: ${manifest.length} registered tools; ${manifest.filter(entry => entry.hasEvidenceContract).length} have declared evidence contracts (${manifest.filter(entry => entry.evidence?.declarationSource === 'tool_definition').length} tool-specific, remainder conservative manifest policy).`,
    `Capability families available: ${capabilityGroups.join(', ') || 'none'}.`,
    ...mcpLines,
    `Skill workflows known: ${workflows.join(', ') || 'none'}.`,
    taskContext,
    adapterLines.length
      ? ['Relevant adapters/external systems:', ...adapterLines.map(line => `- ${line}`)].join('\n')
      : 'Relevant adapters/external systems: none.',
    'Use this order: understand the turn -> decide chat/work -> if persistent work, bind/create task -> if repeatable pattern, use skill workflow -> if external execution is needed, choose adapter/tool -> verify result -> report humanly.',
  ].join('\n');
}
