import { describe, expect, it } from 'vitest';
import type { Server as SocketIOServer } from 'socket.io';
import type { BackgroundDelegationTask } from '../server/agents/background_tasks';
import { emitBackgroundTaskUpdate } from '../server/agents/background_task_supervisor';

function privateTask(): BackgroundDelegationTask {
  return {
    id: 'background-public-event',
    userId: 'owner',
    title: 'Prepare report',
    prompt: 'private prompt with api_key=secret-value',
    status: 'running',
    workers: [{ id: 'worker-1', name: 'Worker' }],
    workerNames: ['Worker'],
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
    checkpoint: {
      phase: 'execute',
      completedNodeIds: [],
      receiptIds: [],
      updatedAt: '2026-08-26T00:01:00.000Z',
    },
    idempotencyKey: 'private-idempotency-key',
    toolCallsCount: 1,
    cancelRequested: false,
    pauseRequested: false,
    attempt: 1,
    recoveryCount: 0,
    leaseId: 'private-lease',
    leaseOwner: 'private-owner',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:01:00.000Z',
  };
}

describe('background task socket projection', () => {
  it('never broadcasts prompt, context, provider, policy, idempotency, or lease fields', () => {
    const events: Array<{ room: string; event: string; payload: any }> = [];
    const io = {
      to(room: string) {
        return {
          emit(event: string, payload: any) {
            events.push({ room, event, payload });
          },
        };
      },
    } as unknown as SocketIOServer;

    emitBackgroundTaskUpdate(io, privateTask());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      room: 'user:owner:personal',
      event: 'agent:background_task_update',
      payload: {
        taskId: 'background-public-event',
        task: { id: 'background-public-event', status: 'running', phase: 'execute' },
      },
    });
    for (const privateField of [
      'prompt',
      'context',
      'provider',
      'toolPolicy',
      'idempotencyKey',
      'leaseId',
      'leaseOwner',
    ]) {
      expect(events[0].payload.task).not.toHaveProperty(privateField);
    }
    expect(JSON.stringify(events[0].payload)).not.toContain('secret-value');
    expect(JSON.stringify(events[0].payload)).not.toContain('private-provider');
    expect(JSON.stringify(events[0].payload)).not.toContain('private-tool');
  });

  it('does not fall back to a personal room for a malformed work scope', () => {
    const events: Array<{ room: string; event: string; payload: any }> = [];
    const io = {
      to(room: string) {
        return {
          emit(event: string, payload: any) {
            events.push({ room, event, payload });
          },
        };
      },
    } as unknown as SocketIOServer;
    const task = privateTask();
    task.context = { ...task.context, domain: 'work', orgId: '' };

    emitBackgroundTaskUpdate(io, task);

    expect(events).toEqual([]);
  });
});
