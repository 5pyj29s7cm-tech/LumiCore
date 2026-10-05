import { beforeAll, describe, expect, it, vi } from 'vitest';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';
import {
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
    expect(snapshot.modes).toEqual([]);
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

  it('keeps the fact digest stable across adjacent reads of the same live snapshot', () => {
    const observedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(observedAt);
    try {
      const first = getSelfModelSnapshot('self-snapshot-user');
      clock.mockReturnValue(observedAt + 2_000);
      const second = getSelfModelSnapshot('self-snapshot-user');
      expect(second.factDigest).toBe(first.factDigest);
      expect(second.identity).toEqual(first.identity);
      expect(second.connectedCapabilities).toEqual(first.connectedCapabilities);
      expect(second.runtime.sourceUpdatedAt).toBe(first.runtime.sourceUpdatedAt);
      expect(second.runtime.refreshRequired).toBe(false);
      expect(second.knowledgeCoverage.verifiedAbsorption).toBe(false);
    } finally { clock.mockRestore(); }
  });

  it('keeps disconnected cross-channel facts qualified behind one refresh contract', () => {
    const chat = getSelfModelSnapshot('self-missing-user');
    const voice = getSelfModelSnapshot('self-missing-user');

    expect(chat.factDigest).toBe(voice.factDigest);
    expect(chat.identity).toEqual(voice.identity);
    expect(chat.runtime.refreshRequired).toBe(true);
    expect(chat.runtime.refreshAction).toBe('client_self_repair(refresh_client_state)');
    expect(getSelfModelSnapshot('self-missing-user').runtime.awareness).toBe('missing');
  });
});
