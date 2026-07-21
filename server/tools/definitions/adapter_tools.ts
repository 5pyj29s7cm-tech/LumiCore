import { getAdapterRegistry, summarizeAdapters, AdapterCapability, AdapterCategory, AdapterStatus } from '../../adapters/registry';
import { getClientStateForScope } from '../../client/self_model';
import { ToolRegistry } from '../registry';

const STATUSES: AdapterStatus[] = [
  'ready',
  'available',
  'draft_only',
  'requires_setup',
  'attention',
  'degraded',
  'blocked',
  'planned',
];

const CATEGORIES: AdapterCategory[] = [
  'client',
  'workspace',
  'media',
  'files',
  'web',
  'messaging',
  'cad_bim',
  'ai',
  'automation',
  'collaboration',
  'organization',
  'memory',
  'system',
];

export function registerAdapterTools(registry: ToolRegistry): void {
  registry.register({
    name: 'adapter_registry_list',
    description: 'List Lumi client capability adapters: windows, modes, tools, skills, music, meeting, organization, runtime logs, knowledge, settings, permissions, desktop control, CAD/BIM, external apps, and collaboration.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: CATEGORIES,
          description: 'Optional category filter.',
        },
        status: {
          type: 'string',
          enum: STATUSES,
          description: 'Optional status filter.',
        },
        includePlanned: {
          type: 'boolean',
          description: 'Whether to include planned/not-yet-wired adapters. Defaults to true.',
        },
      },
      required: [],
    },
    handler: async (args, context) => {
      const userId = context?.userId || 'anonymous';
      const report = getAdapterRegistry({
        userId,
        clientState: getClientStateForScope(userId, { domain: context?.domain, orgId: context?.orgId }),
        includePlanned: args.includePlanned !== false,
      });
      const adapters = filterAdapters(report.adapters, args);
      return JSON.stringify({
        ...report,
        summary: summarizeAdapters(adapters),
        adapters,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'adapter_health_check',
    description: 'Check Lumi adapter readiness and return blockers, setup needs, degraded areas, and safe next actions. Use this when Lumi needs to understand whether a capability can really be used.',
    parameters: {
      type: 'object',
      properties: {
        adapterId: {
          type: 'string',
          description: 'Optional exact adapter id, e.g. cad_bim.drafting, automation.computer_use, workspace.skills_mcp.',
        },
        category: {
          type: 'string',
          enum: CATEGORIES,
          description: 'Optional category filter.',
        },
      },
      required: [],
    },
    handler: async (args, context) => {
      const userId = context?.userId || 'anonymous';
      const report = getAdapterRegistry({
        userId,
        clientState: getClientStateForScope(userId, { domain: context?.domain, orgId: context?.orgId }),
        includePlanned: true,
      });
      const adapters = filterAdapters(report.adapters, args)
        .filter(adapter => !args.adapterId || adapter.id === String(args.adapterId));
      const needsAttention = adapters.filter(adapter => ['attention', 'degraded'].includes(adapter.status));
      const setupRequired = adapters.filter(adapter => ['requires_setup', 'blocked'].includes(adapter.status));
      const draftOnly = adapters.filter(adapter => adapter.status === 'draft_only');
      const planned = adapters.filter(adapter => adapter.status === 'planned');
      const usable = adapters.filter(adapter => ['ready', 'available', 'draft_only'].includes(adapter.status));

      return JSON.stringify({
        generatedAt: report.generatedAt,
        userId,
        checkedCount: adapters.length,
        summary: summarizeAdapters(adapters),
        usable: usable.map(compactAdapter),
        needsAttention: needsAttention.map(adapter => ({
          ...compactAdapter(adapter),
          diagnostics: adapter.diagnostics || [],
          setup: adapter.setup || [],
        })),
        setupRequired: setupRequired.map(adapter => ({
          ...compactAdapter(adapter),
          setup: adapter.setup || [],
          safety: adapter.safety,
        })),
        draftOnly: draftOnly.map(compactAdapter),
        planned: planned.map(adapter => ({
          ...compactAdapter(adapter),
          setup: adapter.setup || [],
        })),
        nextActions: buildNextActions(adapters),
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });
}

function filterAdapters(adapters: AdapterCapability[], args: Record<string, any>): AdapterCapability[] {
  const category = String(args.category || '').trim();
  const status = String(args.status || '').trim();
  return adapters.filter(adapter => (
    (!category || adapter.category === category) &&
    (!status || adapter.status === status)
  ));
}

function compactAdapter(adapter: AdapterCapability) {
  return {
    id: adapter.id,
    label: adapter.label,
    category: adapter.category,
    status: adapter.status,
    actions: adapter.actions,
    surfaces: adapter.surfaces || [],
    requiresConfirmation: Boolean(adapter.requiresConfirmation),
    notes: adapter.notes,
  };
}

function buildNextActions(adapters: AdapterCapability[]): string[] {
  const actions: string[] = [];
  if (adapters.some(adapter => adapter.status === 'degraded' || adapter.status === 'attention')) {
    actions.push('Use client_health_check, then open the related recovery surface with client_self_repair if the cause is a client state/runtime issue.');
  }
  if (adapters.some(adapter => adapter.status === 'requires_setup' || adapter.status === 'blocked')) {
    actions.push('Open Settings or Skill Hall for setup before claiming this capability is usable.');
  }
  if (adapters.some(adapter => adapter.requiresConfirmation)) {
    actions.push('Ask for explicit confirmation before desktop automation, external messaging, meetings, autonomous execution, provider changes, installs, or file writes.');
  }
  if (adapters.some(adapter => adapter.status === 'planned')) {
    actions.push('Treat planned adapters as roadmap items. Use capability_research before building or installing integrations.');
  }
  if (!actions.length) actions.push('Adapters checked are usable. Prefer their explicit actions over blind UI control.');
  return actions;
}
