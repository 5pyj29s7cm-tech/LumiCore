import './helpers';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { createToolReceiptObserver } from '../server/tools/receipt_observer';

function fixture() {
  const registry = new ToolRegistry();
  registry.register({ name: 'receipt_observer_probe', description: 'Synthetic observation', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: {}, required: [] }, handler: async () => 'fixture value' });
  return (onToolRecord?: ReturnType<typeof createToolReceiptObserver>['onToolRecord']) => executeToolCall({
    registry, name: 'receipt_observer_probe', id: 'receipt-probe', arguments: {}, context: { userId: 'observer-fixture', onToolRecord },
  });
}

describe('canonical receipt persistence barrier', () => {
  it('shares one save between passive observation and the awaited terminal barrier', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const write = vi.fn(async () => { await gate; });
    const observer = createToolReceiptObserver(write);
    const record = await fixture()(observer.onToolRecord);
    let saved = false;
    const barrier = observer.persist(record).then(() => { saved = true; });
    await Promise.resolve();
    expect(saved).toBe(false);
    expect(write).toHaveBeenCalledOnce();
    release(); await barrier;
    expect(saved).toBe(true);
    await observer.persist(record);
    expect(write).toHaveBeenCalledOnce();
  });

  it('propagates failed durable writes and permits a later save retry without rerunning the tool', async () => {
    const record = await fixture()();
    const write = vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(undefined);
    const observer = createToolReceiptObserver(write);
    await expect(observer.persist(record)).rejects.toThrow('storage unavailable');
    await expect(observer.persist(record)).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('ignores copied or modified receipts that did not come intact from the execution engine', async () => {
    const record = await fixture()();
    const write = vi.fn(async () => {});
    const observer = createToolReceiptObserver(write);
    observer.onToolRecord({ ...record });
    record.result = 'modified';
    await observer.persist(record);
    expect(write).not.toHaveBeenCalled();
  });
});
