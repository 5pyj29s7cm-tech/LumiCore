import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';

const mocks = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock('../server/llm/providers', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/providers')>(),
  makeLLMCall: mocks.model,
  makeLLMCallStreaming: mocks.model,
}));
vi.mock('../server/memory', async importOriginal => ({
  ...await importOriginal<typeof import('../server/memory')>(),
  queryMemories: vi.fn(() => []), queryMemoriesVector: vi.fn(async () => []),
  extractMemories: vi.fn(async () => ({ memories: [], reminders: [] })),
}));
vi.mock('../server/agents/rag', async importOriginal => ({
  ...await importOriginal<typeof import('../server/agents/rag')>(), retrieveChunks: vi.fn(async () => []),
}));

import { initDatabase, readDB, flushDBOrThrow } from '../db_layer';
import { getDataPath } from '../server/config/data_path';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { registerChatHandler } from '../server/socket/chat';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';
import { ToolRegistry } from '../server/tools/registry';
import { runWithTools } from '../server/llm/adapter';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { formatGroundedKnowledgeObservation } from '../server/cognition/knowledge_result';
import { guardCompletionClaims } from '../server/work_product/completion_guard';
import { buildForegroundTaskCompletionFeedback } from '../server/cognition/acceptance_evidence';
import { recoverBlockedExecutionOnce } from '../server/cognition/execution_guard_recovery';
import type { ToolExecutionRecord } from '../server/tools/types';

const task = '查看一下知识库的文件';
function statsRecord(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    id: 'stats-record', name: 'knowledge_file_stats', arguments: {},
    result: JSON.stringify({ totalFiles: 6, fullyAbsorbed: false, files: Array.from({ length: 6 }, (_, i) => ({ name: `sample-${i}.txt`, status: i < 4 ? 'indexed_unverified' : 'pending' })) }),
    terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Inventory query returned.' },
    ...overrides,
  };
}

describe('knowledge observation completion contract', () => {
  it('uses actual counts instead of a model promise, without claiming full absorption', () => {
    const result = guardCompletionClaims({ task, response: '我先查看一下知识库的文件。', toolCalls: [statsRecord()] });
    expect(result.blocked).toBe(false);
    expect(result.text).toContain('共有 6 个文件');
    expect(result.text).toContain('4 个已索引但未验证');
    expect(result.text).toContain('2 个待处理');
    expect(result.text).toContain('不代表文件都已完整吸收');
    expect(result.text).not.toContain('没能完成');
  });

  it.each(['打开知识库页面', '删除知识库全部文件', '导入知识库文件', '读取知识库合同的全文并分析内容'])('does not let inventory evidence complete another goal: %s', goal => {
    expect(formatGroundedKnowledgeObservation({ taskText: goal, toolRecords: [statsRecord()] })).toBeNull();
  });

  it('rejects stale, failed, malformed and unverified observations', () => {
    const valid = statsRecord({ taskId: 'current-task', requestId: 'current-request' });
    for (const record of [
      statsRecord(), { ...valid, taskId: 'old-task' }, { ...valid, requestId: 'old-request' },
      { ...valid, result: '{"totalFiles":6,"files":[]}' },
      { ...valid, terminalVerification: { ...valid.terminalVerification!, status: 'failed' as const } },
      { ...valid, error: 'inventory unavailable' },
    ]) {
      expect(formatGroundedKnowledgeObservation({ taskText: task, toolRecords: [record], taskId: 'current-task', requestId: 'current-request' })).toBeNull();
    }
    expect(formatGroundedKnowledgeObservation({ taskText: task, toolRecords: [valid, { ...valid, error: 'newer failure' }], taskId: 'current-task', requestId: 'current-request' })).toBeNull();
    const conflictingEnvelope = {
      version: 1, status: 'verified_success', toolName: 'knowledge_file_stats',
      taskId: 'old-task', requestId: 'current-request', verification: { status: 'verified' },
    } as ToolExecutionRecord['envelope'];
    expect(formatGroundedKnowledgeObservation({ taskText: task, toolRecords: [{ ...valid, envelope: conflictingEnvelope }], taskId: 'current-task', requestId: 'current-request' })).toBeNull();
  });

  it('keeps empty inventories and complete inventories truthful in English', () => {
    const render = (files: Array<{ name: string; status: string }>) => formatGroundedKnowledgeObservation({
      taskText: 'Show knowledge base files', toolRecords: [statsRecord({ result: JSON.stringify({ totalFiles: files.length, files, fullyAbsorbed: false }) })],
    });
    expect(render([])).toBe('The knowledge base currently contains no files.');
    expect(render([{ name: 'sample.txt', status: 'verified' }])).toContain('All these files passed');
  });

  it('preserves a failed adapter guard through finalization and feedback, including a second guard pass', async () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'list_directory', description: 'Synthetic directory observation.', parameters: { type: 'object', properties: {} }, permission: 'public', securityLevel: 'safe', handler: async () => '["sample.pdf"]' });
    mocks.model.mockReset().mockResolvedValueOnce({ text: '', toolCalls: [{ id: 'list', name: 'list_directory', arguments: {} }] })
      .mockResolvedValue({ text: '我先读取合同内容并审查。' });
    const response = await runWithTools([{ role: 'user', content: '读取合同内容并审查' }], registry, { provider: 'deepseek', model: 'synthetic' }, undefined, 2);
    expect(response.completionGuard?.blocked).toBe(true);
    const final = finalizeLumiResponse({ taskText: '读取合同内容并审查', responseText: response.text, toolRecords: response.toolCalls, completionGuard: response.completionGuard, source: 'chat' });
    expect(final.blocked).toBe(true);
    expect(buildForegroundTaskCompletionFeedback({ taskId: 'test-task', taskLabel: '读取合同内容并审查', toolRecords: response.toolCalls, blocked: final.blocked, reason: final.reason })?.status).toBe('blocked');
    const recovered = await recoverBlockedExecutionOnce({
      task: '读取合同内容并审查', responseText: final.text, finalization: final, allowToolUse: true,
      toolRecords: response.toolCalls,
      attempt: async () => ({ text: response.text, toolRecords: response.toolCalls, completionGuard: response.completionGuard }),
      finalize: (responseText, toolRecords, completionGuard) => {
        expect(completionGuard).toEqual(response.completionGuard);
        return finalizeLumiResponse({ taskText: '读取合同内容并审查', responseText, toolRecords, completionGuard, source: 'chat_guard_recovery' });
      },
    });
    expect(recovered.attempted).toBe(true);
    expect(recovered.finalization.blocked).toBe(true);
  });
});

describe('real Socket + adapter + knowledge handler + durable task', () => {
  const userId = `knowledge-terminal-${crypto.randomUUID()}`;
  const http = createServer();
  const io = new Server(http, { transports: ['websocket'] });
  let client: Socket;
  let conversationId: string;
  const modelCalls: string[][] = [];
  const events: Array<{ event: string; payload: any }> = [];
  let emittedTool = false;
  let requestedTool = 'knowledge_file_stats';
  let modelText = '我先查看一下知识库的文件。';

  beforeAll(async () => {
    await initDatabase();
    registerAllTools(toolRegistry);
    const dirname = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24);
    const dir = getDataPath(path.join('knowledge', '_users', dirname));
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, `sample-${i}.txt`), 'Synthetic inventory fixture.');
    conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
    mocks.model.mockReset().mockImplementation(async (_messages: unknown, declarations: Array<{ function: { name: string } }>) => {
      if (!declarations.length) return { text: '{"category":"conversation","confidence":1,"entities":{}}' };
      modelCalls.push(declarations.map(declaration => declaration.function.name));
      if (!emittedTool) {
        emittedTool = true;
        return { text: '', toolCalls: [{ id: crypto.randomUUID(), name: requestedTool, arguments: {} }] };
      }
      return { text: modelText };
    });
    io.on('connection', socket => {
      socket.data.authenticatedUserId = userId;
      socket.data.authenticatedRole = 'admin';
      socket.data.trustedLocalExecution = true;
      socket.join(`user:${userId}:personal`);
      const getter = () => ({});
      registerChatHandler(socket, {
        getDeepSeek: getter, getGemini: getter, getOpenAI: getter, getAnthropic: getter, getQwen: getter,
        getOllama: getter, isOllamaAvailable: () => false, getLmStudio: getter, isLmStudioAvailable: () => false,
        getArk: getter, getXiaomi: getter, getKimi: getter, getGlm: getter, getRelay: getter,
      }, () => ({ audio: false, visual: false, spatial: false, haptic: false, holographic: false, activeDeviceTypes: [], deviceCount: 0 }), () => userId, io);
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('No isolated port');
    client = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'] });
    client.onAny((event, payload) => events.push({ event, payload }));
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
  });
  afterAll(async () => { client?.disconnect(); await new Promise<void>(resolve => io.close(() => resolve())); });

  async function query(text: string) {
    const requestId = `knowledge-query-${crypto.randomUUID()}`;
    emittedTool = false;
    const answer = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { client.off('agent:response', handler); reject(new Error('Synthetic chat did not finish')); }, 12_000);
      const handler = (value: any) => { if (value.requestId === requestId && value.finalized) { clearTimeout(timer); client.off('agent:response', handler); resolve(value); } };
      client.on('agent:response', handler);
    });
    expect(await client.timeout(5_000).emitWithAck('agent:chat', { text, requestId, conversationId, agentId: 'lumi', domain: 'personal', source: 'command-center-chat' })).toMatchObject({ ok: true, requestId });
    const response = await answer;
    await flushDBOrThrow();
    return { requestId, response };
  }

  it('does not carry a prior failed client action into a fresh successful knowledge query', async () => {
    requestedTool = 'client_action';
    modelText = '我先打开客户端设置。';
    const prior = await query('打开Lumi客户端设置');
    expect(prior.response.blocked).toBe(true);
    requestedTool = 'knowledge_file_stats';
    modelText = '我先查看一下知识库的文件。';
    const { requestId, response } = await query(task);
    expect(response).toMatchObject({ finalized: true, blocked: false, completionFeedback: { status: 'completed' } });
    expect(response.text).toContain('共有 6 个文件');
    expect(response.text).toContain('6 个待处理');
    expect(response.text).not.toContain('没能完成');
    const currentTurn = (readDB().conversationActionTurns || []).find((row: any) => row.requestId === requestId);
    const priorTurn = (readDB().conversationActionTurns || []).find((row: any) => row.requestId === prior.requestId);
    const current = (readDB().conversationActionTasks || []).find((row: any) => row.id === currentTurn?.taskId);
    expect(current).toMatchObject({ status: 'completed', goal: task });
    expect(current?.id).not.toBe(priorTurn?.taskId);
    const context = typeof current?.context === 'string' ? JSON.parse(current.context) : current?.context;
    expect(context.inheritedReceipts).toEqual([]);
    const receipts = (readDB().conversationActionReceipts || []).filter((row: any) => row.taskId === current?.id);
    expect(receipts.map((row: any) => row.toolName)).toEqual(['knowledge_file_stats']);
    const assistant = (readDB().interactions || []).find((row: any) => row.requestId === requestId && row.role === 'assistant');
    expect(assistant?.message).toContain('共有 6 个文件');
    const route = events.find(item => item.event === 'agent:tool_route' && item.payload?.toolNames?.includes('knowledge_file_stats'));
    expect(route?.payload.toolNames).toEqual(expect.arrayContaining(['knowledge_file_stats']));
    expect(route?.payload.toolNames).not.toContain('client_action');
    expect(modelCalls.at(-1)).toEqual(expect.arrayContaining(['knowledge_file_stats']));
  });

  it('keeps an actual inventory failure blocked through model guard recovery and durable feedback', async () => {
    const tool = toolRegistry.get('knowledge_file_stats');
    if (!tool) throw new Error('Knowledge tool missing');
    const failure = vi.spyOn(tool, 'handler').mockRejectedValue(new Error('Synthetic inventory read failed'));
    try {
      const { requestId, response } = await query('查询知识库文件列表');
      expect(failure).toHaveBeenCalled();
      expect(response).toMatchObject({ finalized: true, blocked: true, completionFeedback: { status: 'blocked' } });
      expect(response.text).not.toContain('共有 6 个文件');
      const turn = (readDB().conversationActionTurns || []).find((row: any) => row.requestId === requestId);
      expect((readDB().conversationActionTasks || []).find((row: any) => row.id === turn?.taskId)?.status).toBe('blocked');
    } finally { failure.mockRestore(); }
  });
});
