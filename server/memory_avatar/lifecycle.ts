import { readDB } from '../../db_layer';

const watchers = new Map<string, Set<AbortController>>();
const keyFor = (userId: string, avatarId: string) => JSON.stringify([userId, avatarId]);

/** Called synchronously when a private source is removed or its avatar archived. */
export function invalidateMemoryAvatarAuthorization(userId: string, avatarId: string): void {
  const key = keyFor(userId, avatarId);
  const active = watchers.get(key);
  watchers.delete(key);
  for (const controller of active || []) {
    controller.abort(new DOMException('Memory avatar or its sources changed.', 'AbortError'));
  }
}

export function captureMemoryAvatarAuthorization(userId: string, avatarId: string) {
  const row = () => (readDB().memoryAvatars || []).find((item: any) => item.id === avatarId && item.userId === userId);
  const initial = row();
  const generation = Number(initial?.payload?.sourceGeneration) || 0;
  let revoked = !initial || initial.status !== 'active';
  const isCurrent = () => {
    const current = row();
    if (!current || current.status !== 'active' || (Number(current.payload?.sourceGeneration) || 0) !== generation) revoked = true;
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
