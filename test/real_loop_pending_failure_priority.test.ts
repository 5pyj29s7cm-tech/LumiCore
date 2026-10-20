import type { CapabilityManifestEntry } from '../server/tools/types';
import './helpers';
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import * as org from '../server/org/db';
import { toolRegistry } from '../server/tools/registry';
import { processWithPersonality } from '../server/regions/packs/cn/messaging_routes';
import * as preparation from '../server/regions/packs/cn/messaging_turn/execution_preparation';
import * as modelExecution from '../server/regions/packs/cn/messaging_turn/model_execution';
import { conversationForMessagingTurn } from '../server/regions/packs/cn/messaging_persistence';
import { getPendingConfirmation, buildTransportNeutralConfirmationScope, formatPendingConfirmationRequest } from '../server/tools/pending_confirmation';
import type { IncomingMessage } from '../server/messaging/types';
import type { LLMResult } from '../server/llm/adapter';

let seq = 0, user: string, orgId: string, mediaEntries = 0, publishEntries = 0;
beforeAll(() => initDatabase());
beforeEach(() => {
  seq++; user = 'loop-priority-user-' + seq;
  orgId = org.createOrg('Synthetic loop priority', 'loop-priority-' + seq, user).id;
  org.addMember(orgId, user, 'owner'); mediaEntries = 0; publishEntries = 0;
  toolRegistry.register({ name: 'publish_synthetic_priority_notice', description: 'Publish the synthetic notice to the exact selected URL.',
    parameters: { type: 'object', properties: { url: { type: 'string' }, content: { type: 'string' } } }, permission: 'user', securityLevel: 'safe',
    capability: { lane: 'knowledge', operation: 'communicate', sideEffects: [{ type: 'external_communication', scope: 'organization', reversible: false }] },
    evidence: { capability: 'publish_synthetic_priority_notice', operation: 'communicate', assurance: 'observed' },
    handler: async () => { publishEntries++; throw new Error('The synthetic external handler must not run.'); },
  });
  toolRegistry.register({ name: 'generate_video', description: 'Generate a synthetic local test video; this fixture always fails without a network request.',
    parameters: { type: 'object', properties: { prompt: { type: 'string' } } }, permission: 'user', securityLevel: 'safe',
    capability: { lane: 'knowledge', operation: 'create', sideEffects: [{ type: 'local_state_change', scope: 'synthetic', reversible: true }] },
    evidence: { capability: 'generate_video', operation: 'create', assurance: 'observed' },
    handler: async () => { mediaEntries++; throw new Error('Synthetic generation failed locally; no provider was invoked.'); },
  });
});
afterEach(() => vi.restoreAllMocks());
function message(): IncomingMessage {
  return { platform: 'feishu', userId: 'ou-loop-' + seq, userName: 'Synthetic', chatId: 'loop-chat-' + seq, chatType: 'private',
    messageId: 'loop-priority-' + seq, raw: {}, timestamp: new Date().toISOString(), boundUserId: user, boundOrgId: orgId,
    text: 'Use generate_video to create a synthetic video and use publish_synthetic_priority_notice to publish the exact synthetic notice to https://synthetic.example.invalid/priority.' };
}
function lookup(input: IncomingMessage) {
  const conversation = conversationForMessagingTurn(input)!;
  return getPendingConfirmation(user, buildTransportNeutralConfirmationScope({ domain: 'work', orgId, conversationId: conversation.id, taskId: conversation.actionContinuationState?.taskId }));
}
function calls(order: 'pending_first' | 'failure_first') {
  const publish = { id: 'publish-current-' + seq, type: 'function', function: { name: 'publish_synthetic_priority_notice', arguments: JSON.stringify({ url: 'https://synthetic.example.invalid/priority', content: 'Exact synthetic pending content.' }) } };
  const media = { id: 'media-current-' + seq, type: 'function', function: { name: 'generate_video', arguments: JSON.stringify({ prompt: 'Synthetic local no-network generation failure.' }) } };
  return order === 'pending_first' ? [publish, media] : [media, publish];
}
async function runActualLoop(order: 'pending_first' | 'failure_first', revokeAfterPending = false) {
  const input = message(); let actual: LLMResult | undefined;
  let receivedCapability: CapabilityManifestEntry | undefined, declaredCapability: CapabilityManifestEntry | undefined;
  const originalModel = modelExecution.prepareMessagingModelTurn;
  vi.spyOn(modelExecution, 'prepareMessagingModelTurn').mockImplementation(async context => {
    const turn = await originalModel(context);
    if (turn.data) { const observe = turn.data.prepared.onResult; turn.data.prepared.onResult = result => { actual = result; observe(result); }; }
    return turn;
  });
  const originalPrepare = preparation.prepareMessagingExecution;
  vi.spyOn(preparation, 'prepareMessagingExecution').mockImplementation(async context => {
    const prepared = await originalPrepare(context);
    if (prepared.context) {
      const target = prepared.context.remoteToolContext;
      const confirm = target.requestConfirmation;
      target.requestConfirmation = (name, args, capability?: CapabilityManifestEntry) => {
        const manifest = toolRegistry.getCapabilityManifestEntry(name, target.toolPolicy, target);
        receivedCapability = capability; declaredCapability = manifest;
        return confirm(name,args,capability);
      };
      const observe = target.onToolRecord;
      target.onToolRecord = record => { observe(record); if (revokeAfterPending && record.envelope?.status === 'waiting_confirmation') org.removeMember(orgId, user); };
    }
    return prepared;
  });
  let toolModelCalls = 0;
  const sdk = vi.fn(async (sdkInput: { tools?: Array<{ function: { name: string } }> }) => {
    if (!sdkInput.tools) return { choices: [{ message: { content: JSON.stringify({ memories: [], reminders: [] }) } }] };
    toolModelCalls++;
    const declared = (sdkInput.tools || []).map(tool => tool.function.name);
    if (!declared.includes('publish_synthetic_priority_notice') || !declared.includes('generate_video')) throw new Error('The original requested registered tools must be exposed: ' + JSON.stringify(declared));
    if (toolModelCalls > 1) throw new Error('The original tool batch must stop before any second model response.');
    return { choices: [{ message: { content: '', tool_calls: calls(order) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  });
  const pending = processWithPersonality(input, { llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create: sdk } } }) } });
  return { input, sdk, pending, toolModelCalls: () => toolModelCalls, receivedCapability: () => receivedCapability, declaredCapability: () => declaredCapability, actual: () => actual };
}

describe('real loop confirmation, hard failure and cancellation priority', () => {
  it('stops the real returned tool batch at its exact pending proposal before a queued hard media failure can run', async () => {
    const run = await runActualLoop('pending_first'); const reply = await run.pending; const proposal = lookup(run.input)!;
    expect(run.toolModelCalls()).toBe(1); expect(mediaEntries).toBe(0); expect(publishEntries).toBe(0);
    expect(run.actual()?.toolCalls?.map(record => record.name)).toEqual(['publish_synthetic_priority_notice']);
    expect(run.receivedCapability()).toEqual(run.declaredCapability());
    expect(run.receivedCapability()).toMatchObject({ metadataSources: { operation: 'tool_definition', sideEffects: 'tool_definition' }, sideEffects: [{ type: 'external_communication' }] });
    expect(run.actual()?.completionGuard?.blocked).not.toBe(true);
    expect(proposal).toMatchObject({ originRequestId: 'feishu_bot:' + run.input.messageId, target: 'https://synthetic.example.invalid/priority' });
    expect(reply).toBe(formatPendingConfirmationRequest(proposal));
    expect(readDB().conversationActionTasks.find((task: { id: string }) => task.id === proposal.taskId)?.status).toBe('waiting_confirmation');
  });

  it('stops the real batch on a hard media failure before a later publish call can create a proposal', async () => {
    const run = await runActualLoop('failure_first'); const reply = await run.pending;
    expect(run.toolModelCalls()).toBe(1); expect(mediaEntries).toBe(1); expect(publishEntries).toBe(0);
    expect(run.actual()?.toolCalls?.map(record => record.name)).toEqual(['generate_video']);
    expect(run.actual()?.completionGuard).toMatchObject({ blocked: true, reason: 'media_generation_failed' });
    expect(lookup(run.input)).toBeNull();
    expect(reply).toContain('Generation did not complete');
    expect(reply).not.toContain('Exact synthetic pending content.');
  });

  it('does not deliver or complete a proposal when membership is revoked after its real waiting receipt', async () => {
    const run = await runActualLoop('pending_first', true);
    await expect(run.pending).rejects.toMatchObject({ name: 'MessagingAuthorizationRevokedError' });
    expect(run.toolModelCalls()).toBe(1); expect(mediaEntries).toBe(0); expect(publishEntries).toBe(0);
    expect(run.actual()?.toolCalls?.some(record => record.envelope?.status === 'waiting_confirmation')).toBe(true);
    const db = readDB();
    expect(db.interactions.filter((row: { userId: string; role: string; requestId?: string }) => row.userId === user && row.role === 'assistant' && row.requestId === 'feishu_bot:' + run.input.messageId)).toEqual([]);
    expect(db.conversationActionTasks.filter((task: { userId: string; activeRequestId: string; status: string }) => task.userId === user && task.activeRequestId === 'feishu_bot:' + run.input.messageId && task.status === 'completed')).toEqual([]);
  });
});
