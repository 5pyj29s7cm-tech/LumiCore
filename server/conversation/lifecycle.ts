import { readDB } from '../../db_layer';

export type ConversationOwner = { userId: string; domain: 'personal' | 'work'; orgId?: string; agentId?: string };
export type RequestAuthorization = {
  isCurrent(): boolean;
  assertCurrent(): void;
  watch(controller: AbortController): () => void;
};

/** Closing/rolling over a transcript is allowed; deleting its identity is terminal. */
export function conversationExists(conversationId: string, owner: ConversationOwner): boolean {
  if (!conversationId) return false;
  return (readDB().conversations || []).some(row => row.id === conversationId
    && row.userId === owner.userId
    && (!owner.agentId || row.agentId === owner.agentId)
    && (owner.domain === 'work'
      ? row.domain === 'work' && String(row.orgId || '') === String(owner.orgId || '')
      : row.domain !== 'work' && !row.orgId));
}

export function captureConversationAuthorization(
  owner: ConversationOwner,
  conversationId: () => string,
): RequestAuthorization {
  let revoked = false;
  const controllers = new Set<AbortController>();
  const error = () => new DOMException('Conversation was deleted or is no longer available.', 'AbortError');
  const isCurrent = () => {
    if (!conversationExists(conversationId(), owner)) revoked = true;
    if (revoked) for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort(error());
    }
    return !revoked;
  };
  return {
    isCurrent,
    assertCurrent() { if (!isCurrent()) throw error(); },
    watch(controller) {
      controllers.add(controller);
      isCurrent();
      const timer = setInterval(isCurrent, 100);
      timer.unref?.();
      return () => { clearInterval(timer); controllers.delete(controller); };
    },
  };
}

export function combineRequestAuthorizations(...guards: RequestAuthorization[]): RequestAuthorization {
  return {
    isCurrent: () => guards.every(guard => guard.isCurrent()),
    assertCurrent() { for (const guard of guards) guard.assertCurrent(); },
    watch(controller) {
      const stop = guards.map(guard => guard.watch(controller));
      return () => { for (const unsubscribe of stop) unsubscribe(); };
    },
  };
}

/** Post-turn enrichment outlives the foreground lease but keeps its own validity watch. */
export async function runAuthorizedEnrichment<T>(
  authorization: RequestAuthorization,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const stop = authorization.watch(controller);
  try {
    authorization.assertCurrent();
    const value = await run(controller.signal);
    authorization.assertCurrent();
    return value;
  } finally { stop(); }
}
