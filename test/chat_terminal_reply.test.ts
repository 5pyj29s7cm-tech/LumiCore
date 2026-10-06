import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatTurnMessage } from '../server/socket/chat/message_writer';
import { createChatTerminalReply } from '../server/socket/chat/terminal_reply';

describe('common chat reply at the durable terminal boundary', () => {
  const write = vi.fn((message: ChatTurnMessage) => 'message');
  beforeEach(() => write.mockClear());
  it('defers assistant metadata and publication to the durable owner', async () => {
    let persisted!: () => void;
    let state = 'before';
    const publishAfter = vi.fn();
    const commit = vi.fn(async input => { persisted = input.persistAssistantMessage; return true; });
    const reply = createChatTerminalReply({ commit, write, getConversationId: () => 'accepted-conversation' });
    await expect(reply({ text: 'reply', reason: 'status', sidecar: true,
      message: () => ({ cognitiveIntent: state, llmWasCalled: false }), publishAfter, errorContext: 'status' })).resolves.toBe(true);
    expect(write).not.toHaveBeenCalled(); expect(publishAfter).not.toHaveBeenCalled();
    state = 'after'; persisted();
    expect(write).toHaveBeenCalledExactlyOnceWith({ conversationId: 'accepted-conversation', role: 'assistant',
      content: 'reply', cognitiveIntent: 'after', llmWasCalled: false });
    expect(commit.mock.calls[0][0]).toMatchObject({ payload: { text: 'reply', agentName: 'Lumi', finalized: true,
      blocked: false, reason: 'status', sidecar: true }, publishAfter, errorContext: 'status' });
    expect(commit.mock.calls[0][0].payload).not.toHaveProperty('message');
  });
  it('preserves blocked evidence and a branch-owned conversation without inventing a model call', async () => {
    const records = [{ name: 'read_file', result: 'verified receipt' }];
    const commit = vi.fn(async input => { input.persistAssistantMessage(); return false; });
    const reply = createChatTerminalReply({ commit, write, getConversationId: () => 'default' });
    await expect(reply({ text: 'incomplete', blocked: true, reason: 'unknown',
      message: () => ({ conversationId: 'task-conversation', toolCalls: records,
        terminalTaskDisposition: { outcome: 'blocked', taskId: 'task', requestId: 'request', reason: 'unknown' } }) })).resolves.toBe(false);
    expect(write.mock.calls[0][0]).toMatchObject({ conversationId: 'task-conversation', role: 'assistant', content: 'incomplete', toolCalls: records });
    expect(write.mock.calls[0][0]).not.toHaveProperty('llmWasCalled');
    expect(commit.mock.calls[0][0].payload).toMatchObject({ blocked: true, finalized: true });
  });
  it('propagates a durability error to the request owner', async () => {
    const reply = createChatTerminalReply({ commit: async () => { throw new Error('storage failed'); }, write, getConversationId: () => 'conversation' });
    await expect(reply({ text: 'reply', message: () => ({}) })).rejects.toThrow('storage failed');
    expect(write).not.toHaveBeenCalled();
  });
});
