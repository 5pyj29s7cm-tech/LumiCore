import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { getAdapterRegistry } from '../server/adapters/registry';
import { getExternalAppAdapters } from '../server/external_apps/adapters';

beforeAll(async () => { await initDatabase(); });

describe('external app catalog projection', () => {
  it('uses the current external AI catalog instead of the removed external_agents fallback', () => {
    const report = getAdapterRegistry({ userId: 'catalog-owner', includePlanned: false });
    const live = report.adapters.find(adapter => adapter.id === 'ai.external_tools')!;
    const projected = getExternalAppAdapters(report).find(adapter => adapter.id === 'ai_apps')!;
    expect(projected).toBeDefined();
    expect(projected.actions).toEqual(live.actions);
    expect(projected.label).toBe(live.label);
    expect(projected.notes).toBe(live.notes);
    expect(projected.actions).toContain('desktop_ai_ask');
  });

  it('omits missing adapters instead of inventing tools and availability', () => {
    expect(getExternalAppAdapters({ adapters: [] })).toEqual([]);
    const report = getAdapterRegistry({ userId: 'catalog-owner' });
    const live = report.adapters.find(adapter => adapter.id === 'ai.external_tools')!;
    const projected = getExternalAppAdapters({ adapters: [{ ...live, status: 'degraded', actions: [] }] });
    expect(projected).toEqual([expect.objectContaining({ id: 'ai_apps', status: 'requires_setup', actions: [] })]);
  });
});
