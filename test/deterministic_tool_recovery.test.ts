import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeLLMCall: vi.fn(),
}));

vi.mock('../server/llm/providers', async () => {
  const actual = await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers');
  return { ...actual, makeLLMCall: mocks.makeLLMCall };
});

import {
  buildDeterministicExplicitToolRecoveryCall,
  buildDurableTaskDeterministicToolRecoveryCall,
  validateRuntimeOwnedDeterministicToolRecoveryCall,
} from '../server/cognition/deterministic_tool_recovery';
import type { ConversationActionContinuationState } from '../server/cognition/action_continuation';
import { buildTaskCapsuleV1 } from '../server/conversation/task_capsule';
import type { PendingToolConfirmation } from '../server/tools/pending_confirmation';
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

function registerConfirmationWrite(registry: ToolRegistry, handler: (...args: any[]) => Promise<string>) {
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

function correctedWriteState(requestId: string): {
  state: ConversationActionContinuationState;
  revokedCorrectionBasis: PendingToolConfirmation;
  targets: string[];
  content: string;
  finalInstruction: string;
} {
  const targets = [0, 1, 2, 3].map(index => (
    `C:\\Users\\ExampleUser\\LumiCore\\formal-client-${index}.txt`
  ));
  const content = `  api_key=secret-shaped-fixture\n${'x'.repeat(760)}\nformal-marker:end  `;
  const goal = `创建一个仅用于正式 E2E 的确认门控文件 ${targets[0]}，内容严格写成 ${content}。必须调用 write_file，但不要代替用户确认；到确认边界立即停止。`;
  const corrections = [
    `不是 ${targets[0]}，把同一个任务的目标改成 ${targets[1]}，内容保持不变；不要沿用或重试旧目标。`,
    `再纠正一次：不要 ${targets[1]}，改成 ${targets[2]}，仍是同一个任务且内容不变。`,
    `最后一次纠正：拒绝 ${targets[2]}，最终目标是 ${targets[3]}，内容不变；等待我的确认。`,
  ];
  let capsule = buildTaskCapsuleV1({
    taskId: 'task-durable-correction',
    revision: 1,
    status: 'waiting_confirmation',
    unfinished: true,
    goal,
    latestInstruction: goal,
    latestInstructionRef: 'message-0',
    sourcePaths: [targets[0]],
    receipts: [],
    toolSummaries: [],
    updatedAt: '2026-08-28T00:00:00.000Z',
  }, {
    currentTurnText: goal,
    currentTurnRef: 'message-0',
    observedAt: '2026-08-28T00:00:00.000Z',
  })!;
  for (let index = 0; index < corrections.length; index += 1) {
    const eventRef = `message-${index + 1}`;
    capsule = buildTaskCapsuleV1({
      taskId: 'task-durable-correction',
      revision: index + 2,
      status: 'planning',
      unfinished: true,
      goal,
      latestInstruction: corrections[index],
      latestInstructionRef: eventRef,
      sourcePaths: [targets[0]],
      receipts: [],
      toolSummaries: [],
      updatedAt: `2026-08-28T00:0${index + 1}:00.000Z`,
    }, {
      previousCapsule: capsule,
      currentTurnText: corrections[index],
      currentTurnRef: eventRef,
      observedAt: `2026-08-28T00:0${index + 1}:00.000Z`,
    })!;
  }
  return {
    state: {
      version: 2,
      taskId: 'task-durable-correction',
      revision: 4,
      status: 'planning',
      activeRequestId: requestId,
      goal,
      latestInstruction: corrections[2],
      latestInstructionRef: 'message-3',
      appTarget: '',
      sourcePaths: [targets[0]],
      latestBlocker: '',
      unfinished: true,
      evidenceTools: [],
      assistantState: '',
      toolSummaries: [],
      taskCapsule: capsule,
      receipts: [],
      updatedAt: '2026-08-28T00:03:00.000Z',
    },
    revokedCorrectionBasis: {
      id: 'pending-target-2',
      userId: 'user-1',
      toolName: 'write_file',
      argsHash: 'validated-args-hash',
      target: targets[2],
      payloadDigest: 'validated-payload-digest',
      exactArgs: { path: targets[2], content },
      safeArgs: { path: targets[2] },
      actionIntent: corrections[1],
      source: 'chat',
      domain: 'personal',
      orgId: '',
      channelId: 'conversation:durable-correction',
      taskId: 'task-durable-correction',
      originRequestId: 'request-target-2',
      createdAt: '2026-08-28T00:02:00.000Z',
      expiresAt: Date.now() + 60_000,
    },
    targets,
    content,
    finalInstruction: corrections[2],
  };
}

beforeEach(() => {
  mocks.makeLLMCall.mockReset();
  mocks.makeLLMCall.mockResolvedValue({ text: 'I will continue with the file request.' });
});

describe('deterministic missing-tool recovery', () => {
  it('executes a server-owned structured media request directly without waiting for a model', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => JSON.stringify({
      ok: true,
      status: 'generated',
      verified: true,
      verificationStatus: 'verified',
      images: ['D:\\lumi_output\\exact.png'],
    }));
    registry.register({
      name: 'generate_image',
      description: 'Generate a verified image artifact.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          size: { type: 'string' },
          n: { type: 'number' },
        },
        required: ['prompt'],
      },
      permission: 'user',
      securityLevel: 'safe',
      handler,
    });
    mocks.makeLLMCall.mockRejectedValueOnce(new Error('the reasoning model is unavailable'));
    const exactArguments = { prompt: 'quiet moonlit harbor', size: '1024x1024', n: 1 };

    const result = await runWithTools(
      [{ role: 'user', content: 'Generate the requested image.' }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      1,
      ...getters,
      undefined,
      {
        userId: 'user-1',
        authenticated: true,
        taskId: 'task-media-1',
        taskRevision: 2,
        requestId: 'request-media-1',
        source: 'chat',
        actionIntent: 'Generate the requested image.',
        routedTaskText: 'Generate images',
        runtimeOwnedDeterministicRecoveryCall: {
          source: 'structured_media_request',
          taskId: 'task-media-1',
          taskRevision: 2,
          requestId: 'request-media-1',
          name: 'generate_image',
          arguments: exactArguments,
        },
        requestConfirmation: async () => true,
        toolPolicy: {
          allowedTools: ['generate_image'],
          requireConfirmation: [],
          forbiddenTools: [],
          maxIterations: 1,
        },
        modelToolProjection: {
          toolNames: ['generate_image'],
          maxTools: 1,
          allowDynamicDiscovery: false,
        },
      },
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(mocks.makeLLMCall).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(exactArguments, expect.not.objectContaining({
      runtimeOwnedDeterministicRecoveryCall: expect.anything(),
    }));
    expect(result.toolCalls[0]).toMatchObject({
      name: 'generate_image',
      arguments: exactArguments,
      executionOrigin: 'deterministic_route',
      result: expect.stringContaining('"verificationStatus":"verified"'),
    });
  });

  it('parses one explicit absolute path and exact content without executing it', () => {
    const target = 'C:\\Users\\ExampleUser\\LumiCore\\confirmation.txt';
    expect(buildDeterministicExplicitToolRecoveryCall(exactWriteTask(target, 'receipt-51fe050f'), ['write_file']))
      .toEqual({
        name: 'write_file',
        arguments: { path: target, content: 'receipt-51fe050f' },
        reason: 'explicit_exact_text_write',
      });
  });

  it('parses the fully specified Chinese formal-client write request', () => {
    const target = 'C:\\Users\\ExampleUser\\LumiCore\\confirmation-zh.txt';
    const content = 'formal-marker:confirmation-gate';
    const task = `创建确认门控文件 ${target}，内容严格写成 ${content}。必须调用 write_file，但不要代替用户确认。`;
    expect(buildDeterministicExplicitToolRecoveryCall(task, ['write_file'])).toEqual({
      name: 'write_file',
      arguments: { path: target, content },
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

  it('recovers a third corrected target from the current durable task capsule', async () => {
    const requestId = 'request-durable-correction';
    const { state, revokedCorrectionBasis, targets, content, finalInstruction } = correctedWriteState(requestId);
    const recoveryCall = buildDurableTaskDeterministicToolRecoveryCall(
      state,
      requestId,
      revokedCorrectionBasis,
    );
    expect(recoveryCall).toMatchObject({
      source: 'durable_task_capsule',
      taskId: 'task-durable-correction',
      taskRevision: 4,
      requestId,
      name: 'write_file',
      arguments: { path: targets[3], content },
    });
    expect(state.taskCapsule?.rejectedTargets.map(item => item.identity)).toEqual(
      expect.arrayContaining(targets.slice(0, 3)),
    );

    const registry = new ToolRegistry();
    const handler = vi.fn(async () => 'must not execute before confirmation');
    const requestConfirmation = vi.fn(async () => false);
    registerConfirmationWrite(registry, handler);
    mocks.makeLLMCall.mockResolvedValueOnce({
      text: 'I changed the content while correcting the path.',
      toolCalls: [{
        id: 'model-tampered-write',
        name: 'write_file',
        arguments: { path: targets[3], content: 'tampered-content' },
      }],
    });
    const result = await runWithTools(
      [{ role: 'user', content: finalInstruction }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      2,
      ...getters,
      undefined,
      {
        userId: 'user-1',
        authenticated: true,
        taskId: state.taskId,
        taskRevision: state.revision,
        requestId,
        source: 'chat',
        actionIntent: finalInstruction,
        routedTaskText: finalInstruction,
        runtimeOwnedDeterministicRecoveryCall: recoveryCall!,
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

    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(1);
    expect(requestConfirmation).toHaveBeenCalledOnce();
    expect(requestConfirmation).toHaveBeenCalledWith('write_file', {
      path: targets[3],
      content,
    });
    expect(requestConfirmation).not.toHaveBeenCalledWith('write_file', expect.objectContaining({
      path: targets[2],
    }));
    expect(handler).not.toHaveBeenCalled();
    expect(result.toolCalls[0]).toMatchObject({
      taskId: state.taskId,
      requestId,
      executionOrigin: 'deterministic_route',
      arguments: { path: targets[3], content },
    });
  });

  it('rejects stale, rejected, mismatched, or unexposed durable recovery calls', () => {
    const requestId = 'request-durable-fail-closed';
    const { state, revokedCorrectionBasis, targets } = correctedWriteState(requestId);
    const call = buildDurableTaskDeterministicToolRecoveryCall(
      state,
      requestId,
      revokedCorrectionBasis,
    )!;
    expect(call).toBeTruthy();
    expect(validateRuntimeOwnedDeterministicToolRecoveryCall(
      call,
      { taskId: state.taskId, taskRevision: state.revision, requestId: 'different-request' },
      ['write_file'],
    )).toBeNull();
    expect(validateRuntimeOwnedDeterministicToolRecoveryCall(
      call,
      { taskId: state.taskId, taskRevision: state.revision, requestId },
      [],
    )).toBeNull();

    const rejected = structuredClone(state);
    rejected.taskCapsule!.rejectedTargets.push({
      identity: targets[3],
      reason: 'explicitly rejected',
      observedAt: '2026-08-28T00:04:00.000Z',
    });
    expect(buildDurableTaskDeterministicToolRecoveryCall(
      rejected,
      requestId,
      revokedCorrectionBasis,
    )).toBeNull();

    const staleEvent = structuredClone(state);
    staleEvent.latestInstructionRef = 'different-message';
    expect(buildDurableTaskDeterministicToolRecoveryCall(
      staleEvent,
      requestId,
      revokedCorrectionBasis,
    )).toBeNull();

    const mismatchedInstruction = structuredClone(state);
    mismatchedInstruction.latestInstruction = 'content changed';
    expect(buildDurableTaskDeterministicToolRecoveryCall(
      mismatchedInstruction,
      requestId,
      revokedCorrectionBasis,
    )).toBeNull();

    const wrongPriorArgs = structuredClone(revokedCorrectionBasis);
    wrongPriorArgs.exactArgs.path = targets[1];
    expect(buildDurableTaskDeterministicToolRecoveryCall(
      state,
      requestId,
      wrongPriorArgs,
    )).toBeNull();
  });

  it('distinguishes prior task receipts from new-turn execution without replaying an exact call', async () => {
    const requestId = 'request-durable-with-prior-receipt';
    const { state, revokedCorrectionBasis, targets, content, finalInstruction } = correctedWriteState(requestId);
    const recoveryCall = buildDurableTaskDeterministicToolRecoveryCall(
      state,
      requestId,
      revokedCorrectionBasis,
    )!;
    const registry = new ToolRegistry();
    const requestConfirmation = vi.fn(async () => false);
    const handler = vi.fn(async () => 'must not execute');
    registerConfirmationWrite(registry, handler);
    const prior = {
      id: 'prior-target-2-confirmation',
      name: 'write_file',
      arguments: { path: targets[2], content },
      result: 'Confirmation required.',
      taskId: state.taskId,
      requestId: 'request-target-2',
    };

    const result = await runWithTools(
      [{ role: 'user', content: finalInstruction }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      2,
      ...getters,
      undefined,
      {
        userId: 'user-1',
        authenticated: true,
        taskId: state.taskId,
        taskRevision: state.revision,
        requestId,
        source: 'chat_guard_recovery',
        actionIntent: finalInstruction,
        routedTaskText: finalInstruction,
        runtimeOwnedDeterministicRecoveryCall: recoveryCall,
        priorToolRecords: [prior],
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

    expect(requestConfirmation).toHaveBeenCalledOnce();
    expect(requestConfirmation).toHaveBeenCalledWith('write_file', {
      path: targets[3],
      content,
    });
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.at(-1)).toMatchObject({
      arguments: { path: targets[3], content },
      executionOrigin: 'deterministic_route',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps the revoked exact payload out of the generic tool-handler context', async () => {
    const requestId = 'request-private-recovery-context';
    const { state, revokedCorrectionBasis, content, finalInstruction } = correctedWriteState(requestId);
    const recoveryCall = buildDurableTaskDeterministicToolRecoveryCall(
      state,
      requestId,
      revokedCorrectionBasis,
    )!;
    const registry = new ToolRegistry();
    let observedContext: Record<string, unknown> | undefined;
    const handler = vi.fn(async (_args: Record<string, unknown>, context: Record<string, unknown>) => {
      observedContext = context;
      return 'written';
    });
    registerConfirmationWrite(registry, handler);

    await runWithTools(
      [{ role: 'user', content: finalInstruction }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      1,
      ...getters,
      undefined,
      {
        userId: 'user-1',
        authenticated: true,
        taskId: state.taskId,
        taskRevision: state.revision,
        requestId,
        source: 'chat',
        actionIntent: finalInstruction,
        routedTaskText: finalInstruction,
        runtimeOwnedDeterministicRecoveryCall: recoveryCall,
        requestConfirmation: async () => true,
        toolPolicy: {
          allowedTools: ['write_file'],
          requireConfirmation: ['write_file'],
          forbiddenTools: [],
          maxIterations: 1,
        },
        modelToolProjection: {
          toolNames: ['write_file'],
          maxTools: 1,
          allowDynamicDiscovery: false,
        },
      },
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(observedContext).toBeDefined();
    expect(observedContext).not.toHaveProperty('runtimeOwnedDeterministicRecoveryCall');
    expect(JSON.stringify(observedContext)).not.toContain(content);
  });

  it('does not replay an already recorded exact correction when argument keys are reordered', async () => {
    const requestId = 'request-canonical-prior-signature';
    const { state, revokedCorrectionBasis, targets, content, finalInstruction } = correctedWriteState(requestId);
    const recoveryCall = buildDurableTaskDeterministicToolRecoveryCall(
      state,
      requestId,
      revokedCorrectionBasis,
    )!;
    const registry = new ToolRegistry();
    const requestConfirmation = vi.fn(async () => false);
    const handler = vi.fn(async () => 'must not execute');
    registerConfirmationWrite(registry, handler);
    mocks.makeLLMCall.mockResolvedValueOnce({
      text: 'I will change it again.',
      toolCalls: [{
        id: 'model-reordered-replay',
        name: 'write_file',
        arguments: { path: targets[3], content: 'tampered' },
      }],
    });

    const result = await runWithTools(
      [{ role: 'user', content: finalInstruction }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      1,
      ...getters,
      undefined,
      {
        userId: 'user-1',
        authenticated: true,
        taskId: state.taskId,
        taskRevision: state.revision,
        requestId,
        source: 'chat_guard_recovery',
        actionIntent: finalInstruction,
        routedTaskText: finalInstruction,
        runtimeOwnedDeterministicRecoveryCall: recoveryCall,
        priorToolRecords: [{
          id: 'prior-exact-correction',
          name: 'write_file',
          arguments: { content, path: targets[3] },
          result: 'Confirmation required.',
          taskId: state.taskId,
          requestId: 'prior-request',
        }],
        requestConfirmation,
        toolPolicy: {
          allowedTools: ['write_file'],
          requireConfirmation: ['write_file'],
          forbiddenTools: [],
          maxIterations: 1,
        },
        modelToolProjection: {
          toolNames: ['write_file'],
          maxTools: 1,
          allowDynamicDiscovery: false,
        },
      },
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe('prior-exact-correction');
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
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
