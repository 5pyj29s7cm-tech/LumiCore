import type { Socket } from 'socket.io';
import {
  captureOrganizationMembershipAuthorization,
  watchOrganizationMembershipAuthorization,
} from '../org/membership_authorization';
import type { RuntimeScope } from './scope';

/** A stopped work credential keeps its original scope only for exact cancellation. */
export function taskSocketScope(socket: Socket): RuntimeScope {
  const orgId = String(socket.data?.authenticatedOrgId || '').trim();
  return orgId ? { domain: 'work', orgId } : { domain: 'personal', orgId: '' };
}

/** One invocation owns this immutable identity until its real executor settles. */
export function captureTaskAuthorization(socket: Socket, userId: string) {
  const scope = taskSocketScope(socket);
  if (!userId || socket.data?.authenticatedUserId !== userId) throw new Error('An authenticated user session is required.');
  const membership = scope.domain === 'work'
    ? captureOrganizationMembershipAuthorization(scope.orgId, userId) : undefined;
  if (membership) scope.orgRole = membership.role;
  let revoked = false;
  let controller: AbortController | undefined;
  let onRevoked: (() => void) | undefined;
  let notified = false;
  const revoke = () => {
    revoked = true;
    if (!controller?.signal.aborted) controller?.abort(new DOMException('Task authorization was revoked.', 'AbortError'));
    if (onRevoked && !notified) { notified = true; onRevoked(); }
  };
  const watcher = membership
    ? watchOrganizationMembershipAuthorization(membership, scope.orgId, userId, revoke) : undefined;
  const isAuthorized = () => {
    if (!revoked && (socket.data?.authenticatedUserId !== userId
      || taskSocketScope(socket).orgId !== scope.orgId || watcher?.isAuthorized() === false)) revoke();
    return !revoked;
  };
  return {
    scope,
    isAuthorized,
    bindController(next: AbortController, notify?: () => void) { controller = next; onRevoked = notify; notified = false; isAuthorized(); if (revoked) revoke(); },
    isCancelled() { return !isAuthorized() || controller?.signal.aborted === true; },
    assertAuthorized() { if (!isAuthorized()) throw new DOMException('Task authorization was revoked.', 'AbortError'); },
    dispose() { watcher?.dispose(); },
  };
}
