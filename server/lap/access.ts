import { readDB, writeDB } from '../../db_layer';
import { createHash } from 'crypto';
import type { AuthUser } from '../middleware/auth';
import { resolveDomain } from '../middleware/auth';
import { getSession, approveSession } from './session';
import type { LAPSession } from './types';

const BINDING_SETTING_KEY = '__lumi_lap_session_bindings_v1';

export interface LAPAccessScope {
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
}

export interface LAPSessionBinding extends LAPAccessScope {
  sessionId: string;
  peerAgentId: string;
  peerUserId: string;
  peerKeyFingerprint: string;
  status: 'approved' | 'revoked';
  approvedAt: string;
  revokedAt?: string;
}

export function lapAccessScope(user: AuthUser): LAPAccessScope {
  const domain = resolveDomain(user);
  return { userId: user.uid, domain: domain.domain, orgId: domain.orgId };
}

function readBindings(): LAPSessionBinding[] {
  try {
    const row = (readDB().settings || []).find((item: any) => item?.key === BINDING_SETTING_KEY);
    const parsed = row?.value ? JSON.parse(row.value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBindings(bindings: LAPSessionBinding[]): void {
  const db = readDB();
  if (!Array.isArray(db.settings)) db.settings = [];
  const value = JSON.stringify(bindings.slice(-500));
  const index = db.settings.findIndex((item: any) => item?.key === BINDING_SETTING_KEY);
  if (index >= 0) db.settings[index].value = value;
  else db.settings.push({ key: BINDING_SETTING_KEY, value });
  writeDB(db);
}

function sameScope(left: LAPAccessScope, right: LAPAccessScope): boolean {
  return left.userId === right.userId && left.domain === right.domain && left.orgId === right.orgId;
}

export function sessionTargetsScope(session: LAPSession, scope: LAPAccessScope): boolean {
  return session.targetUserId === scope.userId
    && (session.targetDomain || 'personal') === scope.domain
    && (session.targetDomain === 'work' ? String(session.targetOrgId || '') === scope.orgId : scope.orgId === '');
}

export function getSessionBinding(sessionId: string): LAPSessionBinding | undefined {
  return readBindings().find(binding => binding.sessionId === sessionId && binding.status === 'approved');
}

export function canInspectSession(session: LAPSession, scope: LAPAccessScope): boolean {
  if (sessionTargetsScope(session, scope)) return true;
  const binding = getSessionBinding(session.sessionId);
  return Boolean(binding && sameScope(binding, scope));
}

export function canUseSession(session: LAPSession, scope: LAPAccessScope): boolean {
  if (session.authorizationStatus !== 'approved') return false;
  const binding = getSessionBinding(session.sessionId);
  return Boolean(binding && sameScope(binding, scope));
}

export function claimSession(input: {
  sessionId: string;
  peerAgentId: string;
  scope: LAPAccessScope;
}): { ok: true; session: LAPSession; binding: LAPSessionBinding; reason?: never } | { ok: false; reason: string; session?: never; binding?: never } {
  const session = getSession(input.sessionId);
  if (!session) return { ok: false, reason: 'LAP session not found or expired.' };
  if (!sessionTargetsScope(session, input.scope)) return { ok: false, reason: 'LAP session target does not match the active workspace.' };
  const peer = session.peerA.agentId === input.peerAgentId ? session.peerA
    : session.peerB.agentId === input.peerAgentId ? session.peerB
      : null;
  if (!peer) return { ok: false, reason: 'Peer identity does not match this LAP session.' };

  const bindings = readBindings();
  const occupied = bindings.find(binding => binding.sessionId === input.sessionId && binding.status === 'approved');
  if (occupied && !sameScope(occupied, input.scope)) {
    return { ok: false, reason: 'LAP session is already bound to another workspace.' };
  }

  const approved = approveSession(input.sessionId);
  if (!approved) return { ok: false, reason: 'LAP session cannot be approved.' };
  const binding: LAPSessionBinding = {
    ...input.scope,
    sessionId: input.sessionId,
    peerAgentId: peer.agentId,
    peerUserId: peer.userId,
    peerKeyFingerprint: createHash('sha256').update(peer.publicKey).digest('hex'),
    status: 'approved',
    approvedAt: new Date().toISOString(),
  };
  writeBindings([...bindings.filter(item => item.sessionId !== input.sessionId), binding]);
  return { ok: true, session: approved, binding };
}

export function revokeSessionBinding(sessionId: string, scope: LAPAccessScope): boolean {
  const bindings = readBindings();
  const current = bindings.find(binding => binding.sessionId === sessionId && binding.status === 'approved');
  if (!current || !sameScope(current, scope)) return false;
  const now = new Date().toISOString();
  writeBindings(bindings.map(binding => binding.sessionId === sessionId
    ? { ...binding, status: 'revoked' as const, revokedAt: now }
    : binding));
  return true;
}
