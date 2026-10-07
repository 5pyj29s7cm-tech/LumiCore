import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireCircuitCall, getCircuitStatus, getProviderConfigurationEpoch, recordFailure, resetCircuit } from '../server/cloud/circuit_breaker';
import { runLocalModelInference, saveLocalModelConfig } from '../server/llm/local_models';

const state = vi.hoisted(() => ({ settings: new Map<string, string>() }));
vi.mock('../server/persistence/settings_repository', () => ({
  readSettingRecord: (key: string) => state.settings.has(key) ? { key, value: state.settings.get(key) } : undefined,
  writeSetting: (key: string, value: string) => state.settings.set(key, value),
}));
beforeEach(() => { state.settings.clear(); resetCircuit(); });
const endpoint = 'http://127.0.0.1:59999';
const config = () => ({ baseUrl: endpoint, detected: true, models: ['model-a', 'model-b'], probedModel: 'model-a' });

describe('local endpoint changes own circuit invalidation', () => {
  it('keeps a sibling model circuit and configuration epoch when ordinary inference succeeds', async () => {
    saveLocalModelConfig('lmstudio', config());
    const epoch = getProviderConfigurationEpoch('lmstudio');
    const failed = acquireCircuitCall('lmstudio', 'model-b')!;
    recordFailure('lmstudio', 'model-b', new Error('model B down'), { openImmediately: true }, failed);
    await expect(runLocalModelInference('lmstudio', async () => 'OK', { model: 'model-a' })).resolves.toBe('OK');
    expect(getProviderConfigurationEpoch('lmstudio')).toBe(epoch);
    expect(getCircuitStatus()).toMatchObject([{ key: 'lmstudio:model-b', state: 'open' }]);
  });

  it('invalidates old backoff immediately when accepting a new unprobed endpoint', () => {
    saveLocalModelConfig('lmstudio', config());
    const epoch = getProviderConfigurationEpoch('lmstudio');
    const failed = acquireCircuitCall('lmstudio', 'model-a')!;
    recordFailure('lmstudio', 'model-a', new Error('old endpoint down'), { openImmediately: true }, failed);
    saveLocalModelConfig('lmstudio', { baseUrl: 'http://127.0.0.1:59998', detected: false, models: [] });
    expect(getProviderConfigurationEpoch('lmstudio')).not.toBe(epoch);
    expect(getCircuitStatus()).toEqual([]);
  });
});
