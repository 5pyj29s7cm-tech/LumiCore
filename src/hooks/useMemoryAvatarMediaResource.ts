import { useEffect, useMemo, useState } from 'react';
import type { MemoryAvatarMediaVariant } from '../../shared/memory_avatar';
import { getStoredToken } from '../services/authService';
import { loadMemoryAvatarMediaResource } from '../services/memoryAvatarMediaService';

export function useMemoryAvatarMediaResource({ ownerId, avatarId, mediaId, variant = 'original', enabled = true }: {
  ownerId: string; avatarId: string; mediaId?: string; variant?: MemoryAvatarMediaVariant; enabled?: boolean;
}) {
  const token = getStoredToken();
  const key = useMemo(() => ({ ownerId, avatarId, mediaId, variant, token, enabled }), [ownerId, avatarId, mediaId, variant, token, enabled]);
  const [state, setState] = useState<{ key?: typeof key; url?: string; error?: Error }>({});
  const active = Boolean(ownerId && avatarId && mediaId && enabled);
  useEffect(() => {
    if (!active || !mediaId) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void loadMemoryAvatarMediaResource(avatarId, mediaId, variant, controller.signal).then(resource => {
      if (controller.signal.aborted) { resource.release(); return; }
      release = resource.release;
      setState({ key, url: resource.url });
    }).catch(error => { if (!controller.signal.aborted) setState({ key, error }); });
    return () => { controller.abort(); release?.(); };
  }, [active, avatarId, mediaId, variant, key]);
  const current = active && state.key === key ? state : {};
  return { url: current.url, error: current.error, loading: active && !current.url && !current.error };
}
