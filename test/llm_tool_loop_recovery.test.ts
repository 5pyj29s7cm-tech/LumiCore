import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeLLMCall: vi.fn(),
}));

vi.mock('../server/llm/providers', async () => {
  const actual = await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers');
  return {
    ...actual,
    makeLLMCall: mocks.makeLLMCall,
  };
});

import { buildConfirmedStepContinuationMessages, runWithTools } from '../server/llm/adapter';
import { encodeToolResult } from '../server/tools/result_envelope';
import { ToolRegistry } from '../server/tools/registry';
import type { ToolExecutionRecord } from '../server/tools/types';

const getters = [
  () => null,
  () => null,
  () => null,
  () => null,
  () => null,
] as const;

function registerReadOnlyProbe(
  registry: ToolRegistry,
  name: string,
  handler: () => Promise<string>,
) {
  registry.register({
    name,
    description: `Read-only recovery probe ${name}`,
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LLM tool-loop recovery and terminal truth', () => {
  it('attributes a confirmation continuation to the accepted confirmation row, not the old goal', () => {
    const messages = buildConfirmedStepContinuationMessages(
      'Delete the exact reviewed cache entry, then verify it is gone.',
      {
        id: 'confirmed-delete-1',
        name: 'delete_reviewed_cache_entry',
        arguments: { id: 'cache-entry-1' },
        result: JSON.stringify({ ok: true, status: 'verified' }),
      },
      {
        messageId: 'durable-confirmation-message-1',
        text: '确认',
      },
    );

    const userMessages = messages.filter(message => message.role === 'user');
    expect(userMessages).toEqual([
      expect.objectContaining({
        content: 'Delete the exact reviewed cache entry, then verify it is gone.',
      }),
      expect.objectContaining({
        content: '确认',
        sourceMessageId: 'durable-confirmation-message-1',
      }),
    ]);
    expect(userMessages[0]).not.toHaveProperty('sourceMessageId');
    expect(messages.filter(message => message.sourceMessageId)).toHaveLength(1);
  });

  it('reviews a confirmed receipt, blocks mutation replay, and continues only the missing verification', async () => {
    const registry = new ToolRegistry();
    const mutation = vi.fn(async () => encodeToolResult('mutation should not run twice', {
      ok: true,
      status: 'verified',
    }));
    registry.register({
      name: 'confirmed_mutation',
      description: 'State-changing operation that already ran after exact confirmation.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string' } },
        required: ['target'],
      },
      permission: 'public',
      securityLevel: 'safe',
      capability: {
        id: 'test.confirmed_mutation',
        family: 'test',
        lane: 'system',
        operation: 'mutate',
        risk: 'medium',
        sideEffects: [{ type: 'local_state_change', scope: 'test target', reversible: true }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: ['ok'],
          requiredValues: { ok: true },
          successSignals: ['mutation receipt'],
          limitations: [],
        },
      },
      handler: mutation,
    });
    const readback = vi.fn(async () => encodeToolResult('readback matches the requested value', {
      ok: true,
      status: 'verified',
      verified: true,
    }));
    registerReadOnlyProbe(registry, 'confirmation_readback', readback);

    const confirmedRecord: ToolExecutionRecord = {
      id: 'confirmed-once',
      name: 'confirmed_mutation',
      arguments: { target: 'artifact-A' },
      result: JSON.stringify({ ok: true, status: 'verified', changed: true }),
      receipt: { ok: true, status: 'verified', target: 'artifact-A' },
      capability: {
        capabilityId: 'test.confirmed_mutation',
        lane: 'system',
        operation: 'mutate',
        risk: 'medium',
        sideEffects: [{ type: 'local_state_change', scope: 'test target', reversible: true }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: ['ok'],
          requiredValues: { ok: true },
          successSignals: ['mutation receipt'],
          limitations: [],
        },
      },
      terminalVerification: {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: 'Exact confirmed mutation completed.',
      },
    };

    mocks.makeLLMCall
      .mockResolvedValueOnce({
        text: 'checking the still-missing acceptance condition',
        toolCalls: [{ id: 'readback-1', name: 'confirmation_readback', arguments: {} }],
        routingReceiptId: 'routing-confirmation-readback',
      })
      .mockResolvedValueOnce({
        text: 'trying to repeat the mutation after verification',
        toolCalls: [{ id: 'repeat-mutation', name: 'confirmed_mutation', arguments: { target: 'artifact-A' } }],
      })
      .mockResolvedValueOnce({ text: 'The mutation and its readback are both verified.' });

    const goal = 'Apply the change, then independently verify the final state.';
    const result = await runWithTools(
      [
        { role: 'system', content: 'Use receipts and tools to finish the complete request.' },
        ...buildConfirmedStepContinuationMessages(goal, confirmedRecord),
      ],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      3,
      ...getters,
      undefined,
      {
        source: 'test_confirmation_resume',
        actionIntent: goal,
        routedTaskText: goal,
        priorToolRecords: [confirmedRecord],
      },
    );

    expect(mutation).not.toHaveBeenCalled();
    expect(readback).toHaveBeenCalledTimes(1);
    expect(result.toolCalls.map(record => record.id)).toEqual(['confirmed-once', 'readback-1']);
    expect(result.toolCalls.find(record => record.id === 'readback-1'))
      .toMatchObject({ modelRoutingReceiptId: 'routing-confirmation-readback' });
    const finalModelMessages = mocks.makeLLMCall.mock.calls[2][0] as Array<{ role: string; content: string }>;
    expect(finalModelMessages.some(message => (
      message.role === 'tool'
      && message.content.includes('Duplicate confirmed side effect was not executed')
    ))).toBe(true);
    const firstModelMessages = mocks.makeLLMCall.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(firstModelMessages.some(message => (
      message.role === 'tool'
      && message.content.includes('[LUMI TERMINAL VERIFICATION]')
      && message.content.includes('Exact confirmed mutation completed.')
    ))).toBe(true);
    expect(firstModelMessages.some(message => (
      message.role === 'system'
      && message.content.includes('Judge the whole original user goal')
      && message.content.includes('Do not blindly replay')
    ))).toBe(true);
  });

  it('does not spend the confirmed side effect twice when the model repeats it before selecting readback', async () => {
    const registry = new ToolRegistry();
    const repeatedWrite = vi.fn(async () => encodeToolResult('must not execute twice', {
      ok: true,
      status: 'verified',
    }));
    registry.register({
      name: 'desktop_write_text_file',
      description: 'Write exact text to one native host file path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      permission: 'public',
      securityLevel: 'safe',
      capability: {
        id: 'desktop.files.text.write',
        family: 'desktop_files',
        lane: 'files',
        operation: 'mutate',
        risk: 'high',
        sideEffects: [{ type: 'local_write', scope: 'one exact native host text-file path', reversible: false }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: ['ok'],
          requiredValues: { ok: true },
          successSignals: ['native byte read-back matched'],
          limitations: ['Use a text reader when the result must quote the content.'],
        },
      },
      handler: repeatedWrite,
    });
    const readback = vi.fn(async () => 'confirmation continuation readback');
    registerReadOnlyProbe(registry, 'read_file', readback);

    const confirmedRecord: ToolExecutionRecord = {
      id: 'confirmed-desktop-write',
      name: 'desktop_write_text_file',
      arguments: { path: 'C:\\Users\\me\\Desktop\\note.txt', content: 'exact requested content' },
      result: JSON.stringify({ ok: true, status: 'completed', stdout: '' }),
      receipt: { ok: true, status: 'completed', stdout: '' },
      adapterStarted: true,
      capability: {
        capabilityId: 'desktop.files.text.write',
        lane: 'files',
        operation: 'mutate',
        risk: 'high',
        sideEffects: [{ type: 'local_write', scope: 'one exact native host text-file path', reversible: false }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: ['ok'],
          requiredValues: { ok: true },
          successSignals: ['native byte read-back matched'],
          limitations: ['Use a text reader when the result must quote the content.'],
        },
      },
      terminalVerification: {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: 'The native command adapter returned a structured completion receipt.',
      },
    };

    mocks.makeLLMCall
      .mockResolvedValueOnce({
        text: 'repeating the write',
        toolCalls: [{
          id: 'duplicate-write',
          name: 'desktop_write_text_file',
          arguments: { path: 'C:\\Users\\me\\Desktop\\note.txt', content: 'exact requested content' },
        }],
      })
      .mockResolvedValueOnce({
        text: 'using independent readback instead',
        toolCalls: [{ id: 'readback-after-confirmation', name: 'read_file', arguments: {} }],
      })
      .mockResolvedValueOnce({ text: 'The write and exact readback are verified.' });

    const goal = 'Write the requested file once, then read it back and report the exact contents.';
    const result = await runWithTools(
      buildConfirmedStepContinuationMessages(goal, confirmedRecord),
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      3,
      ...getters,
      undefined,
      {
        source: 'test_confirmation_resume',
        actionIntent: goal,
        routedTaskText: goal,
        priorToolRecords: [confirmedRecord],
      },
    );

    expect(repeatedWrite).not.toHaveBeenCalled();
    expect(readback).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('The write and exact readback are verified.');
    expect(result.toolCalls.map(record => record.id)).toEqual([
      'confirmed-desktop-write',
      'readback-after-confirmation',
    ]);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(3);
  });

  it('reserves a bounded verification continuation when a confirmed turn was routed with one iteration', async () => {
    const registry = new ToolRegistry();
    const target = 'C:\\Users\\me\\Desktop\\confirmed-budget.txt';
    const repeatedWrite = vi.fn(async () => 'must not execute twice');
    registry.register({
      name: 'desktop_write_text_file',
      description: 'Write exact text to one native host file path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      permission: 'public',
      securityLevel: 'safe',
      capability: {
        id: 'desktop.files.text.write',
        family: 'desktop_files',
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
      handler: repeatedWrite,
    });
    const readback = vi.fn(async () => encodeToolResult('confirmed exact content', {
      ok: true,
      status: 'verified',
    }));
    registerReadOnlyProbe(registry, 'read_file', readback);

    const confirmedRecord: ToolExecutionRecord = {
      id: 'confirmed-one-turn-write',
      name: 'desktop_write_text_file',
      arguments: { path: target, content: 'confirmed exact content' },
      result: JSON.stringify({
        ok: true,
        status: 'verified',
        path: target,
        bytesWritten: 23,
        readBackMatched: true,
      }),
      receipt: {
        ok: true,
        status: 'verified',
        path: target,
        bytesWritten: 23,
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
        reason: 'The native client wrote and read back the exact requested bytes.',
      },
    };

    mocks.makeLLMCall
      .mockResolvedValueOnce({ text: 'The file is complete.' })
      .mockResolvedValueOnce({
        text: 'I will obtain the missing independent evidence.',
        toolCalls: [{ id: 'confirmed-one-turn-readback', name: 'read_file', arguments: { path: target } }],
      })
      .mockResolvedValueOnce({ text: `Verified ${target}: confirmed exact content` });

    const task = `After writing ${target}, read the same path back and report the exact content.`;
    const result = await runWithTools(
      buildConfirmedStepContinuationMessages(task, confirmedRecord),
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      1,
      ...getters,
      undefined,
      {
        source: 'chat_confirmation_resume',
        actionIntent: task,
        routedTaskText: task,
        priorToolRecords: [confirmedRecord],
      },
    );

    expect(repeatedWrite).not.toHaveBeenCalled();
    expect(readback).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('confirmed exact content');
    expect(result.toolCalls.map(record => record.id)).toEqual([
      'confirmed-one-turn-write',
      'confirmed-one-turn-readback',
    ]);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(3);

    vi.clearAllMocks();
    mocks.makeLLMCall
      .mockRejectedValueOnce(new Error('selected provider call failed before producing a response'))
      .mockResolvedValueOnce({
        text: 'Continuing from the preserved receipt with an observation capability.',
        toolCalls: [{ id: 'fallback-selected-readback', name: 'read_file', arguments: { path: target } }],
      })
      .mockResolvedValueOnce({ text: `Fallback verified ${target}: confirmed exact content` });

    const recovered = await runWithTools(
      buildConfirmedStepContinuationMessages(task, confirmedRecord),
      registry,
      {
        provider: 'deepseek',
        model: 'test-model',
        fallbackCandidates: [{ provider: 'qwen', model: 'fallback-model' }],
        allowCloudFallback: true,
      },
      undefined,
      1,
      ...getters,
      undefined,
      {
        source: 'chat_confirmation_resume',
        actionIntent: task,
        routedTaskText: task,
        priorToolRecords: [confirmedRecord],
      },
    );

    expect(repeatedWrite).not.toHaveBeenCalled();
    expect(readback).toHaveBeenCalledTimes(1);
    expect(recovered.text).toContain('confirmed exact content');
    expect(recovered.toolCalls.map(record => record.id)).toEqual([
      'confirmed-one-turn-write',
      'fallback-selected-readback',
    ]);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(3);
    const recoveredMessages = mocks.makeLLMCall.mock.calls.flatMap(call => (
      call[0] as Array<{ role: string; content: string }>
    ));
    expect(recoveredMessages.some(message => (
      message.role === 'system'
      && message.content.includes('provider/fallback policy')
      && message.content.includes('Declarative verification obligation')
    ))).toBe(true);
  });

  it('returns a missing artifact verification obligation to the shared model instead of executing a fixed readback', async () => {
    const registry = new ToolRegistry();
    const target = 'C:\\Users\\me\\Desktop\\model-owned-note.txt';
    const write = vi.fn(async () => encodeToolResult('native bytes matched', {
      ok: true,
      status: 'verified',
      path: target,
      readBackMatched: true,
      bytesWritten: 25,
    }));
    registry.register({
      name: 'write_file',
      description: 'Write exact text to one local file path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      permission: 'public',
      securityLevel: 'safe',
      capability: {
        id: 'files.text.write',
        family: 'file_ops',
        lane: 'files',
        operation: 'mutate',
        risk: 'medium',
        sideEffects: [{ type: 'local_write', scope: 'one exact local text-file path', reversible: true }],
        verification: {
          strategy: 'measured',
          required: true,
          requiredFields: ['path', 'readBackMatched'],
          requiredValues: { readBackMatched: true },
          successStatuses: ['verified'],
          successSignals: ['native byte read-back matched'],
          limitations: ['Use a text reader when the result must quote the content.'],
        },
      },
      handler: write,
    });
    const readback = vi.fn(async () => 'model-owned exact content');
    registerReadOnlyProbe(registry, 'read_file', readback);

    mocks.makeLLMCall
      .mockResolvedValueOnce({
        text: 'writing',
        toolCalls: [{
          id: 'semantic-write',
          name: 'write_file',
          arguments: { path: target, content: 'model-owned exact content' },
        }],
      })
      .mockResolvedValueOnce({ text: 'The file is complete.' })
      .mockResolvedValueOnce({
        text: 'checking the missing evidence',
        toolCalls: [{ id: 'model-selected-readback', name: 'read_file', arguments: { path: target } }],
      })
      .mockResolvedValueOnce({ text: `Verified ${target}: model-owned exact content` });

    const task = `After creating the file, read it back and quote the exact content. Target: ${target}`;
    const result = await runWithTools(
      [{ role: 'user', content: task }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      4,
      ...getters,
      undefined,
      {
        allowLocalFileWrites: true,
        localWriteIntentReason: 'The current task explicitly requests a local text-file deliverable.',
      },
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(readback).toHaveBeenCalledTimes(1);
    expect(result.toolCalls.map(record => record.id)).toEqual([
      'semantic-write',
      'model-selected-readback',
    ]);
    expect(result.text).toContain('model-owned exact content');
    const obligationMessages = mocks.makeLLMCall.mock.calls.flatMap(call => (
      call[0] as Array<{ role: string; content: string }>
    ));
    expect(obligationMessages
      .filter(message => message.role === 'system')
      .map(message => message.content)).toEqual(expect.arrayContaining([
        expect.stringContaining('Declarative verification obligation'),
      ]));
  });

  it('routes a failed confirmed receipt through shared recovery instead of ending with a failure notice', async () => {
    const registry = new ToolRegistry();
    const failedPath = vi.fn(async () => encodeToolResult('unexpected replay', {
      ok: false,
      status: 'failed',
    }));
    registerReadOnlyProbe(registry, 'failed_confirmed_probe', failedPath);
    const fallback = vi.fn(async () => encodeToolResult('fallback verified the current state', {
      ok: true,
      status: 'verified',
      verified: true,
    }));
    registerReadOnlyProbe(registry, 'confirmed_fallback_probe', fallback);

    const failedRecord: ToolExecutionRecord = {
      id: 'confirmed-failed',
      name: 'failed_confirmed_probe',
      arguments: {},
      result: JSON.stringify({ ok: false, status: 'timed_out' }),
      error: 'temporary timeout before a verified result',
      capability: {
        capabilityId: 'test.failed_confirmed_probe',
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
      terminalVerification: {
        status: 'failed',
        strategy: 'state_diff',
        reason: 'temporary timeout before a verified result',
      },
    };

    mocks.makeLLMCall
      .mockResolvedValueOnce({ text: 'The confirmed call failed, so I am stopping.' })
      .mockResolvedValueOnce({
        text: 'using the available fallback',
        toolCalls: [{ id: 'fallback-after-confirmation', name: 'confirmed_fallback_probe', arguments: {} }],
      })
      .mockResolvedValueOnce({ text: 'The fallback produced verified evidence.' });

    const goal = 'Determine the current state and recover if the first route fails.';
    const result = await runWithTools(
      buildConfirmedStepContinuationMessages(goal, failedRecord),
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      3,
      ...getters,
      undefined,
      {
        source: 'test_confirmation_resume',
        actionIntent: goal,
        routedTaskText: goal,
        priorToolRecords: [failedRecord],
      },
    );

    expect(failedPath).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(result.toolCalls.map(record => record.id)).toEqual([
      'confirmed-failed',
      'fallback-after-confirmation',
    ]);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(3);
    const recoveryMessages = mocks.makeLLMCall.mock.calls[1][0] as Array<{ role: string; content: string }>;
    expect(recoveryMessages.some(message => (
      message.role === 'system'
      && message.content.includes('Do not stop with an explanation of the failure')
    ))).toBe(true);
  });

  it('feeds verification and a redacted receipt back to the model and permits one safe identical recovery retry', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn()
      .mockResolvedValueOnce(encodeToolResult('first diagnostic result', {
        ok: true,
        status: 'observed',
        attempt: 1,
        apiKey: 'must-not-reach-the-model',
      }))
      .mockResolvedValueOnce(encodeToolResult('second verified result', {
        ok: true,
        status: 'verified',
        verified: true,
        attempt: 2,
      }));
    registerReadOnlyProbe(registry, 'retry_probe', handler);

    mocks.makeLLMCall
      .mockResolvedValueOnce({
        text: 'checking',
        toolCalls: [{ id: 'probe-1', name: 'retry_probe', arguments: {} }],
      })
      .mockResolvedValueOnce({
        text: 'retrying the unverified read-only probe',
        toolCalls: [{ id: 'probe-2', name: 'retry_probe', arguments: {} }],
      })
      .mockResolvedValueOnce({ text: 'The second probe verified the state.' });

    const result = await runWithTools(
      [{ role: 'user', content: 'Check the current state and verify it.' }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      3,
      ...getters,
    );

    expect(handler).toHaveBeenCalledTimes(2);
    expect(result.toolCalls.map(record => record.terminalVerification?.status)).toEqual([
      'unverified',
      'verified',
    ]);
    const secondModelMessages = mocks.makeLLMCall.mock.calls[1][0] as Array<{ role: string; content: string }>;
    const firstReceiptMessage = secondModelMessages.find(message => message.role === 'tool')?.content || '';
    expect(firstReceiptMessage).toContain('[LUMI TERMINAL VERIFICATION]');
    expect(firstReceiptMessage).toContain('status=unverified');
    expect(firstReceiptMessage).toContain('not verified completion evidence');
    expect(firstReceiptMessage).toContain('"attempt":1');
    expect(firstReceiptMessage).toContain('"apiKey":"[redacted]"');
    expect(firstReceiptMessage).not.toContain('must-not-reach-the-model');
  });

  it('deduplicates an identical call only after verified success and asks the model to finish from the receipt', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => encodeToolResult('verified state', {
      ok: true,
      status: 'verified',
      verified: true,
    }));
    registerReadOnlyProbe(registry, 'verified_probe', handler);

    mocks.makeLLMCall
      .mockResolvedValueOnce({
        text: 'checking',
        toolCalls: [{ id: 'verified-1', name: 'verified_probe', arguments: {} }],
      })
      .mockResolvedValueOnce({
        text: 'checking again',
        toolCalls: [{ id: 'verified-2', name: 'verified_probe', arguments: {} }],
      })
      .mockResolvedValueOnce({ text: 'The existing verified receipt completes the check.' });

    const result = await runWithTools(
      [{ role: 'user', content: 'Check the current service state.' }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      3,
      ...getters,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(3);
    const finalModelMessages = mocks.makeLLMCall.mock.calls[2][0] as Array<{ role: string; content: string }>;
    expect(finalModelMessages.some(message => (
      message.role === 'system'
      && message.content.includes('identical prior call already has verified terminal evidence')
    ))).toBe(true);
  });

  it('does not accept a failure explanation as terminal while a fallback capability remains available', async () => {
    const registry = new ToolRegistry();
    const primary = vi.fn(async () => encodeToolResult('primary path returned without proof', {
      ok: true,
      status: 'observed',
    }));
    const fallback = vi.fn(async () => encodeToolResult('fallback verified state', {
      ok: true,
      status: 'verified',
      verified: true,
    }));
    registerReadOnlyProbe(registry, 'primary_probe', primary);
    registerReadOnlyProbe(registry, 'fallback_probe', fallback);

    mocks.makeLLMCall
      .mockResolvedValueOnce({
        text: 'trying primary',
        toolCalls: [{ id: 'primary-1', name: 'primary_probe', arguments: {} }],
      })
      .mockResolvedValueOnce({ text: 'The primary tool failed; the user must try again.' })
      .mockResolvedValueOnce({
        text: 'using the fallback instead',
        toolCalls: [{ id: 'fallback-1', name: 'fallback_probe', arguments: {} }],
      })
      .mockResolvedValueOnce({ text: 'The fallback independently verified the state.' });

    await runWithTools(
      [{ role: 'user', content: 'Inspect the state and recover through an available capability.' }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      4,
      ...getters,
    );

    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(4);
    const fallbackPlanningMessages = mocks.makeLLMCall.mock.calls[2][0] as Array<{ role: string; content: string }>;
    expect(fallbackPlanningMessages.some(message => (
      message.role === 'system'
      && message.content.includes('Do not stop with an explanation of the failure')
      && message.content.includes('declared fallback or verification capability')
    ))).toBe(true);
  });
});
