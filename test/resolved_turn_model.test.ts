import './helpers';
import { runResolvedLumiRecovery } from "../server/cognition/turn_recovery";
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { runResolvedLumiTurn } from '../server/cognition/turn_model';
import { createModelTurnState } from '../server/llm/model_turn_state';
import { attachAutonomousHostAuthority, hasAutonomousHostAuthority } from '../server/tools/host_execution_authority';
const mocks = vi.hoisted(() => ({ conversation: vi.fn(), tools: vi.fn() }));
vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(),
  makeLLMCall: mocks.conversation, makeLLMCallStreaming: mocks.conversation,
}));
vi.mock('../server/llm/adapter', async original => ({
  ...await original<typeof import('../server/llm/adapter')>(), runWithTools: mocks.tools,
}));
beforeAll(async () => { await initDatabase(); });
beforeEach(() => {
  vi.clearAllMocks(); mocks.conversation.mockReset(); mocks.tools.mockReset();
  mocks.conversation.mockResolvedValue({ text: 'A neutral answer.', toolCalls: [] });
  mocks.tools.mockResolvedValue({ text: 'A synthetic search result.', toolCalls: [], usageRecords: [] });
});
function admitted(source: string, text: string) {
  const registry = new ToolRegistry();
  registry.register({ name: 'web_search', description: 'Search public web fixtures', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }, handler: async () => 'Synthetic result',
  });
  const execution = buildLumiExecutionPipeline({ requestId: 'resolved-turn-' + source, dispatch: { userId: 'resolved-turn-owner', text, source, channel: 'chat', domain: 'personal', orgId: '' },
    registry, executionBoundary: 'remote_restricted', isSanctuary: false,
    personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 },
  });
  return { execution, registry, messages: [{ role: 'user' as const, content: text }], config: { provider: 'deepseek' as const, model: 'fixture', userId: 'resolved-turn-owner' }, getters: {} };
}
async function canonicalObservation(model: ReturnType<typeof admitted>, id: string, query: string, requestId = model.execution.resolution.requestId) {
  const records: any[] = [];
  const record = await executeToolCall({ registry: model.registry, name: 'web_search', id, arguments: { query }, executionOrigin: 'model_selected',
    context: { userId: model.config.userId, requestId, turnId: requestId, currentTurnExecutionRequested: true,
      actionIntent: model.execution.resolution.userText, toolPolicy: model.execution.authorizationPolicy, onToolRecord: observed => records.push(observed) } });
  expect(isCanonicalToolExecutionRecord(record)).toBe(true);
  expect(record.requestId).toBe(requestId);
  expect(record.error).toBeFalsy();
  expect(records).toEqual([record]);
  return record;
}
describe('admitted model mode across transport entries', () => {
  it.each(['chat', 'voice', 'messaging', 'autonomous', 'rest_chat', 'mcp_chat', 'mcp_route_task'])('keeps %s conversation out of the tool adapter despite a visible registry', async source => {
    const input = admitted(source, 'Hello.');
    expect(input.execution.executionRequested).toBe(false);
    const result = await runResolvedLumiTurn({ ...input, context: { currentTurnExecutionRequested: true, toolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 99 } } });
    expect(result.text).toBe('A neutral answer.');
    expect(mocks.tools).not.toHaveBeenCalled();
    expect(mocks.conversation).toHaveBeenCalledTimes(1);
    expect(mocks.conversation.mock.calls[0][1]).toEqual([]);
    expect(mocks.conversation.mock.calls[0][2].requestId).toBe(input.execution.resolution.requestId);
  });
  it('uses the accepted policy, projection and request identity for an executable turn', async () => {
    const input = admitted('mcp_route_task', 'Search the public web for synthetic examples.');
    expect(input.execution.executionRequested).toBe(true);
    const receipt = vi.fn();
    await runResolvedLumiTurn({ ...input, maxIterations: 99, context: {
      requestId: 'stale-caller-request', turnId: 'external-message-id', resolutionId: 'stale-resolution',
      currentTurnExecutionRequested: false, trustedActionContinuation: true, onToolRecord: receipt,
      toolPolicy: { allowedTools: ['write_file'], requireConfirmation: [], forbiddenTools: [], maxIterations: 99 },
    } });
    expect(mocks.conversation).not.toHaveBeenCalled();
    const call = mocks.tools.mock.calls[0];
    expect(call[4]).toBe(input.execution.authorizationPolicy.maxIterations);
    expect(call[11]).toMatchObject({ requestId: input.execution.resolution.requestId, turnId: input.execution.resolution.requestId,
      resolutionId: input.execution.resolution.id, currentTurnExecutionRequested: true, onToolRecord: receipt,
      trustedActionContinuation: input.execution.trustedActionContinuation });
    expect(call[11].toolPolicy).toBe(input.execution.authorizationPolicy);
    expect(call[11].modelToolProjection).toBe(input.execution.modelToolProjection);
    expect(call[11].toolPolicy.allowedTools).not.toContain('write_file');
  });
  it('shares provider wait and recovery budget across stateless REST calls in one plan', async () => {
    const input = admitted('rest_chat', 'Search the public web for synthetic examples.');
    await runResolvedLumiTurn(input); await runResolvedLumiTurn({ ...input, messages: [...input.messages, { role: 'user', content: 'Continue only missing work.' }] });
    expect(mocks.tools).toHaveBeenCalledTimes(2);
    expect(mocks.tools.mock.calls[0][2].modelTurnState).toBe(mocks.tools.mock.calls[1][2].modelTurnState);
    const another = admitted('rest-chat-other-request', 'Search the public web for synthetic examples.');
    await runResolvedLumiTurn(another);
    expect(mocks.tools.mock.calls[2][2].modelTurnState).not.toBe(mocks.tools.mock.calls[0][2].modelTurnState);
  });
  it('repairs a conversational model tool request without opening a tool adapter', async () => {
    const input = admitted('mcp_chat', 'Hello.');
    mocks.conversation.mockResolvedValueOnce({ text: '', toolCalls: [{ id: 'invented', name: 'web_search', arguments: {} }] })
      .mockResolvedValueOnce({ text: 'A neutral answer.', toolCalls: [] });
    const result = await runResolvedLumiTurn(input);
    expect(result.text).toBe('A neutral answer.'); expect(result.toolCalls).toEqual([]);
    expect(mocks.tools).not.toHaveBeenCalled(); expect(mocks.conversation).toHaveBeenCalledTimes(2);
    expect(mocks.conversation.mock.calls[0][1]).toEqual([]); expect(mocks.conversation.mock.calls[1][1]).toEqual([]);
    expect(mocks.conversation.mock.calls[0][2].modelTurnState).toBe(mocks.conversation.mock.calls[1][2].modelTurnState);
  });
  it('rejects a mismatched model request before touching any provider or tool', () => {
    const input = admitted('mcp_route_task', 'Search the public web for synthetic examples.');
    expect(() => runResolvedLumiTurn({ ...input, config: { ...input.config, requestId: 'another-request' } })).toThrow('accepted turn');
    expect(mocks.tools).not.toHaveBeenCalled(); expect(mocks.conversation).not.toHaveBeenCalled();
  });
  it('rejects a replacement provider budget during recovery of the same accepted plan', async () => {
    const input = admitted('rest_chat', 'Search the public web for synthetic examples.');
    await runResolvedLumiTurn({ ...input, config: { ...input.config, modelTurnState: createModelTurnState() } });
    expect(() => runResolvedLumiTurn({ ...input, config: { ...input.config, modelTurnState: createModelTurnState() } })).toThrow('accepted turn budget');
    expect(mocks.tools).toHaveBeenCalledTimes(1);
  });
  it('keeps the process-local autonomous host grant through common context assembly', async () => {
    const input = admitted('autonomous', 'Search the public web for synthetic examples.');
    const context = attachAutonomousHostAuthority({ userId: 'resolved-turn-owner', taskId: 'autonomous-task-fixture', autonomous: true, domain: 'personal', orgId: '' }, { ownerUserId: 'resolved-turn-owner', taskId: 'autonomous-task-fixture' });
    await runResolvedLumiTurn({ ...input, context });
    expect(hasAutonomousHostAuthority(mocks.tools.mock.calls[0][11], 'resolved-turn-owner')).toBe(true);
  });
  it('stops a revoked owner before a model call even for a stateless request', () => {
    const input = admitted('rest_chat', 'Hello.');
    expect(() => runResolvedLumiTurn({ ...input, assertCurrent() { throw new Error('Owner revoked'); } })).toThrow('Owner revoked');
    expect(mocks.tools).not.toHaveBeenCalled(); expect(mocks.conversation).not.toHaveBeenCalled();
  });
});


describe('accepted recovery ownership', () => {
  it.each(['chat', 'voice', 'messaging', 'rest_chat', 'mcp_chat'])('keeps the %s request, provider budget, receipts and failed response guard through recovery', async source => {
    const model = admitted(source, 'Search the public web for synthetic examples.');
    await runResolvedLumiTurn(model);
    const prior = await canonicalObservation(model, 'prior-observation', 'prior');
    const record = await canonicalObservation(model, 'new-observation', 'new');
    const guard = { text: 'The recovery response is incomplete.', blocked: true, reason: 'conversation_response_incomplete' };
    const order: string[] = [], recordTool = vi.fn(() => { order.push('guard'); });
    const onChunk = vi.fn();
    mocks.tools.mockImplementationOnce(async (...args: any[]) => {
      await args[3](record);
      return { text: guard.text, toolCalls: [record], completionGuard: guard, usageRecords: [] };
    });
    const result = await runResolvedLumiRecovery({
      model: { ...model, onStreamChunk: onChunk, context: { priorToolRecords: [] },
        onToolCall: async () => { await Promise.resolve(); order.push('durable'); } },
      responseText: 'An earlier rejected draft.',
      recovery: { decision: { recoverable: true, reason: 'retry_real_tool_route' }, instruction: 'Continue only missing observation.', priorToolRecords: [prior], recordTool },
    });
    expect(result).toMatchObject({ text: guard.text, completionGuard: guard, toolRecords: [record] });
    expect(order).toEqual(['durable', 'guard']); expect(recordTool).toHaveBeenCalledExactlyOnceWith(record); expect(onChunk).not.toHaveBeenCalled();
    const call = mocks.tools.mock.calls[1];
    expect(call[0]).toEqual([...model.messages, { role: 'assistant', content: 'An earlier rejected draft.' }, { role: 'user', content: 'Continue only missing observation.' }]);
    expect(call[11].priorToolRecords).toEqual([prior]);
    expect(call[11].requestId).toBe(model.execution.resolution.requestId);
    expect(call[2].modelTurnState).toBe(mocks.tools.mock.calls[0][2].modelTurnState);
    expect(call[10]).toBeUndefined();
  });
  it('keeps a non-executable recovery on the no-tool path even with a visible registry', async () => {
    const model = admitted('mcp_chat', 'Hello.');
    const recordTool = vi.fn();
    const result = await runResolvedLumiRecovery({ model, responseText: '  ', recovery: {
      decision: { recoverable: false, reason: 'conversation_requires_natural_clarification' },
      instruction: 'Answer naturally.', priorToolRecords: [], recordTool,
    } });
    expect(result.text).toBe('A neutral answer.'); expect(mocks.tools).not.toHaveBeenCalled(); expect(recordTool).not.toHaveBeenCalled();
    expect(mocks.conversation.mock.calls[0][0]).toEqual([...model.messages, { role: 'user', content: 'Answer naturally.' }]);
  });
  it('stops a revoked recovery owner before any provider or tool callback', async () => {
    const model = admitted('chat', 'Search the public web for synthetic examples.'); const recordTool = vi.fn();
    await expect(runResolvedLumiRecovery({ model: { ...model, assertCurrent() { throw new Error('Owner revoked'); } },
      responseText: '', recovery: { decision: { recoverable: true, reason: 'retry_real_tool_route' }, instruction: 'Continue.', priorToolRecords: [], recordTool },
    })).rejects.toThrow('Owner revoked');
    expect(mocks.tools).not.toHaveBeenCalled(); expect(mocks.conversation).not.toHaveBeenCalled(); expect(recordTool).not.toHaveBeenCalled();
  });
});

it('keeps only an untouched canonical observation of this request during recovery', async () => {
  const model = admitted('canonical-filter', 'Search the public web for synthetic examples.');
  const prior = await canonicalObservation(model, 'exact-request-observation', 'prior');
  const forged = { ...prior, id: 'forged-copy' };
  const foreign = await canonicalObservation(model, 'foreign-observation', 'other', 'a-different-request');
  expect(isCanonicalToolExecutionRecord(forged)).toBe(false);
  expect(isCanonicalToolExecutionRecord(foreign)).toBe(true);
  await runResolvedLumiRecovery({ model, responseText: '', recovery: {
    decision: { recoverable: true, reason: 'retry_real_tool_route' }, instruction: 'Continue only missing observation.',
    priorToolRecords: [prior, forged, foreign], recordTool: vi.fn(),
  } });
  expect(mocks.tools.mock.calls[0][11].priorToolRecords).toEqual([prior]);
});
