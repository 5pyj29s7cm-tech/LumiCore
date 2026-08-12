import './helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushDB, initDatabase, readDB, writeDB } from '../db_layer';
import { canInspectSession, canUseSession, claimSession } from '../server/lap/access';
import { shareContext, resetSharedContextsForTests } from '../server/lap/context';
import { buildTaskListResponse, delegateTask, registerOutboundTask, resetLAPTasksForTests, updateTaskStatus } from '../server/lap/delegate';
import { createSession, resetLAPSessionsForTests } from '../server/lap/session';
import type { LAPAgentIdentity } from '../server/lap/types';

const remote: LAPAgentIdentity = {
  agentId: 'remote-lumi', userId: 'remote-owner', name: 'Remote Lumi', capabilities: ['notify'], publicKey: 'remote-key',
};
const local: LAPAgentIdentity = {
  agentId: 'local-lumi', userId: 'local-owner', name: 'Local Lumi', capabilities: ['notify'], publicKey: 'local-key',
};
const personalScope = { userId: 'owner-a', domain: 'personal' as const, orgId: '' };

describe('LAP workspace authorization', () => {
  beforeEach(async () => {
    await initDatabase();
    resetLAPSessionsForTests();
    resetLAPTasksForTests();
    resetSharedContextsForTests();
    const db = readDB();
    db.settings = (db.settings || []).filter((item: any) => item.key !== '__lumi_lap_session_bindings_v1');
    writeDB(db);
  });

  afterEach(async () => {
    resetLAPSessionsForTests();
    resetLAPTasksForTests();
    resetSharedContextsForTests();
    await flushDB();
  });

  it('keeps handshake sessions inert until the exact workspace claims the peer', () => {
    const session = createSession(remote, local, 'public', ['share_context', 'delegate_task'], personalScope);

    expect(canInspectSession(session, personalScope)).toBe(true);
    expect(canUseSession(session, personalScope)).toBe(false);
    expect(delegateTask({ lap: '2.0', id: 'd1', sessionId: session.sessionId, timestamp: new Date().toISOString(), method: 'lap.task.delegate', task: { taskId: 'task-1', type: 'probe', priority: 'normal', payload: {} } }, session).accepted).toBe(false);
    expect(shareContext({ lap: '2.0', id: 'c1', sessionId: session.sessionId, timestamp: new Date().toISOString(), method: 'lap.context.share', contexts: [{ type: 'knowledge', scope: 'session', payload: 'public fact', confidence: 0.8 }] }, session).accepted).toBe(false);

    expect(claimSession({ sessionId: session.sessionId, peerAgentId: remote.agentId, scope: personalScope }).ok).toBe(true);
    expect(canUseSession(session, personalScope)).toBe(true);
    expect(canUseSession(session, { userId: 'owner-b', domain: 'personal', orgId: '' })).toBe(false);
  });

  it('rejects claim attempts from another organization or with the wrong peer identity', () => {
    const session = createSession(remote, local, 'public', ['notify'], { userId: 'member-a', domain: 'work', orgId: 'org-a' });

    expect(claimSession({ sessionId: session.sessionId, peerAgentId: remote.agentId, scope: { userId: 'member-a', domain: 'work', orgId: 'org-b' } })).toMatchObject({ ok: false });
    expect(claimSession({ sessionId: session.sessionId, peerAgentId: 'spoofed-peer', scope: { userId: 'member-a', domain: 'work', orgId: 'org-a' } })).toMatchObject({ ok: false });
  });

  it('binds outbound results to the exact peer and archives late results without replay', () => {
    const session = createSession(remote, local, 'public', ['delegate_task'], personalScope);
    expect(claimSession({ sessionId: session.sessionId, peerAgentId: remote.agentId, scope: personalScope }).ok).toBe(true);
    const task = { taskId: 'probe-late', type: 'sandbox_capability_probe', priority: 'normal' as const, payload: {} };
    registerOutboundTask(task, session, local.agentId);

    expect(updateTaskStatus(session.sessionId, task.taskId, 'completed', { answer: 'spoofed' }, undefined, 'another-agent')).toBe(false);
    expect(updateTaskStatus(session.sessionId, task.taskId, 'unknown', undefined, 'transport timeout', remote.agentId)).toBe(true);
    expect(updateTaskStatus(session.sessionId, task.taskId, 'completed', { answer: 'late result' }, undefined, remote.agentId)).toBe(true);
    expect(updateTaskStatus(session.sessionId, task.taskId, 'running', undefined, undefined, remote.agentId)).toBe(false);

    expect(buildTaskListResponse([registerOutboundTask(task, session, local.agentId)], { includeResult: true })).toMatchObject({
      tasks: [{ taskId: task.taskId, status: 'completed', result: { answer: 'late result' }, receiptStatus: 'peer_reported_late' }],
    });
  });
});
