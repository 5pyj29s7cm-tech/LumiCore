import './helpers';
import { describe, it, expect } from 'vitest';
import { executionIdempotencyKey } from '../server/tools/registry';
describe('operation identity fallback', () => {
    it('separates independent taskless requests with identical inputs', () => {
        const base = { userId: 'identity-user', actionIntent: 'send exact content' };
        const key = (requestId: string) => executionIdempotencyKey('wechat_send_message', { recipient: 'fixture', message: 'hello' }, { ...base, requestId });
        expect(key('request-a')).not.toBe(key('request-b'));
        expect(key('request-a')).toBe(key('request-a'));
    });
    it('retains the same durable task operation across a continuation request', () => {
        const base = { userId: 'identity-user', taskId: 'same-durable-task', actionIntent: 'send exact content' };
        const key = (requestId: string) => executionIdempotencyKey('wechat_send_message', { recipient: 'fixture', message: 'hello' }, { ...base, requestId });
        expect(key('request-a')).toBe(key('request-resume'));
    });
    it('preserves an explicit server journal identity', () => {
        expect(executionIdempotencyKey('fixture', {}, { idempotencyKey: 'journal-exact' })).toBe('journal-exact');
    });
});
