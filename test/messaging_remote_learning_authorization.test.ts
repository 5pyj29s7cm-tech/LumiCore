import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import * as bindings from '../server/messaging/bindings';
import { captureMessagingBinding } from '../server/messaging/turn_authorization';
import { drainRemotePostTurnLearning, persistRemotePostTurnLearning } from '../server/regions/packs/cn/remote_memory';
import type { IncomingMessage } from '../server/messaging/types';

const extractor = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../server/memory', async original => ({
  ...(await original<typeof import('../server/memory')>()), extractMemories: extractor.run,
}));
let sequence = 0;
function fixture() {
  sequence++;
  const userId = `learning-user-${sequence}`;
  const code = bindings.createBindingCode('feishu', userId, '', 'personal');
  const binding = bindings.consumeBindingCode('feishu', code.code, `platform-${sequence}`, `chat-${sequence}`)!;
  const message: IncomingMessage = { platform: 'feishu', userId: binding.platformUserId, chatId: binding.chatId!,
    userName: 'Synthetic', chatType: 'private', messageId: `learning-${sequence}`, raw: {}, timestamp: new Date().toISOString(),
    text: 'Please remember my synthetic preference.', boundUserId: userId, bindingAuthorization: captureMessagingBinding(binding) };
  return { message, revoke: () => bindings.deleteBindingForUser(userId, binding.id) };
}
const extracted = { memories: [{ type: 'fact', content: 'Synthetic learned fact', keywords: ['synthetic'], confidence: 0.8 }], reminders: [] };
const config = { provider: 'deepseek' as const, model: 'synthetic' };
beforeAll(() => initDatabase());
afterEach(() => extractor.run.mockReset());

describe('remote post-turn learning lifecycle', () => {
  it.each(['binding', 'shutdown'] as const)('waits for already started extraction and suppresses writes after %s cancellation', async reason => {
    const { message, revoke } = fixture();
    let finish!: (value: typeof extracted) => void;
    extractor.run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let cancelled = false;
    const learning = persistRemotePostTurnLearning({ message, responseText: 'Synthetic answer', modelConfig: config, isCancelled: () => cancelled });
    expect(extractor.run).toHaveBeenCalledOnce();
    if (reason === 'binding') revoke();
    else cancelled = true;
    let drained = false;
    const draining = drainRemotePostTurnLearning().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish(extracted);
    await Promise.all([learning, draining]);
    expect(readDB().memories.some((item: any) => item.userId === message.boundUserId)).toBe(false);
  });

  it('does not start extraction after the binding has already been removed', async () => {
    const { message, revoke } = fixture();
    revoke();
    await persistRemotePostTurnLearning({ message, responseText: 'Synthetic answer', modelConfig: config });
    expect(extractor.run).not.toHaveBeenCalled();
  });

  it('preserves completed learning while the accepted identity is still authorized', async () => {
    const { message } = fixture();
    extractor.run.mockResolvedValue(extracted);
    await persistRemotePostTurnLearning({ message, responseText: 'Synthetic answer', modelConfig: config });
    expect(readDB().memories).toEqual(expect.arrayContaining([expect.objectContaining({ userId: message.boundUserId, content: 'Synthetic learned fact' })]));
  });
});
