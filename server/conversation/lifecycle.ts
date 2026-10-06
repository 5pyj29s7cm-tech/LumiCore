import { ownedConversationExists } from './history_repository';

export type ConversationOwner = { userId: string; domain: 'personal' | 'work'; orgId?: string; agentId?: string };
export type RequestAuthorization = {
  isCurrent(): boolean;
  assertCurrent(): void;
  watch(controller: AbortController): () => void;
};

/** Closing/rolling over a transcript is allowed; deleting its identity is terminal. */
export function conversationExists(conversationId: string, owner: ConversationOwner): boolean {
  return ownedConversationExists(conversationId, owner);
}

/** A revocation is permanent for this request and aborts every registered owner. */
export function captureRequestAuthorization(
  isAuthorized: () => boolean,
  reason: string,
): RequestAuthorization {
  let revoked = false;
  const controllers = new Set<AbortController>();
  const error = () => new DOMException(reason, 'AbortError');
  const isCurrent = () => {
    if (!isAuthorized()) revoked = true;
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

export function captureConversationAuthorization(
  owner: ConversationOwner,
  conversationId: () => string,
): RequestAuthorization {
  return captureRequestAuthorization(() => conversationExists(conversationId(), owner),
    'Conversation was deleted or is no longer available.');
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
