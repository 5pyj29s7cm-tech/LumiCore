import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeLLMCall: vi.fn(),
}));

vi.mock('../server/llm/providers', async () => {
  const actual = await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers');
  return { ...actual, makeLLMCall: mocks.makeLLMCall };
});

import {
  ToolLifecyclePersistenceError,
  buildConfirmedStepContinuationMessages,
  runWithTools,
} from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';
import { encodeToolResult } from '../server/tools/result_envelope';
import type { ToolExecutionRecord } from '../server/tools/types';

const getters = [
  () => null,
  () => null,
  () => null,
  () => null,
  () => null,
] as const;

function registerObservedTool(
  registry: ToolRegistry,
  name: string,
  handler: () => Promise<string>,
): void {
  registry.register({
    name,
    description: `Durable lifecycle test capability ${name}`,
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
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok'],
        requiredValues: { ok: true },
        successStatuses: ['verified'],
        successSignals: ['verified test state'],
        limitations: [],
      },
    },
    handler,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('durable adapter terminal lifecycle', () => {
  it('delivers one real late terminal after caller abort and never resumes the model loop', async () => {
    const registry = new ToolRegistry();
    let releaseHandler!: () => void;
    let handlerEntered!: () => void;
    const entered = new Promise<void>(resolve => { handlerEntered = resolve; });
    const handler = vi.fn(async () => {
      handlerEntered();
      await new Promise<void>(resolve => { releaseHandler = resolve; });
      return encodeToolResult('late handler result', {
        ok: true,
        status: 'verified',
        verified: true,
      });
    });
    registerObservedTool(registry, 'late_terminal_probe', handler);
    mocks.makeLLMCall.mockResolvedValueOnce({
      text: 'run the probe',
      toolCalls: [{ id: 'late-terminal-1', name: 'late_terminal_probe', arguments: {} }],
    });

    const controller = new AbortController();
    const durable = new Map<string, unknown>();
    const terminalObserver = vi.fn(async (record: ToolExecutionRecord) => {
      durable.set(String(record.id), record);
    });
    let settled = false;
    const execution = runWithTools(
      [{ role: 'user', content: 'Run the delayed probe once.' }],
      registry,
      { provider: 'deepseek', model: 'lifecycle-test', signal: controller.signal },
      terminalObserver,
      2,
      ...getters,
      undefined,
      {
        onAdapterStart: async () => {
          durable.set('late-terminal-1', { status: 'unknown_outcome' });
        },
      },
    ).finally(() => { settled = true; });

    await entered;
    expect(durable.get('late-terminal-1')).toEqual({ status: 'unknown_outcome' });
    controller.abort(new Error('caller deadline elapsed'));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(terminalObserver).not.toHaveBeenCalled();

    releaseHandler();
    const result = await execution;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(terminalObserver).toHaveBeenCalledTimes(1);
    expect(durable.get('late-terminal-1')).toMatchObject({
      id: 'late-terminal-1',
      adapterStarted: true,
      result: 'late handler result',
      terminalVerification: { status: 'verified' },
    });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ id: 'late-terminal-1', result: 'late handler result' }),
    ]);
    expect(result.text).toMatch(/cancelled/i);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(1);
  });

  it('rethrows a terminal observer failure from the bounded verification continuation', async () => {
    const registry = new ToolRegistry();
    const target = 'C:\\Users\\me\\Desktop\\durable-continuation.txt';
    const readback = vi.fn(async () => encodeToolResult('durable exact content', {
      ok: true,
      status: 'verified',
      verified: true,
    }));
    registerObservedTool(registry, 'read_file', readback);
    const confirmedRecord: ToolExecutionRecord = {
      id: 'confirmed-write-before-provider-failure',
      name: 'desktop_write_text_file',
      arguments: { path: target, content: 'durable exact content' },
      result: JSON.stringify({
        ok: true,
        status: 'verified',
        path: target,
        bytesWritten: 21,
        readBackMatched: true,
      }),
      receipt: {
        ok: true,
        status: 'verified',
        path: target,
        bytesWritten: 21,
        readBackMatched: true,
      },
      capability: {
        capabilityId: 'desktop.files.text.write',
        lane: 'files',
        operation: 'mutate',
        risk: 'high',
        sideEffects: [{ type: 'local_write', scope: 'one exact native host text-file path', reversible: false }],
        verification: {
          strategy: 'measured',
          required: true,
          requiredFields: ['path', 'bytesWritten', 'readBackMatched'],
          requiredValues: { readBackMatched: true },
          successStatuses: ['verified'],
          successSignals: ['native byte read-back matched'],
          limitations: [],
        },
      },
      terminalVerification: {
        status: 'verified',
        strategy: 'measured',
        reason: 'The exact native bytes were written and read back.',
      },
    };
    mocks.makeLLMCall
      .mockRejectedValueOnce(new Error('primary provider stopped after the confirmed mutation'))
      .mockResolvedValueOnce({
        text: 'obtain the missing independent readback',
        toolCalls: [{ id: 'continuation-readback-1', name: 'read_file', arguments: {} }],
      });
    const observer = vi.fn(async (record: ToolExecutionRecord) => {
      if (record.id === 'continuation-readback-1') {
        throw new Error('terminal checkpoint store unavailable');
      }
    });
    const task = `After writing ${target}, read the same path back and report the exact content.`;

    const error = await runWithTools(
      buildConfirmedStepContinuationMessages(task, confirmedRecord),
      registry,
      { provider: 'deepseek', model: 'lifecycle-test' },
      observer,
      1,
      ...getters,
      undefined,
      {
        source: 'chat_confirmation_resume',
        actionIntent: task,
        routedTaskText: task,
        priorToolRecords: [confirmedRecord],
      },
    ).then(() => null, reason => reason);

    expect(error).toBeInstanceOf(ToolLifecyclePersistenceError);
    expect(error).toMatchObject({
      phase: 'terminal',
      code: 'TOOL_LIFECYCLE_PERSISTENCE_FAILED',
    });
    expect(error.message).toContain('terminal checkpoint store unavailable');
    expect(readback).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(2);
  });

  it('bounds a hung terminal observer and retains the durable unknown fence', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    registerObservedTool(registry, 'hung_terminal_probe', async () => encodeToolResult(
      'handler settled before observer hang',
      { ok: true, status: 'verified', verified: true },
    ));
    mocks.makeLLMCall.mockResolvedValueOnce({
      text: 'run the probe',
      toolCalls: [{ id: 'hung-terminal-1', name: 'hung_terminal_probe', arguments: {} }],
    });

    const durable = new Map<string, unknown>();
    let observerEntered!: () => void;
    const entered = new Promise<void>(resolve => { observerEntered = resolve; });
    const terminalObserver = vi.fn(async () => {
      observerEntered();
      await new Promise<never>(() => {});
    });
    const execution = runWithTools(
      [{ role: 'user', content: 'Run one probe and persist its receipt.' }],
      registry,
      {
        provider: 'deepseek',
        model: 'lifecycle-test',
        toolLifecycleObserverTimeoutMs: 40,
      },
      terminalObserver,
      2,
      ...getters,
      undefined,
      {
        onAdapterStart: async () => {
          durable.set('hung-terminal-1', { status: 'unknown_outcome', replayAllowed: false });
        },
      },
    );
    const captured = execution.then(() => null, reason => reason);

    await entered;
    await vi.advanceTimersByTimeAsync(40);
    const error = await captured;

    expect(error).toBeInstanceOf(ToolLifecyclePersistenceError);
    expect(error).toMatchObject({
      phase: 'terminal',
      code: 'TOOL_LIFECYCLE_OBSERVER_TIMEOUT',
      timeoutMs: 40,
      quarantined: true,
    });
    expect(error.message).toContain('automatic replay is forbidden');
    expect(terminalObserver).toHaveBeenCalledTimes(1);
    expect(durable.get('hung-terminal-1')).toEqual({
      status: 'unknown_outcome',
      replayAllowed: false,
    });
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(1);
  });
});
