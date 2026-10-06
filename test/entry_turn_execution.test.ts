import './helpers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { initDatabase, readDB } from '../db_layer';
import { getOrCreateActiveConversation, getMessages } from '../server/conversation/manager';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { getConversationExecution } from '../server/cognition/conversation_execution';
import { runLumiEntryTurn, type LumiEntryTurnInput, type ExecutedLumiTurn } from '../server/cognition/turn_execution';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
const model = vi.hoisted(() => vi.fn());
vi.mock('../server/llm/adapter', () => ({ runWithTools: (...args: any[]) => model(...args) }));
vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(),
  makeLLMCall: (...args: any[]) => model(...args), makeLLMCallStreaming: (...args: any[]) => model(...args),
}));
beforeAll(() => initDatabase());
beforeEach(() => model.mockReset());
function fixture(previous?: { userId: string; conversationId: string }, source = 'mcp_chat') {
  const userId = previous?.userId || 'turn-driver-' + randomUUID();
  const conversationId = previous?.conversationId || getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
  const identity = { userId, conversationId, agentId: 'lumi', domain: 'personal' as const, orgId: '', requestId: randomUUID() };
  const registry = new ToolRegistry();
  registry.register({ name: 'web_search', description: 'Synthetic public evidence', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    handler: async () => JSON.stringify({ ok: true, results: [{ title: 'Synthetic source', url: 'https://example.invalid/source' }] }),
  });
  const authorization = captureRequestAuthorization(() => true, 'Fixture was revoked');
  const controller = new AbortController();
  const planning = { dispatch: { userId, text: 'Search the public web for synthetic examples.', channel: 'chat' as const, source, domain: 'personal' as const, orgId: '' }, registry,
    personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 }, executionBoundary: 'remote_restricted' as const };
  const input: LumiEntryTurnInput<ExecutedLumiTurn> = {
    entry: { source, channel: 'chat', historyLimit: 30, failureText: 'The turn could not finish.', failureReason: 'fixture_failure' },
    identity, userText: 'Search the public web for synthetic examples.', authorization, controller,
    planning,
    assemble: () => ({ systemPrompt: 'Use real current-turn evidence.', model: { registry, config: { provider: 'deepseek', model: 'fixture', userId }, getters: {}, maxIterations: 3 } }),
    deliver: result => result,
  };
  return { identity, input, registry, planning };
}
async function verifiedStep(registry: ToolRegistry, args: any[]) {
  const context = args[11];
  const record = await executeToolCall({ registry, id: context.requestId + ':search', name: 'web_search', arguments: { query: 'synthetic' }, context });
  expect(record.error).toBeUndefined(); await args[3]?.(record);
  return { text: 'The search returned a synthetic source.', toolCalls: [record], usageRecords: [] };
}
describe('entry turn execution ownership', () => {
  it('serializes different entries until their transcript and task outcome are durable', async () => {
    const first = fixture(); const second = fixture(first.identity, 'mcp_route_task');
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let receiptReady = false;
    model.mockImplementationOnce(async (...args) => { const result = await verifiedStep(first.registry, args); receiptReady = true; await held; return result; })
      .mockImplementationOnce((...args) => verifiedStep(second.registry, args));
    const published: string[] = [];
    for (const item of [first, second]) item.input.deliver = result => {
      const row = readDB().conversationActionTasks.find((task: any) => task.id === result.taskId);
      expect(row?.status).toBe('completed');
      expect(getMessages(item.identity.conversationId, 20).some(message => message.role === 'assistant' && message.requestId === item.identity.requestId)).toBe(true);
      published.push(item.identity.requestId); return result;
    };
    const running = runLumiEntryTurn(first.input);
    await vi.waitFor(() => expect(receiptReady).toBe(true));
    const queued = runLumiEntryTurn(second.input);
    try {
      expect(model).toHaveBeenCalledTimes(1);
      expect(getConversationExecution({ ...second.identity, source: second.input.entry.source }, second.identity.requestId)?.state).toBe('queued');
      expect(readDB().conversationActionReceipts.filter((row: any) => row.requestId === first.identity.requestId)).toHaveLength(1);
    } finally { release(); }
    await Promise.all([running, queued]);
    expect(published).toEqual([first.identity.requestId, second.identity.requestId]);
    expect(model.mock.calls[1][0]).toEqual(expect.arrayContaining([{ role: 'assistant', content: 'The search returned a synthetic source.' }]));
    expect(getConversationExecution({ ...second.identity, source: second.input.entry.source }, second.identity.requestId)).toBeUndefined();
  });
  it('pins the queued identity, entry source and dispatch before caller mutation', async () => {
    const first = fixture(); const second = fixture(first.identity, 'mcp_route_task'); const elsewhere = fixture();
    const expected = { ...second.identity }; const oldSource = second.input.entry.source;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    model.mockImplementationOnce(async (...args) => { const result = await verifiedStep(first.registry, args); await held; return result; })
      .mockImplementationOnce((...args) => verifiedStep(second.registry, args));
    const running = runLumiEntryTurn(first.input); await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
    const queued = runLumiEntryTurn(second.input);
    second.input.identity.conversationId = elsewhere.identity.conversationId; second.input.identity.userId = elsewhere.identity.userId;
    second.input.entry.source = 'mutated'; second.planning.dispatch.userId = elsewhere.identity.userId;
    release(); const [, result] = await Promise.all([running, queued]);
    expect(result.execution.resolution.requestId).toBe(expected.requestId);
    expect(readDB().conversationActionReceipts.find((row: any) => row.requestId === expected.requestId)).toMatchObject({ conversationId: expected.conversationId });
    expect(readDB().conversationActionTurns.find((row: any) => row.requestId === expected.requestId)).toMatchObject({ conversationId: expected.conversationId, userId: expected.userId, source: oldSource });
    expect(readDB().conversationActionTasks.find((row: any) => row.id === result.taskId)).toMatchObject({ userId: expected.userId, conversationId: expected.conversationId });
    expect(getMessages(elsewhere.identity.conversationId, 20)).toHaveLength(0);
  });
  it('revokes a queued turn before assembly, model use or transcript writes and releases its lease', async () => {
    const first = fixture(); const second = fixture(first.identity, 'mcp_route_task');
    let allowed = true; second.input.authorization = captureRequestAuthorization(() => allowed, 'Fixture access was revoked');
    const assemble = vi.fn(second.input.assemble); second.input.assemble = assemble;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    model.mockImplementationOnce(async (...args) => { const result = await verifiedStep(first.registry, args); await held; return result; });
    const running = runLumiEntryTurn(first.input); await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
    const queued = runLumiEntryTurn(second.input); const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    allowed = false; await vi.waitFor(() => expect(second.input.controller.signal.aborted).toBe(true)); release(); await running; await rejected;
    expect(assemble).not.toHaveBeenCalled(); expect(model).toHaveBeenCalledTimes(1);
    expect(getMessages(first.identity.conversationId, 20).some(row => row.requestId === second.identity.requestId)).toBe(false);
    expect(getConversationExecution({ ...second.identity, source: second.input.entry.source }, second.identity.requestId)).toBeUndefined();
  });
  it('rejects a foreign model request before execution and durably blocks the original accepted request', async () => {
    const item = fixture(); const assembly = item.input.assemble;
    item.input.assemble = async execution => { const data = await assembly(execution); if ('terminal' in data) throw new Error('Foreign-model fixture requires model data'); data.model.config.requestId = 'foreign-request'; return data; };
    await expect(runLumiEntryTurn(item.input)).rejects.toThrow('accepted request');
    expect(model).not.toHaveBeenCalled();
    const turn = readDB().conversationActionTurns.find((row: any) => row.requestId === item.identity.requestId);
    expect(readDB().conversationActionTasks.find((row: any) => row.id === turn.taskId)?.status).toBe('blocked');
    expect(getMessages(item.identity.conversationId, 20).at(-1)).toMatchObject({ requestId: item.identity.requestId, role: 'assistant', message: 'The turn could not finish.' });
  });
  it('holds an external ledger turn through settlement before resolving a later entry', async () => {
    const first = fixture(); const second = fixture(first.identity, 'rest_chat');
    first.input.persistence = 'external';
    let release!: () => void; const held = new Promise<void>(done => { release = done; });
    const events: string[] = [];
    first.input.settle = async () => { events.push('saving'); await held; events.push('saved'); };
    const resolveSecondPlan = vi.fn(() => { events.push('planned'); return second.planning; });
    second.input.planning = resolveSecondPlan;
    model.mockImplementationOnce((...args) => verifiedStep(first.registry, args))
      .mockImplementationOnce((...args) => verifiedStep(second.registry, args));
    const running = runLumiEntryTurn(first.input);
    await vi.waitFor(() => expect(events).toEqual(['saving']));
    const queued = runLumiEntryTurn(second.input);
    try {
      expect(resolveSecondPlan).not.toHaveBeenCalled(); expect(model).toHaveBeenCalledTimes(1);
      expect(getMessages(first.identity.conversationId, 20)).toHaveLength(0);
      expect(getConversationExecution({ ...second.identity, source: second.input.entry.source }, second.identity.requestId)?.state).toBe('queued');
    } finally { release(); }
    await Promise.all([running, queued]);
    expect(events).toEqual(['saving', 'saved', 'planned']);
    expect(getConversationExecution({ ...first.identity, source: first.input.entry.source }, first.identity.requestId)).toBeUndefined();
    expect(getMessages(first.identity.conversationId, 20).every(row => row.requestId === second.identity.requestId)).toBe(true);
  });
  it('settles a revoked external attempt without starting a model or writing a transcript', async () => {
    const item = fixture(); const events: string[] = [];
    const assemble = vi.fn(() => { throw new Error('A rejected attempt must not assemble model data'); });
    const result = await runLumiEntryTurn<string>({ ...item.input, planning: item.planning, persistence: 'external', assemble,
      authorization: captureRequestAuthorization(() => false, 'Revoked before queue admission'),
      onFailure: error => { expect(error).toMatchObject({ name: 'AbortError' }); events.push('failed'); return 'blocked'; },
      deliver: () => 'delivered', settle: async () => { events.push('saved'); },
    });
    expect(result).toBe('blocked'); expect(events).toEqual(['failed', 'saved']);
    expect(model).not.toHaveBeenCalled(); expect(assemble).not.toHaveBeenCalled();
    expect(getMessages(item.identity.conversationId, 20)).toHaveLength(0);
    expect(getConversationExecution({ ...item.identity, source: item.input.entry.source }, item.identity.requestId)).toBeUndefined();
  });
});
