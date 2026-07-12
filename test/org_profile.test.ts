import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers';
import * as OrgDB from '../server/org/db';

let cleanup = () => {};

beforeAll(async () => {
  const app = await makeApp();
  cleanup = app.cleanup;
});

afterAll(() => cleanup());

describe('organization profile persistence', () => {
  it('updates the real organization name instead of hiding it in settings', () => {
    const org = OrgDB.createOrg('Old Name', `rename-${Date.now()}`, 'profile-owner');
    const updated = OrgDB.updateOrgProfile(org.id, { name: 'New Organization Name' });

    expect(updated?.name).toBe('New Organization Name');
    expect(JSON.parse(updated?.settings || '{}')).not.toHaveProperty('name');
    expect(OrgDB.getOrgById(org.id)?.name).toBe('New Organization Name');
  });

  it('repairs irrecoverable replacement characters with a readable slug fallback', () => {
    const org = OrgDB.createOrg('\uFFFD\uFFFD Broken', `repair-org-${Date.now()}`, 'repair-owner');
    const repaired = OrgDB.repairCorruptedOrganizationNames();
    const saved = OrgDB.getOrgById(org.id);

    expect(repaired).toBeGreaterThan(0);
    expect(saved?.name).not.toContain('\uFFFD');
    expect(saved?.name).toContain('Repair Org');
  });
});
