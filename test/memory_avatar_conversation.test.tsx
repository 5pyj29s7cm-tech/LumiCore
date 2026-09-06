// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock('../src/services/memoryAvatarService', () => ({ memoryAvatarService: mocks }));
import { useMemoryAvatarConversation } from '../src/hooks/useMemoryAvatarConversation';
import { chatExecutionStorageKey } from '../src/lib/chatExecutionRecovery';
import { upsertPersistedPendingChatExecution } from '../src/lib/chatEventReceipts';

function socket() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    connected: true, emit: vi.fn(),
    on(name: string, callback: (...args: any[]) => void) { const group = listeners.get(name) || new Set(); group.add(callback); listeners.set(name, group); },
    off(name: string, callback: (...args: any[]) => void) { listeners.get(name)?.delete(callback); },
    receive(name: string, ...data: any[]) { for (const callback of listeners.get(name) || []) callback(...data); },
    count: () => [...listeners.values()].reduce((count, group) => count + group.size, 0),
  };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const owner = { userId: 'owner-a', agentId: 'memory_avatar_a', domain: 'personal' as const, orgId: '', source: 'memory-avatar' };
beforeEach(() => { mocks.history.mockReset().mockResolvedValue([]); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function ready(result: any) { await waitFor(() => expect(result.current.loading).toBe(false)); }

it('sends one private avatar request and rejects other people, request IDs and channels', async () => {
  const transport = socket();
  const { result } = renderHook(() => useMemoryAvatarConversation({ socket: transport, ownerId: owner.userId, avatarId: owner.agentId, locale: 'en' }));
  await ready(result);
  act(() => { expect(result.current.send('A synthetic story')).toBe(true); expect(result.current.send('duplicate click')).toBe(false); });
  const [, payload] = transport.emit.mock.calls.find(call => call[0] === 'agent:chat')!;
  expect(payload).toMatchObject({ agentId: owner.agentId, source: 'memory-avatar', domain: 'personal', orgId: null });
  expect(payload).not.toHaveProperty('history');
  act(() => {
    transport.receive('agent:chunk', { requestId: payload.requestId, agentId: 'memory_avatar_b', text: 'other person' });
    transport.receive('agent:chunk', { requestId: 'old-request', agentId: owner.agentId, text: 'old request' });
    transport.receive('agent:chunk', { requestId: payload.requestId, agentId: owner.agentId, source: 'chat', text: 'other channel' });
  });
  expect(result.current.messages).toHaveLength(1);
  act(() => transport.receive('agent:chunk', { requestId: payload.requestId, agentId: owner.agentId, text: 'A remembered story from this person.' }));
  expect(result.current.messages.at(-1)).toMatchObject({ text: 'A remembered story from this person.', pending: true });
  act(() => transport.receive('agent:response', { requestId: payload.requestId, agentId: owner.agentId, source: 'memory-avatar', text: 'A remembered story.' }));
  expect(result.current.messages).toHaveLength(2);
  expect(result.current.messages.at(-1)).toMatchObject({ text: 'A remembered story.', pending: false });
  expect(result.current.busy).toBe(false);
});

it('removes an unconfirmed streamed reply on terminal error and permits a new turn', async () => {
  const transport = socket();
  const { result } = renderHook(() => useMemoryAvatarConversation({ socket: transport, ownerId: owner.userId, avatarId: owner.agentId, locale: 'en' }));
  await ready(result);
  act(() => { result.current.send('Synthetic request'); });
  const [, payload] = transport.emit.mock.calls.find(call => call[0] === 'agent:chat')!;
  act(() => transport.receive('agent:chunk', { ...payload, text: 'This long reply is not yet confirmed.' }));
  expect(result.current.messages.at(-1)?.pending).toBe(true);
  act(() => {
    transport.receive('agent:error', { ...payload, message: 'Save could not be confirmed' });
  });
  expect(result.current.messages.map((row: any) => row.text)).toEqual(['Synthetic request']);
  expect(result.current.busy).toBe(false);
  expect(result.current.error).toContain('Save');
});

it('uses the authenticated owner storage and resumes the exact request after remount', async () => {
  const transport = socket();
  const options = { socket: transport, ownerId: owner.userId, avatarId: owner.agentId, locale: 'en' as const };
  const first = renderHook(() => useMemoryAvatarConversation(options)); await ready(first.result);
  act(() => { first.result.current.send('Remember this request'); });
  const [, payload] = transport.emit.mock.calls.find(call => call[0] === 'agent:chat')!;
  first.unmount(); expect(transport.count()).toBe(0);
  const second = renderHook(() => useMemoryAvatarConversation(options)); await ready(second.result);
  const resume = transport.emit.mock.calls.find(call => call[0] === 'agent:execution_resume');
  expect(resume?.[1]).toMatchObject({ requestId: payload.requestId, source: owner.source, domain: 'personal' });
  act(() => {
    resume?.[2]({ ok: true, snapshot: { ...resume[1], terminal: true, terminalEvent: { event: 'agent:response' } } });
    transport.receive('agent:response', { ...payload, text: 'Recovered reply', replayed: true });
  });
  expect(second.result.current.messages.filter(row => row.role === 'assistant').map(row => row.text)).toEqual(['Recovered reply']);
  second.unmount(); transport.emit.mockClear();
  const third = renderHook(() => useMemoryAvatarConversation({ ...options, ownerId: 'owner-b' })); await ready(third.result);
  expect(transport.emit.mock.calls.some(call => call[0] === 'agent:execution_resume')).toBe(false);
});

it('never adopts unowned legacy pending records', async () => {
  const transport = socket();
  localStorage.setItem(chatExecutionStorageKey(owner), JSON.stringify(upsertPersistedPendingChatExecution(null, {
    requestId: 'legacy', source: owner.source, domain: 'personal', startedAt: new Date().toISOString(),
  })));
  const { result } = renderHook(() => useMemoryAvatarConversation({ socket: transport, ownerId: owner.userId, avatarId: owner.agentId, locale: 'en' }));
  await ready(result);
  expect(transport.emit).not.toHaveBeenCalled(); expect(result.current.busy).toBe(false);
});

it('discards old history after an account or avatar change', async () => {
  const transport = socket(); const old = deferred<any[]>();
  mocks.history.mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ id: 'new', role: 'assistant', content: 'New person only' }]);
  const { result, rerender } = renderHook(({ ownerId, avatarId }) => useMemoryAvatarConversation({ socket: transport, ownerId, avatarId, locale: 'en' }), { initialProps: { ownerId: owner.userId, avatarId: owner.agentId } });
  rerender({ ownerId: 'owner-b', avatarId: 'memory_avatar_b' }); await ready(result);
  await act(async () => { old.resolve([{ id: 'old', role: 'assistant', content: 'Private old person' }]); });
  expect(result.current.messages.map(row => row.text)).toEqual(['New person only']);
});

it('deduplicates persisted voice turns by request ID and preserves accepted live turns during history loading', async () => {
  const transport = socket(); const history = deferred<any[]>(); mocks.history.mockReturnValueOnce(history.promise);
  const { result } = renderHook(() => useMemoryAvatarConversation({ socket: transport, ownerId: owner.userId, avatarId: owner.agentId, locale: 'en' }));
  act(() => {
    result.current.appendVoiceTranscript('Spoken sentence', true, { requestId: 'voice-1' });
    result.current.appendVoiceResponse('Spoken reply', { requestId: 'voice-1' });
    result.current.appendVoiceResponse('Spoken reply', { requestId: 'voice-1' });
  });
  await act(async () => { history.resolve([{ id: 'db-user', requestId: 'voice-1', role: 'user', content: 'Spoken sentence' }, { id: 'db-assistant', requestId: 'voice-1', role: 'assistant', content: 'Spoken reply' }]); });
  expect(result.current.messages).toHaveLength(2);
  expect(result.current.messages.map(row => row.text)).toEqual(['Spoken sentence', 'Spoken reply']);
});

it('shows a history read failure and clears it after a successful retry', async () => {
  const transport = socket();
  mocks.history.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
  const { result } = renderHook(() => useMemoryAvatarConversation({ socket: transport, ownerId: owner.userId, avatarId: owner.agentId, locale: 'en' }));
  await ready(result); expect(result.current.error).toContain('history');
  await act(async () => { await result.current.refresh(); }); expect(result.current.error).toBe('');
});

it('replaces corrupt recovery JSON and resumes the newly accepted request after remount', async () => {
  const transport = socket();
  const options = { socket: transport, ownerId: owner.userId, avatarId: owner.agentId, locale: 'en' as const };
  localStorage.setItem(chatExecutionStorageKey(owner), '{broken');
  const first = renderHook(() => useMemoryAvatarConversation(options)); await ready(first.result);
  act(() => { expect(first.result.current.send('A recoverable synthetic story')).toBe(true); });
  const [, payload] = transport.emit.mock.calls.find(call => call[0] === 'agent:chat')!;
  expect(JSON.parse(localStorage.getItem(chatExecutionStorageKey(owner))!).pending[0]).toMatchObject({ requestId: payload.requestId, userId: owner.userId });
  first.unmount();
  const next = renderHook(() => useMemoryAvatarConversation(options)); await ready(next.result);
  expect(transport.emit.mock.calls.find(call => call[0] === 'agent:execution_resume')?.[1].requestId).toBe(payload.requestId);
  expect(transport.emit.mock.calls.filter(call => call[0] === 'agent:chat')).toHaveLength(1);
});

it('keeps an uncertain recovery acknowledgement pending and retries only reconciliation on reconnect', async () => {
  const transport = socket();
  const { result } = renderHook(() => useMemoryAvatarConversation({ socket: transport, ownerId: owner.userId, avatarId: owner.agentId, locale: 'en' })); await ready(result);
  act(() => { result.current.send('One original turn'); transport.receive('connect'); });
  const resume = transport.emit.mock.calls.find(call => call[0] === 'agent:execution_resume')!;
  act(() => resume[2]({ ok: false, error: 'temporarily unavailable' }));
  expect(result.current.busy).toBe(true);
  expect(JSON.parse(localStorage.getItem(chatExecutionStorageKey(owner))!).pending).toHaveLength(1);
  act(() => { expect(result.current.send('repeat')).toBe(false); transport.receive('connect'); });
  expect(transport.emit.mock.calls.filter(call => call[0] === 'agent:chat')).toHaveLength(1);
  const retry = transport.emit.mock.calls.filter(call => call[0] === 'agent:execution_resume').at(-1)!;
  expect(retry[1].requestId).toBe(resume[1].requestId);
  act(() => retry[2]({ ok: false, error: 'Execution not found or no longer recoverable' }));
  await ready(result);
  expect(result.current.busy).toBe(false);
  expect(JSON.parse(localStorage.getItem(chatExecutionStorageKey(owner))!).pending).toEqual([]);
});

it('rejects retained callbacks from a previous owner, including after switching back to that account', async () => {
  const transport = socket();
  const { result, rerender } = renderHook(({ ownerId }) => useMemoryAvatarConversation({ socket: transport, ownerId, avatarId: owner.agentId, locale: 'en' }), { initialProps: { ownerId: owner.userId } }); await ready(result);
  const old = result.current;
  rerender({ ownerId: 'owner-b' }); await ready(result);
  rerender({ ownerId: owner.userId }); await ready(result);
  const reads = mocks.history.mock.calls.length;
  await act(async () => {
    expect(old.send('Old account callback')).toBe(false);
    old.appendVoiceTranscript('Old transcript', true);
    old.appendVoiceResponse('Old response');
    await old.refresh();
  });
  expect(result.current.messages).toEqual([]);
  expect(mocks.history).toHaveBeenCalledTimes(reads);
  expect(transport.emit).not.toHaveBeenCalled();
  act(() => { expect(result.current.send('Current account')).toBe(true); });
});

it('never sends without an authenticated owner after sign-out', async () => {
  const transport = socket();
  const { result, rerender } = renderHook(({ ownerId }) => useMemoryAvatarConversation({ socket: transport, ownerId, avatarId: owner.agentId, locale: 'en' }), { initialProps: { ownerId: owner.userId } }); await ready(result);
  rerender({ ownerId: '' });
  act(() => { expect(result.current.send('Unsigned request')).toBe(false); });
  expect(transport.emit).not.toHaveBeenCalled();
});
