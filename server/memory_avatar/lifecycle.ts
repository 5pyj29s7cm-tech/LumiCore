import { readMemoryAvatarAuthorization } from './store';
import { watchers, keyFor } from './authorization_watchers';
export { invalidateMemoryAvatarAuthorization } from './authorization_watchers';

export function captureMemoryAvatarAuthorization(userId: string, avatarId: string) {
  const row = () => readMemoryAvatarAuthorization(userId, avatarId);
  const initial = row();
  const generation = initial?.sourceGeneration || 0;
  let revoked = !initial || initial.status !== 'active';
  const isCurrent = () => {
    const current = row();
    if (!current || current.status !== 'active' || current.sourceGeneration !== generation) revoked = true;
    return !revoked;
  };
  return {
    isCurrent,
    assertCurrent() {
      if (!isCurrent()) throw new DOMException('Memory avatar or its sources changed.', 'AbortError');
    },
    watch(controller: AbortController): () => void {
      const key = keyFor(userId, avatarId);
      if (!isCurrent()) { controller.abort(new DOMException('Memory avatar unavailable.', 'AbortError')); return () => {}; }
      const active = watchers.get(key) || new Set<AbortController>();
      active.add(controller);
      watchers.set(key, active);
      const release = () => {
        active.delete(controller);
        if (watchers.get(key) === active && active.size === 0) watchers.delete(key);
        controller.signal.removeEventListener('abort', release);
      };
      controller.signal.addEventListener('abort', release, { once: true });
      if (controller.signal.aborted) release();
      return release;
    },
  };
}
