import type { ToolRegistry } from '../registry';
import { getClientCapabilities, getClientHealthReport, getClientInterfaceSurfaces, getClientSelfAwarenessReport, getClientStateForScope, getClientStateDigest, getVisibleExecutionHabits } from '../../client/self_model';
import { getLumiTechnicalArchitecture } from '../../../shared/technical_architecture';
import { sanitizeDiagnosticValue } from '../../client/diagnostic_sanitizer';
import { getSkillRuntimeFindings, getAutonomyDiagnosticPolicy, getAutonomyWorkflowDiagnostics, getCapabilityRuntimeSummary, rankCapabilityManifestEntry } from './client_self_shared';

export function registerClientDiagnosticsTools(registry: ToolRegistry): void {
  registry.register({
    name: 'client_get_state',
    description: 'Read the latest Lumi desktop/client state and a compact health/capability summary. Use detail=full only for an explicit self-diagnostic audit; use client_capability_manifest for searchable capability inventory.',
    parameters: {
      type: 'object',
      properties: {
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description: 'summary is the bounded default for normal state/action verification; full includes the complete diagnostic maps.',
        },
      },
      required: [],
    },
    handler: async (args, context) => {
      const userId = context?.userId || 'anonymous';
      const scope = { domain: context?.domain, orgId: context?.orgId };
      const isWork = context?.domain === 'work' && Boolean(context?.orgId);
      const state = getClientStateForScope(userId, scope);
      const architecture = getLumiTechnicalArchitecture();
      const capabilityRuntime = getCapabilityRuntimeSummary(registry, context);
      const health = getClientHealthReport(userId, scope);
      const selfAwareness = getClientSelfAwarenessReport(userId, scope, health);
      const autonomyGate = isWork ? null : getAutonomyDiagnosticPolicy(userId);
      const autonomyWorkflows = isWork ? [] : getAutonomyWorkflowDiagnostics(userId);
      const scopedIdentity = isWork ? { domain: 'work', orgId: context?.orgId } : { domain: 'personal' };
      const common = {
        detail: args?.detail === 'full' ? 'full' : 'summary',
        state: sanitizeDiagnosticValue(state),
        stateDigest: getClientStateDigest(state),
        health,
        capabilityRuntime,
        autonomyGate,
        autonomyWorkflows,
        scope: scopedIdentity,
      };
      const payload = args?.detail === 'full'
        ? {
            ...common,
            architecture,
            selfAwareness,
            capabilities: getClientCapabilities(registry.getCapabilityManifest(context?.toolPolicy, { context })),
            interfaceSurfaces: getClientInterfaceSurfaces(),
            visibleExecutionHabits: getVisibleExecutionHabits(),
            skillRuntimeFindings: getSkillRuntimeFindings(),
          }
        : {
            ...common,
            architecture: {
              product: architecture.product,
              topology: architecture.topology,
              schemaVersion: architecture.schemaVersion,
            },
            selfAwareness: {
              level: selfAwareness.level,
              bodySummary: selfAwareness.bodySummary,
              gaps: selfAwareness.gaps.slice(0, 4),
              nextBestActions: selfAwareness.nextBestActions.slice(0, 3),
            },
            omitted: ['capabilities', 'interfaceSurfaces', 'visibleExecutionHabits', 'skillRuntimeFindings'],
            inventoryTool: 'client_capability_manifest',
          };
      return JSON.stringify(sanitizeDiagnosticValue(payload), null, 2);
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
      const installed = registry.getCapabilityManifest(undefined, { context });
      const turnExecutable = new Set(
        registry.getCapabilityManifest(context?.toolPolicy, { executableOnly: true, context })
          .map(entry => entry.toolName),
      );
      const query = String(args.query || '').trim().normalize('NFKC').toLowerCase().slice(0, 500);
      const source = String(args.source || '').trim();
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
      const eligible = installed
        .filter(entry => !source || entry.source === source)
        .filter(entry => !args.executableOnly || turnExecutable.has(entry.toolName));
      const matches = query
        ? eligible
            .map(entry => ({ entry, ...rankCapabilityManifestEntry(entry, query) }))
            .filter(match => match.score > 0)
            .sort((left, right) => (
              right.score - left.score
              || left.entry.toolName.localeCompare(right.entry.toolName)
            ))
        : eligible.map(entry => ({ entry, score: 0, matchedTerms: [] as string[] }));
      return JSON.stringify(sanitizeDiagnosticValue({
        summary: getCapabilityRuntimeSummary(registry, context),
        query: query || null,
        source: source || null,
        matched: matches.length,
        returned: Math.min(matches.length, limit),
        capabilities: matches.slice(0, limit).map(match => ({
          ...match.entry,
          executableThisTurn: turnExecutable.has(match.entry.toolName),
          ...(query ? {
            matchScore: match.score,
            matchedTerms: match.matchedTerms.slice(0, 12),
          } : {}),
        })),
      }), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });
}
