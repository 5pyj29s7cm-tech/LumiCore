import { getActionAuthorizationRules } from '../tools/action_authorization_rules';
import type { AdapterCapability, AdapterRegistryReport } from '../adapters/registry';

export type ExternalAppAdapterId = 'browser' | 'wechat' | 'cad' | 'ai_apps';

export interface ExternalAppAdapter {
  id: ExternalAppAdapterId;
  label: string;
  status: 'ready' | 'draft_only' | 'requires_setup';
  actions: string[];
  safety: string;
  notes: string;
}

const EXTERNAL_APP_ADAPTER_IDS: Record<ExternalAppAdapterId, string> = {
  browser: 'web.browser',
  wechat: 'messaging.wechat_feishu',
  cad: 'cad_bim.drafting',
  ai_apps: 'ai.external_tools',
};

/** Project the same live catalog used by the enclosing tool response. */
export function getExternalAppAdapters(registry: Pick<AdapterRegistryReport, 'adapters'>): ExternalAppAdapter[] {
  return (Object.entries(EXTERNAL_APP_ADAPTER_IDS) as Array<[ExternalAppAdapterId, string]>)
    .flatMap(([publicId, registryId]) => {
      const adapter = registry.adapters.find(item => item.id === registryId);
      return adapter ? [toExternalAppAdapter(publicId, adapter)] : [];
    });
}

function toExternalAppAdapter(id: ExternalAppAdapterId, adapter: AdapterCapability): ExternalAppAdapter {
  return {
    id,
    label: adapter.label,
    status: toPublicStatus(adapter),
    actions: adapter.actions,
    safety: getActionAuthorizationRules().join(' '),
    notes: adapter.notes || '',
  };
}

function toPublicStatus(adapter: AdapterCapability): ExternalAppAdapter['status'] {
  if (adapter.status === 'draft_only') return 'draft_only';
  if (adapter.status === 'requires_setup' || adapter.status === 'blocked' || adapter.status === 'planned'
    || adapter.status === 'attention' || adapter.status === 'degraded') return 'requires_setup';
  return 'ready';
}
