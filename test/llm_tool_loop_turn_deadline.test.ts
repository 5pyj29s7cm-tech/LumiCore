import os from 'node:os';
import path from 'node:path';
import { resolveAcceptedTaskTarget } from '../server/conversation/task_target_anchor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeLLMCallStreaming: vi.fn(),
}));

vi.mock('../server/llm/providers', async () => {
  const actual = await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers');
  return {
    ...actual,
    makeLLMCallStreaming: mocks.makeLLMCallStreaming,
  };
});

import { runWithTools } from '../server/llm/adapter';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { resolveModelAttemptTimeouts } from '../server/llm/providers';
import { createModelTurnState } from '../server/llm/model_turn_state';
import { encodeToolResult } from '../server/tools/result_envelope';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { buildIterationLimitSummary } from '../server/llm/tool_loop/summaries';
import { buildVerifiedToolCheckpoint } from '../server/llm/tool_loop/checkpoints';
import { withCloudResilience } from '../server/cloud/resilience';
import { getCircuitStatus, resetCircuit } from '../server/cloud/circuit_breaker';

const getters = [
  () => null,
  () => null,
  () => null,
  () => null,
  () => null,
] as const;

function deadlineRegistry(verifiedDelayMs = 0) {
  const registry = new ToolRegistry();
  const verified = vi.fn(async () => {
    if (verifiedDelayMs > 0) await new Promise(resolve => setTimeout(resolve, verifiedDelayMs));
    return encodeToolResult('青穹跟进：目标是完成客户回访；当前已核验联系人记录；下一步确认发送时间。', {
      ok: true,
      status: 'verified',
      verified: true,
    });
  });
  const late = vi.fn(async () => encodeToolResult('late mutation must not run', {
    ok: true,
    status: 'verified',
    verified: true,
  }));
  for (const [name, handler] of [['verified_context', verified], ['late_tool', late]] as const) {
    registry.register({
      name,
      description: `Deadline test capability ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'public',
      securityLevel: 'safe',
      capability: {
        id: `test.${name}`,
        family: 'test',
        lane: 'system',
        operation: 'observe',
        risk: 'none',
        sideEffects: [{ type: 'local_read', scope: 'test state', reversible: true }],
        verification: {
          strategy: 'state_diff',
          required: true,
          requiredFields: ['ok'],
          requiredValues: { ok: true },
          successSignals: ['verified state'],
          limitations: [],
        },
      },
      handler,
    });
  }
  return { registry, verified, late };
}

beforeEach(() => {
  resetCircuit();
  // Reset queued one-shot implementations as well as call history. If a
  // cancellation/deadline test exits before consuming its last mocked model
  // response, clearAllMocks would leak that response into the next case.
  vi.resetAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bounded cumulative model-wait lifecycle', () => {
  it.each([false, true])('preserves source reads through preflights with late task binding=%s', async lateBinding => {
    const desktop = path.join(os.homedir(), 'Desktop');
    const sources = ['LOOP-SOURCE-A.docx', 'LOOP-SOURCE-B.docx'].map(name => path.join(desktop, name));
    const task = '把桌面的“LOOP-SOURCE-A.docx”和“LOOP-SOURCE-B.docx”合并成“LOOP-OUTPUT.docx”，保留两份文件全部正文。';
    const read = vi.fn(async (args: any) => encodeToolResult('fixture body for ' + args.filePath, { ok: true, status: 'verified', verified: true }));
    const registry = new ToolRegistry();
    registry.register({ name: 'read_docx', description: 'Read a source document', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] }, permission: 'public', securityLevel: 'safe', handler: read });
    mocks.makeLLMCallStreaming.mockResolvedValueOnce({ text: '', toolCalls: sources.map((filePath, index) => ({ id: 'loop-source-' + index, name: 'read_docx', arguments: { filePath } })) })
      .mockResolvedValue({ text: 'Source retrieval only; output is still pending.', toolCalls: null });
    const result = await runWithTools([{ role: 'user', content: task }], registry, { provider: 'deepseek', model: 'test-model' }, () => {}, 2, ...getters, () => {},
      { userId: 'source-preflight-fixture', requestId: 'source-preflight-request', taskId: lateBinding ? undefined : 'source-preflight-task', prepareSelectedToolCall: async () => ({ taskId: 'source-preflight-task', turnRowId: 'source-preflight-row' }), authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local', actionIntent: task, routedTaskText: task, acceptedTaskTarget: resolveAcceptedTaskTarget({ text: task }) });
    expect(read.mock.calls.map(call => call[0].filePath)).toEqual(sources);
    expect(result.toolCalls.filter(call => call.name === 'read_docx')).toHaveLength(2);
    expect(result.toolCalls.filter(call => call.name === 'read_docx').every(call => !call.error && call.requestId === 'source-preflight-request' && call.taskId === 'source-preflight-task')).toBe(true);
  });

  it.each([
    'Create D:/work/meeting.docx with a meeting agenda.',
    '水杯数量改成4，其余不变，更新刚才生成的 Excel，保存后回读告诉我结果。',
    'Explain a mathematical theorem.',
  ])('preserves provider deadlines across task wording: %s', async task => {
    vi.useFakeTimers();
    const { registry, verified, late } = deadlineRegistry();
    for (const attemptTimeouts of [undefined, { semanticContentMs: 90_000 }, { semanticContentMs: 90_000, absoluteMs: 100_000 }]) {
      let attemptConfig: any;
      mocks.makeLLMCallStreaming.mockImplementationOnce((_messages, _tools, config) => {
        attemptConfig = config;
        return new Promise((_resolve, reject) => setTimeout(() => reject(new Error('provider-only stop')), 30_000));
      });
      const pending = runWithTools([{ role: 'user', content: task }], registry, {
        provider: 'relay', model: 'primary', selectionMode: 'ordered_fallback',
        fallbackCandidates: [{ provider: 'relay', model: 'backup' }], attemptTimeouts,
      }, undefined, 1, ...getters, () => {});
      const assertion = expect(pending).rejects.toThrow('provider-only stop');
      await vi.advanceTimersByTimeAsync(25_001);
      expect(attemptConfig.attemptTimeouts).toEqual(resolveModelAttemptTimeouts({
        ...attemptTimeouts, semanticContentMs: attemptTimeouts?.semanticContentMs ?? Infinity,
        absoluteMs: attemptTimeouts?.absoluteMs ?? Infinity,
      }));
      expect(attemptConfig.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(4_999);
      await assertion;
    }
    expect(verified).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
  });

  it('continues independent reads after one missing source in the same planned batch', async () => {
    const registry = new ToolRegistry();
    const sources = ['missing-notes.docx', 'available-notes.docx'].map(name => path.join(os.homedir(), 'Desktop', name));
    const read = vi.fn(async (args: any) => {
      if (args.filePath === sources[0]) throw new Error('DOCX file not found: ' + sources[0]);
      return encodeToolResult('The available document body.', { ok: true, status: 'verified', verified: true });
    });
    registry.register({ name: 'read_docx', description: 'Read the exact document',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
      permission: 'public', securityLevel: 'safe', handler: read });
    mocks.makeLLMCallStreaming.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'missing-first', name: 'read_docx', arguments: { filePath: sources[0] } },
      { id: 'available-second', name: 'read_docx', arguments: { filePath: sources[1] } },
    ] }).mockResolvedValueOnce({ text: 'The available document body. The other input was not found.', toolCalls: null });
    const task = '请读取桌面的“missing-notes.docx”和“available-notes.docx”，把两份完整正文分别发到聊天。只读，不创建或修改文件。';
    const result = await runWithTools([{ role: 'user', content: task }], registry,
      { provider: 'deepseek', model: 'test-model' }, undefined, 3, ...getters, () => {});
    expect(read.mock.calls.map(call => call[0].filePath)).toEqual(sources);
    expect(result.toolCalls.find(call => call.id === 'available-second')).toMatchObject({ adapterStarted: true });
    expect(result.toolCalls.find(call => call.id === 'available-second')?.error).toBeUndefined();
  });

  it('allows an isolated calculation after a missing input without running an ungrounded writer', async () => {
    const registry = new ToolRegistry();
    const read = vi.fn(async () => { throw new Error('DOCX file not found: D:/missing-report.docx'); });
    const write = vi.fn(async () => encodeToolResult('invented report', { ok: true, status: 'verified', verified: true }));
    const calculate = vi.fn(async (args: any) => encodeToolResult(String(args.input.reduce((sum: number, value: number) => sum + value, 0)), { ok: true, status: 'verified', verified: true }));
    registry.register({ name: 'read_docx', description: 'Read source document', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] }, permission: 'public', securityLevel: 'safe', handler: read });
    registry.register({ name: 'create_docx', description: 'Create an output document', parameters: { type: 'object', properties: { outputPath: { type: 'string' }, content: { type: 'string' } }, required: ['outputPath', 'content'] }, permission: 'public', securityLevel: 'safe',
      capability: { operation: 'create', sideEffects: [{ type: 'local_write', scope: 'requested output file', reversible: true }] }, handler: write });
    registry.register({ name: 'code_execution', description: 'Evaluate an isolated calculation', parameters: { type: 'object', properties: { code: { type: 'string' }, input: { type: 'array', items: { type: 'number' } } }, required: ['code', 'input'] }, permission: 'public', securityLevel: 'safe',
      capability: { id: 'code.javascript.sandbox.execute', source: 'builtin', operation: 'test', sideEffects: [{ type: 'local_state_change', scope: 'isolated calculation runtime', reversible: true }] }, handler: calculate });
    const counts = [12, 5];
    mocks.makeLLMCallStreaming.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'missing-source', name: 'read_docx', arguments: { filePath: 'D:/missing-report.docx' } },
      { id: 'dependent-write', name: 'create_docx', arguments: { outputPath: 'D:/summary.docx', content: 'Invented contents without the source.' } },
      { id: 'independent-calculation', name: 'code_execution', arguments: { code: 'input.reduce((sum, value) => sum + value, 0)', input: counts } },
    ] }).mockResolvedValueOnce({ text: 'The arithmetic is available; the report source is missing.', toolCalls: null });
    const task = '请读取“D:/missing-report.docx”，根据其完整正文生成“D:/summary.docx”；另外根据前文数据求和。';
    const result = await runWithTools([{ role: 'user', content: task }], registry,
      { provider: 'deepseek', model: 'test-model' }, undefined, 3, ...getters, () => {});
    expect(read).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(calculate).toHaveBeenCalledOnce();
    expect(result.toolCalls.find(call => call.id === 'dependent-write')?.adapterStarted).not.toBe(true);
    expect(result.toolCalls.find(call => call.id === 'dependent-write')?.terminalVerification?.status).toBe('failed');
    expect(result.toolCalls.find(call => call.id === 'dependent-write')?.error).toMatch(/required input file/iu);
    expect(result.toolCalls.find(call => call.id === 'independent-calculation')).toMatchObject({ adapterStarted: true });
    expect(result.toolCalls.find(call => call.id === 'independent-calculation')?.error).toBeUndefined();
    const finalized = finalizeLumiResponse({ source: 'chat', taskText: task, responseText: 'The source-based document is completed.', toolRecords: result.toolCalls });
    expect(finalized.blocked).toBe(true);
    expect(finalized.text).not.toContain('document is completed');
  });

  it('retains a completed contextual calculation through the tool loop and finalizer when a separate read is missing', async () => {
    const registry = new ToolRegistry();
    const missingName = 'inventory-log.docx';
    const missingPath = path.join(os.homedir(), 'Desktop', missingName);
    const read = vi.fn(async () => { throw new Error('DOCX file not found: ' + missingPath); });
    registry.register({ name: 'read_docx', description: 'Read the exact document',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
      permission: 'public', securityLevel: 'safe', handler: read });
    const values = [11, 4];
    const arithmetic = values.join(' + ') + ' = ' + values.reduce((sum, value) => sum + value, 0);
    const task = '先根据刚才已读出的数量，计算两组备件的合计；再读取桌面的“' + missingName + '”，把完整正文发到聊天。分别说明两件事的结果。不重新读取前两份文件，不创建或修改文件。';
    const modelReply = '数量合计的计算已完成：' + arithmetic + '。没有在桌面找到“' + missingName + '”，第二项无法读取；请上传文件或提供完整路径。';
    mocks.makeLLMCallStreaming.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'independent-read-missing', name: 'read_docx', arguments: { filePath: missingPath } },
    ] }).mockResolvedValueOnce({ text: modelReply, toolCalls: null });
    const context = { userId: 'partial-context-user', requestId: 'partial-context-turn', taskId: 'partial-context-task',
      authenticated: true, authRole: 'admin' as const, localExecution: true, executionBoundary: 'trusted_local' as const,
      actionIntent: task, routedTaskText: task, acceptedTaskTarget: resolveAcceptedTaskTarget({ text: task }) };
    const result = await runWithTools([
      { role: 'assistant', content: '上一份材料：备件 ' + values[0] + ' 个。另一份材料：备件 ' + values[1] + ' 个。' },
      { role: 'user', content: task },
    ], registry, { provider: 'deepseek', model: 'test-model' }, undefined, 3, ...getters, () => {}, context);
    expect(result.text).toContain(arithmetic);
    expect(result.text).toContain(missingName);
    const finalized = finalizeLumiResponse({ source: 'chat', taskText: task, responseText: result.text,
      toolRecords: result.toolCalls, requestId: context.requestId, taskId: context.taskId });
    expect(finalized.text).toContain(arithmetic);
    expect(finalized.text).toContain(missingName);
    expect(finalized.blocked).toBe(true);
    expect(finalized.reason).toBe('required_input_file_missing');
    expect(read).toHaveBeenCalledOnce();
    expect(result.toolCalls).toHaveLength(1);
    expect(mocks.makeLLMCallStreaming).toHaveBeenCalledTimes(2);
  });

  it('blocks a queued side effect but lets the model explain the missing source and permits a new attempt', async () => {
    const { registry, late } = deadlineRegistry();
    registry.get('late_tool')!.capability = { ...registry.get('late_tool')!.capability,
      operation: 'mutate', sideEffects: [{ type: 'local_write', scope: 'dependent output', reversible: true }] };
    const read = vi.fn().mockRejectedValueOnce(new Error('XLSX file not found: D:/orders.xlsx'))
      .mockResolvedValueOnce(encodeToolResult('source supplied', { ok: true, status: 'verified', verified: true }));
    registry.register({ name: 'read_xlsx', description: 'Read the source workbook',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
      permission: 'public', securityLevel: 'safe', handler: read });
    const call = { id: 'required-source', name: 'read_xlsx', arguments: { filePath: 'D:/orders.xlsx' } };
    const explanation = '没有找到 D:/orders.xlsx。请在文件管理器中确认源表的位置，把实际完整路径发给我，确认后再继续处理。';
    mocks.makeLLMCallStreaming.mockResolvedValueOnce({ text: '', toolCalls: [call, { id: 'late-write', name: 'late_tool', arguments: {} }] })
      .mockImplementationOnce(async modelMessages => {
        const returned = JSON.stringify(modelMessages);
        expect(returned).toContain('D:/orders.xlsx');
        expect(returned).toContain('XLSX file not found');
        expect(returned).toContain('late-write');
        expect(returned).toMatch(/not executed/iu);
        return { text: explanation, toolCalls: null };
      });
    const messages = [{ role: 'user' as const, content: '把 D:/orders.xlsx 数量改成4，另存为 D:/result.xlsx。' }];
    const config = { provider: 'deepseek', model: 'test-model' };
    const result = await runWithTools(messages, registry, config, undefined, 5, ...getters, () => {});
    expect(result.text).toBe(explanation);
    const finalized = finalizeLumiResponse({ source: 'chat', taskText: messages[0].content, responseText: result.text, toolRecords: result.toolCalls });
    expect(finalized).toMatchObject({ text: explanation, blocked: true, reason: 'required_input_file_missing' });
    expect(read).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
    expect(mocks.makeLLMCallStreaming).toHaveBeenCalledTimes(2);
    mocks.makeLLMCallStreaming.mockResolvedValueOnce({ text: '', toolCalls: [{ ...call, id: 'new-read' }] })
      .mockResolvedValueOnce({ text: 'Source available, still needs saving.', toolCalls: null });
    const next = await runWithTools(messages, registry, config, undefined, 2, ...getters, () => {},
      { priorToolRecords: result.toolCalls });
    expect(read).toHaveBeenCalledTimes(2);
    expect(next.completionGuard?.reason).not.toBe('required_input_file_missing');
  });

  it('does not grant a fresh model-wait budget to a second recovery loop', async () => {
    vi.useFakeTimers();
    const { registry } = deadlineRegistry();
    const state = createModelTurnState();
    const config = { provider: 'deepseek', model: 'test-model', modelWaitBudgetMs: 40, modelTurnState: state };
    mocks.makeLLMCallStreaming
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ text: 'Known context.', toolCalls: null }), 30)))
      .mockImplementationOnce(() => new Promise(() => {}));
    const first = runWithTools([{ role: 'user', content: 'Explain the context.' }], registry, config, undefined, 1, ...getters, () => {});
    await vi.advanceTimersByTimeAsync(30);
    await first;
    expect(state.modelWaitMs).toBe(30);
    const recovery = runWithTools([{ role: 'user', content: 'Explain the context.' }], registry, config, undefined, 1, ...getters, () => {});
    const assertion = expect(recovery).rejects.toMatchObject({ name: 'ToolLoopModelBudgetError' });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(state.modelWaitMs).toBe(40);
    const exhausted = runWithTools([{ role: 'user', content: 'Explain the context.' }], registry, config, undefined, 1, ...getters, () => {});
    await expect(exhausted).rejects.toMatchObject({ name: 'ToolLoopModelBudgetError' });
    expect(mocks.makeLLMCallStreaming).toHaveBeenCalledTimes(2);
  });
  it('does not disable local inference when only the parent turn budget expires', async () => {
    vi.useFakeTimers();
    const { registry } = deadlineRegistry();
    mocks.makeLLMCallStreaming.mockImplementation((_messages, _tools, config) => withCloudResilience(
      () => new Promise(() => {}),
      { provider: 'lmstudio', model: 'test-local', maxRetries: 0,
        signal: config.signal, timeoutMs: config.attemptTimeouts.absoluteMs },
    ));
    const pending = runWithTools([{ role: 'user', content: 'Read current context.' }], registry,
      { provider: 'lmstudio', model: 'test-local', modelWaitBudgetMs: 797,
        attemptTimeouts: { absoluteMs: 60000 } }, undefined, 2, ...getters, () => {});
    const assertion = expect(pending).rejects.toMatchObject({ name: 'ToolLoopModelBudgetError' });
    await vi.advanceTimersByTimeAsync(800);
    await assertion;
    expect(getCircuitStatus().filter(row => row.key.startsWith('lmstudio'))).toEqual([]);
  });
  it('returns a verified checkpoint when the model never settles after a completed tool', async () => {
    vi.useFakeTimers();
    let modelStalled!: () => void;
    const stalled = new Promise<void>(resolve => { modelStalled = resolve; });
    const { registry, verified } = deadlineRegistry();
    mocks.makeLLMCallStreaming
      .mockResolvedValueOnce({
        text: '先读取已知上下文',
        toolCalls: [{ id: 'context-1', name: 'verified_context', arguments: {} }],
        usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
      })
      .mockImplementationOnce(() => { modelStalled(); return new Promise<never>(() => {}); });

    const startedAt = Date.now();
    const pending = runWithTools(
      [{ role: 'user', content: '告诉我青穹客户跟进的目标、状态和下一步。' }],
      registry,
      {
        provider: 'deepseek',
        model: 'test-model',
        modelWaitBudgetMs: 35,
        attemptTimeouts: { requestMs: 500, firstByteMs: 500, semanticContentMs: 500, idleMs: 500, absoluteMs: 500 },
      },
      undefined,
      2,
      ...getters,
      () => {},
    );

    await stalled;
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(34);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(Date.now() - startedAt).toBe(35);
    expect(verified).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].terminalVerification?.status).toBe('verified');
    expect(result.usageRecords).toEqual([
      expect.objectContaining({ provider: 'deepseek', model: 'test-model', totalTokens: 16 }),
    ]);
    expect(result.toolCalls[0].result).toContain('青穹跟进：目标是完成客户回访');
    expect(result.text).toMatch(/尚未.*完成|还没完成|未.*完成/u);
    expect(result.text).not.toMatch(/verified_context|test\.verified_context|execution_/u);
  });

  it('aborts the turn and quarantines late chunks and tool calls after cancellation', async () => {
    const { registry, late } = deadlineRegistry();
    let cancelled = false;
    const visibleChunks: string[] = [];
    mocks.makeLLMCallStreaming
      .mockResolvedValueOnce({
        text: '先读取上下文',
        toolCalls: [{ id: 'context-1', name: 'verified_context', arguments: {} }],
      })
      .mockImplementationOnce((_messages, _tools, _config, onChunk) => new Promise(resolve => {
        setTimeout(() => { cancelled = true; }, 8);
        setTimeout(() => {
          onChunk('late text that must stay invisible');
          resolve({
            text: 'late response',
            toolCalls: [{ id: 'late-1', name: 'late_tool', arguments: {} }],
          });
        }, 45);
      }));

    const result = await runWithTools(
      [{ role: 'user', content: '读取上下文，然后继续处理。' }],
      registry,
      {
        provider: 'deepseek',
        model: 'test-model',
        // This case verifies cancellation quarantine, not budget expiry. Keep
        // enough wall-clock headroom for a heavily parallel full-suite run.
        modelWaitBudgetMs: 5_000,
      },
      undefined,
      3,
      ...getters,
      chunk => visibleChunks.push(chunk),
      { isCancelled: () => cancelled },
    );

    expect(result.text).toMatch(/cancelled/i);
    await new Promise(resolve => setTimeout(resolve, 70));
    expect(visibleChunks).toEqual([]);
    expect(late).not.toHaveBeenCalled();
  });

  it('keeps provider health deadlines separate from the remaining turn budget', async () => {
    const { registry } = deadlineRegistry();
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mocks.makeLLMCallStreaming
      .mockImplementationOnce(async (_messages, _tools, config) => {
        expect(config.attemptTimeouts.absoluteMs).toBe(90);
        now += 40;
        return {
          text: '读取',
          toolCalls: [{ id: 'context-1', name: 'verified_context', arguments: {} }],
        };
      })
      .mockImplementationOnce(async (_messages, _tools, config) => {
        expect(config.attemptTimeouts.absoluteMs).toBe(90);
        return { text: '已根据核验结果整理完成。', toolCalls: null };
      });

    const result = await runWithTools(
      [{ role: 'user', content: '整理当前信息。' }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      2,
      ...getters,
      () => {},
      {
        toolPolicy: {
          allowedTools: ['*'],
          requireConfirmation: [],
          forbiddenTools: [],
          maxIterations: 2,
          modelAttemptTimeoutMs: 90,
          modelWaitBudgetMs: 90,
        },
      },
    );

    expect(result.text).toContain('整理完成');
  });

  it('does not charge a canonical long-running tool against the model-wait budget', async () => {
    const { registry, verified } = deadlineRegistry(55);
    const seenAttemptBudgets: number[] = [];
    mocks.makeLLMCallStreaming
      .mockImplementationOnce(async (_messages, _tools, config) => {
        seenAttemptBudgets.push(config.attemptTimeouts.absoluteMs);
        return {
          text: '读取长期任务结果',
          toolCalls: [{ id: 'slow-context-1', name: 'verified_context', arguments: {} }],
        };
      })
      .mockImplementationOnce(async (_messages, _tools, config) => {
        seenAttemptBudgets.push(config.attemptTimeouts.absoluteMs);
        return { text: '长期工具的核验回执已经整理完成。', toolCalls: null };
      });

    const startedAt = Date.now();
    const result = await runWithTools(
      [{ role: 'user', content: '执行这个需要较长时间的工具，并在结束后整理结果。' }],
      registry,
      {
        provider: 'deepseek',
        model: 'test-model',
        modelWaitBudgetMs: 25,
        attemptTimeouts: { requestMs: 200, firstByteMs: 200, semanticContentMs: 200, idleMs: 200, absoluteMs: 200 },
      },
      undefined,
      2,
      ...getters,
      () => {},
    );

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45);
    expect(verified).toHaveBeenCalledTimes(1);
    expect(result.toolCalls[0].terminalVerification?.status).toBe('verified');
    expect(result.text).toContain('长期工具的核验回执已经整理完成');
    expect(seenAttemptBudgets).toHaveLength(2);
    expect(seenAttemptBudgets[1]).toBeGreaterThan(0);
  });
});


describe('read-only source projection at incomplete tool-loop boundaries', () => {
  const first = path.resolve('D:/synthetic/read-boundary/source-one.docx');
  const second = path.resolve('D:/synthetic/read-boundary/source-two.docx');
  const other = path.resolve('D:/synthetic/read-boundary/unrequested.docx');
  const task = '读取文件 ' + first + ' 和 ' + second + '，分别展示完整正文。';
  const context = { authenticated: true, authRole: 'admin', userId: 'read-boundary-user', requestId: 'read-boundary-request',
    taskId: 'read-boundary-task', localExecution: true, executionBoundary: 'trusted_local', currentTurnExecutionRequested: true,
    actionIntent: task, routedTaskText: task } as any;
  async function canonicalRead(filePath: string, content: string, options: { name?: string; fail?: boolean; metadata?: boolean; scope?: any } = {}) {
    const registry = new ToolRegistry();
    const name = options.name || 'read_docx';
    registry.register({ name, description: 'Isolated source projection fixture', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
      permission: 'public', securityLevel: 'safe', capability: { id: 'test.read.boundary', family: 'file', lane: 'system', operation: 'observe', risk: 'none',
        sideEffects: [{ type: 'local_read', scope: 'synthetic fixture', reversible: true }], verification: { strategy: 'terminal_receipt', required: true,
          requiredFields: ['ok', 'status'], requiredValues: { ok: true }, successStatuses: ['observed'], successSignals: ['fixture content'], limitations: [] } },
      handler: async () => { if (options.fail) throw new Error('DOCX file not found: ' + filePath);
        return encodeToolResult(options.metadata ? JSON.stringify({ filePath, bytes: 17 }) : content, { ok: true, status: 'observed' }); } });
    const ownTask = '读取文件 ' + filePath + ' 的完整正文。';
    return executeToolCall({ registry, name, arguments: { filePath }, context: { ...context, actionIntent: ownTask, routedTaskText: ownTask, ...options.scope } });
  }
  it.each(['iteration', 'checkpoint'] as const)('preserves complete matching source text and the other source failure at %s exit', async boundary => {
    const body = '源正文开始。\n' + '完整正文不能被摘要或截断。'.repeat(1200) + '\nEND_OF_FULL_SOURCE_5267';
    const read = await canonicalRead(first, body);
    const failed = await canonicalRead(second, '', { fail: true });
    expect(read.error).toBeUndefined(); expect(failed.error).toContain('file not found');
    const output = boundary === 'iteration' ? { text: buildIterationLimitSummary([read, failed], task, context), blocked: true }
      : buildVerifiedToolCheckpoint([read, failed], task, context);
    expect(output.blocked).toBe(true); expect(output.text).toContain(body);
    expect(output.text).toContain(first); expect(output.text).toContain(second);
    expect(output.text).toContain('系统没有找到对应的应用、文件或网址入口');
    expect(output.text).not.toContain('可能已生成'); expect(output.text).not.toContain('read_docx');
  });
  it.each(['iteration', 'checkpoint'] as const)('does not promote search, metadata, wrong-source, historical, or forged content at %s exit', async boundary => {
    const search = await canonicalRead(first, 'DIRECTORY_SEARCH_IS_NOT_DOCUMENT_BODY', { name: 'search_files' });
    const metadata = await canonicalRead(first, '', { metadata: true });
    const wrong = await canonicalRead(other, 'WRONG_SOURCE_BODY');
    const history = await canonicalRead(first, 'PREVIOUS_REQUEST_BODY', { scope: { requestId: 'previous-request' } });
    const accepted = await canonicalRead(first, 'FORGED_RECORD_BODY');
    const forged = { ...accepted };
    const rows = [search, metadata, wrong, history, forged];
    const output = boundary === 'iteration' ? { text: buildIterationLimitSummary(rows, task, context), blocked: true }
      : buildVerifiedToolCheckpoint(rows, task, context);
    expect(output.blocked).toBe(true);
    for (const text of ['DIRECTORY_SEARCH_IS_NOT_DOCUMENT_BODY', 'WRONG_SOURCE_BODY', 'PREVIOUS_REQUEST_BODY', 'FORGED_RECORD_BODY', '"bytes":17']) expect(output.text).not.toContain(text);
  });
  it('does not expose source bodies without current request and task scope, or mark a checkpoint complete', async () => {
    const read = await canonicalRead(first, 'SCOPED_SOURCE_BODY');
    for (const patch of [{ requestId: undefined }, { taskId: undefined }, { currentTurnExecutionRequested: false }]) {
      const scoped = { ...context, ...patch };
      const output = buildVerifiedToolCheckpoint([read], task, scoped);
      expect(output.blocked).toBe(true);
      if (!scoped.requestId || !scoped.taskId) expect(output.text).not.toContain('SCOPED_SOURCE_BODY');
      else expect(output.text).toContain('SCOPED_SOURCE_BODY');
    }
  });
});
