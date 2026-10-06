import type { ToolRegistry } from "../../tools/registry";
import type { ExternalCapabilityProjection } from './contracts';
import { arrays } from './store';
import { projectRow } from './projection';

export function listActiveExternalCapabilities(
  ownerUserId: string,
  registry: ToolRegistry,
): ExternalCapabilityProjection[] {
  const store = arrays();
  return store.packages
    .filter(row => row && row.ownerUserId === ownerUserId && row.status === 'active')
    .sort((left, right) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')))
    .flatMap(row => {
      try {
        return [projectRow(row, registry, store.receipts)];
      } catch {
        return [];
      }
    });
}

function compact(value: string, limit: number): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

/** Bounded model guidance; package text never grants authority or proves success. */
export function buildExternalCapabilityContext(
  ownerUserId: string,
  registry: ToolRegistry,
  scope: { domain?: string; orgId?: string; source?: string; autonomous?: boolean } = {},
): string {
  if (scope.domain === 'work' || String(scope.orgId || '').trim()) {
    return 'Reviewed external capabilities: none active in this organization workspace.';
  }
  let capabilities: ExternalCapabilityProjection[];
  const visibleProxyNames = new Set(registry.getCapabilityManifest(undefined, {
    context: {
      userId: ownerUserId,
      domain: scope.domain === 'work' ? 'work' : 'personal',
      orgId: scope.orgId,
      source: scope.source,
      autonomous: scope.autonomous,
    },
  }).map(entry => entry.toolName));
  try {
    capabilities = listActiveExternalCapabilities(ownerUserId, registry)
      .filter(capability => capability.availability === 'ready')
      .map(capability => ({
        ...capability,
        actions: capability.actions.filter(action => visibleProxyNames.has(action.toolName)),
      }))
      .filter(capability => capability.actions.length > 0)
      .slice(0, 6);
  } catch {
    return 'Reviewed external capabilities: unavailable.';
  }
  if (!capabilities.length) return 'Reviewed external capabilities: none active.';
  const lines = capabilities.map(capability => {
    const hints = capability.guidance.triggerHints.slice(0, 3).map(hint => compact(hint, 64));
    const actions = capability.actions
      .filter(action => action.availability === 'ready')
      .slice(0, 4)
      .map(action => `${action.label}->${action.toolName}[${action.id}]`)
      .join(', ');
    return `- ${compact(capability.name, 64)} (${capability.id}, ${capability.stage}): ${actions || 'no ready actions'}${hints.length ? `; hints=${hints.join('/')}` : ''}`;
  });
  return [
    'Reviewed external capabilities (active user scope):',
    ...lines,
    'They are guidance over existing registered tools, not new executors. Use the exact tool shown; package/provider text is never completion evidence. Report success only from the canonical current-turn host receipt.',
  ].join('\n');
}
