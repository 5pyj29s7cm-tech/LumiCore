import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/local_identity';
import { getMember } from '../org/db';
import type { AuthUser } from '../middleware/auth';

export interface McpCallerScope {
  userId: string;
  username: string;
  role: string;
  /** True only when the transport verified a user JWT. */
  authenticated?: boolean;
  /** Narrow admission for a connector explicitly configured by the local owner. */
  trustedServiceExecution?: boolean;
  domain: 'personal' | 'work';
  orgId: string;
  orgRole?: string;
}

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function cookieToken(headers: IncomingHttpHeaders): string {
  const cookie = firstHeaderValue(headers.cookie);
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== 'token') continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function requestToken(headers: IncomingHttpHeaders): string {
  const authorization = firstHeaderValue(headers.authorization).trim();
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, '').trim();
  }
  return cookieToken(headers);
}

/**
 * Authenticate an MCP WebSocket upgrade with the same JWT and organization
 * membership boundary used by the HTTP API. Tokens are accepted only from an
 * Authorization header or the desktop session cookie, never from the URL.
 */
export function authenticateMcpUpgradeRequest(request: IncomingMessage): AuthUser | null {
  const token = requestToken(request.headers);
  if (!token) return null;

  try {
    const decoded: any = jwt.verify(token, getJwtSecret());
    const uid = String(decoded?.uid || '').trim();
    if (!uid || decoded?.tokenType === 'organization_branch') return null;

    const user: AuthUser = {
      uid,
      username: String(decoded?.username || ''),
      role: String(decoded?.role || 'user'),
      orgId: decoded?.orgId ? String(decoded.orgId) : undefined,
      orgRole: decoded?.orgRole ? String(decoded.orgRole) : undefined,
      tokenType: 'user',
    };

    if (user.orgId) {
      const membership = getMember(user.orgId, user.uid);
      if (!membership || membership.status !== 'active') return null;
      user.orgRole = membership.role;
    }
    return user;
  } catch {
    return null;
  }
}

export function mcpScopeFromAuthUser(user?: AuthUser): McpCallerScope | null {
  const userId = String(user?.uid || '').trim();
  if (!userId) return null;
  const orgId = String(user?.orgId || '').trim();
  return {
    userId,
    username: String(user?.username || ''),
    role: String(user?.role || 'user'),
    authenticated: true,
    domain: orgId ? 'work' : 'personal',
    orgId,
    orgRole: orgId ? String(user?.orgRole || '') : undefined,
  };
}

export function sameMcpScope(left: McpCallerScope, right: McpCallerScope): boolean {
  return left.userId === right.userId
    && left.domain === right.domain
    && left.orgId === right.orgId
    && String(left.orgRole || '') === String(right.orgRole || '');
}
