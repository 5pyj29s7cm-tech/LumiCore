import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import { createAgentForSkill } from '../server/agents/skill_agent';

describe('skill team agent scope', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('creates unique agents for personal users and a shared agent per organization', () => {
    const skillName = `Scoped Skill ${Date.now()}`;
    const personalA = createAgentForSkill(skillName, {
      scope: { ownerUid: 'skill-user-a', userId: 'skill-user-a', domain: 'personal', orgId: '' },
    });
    const personalB = createAgentForSkill(skillName, {
      scope: { ownerUid: 'skill-user-b', userId: 'skill-user-b', domain: 'personal', orgId: '' },
    });
    const organization = createAgentForSkill(skillName, {
      scope: { ownerUid: 'org-owner', userId: 'org-owner', domain: 'work', orgId: 'skill-org' },
    });
    const organizationAgain = createAgentForSkill(skillName, {
      scope: { ownerUid: 'org-member', userId: 'org-member', domain: 'work', orgId: 'skill-org' },
    });

    expect(personalA).toBeTruthy();
    expect(new Set([personalA, personalB, organization]).size).toBe(3);
    expect(organizationAgain).toBe(organization);

    const scoped = readDB().agents.filter((agent: any) => [personalA, personalB, organization].includes(agent.id));
    expect(scoped).toHaveLength(3);
    expect(scoped.find((agent: any) => agent.id === personalA)?.ownerUid).toBe('skill-user-a');
    expect(scoped.find((agent: any) => agent.id === personalB)?.ownerUid).toBe('skill-user-b');
    expect(scoped.find((agent: any) => agent.id === organization)?.orgId).toBe('skill-org');
  });
});
