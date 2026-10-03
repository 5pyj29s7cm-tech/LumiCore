import { useEffect, useState } from 'react';
import { useApp } from '../contexts/AppContext';
import { apiJson } from '../services/apiClient';
import type { OfficialApiModelCatalog } from '../../server/llm/official_api';

/** Optional metadata belongs to the mounted account, never to a module-global cache. */
export function useLumiOfficialCatalog(): OfficialApiModelCatalog | null {
  const { user, workDomain, orgConnection } = useApp();
  const scope = JSON.stringify([user?.uid, user?.role, workDomain, orgConnection?.orgId]);
  const [result, setResult] = useState<{ scope: string; catalog: OfficialApiModelCatalog } | null>(null);
  useEffect(() => {
    if (!user?.uid) return;
    let owner: AbortController | undefined;
    const refresh = (event?: Event) => {
      const changed = (event as CustomEvent | undefined)?.detail;
      if (event && ![...(changed?.saved ?? []), ...(changed?.deleted ?? [])].some(key => key === 'RELAY_API_KEY' || key === 'RELAY_BASE_URL')) return;
      owner?.abort(); owner = new AbortController();
      const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(15_000)]);
      setResult(null);
      void apiJson('/api/preferences/official/models', { signal }).then(data => {
        signal.throwIfAborted();
        if (data?.ok !== true || !Array.isArray(data.models) || data.models.some((item: any) => !item || typeof item.id !== 'string')
          || !data.byRole || typeof data.byRole !== 'object' || Array.isArray(data.byRole)
          || Object.values(data.byRole).some(models => !Array.isArray(models) || models.some(model => typeof model !== 'string'))) return;
        setResult({ scope, catalog: data as OfficialApiModelCatalog });
      }).catch(() => { /* Optional metadata stays unavailable; reopening retries. */ });
    };
    refresh();
    window.addEventListener('lumi:keys-changed', refresh);
    return () => { owner?.abort(); window.removeEventListener('lumi:keys-changed', refresh); };
  }, [scope, user?.uid]);
  return result?.scope === scope ? result.catalog : null;
}
