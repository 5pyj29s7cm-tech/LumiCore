import './helpers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB, writeDB, flushDBOrThrow } from '../db_layer';
import * as org from '../server/org/db';
import * as bindings from '../server/messaging/bindings';
import * as journal from '../server/messaging/message_journal';
import type { IncomingMessage } from '../server/messaging/types';

const model = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../server/llm/providers', async original => ({
  ...(await original<typeof import('../server/llm/providers')>()), makeLLMCall: model.call,
}));

let routes: typeof import('../server/regions/packs/cn/messaging_routes');
let sequence = 0;
let userId: string;
let orgId: string;
let message: IncomingMessage;
let binding: bindings.MessagingBinding;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Message did not settle');
}
const done = () => ['ignored', 'completed', 'superseded'].includes(journal.getMessagingJournalEntry(message)?.status || '');
const personalityRegistry = { buildSystemPrompt: () => ({
  config: { id: 'lumi', toolPolicy: { allowedTools: [], requireConfirmation: [], forbiddenTools: ['*'], maxIterations: 0 } },
  systemPrompt: 'Synthetic system',
}) } as any;

beforeAll(async () => {
  await initDatabase();
  routes = await import('../server/regions/packs/cn/messaging_routes');
});
beforeEach(() => {
  sequence++;
  userId = `revocation-user-${sequence}`;
  orgId = org.createOrg('Synthetic', `revocation-org-${sequence}`, userId).id;
  org.addMember(orgId, userId, 'member');
  message = { platform: 'feishu', userId: `platform-${sequence}`, userName: 'Synthetic',
    chatId: `chat-${sequence}`, chatType: 'private', messageId: `revocation-message-${sequence}`, text: '你好', raw: {},
    timestamp: new Date().toISOString(), attachments: [{ id: 'attachment', type: 'file', fileName: 'synthetic.txt' }] };
  const code = bindings.createBindingCode('feishu', userId, orgId, 'work');
  binding = bindings.consumeBindingCode('feishu', code.code, message.userId, message.chatId)!;
  readDB().memories.push({ id: `secret-${sequence}`, userId, orgId, domain: 'work', content: '你好 synthetic confidential memory',
    confidence: 0.8, type: 'episodic', source: 'manual', perspective: 'owner_trait', tier: 'episodic', importance: 0.8,
    agentId: 'lumi', nodeType: 'leaf', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), keywords: [] });
  writeDB(readDB());
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No network permitted')));
  model.call.mockReset().mockRejectedValue(new Error('Unexpected model call'));
});
afterEach(async () => { await flushDBOrThrow(); vi.unstubAllGlobals(); });

describe('remote message authorization remains bound to its accepted identity', () => {
  it.each(['binding', 'membership', 'membership_replaced', 'replacement'] as const)('stops before memory, execution and delivery after %s revocation during attachment work', async reason => {
    const gate = deferred<IncomingMessage>();
    let captured: IncomingMessage | undefined;
    let replacementUser: string | undefined;
    const { queryMemories } = await import('../server/memory');
    const memoryRead = vi.fn(queryMemories);
    const onMessage = vi.fn(async () => ({ platform: 'feishu' as const, text: 'synthetic reply' }));
    const reply = vi.fn(async () => 'reply-id');
    expect(routes.dispatchIncomingMessage(message, { enrich: async value => { captured = value; return gate.promise; }, reply },
      { queryMemories: memoryRead, personalityRegistry, onMessage })).toBe(true);
    await waitFor(() => Boolean(captured));
    if (reason === 'binding') bindings.deleteBindingForUser(userId, binding.id, orgId, 'work');
    else if (reason === 'membership') org.removeMember(orgId, userId);
    else if (reason === 'membership_replaced') {
      org.removeMember(orgId, userId);
      org.addMember(orgId, userId, 'member');
    }
    else {
      replacementUser = `replacement-${sequence}`;
      org.addMember(orgId, replacementUser, 'member');
      const code = bindings.createBindingCode('feishu', replacementUser, orgId, 'work');
      const replacement = bindings.consumeBindingCode('feishu', code.code, message.userId, message.chatId)!;
      expect(replacement.revision).not.toBe(binding.revision);
    }
    gate.resolve(captured!);
    await waitFor(done);
    expect(journal.getMessagingJournalEntry(message)?.status).toBe('ignored');
    expect(memoryRead).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    if (replacementUser) {
      message = { ...message, messageId: `${message.messageId}-new-binding` };
      routes.dispatchIncomingMessage(message, { enrich: async value => value, reply }, { queryMemories: memoryRead, personalityRegistry, onMessage });
      await waitFor(done);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ boundUserId: replacementUser, boundOrgId: orgId }));
      expect(reply).toHaveBeenCalledOnce();
    }
  });

  it('preserves a normal authorized memory read and reply', async () => {
    const { queryMemories } = await import('../server/memory');
    const memoryRead = vi.fn(queryMemories);
    const onMessage = vi.fn(async () => ({ platform: 'feishu' as const, text: 'synthetic reply' }));
    const reply = vi.fn(async () => 'reply-id');
    routes.dispatchIncomingMessage(message, { enrich: async value => value, reply }, { queryMemories: memoryRead, personalityRegistry, onMessage });
    await waitFor(done);
    expect(memoryRead.mock.results[0].value).toEqual(expect.arrayContaining([expect.objectContaining({ id: `secret-${sequence}` })]));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ boundUserId: userId, boundOrgId: orgId }));
    expect(reply).toHaveBeenCalledOnce();
  });

  it('suppresses an already running callback result after its binding is deleted', async () => {
    const gate = deferred<{ platform: 'feishu'; text: string }>();
    const onMessage = vi.fn(() => gate.promise);
    const reply = vi.fn(async () => 'reply-id');
    routes.dispatchIncomingMessage(message, { enrich: async value => value, reply }, { personalityRegistry, onMessage });
    await waitFor(() => onMessage.mock.calls.length === 1);
    bindings.deleteBindingForUser(userId, binding.id, orgId, 'work');
    gate.resolve({ platform: 'feishu', text: 'must never be delivered' });
    await waitFor(done);
    expect(reply).not.toHaveBeenCalled();
  });

  it('aborts an active model request when organization membership is removed', async () => {
    let signal: AbortSignal | undefined;
    model.call.mockImplementation((_messages, _tools, prefs) => {
      signal = prefs.signal;
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      });
    });
    const reply = vi.fn(async () => 'reply-id');
    routes.dispatchIncomingMessage(message, { enrich: async value => value, reply }, { personalityRegistry });
    await waitFor(() => Boolean(signal));
    org.removeMember(orgId, userId);
    await waitFor(done);
    expect(signal!.aborted).toBe(true);
    expect(reply).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('closes admission immediately and waits for an accepted attachment route to settle on shutdown', async () => {
    const gate = deferred<IncomingMessage>();
    let captured: IncomingMessage | undefined;
    const onMessage = vi.fn(async () => ({ platform: 'feishu' as const, text: 'must stop' }));
    const reply = vi.fn(async () => 'reply-id');
    routes.dispatchIncomingMessage(message, { enrich: async value => { captured = value; return gate.promise; }, reply }, { onMessage });
    await waitFor(() => Boolean(captured));
    let drained = false;
    const draining = routes.stopMessagingIngressAndDrain().then(() => { drained = true; });
    expect(routes.dispatchIncomingMessage({ ...message, messageId: 'after-close' }, { enrich: async value => value, reply }, { onMessage })).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(drained).toBe(false);
    gate.resolve(captured!);
    await draining;
    expect(journal.getMessagingJournalEntry(message)?.status).toBe('ignored');
    expect(onMessage).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});
