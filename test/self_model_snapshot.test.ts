import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';
import {
  buildSelfIntroductionPlan,
  getSelfModelSnapshot,
  updateClientState,
} from '../server/client/self_model';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
  registerAllTools(toolRegistry);
});

describe('live Lumi self model snapshot', () => {
  it('reports current model/capability/knowledge facts without claiming full absorption', () => {
    updateClientState('self-snapshot-user', {
      mode: 'assistant',
      workDomain: 'personal',
      activeTab: 'home',
      viewMode: 'personal',
      knowledge: {
        domain: 'personal',
        totalFiles: 3,
        indexedFiles: 2,
        partialFiles: 1,
        pendingFiles: 0,
        failedFiles: 0,
        unsupportedFiles: 0,
      },
      updatedAt: Date.now(),
    });
    const snapshot = getSelfModelSnapshot('self-snapshot-user');

    expect(snapshot.identity.name).toBe('Lumi');
    expect(snapshot.modes.find(mode => mode.id === 'assistant')?.active).toBe(true);
    expect(snapshot.configuredModels.length).toBeGreaterThanOrEqual(9);
    expect(snapshot.connectedCapabilities.tools).toBeGreaterThan(0);
    expect(snapshot.knowledgeCoverage.verification).toBe('partial');
    expect(snapshot.knowledgeCoverage.verifiedAbsorption).toBe(false);
    expect(snapshot.permissions.externalCommitConfirmation).toBe('required');
  });

  it('builds verbal and visible-demo introductions from the same snapshot', () => {
    const verbal = buildSelfIntroductionPlan('self-snapshot-user');
    const visible = buildSelfIntroductionPlan('self-snapshot-user', {}, { visibleDemo: true });

    expect(verbal.mode).toBe('verbal');
    expect(verbal.demoCandidates.every(candidate => !candidate.enabled)).toBe(true);
    expect(visible.mode).toBe('visible_demo');
    expect(visible.demoCandidates.find(candidate => candidate.applicationId === 'lumi-client')?.enabled).toBe(true);
    expect(visible.documentText).toContain('索引不等于完全吸收');
    expect(visible.statements.map(statement => statement.evidence)).toContain('live model role configuration');
  });
});
