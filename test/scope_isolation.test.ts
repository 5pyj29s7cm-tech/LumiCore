import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { addMemory, queryMemories } from '../server/memory/store';
import { getWorkflow, listWorkflows, saveWorkflow } from '../server/agents/workflows';
import { findWorkflowClusters, recordWorkflow } from '../server/skills/worklog';
import { listCapabilityLearningRecords, upsertCapabilityLearningRecord } from '../server/self_extension/capability_memory';

describe('personal and organization scope isolation', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('does not deduplicate identical personal and organization memories together', () => {
    const userId = `scope-memory-${Date.now()}`;
    const content = `same-content-${Date.now()}`;
    const personal = addMemory({
      userId,
      type: 'knowledge',
      content,
      keywords: ['scope-test'],
      confidence: 0.8,
      sourceInteractionId: 'scope-test-personal',
    }, { domain: 'personal', orgId: '' });
    const work = addMemory({
      userId,
      type: 'knowledge',
      content,
      keywords: ['scope-test'],
      confidence: 0.8,
      sourceInteractionId: 'scope-test-work',
    }, { domain: 'work', orgId: 'org-scope-test', privacyClass: 'organization' });

    expect(work.id).not.toBe(personal.id);
    expect(queryMemories({ userId, query: content, domain: 'personal', orgId: '', limit: 10 }).map(m => m.id)).toContain(personal.id);
    expect(queryMemories({ userId, query: content, domain: 'personal', orgId: '', limit: 10 }).map(m => m.id)).not.toContain(work.id);
    expect(queryMemories({ userId, query: content, domain: 'work', orgId: 'org-scope-test', limit: 10 }).map(m => m.id)).toContain(work.id);
  });

  it('allows the same workflow name in personal and organization scopes', () => {
    const userId = `scope-workflow-${Date.now()}`;
    const personal = saveWorkflow(userId, 'Daily review', 'Personal', [], undefined, undefined, { domain: 'personal', orgId: '' });
    const work = saveWorkflow(userId, 'Daily review', 'Organization', [], undefined, undefined, { domain: 'work', orgId: 'org-scope-test' });

    expect(work.id).not.toBe(personal.id);
    expect(getWorkflow(userId, 'Daily review', { domain: 'personal', orgId: '' })?.id).toBe(personal.id);
    expect(getWorkflow(userId, 'Daily review', { domain: 'work', orgId: 'org-scope-test' })?.id).toBe(work.id);
    expect(listWorkflows(userId, undefined, { domain: 'personal', orgId: '' })).toHaveLength(1);
    expect(listWorkflows(userId, undefined, { domain: 'work', orgId: 'org-scope-test' })).toHaveLength(1);
  });

  it('clusters operation traces only inside the requested owner and scope', () => {
    const userA = `scope-log-a-${Date.now()}`;
    const userB = `scope-log-b-${Date.now()}`;
    for (let index = 0; index < 3; index++) {
      recordWorkflow({
        userId: userA,
        domain: 'personal',
        orgId: '',
        userIntent: 'prepare daily case summary',
        toolSequence: [{ name: 'legal_case_summary', args: {}, resultSummary: 'ok' }],
        conversationExcerpt: 'prepare daily case summary',
      });
      recordWorkflow({
        userId: userB,
        domain: 'work',
        orgId: 'org-scope-test',
        userIntent: 'prepare daily case summary',
        toolSequence: [{ name: 'legal_case_summary', args: {}, resultSummary: 'ok' }],
        conversationExcerpt: 'prepare daily case summary',
      });
    }

    const personalClusters = findWorkflowClusters(3, userA, 'personal', '');
    const workClusters = findWorkflowClusters(3, userB, 'work', 'org-scope-test');
    expect(personalClusters[0]?.workflows.every(item => item.userId === userA && item.domain === 'personal')).toBe(true);
    expect(workClusters[0]?.workflows.every(item => item.userId === userB && item.domain === 'work')).toBe(true);
  });

  it('separates capability category from personal and organization ownership', () => {
    const userId = `scope-capability-${Date.now()}`;
    const createRecord = (scopeDomain: 'personal' | 'work', orgId: string) => upsertCapabilityLearningRecord({
      userId,
      scopeDomain,
      orgId,
      domain: 'cad_bim',
      goal: 'AutoCAD structured drawing',
      status: 'learned',
      selectedRoute: {
        id: 'cad.autocad_mcp_playback',
        label: 'AutoCAD MCP/COM route',
        interfacePattern: 'mcp',
        preferredTools: ['cad_prepare_autocad_operations', 'mcp_cad-drafting_autocad_playback_file'],
        fallbackTools: [],
        avoid: [],
        reason: 'structured drawing',
        confirmationRequired: [],
      },
      planReadiness: 'use_existing',
      existingTools: ['cad_prepare_autocad_operations', 'mcp_cad-drafting_autocad_playback_file'],
      nextUse: {
        triggerHints: ['AutoCAD'],
        preferredTools: ['cad_prepare_autocad_operations', 'mcp_cad-drafting_autocad_playback_file'],
        firstStep: 'cad_prepare_autocad_operations',
        reportRule: 'verify first',
      },
      experiment: { status: 'passed', summary: 'verified', toolCalls: [], artifacts: [], verification: [] },
      safety: [],
    });

    const personal = createRecord('personal', '');
    const organization = createRecord('work', 'org-scope-test');
    expect(organization.id).not.toBe(personal.id);
    expect(listCapabilityLearningRecords({ userId, scopeDomain: 'personal', domain: 'cad_bim' }).map(item => item.id))
      .toEqual([personal.id]);
    expect(listCapabilityLearningRecords({ userId, scopeDomain: 'work', orgId: 'org-scope-test', domain: 'cad_bim' }).map(item => item.id))
      .toEqual([organization.id]);
    expect(listCapabilityLearningRecords({ userId, scopeDomain: 'work', orgId: 'another-org', domain: 'cad_bim' }))
      .toEqual([]);
  });
});
