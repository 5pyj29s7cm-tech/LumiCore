import { describe, it, expect } from 'vitest';
import { conversationExecutionKey, reserveConversationExecution, getConversationExecution, getCurrentConversationExecution, cancelConversationExecution, captureConversationExecutionCancellation } from '../server/cognition/conversation_execution';
const scope = { userId: 'resource-fixture', domain: 'personal' as const, conversationId: 'conversation' };
describe('conversation execution resource', () => {
    it('serializes sources using the same user/domain/organization/conversation resource', async () => {
        expect(conversationExecutionKey({ ...scope, source: 'chat' } as any)).toBe(conversationExecutionKey({ ...scope, source: 'voice' } as any));
        const first = reserveConversationExecution(scope, 'first'), second = reserveConversationExecution(scope, 'second');
        await first.waitForTurn();
        let entered = false;
        const waiting = second.waitForTurn().then(() => { entered = true; });
        await Promise.resolve();
        expect(entered).toBe(false);
        first.release();
        await waiting;
        expect(entered).toBe(true);
        second.release();
    });
    it('keeps other users, domains, organizations and conversations independent', async () => {
        const first = reserveConversationExecution(scope, 'scope-first');
        await first.waitForTurn();
        for (const other of [{ ...scope, userId: 'other' }, { ...scope, conversationId: 'other' }, { ...scope, domain: 'work' as const, orgId: 'org-a' }, { ...scope, domain: 'work' as const, orgId: 'org-b' }]) {
            const lease = reserveConversationExecution(other, 'other');
            await lease.waitForTurn();
            lease.release();
        }
        first.release();
    });
    it('cancelled queued requests cannot overtake the active predecessor or admit a successor early', async () => {
        const first = reserveConversationExecution(scope, 'active'), abort = new AbortController();
        const cancelled = reserveConversationExecution(scope, 'cancelled', abort.signal), last = reserveConversationExecution(scope, 'last');
        await first.waitForTurn();
        const failed = cancelled.waitForTurn().then(() => false, () => true);
        let entered = false;
        const waiting = last.waitForTurn().then(() => { entered = true; });
        abort.abort();
        await Promise.resolve();
        expect(entered).toBe(false);
        first.release();
        expect(await failed).toBe(true);
        await waiting;
        cancelled.release();
        last.release();
    });
    it('rejects a duplicate modern request without handing a second executor the same lease', async () => {
        const first = reserveConversationExecution(scope, 'duplicate');
        expect(() => reserveConversationExecution(scope, 'duplicate')).toThrow(/already owns/);
        first.release();
    });
    it('source-fenced controls cannot cancel another transport in the shared FIFO', async () => {
        const voiceScope = { ...scope, source: 'voice' }, chatScope = { ...scope, source: 'chat' };
        const voice = reserveConversationExecution(voiceScope, 'voice-owner');
        const chat = reserveConversationExecution(chatScope, 'chat-waiter');
        await voice.waitForTurn();
        expect(getConversationExecution(chatScope, 'voice-owner')).toBeUndefined();
        expect(getCurrentConversationExecution(chatScope)?.requestId).toBe('chat-waiter');
        expect(await cancelConversationExecution(chatScope, 'voice-owner')).toBe(false);
        expect(voice.controller.signal.aborted).toBe(false);
        expect(await cancelConversationExecution(chatScope, 'chat-waiter')).toBe(true);
        expect(chat.controller.signal.aborted).toBe(true);
        const rejected = chat.waitForTurn().catch(() => 'cancelled');
        voice.release();
        expect(await rejected).toBe('cancelled');
        chat.release();
    });
    it('keeps equal client request ids in different sources distinct while serializing their execution', async () => {
        const chatScope = { ...scope, source: 'chat' }, voiceScope = { ...scope, source: 'voice' };
        const first = reserveConversationExecution(chatScope, 'equal-id');
        const second = reserveConversationExecution(voiceScope, 'equal-id');
        await first.waitForTurn();
        expect(await cancelConversationExecution(voiceScope, 'equal-id')).toBe(true);
        expect(first.controller.signal.aborted).toBe(false);
        const waiting = second.waitForTurn().catch(() => 'cancelled');
        first.release();
        expect(await waiting).toBe('cancelled');
        second.release();
    });
});

it('cancels only the source-fenced owners captured before newer requests arrive', async () => {
  const resource = { ...scope, conversationId: 'accepted-replacement', source: 'chat' };
  const first = reserveConversationExecution(resource, 'accepted-first');
  const queued = reserveConversationExecution(resource, 'accepted-queued');
  await first.waitForTurn();
  const queuedResult = queued.waitForTurn().then(() => 'entered', () => 'cancelled');
  const cancelAccepted = captureConversationExecutionCancellation(resource);
  const newer = reserveConversationExecution(resource, 'newer-arrival');
  const otherSource = reserveConversationExecution({ ...resource, source: 'voice' }, 'other-source');
  const cancellation = cancelAccepted();
  expect(first.controller.signal.aborted).toBe(true);
  expect(queued.controller.signal.aborted).toBe(true);
  expect(newer.controller.signal.aborted).toBe(false);
  expect(otherSource.controller.signal.aborted).toBe(false);
  first.release();
  expect(await queuedResult).toBe('cancelled');
  await cancellation;
  await newer.waitForTurn(); newer.release();
  await otherSource.waitForTurn(); otherSource.release();
  queued.release();
});
