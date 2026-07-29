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
    const chrome = snapshot.desktopCapabilities.find(capability => capability.id === 'chrome-browser');
    expect(chrome).toMatchObject({
      supportTier: 'certified',
      certification: 'runtime_preflight_required',
      certifiedVersion: null,
    });
    expect(chrome?.requiredIdentitySignals).toEqual(expect.arrayContaining([
      'process_name', 'executable_path', 'publisher', 'product_name', 'window_class', 'product_version', 'code_signature',
    ]));
    expect(snapshot.factDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.runtime).toMatchObject({ refreshRequired: false, refreshAction: null });
  });

  it('builds verbal and visible-demo introductions from the same snapshot', () => {
    const verbal = buildSelfIntroductionPlan('self-snapshot-user');
    const visible = buildSelfIntroductionPlan('self-snapshot-user', {}, { visibleDemo: true });

    expect(verbal.mode).toBe('verbal');
    expect(verbal.demoCandidates.every(candidate => !candidate.enabled)).toBe(true);
    expect(visible.mode).toBe('visible_demo');
    expect(visible.snapshotFactDigest).toBe(verbal.snapshotFactDigest);
    expect(visible.refreshRequired).toBe(false);
    expect(visible.demoCandidates.find(candidate => candidate.applicationId === 'lumi-client')?.enabled).toBe(true);
    expect(visible.demoCandidates
      .filter(candidate => candidate.applicationId !== 'lumi-client')
      .every(candidate => !candidate.enabled)).toBe(true);
    const explicitWps = buildSelfIntroductionPlan('self-snapshot-user', {}, {
      visibleDemo: true,
      requestText: 'Show a visible Lumi demo in WPS',
    });
    expect(explicitWps.demoCandidates.some(candidate => (
      candidate.applicationId.startsWith('wps-') && candidate.enabled
    ))).toBe(true);
    expect(visible.documentText).toContain('索引不等于完全吸收');
    expect(visible.statements.map(statement => statement.evidence)).toContain('live model role configuration');
    expect(visible.statements[0].text).toContain(`${snapshotIdentityName(verbal)}，运行在 LumiOS 中`);
    expect(visible.statements.every(statement => statement.observedAt === visible.snapshotGeneratedAt)).toBe(true);
    expect(visible.statements.map(statement => statement.source)).toEqual(expect.arrayContaining([
      'self_model.identity',
      'self_model.configuredModels',
      'self_model.connectedCapabilities',
      'self_model.knowledgeCoverage',
      'self_model.runtime',
    ]));
  });

  it('keeps disconnected cross-channel facts qualified behind one refresh contract', () => {
    const chat = buildSelfIntroductionPlan('self-missing-user');
    const voice = buildSelfIntroductionPlan('self-missing-user');

    expect(chat.snapshotFactDigest).toBe(voice.snapshotFactDigest);
    expect(chat.statements.map(statement => statement.text)).toEqual(
      voice.statements.map(statement => statement.text),
    );
    expect(chat.refreshRequired).toBe(true);
    expect(chat.refreshActions).toEqual(['client_self_repair(refresh_client_state)']);
    expect(getSelfModelSnapshot('self-missing-user').runtime.awareness).toBe('missing');
  });
});

function snapshotIdentityName(plan: ReturnType<typeof buildSelfIntroductionPlan>): string {
  const match = plan.statements[0].text.match(/^我是\s+([^，]+)/u);
  return match?.[1] || '';
}
