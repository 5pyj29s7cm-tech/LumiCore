import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: { settings: [], modelRoutingReceipts: [] } as any }));
vi.mock('../db_layer', async (...databaseMockArgs: any[]) => { const mocked = await ((() => ({ readDB: () => state.db, writeDB: vi.fn() })) as any)(...databaseMockArgs); const { withTableDatabaseMock } = await import("./helpers/table_database_mock"); const scoped = withTableDatabaseMock(mocked); return { ...scoped, readDatabaseTables: vi.fn(scoped.readDatabaseTables) }; });
import { readProviderRuntimeObservation, createProviderAvailabilityReader } from '../server/llm/provider_health';

import { readDatabaseTables } from '../db_layer';
import { getProviderConfigurationEpoch, resetCircuit } from '../server/cloud/circuit_breaker';

afterEach(() => { state.db = { settings: [], modelRoutingReceipts: [] }; resetCircuit(); vi.clearAllMocks(); });

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

it('shares one detached receipt snapshot across a provider page and refreshes on the next read', () => {
  const oldEpoch = getProviderConfigurationEpoch('openai');
  resetCircuit('openai');
  const currentEpoch = getProviderConfigurationEpoch('openai');
  const attempt = { provider: 'openai', model: 'fixture', completedAt: new Date().toISOString() };
  state.db.modelRoutingReceipts = [
    { attempts: [{ ...attempt, status: 'succeeded', configurationEpoch: currentEpoch }] },
    { attempts: [{ ...attempt, status: 'failed', configurationEpoch: oldEpoch }] },
  ];
  const readStatus = createProviderAvailabilityReader();
  const input = { provider: 'openai', model: 'fixture', configured: true };
  const status = readStatus(input);
  expect(status).toMatchObject({ readiness: 'healthy', reason: 'recent_model_success', lastObservation: { status: 'failed' } });
  status.lastObservation!.status = 'succeeded';
  for (const provider of ['openai', 'relay', 'qwen', 'ollama']) {
    readStatus({ ...input, provider });
  }
  expect(vi.mocked(readDatabaseTables).mock.calls.filter(([keys]) => keys.includes('modelRoutingReceipts'))).toHaveLength(1);
  expect(readStatus(input).lastObservation?.status).toBe('failed');
  state.db.modelRoutingReceipts.push({ attempts: [{ ...attempt, status: 'failed', configurationEpoch: currentEpoch }] });
  expect(readStatus(input).readiness).toBe('healthy');
  expect(createProviderAvailabilityReader()(input)).toMatchObject({ readiness: 'unhealthy', reason: 'recent_model_failure' });
});
