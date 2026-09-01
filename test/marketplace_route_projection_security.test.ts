import { describe, expect, it } from 'vitest';
import {
  projectMarketplaceRuntime,
  publicMarketplaceSkill,
} from '../server/routes/marketplace_routes';

const operationalSkill = {
  id: 'skill-private-test',
  name: 'Private Test',
  description: 'Catalog description.',
  author: 'Lumi Official',
  downloads: 1,
  rating: 5,
  category: 'Test',
  icon: 'Zap',
  installSource: 'bundled',
  installPath: 'C:\\Users\\secret\\server\\skills\\bundled\\private-test',
  installed: true,
  officialIdentityStatus: 'conflict',
  conflictReason: 'C:\\Users\\secret\\tampered-package.json',
  registeredToolNames: ['private_runtime_tool'],
  manifestCapabilityIds: ['private.runtime.tool'],
  runtimeStatus: 'identity_conflict',
  version: '1.0.0',
  toolCount: 1,
};

describe('marketplace public projection', () => {
  it('returns catalog metadata without host paths or runtime state', () => {
    const projected = publicMarketplaceSkill(operationalSkill);
    expect(projected).toMatchObject({
      id: 'skill-private-test',
      name: 'Private Test',
      installSource: 'bundled',
      version: '1.0.0',
    });
    expect(projected).not.toHaveProperty('installPath');
    expect(projected).not.toHaveProperty('installed');
    expect(projected).not.toHaveProperty('officialIdentityStatus');
    expect(projected).not.toHaveProperty('conflictReason');
    expect(projected).not.toHaveProperty('registeredToolNames');
    expect(projected).not.toHaveProperty('manifestCapabilityIds');
    expect(projected).not.toHaveProperty('runtimeStatus');
  });

  it('never returns the absolute source install path, even to local diagnostics', () => {
    const [projected] = projectMarketplaceRuntime([operationalSkill], true);
    expect(projected).not.toHaveProperty('installPath');
    expect(JSON.stringify(projected)).not.toContain('C:\\Users\\secret');
  });
});
