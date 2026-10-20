import type { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { getClientState } from '../../client/self_model';
import { getGateConfig } from '../../autonomy/safety_gate';
import { listAutonomousWorkflows } from '../../autonomy/workflows';
import { PERSONAL_CLIENT_SURFACE_ACTIONS } from '../../../shared/client_surfaces';
export { getSkillRuntimeFindings } from '../../client/self/health';

export const ACTIONS = Array.from(new Set([
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
  'set_desktop_execution_preference',
]));

export const RECOVERY_SURFACE_ACTIONS: Record<string, { action: string; section?: string }> = {
  skills: { action: 'open_skills' },
  business: { action: 'open_business' },
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

export const ACTIONS_WITH_INTERNAL_REFRESH = new Set(['refresh_client_state']);

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function parseRelayOutput(output: string): any {
  if (!output) return output;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

export async function waitForClientStateAfter(userId: string, previousUpdatedAt: number, timeoutMs = 1200) {
  const start = Date.now();
  let latest = getClientState(userId);
  while (Date.now() - start < timeoutMs) {
    latest = getClientState(userId);
    if (latest?.updatedAt && latest.updatedAt > previousUpdatedAt) return latest;
    await delay(80);
  }
  return latest;
}

export function getAutonomyDiagnosticPolicy(userId: string) {
  return {
    ...getGateConfig(userId),
    externalAppAutomationGate: 'removed',
    externalAppExecutionScope: 'foreground_user_requests_use_registered_adapters',
  };
}

export function getAutonomyWorkflowDiagnostics(userId: string) {
  return listAutonomousWorkflows(userId).map((workflow) => {
    const { externalAppsAllowed, ...rest } = workflow;
    return {
      ...rest,
      policyScope: 'unattended_background_workflow',
      backgroundExternalAppsAllowed: externalAppsAllowed,
    };
  });
}

export function getCapabilityRuntimeSummary(registry: ToolRegistry, context?: ToolContext) {
  const manifest = registry.getCapabilityManifest(undefined, { context });
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

const CAPABILITY_SEARCH_STOPWORDS = new Set([
  'and', 'can', 'could', 'for', 'from', 'help', 'please', 'the', 'this', 'use', 'with',
]);

function capabilitySearchTokens(query: string): string[] {
  const normalized = query.normalize('NFKC').toLowerCase().slice(0, 500);
  const tokens: string[] = [];
  for (const token of normalized.match(/[a-z0-9][a-z0-9._+-]{1,}/g) || []) {
    if (!CAPABILITY_SEARCH_STOPWORDS.has(token)) tokens.push(token);
  }
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) || []) {
    for (let size = 2; size <= Math.min(5, run.length); size += 1) {
      for (let index = 0; index <= run.length - size; index += 1) {
        const token = run.slice(index, index + size);
        if (!CAPABILITY_SEARCH_STOPWORDS.has(token)) tokens.push(token);
      }
    }
  }
  return Array.from(new Set(tokens));
}

export function rankCapabilityManifestEntry(
  entry: ReturnType<ToolRegistry['getCapabilityManifest']>[number],
  query: string,
): { score: number; matchedTerms: string[] } {
  const normalizedQuery = query.normalize('NFKC').toLowerCase().trim().slice(0, 500);
  if (!normalizedQuery) return { score: 0, matchedTerms: [] };
  const identity = [entry.toolName, entry.capabilityId, entry.family, entry.provider || '']
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();
  const haystack = [
    identity,
    entry.description,
    ...entry.domains,
    ...entry.routingTerms,
  ].join(' ').normalize('NFKC').toLowerCase();
  let score = 0;
  if (haystack.includes(normalizedQuery)) score += 200 + Math.min(100, normalizedQuery.length * 4);
  const matchedTerms = capabilitySearchTokens(normalizedQuery).filter(token => haystack.includes(token));
  for (const token of matchedTerms) {
    score += Math.min(18, token.length * 3);
    if (identity.includes(token)) score += Math.min(24, token.length * 4);
  }
  return { score, matchedTerms };
}
