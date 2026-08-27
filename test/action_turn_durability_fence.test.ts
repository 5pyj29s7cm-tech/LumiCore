import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  admitAcceptedUserTurnDurably,
  resolveAcceptedTurnConfirmation,
  runAfterAcceptedUserTurnAdmission,
} from '../server/socket/action_turn_durability';
import {
  beginChatExecution,
  beginChatExecutionDurably,
  getChatExecution,
  resetChatExecutionRegistryForTests,
  type ChatExecutionScope,
} from '../server/socket/chat_execution_registry';
import {
  buildTransportNeutralConfirmationScope,
  clearAllPendingConfirmationsForTests,
  consumePendingConfirmationDurably,
  getPendingConfirmation,
  recordPendingConfirmation,
} from '../server/tools/pending_confirmation';

afterEach(() => {
  resetChatExecutionRegistryForTests();
  clearAllPendingConfirmationsForTests();
});

describe('accepted action-turn durability fence', () => {
  it('does not admit the executor when the accepted transcript flush fails', async () => {
    const executor = vi.fn(async () => 'should-never-run');
    const onPersistenceUnknown = vi.fn();
    const admission = await admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: () => 'message-id',
      flush: async () => { throw new Error('disk unavailable'); },
      onPersistenceUnknown,
    });
    if (admission) await runAfterAcceptedUserTurnAdmission(admission, executor);

    expect(admission).toBeNull();
    expect(onPersistenceUnknown).toHaveBeenCalledOnce();
    expect(executor).not.toHaveBeenCalled();
  });

  it('admits execution only after the flush has completed', async () => {
    const order: string[] = [];
    const admission = await admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: () => { order.push('persist'); return 'message-id'; },
      flush: async () => { order.push('flush'); },
      onPersistenceUnknown: () => { order.push('unknown'); },
    });
    if (admission) runAfterAcceptedUserTurnAdmission(admission, () => { order.push('executor'); });
    expect(order).toEqual(['persist', 'flush', 'executor']);
  });

  it('keeps the real active execution and every admission-sensitive operation untouched when flush rejects', async () => {
    const scope: ChatExecutionScope = {
      userId: 'admission-user',
      domain: 'personal',
      source: 'voice',
      conversationId: 'admission-conversation',
    };
    beginChatExecution(scope, 'old-active-request');
    const clearConfirmation = vi.fn();
    const consumeConfirmation = vi.fn();
    const cancelOld = vi.fn();
    const reserve = vi.fn();
    const beginDurable = vi.fn(() => beginChatExecutionDurably(
      scope,
      'new-request',
      { text: 'persistence unknown' },
    ));

    const admission = await admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: vi.fn(() => 'persisted-user-message'),
      flush: async () => { throw new Error('disk unavailable'); },
      onPersistenceUnknown: vi.fn(),
    });
    if (admission) {
      await runAfterAcceptedUserTurnAdmission(admission, async () => {
        clearConfirmation();
        consumeConfirmation();
        cancelOld();
        reserve();
        await beginDurable();
      });
    }

    expect(admission).toBeNull();
    expect(clearConfirmation).toHaveBeenCalledTimes(0);
    expect(consumeConfirmation).toHaveBeenCalledTimes(0);
    expect(cancelOld).toHaveBeenCalledTimes(0);
    expect(reserve).toHaveBeenCalledTimes(0);
    expect(beginDurable).toHaveBeenCalledTimes(0);
    expect(getChatExecution(scope)).toMatchObject({
      requestId: 'old-active-request',
      terminal: false,
    });
    expect(getChatExecution(scope, 'new-request')).toBeNull();
  });

  it('revokes a taskless grant only after the unrelated accepted turn is durable', async () => {
    const channelScope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'confirmation-conversation',
    });
    const taskScope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'confirmation-conversation',
      taskId: 'durable-task',
    });
    recordPendingConfirmation(
      'confirmation-user',
      'desktop_open',
      { target: 'Notepad' },
      'chat',
      channelScope,
    );
    const admission = await admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: () => 'message-id',
      flush: async () => undefined,
      onPersistenceUnknown: vi.fn(),
    });
    expect(admission).not.toBeNull();

    const resolution = await resolveAcceptedTurnConfirmation({
      admission: admission!,
      userId: 'confirmation-user',
      userText: 'Tell me about the weather.',
      taskScope,
      channelScope,
    });

    expect(resolution).toMatchObject({ pending: null, prompt: '', cleared: true });
    expect(getPendingConfirmation('confirmation-user', channelScope)).toBeNull();
  });

  it('does not revoke a task-bound grant for an unrelated accepted turn', async () => {
    const channelScope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'bound-confirmation-conversation',
    });
    const taskScope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'bound-confirmation-conversation',
      taskId: 'durable-task',
    });
    const taskBound = recordPendingConfirmation(
      'bound-confirmation-user',
      'desktop_open',
      { target: 'Calculator' },
      'chat',
      taskScope,
    );
    const admission = await admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: () => 'message-id',
      flush: async () => undefined,
      onPersistenceUnknown: vi.fn(),
    });

    const resolution = await resolveAcceptedTurnConfirmation({
      admission: admission!,
      userId: 'bound-confirmation-user',
      userText: 'Tell me about the weather.',
      taskScope,
      channelScope,
    });

    expect(resolution.cleared).toBe(false);
    expect(getPendingConfirmation('bound-confirmation-user', taskScope)?.id).toBe(taskBound.id);
  });

  it('revokes a rejected pending target and requires a fresh confirmation for its correction', async () => {
    const oldTarget = 'C:\\Users\\Administrator\\LumiCore\\formal-client-e2e-artifacts\\LUMI-E2E-confirmation-correction\\target-0.txt';
    const newTarget = 'C:\\Users\\Administrator\\LumiCore\\formal-client-e2e-artifacts\\LUMI-E2E-confirmation-correction\\target-1.txt';
    const channelScope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'corrected-confirmation-conversation',
    });
    const taskScope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'corrected-confirmation-conversation',
      taskId: 'corrected-confirmation-task',
    });
    const oldPending = recordPendingConfirmation(
      'corrected-confirmation-user',
      'write_file',
      { path: oldTarget, content: 'same content' },
      'chat',
      taskScope,
    );
    const admission = await admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: () => 'correction-message',
      flush: async () => undefined,
      onPersistenceUnknown: vi.fn(),
    });

    const resolution = await resolveAcceptedTurnConfirmation({
      admission: admission!,
      userId: 'corrected-confirmation-user',
      userText: `不是 ${oldTarget}，把同一个任务的目标改成 ${newTarget}，内容保持不变；不要沿用或重试旧目标。`,
      actionState: {
        version: 2,
        taskId: 'corrected-confirmation-task',
        status: 'waiting_confirmation',
        goal: 'create the confirmed file',
        appTarget: '',
        sourcePaths: [],
        latestBlocker: '',
        unfinished: true,
        evidenceTools: ['write_file'],
        latestInstruction: `create ${oldTarget}`,
        assistantState: 'waiting for confirmation',
        toolSummaries: [],
        updatedAt: new Date().toISOString(),
      },
      taskScope,
      channelScope,
    });

    expect(resolution).toMatchObject({
      pending: null,
      prompt: '',
      cleared: true,
      correctionRequiresFreshConfirmation: true,
    });
    expect(getPendingConfirmation('corrected-confirmation-user', taskScope)).toBeNull();
    const replacement = recordPendingConfirmation(
      'corrected-confirmation-user',
      'write_file',
      { path: newTarget, content: 'same content' },
      'chat',
      taskScope,
    );
    expect(replacement.id).not.toBe(oldPending.id);
    expect(replacement.exactArgs).toMatchObject({ path: newTarget });

    const mixedAdmission = await admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: () => 'mixed-correction-message',
      flush: async () => undefined,
      onPersistenceUnknown: vi.fn(),
    });
    const mixedResolution = await resolveAcceptedTurnConfirmation({
      admission: mixedAdmission!,
      userId: 'corrected-confirmation-user',
      userText: `不是 ${newTarget}，而是创建文件 corrected-final-target.txt，内容不变。`,
      actionState: {
        version: 2,
        taskId: 'corrected-confirmation-task',
        status: 'waiting_confirmation',
        goal: 'create the confirmed file',
        appTarget: '',
        sourcePaths: [newTarget],
        latestBlocker: '',
        unfinished: true,
        evidenceTools: ['write_file'],
        latestInstruction: `create ${newTarget}`,
        assistantState: 'waiting for confirmation',
        toolSummaries: [],
        updatedAt: new Date().toISOString(),
      },
      taskScope,
      channelScope,
    });
    expect(mixedResolution).toMatchObject({
      pending: null,
      cleared: true,
      correctionRequiresFreshConfirmation: true,
    });
    expect(getPendingConfirmation('corrected-confirmation-user', taskScope)).toBeNull();
  });

  it('recovers the same exact pending action for repeated confirmations and consumes it once', async () => {
    const channelScope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'repeat-confirmation-conversation',
    });
    const taskScope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'repeat-confirmation-conversation',
      taskId: 'repeat-confirmation-task',
    });
    const exactArgs = { target: 'WPS', path: 'D:\\deliverables\\final.docx' };
    const pending = recordPendingConfirmation(
      'repeat-confirmation-user',
      'desktop_open',
      exactArgs,
      'chat',
      taskScope,
    );
    const admit = async (messageId: string) => admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: () => messageId,
      flush: async () => undefined,
      onPersistenceUnknown: vi.fn(),
    });
    const [firstAdmission, repeatedAdmission] = await Promise.all([
      admit('confirmation-1'),
      admit('confirmation-2'),
    ]);

    const [first, repeated] = await Promise.all([
      resolveAcceptedTurnConfirmation({
        admission: firstAdmission!,
        userId: 'repeat-confirmation-user',
        userText: '确认',
        taskScope,
        channelScope,
      }),
      resolveAcceptedTurnConfirmation({
        admission: repeatedAdmission!,
        userId: 'repeat-confirmation-user',
        userText: '确认了',
        taskScope,
        channelScope,
      }),
    ]);

    expect(first.pending).toMatchObject({ id: pending.id, toolName: 'desktop_open', exactArgs });
    expect(repeated.pending).toMatchObject({ id: pending.id, toolName: 'desktop_open', exactArgs });
    expect(await consumePendingConfirmationDurably(
      'repeat-confirmation-user', pending.id, pending.toolName, exactArgs, taskScope,
    )).toBe(true);
    expect(await consumePendingConfirmationDurably(
      'repeat-confirmation-user', pending.id, pending.toolName, exactArgs, taskScope,
    )).toBe(false);
  });

  it.each([
    ['chat.ts', 'const chatAdmission = await admitAcceptedUserTurnDurably({', 'chatExecutionQueue.reserve(', 'beginChatExecutionDurably('],
    ['voice.ts', 'const voiceAdmission = await admitAcceptedUserTurnDurably({', 'resolveAcceptedTurnConfirmation({', 'beginChatExecutionDurably('],
    ['task.ts', 'const taskAdmission = await admitAcceptedUserTurnDurably({', 'taskExecutionQueue.reserve(', 'beginChatExecutionDurably('],
  ])('places the %s source-order fence before confirmation, reservation, replacement and routing', (
    fileName,
    admissionMarker,
    reservationMarker,
    durableBeginMarker,
  ) => {
    const source = fs.readFileSync(path.resolve('server/socket', fileName), 'utf8');
    const admission = source.indexOf(admissionMarker);
    const persist = source.indexOf('persistAcceptedUserTurn:', admission);
    const flush = source.indexOf('flush: flushDBOrThrow', persist);
    const confirmation = source.indexOf('resolveAcceptedTurnConfirmation({', flush);
    const reservation = source.indexOf(reservationMarker, flush);
    const durableBegin = source.indexOf(durableBeginMarker, flush);
    const consume = source.indexOf('consumePendingConfirmationDurably(', flush);
    const routing = source.indexOf('buildLumiExecutionPipeline({', flush);
    expect(admission).toBeGreaterThanOrEqual(0);
    expect(persist).toBeGreaterThan(admission);
    expect(flush).toBeGreaterThan(persist);
    expect(confirmation).toBeGreaterThan(flush);
    expect(reservation).toBeGreaterThan(flush);
    expect(durableBegin).toBeGreaterThan(flush);
    expect(consume).toBeGreaterThan(flush);
    expect(routing).toBeGreaterThan(durableBegin);
  });
});
