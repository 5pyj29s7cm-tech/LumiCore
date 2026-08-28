import type { Socket } from 'socket.io';
import { getMember } from '../org/db';
import type { ToolContext } from '../tools/types';

export type RuntimeDomain = 'personal' | 'work';

export interface RuntimeScope {
  domain: RuntimeDomain;
  orgId: string;
  orgRole?: string;
}

export interface RequestedRuntimeScope {
  domain?: RuntimeDomain;
  orgId?: string;
}

export type SocketToolSecurityContext = Pick<
  ToolContext,
  'authenticated' | 'authRole' | 'orgRole' | 'localExecution' | 'executionBoundary'
>;

/**
 * Project the transport-owned socket identity into every tool/runtime
 * context.  Loopback is intentionally irrelevant: only a native session proof
 * verified by the Socket.IO authentication middleware can set
 * trustedLocalExecution.
 */
export function buildSocketToolSecurityContext(
  socket: Socket,
  scope: RuntimeScope,
): SocketToolSecurityContext {
  const authenticated = Boolean(String(socket.data?.authenticatedUserId || '').trim());
  const localExecution = authenticated && socket.data?.trustedLocalExecution === true;
  return {
    authenticated,
    authRole: String(socket.data?.authenticatedRole || 'user'),
    orgRole: scope.orgRole || String(socket.data?.authenticatedOrgRole || '') || undefined,
    localExecution,
    executionBoundary: localExecution ? 'trusted_local' : 'remote_restricted',
  };
}

/**
 * Resolve runtime scope from the authenticated socket token. Request payloads
 * may describe UI state, but cannot cross the personal/organization boundary.
 */
export function resolveSocketScope(
  socket: Socket,
  userId: string,
  _requested: RequestedRuntimeScope = {},
): RuntimeScope {
  const tokenOrgId = String(socket.data?.authenticatedOrgId || '').trim();
  if (tokenOrgId) {
    const membership = getMember(tokenOrgId, userId);
    if (membership?.status === 'active') {
      return { domain: 'work', orgId: tokenOrgId, orgRole: membership.role };
    }
  }

  return { domain: 'personal', orgId: '' };
}

export function scopedEmotionalStateKey(userId: string, scope: RuntimeScope, agentId?: string): string {
  const owner = scope.domain === 'work' ? `${userId}:org:${scope.orgId}` : userId;
  return agentId ? `${owner}:agent:${agentId}` : owner;
}

export function runtimeScopeStorageKey(userId: string, scope: RuntimeScope): string {
  return scope.domain === 'work' ? `${userId}:org:${scope.orgId}` : `${userId}:personal`;
}
