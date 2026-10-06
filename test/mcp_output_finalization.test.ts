import './helpers';
import { initDatabase, flushDBOrThrow, readDB } from '../db_layer';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  model: vi.fn(), tools: vi.fn(), conversation: vi.fn(),
  synthesizeSpeech: vi.fn(),
  extractMemories: vi.fn(),
  autoExtract: false,
}));

vi.mock('../server/llm/adapter', () => ({
  runWithTools: (...args: any[]) => { mocks.tools(...args); return mocks.model(...args); },
}));

vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(),
  makeLLMCall: (...args: any[]) => { mocks.conversation(...args); return mocks.model(...args); },
  makeLLMCallStreaming: (...args: any[]) => { mocks.conversation(...args); return mocks.model(...args); },
}));

vi.mock('../server/memory', () => ({
  queryMemories: vi.fn(() => []),
  addMemory: vi.fn(),
  getDueReminders: vi.fn(() => []),
  buildNarrativeChain: vi.fn(() => ''),
}));

vi.mock('../server/memory/turn_memory', async importOriginal => ({
  ...await importOriginal<typeof import('../server/memory/turn_memory')>(), persistTurnMemory: mocks.extractMemories,
}));

vi.mock('../server/personality', () => {
  const personality = {
    id: 'lumi',
    name: 'Lumi',
    memoryPolicy: {
      retrieveLimit: 5,
      minConfidence: 0,
      get autoExtract() { return mocks.autoExtract; },
    },
    toolPolicy: {
      maxIterations: 5,
      allowedTools: ['*'],
      requireConfirmation: [],
      forbiddenTools: [],
    },
    ttsVoiceId: 'test-voice',
  };
  return {
    personalityRegistry: {
      get: vi.fn(() => personality),
      getForUser: vi.fn(() => personality),
      getDefault: vi.fn(() => personality),
      buildSystemPrompt: vi.fn(() => ({ systemPrompt: 'You are Lumi.' })),
    },
  };
});

vi.mock('../server/devices', () => ({
  deviceRegistry: {
    getSensoryContext: vi.fn(() => ({
      hasAudio: true,
      hasVideo: false,
      hasSpatial: false,
      hasHaptic: false,
      hasHolographic: false,
      activeDeviceTypes: ['speaker'],
      deviceCount: 1,
    })),
  },
}));

vi.mock('../server/output/holographic', () => ({
  canOutputHolographic: vi.fn(() => false),
  textToHolographicOutput: vi.fn(),
}));

vi.mock('../server/tools/definitions/office_tools', () => ({
  setOfficeBroadcast: vi.fn(),
}));

vi.mock('../server/tts/adapter', () => ({
  getActiveProvider: vi.fn(() => 'test'),
  synthesizeSpeech: mocks.synthesizeSpeech,
}));


vi.mock('../server/lap/policy', () => ({
  formatLAPSelfPrompt: vi.fn(() => ''),
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { createLumiMcpServer } from '../server/mcp/lumi_server';
import { McpCallLifecycle } from '../server/mcp/lifecycle';
import {
  addMemory,
  getDueReminders,
  queryMemories,
} from '../server/memory';

type RegisteredHandler = (args: Record<string, any>) => Promise<any>;

function getHandler(server: ReturnType<typeof createLumiMcpServer>, name: string): RegisteredHandler {
  const handler = (server as any)._registeredTools?.[name]?.handler;
  if (typeof handler !== 'function') throw new Error(`Missing MCP handler: ${name}`);
  return handler;
}

function wpsContinuationTask(): string {
  return [
    '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi MCP \u56de\u5f52\u3002',
    '## Recent action continuation context',
    'Recovered structured action state:',
    '- appTarget: WPS Office',
    '- unfinished: yes',
  ].join('\n');
}

function falseSuccessRecord() {
  return {
    id: 'write-1',
    name: 'write_file',
    arguments: { path: 'D:\\LumiCore\\mcp-false-success.txt' },
    result: 'File written: D:\\LumiCore\\mcp-false-success.txt',
  };
}

beforeAll(async () => { await initDatabase(); });

it('archives an MCP tool step before the model finishes without completing its task', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'web_search', description: 'Search public web fixtures', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    handler: async () => JSON.stringify({ ok: true, results: [{ title: 'Synthetic result', url: 'https://example.com' }] }),
  });
  let finishedStep = false;
  let record: any;
  let context: any;
  let release!: () => void;
  const waitForFinal = new Promise<void>(resolve => { release = resolve; });
  mocks.model.mockImplementationOnce(async (...args) => {
    context = args[11];
    record = await executeToolCall({ registry, id: 'mcp-step-receipt', name: 'web_search', arguments: { query: 'synthetic' }, context });
    await flushDBOrThrow();
    finishedStep = true;
    await waitForFinal;
    return { text: 'The search returned a synthetic result.', toolCalls: [record], usageRecords: [] };
  });
  const server = createLumiMcpServer(undefined, registry, undefined, {
    userId: 'mcp-receipt-owner', username: 'test', role: 'user', domain: 'personal', orgId: '', authenticated: true,
  });
  const reply = getHandler(server, 'lumi_chat')({ message: 'Search the public web for synthetic examples.' });
  try {
    await vi.waitFor(() => expect(finishedStep).toBe(true));
    expect(record.error).toBeUndefined();
    expect({ taskId: context.taskId, execution: context.currentTurnExecutionRequested }).toMatchObject({ taskId: expect.any(String), execution: true });
    expect(readDB().conversationActionReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: context.taskId, requestId: context.requestId, toolName: 'web_search' }),
    ]));
    expect(readDB().conversationActionTasks.find((row: any) => row.id === context.taskId)?.status).not.toBe('completed');
  } finally { release(); await reply; }
});

it('serializes MCP turns and keeps history and event identities in the owned conversation', async () => {
  let release!: (value: any) => void;
  mocks.model.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValue({ text: 'Second answer.', toolCalls: [], usageRecords: [] });
  const broadcast = vi.fn();
  const server = createLumiMcpServer(undefined, new ToolRegistry(), broadcast);
  const chat = getHandler(server, 'lumi_chat');
  const first = chat({ message: 'My favourite colour is blue.' });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const second = chat({ message: 'What colour did I mention?' });
  await Promise.resolve();
  expect(mocks.model).toHaveBeenCalledTimes(1);
  release({ text: 'You like blue.', toolCalls: [], usageRecords: [] });
  const [a, b] = await Promise.all([first, second]);
  expect(a.conversationId).toBe(b.conversationId);
  expect(a.requestId).not.toBe(b.requestId);
  expect(mocks.model.mock.calls[1][0]).toEqual(expect.arrayContaining([
    { role: 'user', content: 'My favourite colour is blue.' }, { role: 'assistant', content: 'You like blue.' },
  ]));
  expect(broadcast.mock.calls.filter(([event]) => event === 'agent:response').map(([, data]) => data.requestId)).toEqual([a.requestId, b.requestId]);
  expect(mocks.model.mock.calls[0][2].modelTurnState).not.toBe(mocks.model.mock.calls[1][2].modelTurnState);
});

it('rejects an MCP continuation owned by another user before calling a model', async () => {
  mocks.model.mockResolvedValue({ text: 'Hello.', toolCalls: [], usageRecords: [] });
  const owner = createLumiMcpServer(undefined, new ToolRegistry());
  const first = await getHandler(owner, 'lumi_chat')({ message: 'Hello.' });
  const other = createLumiMcpServer(undefined, new ToolRegistry(), vi.fn(), {
    userId: 'different-mcp-user', username: 'other', role: 'user', domain: 'personal', orgId: '', authenticated: true,
  });
  const denied = await getHandler(other, 'lumi_chat')({ message: 'Continue.', conversationId: first.conversationId });
  expect(denied.isError).toBe(true);
  expect(mocks.model).toHaveBeenCalledTimes(1);
});

it.each(['saved', 'failed'] as const)('acknowledges explicit MCP memory only from its %s persistence receipt', async status => {
  mocks.extractMemories.mockResolvedValue({ status, text: `Memory receipt: ${status}`, ids: [] });
  const server = createLumiMcpServer(undefined, new ToolRegistry());
  const result = await getHandler(server, 'lumi_chat')({ message: 'Remember that my preferred colour is blue.' });
  expect(mocks.model).not.toHaveBeenCalled();
  expect(mocks.extractMemories).toHaveBeenCalledWith(expect.objectContaining({ userText: 'Remember that my preferred colour is blue.', channel: 'chat' }));
  expect(result.content[0].text).toBe(`Memory receipt: ${status}`);
  expect(result.blocked).toBe(status === 'failed');
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.model.mockReset();
  mocks.autoExtract = false;
  mocks.extractMemories.mockResolvedValue({ memories: [], reminders: [] });
  mocks.synthesizeSpeech.mockResolvedValue({
    audioBuffer: Buffer.from('safe-audio'),
    format: 'wav',
  });
});

describe('MCP finalized output delivery', () => {
  it('drains an admitted chat and rejects every registered tool after shutdown admission closes', async () => {
    let finish!: (value: any) => void;
    mocks.model.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const lifecycle = new McpCallLifecycle();
    const server = createLumiMcpServer(undefined, new ToolRegistry(), vi.fn(), undefined, lifecycle);
    const response = getHandler(server, 'lumi_chat')({ message: 'hello' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    lifecycle.stopAdmission();
    let drained = false;
    const pendingDrain = lifecycle.drain().then(() => { drained = true; });
    for (const name of Object.keys((server as any)._registeredTools)) {
      await expect(getHandler(server, name)({})).rejects.toThrow('shutting down');
    }
    expect(drained).toBe(false);
    expect(mocks.model).toHaveBeenCalledTimes(1);
    finish({ text: 'Hello.', toolCalls: [], usageRecords: [] });
    expect(await response).toMatchObject({ finalized: true });
    await pendingDrain;
    expect(drained).toBe(true);
  });

  it('waits for timed-out chat finalization and its later memory write before declaring shutdown drained', async () => {
    vi.useFakeTimers();
    try {
      mocks.autoExtract = true;
      let finishResponse!: (value: any) => void;
      let finishExtraction!: (value: any) => void;
      mocks.model.mockImplementationOnce(() => new Promise(resolve => { finishResponse = resolve; }));
      mocks.extractMemories.mockImplementationOnce(() => new Promise(resolve => { finishExtraction = resolve; }));
      const lifecycle = new McpCallLifecycle();
      const broadcast = vi.fn();
      const server = createLumiMcpServer(undefined, new ToolRegistry(), broadcast, undefined, lifecycle);
      const pending = getHandler(server, 'lumi_chat')({ message: 'My favourite colour is synthetic blue.' });
      await vi.waitFor(() => expect(finishResponse).toBeTypeOf('function'));
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await pending).toMatchObject({ finalized: false, reason: 'background_processing' });
      lifecycle.stopAdmission();
      let drained = false;
      const pendingDrain = lifecycle.drain().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      finishResponse({ text: 'I will remember blue.', toolCalls: [], usageRecords: [] });
      await vi.waitFor(() => expect(finishExtraction).toBeTypeOf('function'));
      await vi.waitFor(() => expect(broadcast.mock.calls.some(([event]) => event === 'mcp:proactive')).toBe(true));
      expect(drained).toBe(false);
      expect(addMemory).not.toHaveBeenCalled();
      finishExtraction({ memories: [{ type: 'fact', content: 'Synthetic blue', keywords: ['blue'], confidence: 1 }], reminders: [] });
      await pendingDrain;
      expect(mocks.extractMemories).toHaveBeenCalledWith(expect.objectContaining({ userText: 'My favourite colour is synthetic blue.', requestId: expect.any(String), conversationId: expect.any(String) }));
      expect(addMemory).not.toHaveBeenCalled();
      expect(drained).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('finishes draining a failed background chat without retaining a phantom active call', async () => {
    vi.useFakeTimers();
    try {
      let fail!: (reason: Error) => void;
      mocks.model.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
      const lifecycle = new McpCallLifecycle();
      const broadcast = vi.fn();
      const server = createLumiMcpServer(undefined, new ToolRegistry(), broadcast, undefined, lifecycle);
      const pending = getHandler(server, 'lumi_chat')({ message: 'hello' });
      await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await pending).toMatchObject({ finalized: false });
      lifecycle.stopAdmission();
      const pendingDrain = lifecycle.drain();
      fail(new Error('synthetic adapter failure'));
      await pendingDrain;
      expect(broadcast).toHaveBeenCalledWith('agent:response', expect.objectContaining({ reason: 'mcp_operation_failed' }));
    } finally { vi.useRealTimers(); }
  });

  it('keeps unavailable remote capabilities out of the lumi_chat tool adapter', async () => {
    mocks.model.mockResolvedValue({
      text: 'safe remote answer',
      toolCalls: [],
      usageRecords: [],
    });
    const scope = {
      userId: 'remote-mcp-user',
      username: 'remote-mcp-user',
      role: 'user',
      authenticated: true,
      domain: 'personal' as const,
      orgId: '',
    };
    const server = createLumiMcpServer(undefined, new ToolRegistry(), vi.fn(), scope);

    await getHandler(server, 'lumi_chat')({ message: 'inspect local files and processes' });

    expect(mocks.tools).not.toHaveBeenCalled();
    expect(mocks.conversation).toHaveBeenCalledTimes(1);
    expect(mocks.model.mock.calls[0][1]).toEqual([]);
    expect(mocks.model.mock.calls[0][2]).toMatchObject({ userId: scope.userId, domain: scope.domain, orgId: scope.orgId });
    const modelMessages = mocks.model.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const systemPrompt = modelMessages.find(message => message.role === 'system')?.content || '';
    expect(systemPrompt).toContain('Remote execution boundary');
    expect(systemPrompt).not.toMatch(/full access|read_file|desktop_running_processes|credential_get|LAP Inter-Lumi/);
  });

  it('binds memory reads and writes to the authenticated MCP user and organization scope', async () => {
    const scope = {
      userId: 'scoped-mcp-user',
      username: 'scoped-user',
      role: 'user',
      domain: 'work' as const,
      orgId: 'scoped-mcp-org',
    };
    const server = createLumiMcpServer(undefined, new ToolRegistry(), vi.fn(), scope);

    await getHandler(server, 'lumi_memory_search')({ query: 'private', limit: 3 });
    expect(queryMemories).toHaveBeenCalledWith(expect.objectContaining({
      userId: scope.userId,
      domain: scope.domain,
      orgId: scope.orgId,
      query: 'private',
      limit: 3,
    }));

    await getHandler(server, 'lumi_memory_add')({
      type: 'fact',
      content: 'Scoped MCP fact',
      keywords: ['scoped'],
    });
    expect(addMemory).toHaveBeenCalledWith(
      expect.objectContaining({ userId: scope.userId, content: 'Scoped MCP fact' }),
      expect.objectContaining({ domain: scope.domain, orgId: scope.orgId }),
    );

    await getHandler(server, 'lumi_reminder_list')({});
    expect(getDueReminders).toHaveBeenCalledWith({
      userId: scope.userId,
      domain: scope.domain,
      orgId: scope.orgId,
    });

  });

  it('buffers raw chat chunks and speaks only the finalized blocked result', async () => {
    const record = falseSuccessRecord();
    mocks.model.mockImplementation(async (...args: any[]) => {
      args[3]?.(record);
      args[10]?.('\u5df2\u5b8c\u6210\uff0c\u6587\u6863\u5df2\u5199\u597d\u3002');
      return {
        text: '\u5df2\u5b8c\u6210\uff0c\u6587\u6863\u5df2\u5199\u597d\u3002',
        toolCalls: [record],
        usageRecords: [],
      };
    });
    const broadcast = vi.fn();
    const server = createLumiMcpServer(undefined, new ToolRegistry(), broadcast);

    const result = await getHandler(server, 'lumi_chat')({
      message: wpsContinuationTask(),
    });

    const responseEvent = broadcast.mock.calls.find(([event]) => event === 'agent:response');
    expect(responseEvent).toBeTruthy();
    expect(responseEvent?.[1]).toMatchObject({
      finalized: true,
      blocked: true,
    });
    expect(responseEvent?.[1].reason).toBe('conversation_response_incomplete');
    expect(responseEvent?.[1].text).not.toBe('\u5df2\u5b8c\u6210\uff0c\u6587\u6863\u5df2\u5199\u597d\u3002');
    expect(JSON.stringify(responseEvent?.[1])).not.toMatch(
      /No successful current-turn tool execution|Missing in-app UI mutation evidence/u,
    );
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(mocks.tools).not.toHaveBeenCalled();
    expect(mocks.conversation).toHaveBeenCalledTimes(2);

    const chunkEvents = broadcast.mock.calls.filter(([event]) => event === 'mcp:chunk');
    expect(chunkEvents).toHaveLength(1);
    expect(chunkEvents[0][1]).toMatchObject({
      text: responseEvent?.[1].text,
      finalized: true,
      blocked: true,
    });
    expect(mocks.synthesizeSpeech).toHaveBeenCalledWith(
      responseEvent?.[1].text,
      expect.any(Object),
    );
    expect(result).toMatchObject({
      finalized: true,
      blocked: true,
    });
    expect(result.content[0].text).toBe(responseEvent?.[1].text);
  });

  it('keeps ordinary MCP conversation available through the same gate', async () => {
    mocks.model.mockResolvedValue({
      text: '\u542c\u5f97\u89c1\uff0c\u6211\u5728\u3002',
      toolCalls: [],
      usageRecords: [],
    });
    const broadcast = vi.fn();
    const server = createLumiMcpServer(undefined, new ToolRegistry(), broadcast);

    const result = await getHandler(server, 'lumi_chat')({ message: '\u4f60\u80fd\u542c\u89c1\u6211\u8bf4\u8bdd\u5417\uff1f' });

    expect(result).toMatchObject({
      finalized: true,
      blocked: false,
    });
    expect(result.content[0].text).toBe('\u542c\u5f97\u89c1\uff0c\u6211\u5728\u3002');
    expect(mocks.synthesizeSpeech).toHaveBeenCalledWith('\u542c\u5f97\u89c1\uff0c\u6211\u5728\u3002', expect.any(Object));
  });

  it('blocks proactive speech that claims an unevidenced desktop action', async () => {
    const broadcast = vi.fn();
    const server = createLumiMcpServer(undefined, new ToolRegistry(), broadcast);

    const result = await getHandler(server, 'lumi_speak')({
      text: '\u5df2\u7ecf\u6253\u5f00\u5fae\u4fe1\u4e86\u3002',
    });

    expect(result).toMatchObject({
      isError: true,
      finalized: true,
      blocked: true,
    });
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
    expect(broadcast.mock.calls.find(([event]) => event === 'mcp:proactive')).toBeUndefined();
  });

  it('allows grounded-neutral proactive speech through the same gate', async () => {
    const broadcast = vi.fn();
    const server = createLumiMcpServer(undefined, new ToolRegistry(), broadcast);

    const result = await getHandler(server, 'lumi_speak')({
      text: '\u8bb0\u5f97\u559d\u6c34\u3002',
    });

    expect(result).toMatchObject({
      finalized: true,
      blocked: false,
    });
    expect(mocks.synthesizeSpeech).toHaveBeenCalledWith('\u8bb0\u5f97\u559d\u6c34\u3002', expect.any(Object));
    expect(broadcast.mock.calls.find(([event]) => event === 'mcp:proactive')?.[1]).toMatchObject({
      text: '\u8bb0\u5f97\u559d\u6c34\u3002',
      finalized: true,
      blocked: false,
    });
  });

  it('returns only a non-terminal timeout message, then finalizes the background result', async () => {
    vi.useFakeTimers();
    try {
      let resolveResponse!: (value: any) => void;
      mocks.model
        .mockImplementationOnce(() => new Promise(resolve => {
          resolveResponse = resolve;
        }))
        .mockResolvedValue({
          text: '\u4ecd\u672a\u62ff\u5230\u53ef\u9a8c\u8bc1\u7684\u5ba2\u6237\u7aef\u64cd\u4f5c\u7ed3\u679c\u3002',
          toolCalls: [falseSuccessRecord()],
          usageRecords: [],
        });
      const broadcast = vi.fn();
      const server = createLumiMcpServer(undefined, new ToolRegistry(), broadcast);
      const pending = getHandler(server, 'lumi_chat')({ message: wpsContinuationTask() });
      await vi.waitFor(() => expect(resolveResponse).toBeTypeOf('function'));

      await vi.advanceTimersByTimeAsync(25_000);
      const timeoutResult = await pending;
      expect(timeoutResult).toMatchObject({
        finalized: false,
        blocked: false,
        reason: 'background_processing',
      });
      expect(timeoutResult.content[0].text).not.toMatch(/\u5df2\u5b8c\u6210|\u6210\u529f/);
      expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();

      resolveResponse({
        text: '\u5df2\u5b8c\u6210\uff0c\u6587\u6863\u5df2\u5199\u597d\u3002',
        toolCalls: [falseSuccessRecord()],
        usageRecords: [],
      });
      await vi.waitFor(() => expect(broadcast.mock.calls.some(([event]) => event === 'mcp:proactive')).toBe(true));

      const responseEvent = broadcast.mock.calls.find(([event]) => event === 'agent:response');
      expect(responseEvent?.[1]).toMatchObject({
        finalized: true,
        blocked: true,
      });
      expect(mocks.synthesizeSpeech).toHaveBeenCalledWith(responseEvent?.[1].text, expect.any(Object));
      const proactiveEvent = broadcast.mock.calls.find(([event]) => event === 'mcp:proactive');
      expect(proactiveEvent?.[1]).toMatchObject({
        finalized: true,
        blocked: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects fictional route-task tool results when no capability is admitted', async () => {
    mocks.model.mockResolvedValue({ text: '已完成，文档已写好。', toolCalls: [falseSuccessRecord()], usageRecords: [] });
    const server = createLumiMcpServer(undefined, new ToolRegistry(), vi.fn(), {
      userId: 'mcp-unavailable-task-owner', username: 'fixture', role: 'user', authenticated: false, trustedServiceExecution: true, domain: 'personal', orgId: '',
    });
    const response = await getHandler(server, 'lumi_route_task')({ task: wpsContinuationTask() });
    const payload = JSON.parse(response.content[0].text);
    expect(payload).toMatchObject({ handledBy: 'LumiCore', finalized: true, blocked: true, toolCalls: 0 });
    expect(payload.result).not.toBe('已完成，文档已写好。');
    expect(JSON.stringify(payload)).not.toMatch(/No successful current-turn tool execution|Missing in-app UI mutation evidence/u);
    expect(mocks.tools).not.toHaveBeenCalled(); expect(mocks.conversation).toHaveBeenCalledTimes(2);
    const config = mocks.model.mock.calls[0][2];
    expect(payload).toMatchObject({ requestId: config.requestId, conversationId: config.conversationId });
    expect(mocks.model.mock.calls[0][1]).toEqual([]); expect(mocks.model.mock.calls[1][1]).toEqual([]);
    expect(mocks.model.mock.calls[0][2].modelTurnState).toBe(mocks.model.mock.calls[1][2].modelTurnState);
    expect(readDB().conversationActionTurns).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: config.requestId, conversationId: config.conversationId }),
    ]));
    expect(readDB().conversationActionReceipts.some((row: any) => row.requestId === config.requestId)).toBe(false);
  });
});

it('shares its conversation lease with socket and messaging writers', async () => {
  const { startIsolatedConversation } = await import('../server/conversation/manager');
  const { reserveConversationExecution } = await import('../server/cognition/conversation_execution');
  const userId = 'mcp-shared-queue-owner';
  const conversation = startIsolatedConversation(userId, 'lumi', 'personal', '');
  const prior = reserveConversationExecution({ userId, conversationId: conversation.id }, 'socket-prior-request');
  await prior.waitForTurn();
  mocks.model.mockResolvedValue({ text: 'Hello.', toolCalls: [], usageRecords: [] });
  const calls = mocks.model.mock.calls.length;
  const server = createLumiMcpServer(undefined, new ToolRegistry(), undefined, {
    userId, username: 'fixture', role: 'user', domain: 'personal', orgId: '', authenticated: true,
  });
  const reply = getHandler(server, 'lumi_chat')({ message: 'Hello.', conversationId: conversation.id });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(mocks.model.mock.calls).toHaveLength(calls);
  } finally { prior.release(); }
  expect(await reply).toMatchObject({ finalized: true, conversationId: conversation.id });
  const config = mocks.model.mock.calls.at(-1)![2];
  expect(mocks.tools).not.toHaveBeenCalled();
  expect(config).toMatchObject({ requestId: expect.any(String), conversationId: conversation.id });
  expect(readDB().conversationActionTurns).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: expect.any(String), requestId: config.requestId, conversationId: conversation.id }),
  ]));
  const next = reserveConversationExecution({ userId, conversationId: conversation.id }, 'socket-next-request');
  try { await next.waitForTurn(); } finally { next.release(); }
});


it('serializes task and chat through one durable MCP conversation with exact tool receipt identity', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'web_search', description: 'Search public web fixtures', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    handler: async () => JSON.stringify({ ok: true, results: [{ title: 'Synthetic result', url: 'https://example.com' }] }),
  });
  let finish!: () => void; let context: any; let recorded = false;
  const final = new Promise<void>(resolve => { finish = resolve; });
  mocks.model.mockImplementationOnce(async (...args) => {
    context = args[11];
    const record = await executeToolCall({ registry, id: 'mcp-task-step-receipt', name: 'web_search', arguments: { query: 'synthetic' }, context });
    expect(record.error).toBeUndefined();
    await flushDBOrThrow(); recorded = true; await final;
    return { text: 'The search returned a synthetic result.', toolCalls: [record], usageRecords: [] };
  }).mockResolvedValue({ text: 'We discussed a synthetic search result.', toolCalls: [], usageRecords: [] });
  const broadcast = vi.fn(); const userId = 'mcp-cross-entry-receipt-owner';
  const server = createLumiMcpServer(undefined, registry, broadcast, {
    userId, username: 'fixture', role: 'user', domain: 'personal', orgId: '', authenticated: true,
  });
  const task = getHandler(server, 'lumi_route_task')({ task: 'Search the public web for synthetic examples.' });
  let chat: Promise<any> | undefined;
  try {
    await vi.waitFor(() => expect(recorded).toBe(true));
    expect(context).toMatchObject({ source: 'mcp_route_task', turnId: context.requestId, taskId: expect.any(String), turnRowId: expect.any(String), resolutionId: 'resolution:' + context.requestId });
    expect(readDB().conversationActionReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: context.requestId, taskId: context.taskId, conversationId: context.conversationId, toolName: 'web_search' }),
    ]));
    expect(readDB().conversationActionTasks.find((row: any) => row.id === context.taskId)?.status).not.toBe('completed');
    chat = getHandler(server, 'lumi_chat')({ message: 'What did we discuss?', conversationId: context.conversationId });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(mocks.model).toHaveBeenCalledTimes(1);
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  } finally { finish(); }
  const taskResponse = JSON.parse((await task).content[0].text); const chatResponse = await chat!;
  expect(taskResponse).toMatchObject({ requestId: context.requestId, conversationId: context.conversationId, toolCalls: 1, finalized: true, blocked: false });
  expect(chatResponse.conversationId).toBe(context.conversationId);
  expect(chatResponse.requestId).not.toBe(context.requestId);
  expect(mocks.model.mock.calls[1][0]).toEqual(expect.arrayContaining([
    { role: 'user', content: 'Search the public web for synthetic examples.' }, { role: 'assistant', content: taskResponse.result },
  ]));
  expect(mocks.synthesizeSpeech).toHaveBeenCalledTimes(1);
  expect(broadcast.mock.calls.filter(([event]) => event === 'agent:response').map(([, data]) => [data.requestId, data.conversationId, data.source])).toEqual([
    [taskResponse.requestId, taskResponse.conversationId, 'mcp_route_task'], [chatResponse.requestId, chatResponse.conversationId, 'mcp_chat'],
  ]);
});

it('keeps task calls out of speech and memory extraction while persisting their transcript', async () => {
  mocks.autoExtract = true;
  mocks.model.mockResolvedValue({ text: 'A neutral explanation.', toolCalls: [], usageRecords: [] });
  const server = createLumiMcpServer(undefined, new ToolRegistry(), undefined, {
    userId: 'mcp-task-transcript-owner', username: 'fixture', role: 'user', domain: 'personal', orgId: '', authenticated: true,
  });
  const result = JSON.parse((await getHandler(server, 'lumi_route_task')({ task: 'Explain a synthetic example.' })).content[0].text);
  const { getMessages } = await import('../server/conversation/manager');
  expect(result).toMatchObject({ handledBy: 'LumiCore', finalized: true, blocked: false, requestId: expect.any(String), conversationId: expect.any(String) });
  expect(getMessages(result.conversationId, 10).map(row => [row.role, row.message])).toEqual([
    ['user', 'Explain a synthetic example.'], ['assistant', 'A neutral explanation.'],
  ]);
  expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  expect(mocks.extractMemories).not.toHaveBeenCalled();
});

it('aborts a queued task when original organization access is revoked despite mutation of the caller scope', async () => {
  const { createOrg, addMember, removeMember } = await import('../server/org/db');
  const { reserveConversationExecution, getConversationExecution } = await import('../server/cognition/conversation_execution');
  const userId = 'mcp-task-revocation-owner';
  const org = createOrg('MCP task scope fixture', 'mcp-task-revocation-org', 'mcp-task-revocation-org-owner');
  addMember(org.id, userId, 'member');
  const caller: any = { userId, username: 'fixture', role: 'user', domain: 'work', orgId: org.id, orgRole: 'member', authenticated: true };
  mocks.model.mockResolvedValue({ text: 'A neutral explanation.', toolCalls: [], usageRecords: [] });
  const broadcast = vi.fn(); const server = createLumiMcpServer(undefined, new ToolRegistry(), broadcast, caller);
  const task = getHandler(server, 'lumi_route_task');
  const first = JSON.parse((await task({ task: 'Explain a synthetic example.' })).content[0].text);
  const scope = { userId, domain: 'work' as const, orgId: org.id, conversationId: first.conversationId };
  const prior = reserveConversationExecution(scope, 'mcp-task-original-work-owner'); await prior.waitForTurn();
  const second = task({ task: 'Explain another synthetic example.' });
  const requestId = broadcast.mock.calls.filter(([event]) => event === 'agent:status').at(-1)![1].requestId;
  const admission = getConversationExecution({ ...scope, source: 'mcp_route_task' }, requestId)!;
  try {
    expect(admission.state).toBe('queued');
    caller.domain = 'personal'; caller.orgId = ''; removeMember(org.id, userId);
    await vi.waitFor(() => expect(admission.signal.aborted).toBe(true));
    expect(mocks.model).toHaveBeenCalledTimes(1);
    expect(readDB().conversationActionTurns.some((row: any) => row.requestId === requestId)).toBe(false);
  } finally { prior.release(); }
  expect(await second).toMatchObject({ isError: true, blocked: true, reason: 'mcp_operation_failed' });
  expect(mocks.model).toHaveBeenCalledTimes(1);
  expect(getConversationExecution({ ...scope, source: 'mcp_route_task' }, requestId)).toBeUndefined();
});

it('drains a timed-out task through durable finalization without replaying its model or speaking', async () => {
  vi.useFakeTimers();
  try {
    let finish!: (value: any) => void;
    mocks.model.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const lifecycle = new McpCallLifecycle(); const broadcast = vi.fn();
    const server = createLumiMcpServer(undefined, new ToolRegistry(), broadcast, undefined, lifecycle);
    const pending = getHandler(server, 'lumi_route_task')({ task: 'Explain a synthetic example.' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await vi.advanceTimersByTimeAsync(25_000);
    const partial = JSON.parse((await pending).content[0].text);
    expect(partial).toMatchObject({ finalized: false, reason: 'background_processing', requestId: expect.any(String), conversationId: expect.any(String) });
    lifecycle.stopAdmission(); let drained = false;
    const drain = lifecycle.drain().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    finish({ text: 'A neutral explanation.', toolCalls: [], usageRecords: [] }); await drain;
    expect(drained).toBe(true); expect(mocks.model).toHaveBeenCalledTimes(1);
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith('mcp:proactive', expect.objectContaining({ text: 'A neutral explanation.', finalized: true, requestId: partial.requestId, conversationId: partial.conversationId, source: 'mcp_route_task' }));
    const { getMessages } = await import('../server/conversation/manager');
    expect(getMessages(partial.conversationId, 10).at(-1)?.message).toBe('A neutral explanation.');
  } finally { vi.useRealTimers(); }
});

it.each(['', 'I have completed the nonexistent write.'])('blocks incomplete MCP conversation and skips automatic learning: %s', async text => {
  mocks.autoExtract = true;
  mocks.model.mockResolvedValue({ text, toolCalls: text ? [falseSuccessRecord()] : [], usageRecords: [] });
  const server = createLumiMcpServer(undefined, new ToolRegistry(), vi.fn());
  const result = await getHandler(server, 'lumi_chat')({ message: 'Hello.' });
  expect(result).toMatchObject({ finalized: true, blocked: true, reason: 'conversation_response_incomplete' });
  expect(mocks.conversation).toHaveBeenCalledTimes(2);
  expect(mocks.tools).not.toHaveBeenCalled();
  expect(mocks.extractMemories).not.toHaveBeenCalled();
  expect(mocks.model.mock.calls[0][2].modelTurnState).toBe(mocks.model.mock.calls[1][2].modelTurnState);
});


it.each(['lumi_chat', 'lumi_route_task'] as const)('keeps %s blocked after a successful recovery step when the final model guard failed', async name => {
  const registry = new ToolRegistry();
  registry.register({ name: 'web_search', description: 'Synthetic public evidence', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    handler: async () => JSON.stringify({ ok: true, results: [{ title: 'Synthetic source', url: 'https://example.invalid/source' }] }),
  });
  let identity: any;
  mocks.model.mockResolvedValueOnce({ text: 'I have completed the search.', toolCalls: [], usageRecords: [] });
  mocks.model.mockImplementationOnce(async (...args: any[]) => {
    identity = args[11];
    const record = await executeToolCall({ registry, id: identity.requestId + ':recovery', name: 'web_search', arguments: { query: 'synthetic' }, context: identity });
    expect(record.error).toBeUndefined(); await args[3]?.(record);
    return { text: 'A synthetic source was found.', toolCalls: [record], usageRecords: [],
      completionGuard: { text: 'The model response could not be completed.', blocked: true, reason: 'conversation_response_incomplete' } };
  });
  mocks.autoExtract = true; const broadcast = vi.fn();
  const server = createLumiMcpServer(undefined, registry, broadcast, { userId: 'mcp-blocked-' + name, username: 'fixture', role: 'user', domain: 'personal', orgId: '', authenticated: true });
  const input = 'Search the public web for synthetic examples.';
  const raw = await getHandler(server, name)(name === 'lumi_chat' ? { message: input } : { task: input });
  const result = name === 'lumi_chat' ? raw : JSON.parse(raw.content[0].text);
  expect(result, JSON.stringify(result)).toMatchObject({ finalized: true, blocked: true });
  expect(mocks.model).toHaveBeenCalledTimes(2); expect(mocks.extractMemories).not.toHaveBeenCalled();
  const task = readDB().conversationActionTasks.find((row: any) => row.id === identity.taskId);
  expect(task.status).toBe('blocked');
  expect(readDB().conversationActionReceipts.filter((row: any) => row.requestId === identity.requestId)).toHaveLength(1);
  expect(broadcast).toHaveBeenCalledWith('agent:response', expect.objectContaining({ blocked: true, requestId: identity.requestId, conversationId: identity.conversationId }));
});
