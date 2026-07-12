import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import * as OrgDB from '../server/org/db';
import { resolveSocketScope } from '../server/socket/scope';

describe('socket runtime scope boundary', () => {
  const userId = `socket-scope-${Date.now()}`;
  let orgId = '';

  beforeAll(async () => {
    await initDatabase();
    const org = OrgDB.createOrg('Socket Scope Org', `socket-scope-${Date.now()}`, userId);
    orgId = org.id;
    OrgDB.addMember(orgId, userId, 'owner');
  });

  it('does not let a personal token enter work scope through payload fields', () => {
    const socket = { data: {} } as any;
    expect(resolveSocketScope(socket, userId, { domain: 'work', orgId })).toEqual({
      domain: 'personal',
      orgId: '',
    });
  });

  it('does not let an organization token read personal scope through payload fields', () => {
    const socket = { data: { authenticatedOrgId: orgId, authenticatedOrgRole: 'owner' } } as any;
    expect(resolveSocketScope(socket, userId, { domain: 'personal' })).toEqual({
      domain: 'work',
      orgId,
      orgRole: 'owner',
    });
  });

  it('uses the live membership role instead of a requested organization', () => {
    const socket = { data: { authenticatedOrgId: orgId, authenticatedOrgRole: 'viewer' } } as any;
    expect(resolveSocketScope(socket, userId, { domain: 'work', orgId: 'another-org' }).orgRole).toBe('owner');
  });
});
