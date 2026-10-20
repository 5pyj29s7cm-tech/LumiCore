import './helpers';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB, flushDBOrThrow } from '../db_layer';
import * as org from '../server/org/db';
import * as orgKB from '../server/org/kb';
import * as routing from '../server/org/work_routing';
import * as preparation from '../server/regions/packs/cn/messaging_turn/execution_preparation';
import { processWithPersonality } from '../server/regions/packs/cn/messaging_routes';
import { toolRegistry, ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import type { IncomingMessage } from '../server/messaging/types';
import type { ToolContext, ToolDefinition } from '../server/tools/types';

let sequence = 0;
let orgId: string, owner: string, member: string, department: string;
beforeAll(() => initDatabase());
beforeEach(() => {
  sequence++; owner = 'admit-owner-' + sequence; member = 'admit-member-' + sequence;
  orgId = org.createOrg('Synthetic admission', 'admit-' + sequence, owner).id;
  org.addMember(orgId, owner, 'owner'); org.addMember(orgId, member, 'member');
  department = org.createDepartment(orgId, 'Synthetic empty department').id;
});
afterEach(() => vi.restoreAllMocks());
function message(text: string, id = 'admit-' + sequence): IncomingMessage {
  return { platform: 'feishu', userId: 'ou-' + member, userName: 'Synthetic', chatId: 'chat-' + sequence,
    chatType: 'private', text, messageId: id, raw: {}, timestamp: new Date().toISOString(), boundUserId: member, boundOrgId: orgId };
}
function policy(approvalMode: 'admin' | 'none' = 'admin') {
  return routing.createOrganizationWorkRoutingRule({ orgId, actorUserId: owner, name: 'Synthetic gate',
    keywords: [], departmentId: department, approvalMode, requireApprovalForExternalCommit: true });
}
async function run(text: string, action?: (context: ToolContext) => Promise<void>, legacy = vi.fn(), id = 'admit-' + sequence) {
  let context: ToolContext | undefined;
  const original = preparation.prepareMessagingExecution;
  const spy = vi.spyOn(preparation, 'prepareMessagingExecution').mockImplementation(async input => {
    const result = await original(input); context = result.context?.remoteToolContext; return result;
  });
  let called = false;
  const create = vi.fn(async () => {
    if (!called && action) { called = true; expect(context).toBeTruthy(); await action(context!); }
    return { choices: [{ message: { content: 'Synthetic explanation.' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  });
  try {
    const reply = await processWithPersonality(message(text, id), { onMessage: legacy,
      llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } });
    return { reply, create, legacy };
  } finally { spy.mockRestore(); }
}
function registerRead(handler: ToolDefinition['handler'] = vi.fn(async () => JSON.stringify({ ok: true, status: 'observed' })), write = false) {
  const name = 'org_admission_read_' + sequence;
  toolRegistry.register({ name, description: 'Read the synthetic organization admission fixture.',
    parameters: { type: 'object', properties: {} }, permission: 'user', securityLevel: 'safe',
    capability: { lane: 'knowledge', operation: write ? 'create' : 'observe', sideEffects: [{ type: write ? 'local_write' : 'local_read', scope: 'organization', reversible: true }] },
    evidence: { capability: 'org_admission_read', operation: write ? 'create' : 'observe', assurance: 'observed' }, handler });
  return { name, handler };
}
function route(requestId: string, sideEffectClass = 'none', taskId = 'task-' + sequence) {
  return routing.routeOrganizationWork({ orgId, requesterUserId: member, source: 'feishu_bot', requestId,
    idempotencyKey: 'organization-work:' + requestId, text: 'Complete synthetic organization work',
    intentKind: 'work_task', operation: sideEffectClass === 'none' ? 'observe' : 'communicate', sideEffectClass,
    conversationId: 'conversation-' + sequence, taskId });
}

describe('organization selected-adapter admission', () => {
  it.each(['组织工作台有哪些功能？只解释，不执行操作。', '不要调用工具，只解释组织审批的含义。'])('does not create organization work for an ordinary explanation: %s', async text => {
    const outcome = await run(text);
    expect(outcome.create).toHaveBeenCalled();
    expect(routing.listOrganizationWorkItems(orgId)).toEqual([]);
    expect(outcome.legacy).not.toHaveBeenCalled();
  });

  it('blocks the first canonical adapter before handler entry while organization approval is pending', async () => {
    policy(); const probe = registerRead();
    const outcome = await run('Please complete a synthetic document review for the organization.', async context => {
      await executeToolCall({ registry: toolRegistry, id: 'selected-read-' + sequence, name: probe.name, arguments: {}, context });
    });
    expect(probe.handler).not.toHaveBeenCalled();
    expect(outcome.legacy).not.toHaveBeenCalled();
    expect(outcome.reply).toContain('等待组织管理员审批');
    const items = routing.listOrganizationWorkItems(orgId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: 'waiting_approval', sideEffectClass: 'none', requestId: 'feishu_bot:admit-' + sequence });
    expect(items[0].taskId).toBeTruthy();
  });

  it('reuses the same request work item and canonical idempotency instead of creating a second task or effect', async () => {
    const effect = vi.fn(async (_args: Record<string, unknown>, context?: ToolContext) => {
      const article = orgKB.createArticle(orgId, context!.userId!, { title: 'Synthetic once', content: 'One exact write.' }, { index: false });
      return JSON.stringify({ ok: true, status: 'completed', articleId: article.id });
    });
    const probe = registerRead(effect, true);
    await run('Please complete a synthetic document review for the organization.', async context => {
      const call = { registry: toolRegistry, id: 'same-selected-read-' + sequence, name: probe.name, arguments: {}, context };
      const first = await executeToolCall(call), second = await executeToolCall(call);
      expect(first.envelope?.status).toBe('verified_success');
      expect(second.envelope?.status).toBe('verified_success');
      expect(first.taskId).toBe(second.taskId);
      expect(first.requestId).toBe(second.requestId);
    });
    expect(probe.handler).toHaveBeenCalledTimes(1);
    expect(orgKB.listArticles(orgId, {}, member)).toHaveLength(1);
    expect(routing.listOrganizationWorkItems(orgId)).toHaveLength(1);
  });

  it('places a real native organization archive behind the same approval fence', async () => {
    policy();
    const input = message('把附件保存到组织知识库');
    input.attachments = [{ id: 'synthetic-attachment', type: 'file', fileName: 'Synthetic.txt', extractedText: 'Synthetic local archive content.' }];
    const reply = await processWithPersonality(input);
    expect(reply).toContain('等待组织管理员审批');
    expect(routing.listOrganizationWorkItems(orgId)).toHaveLength(1);
    expect(orgKB.listArticles(orgId, {}, member)).toEqual([]);
    await flushDBOrThrow();
  });

  it('raises none to external commit monotonically and expires the approved lower-risk revision before execution', () => {
    policy(); const first = route('risk-' + sequence);
    const oldApproval = first.approval!.id;
    routing.decideOrganizationWorkApproval({ orgId, approvalId: oldApproval, actorUserId: owner, decision: 'approve' });
    const controller = new AbortController();
    const execution = routing.registerOrganizationWorkExecution({ orgId, workItemId: first.workItem.id, actorUserId: member, abortController: controller });
    const stronger = route('risk-' + sequence, 'external_commit');
    expect(stronger.created).toBe(false);
    expect(stronger.workItem).toMatchObject({ id: first.workItem.id, revision: 2, status: 'waiting_approval', sideEffectClass: 'external_commit' });
    expect(stronger.approval?.id).not.toBe(oldApproval);
    expect(readDB().orgWorkApprovals.find((row: { id: string }) => row.id === oldApproval)?.status).toBe('expired');
    expect(controller.signal.aborted).toBe(true);
    expect(execution.isCurrent()).toBe(false);
    expect(() => routing.registerOrganizationWorkExecution({ orgId, workItemId: first.workItem.id, actorUserId: member, abortController: new AbortController() })).toThrow(/approval/i);
    execution.release();
    const laterRead = route('risk-' + sequence, 'none');
    expect(laterRead.workItem).toMatchObject({ revision: 2, sideEffectClass: 'external_commit', approvalId: stronger.approval!.id, status: 'waiting_approval' });
    expect(routing.listOrganizationWorkItems(orgId)).toHaveLength(1);
  });

  it('does not reuse another requester or conversation authority with the same idempotency key', () => {
    const first = route('bound-' + sequence);
    expect(() => routing.routeOrganizationWork({ orgId, requesterUserId: owner, source: 'feishu_bot', requestId: first.workItem.requestId,
      idempotencyKey: first.workItem.idempotencyKey, text: first.workItem.textDigest, intentKind: 'work_task', operation: 'observe',
      sideEffectClass: 'none', conversationId: first.workItem.conversationId, taskId: first.workItem.taskId })).toThrow(/another accepted request/);
    expect(routing.listOrganizationWorkItems(orgId)).toHaveLength(1);
  });


  it('resumes an approved canonical action under the original task without creating a new organization owner', async () => {
    policy(); const probe = registerRead();
    const action = async (context: ToolContext) => { await executeToolCall({ registry: toolRegistry, id: 'approved-read-' + sequence, name: probe.name, arguments: {}, context }); };
    await run('Please complete a synthetic document review for the organization.', action);
    const first = routing.listOrganizationWorkItems(orgId)[0];
    routing.decideOrganizationWorkApproval({ orgId, approvalId: first.approvalId!, actorUserId: owner, decision: 'approve' });
    await run('continue', action, vi.fn(), 'approved-continuation-' + sequence);
    expect(probe.handler).toHaveBeenCalledTimes(1);
    expect(routing.listOrganizationWorkItems(orgId)).toHaveLength(1);
    expect(routing.listOrganizationWorkItems(orgId)[0].taskId).toBe(first.taskId);
    expect(readDB().conversationActionReceipts).toEqual(expect.arrayContaining([expect.objectContaining({
      taskId: first.taskId, requestId: 'feishu_bot:approved-continuation-' + sequence, toolName: probe.name, outcome: 'verified_success',
    })]));
  });

  it('keeps an assigned human owner ahead of the adapter and does not invoke the removed opaque organization callback', async () => {
    const target = 'human-' + sequence; org.addMember(orgId, target, 'member');
    routing.createOrganizationWorkRoutingRule({ orgId, actorUserId: owner, name: 'Human gate', keywords: [], memberId: target });
    const probe = registerRead();
    const outcome = await run('Please complete a synthetic document review for the organization.', async context => {
      await executeToolCall({ registry: toolRegistry, id: 'human-read-' + sequence, name: probe.name, arguments: {}, context });
    });
    expect(probe.handler).not.toHaveBeenCalled(); expect(outcome.legacy).not.toHaveBeenCalled();
    expect(outcome.reply).toContain(target);
    expect(routing.listOrganizationWorkItems(orgId)[0]).toMatchObject({ status: 'waiting_human', humanOwnerUserId: target });
  });

  it('refuses a native organization write when the caller omits the shared admission fence', async () => {
    const input = message('把附件保存到组织知识库');
    input.attachments = [{ id: 'no-fence', type: 'file', fileName: 'Synthetic.txt', extractedText: 'No admission.' }];
    const { handleRemoteOrgCommand } = await import('../server/regions/packs/cn/remote_org_commands');
    await expect(handleRemoteOrgCommand(input)).rejects.toThrow(/admission fence/);
    expect(orgKB.listArticles(orgId, {}, member)).toEqual([]);
  });


  it.each([{ domain: 'personal' as const, orgId: '' }, { domain: 'work' as const, orgId: 'different-organization' }])('does not let a native organization branch reuse a mismatched accepted domain: %j', async scope => {
    const { withRemoteOrganizationAction } = await import('../server/regions/packs/cn/remote_org_commands');
    const handler = vi.fn(async () => 'Synthetic changed state'); const onAdapterStart = vi.fn();
    await expect(withRemoteOrganizationAction(message('明确归档'), { ...scope, onAdapterStart }, 'create', {}, handler)).rejects.toThrow(/matching scoped admission fence/);
    expect(handler).not.toHaveBeenCalled(); expect(onAdapterStart).not.toHaveBeenCalled();
  });

  it('supplies the pinned capability and bound arguments before handler entry without letting observer mutation change them', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async (args: Record<string, unknown>) => JSON.stringify({ ok: true, status: 'observed', target: args.target }));
    registry.register({ name: 'org_pinned_read', description: 'Synthetic pinned read', parameters: { type: 'object', properties: {} },
      permission: 'public', securityLevel: 'safe', serverOwnedArgumentBinder: () => ({ target: 'server-bound' }),
      evidence: { capability: 'pinned', operation: 'observe', assurance: 'observed' }, handler });
    const record = await executeToolCall({ registry, name: 'org_pinned_read', arguments: { target: 'forged' }, context: {
      onAdapterStart: call => {
        expect(handler).not.toHaveBeenCalled(); expect(call.arguments.target).toBe('server-bound'); expect(call.capability.operation).toBe('observe');
        (call.arguments as Record<string, unknown>).target = 'observer-change'; call.capability.operation = 'communicate';
      },
    } });
    expect(handler.mock.calls[0][0].target).toBe('server-bound');
    expect(record.capability?.operation).toBe('observe');
  });
});
