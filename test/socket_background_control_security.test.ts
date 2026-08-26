import './helpers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import {
  getBackgroundTask,
  registerBackgroundTask,
  resetBackgroundTasksForTest,
} from '../server/agents/background_tasks';
import { registerChatHandler } from '../server/socket/chat';

describe('legacy socket background controls', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  beforeEach(() => {
    resetBackgroundTasksForTest({ markHydrated: true });
  });

  it('enforces the authenticated scope and emits only a safe task projection', () => {
    const userId = `socket-background-${Date.now()}-${Math.random()}`;
    const personal = registerBackgroundTask({
      userId,
      title: 'Personal task',
      prompt: 'private prompt',
      context: {
        domain: 'personal',
        provider: 'private-provider',
        toolPolicy: {
          allowedTools: ['private-tool'],
          requireConfirmation: [],
          forbiddenTools: [],
          maxIterations: 4,
        },
      },
    });
    const work = registerBackgroundTask({
      userId,
      title: 'Work task',
      prompt: 'organization private prompt',
      context: { domain: 'work', orgId: 'org-private', provider: 'private-provider' },
    });

    const handlers = new Map<string, (data: any) => unknown>();
    const emitted: Array<{ event: string; payload: any }> = [];
    const socket = {
      id: 'socket-background-security',
      data: {
        authenticatedUserId: userId,
        authenticatedRole: 'user',
        trustedLocalExecution: true,
      },
      on(event: string, handler: (data: any) => unknown) {
        handlers.set(event, handler);
      },
      emit(event: string, payload: any) {
        emitted.push({ event, payload });
      },
    };
    const io = {
      to() {
        return { emit() {} };
      },
    };
    registerChatHandler(
      socket as never,
      {} as never,
      () => ({ audio: false, visual: false, spatial: false, haptic: false, holographic: false, activeDeviceTypes: [], deviceCount: 0 }),
      () => userId,
      io as never,
    );

    for (const event of ['agent:background_cancel', 'agent:background_pause', 'agent:background_resume']) {
      emitted.length = 0;
      handlers.get(event)?.({ taskId: work.id });
      expect(emitted.at(-1)).toMatchObject({
        event: 'agent:background_task_update',
        payload: { taskId: work.id, source: 'background_delegation' },
      });
      expect(emitted.at(-1)?.payload.error).toBeTruthy();
      expect(getBackgroundTask(work.id, userId)?.status).toBe('queued');
    }

    emitted.length = 0;
    handlers.get('agent:background_pause')?.({ taskId: personal.id });
    const publicTask = emitted.at(-1)?.payload.task;
    expect(publicTask).toMatchObject({ id: personal.id, status: 'paused' });
    for (const privateField of ['prompt', 'context', 'provider', 'toolPolicy', 'idempotencyKey', 'leaseId']) {
      expect(publicTask).not.toHaveProperty(privateField);
    }
    expect(JSON.stringify(publicTask)).not.toContain('private-provider');
    expect(JSON.stringify(publicTask)).not.toContain('private-tool');
  });
});
