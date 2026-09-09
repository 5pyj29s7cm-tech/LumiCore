import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: { settings: [], modelRoutingReceipts: [] } as any }));
vi.mock('../db_layer', () => ({ readDB: () => state.db, writeDB: vi.fn() }));
import { readProviderRuntimeObservation } from '../server/llm/provider_health';

afterEach(() => { state.db = { settings: [], modelRoutingReceipts: [] }; });

describe('actual provider health evidence', () => {
  it('retains the last actual failure through circuit skips and caller cancellation', () => {
    const attempt = { provider: 'relay', model: 'official', completedAt: new Date().toISOString() };
    state.db.modelRoutingReceipts = [
      { attempts: [{ ...attempt, status: 'failed', reason: 'provider_auth_failed' }] },
      { attempts: [{ ...attempt, status: 'skipped', reason: 'circuit_open' }] },
      { attempts: [{ ...attempt, status: 'failed', reason: 'cancelled' }] },
    ];
    expect(readProviderRuntimeObservation('relay', 'official')).toMatchObject({ status: 'failed', reason: 'provider_auth_failed' });
    state.db.modelRoutingReceipts.push({ attempts: [{ ...attempt, status: 'succeeded' }] });
    expect(readProviderRuntimeObservation('relay', 'official')).toMatchObject({ status: 'succeeded' });
    expect(readProviderRuntimeObservation('relay', 'another-model')).toBeNull();
  });
});
