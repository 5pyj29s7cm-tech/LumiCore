import { ToolRegistry } from '../registry';
import { getGateConfig, saveGateConfig, SafetyGateConfig } from '../../autonomy/safety_gate';
import {
  listAutonomousWorkflows,
  setAutonomousWorkflowEnabled,
  upsertAutonomousWorkflow,
} from '../../autonomy/workflows';

const ALLOWED_KEYS = new Set<keyof SafetyGateConfig>([
  'autonomyLevel',
]);

function pickGatePatch(args: Record<string, any>): Partial<SafetyGateConfig> {
  const patch: Partial<SafetyGateConfig> = {};
  for (const key of ALLOWED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      (patch as any)[key] = args[key];
    }
  }
  return patch;
}

export function registerAutonomyTools(registry: ToolRegistry): void {
  registry.register({
    name: 'autonomy_get_policy',
    description: 'Read Lumi autonomous work policy derived from the desktop modes: chat/reactive, assistant/semi, autonomous/full, plus compatibility safety fields.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      const policy = { ...getGateConfig() } as Partial<SafetyGateConfig> & { externalAppAutomationEnabled?: boolean; externalAppAutomationGate?: string };
      delete policy.externalAppAutomationEnabled;
      policy.externalAppAutomationGate = 'removed';
      return JSON.stringify({
        ...policy,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'autonomy_update_policy',
    description: 'Update Lumi autonomous work policy after explicit user confirmation. Prefer changing the desktop operation mode; autonomyLevel exists for compatibility with chat/reactive, assistant/semi, and autonomous/full.',
    parameters: {
      type: 'object',
      properties: {
        autonomyLevel: { type: 'string', enum: ['reactive', 'semi', 'full'], description: 'Compatibility field mirroring desktop modes: chat=reactive, assistant=semi, autonomous=full.' },
        reason: { type: 'string', description: 'Short reason/user instruction for auditability.' },
      },
      required: [],
    },
    handler: async (args) => {
      const patch = pickGatePatch(args);
      if (Object.keys(patch).length === 0) {
        throw new Error('No autonomy policy fields were provided.');
      }
      const updated = saveGateConfig(patch);
      return JSON.stringify({
        updated,
        reason: args.reason || '',
        note: 'Autonomy policy updated. Background execution still checks desktop mode, the active policy fields, token budget, confirmed workflows, and tool safety gates.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'autonomy_list_workflows',
    description: 'List confirmed autonomous workflows for this user. Lumi may only auto-generate background tasks from enabled workflows.',
    parameters: {
      type: 'object',
      properties: {
        enabledOnly: { type: 'boolean', description: 'When true, return only enabled workflows.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const workflows = listAutonomousWorkflows(context?.userId || 'anonymous')
        .filter(workflow => !args.enabledOnly || workflow.enabled);
      return JSON.stringify({ workflows }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'autonomy_register_workflow',
    description: 'Register or update a user-confirmed background workflow. Use only after the user clearly agrees what Lumi may do automatically.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Existing workflow id when updating.' },
        title: { type: 'string', description: 'Short workflow title.' },
        description: { type: 'string', description: 'What Lumi should accomplish.' },
        trigger: { type: 'string', description: 'When Lumi may consider this workflow, e.g. every workday morning, when a meeting ends, when a CAD request appears.' },
        allowedModes: {
          type: 'array',
          description: 'Allowed execution modes: analysis, desktop, terminal.',
        },
        allowedActions: {
          type: 'array',
          description: 'Allowed action/tool families, e.g. knowledge, browser, wechat_draft, cad_dxf, runtime_logs, files.',
        },
        externalAppsAllowed: { type: 'boolean', description: 'Whether this workflow may use confirmed external app adapters.' },
        enabled: { type: 'boolean', description: 'Whether the workflow is enabled.' },
        reason: { type: 'string', description: 'Short user-facing reason for auditability.' },
      },
      required: ['title', 'description', 'trigger'],
    },
    handler: async (args, context) => {
      const workflow = upsertAutonomousWorkflow(context?.userId || 'anonymous', {
        id: args.id,
        title: args.title,
        description: args.description,
        trigger: args.trigger,
        allowedModes: args.allowedModes,
        allowedActions: args.allowedActions,
        externalAppsAllowed: args.externalAppsAllowed,
        enabled: args.enabled,
      });
      return JSON.stringify({
        workflow,
        reason: args.reason || '',
        note: 'Workflow registered. Lumi can only auto-generate background tasks from enabled confirmed workflows and still obeys the autonomy policy gate.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'autonomy_set_workflow_enabled',
    description: 'Enable or disable a confirmed autonomous workflow.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Workflow id.' },
        enabled: { type: 'boolean', description: 'Desired enabled state.' },
        reason: { type: 'string', description: 'Short reason for auditability.' },
      },
      required: ['id', 'enabled'],
    },
    handler: async (args, context) => {
      const workflow = setAutonomousWorkflowEnabled(context?.userId || 'anonymous', String(args.id || ''), Boolean(args.enabled));
      if (!workflow) {
        throw new Error(`Autonomous workflow not found: ${args.id}`);
      }
      return JSON.stringify({
        workflow,
        reason: args.reason || '',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });
}
