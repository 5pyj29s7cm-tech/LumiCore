import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/services/apiClient';
import { socketService } from '@/services/socketService';
import { isCurrentScopeRequest } from '@/components/scopeRequestGuard';

import type { StructuredRuntimeStatus } from '../../server/monitor/runtime_status';
export type { RuntimeEvidenceReceipt, RuntimeTaskProjection, StructuredRuntimeStatus } from '../../server/monitor/runtime_status';

export function useRuntimeStatus(input: { enabled?: boolean; scopeKey?: string; userId?: string } = {}) {
  const { enabled = true, scopeKey = 'personal' } = input;
  const ownerKey = JSON.stringify([input.userId || '', scopeKey]);
  const [state, setState] = useState<{ owner: string; status: StructuredRuntimeStatus | null; loading: boolean; error: string }>(
    { owner: ownerKey, status: null, loading: enabled, error: '' },
  );
  const activeOwnerRef = useRef('');
  activeOwnerRef.current = enabled ? ownerKey : '';
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || activeOwnerRef.current !== ownerKey) return;
    const request = { scopeKey: ownerKey, generation: ++generationRef.current };
    setState(previous => previous.owner === ownerKey && previous.status ? previous
      : { owner: ownerKey, status: null, loading: true, error: previous.owner === ownerKey ? previous.error : '' });
    try {
      const response = await apiFetch('/api/runtime/status', { signal: AbortSignal.timeout(6_000) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'runtime_status_http_' + response.status);
      if (!isCurrentScopeRequest(request, activeOwnerRef.current, generationRef.current)) return;
      const domain = scopeKey.startsWith('work:') ? 'work' : 'personal';
      const orgId = domain === 'work' ? scopeKey.slice(5) : '';
      if (payload.scope?.domain !== domain || String(payload.scope?.orgId || '') !== orgId) {
        throw new Error('runtime_status_scope_mismatch');
      }
      setState({ owner: ownerKey, status: payload as StructuredRuntimeStatus, loading: false, error: '' });
    } catch (refreshError: any) {
      if (!isCurrentScopeRequest(request, activeOwnerRef.current, generationRef.current)) return;
      setState({ owner: ownerKey, status: null, loading: false, error: String(refreshError?.message || 'runtime_status_failed') });
    }
  }, [enabled, ownerKey, scopeKey]);

  useEffect(() => {
    generationRef.current += 1;
    activeOwnerRef.current = enabled ? ownerKey : '';
    setState({ owner: ownerKey, status: null, loading: enabled, error: '' });
    if (!enabled) return;
    const socket = socketService.connect();
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refresh(), 160);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    const events = ['connect', 'agent:status', 'agent:tool', 'agent:tool_call', 'focus:updated',
      'agent:progress', 'chat:conversation_updated', 'audio:work_progress'];
    for (const event of events) socket.on(event, scheduleRefresh);
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => {
      generationRef.current += 1;
      activeOwnerRef.current = '';
      if (refreshTimer) clearTimeout(refreshTimer);
      window.clearInterval(interval);
      for (const event of events) socket.off(event, scheduleRefresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, refresh, ownerKey]);

  const { status, loading, error } = enabled && state.owner === ownerKey ? state : { status: null, loading: enabled, error: '' };
  return { status, loading, error, refresh };
}
