import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelTasksForSession,
  delegateTask,
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

  it.each(['completed', 'failed', 'unknown'] as LAPTaskStatus[])('returns an existing %s receipt after its deadline without resetting it', status => {
    const scope = session('a');
    const input = request(scope);
    input.task.deadline = new Date(Date.now() + 10_000).toISOString();
    expect(delegateTask(input, scope)).toMatchObject({ accepted: true, status: 'accepted' });
    expect(updateTaskStatus(scope.sessionId, input.task.taskId, status, { evidence: 'synthetic' }, 'original detail', 'local-agent')).toBe(true);
    const original = structuredClone(getTask(input.task.taskId, scope.sessionId));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20_000);
    expect(delegateTask({ ...input, id: 'transport-retry' }, scope)).toMatchObject({
      accepted: true, status, result: { evidence: 'synthetic' }, error: 'original detail',
    });
    expect(getTask(input.task.taskId, scope.sessionId)).toEqual(original);
  });

  it('isolates updates and revocation between approved sessions sharing a task id', () => {
    const first = session('first');
    const second = session('second');
    expect(delegateTask(request(first), first).accepted).toBe(true);
    expect(delegateTask(request(second, { text: 'other workspace' }), second).accepted).toBe(true);
    expect(updateTaskStatus(first.sessionId, 'same-task-id', 'completed', { value: 'first result' }, undefined, 'local-agent')).toBe(true);
    expect(cancelTasksForSession(second.sessionId)).toBe(1);
    expect(getTasksForSession(first.sessionId)).toMatchObject([{ status: 'completed', result: { value: 'first result' } }]);
    expect(getTasksForSession(second.sessionId)).toMatchObject([{ status: 'failed', error: 'Session revoked' }]);
    expect(getTask('same-task-id')).toBeUndefined();
  });

  it('rejects changed payloads and opposite senders without mutating the original task', () => {
    const scope = session('immutable');
    const input = request(scope);
    expect(delegateTask(input, scope).accepted).toBe(true);
    input.task.payload.text = 'changed after acceptance';
    expect(delegateTask(input, scope)).toMatchObject({ accepted: false });
    expect(delegateTask(request(scope), scope, 'local-agent')).toMatchObject({ accepted: false });
    expect(getTask(input.task.taskId, scope.sessionId)?.task.payload).toEqual({ text: 'synthetic' });
    expect(() => registerOutboundTask(input.task, scope, scope.peerA.agentId)).toThrow(/immutable payload/);
    expect(registerOutboundTask(request(scope).task, scope, scope.peerA.agentId).status).toBe('accepted');
  });

  it('treats object property order as the same immutable payload and keeps terminal evidence immutable', () => {
    const scope = session('ordered');
    const input = request(scope);
    input.task.payload = { a: 1, nested: { b: 2, c: 3 } };
    expect(delegateTask(input, scope).accepted).toBe(true);
    const evidence = { result: { a: 1, b: 2 } };
    expect(updateTaskStatus(scope.sessionId, input.task.taskId, 'completed', evidence, undefined, 'local-agent')).toBe(true);
    evidence.result.a = 99;
    const retry = request(scope);
    retry.task.payload = { nested: { c: 3, b: 2 }, a: 1 };
    const response = delegateTask(retry, scope);
    expect(response).toMatchObject({ accepted: true, status: 'completed', result: { result: { a: 1, b: 2 } } });
    response.result!.result.a = 999;
    expect(updateTaskStatus(scope.sessionId, input.task.taskId, 'completed', { result: { b: 2, a: 1 } }, undefined, 'local-agent')).toBe(true);
    expect(updateTaskStatus(scope.sessionId, input.task.taskId, 'completed', { result: 'replacement' }, undefined, 'local-agent')).toBe(false);
    expect(getTask(input.task.taskId, scope.sessionId)?.result).toEqual({ result: { a: 1, b: 2 } });
  });

  it('does not disclose existing receipts to a revoked session or mismatched authenticated session', () => {
    const scope = session('authorized');
    const input = request(scope);
    delegateTask(input, scope);
    updateTaskStatus(scope.sessionId, input.task.taskId, 'completed', { synthetic: 'private result' }, undefined, 'local-agent');
    scope.authorizationStatus = 'revoked';
    expect(delegateTask(input, scope)).toMatchObject({ accepted: false });
    expect(delegateTask(input, scope)).not.toHaveProperty('result');
    const other = session('other');
    expect(delegateTask(input, other)).toMatchObject({ accepted: false });
  });
});
