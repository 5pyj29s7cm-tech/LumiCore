import { ToolRegistry } from '../registry';
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
import { getGateConfig } from '../../autonomy/safety_gate';
import { listAutonomousWorkflows } from '../../autonomy/workflows';
import { mcpManager } from '../../mcp';
import { isExplicitSensitiveClientActionRequest } from '../action_constitution';
import { PERSONAL_CLIENT_SURFACE_ACTIONS } from '../../../shared/client_surfaces';
import {
  redactDiagnosticSecrets,
  safeRuntimeError,
  sanitizeDiagnosticValue,
} from '../../client/diagnostic_sanitizer';

const ACTIONS = Array.from(new Set([
  'open_app',
  'close_app',
  'set_mode',
  'set_client_mode',
  'focus_home',
  'enter_widget_mode',
  'show_desktop_widget',
  'exit_widget_mode',
  'expand_from_widget',
  ...PERSONAL_CLIENT_SURFACE_ACTIONS,
  'close_nexus',
  'show_music_layer',
  'hide_music_layer',
  'start_meeting_mode',
  'end_meeting_mode',
  'open_meeting_notes',
  'open_organization_workspace',
  'refresh_client_state',
  'set_wallpaper_mode',
]));

const RECOVERY_SURFACE_TARGETS: Record<string, string> = {
  skills: 'skills',
  skill: 'skills',
  music: 'music-center',
  'music-center': 'music-center',
  logs: 'runtime-log',
  log: 'runtime-log',
  runtime: 'runtime-log',
  'runtime-log': 'runtime-log',
  knowledge: 'knowledge',
  files: 'knowledge',
  settings: 'settings',
  kernel: 'kernel',
  computer: 'kernel',
  plans: 'plans',
  autonomy: 'plans',
  org: 'org',
  organization: 'org',
  voice: 'settings',
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

function sanitizeRelayOutput(output: string): string {
  const parsed = parseRelayOutput(output);
  return typeof parsed === 'string'
    ? redactDiagnosticSecrets(parsed)
    : JSON.stringify(sanitizeDiagnosticValue(parsed));
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
  const policy = { ...getGateConfig(userId) } as Record<string, any>;
  delete policy.externalAppAutomationEnabled;
  return {
    ...policy,
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
        selfAwareness: getClientSelfAwarenessReport(userId, scope),
        capabilities: getClientCapabilities(),
        interfaceSurfaces: getClientInterfaceSurfaces(),
        visibleExecutionHabits: getVisibleExecutionHabits(),
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
    name: 'client_action',
    description: [
      'Safely control Lumi client UI surfaces through the client action router.',
      'Use the explicit action from the complete personal-client interface registry, including personality, notifications, reminders, devices, token usage, terminal, profile, MCP settings, Voice Forge, skill generation, app launcher, knowledge, organization, meeting, music, and runtime surfaces.',
      'Legacy open_app/close_app/set_mode are still accepted for compatibility.',
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
          description: 'Target app/surface for backward-compatible open_app or close_app. Prefer a registered explicit action when opening a Lumi interface.',
        },
        mode: {
          type: 'string',
          enum: ['meeting', 'chat', 'assistant', 'autonomous'],
          description: 'Target Lumi mode for set_mode or set_client_mode. Music is not a mode; use open_music_center or show_music_layer.',
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
  });

  registry.register({
    name: 'client_health_check',
    description: 'Run Lumi local self-governance health check: client body state, background/runtime health, runtime errors, music/runtime/files/voice issues, autonomy boundary, and skill runtime findings.',
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
      'Use open_recovery_surface to open the relevant Lumi surface (skills, music, runtime-log, settings, kernel, plans, knowledge, org).',
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
          description: 'Recovery surface for open_recovery_surface: skills, music, runtime-log, settings, kernel, plans, knowledge, org. Legacy files opens knowledge.',
        },
      },
      required: ['action'],
    },
    handler: async (args, context) => {
      if (!context?.desktopRelay) {
        throw new Error('Client self-repair requires the Lumi desktop client relay.');
      }
      if (args.action === 'refresh_client_state') {
        const result = await context.desktopRelay('client_action', { action: 'refresh_client_state' });
        return sanitizeRelayOutput(result);
      }
      if (args.action === 'open_recovery_surface') {
        const surface = String(args.surface || 'settings').toLowerCase();
        const target = RECOVERY_SURFACE_TARGETS[surface] || surface;
        const result = await context.desktopRelay('client_action', { action: 'open_app', target });
        return sanitizeRelayOutput(result);
      }
      throw new Error(`Unsupported client_self_repair action: ${args.action}`);
    },
    permission: 'user',
    securityLevel: 'safe',
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
      return JSON.stringify(sanitizeDiagnosticValue(result), null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });
}
