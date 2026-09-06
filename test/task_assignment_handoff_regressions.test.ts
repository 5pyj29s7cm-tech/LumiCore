import './helpers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import * as org from '../server/org/db';
import * as routing from '../server/org/work_routing';
import { mountOrgRoutes } from '../server/org/routes';
import { processWithPersonality } from '../server/regions/packs/cn/messaging_routes';
import { flushDBOrThrow, querySQL, readDB } from '../db_layer';
import * as legalIntake from '../server/regions/packs/cn/legal_notice_intake';
import type { IncomingMessage } from '../server/messaging/types';
import { delegateTask, getTask, getTasksForSession, updateTaskStatus, resetLAPTasksForTests } from '../server/lap/delegate';
import type { LAPSession, LAPTaskDelegateRequest } from '../server/lap/types';

let url: string;
let cleanup: () => void;
let sequence = 0;
let orgId: string;
let ownerId: string;
let requester: string;
let target: string;
let department: string;
beforeAll(async () => {
  const app = await makeApp();
  url = app.url;
  cleanup = app.cleanup;
  mountOrgRoutes(app.apiRouter);
});
afterAll(() => cleanup());
beforeEach(() => {
  sequence++;
  ownerId = `r5-owner-${sequence}`;
  requester = `r5-requester-${sequence}`;
  target = `r5-target-${sequence}`;
  orgId = org.createOrg('Synthetic assignment audit', `r5-assignment-${sequence}`, ownerId).id;
  org.addMember(orgId, ownerId, 'owner');
  org.addMember(orgId, requester, 'member');
  org.addMember(orgId, target, 'member');
  department = org.createDepartment(orgId, 'Synthetic empty department').id;
});
function headers(userId: string) {
  return { 'Content-Type': 'application/json', Cookie: `token=${jwt.sign({ uid: userId, username: userId, role: 'user', orgId }, JWT_SECRET)}` };
}
function api(path: string, userId: string, body?: unknown, method = body ? 'POST' : 'GET') {
  return fetch(`${url}/api/org/org/${orgId}/${path}`, { method, headers: headers(userId), body: body ? JSON.stringify(body) : undefined });
}
function message(text: string, id: string): IncomingMessage {
  return { platform: 'feishu', userId: `ou-${requester}`, chatId: `chat-${sequence}`, userName: 'Synthetic', chatType: 'private',
    text, messageId: id, raw: {}, timestamp: new Date().toISOString(), boundUserId: requester, boundOrgId: orgId };
}
function work() {
  return routing.routeOrganizationWork({ orgId, requesterUserId: requester, source: 'feishu_bot', requestId: `direct-${sequence}`,
    text: 'Complete synthetic review', intentKind: 'general', operation: 'execute', sideEffectClass: 'read_only', targetMemberId: target }).workItem;
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Synthetic assignment checkpoint not reached');
}

describe('organization assignment and handoff regressions', () => {
  it('lists assigned work and collaborators without exposing unrelated member work', async () => {
    const item = work();
    const detail = await api(`work-items/${item.id}`, target);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ assignedMemberId: target, status: 'waiting_human' });
    const list = await api('work-items', target);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: item.id })]));
    const requesterList = await api('work-items', requester);
    expect(await requesterList.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: item.id })]));
    const unrelated = `unrelated-${sequence}`;
    org.addMember(orgId, unrelated, 'member');
    expect(await (await api(`work-items?requesterUserId=${requester}`, unrelated)).json()).toEqual([]);
    const collaborative = routing.routeOrganizationWork({ orgId, requesterUserId: requester, source: 'feishu_bot', requestId: `collaborative-${sequence}`,
      text: 'Synthetic collaboration', intentKind: 'general', operation: 'execute', sideEffectClass: 'read_only', targetMemberIds: [requester, target] }).workItem;
    expect(await (await api(`work-items?taskId=&limit=50`, target)).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: collaborative.id })]));
    expect((await api(`work-items/${item.id}`, unrelated)).status).toBe(403);
  });

  it('keeps administrator approval pending after a declined handoff, then permits the approved continuation', async () => {
    routing.createOrganizationWorkRoutingRule({ orgId, actorUserId: ownerId, name: 'Synthetic approval gate',
      keywords: ['approval-gate'], departmentId: department, approvalMode: 'admin' });
    const onMessage = vi.fn(async () => ({ platform: 'feishu' as const, text: 'Synthetic review finished.' }));
    const id = `approval-message-${sequence}`;
    const first = await processWithPersonality(message('Please complete approval-gate document review for the organization.', id), { onMessage });
    expect(first).toContain('等待组织管理员审批');
    expect(onMessage).not.toHaveBeenCalled();
    const [item] = routing.listOrganizationWorkItems(orgId);
    expect(item.status).toBe('waiting_approval');
    const requested = await api(`work-items/${item.id}/handoffs`, requester, { targetMemberId: target, reason: 'Synthetic transfer' });
    expect(requested.status).toBe(201);
    const handoff = await requested.json();
    const declined = await api(`work-handoffs/${handoff.id}/decision`, target, { decision: 'decline' });
    expect(declined.status).toBe(200);
    expect((await declined.json()).workItem.status).toBe('waiting_approval');
    expect(readDB().orgWorkApprovals.find((entry: any) => entry.id === item.approvalId)?.status).toBe('pending');
    await processWithPersonality(message('continue', `${id}-continue`), { onMessage });
    expect(onMessage).not.toHaveBeenCalled();
    expect(readDB().orgWorkApprovals.find((entry: any) => entry.id === item.approvalId)?.status).toBe('pending');
    expect((await api(`work-approvals/${item.approvalId}/decision`, ownerId, { decision: 'approve' })).status).toBe(200);
    await processWithPersonality(message('continue', `${id}-approved`), { onMessage });
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('suppresses a late completion after the recipient accepts a running task', async () => {
    let finish!: (value: { platform: 'feishu'; text: string }) => void;
    const onMessage = vi.fn(() => new Promise<{ platform: 'feishu'; text: string }>(resolve => { finish = resolve; }));
    const running = processWithPersonality(message('Please complete a synthetic document review for the organization.', `inflight-${sequence}`), { onMessage });
    await waitFor(() => onMessage.mock.calls.length === 1);
    const [item] = routing.listOrganizationWorkItems(orgId);
    expect(item).toBeTruthy();
    const requested = await api(`work-items/${item.id}/handoffs`, requester, { targetMemberId: target, reason: 'Synthetic takeover while running' });
    expect(requested.status).toBe(201);
    const handoff = await requested.json();
    const accepted = await api(`work-handoffs/${handoff.id}/decision`, target, { decision: 'accept' });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).workItem).toMatchObject({ status: 'waiting_human', humanOwnerUserId: target, revision: 2 });
    finish({ platform: 'feishu', text: 'Synthetic stale completion.' });
    expect(await running).toBe('');
    expect(routing.getOrganizationWorkItem(orgId, item.id)).toMatchObject({ status: 'waiting_human', humanOwnerUserId: target, revision: 2 });
    expect(readDB().interactions.some((entry: any) => entry.content === 'Synthetic stale completion.')).toBe(false);
  });

  it('rejects an administrator accepting a handoff to an already removed member', async () => {
    const item = routing.routeOrganizationWork({ orgId, requesterUserId: requester, source: 'feishu_bot', requestId: `orphan-${sequence}`,
      text: 'Synthetic review', intentKind: 'general', operation: 'execute', sideEffectClass: 'read_only' }).workItem;
    const requested = await api(`work-items/${item.id}/handoffs`, requester, { targetMemberId: target, reason: 'Synthetic transfer before removal' });
    expect(requested.status).toBe(201);
    const handoff = await requested.json();
    const removed = await api(`members/${target}`, ownerId, undefined, 'DELETE');
    expect(removed.status).toBe(200);
    expect(org.getMember(orgId, target)).toBeUndefined();
    const accepted = await api(`work-handoffs/${handoff.id}/decision`, ownerId, { decision: 'accept' });
    expect(accepted.status).toBeGreaterThanOrEqual(400);
    expect(routing.getOrganizationWorkItem(orgId, item.id)).toMatchObject({ assignedMemberId: null, humanOwnerUserId: null });
    expect(routing.listOrganizationWorkHandoffs(orgId, item.id)[0].status).toBe('pending');
    expect((await api(`work-items/${item.id}`, target)).status).toBe(403);
  });

  it('preserves duplicate incoming LAP task results and isolates another approved session with the same task id', () => {
    resetLAPTasksForTests();
    const session = (id: string, remote: string): LAPSession => ({ sessionId: id, authorizationStatus: 'approved', scope: ['delegate_task'],
      peerA: { agentId: remote }, peerB: { agentId: 'synthetic-local' } } as LAPSession);
    const firstSession = session('synthetic-session-a', 'synthetic-peer-a');
    const secondSession = session('synthetic-session-b', 'synthetic-peer-b');
    const request = (sessionId: string, text: string): LAPTaskDelegateRequest => ({ lap: '2.0', id: `request-${sessionId}`, sessionId,
      method: 'lap.task.delegate', timestamp: new Date().toISOString(), task: { taskId: 'synthetic-shared-task-id', type: 'probe', priority: 'normal', payload: { text } } });
    expect(delegateTask(request(firstSession.sessionId, 'first'), firstSession).accepted).toBe(true);
    expect(updateTaskStatus(firstSession.sessionId, 'synthetic-shared-task-id', 'completed', { output: 'Synthetic terminal evidence' }, undefined, 'synthetic-local')).toBe(true);
    expect(delegateTask(request(firstSession.sessionId, 'first'), firstSession)).toMatchObject({
      accepted: true, status: 'completed', result: { output: 'Synthetic terminal evidence' },
    });
    expect(delegateTask(request(secondSession.sessionId, 'replacement'), secondSession).accepted).toBe(true);
    expect(getTasksForSession(firstSession.sessionId)).toHaveLength(1);
    expect(getTask('synthetic-shared-task-id')).toBeUndefined();
    expect(getTask('synthetic-shared-task-id', firstSession.sessionId)).toMatchObject({ status: 'completed', result: { output: 'Synthetic terminal evidence' } });
    expect(getTask('synthetic-shared-task-id', secondSession.sessionId)).toMatchObject({ sessionId: secondSession.sessionId, task: { payload: { text: 'replacement' } } });
  });

  it('aborts a pending handoff immediately, rejects overlap, and never revives the old execution after decline', () => {
    const item = routing.routeOrganizationWork({ orgId, requesterUserId: requester, source: 'feishu_bot', requestId: `lease-${sequence}`,
      text: 'Synthetic review', intentKind: 'general', operation: 'execute', sideEffectClass: 'read_only' }).workItem;
    const controller = new AbortController();
    const execution = routing.registerOrganizationWorkExecution({ orgId, workItemId: item.id, actorUserId: requester, abortController: controller });
    try {
      routing.setOrganizationWorkItemExecutionStatus({ orgId, workItemId: item.id, actorUserId: requester, status: 'executing', execution });
      const handoff = routing.requestOrganizationWorkHandoff({ orgId, workItemId: item.id, actorUserId: requester, targetMemberId: target, reason: 'Synthetic handoff' })!;
      expect(controller.signal.aborted).toBe(true);
      expect(() => routing.requestOrganizationWorkHandoff({ orgId, workItemId: item.id, actorUserId: requester, targetMemberId: target, reason: 'Duplicate handoff' })).toThrow(/already pending/);
      routing.decideOrganizationWorkHandoff({ orgId, handoffId: handoff.id, actorUserId: target, decision: 'decline' });
      expect(item.status).toBe('blocked');
      expect(execution.isCurrent()).toBe(false);
      expect(routing.setOrganizationWorkItemExecutionStatus({ orgId, workItemId: item.id, actorUserId: requester, status: 'completed', execution })).toBeNull();
      expect(() => routing.registerOrganizationWorkExecution({ orgId, workItemId: item.id, actorUserId: requester, abortController: new AbortController() })).toThrow(/still settling/);
    } finally { execution.release(); }
    const next = routing.registerOrganizationWorkExecution({ orgId, workItemId: item.id, actorUserId: requester, abortController: new AbortController() });
    try {
      expect(routing.setOrganizationWorkItemExecutionStatus({ orgId, workItemId: item.id, actorUserId: requester, status: 'completed', execution })).toBeNull();
      expect(routing.setOrganizationWorkItemExecutionStatus({ orgId, workItemId: item.id, actorUserId: requester, status: 'completed', execution: next })?.status).toBe('completed');
    } finally { next.release(); }
  });

  it('renews approval for an accepted new target and preserves approval while another handoff is pending', () => {
    routing.createOrganizationWorkRoutingRule({ orgId, actorUserId: ownerId, name: 'Synthetic guarded routing', keywords: ['approval-renew'], departmentId: department, approvalMode: 'admin' });
    const route = routing.routeOrganizationWork({ orgId, requesterUserId: requester, source: 'feishu_bot', requestId: `renew-${sequence}`,
      text: 'approval-renew', intentKind: 'general', operation: 'execute', sideEffectClass: 'read_only' });
    const firstApproval = route.approval!.id;
    const handoff = routing.requestOrganizationWorkHandoff({ orgId, workItemId: route.workItem.id, actorUserId: requester, targetDepartmentId: department, reason: 'Explicit department transfer' })!;
    routing.decideOrganizationWorkApproval({ orgId, approvalId: firstApproval, actorUserId: ownerId, decision: 'approve' });
    expect(route.workItem.status).toBe('waiting_human');
    routing.decideOrganizationWorkHandoff({ orgId, handoffId: handoff.id, actorUserId: ownerId, decision: 'accept' });
    expect(route.workItem).toMatchObject({ status: 'waiting_approval', revision: 2 });
    expect(route.workItem.approvalId).not.toBe(firstApproval);
    expect(() => routing.registerOrganizationWorkExecution({ orgId, workItemId: route.workItem.id, actorUserId: requester, abortController: new AbortController() })).toThrow(/approval/i);
    routing.decideOrganizationWorkApproval({ orgId, approvalId: route.workItem.approvalId!, actorUserId: ownerId, decision: 'approve' });
    const execution = routing.registerOrganizationWorkExecution({ orgId, workItemId: route.workItem.id, actorUserId: requester, abortController: new AbortController() });
    execution.release();
  });

  it('keeps late transaction receipts but does not publish a completion for the new human owner', async () => {
    let finish!: (text: string) => void;
    const intake = vi.spyOn(legalIntake, 'handleRemoteLegalNoticeIntake').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const running = processWithPersonality(message('查询组织知识库 synthetic-evidence', `receipt-${sequence}`));
    try {
      await waitFor(() => Boolean(finish));
      const [item] = routing.listOrganizationWorkItems(orgId);
      const handoff = routing.requestOrganizationWorkHandoff({ orgId, workItemId: item.id, actorUserId: requester, targetMemberId: target, reason: 'Synthetic ownership change' })!;
      routing.decideOrganizationWorkHandoff({ orgId, handoffId: handoff.id, actorUserId: target, decision: 'accept' });
      finish('Synthetic local transaction receipt.');
      expect(await running).toBe('');
      expect(routing.getOrganizationWorkItem(orgId, item.id)?.status).toBe('waiting_human');
      expect(readDB().conversationActionReceipts.some((receipt: any) => receipt.taskId === item.taskId && receipt.toolName === 'organization_business_command' && receipt.outcome === 'verified_success')).toBe(true);
      expect(readDB().interactions.some((entry: any) => entry.content === 'Synthetic local transaction receipt.')).toBe(false);
    } finally { intake.mockRestore(); }
  });

  it('does not let a late execution error block the new human owner', async () => {
    let fail!: (reason: Error) => void;
    const callback = vi.fn(() => new Promise<never>((_resolve, reject) => { fail = reject; }));
    const running = processWithPersonality(message('Please complete a synthetic document review for the organization.', `late-error-${sequence}`), { onMessage: callback });
    await waitFor(() => Boolean(fail));
    const [item] = routing.listOrganizationWorkItems(orgId);
    const handoff = routing.requestOrganizationWorkHandoff({ orgId, workItemId: item.id, actorUserId: requester, targetMemberId: target, reason: 'Synthetic transfer' })!;
    routing.decideOrganizationWorkHandoff({ orgId, handoffId: handoff.id, actorUserId: target, decision: 'accept' });
    fail(new Error('Synthetic obsolete model error'));
    expect(await running).toBe('');
    expect(routing.getOrganizationWorkItem(orgId, item.id)).toMatchObject({ status: 'waiting_human', humanOwnerUserId: target, lastBlocker: '' });
  });

  it('persists the pre-handoff state and enforces pending approval for legacy handoffs without that snapshot', async () => {
    routing.createOrganizationWorkRoutingRule({ orgId, actorUserId: ownerId, name: 'Synthetic legacy gate', keywords: ['legacy-approval'], departmentId: department, approvalMode: 'admin' });
    const route = routing.routeOrganizationWork({ orgId, requesterUserId: requester, source: 'feishu_bot', requestId: `legacy-${sequence}`,
      text: 'legacy-approval', intentKind: 'general', operation: 'execute', sideEffectClass: 'read_only' });
    const handoff = routing.requestOrganizationWorkHandoff({ orgId, workItemId: route.workItem.id, actorUserId: requester, targetMemberId: target, reason: 'Persist original state' })!;
    await flushDBOrThrow();
    const [stored] = await querySQL<{ payload: string }>('SELECT payload FROM org_work_handoffs WHERE id = ?', [handoff.id]);
    expect(JSON.parse(stored.payload)).toMatchObject({ fromStatus: 'waiting_approval', fromCollaboratorMemberIds: [] });
    delete handoff.fromStatus;
    delete handoff.fromBlocker;
    delete handoff.fromCollaboratorMemberIds;
    route.workItem.status = 'assigned';
    expect(() => routing.registerOrganizationWorkExecution({ orgId, workItemId: route.workItem.id, actorUserId: requester, abortController: new AbortController() })).toThrow(/approval/i);
    routing.decideOrganizationWorkHandoff({ orgId, handoffId: handoff.id, actorUserId: target, decision: 'decline' });
    expect(route.workItem.status).toBe('waiting_approval');
  });
});
