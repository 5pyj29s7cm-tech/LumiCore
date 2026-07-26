import { ToolRegistry } from '../registry';
import { getGateConfig, loadGateConfig, saveGateConfig, SafetyGateConfig } from '../../autonomy/safety_gate';
import {
  listAutonomousWorkflows,
  setAutonomousWorkflowEnabled,
  upsertAutonomousWorkflow,
} from '../../autonomy/workflows';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

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
    handler: async (_args, context) => {
      return JSON.stringify({
        ...getGateConfig(context?.userId),
        externalAppAutomationGate: 'removed',
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
    handler: async (args, context) => {
      const patch = pickGatePatch(args);
      if (Object.keys(patch).length === 0) {
        throw new Error('No autonomy policy fields were provided.');
      }
      const updated = saveGateConfig(patch, context?.userId);
      const persistedPolicy = loadGateConfig(context?.userId);
      const requestedLevel = patch.autonomyLevel;
      if (requestedLevel && persistedPolicy.autonomyLevel !== requestedLevel) {
        throw new Error('Autonomy policy was not persisted with the requested level.');
      }
      return JSON.stringify({
        ok: true,
        status: 'updated',
        persisted: true,
        updated,
        persistedPolicy,
        reason: args.reason || '',
        note: 'Autonomy policy updated. Background execution still checks desktop mode, the active policy fields, token budget, confirmed workflows, and tool safety gates.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'autonomy.policy.update',
      family: 'autonomy',
      lane: 'system',
      operation: 'mutate',
      risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'autonomy safety policy', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'persistedPolicy.autonomyLevel'],
        requiredValues: { ok: true, status: 'updated', persisted: true },
        successStatuses: ['updated'],
        failureStatuses: ['failed', 'unverified'],
        successSignals: ['persisted autonomy policy reread matches the requested level'],
        limitations: ['This changes policy only; every later action still passes its own permission and confirmation gates.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'autonomy.policy.update',
      operation: 'mutate',
      subjectArgument: 'autonomyLevel',
      limitations: ['Does not execute an autonomous workflow by itself.'],
    }),
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
      const userId = context?.userId || 'anonymous';
      const workflow = upsertAutonomousWorkflow(userId, {
        id: args.id,
        title: args.title,
        description: args.description,
        trigger: args.trigger,
        allowedModes: args.allowedModes,
        allowedActions: args.allowedActions,
        externalAppsAllowed: args.externalAppsAllowed,
        enabled: args.enabled,
      });
      const persistedWorkflow = listAutonomousWorkflows(userId).find(item => item.id === workflow.id);
      if (!persistedWorkflow || persistedWorkflow.updatedAt !== workflow.updatedAt) {
        throw new Error('Autonomous workflow was not persisted.');
      }
      return JSON.stringify({
        ok: true,
        status: 'registered',
        persisted: true,
        workflow: persistedWorkflow,
        reason: args.reason || '',
        note: 'Workflow registered. Lumi can only auto-generate background tasks from enabled confirmed workflows and still obeys the autonomy policy gate.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'autonomy.workflow.register',
      family: 'autonomy',
      lane: 'system',
      operation: 'create',
      risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'confirmed autonomous workflow definition', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'workflow.id', 'workflow.updatedAt'],
        requiredValues: { ok: true, status: 'registered', persisted: true },
        successStatuses: ['registered'],
        failureStatuses: ['failed', 'unverified'],
        successSignals: ['workflow is present in the persisted user workflow list'],
        limitations: ['Registration does not prove that a future trigger will run successfully.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'autonomy.workflow.register',
      operation: 'create',
      subjectArgument: 'title',
      limitations: ['Creates or updates only the workflow definition.'],
    }),
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
      const userId = context?.userId || 'anonymous';
      const requestedEnabled = Boolean(args.enabled);
      const workflow = setAutonomousWorkflowEnabled(userId, String(args.id || ''), requestedEnabled);
      if (!workflow) {
        throw new Error(`Autonomous workflow not found: ${args.id}`);
      }
      const persistedWorkflow = listAutonomousWorkflows(userId).find(item => item.id === workflow.id);
      if (!persistedWorkflow || persistedWorkflow.enabled !== requestedEnabled) {
        throw new Error('Autonomous workflow enabled state was not persisted.');
      }
      return JSON.stringify({
        ok: true,
        status: requestedEnabled ? 'enabled' : 'disabled',
        persisted: true,
        workflow: persistedWorkflow,
        reason: args.reason || '',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'autonomy.workflow.set-enabled',
      family: 'autonomy',
      lane: 'system',
      operation: 'mutate',
      risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'autonomous workflow enabled state', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'workflow.id', 'workflow.enabled'],
        requiredValues: { ok: true, persisted: true },
        successStatuses: ['enabled', 'disabled'],
        failureStatuses: ['failed', 'not_found', 'unverified'],
        successSignals: ['persisted workflow enabled state matches the requested value'],
        limitations: ['Enabling a workflow does not bypass per-action safety gates.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'autonomy.workflow.set-enabled',
      operation: 'mutate',
      subjectArgument: 'id',
    }),
  });
}
