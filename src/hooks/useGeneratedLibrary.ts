import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '@/components/MemoryTree/types';

/** The scope contains the account/domain, deliberately never a conversation ID. */
export function useGeneratedLibrary(scope: string, scopedUrl: (url: string) => string) {
  const [state, setState] = useState<{ scope: string; files: FileEntry[]; loading: boolean; failed: boolean }>({ scope, files: [], loading: false, failed: false });
  const currentScope = useRef(scope); currentScope.current = scope;
  const revision = useRef(0);
  const reconciled = useRef('');
  const pendingReconcile = useRef<{ scope: string; promise: Promise<void> } | null>(null);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    const current = () => currentScope.current === scope && revision.current === request;
    setState(previous => ({ scope, files: previous.scope === scope ? previous.files : [], loading: true, failed: false }));
    try {
      if (reconciled.current !== scope) {
        if (pendingReconcile.current?.scope !== scope) {
          const promise = fetch(scopedUrl('/api/files/archive-generated'), { method: 'POST', credentials: 'include' })
            .then(response => { if (response.ok && currentScope.current === scope) reconciled.current = scope; })
            .catch(() => {});
          pendingReconcile.current = { scope, promise };
        }
        await pendingReconcile.current.promise;
        if (pendingReconcile.current?.scope === scope) pendingReconcile.current = null;
      }
      if (!current()) return;
      const response = await fetch(scopedUrl('/api/files/list'), { credentials: 'include' });
      if (!response.ok) throw new Error('Library unavailable');
      const data = await response.json();
      if (current()) setState({ scope, loading: false, failed: false, files: (Array.isArray(data.files) ? data.files : []).sort((a: FileEntry, b: FileEntry) =>
        new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime()) });
    } catch {
      if (current()) setState(previous => ({ ...previous, scope, loading: false, failed: true }));
    }
  }, [scope, scopedUrl]);
  useEffect(() => () => { revision.current++; }, [scope]);
  return { files: state.scope === scope ? state.files : [], loading: state.scope === scope && state.loading,
    failed: state.scope === scope && state.failed, refresh };
}
