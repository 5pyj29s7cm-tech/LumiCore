import { afterEach, describe, expect, it } from 'vitest';
import {
  beginChatExecution,
  beginChatSidecarExecution,
  getDurableChatCancellationForCurrentExecution,
  initializeChatExecutionRegistryPersistence,
  persistChatSidecarCancellationIntent,
  recordChatExecutionEvent,
  recordChatExecutionTerminalEventDurably,
  resetChatExecutionRegistryForTests,
  type ChatExecutionPersistenceAdapter,
  type ChatExecutionScope,
  type PersistedChatExecutionReceipt,
} from '../server/socket/chat_execution_registry';

function memoryPersistence(): ChatExecutionPersistenceAdapter {
  const rows: PersistedChatExecutionReceipt[] = [];
  const identity = (receipt: PersistedChatExecutionReceipt) => [
    receipt.userId,
    receipt.domain,
    receipt.orgId,
    receipt.source,
    receipt.conversationId,
    receipt.requestId,
  ].join('\u001f');
  return {
    async loadRecoverable(nowIso) {
      return rows
        .filter(receipt => receipt.expiresAt > nowIso)
        .map(receipt => structuredClone(receipt));
    },
    async upsert(receipt) {
      const index = rows.findIndex(candidate => identity(candidate) === identity(receipt));
      if (index >= 0) rows.splice(index, 1, structuredClone(receipt));
      else rows.push(structuredClone(receipt));
    },
    async purgeExpired(nowIso) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].expiresAt <= nowIso) rows.splice(index, 1);
      }
    },
  };
}

const scope: ChatExecutionScope = {
  userId: 'post-cancel-user',
  domain: 'personal',
  source: 'chat',
  conversationId: 'post-cancel-conversation',
};

afterEach(() => {
  resetChatExecutionRegistryForTests();
});

describe('durable post-cancellation status binding', () => {
  async function completeDurableCancellation(
    persistence: ChatExecutionPersistenceAdapter,
    options: { controlRequestId?: string; reverseTerminalOrder?: boolean } = {},
  ) {
    const controlRequestId = options.controlRequestId || 'stop-request';
    await initializeChatExecutionRegistryPersistence(persistence, Date.now());
    beginChatExecution(scope, 'foreground-request');
    expect(beginChatSidecarExecution(scope, controlRequestId)).toBe(true);
    await persistChatSidecarCancellationIntent(scope, controlRequestId, 'foreground-request');
    const terminalForeground = () => recordChatExecutionTerminalEventDurably(
      scope,
      'foreground-request',
      'agent:response',
      {
        text: '已停止当前任务。',
        agentName: 'Lumi',
        finalized: true,
        blocked: true,
        reason: 'request_cancelled',
        taskRelation: {
          binding: 'active_task',
          taskId: 'task-A',
          revision: 1,
          targetRequestId: 'foreground-request',
        },
      },
    );
    const terminalControl = () => recordChatExecutionTerminalEventDurably(
      scope,
      controlRequestId,
      'agent:response',
      {
        text: '已停止当前任务。',
        agentName: 'Lumi',
        sidecar: true,
        finalized: true,
        blocked: false,
        reason: 'cancelled_by_user',
      },
    );
    if (options.reverseTerminalOrder) {
      await terminalControl();
      await terminalForeground();
    } else {
      await terminalForeground();
      await terminalControl();
    }
  }

  it('binds through durable request relations when the foreground cancellation lands after the sidecar', async () => {
    const persistence = memoryPersistence();
    const startedAt = Date.now();
    await completeDurableCancellation(persistence, { reverseTerminalOrder: true });

    expect(getDurableChatCancellationForCurrentExecution(scope)).toMatchObject({
      controlRequestId: 'stop-request',
      targetRequestId: 'foreground-request',
      controlTerminal: {
        requestId: 'stop-request',
        terminal: true,
        terminalEvent: {
          payload: {
            controlIntent: 'cancel',
            targetRequestId: 'foreground-request',
          },
        },
      },
      targetTerminal: {
        requestId: 'foreground-request',
        status: 'cancelled',
        terminal: true,
      },
    });

    resetChatExecutionRegistryForTests();
    expect(await initializeChatExecutionRegistryPersistence(persistence, startedAt + 1_000)).toBe(2);
    expect(getDurableChatCancellationForCurrentExecution(scope)).toMatchObject({
      controlRequestId: 'stop-request',
      targetRequestId: 'foreground-request',
    });
  });

  it('fails closed for an in-memory-only target terminal', async () => {
    const persistence = memoryPersistence();
    await initializeChatExecutionRegistryPersistence(persistence, Date.now());
    beginChatExecution(scope, 'foreground-request');
    expect(beginChatSidecarExecution(scope, 'stop-request')).toBe(true);
    await persistChatSidecarCancellationIntent(scope, 'stop-request', 'foreground-request');
    expect(recordChatExecutionEvent(scope, 'foreground-request', 'agent:response', {
      text: 'not strictly durable',
      finalized: true,
      blocked: true,
      reason: 'request_cancelled',
    })).toBe(true);
    await recordChatExecutionTerminalEventDurably(scope, 'stop-request', 'agent:response', {
      text: 'stop receipt is durable',
      sidecar: true,
      finalized: true,
      blocked: false,
      reason: 'cancelled_by_user',
    });
    expect(getDurableChatCancellationForCurrentExecution(scope)).toBeNull();
  });

  it('fails closed when multiple durable tombstones name the same foreground', async () => {
    const persistence = memoryPersistence();
    await completeDurableCancellation(persistence);
    expect(beginChatSidecarExecution(scope, 'second-stop-request')).toBe(true);
    await persistChatSidecarCancellationIntent(scope, 'second-stop-request', 'foreground-request');
    await recordChatExecutionTerminalEventDurably(scope, 'second-stop-request', 'agent:response', {
      text: 'second stop',
      sidecar: true,
      finalized: true,
      blocked: false,
      reason: 'cancelled_by_user',
    });
    expect(getDurableChatCancellationForCurrentExecution(scope)).toBeNull();
  });

  it('fails closed after a newer foreground replaces the cancelled target', async () => {
    const persistence = memoryPersistence();
    await completeDurableCancellation(persistence);

    beginChatExecution(scope, 'newer-foreground-request');
    expect(getDurableChatCancellationForCurrentExecution(scope)).toBeNull();
  });

  it('fails closed after restart when the durable task fence names a newer accepted request', async () => {
    const persistence = memoryPersistence();
    const startedAt = Date.now();
    await completeDurableCancellation(persistence);
    resetChatExecutionRegistryForTests();
    expect(await initializeChatExecutionRegistryPersistence(persistence, startedAt + 1_000)).toBe(2);

    expect(getDurableChatCancellationForCurrentExecution(scope, {
      currentTask: {
        taskId: 'task-B',
        revision: 1,
        activeRequestId: 'foreground-request-B',
        unfinished: true,
      },
      relation: {
        binding: 'active_task',
        taskId: 'task-B',
        revision: 1,
        targetRequestId: 'foreground-request-B',
      },
    })).toBeNull();
    expect(getDurableChatCancellationForCurrentExecution(scope, {
      currentTask: {
        taskId: 'task-A',
        revision: 1,
        activeRequestId: 'foreground-request',
        unfinished: false,
      },
      relation: {
        binding: 'previous_task',
        taskId: 'task-A',
        revision: 1,
        targetRequestId: 'foreground-request',
      },
      requestedTarget: {
        requestId: 'foreground-request',
        taskId: 'task-A',
        revision: 1,
      },
    })).toMatchObject({ targetRequestId: 'foreground-request' });
    expect(getDurableChatCancellationForCurrentExecution(scope, {
      requestedTarget: {
        requestId: 'foreground-request',
        taskId: 'task-B',
        revision: 2,
      },
    })).toBeNull();
  });

  it('fails closed when the target receipt has expired but the control tombstone remains', async () => {
    const persistence = memoryPersistence();
    const startedAt = Date.now();
    await completeDurableCancellation(persistence);
    resetChatExecutionRegistryForTests();
    expect(await initializeChatExecutionRegistryPersistence(
      persistence,
      startedAt + 31 * 60 * 1_000,
    )).toBe(1);
    expect(getDurableChatCancellationForCurrentExecution(scope)).toBeNull();
  });
});
