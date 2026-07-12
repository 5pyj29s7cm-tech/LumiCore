import { ToolRegistry } from '../registry';
import {
  getClientActionExpectation,
  getClientCapabilities,
  getClientHealthReport,
  getClientInterfaceSurfaces,
  getClientSelfAwarenessReport,
  getClientState,
  getClientStateDigest,
  getVisibleExecutionHabits,
  verifyClientActionResult,
} from '../../client/self_model';
import { getGateConfig } from '../../autonomy/safety_gate';
import { listAutonomousWorkflows } from '../../autonomy/workflows';
import { mcpManager } from '../../mcp';
import { isExplicitSensitiveClientActionRequest } from '../action_constitution';

const ACTIONS = [
  'open_app',
  'close_app',
  'set_mode',
  'set_client_mode',
  'focus_home',
  'enter_widget_mode',
  'show_desktop_widget',
  'exit_widget_mode',
  'expand_from_widget',
  'open_nexus',
  'close_nexus',
  'open_music_center',
  'show_music_layer',
  'hide_music_layer',
  'start_meeting_mode',
  'end_meeting_mode',
  'open_meeting_notes',
  'open_runtime_log',
  'show_knowledge_base',
  'open_organization_workspace',
  'open_files',
  'open_settings',
  'open_computer_adaptation',
  'open_avatar_studio',
  'open_sound_studio',
  'open_memory_avatar',
  'open_skills',
  'open_tools',
  'open_team',
  'open_chat',
  'open_plans',
  'open_work_queue',
  'open_subscription',
  'open_activation',
  'open_billing',
  'customer_takeover_panel',
  'close_customer_takeover_panel',
  'design_delivery_panel',
  'close_design_delivery_panel',
  'ecommerce_growth_panel',
  'close_ecommerce_growth_panel',
  'refresh_client_state',
  'set_wallpaper_mode',
];

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
        source: serverConfig.source || localSkill?.source || 'unknown',
        description: serverConfig.description || localSkill?.description || name,
        repairTool: `client_repair_skill(skillName="${name}")`,
      };
    })
    .filter(Boolean);
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
      const state = getClientState(userId);
      return JSON.stringify({
        selfAwareness: getClientSelfAwarenessReport(userId),
        capabilities: getClientCapabilities(),
        interfaceSurfaces: getClientInterfaceSurfaces(),
        visibleExecutionHabits: getVisibleExecutionHabits(),
        state,
        stateDigest: getClientStateDigest(state),
        health: getClientHealthReport(userId),
        skillRuntimeFindings: getSkillRuntimeFindings(),
        autonomyGate: getGateConfig(userId),
        autonomyWorkflows: listAutonomousWorkflows(userId),
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'client_action',
    description: [
      'Safely control Lumi client UI surfaces through the client action router.',
      'Use explicit client-native actions like refresh_client_state, open_nexus, open_music_center, start_meeting_mode, open_runtime_log, show_knowledge_base, open_avatar_studio, open_sound_studio, open_computer_adaptation, open_settings, open_subscription, enter_widget_mode, customer_takeover_panel, design_delivery_panel, ecommerce_growth_panel, or set_wallpaper_mode.',
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
          description: 'Target app/surface for open_app or close_app, e.g. nexus, org, knowledge, runtime-log, skills, team, music-center, settings. The legacy files target opens knowledge.',
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
        stage: {
          type: 'string',
          description: 'Optional stage for large workflow panels, e.g. intake, result, cad, publish.',
        },
        brief: {
          type: 'object',
          description: 'Optional structured brief for customer takeover or result panels.',
        },
        payload: {
          type: 'object',
          description: 'Optional structured payload for client-only panels.',
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
          description: 'Optional settings section for open_settings.',
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
        stage: args.stage || '',
        brief: args.brief,
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
      return JSON.stringify({
        ok: verification.status === 'verified' || verification.status === 'not_applicable',
        action: payload.action,
        target: payload.target || expectation.target || '',
        mode: payload.mode || expectation.mode || '',
        expectation,
        relayResult,
        refreshResult,
        verification,
        before: getClientStateDigest(before),
        after: getClientStateDigest(after),
        say: verification.message,
      }, null, 2);
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
      return JSON.stringify({
        report: getClientHealthReport(context?.userId || 'anonymous'),
        skillRuntimeFindings: getSkillRuntimeFindings(),
        autonomyGate: getGateConfig(context?.userId),
        autonomyWorkflows: listAutonomousWorkflows(context?.userId || 'anonymous'),
      }, null, 2);
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
        return context.desktopRelay('client_action', { action: 'refresh_client_state' });
      }
      if (args.action === 'open_recovery_surface') {
        const surface = String(args.surface || 'settings').toLowerCase();
        const target = RECOVERY_SURFACE_TARGETS[surface] || surface;
        return context.desktopRelay('client_action', { action: 'open_app', target });
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
        throw new Error(result.reason || `Skill "${skillName}" repair failed.`);
      }
      return JSON.stringify(result, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });
}
