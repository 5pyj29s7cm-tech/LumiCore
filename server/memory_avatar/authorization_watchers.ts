export const watchers = new Map<string, Set<AbortController>>();
export const keyFor = (userId: string, avatarId: string) => JSON.stringify([userId, avatarId]);

/** Called synchronously when a private source is removed or its avatar archived. */
export function invalidateMemoryAvatarAuthorization(userId: string, avatarId: string): void {
  const key = keyFor(userId, avatarId);
  const active = watchers.get(key);
  watchers.delete(key);
  for (const controller of active || []) {
    controller.abort(new DOMException('Memory avatar or its sources changed.', 'AbortError'));
  }
}
