import { ToolRegistry } from '../registry';
import { executeToolCallOrThrow } from '../execution_engine';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import {
  getClientActionExpectation,
  getClientCapabilities,
  getClientHealthReport,
  getClientInterfaceSurfaces,
  getClientSelfAwarenessReport,
  getClientState,
  getClientStateForScope,
  getClientStateDigest,
  getVisibleExecutionHabits,
  verifyClientActionResult,
} from '../../client/self_model';
import { getLumiTechnicalArchitecture } from '../../../shared/technical_architecture';
import { getGateConfig } from '../../autonomy/safety_gate';
import { listAutonomousWorkflows } from '../../autonomy/workflows';
import { mcpManager } from '../../mcp';
import { isExplicitSensitiveClientActionRequest } from '../action_constitution';
import { PERSONAL_CLIENT_SURFACE_ACTIONS } from '../../../shared/client_surfaces';
import {
  safeRuntimeError,
  sanitizeDiagnosticValue,
} from '../../client/diagnostic_sanitizer';

const ACTIONS = Array.from(new Set([
  'set_client_mode',
  'close_client_surface',
  'focus_home',
  'enter_widget_mode',
  'show_desktop_widget',
  'exit_widget_mode',
  'expand_from_widget',
  ...PERSONAL_CLIENT_SURFACE_ACTIONS,
  'close_nexus',
  'start_meeting_mode',
  'end_meeting_mode',
  'open_meeting_notes',
  'open_organization_workspace',
  'refresh_client_state',
  'set_wallpaper_mode',
]));

const RECOVERY_SURFACE_ACTIONS: Record<string, { action: string; section?: string }> = {
  skills: { action: 'open_skills' },
  skill: { action: 'open_skills' },
  logs: { action: 'open_computer_adaptation' },
  log: { action: 'open_computer_adaptation' },
  runtime: { action: 'open_computer_adaptation' },
  'runtime-log': { action: 'open_computer_adaptation' },
  knowledge: { action: 'show_knowledge_base' },
  files: { action: 'show_knowledge_base' },
  settings: { action: 'open_settings' },
  kernel: { action: 'open_computer_adaptation' },
  computer: { action: 'open_computer_adaptation' },
  plans: { action: 'open_plans' },
  autonomy: { action: 'open_plans' },
  org: { action: 'open_organization_workspace' },
  organization: { action: 'open_organization_workspace' },
  voice: { action: 'open_voice_forge' },
};

const ACTIONS_WITH_INTERNAL_REFRESH = new Set(['refresh_client_state']);

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function parseRelayOutput(output: string): any {
  if (!output) return output;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

async function waitForClientStateAfter(userId: string, previousUpdatedAt: number, timeoutMs = 1200) {
  const start = Date.now();
  let latest = getClientState(userId);
  while (Date.now() - start < timeoutMs) {
    latest = getClientState(userId);
    if (latest?.updatedAt && latest.updatedAt > previousUpdatedAt) return latest;
    await delay(80);
  }
  return latest;
}

function getSkillRuntimeFindings() {
  const health = mcpManager.getServerHealth();
  const connected = new Set(mcpManager.getConnectedServers());
  const config = mcpManager.getConfig();
  const local = mcpManager.listLocalSkills();
  return Object.entries(config)
    .map(([name, serverConfig]) => {
      const localSkill = local.find(skill => skill.name === name);
      const serverHealth = health[name];
      const enabled = Boolean(serverConfig.enabled);
      const isConnected = connected.has(name);
      const broken = Boolean(localSkill?.broken);
      const status = serverHealth?.status || (isConnected ? 'connected' : 'unknown');
      const hasIssue = broken || ['crashed', 'failed', 'restarting'].includes(status) || (enabled && !isConnected);
      if (!hasIssue) return null;
      return {
        name,
        enabled,
        connected: isConnected,
        broken,
        status,
        consecutiveCrashes: Number(serverHealth?.consecutiveCrashes || 0),
        lastError: safeRuntimeError(serverHealth?.lastError),
        lastCrashTime: serverHealth?.lastCrashTime || undefined,
        lastSuccessfulConnect: serverHealth?.lastSuccessfulConnect || undefined,
        source: serverConfig.source || localSkill?.source || 'unknown',
        description: serverConfig.description || localSkill?.description || name,
        repairTool: `client_repair_skill(skillName="${name}")`,
      };
    })
    .filter(Boolean);
}

function getAutonomyDiagnosticPolicy(userId: string) {
  return {
    ...getGateConfig(userId),
    externalAppAutomationGate: 'removed',
    externalAppExecutionScope: 'foreground_user_requests_use_registered_adapters',
  };
}

function getAutonomyWorkflowDiagnostics(userId: string) {
  return listAutonomousWorkflows(userId).map((workflow) => {
    const { externalAppsAllowed, ...rest } = workflow;
    return {
      ...rest,
      policyScope: 'unattended_background_workflow',
      backgroundExternalAppsAllowed: externalAppsAllowed,
    };
  });
}

function getCapabilityRuntimeSummary(registry: ToolRegistry) {
  const manifest = registry.getCapabilityManifest();
  const countBy = (key: 'source' | 'operation' | 'configuredSecurityLevel') => (
    Object.fromEntries(
      Array.from(manifest.reduce((counts, entry) => {
        const value = entry[key];
        counts.set(value, (counts.get(value) || 0) + 1);
        return counts;
      }, new Map<string, number>()).entries()).sort(([left], [right]) => left.localeCompare(right)),
    )
  );
  return {
    registeredTools: manifest.length,
    evidenceContracts: manifest.filter(entry => entry.hasEvidenceContract).length,
    bySource: countBy('source'),
    byOperation: countBy('operation'),
    bySecurity: countBy('configuredSecurityLevel'),
  };
}

export function registerClientSelfTools(registry: ToolRegistry): void {
  registry.register({
    name: 'client_get_state',
    description: 'Read Lumi desktop client self-model: local machine/desktop/background runtime awareness, available capabilities, interface map, visible execution habits, and the latest reported UI state.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async (_args, context) => {
      const userId = context?.userId || 'anonymous';
      const scope = { domain: context?.domain, orgId: context?.orgId };
      const isWork = context?.domain === 'work' && Boolean(context?.orgId);
      const state = getClientStateForScope(userId, scope);
      return JSON.stringify(sanitizeDiagnosticValue({
        architecture: getLumiTechnicalArchitecture(),
        selfAwareness: getClientSelfAwarenessReport(userId, scope),
        capabilities: getClientCapabilities(registry.getCapabilityManifest(context?.toolPolicy)),
        interfaceSurfaces: getClientInterfaceSurfaces(),
        visibleExecutionHabits: getVisibleExecutionHabits(),
        capabilityRuntime: getCapabilityRuntimeSummary(registry),
        state: sanitizeDiagnosticValue(state),
        stateDigest: getClientStateDigest(state),
        health: getClientHealthReport(userId, scope),
        skillRuntimeFindings: getSkillRuntimeFindings(),
        autonomyGate: isWork ? null : getAutonomyDiagnosticPolicy(userId),
        autonomyWorkflows: isWork ? [] : getAutonomyWorkflowDiagnostics(userId),
        scope: isWork ? { domain: 'work', orgId: context?.orgId } : { domain: 'personal' },
      }), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'client_capability_manifest',
    description: 'Inspect the authoritative runtime capability manifest shared by Lumi tool discovery, model exposure, permission checks, execution, and diagnostics. Use this instead of guessing whether a tool or Skill exists.',
    routingHints: ['capability manifest', 'available tools and skills', 'Lumi execution capabilities'],
    capability: {
      id: 'client_capability_inventory',
      family: 'client',
      source: 'builtin',
      operation: 'observe',
      domains: ['client', 'runtime'],
    },
    evidence: {
      capability: 'client_capability_inventory',
      operation: 'observe',
      assurance: 'observed',
      subjectArgument: 'query',
      limitations: ['Registered runtime capabilities only; disabled or uninstalled integrations are reported elsewhere.'],
    },
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional capability, tool, Skill, provider, family, or domain search text.',
        },
        source: {
          type: 'string',
          enum: ['builtin', 'mcp', 'skill', 'adapter'],
          description: 'Optional runtime source filter.',
        },
        executableOnly: {
          type: 'boolean',
          description: 'When true, return only capabilities executable under the current turn policy.',
        },
        limit: {
          type: 'number',
          description: 'Maximum matching entries to return. Defaults to 50 and is capped at 200.',
        },
      },
      required: [],
    },
    handler: async (args, context) => {
      const installed = registry.getCapabilityManifest();
      const turnExecutable = new Set(
        registry.getCapabilityManifest(context?.toolPolicy, { executableOnly: true })
          .map(entry => entry.toolName),
      );
      const query = String(args.query || '').trim().toLowerCase();
      const source = String(args.source || '').trim();
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
      const matches = installed
        .filter(entry => !source || entry.source === source)
        .filter(entry => !args.executableOnly || turnExecutable.has(entry.toolName))
        .filter(entry => {
          if (!query) return true;
          return [
            entry.toolName,
            entry.capabilityId,
            entry.family,
            entry.source,
            entry.provider || '',
            entry.description,
            ...entry.domains,
            ...entry.routingTerms,
          ].join(' ').toLowerCase().includes(query);
        });
      return JSON.stringify(sanitizeDiagnosticValue({
        summary: getCapabilityRuntimeSummary(registry),
        query: query || null,
        source: source || null,
        matched: matches.length,
        returned: Math.min(matches.length, limit),
        capabilities: matches.slice(0, limit).map(entry => ({
          ...entry,
          executableThisTurn: turnExecutable.has(entry.toolName),
        })),
      }), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'client_action',
    description: [
      'Safely control Lumi client UI surfaces through the client action router.',
      'Use the explicit action from the complete personal-client interface registry, including personality, notifications, reminders, devices, token usage, terminal, profile, MCP settings, Voice Forge, skill generation, app launcher, knowledge, organization, meeting, and runtime surfaces.',
      'This does not use mouse/keyboard control and should be preferred over computer_use for Lumi client UI navigation.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'Client action to perform.',
        },
        target: {
          type: 'string',
          description: 'Target surface id for close_client_surface.',
        },
        mode: {
          type: 'string',
          enum: ['meeting', 'chat', 'assistant', 'autonomous'],
          description: 'Target Lumi mode for set_client_mode.',
        },
        task: {
          type: 'string',
          description: 'Optional context text for routed client actions.',
        },
        payload: {
          type: 'object',
          description: 'Optional structured payload for a registered client action.',
        },
        resetNotes: {
          type: 'boolean',
          description: 'Optional meeting action flag to reset captured notes before starting meeting mode.',
        },
        legalCaseTitle: {
          type: 'string',
          description: 'Optional case title for legal meeting capture.',
        },
        enabled: {
          type: 'boolean',
          description: 'Desired boolean state, currently used by set_wallpaper_mode.',
        },
        section: {
          type: 'string',
          description: 'Optional section. For open_organization_workspace use dashboard, kb, chat, messaging, templates, review, members, audit, settings, branch, legal, spatial-design, or brand-design. For open_settings use general, neural/autonomy, ai-providers, external-connections, tools, reasoning-model, world-model, generation-model, retrieval-model, voice-model, security, hardware, voice, or computer. Legacy data-sources and applications requests open the matching tab in External Connections. Legacy app-tools, connections-tools, and MCP aliases route to tools; document-model aliases route to world-model; safety-model aliases route to security; model-routing/llm/world/generation/voice-service aliases route to their canonical settings sections.',
        },
        confirmed: {
          type: 'boolean',
          description: 'Set true only when the user explicitly confirmed a confirmation-sensitive action.',
        },
      },
      required: ['action'],
    },
    handler: async (args, context) => {
      if (!context?.desktopRelay) {
        throw new Error('Client actions require the Lumi desktop client relay.');
      }
      const userId = context?.userId || 'anonymous';
      const userConfirmed = Boolean(
        context.userConfirmed
        || isExplicitSensitiveClientActionRequest(args, context),
      );
      const payload = {
        action: args.action,
        target: args.target || '',
        mode: args.mode || '',
        task: args.task || '',
        payload: args.payload,
        resetNotes: Boolean(args.resetNotes),
        legalCaseTitle: args.legalCaseTitle || '',
        enabled: Boolean(args.enabled),
        section: args.section || '',
        confirmed: userConfirmed,
      };
      const before = getClientState(userId);
      const expectation = getClientActionExpectation(payload);
      const previousUpdatedAt = before?.updatedAt || 0;
      const rawRelayOutput = await context.desktopRelay('client_action', payload);
      const relayResult = parseRelayOutput(rawRelayOutput);
      let refreshResult: any = null;

      if (!ACTIONS_WITH_INTERNAL_REFRESH.has(String(args.action || ''))) {
        await delay(140);
        try {
          const rawRefresh = await context.desktopRelay('client_action', { action: 'refresh_client_state' });
          refreshResult = parseRelayOutput(rawRefresh);
        } catch (err: any) {
          refreshResult = { ok: false, error: err?.message || String(err) };
        }
      }

      const after = await waitForClientStateAfter(userId, previousUpdatedAt);
      const verification = verifyClientActionResult(payload, before, after, relayResult);
      return JSON.stringify(sanitizeDiagnosticValue({
        ok: verification.status === 'verified' || verification.status === 'not_applicable',
        action: payload.action,
        target: payload.target || expectation.target || '',
        mode: payload.mode || expectation.mode || '',
        section: payload.section || '',
        expectation,
        relayResult,
        refreshResult,
        verification,
        before: getClientStateDigest(before),
        after: getClientStateDigest(after),
        say: verification.message,
      }), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'client.surface.action',
      family: 'client',
      lane: 'client',
      operation: 'mutate',
      risk: 'low',
      sideEffects: [{
        type: 'desktop_control',
        scope: 'Lumi client surface state only',
        reversible: true,
      }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['verification.status'],
        successSignals: ['verified client state or explicit not_applicable result'],
        limitations: ['A routed action without the refreshed client-state verification remains pending.'],
      },
      domains: ['client'],
      intents: ['navigate or change a registered Lumi client surface'],
    },
    evidence: {
      capability: 'client.surface.action',
      operation: 'mutate',
      assurance: 'verified',
      subjectArgument: 'action',
      limitations: ['Sensitive meeting and wallpaper actions still follow their explicit intent boundary.'],
    },
  });

  registry.register({
    name: 'client_health_check',
    description: 'Run Lumi local self-governance health check: client body state, background/runtime health, runtime errors, files/voice issues, autonomy boundary, and skill runtime findings.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async (_args, context) => {
      const userId = context?.userId || 'anonymous';
      const scope = { domain: context?.domain, orgId: context?.orgId };
      const isWork = context?.domain === 'work' && Boolean(context?.orgId);
      return JSON.stringify(sanitizeDiagnosticValue({
        report: getClientHealthReport(userId, scope),
        skillRuntimeFindings: getSkillRuntimeFindings(),
        autonomyGate: isWork ? null : getAutonomyDiagnosticPolicy(userId),
        autonomyWorkflows: isWork ? [] : getAutonomyWorkflowDiagnostics(userId),
        scope: isWork ? { domain: 'work', orgId: context?.orgId } : { domain: 'personal' },
      }), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'client_self_repair',
    description: [
      'Perform safe Lumi client self-repair actions that do not write user files or operate external apps.',
      'Use refresh_client_state to force a state relay refresh.',
      'Use open_recovery_surface to open the relevant registered Lumi surface (skills, computer adaptation, settings, plans, knowledge, or organization).',
      'For skill package repair use client_repair_skill, which requires confirmation.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['refresh_client_state', 'open_recovery_surface'],
          description: 'Safe self-repair action.',
        },
        surface: {
          type: 'string',
          description: 'Recovery surface for open_recovery_surface: skills, logs/runtime, settings, kernel/computer, plans/autonomy, knowledge/files, organization, or voice.',
        },
      },
      required: ['action'],
    },
    handler: async (args, context) => {
      if (!context?.desktopRelay || !context.toolRegistry) {
        throw new Error('Client self-repair requires the Lumi desktop client relay.');
      }
      let clientAction: Record<string, unknown>;
      if (args.action === 'refresh_client_state') {
        clientAction = JSON.parse(await executeToolCallOrThrow({
          registry: context.toolRegistry,
          name: 'client_action',
          arguments: { action: 'refresh_client_state' },
          context,
        }));
      } else if (args.action === 'open_recovery_surface') {
        const surface = String(args.surface || 'settings').toLowerCase();
        const recovery = RECOVERY_SURFACE_ACTIONS[surface];
        if (!recovery) throw new Error(`Unknown recovery surface: ${surface}`);
        clientAction = JSON.parse(await executeToolCallOrThrow({
          registry: context.toolRegistry,
          name: 'client_action',
          arguments: recovery,
          context,
        }));
      } else {
        throw new Error(`Unsupported client_self_repair action: ${args.action}`);
      }
      return JSON.stringify(sanitizeDiagnosticValue({
        ok: true,
        status: 'verified',
        requestedRepair: args.action,
        delegatedCapability: 'client.surface.action',
        clientAction,
      }), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      ...capabilityContract({
        id: 'client.recovery.surface',
        family: 'client-recovery',
        lane: 'client',
        operation: 'mutate',
        risk: 'low',
        sideEffects: [{ type: 'desktop_control', scope: 'Lumi client recovery surface state', reversible: true }],
        verification: {
          strategy: 'state_diff',
          required: true,
          requiredFields: ['ok', 'status', 'requestedRepair', 'delegatedCapability', 'clientAction.verification.status'],
          requiredValues: { ok: true, status: 'verified', delegatedCapability: 'client.surface.action' },
          successStatuses: ['verified'],
          failureStatuses: ['failed', 'unverified'],
          successSignals: ['authoritative client_action receipt contains verified refreshed state'],
          limitations: ['Opening a recovery surface does not prove the underlying issue was repaired.'],
        },
      }),
      deprecated: true,
      replacedBy: 'client.surface.action',
    },
    evidence: capabilityEvidence({
      id: 'client.recovery.surface',
      operation: 'mutate',
      subjectArgument: 'action',
      limitations: ['The compatibility wrapper delegates to client.surface.action and must not be selected for new plans.'],
    }),
  });

  registry.register({
    name: 'client_repair_skill',
    description: 'Repair or restart a Lumi skill/MCP server by name. This may reinstall dependencies or restart a local skill process, so it requires confirmation.',
    parameters: {
      type: 'object',
      properties: {
        skillName: {
          type: 'string',
          description: 'Installed skill or MCP server name to repair.',
        },
      },
      required: ['skillName'],
    },
    handler: async (args) => {
      const skillName = String(args.skillName || '').trim();
      if (!skillName) throw new Error('skillName is required.');
      const result = await mcpManager.repairSkill(skillName);
      if (!result.success) {
        throw new Error(safeRuntimeError(result.reason) || `Skill "${skillName}" repair failed.`);
      }
      const toolCount = Number(result.toolCount || 0);
      if (!result.action || toolCount < 1) {
        throw new Error(`Skill "${skillName}" repair returned without a connected tool inventory.`);
      }
      return JSON.stringify(sanitizeDiagnosticValue({
        ok: true,
        status: 'repaired',
        skillName,
        action: result.action,
        directory: result.directory,
        runtimeStatus: 'connected',
        toolCount,
      }), null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'skills.runtime.repair',
      family: 'skill-lifecycle',
      lane: 'system',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [
        { type: 'installation', scope: 'installed skill dependencies or package source when repair requires reinstall', reversible: true },
        { type: 'local_state_change', scope: 'MCP skill runtime configuration', reversible: true },
        { type: 'process_execution', scope: 'local MCP skill process restart', reversible: true },
        { type: 'network_read', scope: 'declared package or repository source when reinstall is required', reversible: true },
      ],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'skillName', 'action', 'runtimeStatus', 'toolCount'],
        requiredValues: { ok: true, status: 'repaired', runtimeStatus: 'connected' },
        successStatuses: ['repaired'],
        failureStatuses: ['failed', 'not_found', 'unverified'],
        successSignals: ['restarted MCP process connected and returned at least one tool'],
        limitations: ['Connection and tool enumeration do not prove a real user task will succeed.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'skills.runtime.repair',
      operation: 'mutate',
      subjectArgument: 'skillName',
      limitations: ['A separate real task is required to validate functional behavior after repair.'],
    }),
  });
}
