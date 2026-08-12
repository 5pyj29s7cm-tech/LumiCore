import { randomBytes, randomUUID } from 'crypto';
import type { LAPAccessScope } from './access';
import type { LAPScope } from './types';

const TICKET_TTL_MS = 10 * 60_000;
const MAX_TICKETS = 200;
const ALLOWED_SCOPES = new Set<LAPScope>(['share_context', 'delegate_task', 'negotiate', 'notify']);

export interface LAPPairingTicket {
  ticketId: string;
  token: string;
  target: LAPAccessScope;
  allowedScopes: LAPScope[];
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  consumedByAgentId?: string;
}

const tickets = new Map<string, LAPPairingTicket>();

function pruneTickets(now = Date.now()): void {
  for (const [token, ticket] of tickets) {
    if (Date.parse(ticket.expiresAt) <= now || ticket.consumedAt) tickets.delete(token);
  }
  if (tickets.size <= MAX_TICKETS) return;
  const oldest = [...tickets.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const ticket of oldest.slice(0, tickets.size - MAX_TICKETS)) tickets.delete(ticket.token);
}

export function normalizeLAPScopes(value: unknown): LAPScope[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map(item => String(item || '').trim() as LAPScope)
    .filter(item => ALLOWED_SCOPES.has(item))))
    .slice(0, ALLOWED_SCOPES.size);
}

export function createPairingTicket(
  target: LAPAccessScope,
  requestedScopes: unknown,
  now = new Date(),
): LAPPairingTicket {
  pruneTickets(now.getTime());
  const allowedScopes = normalizeLAPScopes(requestedScopes);
  const ticket: LAPPairingTicket = {
    ticketId: randomUUID(),
    token: `lap_pair_${randomBytes(24).toString('base64url')}`,
    target: { ...target },
    allowedScopes: allowedScopes.length ? allowedScopes : ['notify'],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TICKET_TTL_MS).toISOString(),
  };
  tickets.set(ticket.token, ticket);
  return structuredClone(ticket);
}

export function consumePairingTicket(
  token: string,
  peerAgentId: string,
  proposedScopes: unknown,
  now = new Date(),
): { ok: true; ticket: LAPPairingTicket; grantedScopes: LAPScope[] } | { ok: false; reason: string } {
  const inspected = inspectPairingTicket(token, peerAgentId, proposedScopes, now);
  if (!inspected.ok) return inspected;
  const { ticket, grantedScopes } = inspected;
  const consumedAt = now.toISOString();
  const consumed = { ...ticket, consumedAt, consumedByAgentId: peerAgentId };
  tickets.delete(ticket.token);
  return { ok: true, ticket: consumed, grantedScopes };
}

/** Validate a ticket without spending it. The transport consumes it only after
 * the complete handshake has passed validation, so malformed requests cannot
 * invalidate a legitimate user's one-time pairing code. */
export function inspectPairingTicket(
  token: string,
  peerAgentId: string,
  proposedScopes: unknown,
  now = new Date(),
): { ok: true; ticket: LAPPairingTicket; grantedScopes: LAPScope[] } | { ok: false; reason: string } {
  pruneTickets(now.getTime());
  const ticket = tickets.get(String(token || '').trim());
  if (!ticket) return { ok: false, reason: 'Pairing ticket is invalid, expired, or already used.' };
  if (!peerAgentId) return { ok: false, reason: 'Pairing peer identity is missing.' };
  const proposed = normalizeLAPScopes(proposedScopes);
  const grantedScopes = proposed.filter(scope => ticket.allowedScopes.includes(scope));
  if (grantedScopes.length === 0) return { ok: false, reason: 'The peer did not request any scope allowed by this pairing ticket.' };

  return { ok: true, ticket: structuredClone(ticket), grantedScopes };
}

export function revokePairingTicket(token: string, target: LAPAccessScope): boolean {
  const ticket = tickets.get(String(token || '').trim());
  if (!ticket) return false;
  if (ticket.target.userId !== target.userId || ticket.target.domain !== target.domain || ticket.target.orgId !== target.orgId) return false;
  return tickets.delete(ticket.token);
}

export function listPairingTickets(target: LAPAccessScope): Array<Omit<LAPPairingTicket, 'token'>> {
  pruneTickets();
  return [...tickets.values()]
    .filter(ticket => ticket.target.userId === target.userId && ticket.target.domain === target.domain && ticket.target.orgId === target.orgId)
    .map(({ token: _token, ...ticket }) => structuredClone(ticket));
}

export function resetPairingTicketsForTests(): void {
  tickets.clear();
}
