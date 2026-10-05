import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ write: vi.fn((message: any) => 'message') }));
vi.mock('../server/conversation/manager', () => ({ addMessageIdempotent: state.write }));
import { createChatMessageWriter } from '../server/socket/chat/message_writer';

beforeEach(() => state.write.mockClear());
describe('authenticated chat message identity', () => {
  const identity = { userId: 'owner', agentId: 'lumi', domain: 'work' as const, orgId: 'org', requestId: 'request', source: 'chat' };
  it('binds both user admission and assistant terminal to the same request while preserving branch data', () => {
    const native = { nativeDeviceId: 'device', executionSessionId: 'session', nativeClientIdentitySha256: 'hash' };
    const write = createChatMessageWriter({ ...identity, getNativeBinding: () => native });
    expect(write({ conversationId: 'conversation', role: 'user', content: 'input', receivedAt: 'time', deferActionPreparation: true })).toBe('message');
    write({ conversationId: 'conversation', role: 'assistant', content: 'done', source: 'confirmation', llmWasCalled: false,
      terminalTaskDisposition: { outcome: 'blocked', taskId: 'task', requestId: 'request', reason: 'unverified' } });
    expect(state.write.mock.calls[0][0]).toMatchObject({ ...identity, ...native, channel: 'chat', role: 'user', receivedAt: 'time', deferActionPreparation: true });
    expect(state.write.mock.calls[1][0]).toMatchObject({ ...identity, ...native, source: 'confirmation', channel: 'chat', role: 'assistant', llmWasCalled: false,
      terminalTaskDisposition: { outcome: 'blocked', taskId: 'task', requestId: 'request' } });
  });
  it('does not permit a runtime message object to override request ownership', () => {
    const write = createChatMessageWriter({ ...identity, getNativeBinding: () => null });
    write({ conversationId: 'conversation', role: 'assistant', content: 'reply', userId: 'other', agentId: 'other', domain: 'personal', orgId: '', channel: 'voice', requestId: 'other' } as any);
    expect(state.write).toHaveBeenCalledExactlyOnceWith({ ...identity, channel: 'chat', conversationId: 'conversation', role: 'assistant', content: 'reply' });
  });
  it('resolves native provenance at each write so disconnected devices cannot retain stale proof', () => {
    const native = { nativeDeviceId: 'device', executionSessionId: 'session', nativeClientIdentitySha256: 'hash' };
    const getNativeBinding = vi.fn().mockReturnValueOnce(native).mockReturnValueOnce(null);
    const write = createChatMessageWriter({ ...identity, getNativeBinding });
    write({ conversationId: 'conversation', role: 'user', content: 'input' });
    write({ conversationId: 'conversation', role: 'assistant', content: 'reply' });
    expect(getNativeBinding).toHaveBeenCalledTimes(2);
    expect(state.write.mock.calls[0][0]).toMatchObject(native);
    expect(state.write.mock.calls[1][0]).not.toHaveProperty('nativeDeviceId');
  });
});
