import { describe, expect, it } from 'vitest';
import { consumePairingTicket, createPairingTicket, inspectPairingTicket } from '../server/lap/pairing';

describe('LAP pairing tickets', () => {
  it('binds an inbound peer to the issuing workspace and intersects requested scopes', () => {
    const target = { userId: 'owner-a', domain: 'work' as const, orgId: 'org-a' };
    const ticket = createPairingTicket(target, ['share_context', 'notify']);
    const result = consumePairingTicket(ticket.token, 'peer-a', ['delegate_task', 'notify']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ticket.target).toEqual(target);
    expect(result.grantedScopes).toEqual(['notify']);
  });

  it('is single-use and cannot be replayed', () => {
    const ticket = createPairingTicket(
      { userId: 'owner-b', domain: 'personal', orgId: '' },
      ['share_context'],
    );

    expect(consumePairingTicket(ticket.token, 'peer-b', ['share_context']).ok).toBe(true);
    expect(consumePairingTicket(ticket.token, 'peer-b', ['share_context'])).toMatchObject({ ok: false });
  });

  it('rejects a peer that requests no locally allowed scope', () => {
    const ticket = createPairingTicket(
      { userId: 'owner-c', domain: 'personal', orgId: '' },
      ['notify'],
    );

    expect(consumePairingTicket(ticket.token, 'peer-c', ['delegate_task'])).toMatchObject({ ok: false });
  });

  it('does not spend a ticket during preflight validation', () => {
    const ticket = createPairingTicket(
      { userId: 'owner-d', domain: 'personal', orgId: '' },
      ['notify'],
    );

    expect(inspectPairingTicket(ticket.token, 'peer-d', ['notify']).ok).toBe(true);
    expect(inspectPairingTicket(ticket.token, 'peer-d', ['notify']).ok).toBe(true);
    expect(consumePairingTicket(ticket.token, 'peer-d', ['notify']).ok).toBe(true);
  });
});
