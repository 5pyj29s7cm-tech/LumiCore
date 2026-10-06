import { getMember } from '../org/db';
import { captureRequestAuthorization, type RequestAuthorization } from '../conversation/lifecycle';
import type { RuntimeScope } from './scope';

/** An admitted turn keeps its original scope and membership, including across remove/rejoin. */
export function captureChatAuthorization(userId: string, scope: RuntimeScope): RequestAuthorization {
  const { domain, orgId } = scope;
  if (domain !== 'work') return { isCurrent: () => true, assertCurrent() {}, watch: () => () => {} };
  const member = getMember(orgId, userId);
  const membershipId = member?.id;
  const role = member?.role;
  return captureRequestAuthorization(() => {
    const current = getMember(orgId, userId);
    return Boolean(membershipId && current?.id === membershipId && current.status === 'active' && current.role === role);
  }, 'Organization access changed during this request.');
}
