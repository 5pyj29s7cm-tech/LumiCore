import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runWithTools: vi.fn(),
  synthesizeSpeech: vi.fn(),
  classifyComplexity: vi.fn(),
  decomposeTask: vi.fn(),
  matchWorkers: vi.fn(),
  executeWorkflow: vi.fn(),
  aggregateWithLLM: vi.fn(),
}));

vi.mock('../server/llm/adapter', () => ({
  runWithTools: mocks.runWithTools,
}));

vi.mock('../server/memory', () => ({
  queryMemories: vi.fn(() => []),
  addMemory: vi.fn(),
  getDueReminders: vi.fn(() => []),
  buildNarrativeChain: vi.fn(() => ''),
  borrowAgentMemories: vi.fn(() => []),
}));

vi.mock('../server/personality', () => {
  const personality = {
    id: 'lumi',
    name: 'Lumi',
    memoryPolicy: {
      retrieveLimit: 5,
      minConfidence: 0,
      autoExtract: false,
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

vi.mock('../server/agents/orchestrator', () => ({
  classifyComplexity: mocks.classifyComplexity,
  decomposeTask: mocks.decomposeTask,
  matchWorkers: mocks.matchWorkers,
  executeWorkflow: mocks.executeWorkflow,
  aggregateWithLLM: mocks.aggregateWithLLM,
  getRoutingCacheStats: vi.fn(() => ({})),
}));

vi.mock('../db_layer', () => ({
  readDB: vi.fn(() => ({
    agents: [
      { id: 'worker-1', name: 'Worker 1', status: 'idle', userId: 'mcp_remote', domain: 'personal', orgId: '' },
      { id: 'work-worker', name: 'Work Worker', status: 'idle', domain: 'work', orgId: 'scoped-route-org' },
    ],
    memories: [],
    interactions: [],
    conversations: [],
  })),
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
import {
  addMemory,
  borrowAgentMemories,
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
    arguments: { path: 'D:\\lumiOS\\mcp-false-success.txt' },
    result: 'File written: D:\\lumiOS\\mcp-false-success.txt',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.synthesizeSpeech.mockResolvedValue({
    audioBuffer: Buffer.from('safe-audio'),
    format: 'wav',
  });
  mocks.classifyComplexity.mockReturnValue('simple');
});

describe('MCP finalized output delivery', () => {
  it('passes a deny-by-default remote boundary into lumi_chat tool execution', async () => {
    mocks.runWithTools.mockResolvedValue({
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
    const server = createLumiMcpServer(undefined, {} as any, vi.fn(), scope);

    await getHandler(server, 'lumi_chat')({ message: 'inspect local files and processes' });

    const context = mocks.runWithTools.mock.calls[0][11] as any;
    expect(context).toMatchObject({
      userId: scope.userId,
      authenticated: true,
      authRole: 'user',
      localExecution: false,
      executionBoundary: 'remote_restricted',
      source: 'mcp_chat',
    });
    expect(context.toolPolicy.allowedTools).toEqual(['web_search']);
    const modelMessages = mocks.runWithTools.mock.calls[0][0] as Array<{ role: string; content: string }>;
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
    const server = createLumiMcpServer(undefined, {} as any, vi.fn(), scope);

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

    await getHandler(server, 'lumi_agent_share')({
      requestingAgentId: 'worker-1',
      topic: 'scoped',
      limit: 2,
    });
    expect(borrowAgentMemories).toHaveBeenCalledWith('worker-1', 'scoped', scope.userId, 8);
  });

  it('buffers raw chat chunks and speaks only the finalized blocked result', async () => {
    const record = falseSuccessRecord();
    mocks.runWithTools.mockImplementation(async (...args: any[]) => {
      args[3]?.(record);
      args[10]?.('\u5df2\u5b8c\u6210\uff0c\u6587\u6863\u5df2\u5199\u597d\u3002');
      return {
        text: '\u5df2\u5b8c\u6210\uff0c\u6587\u6863\u5df2\u5199\u597d\u3002',
        toolCalls: [record],
        usageRecords: [],
      };
    });
    const broadcast = vi.fn();
    const server = createLumiMcpServer(undefined, {} as any, broadcast);

    const result = await getHandler(server, 'lumi_chat')({
      message: wpsContinuationTask(),
    });

    const responseEvent = broadcast.mock.calls.find(([event]) => event === 'agent:response');
    expect(responseEvent).toBeTruthy();
    expect(responseEvent?.[1]).toMatchObject({
      finalized: true,
      blocked: true,
    });
    expect(responseEvent?.[1].reason).toContain('in-app UI mutation');
    expect(responseEvent?.[1].text).not.toBe('\u5df2\u5b8c\u6210\uff0c\u6587\u6863\u5df2\u5199\u597d\u3002');

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
    mocks.runWithTools.mockResolvedValue({
      text: '\u542c\u5f97\u89c1\uff0c\u6211\u5728\u3002',
      toolCalls: [],
      usageRecords: [],
    });
    const broadcast = vi.fn();
    const server = createLumiMcpServer(undefined, {} as any, broadcast);

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
    const server = createLumiMcpServer(undefined, {} as any, broadcast);

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
    const server = createLumiMcpServer(undefined, {} as any, broadcast);

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
      mocks.runWithTools.mockImplementation(() => new Promise(resolve => {
        resolveResponse = resolve;
      }));
      const broadcast = vi.fn();
      const server = createLumiMcpServer(undefined, {} as any, broadcast);
      const pending = getHandler(server, 'lumi_chat')({ message: wpsContinuationTask() });

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
      await vi.runAllTimersAsync();
      await Promise.resolve();

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

  it('finalizes direct route-task results against the actual tool ledger', async () => {
    const record = falseSuccessRecord();
    mocks.runWithTools.mockResolvedValue({
      text: '\u5df2\u5b8c\u6210\uff0c\u6587\u6863\u5df2\u5199\u597d\u3002',
      toolCalls: [record],
      usageRecords: [],
    });
    const server = createLumiMcpServer(undefined, {} as any, vi.fn(), {
      userId: 'mcp_remote',
      username: 'mcp_remote',
      role: 'user',
      authenticated: false,
      trustedServiceExecution: true,
      domain: 'personal',
      orgId: '',
    });

    const response = await getHandler(server, 'lumi_route_task')({ task: wpsContinuationTask() });
    const payload = JSON.parse(response.content[0].text);

    expect(payload).toMatchObject({
      complexity: 'simple',
      finalized: true,
      blocked: true,
      toolCalls: 1,
    });
    expect(payload.reason).toContain('in-app UI mutation');
    expect(payload.result).not.toBe('\u5df2\u5b8c\u6210\uff0c\u6587\u6863\u5df2\u5199\u597d\u3002');
    const context = mocks.runWithTools.mock.calls[0][11] as any;
    expect(context).toMatchObject({
      authenticated: false,
      trustedServiceExecution: true,
      localExecution: false,
      executionBoundary: 'remote_restricted',
      source: 'mcp_route_task',
    });
    expect(context.toolPolicy.allowedTools).toEqual(['web_search']);
  });

  it('does not package an evidence-free orchestrator aggregate as completed', async () => {
    mocks.classifyComplexity.mockReturnValue('complex');
    const subTask = {
      id: 'sub-1',
      description: wpsContinuationTask(),
      requiredSkill: 'general',
      executionMode: 'lumi',
      assignedAgentId: 'worker-1',
    };
    const assignment = {
      subTask,
      agent: { id: 'worker-1', name: 'Worker 1', status: 'idle' },
    };
    mocks.decomposeTask.mockResolvedValue([subTask]);
    mocks.matchWorkers.mockReturnValue([assignment]);
    mocks.executeWorkflow.mockResolvedValue({
      subTaskResults: [{ subTaskId: 'sub-1', output: 'No execution receipt.', agentId: 'worker-1' }],
      aggregatedOutput: 'No execution receipt.',
      totalAgentsUsed: 1,
    });
    mocks.aggregateWithLLM.mockResolvedValue('\u540e\u53f0\u4efb\u52a1\u5df2\u5b8c\u6210\uff0cWPS \u6587\u6863\u5df2\u5199\u597d\u3002');
    const workScope = {
      userId: 'scoped-route-user',
      username: 'scoped-route-user',
      role: 'user',
      authenticated: true,
      domain: 'work' as const,
      orgId: 'scoped-route-org',
    };
    const server = createLumiMcpServer(undefined, {} as any, vi.fn(), workScope);

    const response = await getHandler(server, 'lumi_route_task')({ task: wpsContinuationTask() });
    const payload = JSON.parse(response.content[0].text);

    expect(mocks.decomposeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        userId: workScope.userId,
        domain: workScope.domain,
        orgId: workScope.orgId,
      }),
      expect.objectContaining({
        userId: workScope.userId,
        domain: workScope.domain,
        orgId: workScope.orgId,
      }),
      expect.any(Object),
    );
    expect(mocks.executeWorkflow.mock.calls[0][1]).toMatchObject({
      userId: workScope.userId,
      authenticated: true,
      localExecution: false,
      executionBoundary: 'remote_restricted',
      toolPolicy: expect.objectContaining({ allowedTools: ['web_search'] }),
    });
    expect(mocks.executeWorkflow).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        userId: workScope.userId,
        domain: workScope.domain,
        orgId: workScope.orgId,
      }),
      expect.any(Object),
      expect.any(Object),
      expect.any(Array),
      expect.any(Function),
    );

    expect(payload).toMatchObject({
      complexity: 'complex',
      finalized: true,
      blocked: true,
      toolCalls: 0,
    });
    expect(payload.result).not.toContain('\u540e\u53f0\u4efb\u52a1\u5df2\u5b8c\u6210');
  });
});
