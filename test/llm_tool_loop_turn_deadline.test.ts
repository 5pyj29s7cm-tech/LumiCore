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
import { encodeToolResult } from '../server/tools/result_envelope';
import { ToolRegistry } from '../server/tools/registry';

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
  // Reset queued one-shot implementations as well as call history. If a
  // cancellation/deadline test exits before consuming its last mocked model
  // response, clearAllMocks would leak that response into the next case.
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bounded cumulative model-wait lifecycle', () => {
  it('returns a verified checkpoint when the model never settles after a completed tool', async () => {
    const { registry, verified } = deadlineRegistry();
    mocks.makeLLMCallStreaming
      .mockResolvedValueOnce({
        text: '先读取已知上下文',
        toolCalls: [{ id: 'context-1', name: 'verified_context', arguments: {} }],
        usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
      })
      .mockImplementationOnce(() => new Promise<never>(() => {}));

    const startedAt = Date.now();
    const result = await runWithTools(
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

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(verified).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].terminalVerification?.status).toBe('verified');
    expect(result.usageRecords).toEqual([
      expect.objectContaining({ provider: 'deepseek', model: 'test-model', totalTokens: 16 }),
    ]);
    expect(result.text).toContain('青穹跟进：目标是完成客户回访');
    expect(result.text).toContain('当前进度与回执仍可用于继续');
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

  it('clips every model attempt to the remaining policy-configured model budget', async () => {
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
        expect(config.attemptTimeouts.absoluteMs).toBe(50);
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
