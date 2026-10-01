import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '@/components/MemoryTree/types';

/** The scope contains the account/domain, deliberately never a conversation ID. */
export function useGeneratedLibrary(scope: string, scopedUrl: (url: string) => string) {
  const [state, setState] = useState<{ scope: string; files: FileEntry[]; loading: boolean; error: number | 'network' | null }>({ scope, files: [], loading: false, error: null });
  const currentScope = useRef(scope); currentScope.current = scope;
  const revision = useRef(0);
  const pendingReconcile = useRef<{ scope: string; promise: Promise<void> } | null>(null);
  const refresh = useCallback(async () => {
    if (currentScope.current !== scope) return;
    const request = ++revision.current;
    const current = () => currentScope.current === scope && revision.current === request;
    setState(previous => ({ scope, files: previous.scope === scope ? previous.files : [], loading: true, error: null }));
    try {
      if (pendingReconcile.current?.scope !== scope) {
        const promise = fetch(scopedUrl('/api/files/archive-generated'), { method: 'POST', credentials: 'include' })
          .then(response => { if (!response.ok) throw new Error('Archive unavailable'); });
        pendingReconcile.current = { scope, promise };
      }
      const pending = pendingReconcile.current;
      // Reuse successful reconciliation; retry failures without clearing a newer scope.
      // Awaiting it also collapses simultaneous refresh events to the latest request.
      await pending.promise.catch(() => { if (pendingReconcile.current === pending) pendingReconcile.current = null; });
      if (!current()) return;
      const response = await fetch(scopedUrl('/api/files/list'), { credentials: 'include' });
      if (!response.ok) throw Object.assign(new Error('Library unavailable'), { status: response.status });
      const data = await response.json();
      if (current()) setState({ scope, loading: false, error: null, files: Array.isArray(data.files) ? data.files : [] });
    } catch (error: any) {
      if (current()) setState(previous => ({ ...previous, scope, loading: false, error: error?.status || 'network' }));
    }
  }, [scope, scopedUrl]);
  useEffect(() => () => { revision.current++; }, [scope]);
  return { files: state.scope === scope ? state.files : [], loading: state.scope === scope && state.loading,
    error: state.scope === scope ? state.error : null, failed: state.scope === scope && state.error !== null, refresh };
}
