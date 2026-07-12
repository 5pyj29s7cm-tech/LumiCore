import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import * as OrgDB from '../server/org/db';
import { ToolRegistry } from '../server/tools/registry';
import { registerWebLoginTools } from '../server/tools/definitions/web_login_tools';

describe('web login profile scope and organization roles', () => {
  const ownerId = `web-login-owner-${Date.now()}`;
  const viewerId = `web-login-viewer-${Date.now()}`;
  let orgId = '';
  const profileId = `shared-login-${Date.now()}`;

  beforeAll(async () => {
    await initDatabase();
    const org = OrgDB.createOrg('Web Login Scope', `web-login-scope-${Date.now()}`, ownerId);
    orgId = org.id;
    OrgDB.addMember(orgId, ownerId, 'owner');
    OrgDB.addMember(orgId, viewerId, 'viewer');
  });

  it('lets an organization administrator create a shared profile without exposing its password', async () => {
    const registry = new ToolRegistry();
    registerWebLoginTools(registry);
    const saved = JSON.parse(await registry.execute('web_login_profile_save', {
      id: profileId,
      label: 'Shared CRM',
      loginUrl: 'https://example.com/login',
      username: 'team@example.com',
      password: 'not-returned',
    }, {
      userId: ownerId,
      domain: 'work',
      orgId,
      userConfirmed: true,
    }));

    expect(saved.profile).toMatchObject({ id: profileId, domain: 'work', orgId, hasPassword: true });
    expect(JSON.stringify(saved)).not.toContain('not-returned');
  });

  it('lets viewers use/list the shared profile but not change it', async () => {
    const registry = new ToolRegistry();
    registerWebLoginTools(registry);
    const listed = JSON.parse(await registry.execute('web_login_profile_list', {}, {
      userId: viewerId,
      domain: 'work',
      orgId,
    }));
    expect(listed.profiles.some((profile: any) => profile.id === profileId)).toBe(true);

    await expect(registry.execute('web_login_profile_save', {
      id: profileId,
      label: 'Changed by viewer',
      loginUrl: 'https://example.com/login',
    }, {
      userId: viewerId,
      domain: 'work',
      orgId,
      userConfirmed: true,
    })).rejects.toThrow(/owner or administrator/);
  });

  it('does not expose an organization profile in personal Lumi', async () => {
    const registry = new ToolRegistry();
    registerWebLoginTools(registry);
    const listed = JSON.parse(await registry.execute('web_login_profile_list', {}, {
      userId: ownerId,
      domain: 'personal',
      orgId: '',
    }));
    expect(listed.profiles.some((profile: any) => profile.id === profileId)).toBe(false);
  });

  it('allows the organization owner to remove the shared profile and its persisted session', async () => {
    const registry = new ToolRegistry();
    registerWebLoginTools(registry);
    const result = JSON.parse(await registry.execute('web_login_profile_delete', { id: profileId }, {
      userId: ownerId,
      domain: 'work',
      orgId,
      userConfirmed: true,
    }));
    expect(result.deleted).toBe(true);
  });
});
