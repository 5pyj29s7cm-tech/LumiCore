import type { Socket } from 'socket.io';
import { getMember } from '../org/db';

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
