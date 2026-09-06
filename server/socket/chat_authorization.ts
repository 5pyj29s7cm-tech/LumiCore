import { getMember } from '../org/db';
import type { RuntimeScope } from './scope';

/** An admitted turn keeps its original membership, including across remove/rejoin. */
export function captureChatAuthorization(userId: string, scope: RuntimeScope) {
  const member = scope.domain === 'work' ? getMember(scope.orgId, userId) : undefined;
  const membershipId = member?.id;
  const role = member?.role;
  let revoked = false;
  const controllers = new Set<AbortController>();
  const isCurrent = (): boolean => {
    if (scope.domain !== 'work') return true;
    const current = getMember(scope.orgId, userId);
    if (!membershipId || current?.id !== membershipId || current.status !== 'active' || current.role !== role) revoked = true;
    if (revoked) {
      for (const controller of controllers) {
        if (!controller.signal.aborted) controller.abort(new DOMException('Organization access changed during this request.', 'AbortError'));
      }
    }
    return !revoked;
  };
  return {
    isCurrent,
    assertCurrent() {
      if (!isCurrent()) throw new DOMException('Organization access changed during this request.', 'AbortError');
    },
    watch(controller: AbortController): () => void {
      if (scope.domain !== 'work') return () => {};
      controllers.add(controller);
      isCurrent();
      const timer = setInterval(isCurrent, 100);
      timer.unref?.();
      return () => { clearInterval(timer); controllers.delete(controller); };
    },
  };
}
