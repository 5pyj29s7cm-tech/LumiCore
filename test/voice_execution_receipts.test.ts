import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';
import { createVoiceExecutionReceiptCollector } from '../server/socket/voice_execution_receipts';

beforeAll(() => initDatabase());
let sequence = 0;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  sequence += 1;
  const requestId = `receipt-request-${sequence}`;
  const taskId = `receipt-task-${sequence}`;
  const collector = createVoiceExecutionReceiptCollector(requestId);
  collector.bindTask(taskId);
  const signal = new AbortController();
  const registry = new ToolRegistry();
  const started = deferred();
  const release = deferred();
  const target = path.join(String(process.env.LUMI_DATA_DIR), `voice-late-${sequence}.txt`);
  let fail = false;
  registry.register({
    name: 'receipt_fixture', description: 'Isolated local receipt fixture',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'public', securityLevel: 'safe',
    capability: { id: 'test.receipt', family: 'test', lane: 'files', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_write', scope: 'isolated temporary fixture', reversible: true }],
      verification: { strategy: 'artifact', required: true, requiredFields: [], requiredArtifacts: ['path'],
        successSignals: ['the isolated local file exists'], limitations: [] } },
    handler: async () => {
      started.resolve();
      await release.promise;
      if (fail) throw new Error('isolated delayed rejection');
      fs.writeFileSync(target, 'recorded late effect');
      return JSON.stringify({ ok: true, path: target });
    },
  });
  const execute = () => executeToolCall({ registry, id: `call-${sequence}`, name: 'receipt_fixture', arguments: {},
    context: { requestId, turnId: requestId, taskId, localExecution: true,
      userId: 'voice-receipt-test', authRole: 'admin', userConfirmed: true, source: 'voice',
      executionSignal: signal.signal, isCancelled: () => signal.signal.aborted,
      onToolStart: collector.onToolStart, onToolRecord: collector.onToolRecord, onToolFinished: collector.onToolFinished } });
  return { collector, signal, started, release, target, execute, fail: () => { fail = true; } };
}

describe('voice cancellation canonical receipt ownership', () => {
  it('waits for a late successful real effect and coalesces duplicate cancellation', async () => {
    const value = fixture();
    const execution = value.execute();
    await value.started.promise;
    value.signal.abort();
    const commit = vi.fn(async () => {
      const snapshot = await value.collector.settle(1000);
      expect(snapshot.settled).toBe(true);
      expect(snapshot.records).toHaveLength(1);
      expect(snapshot.records[0].terminalVerification?.status).toBe('verified');
      expect(fs.readFileSync(value.target, 'utf8')).toBe('recorded late effect');
      return true;
    });
    const first = value.collector.cancelOnce(commit);
    const second = value.collector.cancelOnce(commit);
    expect(first).toBe(second);
    value.release.resolve();
    await execution;
    await expect(first).resolves.toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('keeps a late failed outcome as failure and never invents a completed write', async () => {
    const value = fixture();
    value.fail();
    const execution = value.execute();
    await value.started.promise;
    value.signal.abort();
    const settled = value.collector.settle(1000);
    value.release.resolve();
    await execution;
    const result = await settled;
    expect(result.settled).toBe(true);
    expect(result.records[0].error).toContain('isolated delayed rejection');
    expect(result.records[0].terminalVerification?.status).toBe('failed');
    expect(fs.existsSync(value.target)).toBe(false);
  });

  it('bounds the wait and reports unsettled evidence without pretending cancellation erased the operation', async () => {
    const value = fixture();
    const execution = value.execute();
    await value.started.promise;
    value.signal.abort();
    const result = await value.collector.settle(1);
    expect(result).toMatchObject({ settled: false, pendingCount: 1 });
    expect(result.records[0]).toMatchObject({ name: 'receipt_fixture', terminalVerification: { status: 'unverified', reason: 'tool_settlement_unknown' } });
    expect(fs.existsSync(value.target)).toBe(false);
    value.release.resolve();
    await execution;
    expect(value.collector.snapshot()).toMatchObject({ settled: true, pendingCount: 0 });
    expect(value.collector.snapshot().records[0].terminalVerification?.status).toBe('verified');
  });

  it('rejects a canonical receipt from another request and never widens ownership', async () => {
    const first = fixture();
    const other = fixture();
    other.release.resolve();
    const record = await other.execute();
    first.collector.onToolRecord(record);
    expect(first.collector.snapshot().records).toEqual([]);
    expect(() => first.collector.bindTask('another-task')).toThrow(/cannot change task ownership/);
  });
});
