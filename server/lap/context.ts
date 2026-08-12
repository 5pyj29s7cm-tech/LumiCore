import type {
  LAPContextEntry,
  LAPContextFirewallDecision,
  LAPContextShareRequest,
  LAPContextShareResponse,
  LAPSession,
} from './types';
import { evaluateLAPContextFirewall } from './firewall';

export interface SharedContextRecord {
  id: string;
  sessionId: string;
  fromAgentId: string;
  toAgentId: string;
  entry: LAPContextEntry;
  firewall: LAPContextFirewallDecision;
  sharedAt: string;
  expiresAt?: string;
}

const sharedContexts: Map<string, SharedContextRecord[]> = new Map();

export function shareContext(
  request: LAPContextShareRequest,
  session: LAPSession,
): LAPContextShareResponse {
  if (session.authorizationStatus !== 'approved') {
    return {
      accepted: false,
      acceptedEntries: 0,
      rejectedEntries: request.contexts.length,
      reason: 'Session is waiting for local user approval',
    };
  }
  if (!session.scope.includes('share_context')) {
    return {
      accepted: false,
      acceptedEntries: 0,
      rejectedEntries: request.contexts.length,
      reason: 'Session does not permit context sharing',
    };
  }

  let accepted = 0;
  let rejected = 0;
  const rejectedReasons: string[] = [];

  for (const entry of request.contexts) {
    const firewall = evaluateLAPContextFirewall(entry, session);
    if (!firewall.accepted || !firewall.normalizedEntry) {
      rejected++;
      if (firewall.reason) rejectedReasons.push(firewall.reason);
      continue;
    }

    const normalizedEntry = firewall.normalizedEntry;
    const record: SharedContextRecord = {
      id: `${session.sessionId}_ctx_${accepted}_${Date.now()}`,
      sessionId: session.sessionId,
      fromAgentId: session.peerA.agentId,
      toAgentId: session.peerB.agentId,
      entry: normalizedEntry,
      firewall,
      sharedAt: new Date().toISOString(),
    };

    if (normalizedEntry.expiresAt) {
      record.expiresAt = normalizedEntry.expiresAt;
    } else if (normalizedEntry.scope === 'one-time') {
      record.expiresAt = new Date(Date.now() + 300_000).toISOString();
    } else {
      record.expiresAt = undefined;
    }

    if (!sharedContexts.has(session.sessionId)) {
      sharedContexts.set(session.sessionId, []);
    }
    sharedContexts.get(session.sessionId)!.push(record);
    accepted++;
  }

  return {
    accepted: accepted > 0,
    acceptedEntries: accepted,
    rejectedEntries: rejected,
    rejectedReasons: rejectedReasons.length ? rejectedReasons : undefined,
    reason: accepted > 0 ? undefined : rejectedReasons[0],
  };
}

export function getSharedContexts(sessionId: string): SharedContextRecord[] {
  return sharedContexts.get(sessionId) || [];
}

export function getActiveSharedContexts(sessionId: string): SharedContextRecord[] {
  const records = sharedContexts.get(sessionId) || [];
  const now = new Date().toISOString();
  return records.filter(record => !record.expiresAt || record.expiresAt > now);
}

export function getSharedContext(sessionId: string, contextId: string): SharedContextRecord | undefined {
  return getActiveSharedContexts(sessionId).find(record => record.id === contextId);
}

export function removeSharedContexts(sessionId: string): number {
  const count = (sharedContexts.get(sessionId) || []).length;
  sharedContexts.delete(sessionId);
  return count;
}

export function resetSharedContextsForTests(): void {
  sharedContexts.clear();
}
