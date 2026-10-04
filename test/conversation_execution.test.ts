import { describe, it, expect } from 'vitest';
import { conversationExecutionKey, reserveConversationExecution } from '../server/cognition/conversation_execution';
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
});
