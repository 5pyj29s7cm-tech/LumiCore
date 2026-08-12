import { randomUUID } from 'crypto';
import type {
  LAPAgentIdentity,
  LAPSession,
  LAPTrustLevel,
  LAPScope,
  LAPHandshakeRequest,
  LAPHandshakeResponse,
} from './types';

const sessions: Map<string, LAPSession> = new Map();
const agentPeers: Map<string, Set<string>> = new Map(); // agentId → set<sessionId>

const HEARTBEAT_TIMEOUT = 120_000; // 2 min
const SESSION_CLEANUP_INTERVAL = 300_000; // 5 min

export function createSession(
  peerA: LAPAgentIdentity,
  peerB: LAPAgentIdentity,
  trustLevel: LAPTrustLevel,
  scope: LAPScope[],
  target?: LAPHandshakeRequest['target'],
): LAPSession {
  const session: LAPSession = {
    sessionId: randomUUID(),
    peerA,
    peerB,
    trustLevel,
    scope: [],
    requestedScope: scope,
    authorizationStatus: 'pending',
    targetUserId: target?.userId,
    targetDomain: target?.domain,
    targetOrgId: target?.domain === 'work' ? String(target.orgId || '') : '',
    establishedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
  };
  sessions.set(session.sessionId, session);

  // Index by agent
  for (const agentId of [peerA.agentId, peerB.agentId]) {
    if (!agentPeers.has(agentId)) agentPeers.set(agentId, new Set());
    agentPeers.get(agentId)!.add(session.sessionId);
  }

  return session;
}

export function getSession(sessionId: string): LAPSession | undefined {
  return sessions.get(sessionId);
}

export function getPeerSessions(agentId: string): LAPSession[] {
  const sessionIds = agentPeers.get(agentId);
  if (!sessionIds) return [];
  return Array.from(sessionIds).map(id => sessions.get(id)!).filter(Boolean);
}

export function removeSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  for (const agentId of [session.peerA.agentId, session.peerB.agentId]) {
    agentPeers.get(agentId)?.delete(sessionId);
  }
  return sessions.delete(sessionId);
}

export function approveSession(sessionId: string): LAPSession | undefined {
  const session = sessions.get(sessionId);
  if (!session || session.authorizationStatus === 'revoked') return undefined;
  session.authorizationStatus = 'approved';
  session.scope = [...(session.requestedScope || [])];
  session.lastHeartbeat = new Date().toISOString();
  return session;
}

export function updateHeartbeat(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) session.lastHeartbeat = new Date().toISOString();
}

export function validateHeartbeats(): string[] {
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, session] of sessions) {
    const lastHb = new Date(session.lastHeartbeat).getTime();
    if (now - lastHb > HEARTBEAT_TIMEOUT) {
      expired.push(id);
    }
  }
  for (const id of expired) removeSession(id);
  return expired;
}

// Auto-cleanup every 5 min
setInterval(validateHeartbeats, SESSION_CLEANUP_INTERVAL);

export function validateHandshake(
  request: LAPHandshakeRequest,
  localAgent: LAPAgentIdentity,
): { valid: boolean; reason?: string; trustLevel?: LAPTrustLevel } {
  // Check agent ID is non-empty
  if (!request.agent.agentId || !request.agent.userId || !request.agent.publicKey) {
    return { valid: false, reason: 'Agent identity incomplete: missing agentId, userId, or public key' };
  }

  if (!request.target?.userId || !['personal', 'work'].includes(request.target.domain)) {
    return { valid: false, reason: 'Handshake requires a local pairing target' };
  }
  if (request.target.domain === 'work' && !String(request.target.orgId || '').trim()) {
    return { valid: false, reason: 'Organization pairing requires target.orgId' };
  }

  // Check nonce length
  if (!request.nonce || request.nonce.length < 32) {
    return { valid: false, reason: 'Nonce too short (min 32 hex chars)' };
  }

  // Prevent self-connection
  if (request.agent.agentId === localAgent.agentId) {
    return { valid: false, reason: 'Cannot handshake with self' };
  }

  // Determine trust level
  let trustLevel: LAPTrustLevel = 'public';
  // TODO: check trust registry — known contacts get 'direct', verified get 'delegated'
  // For now, all new peers start as 'public'

  return { valid: true, trustLevel };
}

export function buildHandshakeResponse(
  request: LAPHandshakeRequest,
  localAgent: LAPAgentIdentity,
  trustLevel: LAPTrustLevel,
  scope: LAPScope[],
): LAPHandshakeResponse {
  const session = createSession(request.agent, localAgent, trustLevel, scope, request.target);
  return {
    accepted: true,
    sessionId: session.sessionId,
    agent: localAgent,
    trustLevel,
    scope: [],
    authorizationStatus: 'pending',
  };
}

export function getAllSessions(): LAPSession[] {
  return Array.from(sessions.values());
}

export function resetLAPSessionsForTests(): void {
  sessions.clear();
  agentPeers.clear();
}
