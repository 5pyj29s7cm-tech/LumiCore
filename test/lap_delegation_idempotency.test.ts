import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelTasksForSession,
  getTask,
  getTasksForSession,
  registerOutboundTask,
  resetLAPTasksForTests,
  updateTaskStatus,
} from '../server/lap/delegate';
import type { LAPSession, LAPTaskDelegateRequest, LAPTaskStatus } from '../server/lap/types';

function session(id: string): LAPSession {
  return { sessionId: id, authorizationStatus: 'approved', scope: ['delegate_task'],
    peerA: { agentId: `peer-${id}` }, peerB: { agentId: 'local-agent' } } as LAPSession;
}
function request(scope: LAPSession, payload = { text: 'synthetic' }): LAPTaskDelegateRequest {
  return { lap: '2.0', id: `request-${scope.sessionId}`, sessionId: scope.sessionId,
    method: 'lap.task.delegate', timestamp: new Date().toISOString(),
    task: { taskId: 'same-task-id', type: 'synthetic-probe', priority: 'normal', payload } };
}

describe('LAP immutable delegation identities', () => {
  beforeEach(() => resetLAPTasksForTests());
  afterEach(() => { vi.restoreAllMocks(); resetLAPTasksForTests(); });

  it('projects a missing peer result as unknown after its deadline', () => {
    const scope = session('expired-outbound');
    const input = request(scope);
    input.task.deadline = new Date(Date.now() + 1000).toISOString();
    registerOutboundTask(input.task, scope, scope.peerA.agentId);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    expect(getTask(input.task.taskId, scope.sessionId)).toMatchObject({ status: 'unknown', error: expect.stringContaining('deadline') });
  });

  it.each(['completed', 'failed', 'unknown'] as LAPTaskStatus[])('returns an existing %s receipt after its deadline without resetting it', status => {
    const scope = session('a');
    const input = request(scope);
    input.task.deadline = new Date(Date.now() + 10_000).toISOString();
    expect(registerOutboundTask(input.task, scope, scope.peerA.agentId).status).toBe('pending');
    expect(updateTaskStatus(scope.sessionId, input.task.taskId, status, { evidence: 'synthetic' }, 'original detail', 'local-agent')).toBe(true);
    const original = structuredClone(getTask(input.task.taskId, scope.sessionId));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20_000);
    expect(registerOutboundTask(input.task, scope, scope.peerA.agentId)).toMatchObject({
      status, result: { evidence: 'synthetic' }, error: 'original detail',
    });
    expect(getTask(input.task.taskId, scope.sessionId)).toEqual(original);
  });

  it('isolates updates and revocation between approved sessions sharing a task id', () => {
    const first = session('first');
    const second = session('second');
    registerOutboundTask(request(first).task, first, first.peerA.agentId);
    registerOutboundTask(request(second, { text: 'other workspace' }).task, second, second.peerA.agentId);
    expect(updateTaskStatus(first.sessionId, 'same-task-id', 'completed', { value: 'first result' }, undefined, 'local-agent')).toBe(true);
    expect(cancelTasksForSession(second.sessionId)).toBe(1);
    expect(getTasksForSession(first.sessionId)).toMatchObject([{ status: 'completed', result: { value: 'first result' } }]);
    expect(getTasksForSession(second.sessionId)).toMatchObject([{ status: 'failed', error: 'Session revoked' }]);
    expect(getTask('same-task-id')).toBeUndefined();
  });

  it('rejects changed payloads and opposite senders without mutating the original task', () => {
    const scope = session('immutable');
    const input = request(scope);
    expect(registerOutboundTask(input.task, scope, scope.peerA.agentId).status).toBe('pending');
    input.task.payload.text = 'changed after acceptance';
    expect(() => registerOutboundTask(input.task, scope, scope.peerA.agentId)).toThrow(/immutable payload/);
    expect(() => registerOutboundTask(request(scope).task, scope, 'local-agent')).toThrow(/immutable payload/);
    expect(getTask(input.task.taskId, scope.sessionId)?.task.payload).toEqual({ text: 'synthetic' });
    expect(registerOutboundTask(request(scope).task, scope, scope.peerA.agentId).status).toBe('pending');
  });

  it('treats object property order as the same immutable payload and keeps terminal evidence immutable', () => {
    const scope = session('ordered');
    const input = request(scope);
    input.task.payload = { a: 1, nested: { b: 2, c: 3 } };
    expect(registerOutboundTask(input.task, scope, scope.peerA.agentId).status).toBe('pending');
    const evidence = { result: { a: 1, b: 2 } };
    expect(updateTaskStatus(scope.sessionId, input.task.taskId, 'completed', evidence, undefined, 'local-agent')).toBe(true);
    evidence.result.a = 99;
    const retry = request(scope);
    retry.task.payload = { nested: { c: 3, b: 2 }, a: 1 };
    const response = registerOutboundTask(retry.task, scope, scope.peerA.agentId);
    expect(response).toMatchObject({ status: 'completed', result: { result: { a: 1, b: 2 } } });
    expect(updateTaskStatus(scope.sessionId, input.task.taskId, 'completed', { result: { b: 2, a: 1 } }, undefined, 'local-agent')).toBe(true);
    expect(updateTaskStatus(scope.sessionId, input.task.taskId, 'completed', { result: 'replacement' }, undefined, 'local-agent')).toBe(false);
    expect(getTask(input.task.taskId, scope.sessionId)?.result).toEqual({ result: { a: 1, b: 2 } });
  });

});
