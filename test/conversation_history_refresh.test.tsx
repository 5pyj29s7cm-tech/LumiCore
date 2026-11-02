// @vitest-environment jsdom
import { useCallback, useRef, useState } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationTransitions } from '../src/components/agent_chat/useConversationTransitions';
import type { ConversationHistoryItem } from '../src/components/agent_chat/contracts';
import { ChatViewWorkRegistry } from '../src/lib/chatViewWork';

const notices = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast: notices }));

type Input = Parameters<typeof useConversationTransitions>[0];
type Visibility = { isOpen: boolean; isOfficeCommandCenter: boolean; activeDomain: 'personal' | 'work'; activeOrgId: string; agentId: string };
const header = (index: number): ConversationHistoryItem => ({
  id: 'history-' + index, displayTitle: 'Existing conversation ' + index,
  status: index === 0 ? 'active' : 'closed', messageCount: 5,
  createdAt: '2026-10-01T00:00:00.000Z', lastActiveAt: '2026-10-01T00:00:00.000Z',
});
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function createHistory(initialVisibility: Partial<Visibility> = {}) {
  const registry = new ChatViewWorkRegistry();
  const list = document.createElement('div');
  Object.defineProperties(list, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
  const callbacks = {
    setMessages: vi.fn(), detachPreviousExecution: vi.fn(), bindAttachmentContextToConversation: vi.fn(),
  };
  const useHarness = ({ isOpen, isOfficeCommandCenter, activeDomain, activeOrgId, agentId }: Visibility) => {
    const [history, setHistory] = useState<ConversationHistoryItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const stable = useRef({
      conversationTransitionRef: { current: null }, isCreatingConversation: false, restoringConversationId: '',
      setConversationTransitionPending: vi.fn(), setIsCreatingConversation: vi.fn(), invalidateChatViewWork: () => registry.invalidate(),
      chatViewWorkRef: { current: registry },
      ...callbacks, setPendingAttachments: vi.fn(), pendingAttachmentsRef: { current: [] },
      setSearchQuery: vi.fn(), setSearchResults: vi.fn(), setSearchError: vi.fn(),
      messageInputRef: { current: document.createElement('input') },
      conversationHistoryLoadingRef: { current: false }, conversationHistoryHasMoreRef: { current: true },
      conversationHistoryRequestRef: { current: 0 }, conversationHistoryOffsetRef: { current: 0 },
      conversationHistoryListRef: { current: list },
      attachmentConversationIdRef: { current: 'currently-visible-transcript' }, setRestoringConversationId: vi.fn(),
      normalizePersistedMessages: vi.fn((rows: unknown[]) => rows), deletingConversationId: '', t: {}, isZh: true,
      setConversationContextMenu: vi.fn(), appConfirm: vi.fn(), setDeletingConversationId: vi.fn(),
    });
    const scopedConversationUrl = useCallback((url: string) => {
      const separator = url.includes('?') ? '&' : '?';
      return url + separator + 'domain=' + activeDomain + '&agentId=' + agentId;
    }, [activeDomain, agentId]);
    const input = {
      ...stable.current, isOpen, isOfficeCommandCenter, activeDomain, activeOrgId, agentId, scopedConversationUrl,
      setConversationHistory: setHistory, conversationHistory: history,
      setConversationHistoryLoading: setLoading, setConversationHistoryLoadingMore: setLoadingMore,
      conversationHistoryHasMore: hasMore, setConversationHistoryHasMore: setHasMore,
    } as unknown as Input;
    const transitions = useConversationTransitions(input);
    return { ...transitions, history, loading, loadingMore, hasMore, refs: stable.current };
  };
  let currentProps: Visibility = { isOpen: true, isOfficeCommandCenter: true, activeDomain: 'personal', activeOrgId: '', agentId: 'lumi', ...initialVisibility };
  const hook = renderHook(useHarness, { initialProps: currentProps });
  callbacks.bindAttachmentContextToConversation.mockImplementation((id: string) => {
    hook.result.current.refs.attachmentConversationIdRef.current = id;
  });
  return { ...hook, list, callbacks, rerender: (next: Partial<Visibility>) => {
    currentProps = { ...currentProps, ...next };
    hook.rerender(currentProps);
  } };
}

function pageServer(initialRows: ConversationHistoryItem[]) {
  let rows = initialRows;
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname !== '/api/conversations') throw new Error('Unexpected navigation or transcript request: ' + input);
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Math.min(Number(url.searchParams.get('limit') || 40), 100);
    return reply({ conversations: rows.slice(offset, offset + limit), hasMore: offset + limit < rows.length });
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, replace: (next: ConversationHistoryItem[]) => { rows = next; } };
}
function assertTranscriptUntouched(hook: ReturnType<typeof createHistory>) {
  expect(hook.result.current.refs.attachmentConversationIdRef.current).toBe('currently-visible-transcript');
  for (const callback of Object.values(hook.callbacks)) expect(callback).not.toHaveBeenCalled();
}

beforeEach(() => {
  notices.error.mockReset();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('existing conversation history refresh', () => {
  it('recovers a conversation moved ahead of stale loaded pages when the command center is reopened', async () => {
    const original = Array.from({ length: 81 }, (_, index) => header(index));
    const server = pageServer(original);
    const hook = createHistory();
    await waitFor(() => expect(hook.result.current.history).toHaveLength(40));
    expect(server.fetcher).toHaveBeenCalledTimes(1);
    const moved = original[54];
    server.replace([moved, ...original.filter(row => row.id !== moved.id)]);
    act(() => hook.result.current.handleConversationHistoryScroll({ currentTarget: { scrollHeight: 1000, scrollTop: 800, clientHeight: 200 } } as any));
    await waitFor(() => expect(hook.result.current.history.length).toBeGreaterThan(40));
    expect(hook.result.current.history.some(row => row.id === moved.id)).toBe(false);
    hook.rerender({ isOpen: false });
    hook.list.scrollTop = 800;
    hook.rerender({ isOpen: true });
    await waitFor(() => expect(hook.result.current.history.some(row => row.id === moved.id)).toBe(true));
    expect(hook.result.current.history).toHaveLength(40);
    expect(hook.result.current.refs.conversationHistoryOffsetRef.current).toBe(40);
    expect(hook.list.scrollTop).toBe(0);
    assertTranscriptUntouched(hook);
  });

  it('refreshes after all conversations were loaded even when hasMore is false', async () => {
    const original = Array.from({ length: 12 }, (_, index) => header(index));
    const server = pageServer(original);
    const hook = createHistory();
    await waitFor(() => expect(hook.result.current.history).toHaveLength(12));
    expect(hook.result.current.hasMore).toBe(false);
    expect(server.fetcher).toHaveBeenCalledTimes(1);
    hook.rerender({ isOpen: false });
    server.replace([header(99), ...original]);
    hook.rerender({ isOpen: true });
    await waitFor(() => expect(hook.result.current.history[0]?.id).toBe('history-99'));
    expect(hook.result.current.history).toHaveLength(13);
    expect(hook.result.current.hasMore).toBe(false);
    expect(hook.result.current.refs.conversationHistoryOffsetRef.current).toBe(13);
    assertTranscriptUntouched(hook);
  });

  it('does not issue repeated requests after ordinary rerenders or loading state updates', async () => {
    const server = pageServer(Array.from({ length: 80 }, (_, index) => header(index)));
    const hook = createHistory();
    await waitFor(() => expect(hook.result.current.history).toHaveLength(40));
    expect(server.fetcher).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 5; index++) hook.rerender({ isOpen: true });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    expect(server.fetcher).toHaveBeenCalledTimes(1);
    hook.rerender({ isOpen: false });
    await act(async () => { await Promise.resolve(); });
    expect(server.fetcher).toHaveBeenCalledTimes(1);
    expect(hook.result.current.history).toHaveLength(40);
    assertTranscriptUntouched(hook);
  });

  it('lets a command-center reopen refresh supersede an unfinished append without accepting its late result', async () => {
    const original = Array.from({ length: 81 }, (_, index) => header(index));
    const server = pageServer(original);
    const hook = createHistory();
    await waitFor(() => expect(hook.result.current.history).toHaveLength(40));
    expect(server.fetcher).toHaveBeenCalledTimes(1);
    const held = deferred<any>();
    server.fetcher.mockImplementationOnce(() => held.promise);
    act(() => hook.result.current.handleConversationHistoryScroll({ currentTarget: { scrollHeight: 1000, scrollTop: 800, clientHeight: 200 } } as any));
    await waitFor(() => expect(hook.result.current.loadingMore).toBe(true));
    const moved = original[54];
    server.replace([moved, ...original.filter(row => row.id !== moved.id)]);
    hook.rerender({ isOpen: false });
    hook.rerender({ isOpen: true });
    await waitFor(() => expect(hook.result.current.history.some(row => row.id === moved.id)).toBe(true));
    const refreshed = hook.result.current.history;
    await act(async () => { held.resolve(reply({ conversations: original.slice(40, 80), hasMore: true })); await held.promise; });
    expect(hook.result.current.history).toEqual(refreshed);
    expect(hook.result.current.history).toHaveLength(40);
    expect(hook.result.current.refs.conversationHistoryOffsetRef.current).toBe(40);
    expect(hook.result.current.loadingMore).toBe(false);
    assertTranscriptUntouched(hook);
  });

  it('retains the old history and paging cursor if refreshing fails', async () => {
    const server = pageServer(Array.from({ length: 8 }, (_, index) => header(index)));
    const hook = createHistory();
    await waitFor(() => expect(hook.result.current.history).toHaveLength(8));
    expect(server.fetcher).toHaveBeenCalledTimes(1);
    const oldHistory = hook.result.current.history;
    hook.rerender({ isOpen: false });
    hook.list.scrollTop = 250;
    server.fetcher.mockResolvedValueOnce(reply({ error: 'History unavailable' }, 503));
    hook.rerender({ isOpen: true });
    await waitFor(() => expect(notices.error).toHaveBeenCalledWith('History unavailable'));
    expect(hook.result.current.history).toEqual(oldHistory);
    expect(hook.result.current.refs.conversationHistoryOffsetRef.current).toBe(8);
    expect(hook.result.current.hasMore).toBe(false);
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.loadingMore).toBe(false);
    expect(hook.result.current.conversationHistoryError).toBe('History unavailable');
    expect(hook.list.scrollTop).toBe(250);
    assertTranscriptUntouched(hook);
  });
  it('does not request again when the command center closes while its first page is pending', async () => {
    const server = pageServer(Array.from({ length: 80 }, (_, index) => header(index)));
    const first = deferred<any>();
    server.fetcher.mockImplementationOnce(() => first.promise);
    const hook = createHistory();
    await waitFor(() => expect(server.fetcher).toHaveBeenCalledTimes(1));
    expect(hook.result.current.loading).toBe(true);
    hook.rerender({ isOpen: false });
    hook.rerender({ isOpen: false });
    await act(async () => { await Promise.resolve(); });
    expect(server.fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(reply({ conversations: Array.from({ length: 40 }, (_, index) => header(index)), hasMore: true })); await first.promise; });
    expect(server.fetcher).toHaveBeenCalledTimes(1);
    expect(hook.result.current.history).toHaveLength(40);
    hook.rerender({ isOpen: true });
    await waitFor(() => expect(server.fetcher).toHaveBeenCalledTimes(2));
    assertTranscriptUntouched(hook);
  });

  it('waits for the office command center to be visible and refreshes when it returns', async () => {
    const server = pageServer([header(0)]);
    const hook = createHistory({ isOfficeCommandCenter: false });
    await act(async () => { await Promise.resolve(); });
    expect(server.fetcher).not.toHaveBeenCalled();
    hook.rerender({ isOfficeCommandCenter: true });
    await waitFor(() => expect(hook.result.current.history).toHaveLength(1));
    expect(server.fetcher).toHaveBeenCalledTimes(1);
    hook.rerender({ isOfficeCommandCenter: false });
    hook.rerender({ isOfficeCommandCenter: false });
    await act(async () => { await Promise.resolve(); });
    expect(server.fetcher).toHaveBeenCalledTimes(1);
    server.replace([header(99), header(0)]);
    hook.rerender({ isOfficeCommandCenter: true });
    await waitFor(() => expect(hook.result.current.history[0]?.id).toBe('history-99'));
    expect(server.fetcher).toHaveBeenCalledTimes(2);
    assertTranscriptUntouched(hook);
  });

  it('refreshes from the explicit refresh callback and clears a real error on retry', async () => {
    const original = [header(0), header(1)];
    const server = pageServer(original);
    const hook = createHistory();
    await waitFor(() => expect(hook.result.current.history).toHaveLength(2));
    server.fetcher.mockResolvedValueOnce(reply({ error: 'Refresh failed' }, 503));
    await act(async () => { await hook.result.current.refreshConversationHistory(); });
    expect(hook.result.current.conversationHistoryError).toBe('Refresh failed');
    expect(hook.result.current.history).toEqual(original);
    server.replace([header(99), ...original]);
    await act(async () => { await hook.result.current.refreshConversationHistory(); });
    expect(hook.result.current.conversationHistoryError).toBe('');
    expect(hook.result.current.history.map(row => row.id)).toEqual(['history-99', 'history-0', 'history-1']);
    expect(server.fetcher).toHaveBeenCalledTimes(3);
    assertTranscriptUntouched(hook);
  });

  it('loads additional existing headers from the explicit more callback without changing the transcript', async () => {
    const server = pageServer(Array.from({ length: 81 }, (_, index) => header(index)));
    const hook = createHistory();
    await waitFor(() => expect(hook.result.current.history).toHaveLength(40));
    await act(async () => { await hook.result.current.loadMoreConversationHistory(); });
    expect(hook.result.current.history).toHaveLength(80);
    expect(hook.result.current.refs.conversationHistoryOffsetRef.current).toBe(80);
    await act(async () => { await hook.result.current.loadMoreConversationHistory(); });
    expect(hook.result.current.history).toHaveLength(81);
    expect(hook.result.current.hasMore).toBe(false);
    expect(server.fetcher).toHaveBeenCalledTimes(3);
    assertTranscriptUntouched(hook);
  });

  it('restores an existing conversation without an extra history reload', async () => {
    const server = pageServer([header(0), header(1)]);
    const hook = createHistory();
    await waitFor(() => expect(hook.result.current.history).toHaveLength(2));
    server.fetcher.mockResolvedValueOnce(reply({ conversation: { id: 'history-1' } }));
    server.fetcher.mockResolvedValueOnce(reply({ messages: [{ id: 'saved-answer', role: 'assistant', message: 'Already delivered text' }] }));
    await act(async () => { await hook.result.current.restoreTextConversation('history-1'); });
    expect(hook.result.current.refs.attachmentConversationIdRef.current).toBe('history-1');
    expect(hook.callbacks.setMessages).toHaveBeenCalledWith([{ id: 'saved-answer', role: 'assistant', message: 'Already delivered text' }]);
    expect(hook.callbacks.bindAttachmentContextToConversation).toHaveBeenCalledTimes(1);
    expect(server.fetcher.mock.calls.map(([url]) => new URL(url, 'http://localhost').pathname)).toEqual([
      '/api/conversations', '/api/conversations/history-1/activate', '/api/conversations/history-1/messages',
    ]);
  });

  it('refreshes a changed scope and rejects a pending header page owned by the previous scope', async () => {
    const server = pageServer([header(0)]);
    const held = deferred<any>();
    server.fetcher.mockImplementationOnce(() => held.promise);
    const hook = createHistory();
    await waitFor(() => expect(server.fetcher).toHaveBeenCalledTimes(1));
    server.replace([header(99)]);
    hook.rerender({ activeDomain: 'work', activeOrgId: 'org-b' });
    await waitFor(() => expect(hook.result.current.history[0]?.id).toBe('history-99'));
    expect(new URL(server.fetcher.mock.calls[1][0], 'http://localhost').searchParams.get('domain')).toBe('work');
    await act(async () => { held.resolve(reply({ conversations: [header(0)], hasMore: false })); await held.promise; });
    expect(hook.result.current.history.map(row => row.id)).toEqual(['history-99']);
    expect(hook.result.current.refs.conversationHistoryOffsetRef.current).toBe(1);
    expect(hook.result.current.loading).toBe(false);
    expect(server.fetcher).toHaveBeenCalledTimes(2);
    assertTranscriptUntouched(hook);
  });

});
