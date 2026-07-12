import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import { personalityRegistry } from '../server/personality';
import type { EvolutionStep } from '../server/personality/evolution';
import {
  canAccessOrganizationWorkspaceView,
  listOrganizationWorkspaceViewsForRole,
  normalizeOrganizationWorkspaceView,
} from '../shared/org_workspace';

function evolutionStep(persona: string, version: string): EvolutionStep {
  return {
    version,
    timestamp: new Date().toISOString(),
    trigger: 'manual',
    depth: 'full',
    ownerProfile: {
      dominantTone: 'professional',
      frequentExpressions: [],
      interestClusters: [],
      formalityLevel: 0.7,
      emotionalExpressiveness: 0.4,
      communicationPatterns: [],
      synthesizedAt: new Date().toISOString(),
      memoryCount: 0,
    },
    mutations: [{
      field: 'expressionStyle.persona',
      from: '',
      to: persona,
      reason: 'workspace isolation regression test',
    }],
    narrative: 'Workspace isolation regression test',
  };
}

describe('one Lumi with isolated personal and organization workspaces', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('keeps a recognizable personal style in work while isolating each member work adaptation', () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const ownerId = `unified-lumi-owner-${suffix}`;
    const employeeId = `unified-lumi-employee-${suffix}`;
    const orgId = `unified-lumi-org-${suffix}`;
    const personalPersona = `owner-personal-style-${suffix}`;
    const ownerWorkPersona = `owner-work-style-${suffix}`;
    const employeeWorkPersona = `employee-work-style-${suffix}`;

    personalityRegistry.applyEvolution('lumi', evolutionStep(personalPersona, `personal-${suffix}`), {
      userId: ownerId,
    });

    expect(personalityRegistry.getForUser('lumi', ownerId)?.expressionStyle.persona).toBe(personalPersona);
    expect(personalityRegistry.getForUser('lumi', ownerId, orgId)?.expressionStyle.persona).toBe(personalPersona);
    expect(personalityRegistry.getForUser('lumi', employeeId, orgId)?.expressionStyle.persona).not.toBe(personalPersona);

    personalityRegistry.applyEvolution('lumi', evolutionStep(ownerWorkPersona, `owner-work-${suffix}`), {
      userId: ownerId,
      orgId,
    });
    personalityRegistry.applyEvolution('lumi', evolutionStep(employeeWorkPersona, `employee-work-${suffix}`), {
      userId: employeeId,
      orgId,
    });

    expect(personalityRegistry.getForUser('lumi', ownerId)?.expressionStyle.persona).toBe(personalPersona);
    expect(personalityRegistry.getForUser('lumi', ownerId, orgId)?.expressionStyle.persona).toBe(ownerWorkPersona);
    expect(personalityRegistry.getForUser('lumi', employeeId, orgId)?.expressionStyle.persona).toBe(employeeWorkPersona);

    const keys = (readDB().settings || []).map((setting: any) => String(setting.key || ''));
    expect(keys).toContain(`personality_user_state:lumi:org:${orgId}:member:${ownerId}`);
    expect(keys).toContain(`personality_user_state:lumi:org:${orgId}:member:${employeeId}`);
    expect(keys).not.toContain(`personality_user_state:lumi:org:${orgId}`);
  });

  it('normalizes organization destinations and enforces member role boundaries', () => {
    expect(normalizeOrganizationWorkspaceView('company-lumi')).toBe('chat');
    expect(normalizeOrganizationWorkspaceView('law firm')).toBe('legal');
    expect(normalizeOrganizationWorkspaceView('brand_design')).toBe('brand-design');
    expect(canAccessOrganizationWorkspaceView('viewer', 'messaging')).toBe(false);
    expect(canAccessOrganizationWorkspaceView(undefined, 'messaging')).toBe(false);
    expect(canAccessOrganizationWorkspaceView('viewer', 'audit')).toBe(false);
    expect(canAccessOrganizationWorkspaceView('member', 'messaging')).toBe(true);
    expect(canAccessOrganizationWorkspaceView('admin', 'audit')).toBe(true);
    expect(listOrganizationWorkspaceViewsForRole('viewer')).not.toContain('members');
    expect(listOrganizationWorkspaceViewsForRole('owner')).toEqual(expect.arrayContaining([
      'kb',
      'chat',
      'messaging',
      'review',
      'members',
      'audit',
      'legal',
      'spatial-design',
      'brand-design',
    ]));
  });
});
