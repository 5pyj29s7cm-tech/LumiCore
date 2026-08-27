import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeLLMCall: vi.fn(),
}));

vi.mock('../server/llm/providers', async () => {
  const actual = await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers');
  return { ...actual, makeLLMCall: mocks.makeLLMCall };
});

import { buildDeterministicExplicitToolRecoveryCall } from '../server/cognition/deterministic_tool_recovery';
import { runWithTools } from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';

const getters = [
  () => null,
  () => null,
  () => null,
  () => null,
  () => null,
] as const;

function exactWriteTask(path: string, content: string): string {
  return `Create the formal confirmation-gated file ${path} with exact content ${content}. Call write_file, but stop at the confirmation boundary and do not self-confirm.`;
}

function registerConfirmationWrite(registry: ToolRegistry, handler: () => Promise<string>) {
  registry.register({
    name: 'write_file',
    description: 'Write exact text to one file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    permission: 'user',
    securityLevel: 'confirm',
    handler,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.makeLLMCall.mockResolvedValue({ text: 'I will continue with the file request.' });
});

describe('deterministic missing-tool recovery', () => {
  it('parses one explicit absolute path and exact content without executing it', () => {
    const target = 'C:\\Users\\ExampleUser\\LumiCore\\confirmation.txt';
    expect(buildDeterministicExplicitToolRecoveryCall(exactWriteTask(target, 'receipt-51fe050f'), ['write_file']))
      .toEqual({
        name: 'write_file',
        arguments: { path: target, content: 'receipt-51fe050f' },
        reason: 'explicit_exact_text_write',
      });
  });

  it('routes a second zero-tool response through the canonical confirmation gate', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => 'must not execute before confirmation');
    const requestConfirmation = vi.fn(async () => false);
    const onToolStart = vi.fn();
    registerConfirmationWrite(registry, handler);
    const target = 'C:\\Users\\ExampleUser\\LumiCore\\confirmation.txt';
    const task = exactWriteTask(target, 'receipt-51fe050f');

    const result = await runWithTools(
      [{ role: 'user', content: task }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      2,
      ...getters,
      undefined,
      {
        userId: 'user-1',
        authenticated: true,
        taskId: 'task-recovery-1',
        requestId: 'request-recovery-1',
        source: 'chat',
        actionIntent: task,
        routedTaskText: task,
        requestConfirmation,
        onToolStart,
        toolPolicy: {
          allowedTools: ['write_file'],
          requireConfirmation: ['write_file'],
          forbiddenTools: [],
          maxIterations: 2,
        },
        modelToolProjection: {
          toolNames: ['write_file'],
          maxTools: 1,
          allowDynamicDiscovery: false,
        },
      },
    );

    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(2);
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(requestConfirmation).toHaveBeenCalledWith('write_file', {
      path: target,
      content: 'receipt-51fe050f',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(onToolStart).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      taskId: 'task-recovery-1',
      requestId: 'request-recovery-1',
      name: 'write_file',
      arguments: { path: target, content: 'receipt-51fe050f' },
      executionOrigin: 'deterministic_route',
    });
  });

  it('fails closed when path or exact content is ambiguous', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => 'must not execute');
    const requestConfirmation = vi.fn(async () => false);
    registerConfirmationWrite(registry, handler);
    const task = 'Create C:\\Temp\\one.txt and C:\\Temp\\two.txt with exact content first with exact content second. Call write_file.';

    expect(buildDeterministicExplicitToolRecoveryCall(task, ['write_file'])).toBeNull();
    const result = await runWithTools(
      [{ role: 'user', content: task }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      2,
      ...getters,
      undefined,
      {
        userId: 'user-1',
        authenticated: true,
        source: 'chat',
        actionIntent: task,
        routedTaskText: task,
        requestConfirmation,
        toolPolicy: {
          allowedTools: ['write_file'],
          requireConfirmation: ['write_file'],
          forbiddenTools: [],
          maxIterations: 2,
        },
        modelToolProjection: {
          toolNames: ['write_file'],
          maxTools: 1,
          allowDynamicDiscovery: false,
        },
      },
    );

    expect(result.toolCalls).toEqual([]);
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
