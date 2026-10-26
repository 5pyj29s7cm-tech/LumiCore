import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ makeLLMCall: vi.fn() }));
vi.mock('../server/llm/providers', async () => {
  const actual = await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers');
  return { ...actual, makeLLMCall: mocks.makeLLMCall };
});
import { runWithTools } from '../server/llm/adapter';
import * as loopDispatch from '../server/llm/tool_loop/loop_dispatch';
import { toolLifecycleCallKey } from '../server/llm/tool_loop/lifecycle';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';
import { encodeToolResult } from '../server/tools/result_envelope';
import { mergeToolExecutionRecords, coalesceToolExecutionRecords, mergeTaskReceipts, recordsToTaskReceipts } from '../server/cognition/task_execution_ledger';
import { prepareModelRequestContext } from '../server/llm/request_context_budget';
import type { ToolExecutionRecord } from '../server/tools/types';
const getters = [() => null, () => null, () => null, () => null, () => null] as const;
const scope = { userId: 'batch-fixture-user', conversationId: 'batch-fixture-conversation', taskId: 'batch-fixture-task', requestId: 'batch-fixture-request', turnId: 'batch-fixture-request' };
function registryFor(operation: 'observe' | 'mutate' = 'observe') {
  const registry = new ToolRegistry();
  const handler = vi.fn(async (args: Record<string, any>) => encodeToolResult('ORIGINAL_' + args.target + '_' + handler.mock.calls.length, { ok: true, status: 'verified', verified: true, target: args.target }));
  registry.register({ name: 'unknown_batch_probe', description: 'Synthetic independent observation', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { target: { type: 'string' } } },
    capability: { id: 'test.unknown.batch', family: 'test', lane: 'system', operation, risk: 'none',
      sideEffects: operation === 'observe' ? [] : [{ type: 'local_state_change', scope: 'isolated in-memory fixture', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok'], requiredValues: { ok: true }, successStatuses: ['verified'], successSignals: ['fixture result'], limitations: [] } },
    handler });
  return { registry, handler };
}
function batchRecord(route: string, overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return { ...scope, id: 'probe:0', name: 'unknown_batch_probe', arguments: { target: 'same' }, result: 'SOURCE_' + route, modelRoutingReceiptId: route, ...overrides };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());
describe('batch-scoped execution receipt identity', () => {
  it('delivers both actual loop observations when independent assistant batches reuse one ID', async () => {
    const { registry, handler } = registryFor();
    const user = { role: 'user' as const, sourceMessageId: 'exact-current-source', content: 'Compare the independently returned sources. 不改变文件，未给定的事实仍未知。' };
    const sourceBodies: string[] = [];
    mocks.makeLLMCall
      .mockResolvedValueOnce({ text: '', reasoningContent: 'SYNTHETIC_OPAQUE_A', routingReceiptId: 'route-first', toolCalls: [{ id: 'probe:0', name: 'unknown_batch_probe', arguments: { target: 'A' } }] })
      .mockResolvedValueOnce({ text: '', reasoningContent: 'SYNTHETIC_OPAQUE_B', routingReceiptId: 'route-second', toolCalls: [{ id: 'probe:0', name: 'unknown_batch_probe', arguments: { target: 'B' } }] })
      .mockImplementationOnce(async (messages: any) => {
        const prepared = prepareModelRequestContext({ messages, toolDeclarations: [], inputTokenBudget: 64000, preserveAssistantReasoning: true });
        expect(prepared.messages.find(message => message.sourceMessageId === user.sourceMessageId)).toEqual(user);
        expect(prepared.messages.filter(message => message.toolCalls?.length).map(message => message.toolCalls![0].id)).toEqual(['probe:0', 'probe:0']);
        expect(prepared.messages.filter(message => message.reasoningContent).map(message => message.reasoningContent)).toEqual(['SYNTHETIC_OPAQUE_A', 'SYNTHETIC_OPAQUE_B']);
        sourceBodies.push(...prepared.messages.filter(message => message.role === 'tool').map(message => String(message.content)));
        return { text: 'Both independent observations are delivered.' };
      });
    const terminal = vi.fn(), started = vi.fn(), adapterStart = vi.fn();
    const result = await runWithTools([user], registry, { provider: 'deepseek', model: 'synthetic-batch' }, terminal, 3, ...getters, undefined,
      { ...scope, onToolStart: started, onAdapterStart: adapterStart });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(adapterStart).toHaveBeenCalledTimes(2);
    expect(terminal).toHaveBeenCalledTimes(2);
    const records = terminal.mock.calls.map(call => call[0] as ToolExecutionRecord);
    expect(records.map(record => record.id)).toEqual(['probe:0', 'probe:0']);
    expect(records.map(record => record.modelRoutingReceiptId)).toEqual(['route-first', 'route-second']);
    expect(records[0].idempotencyKey).not.toBe(records[1].idempotencyKey);
    expect(started.mock.calls.map(call => call[0].idempotencyKey)).toEqual(records.map(record => record.idempotencyKey));
    expect(records.map(record => record.result)).toEqual(['ORIGINAL_A_1', 'ORIGINAL_B_2']);
    expect(sourceBodies[0]).toContain('ORIGINAL_A_1');
    expect(sourceBodies[1]).toContain('ORIGINAL_B_2');
    expect(mergeToolExecutionRecords([], records)).toEqual(records);
    expect(result.toolCalls).toEqual(records);
  });
  it('deduplicates repeated terminal delivery of the same started execution, not another execution with the same provider ID', async () => {
    const first = batchRecord('route-first', { idempotencyKey: 'execution-first' });
    const second = batchRecord('route-second', { idempotencyKey: 'execution-second' });
    vi.spyOn(loopDispatch, 'runWithToolsInternal').mockImplementationOnce(async (_messages, _registry, _config, _getters, observe, _max, _chunk, context) => {
      for (const record of [first, second]) {
        context!.onToolStart?.({ id: record.id, idempotencyKey: record.idempotencyKey, name: record.name, arguments: record.arguments });
        await context!.onAdapterStart?.({ name: record.name, attempt: 1, idempotencyKey: record.idempotencyKey, arguments: record.arguments,
          capability: { operation: 'observe', sideEffects: [] } });
        await observe?.(record); await observe?.(record);
      }
      return { text: 'Delivered once per execution.', toolCalls: [first, second], usageRecords: [] };
    });
    const terminal = vi.fn(), started = vi.fn();
    await runWithTools([{ role: 'user', content: 'Observe both.' }], new ToolRegistry(), { provider: 'deepseek', model: 'synthetic' }, terminal, 1, ...getters, undefined, { ...scope, onAdapterStart: started });
    expect(started).toHaveBeenCalledTimes(2);
    expect(terminal.mock.calls.map(call => call[0])).toEqual([first, second]);
    expect(toolLifecycleCallKey(first)).not.toBe(toolLifecycleCallKey(second));
    expect(toolLifecycleCallKey(first)).toBe(toolLifecycleCallKey({ ...first }));
  });
  it('keeps two batches in memory while duplicate delivery remains idempotent', () => {
    const first = batchRecord('route-first');
    const second = batchRecord('route-second', { arguments: { target: 'other' }, result: 'Different source' });
    expect(mergeToolExecutionRecords([first], [{ ...first }, second])).toEqual([first, second]);
    expect(mergeToolExecutionRecords([first], [{ ...first, requestId: 'another-request' }])).toHaveLength(2);
  });
  it('does not let an earlier success suppress a later failure with reused ID and arguments', () => {
    const first = batchRecord('route-first');
    const second = batchRecord('route-second', { result: '', error: 'Independent second observation failed.' });
    expect(coalesceToolExecutionRecords([first, second])).toEqual([first, second]);
    const receipts = mergeTaskReceipts(recordsToTaskReceipts([first]), [second]);
    expect(receipts.map(receipt => receipt.modelRoutingReceiptId)).toEqual(['route-first', 'route-second']);
    expect(receipts.map(receipt => receipt.outcome)).toEqual(['success', 'failure']);
  });
  it('retains two successful source versions with reused IDs and identical query arguments', () => {
    const first = batchRecord('route-first'), second = batchRecord('route-second');
    expect(mergeTaskReceipts(recordsToTaskReceipts([first]), [second])).toHaveLength(2);
  });
  it('allocates different implicit local execution keys across actual model batches', async () => {
    const { registry, handler } = registryFor('mutate');
    const first = await executeToolCall({ registry, id: 'probe:0', name: 'unknown_batch_probe', arguments: { target: 'first' }, context: scope, modelRoutingReceiptId: 'route-first' });
    const second = await executeToolCall({ registry, id: 'probe:0', name: 'unknown_batch_probe', arguments: { target: 'second' }, context: scope, modelRoutingReceiptId: 'route-second' });
    expect(first.error).toBeUndefined(); expect(second.error).toBeUndefined();
    expect(first.id).toBe('probe:0'); expect(second.id).toBe('probe:0');
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(handler).toHaveBeenCalledTimes(2);
  });
  it('retains the same explicit local side-effect key across model batches and does not repeat it', async () => {
    const { registry, handler } = registryFor('mutate');
    const first = await executeToolCall({ registry, id: 'probe:0', name: 'unknown_batch_probe', arguments: { target: 'same' }, context: { ...scope, idempotencyKey: 'host-owned-exact-operation' }, modelRoutingReceiptId: 'route-first' });
    const second = await executeToolCall({ registry, id: 'probe:0', name: 'unknown_batch_probe', arguments: { target: 'same' }, context: { ...scope, idempotencyKey: 'host-owned-exact-operation' }, modelRoutingReceiptId: 'route-second' });
    expect(first.error).toBeUndefined(); expect(second.error).toBeUndefined();
    expect(first.idempotencyKey).toBe('host-owned-exact-operation');
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('keeps legacy no-routing identity and explicit resolver identity unchanged', async () => {
    const { registry } = registryFor();
    const input = { registry, id: 'probe:legacy', name: 'unknown_batch_probe', arguments: { target: 'same' }, context: scope };
    const first = await executeToolCall(input), second = await executeToolCall(input);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    const resolved = await executeToolCall({ ...input, modelRoutingReceiptId: 'route-other', context: { ...scope, resolveToolIdempotencyKey: () => 'host-allocated-operation' } });
    expect(resolved.id).toBe('host-allocated-operation');
    expect(resolved.idempotencyKey).toBe('host-allocated-operation');
  });
});
