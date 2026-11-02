// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import { useChatAttachmentsAndPresentation } from '../src/components/agent_chat/state/use_chat_attachments_and_presentation';
import { useConversationHistorySearch } from '../src/components/agent_chat/conversation_history_search';
import { useConversationTransitions } from '../src/components/agent_chat/useConversationTransitions';
import type { ConversationHistoryItem } from '../src/components/agent_chat/contracts';
import { ChatViewWorkRegistry } from '../src/lib/chatViewWork';

vi.mock('../src/hooks/useGeneratedLibrary', () => ({
  useGeneratedLibrary: () => ({ files: [], loading: false, failed: false, refresh: vi.fn() }),
}));
vi.mock('../src/hooks/useConversationAttachments', () => ({
  useConversationAttachments: () => ({ conversationAttachments: [], conversationAttachmentsRef: { current: [] },
    attachmentConversationIdRef: { current: 'current-chat' }, bindAttachmentContextToConversation: vi.fn(),
    rememberConversationAttachments: vi.fn(), clearConversationAttachments: vi.fn() }),
}));
vi.mock('../src/components/MediaGenerationStudio', () => ({ EMPTY_MEDIA_GENERATION_SOURCES: {} }));

type Bindings = Parameters<typeof useChatAttachmentsAndPresentation>[0];
function bindings() {
  return {
    user: { uid: 'user-a', id: 'user-a', username: 'user-a' }, activeDomain: 'work', activeOrgId: 'org-a', agentId: 'lumi',
    isCreationWorkspace: false, isOpen: true, isOfficeCommandCenter: true, t: {}, messages: [],
    pendingAttachments: [], mediaSourceArtifacts: [], mediaGenerationArtifacts: [], platform: 'web',
    pendingAttachmentsRef: { current: [] }, inputDictationActiveRef: { current: false }, localCallState: 'idle',
    chatProgressClearTimerRef: { current: null }, chatTurnTimerGuardRef: { current: { dispose: vi.fn() } },
  } as unknown as Bindings;
}
function nextScope(previous: Bindings, kind: 'account' | 'organization'): Bindings {
  return kind === 'account'
    ? { ...previous, user: { ...previous.user!, uid: 'user-b', id: 'user-b', username: 'user-b' } }
    : { ...previous, activeOrgId: 'org-b' };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
const response = (conversationId: string) => ({ ok: true, json: async () => ({ results: [{ conversationId, message: conversationId }] }) });
function useRealSearch(input: Bindings) {
  const producer = useChatAttachmentsAndPresentation(input);
  return { callback: producer.scopedConversationUrl, search: useConversationHistorySearch('same query', producer.scopedConversationUrl, 0) };
}
function useRealHistory(input: Bindings) {
  const producer = useChatAttachmentsAndPresentation(input);
  const [history, setHistory] = useState<ConversationHistoryItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const stable = useRef({
    conversationTransitionRef: { current: null }, isCreatingConversation: false, restoringConversationId: '',
    setConversationTransitionPending: vi.fn(), setIsCreatingConversation: vi.fn(), invalidateChatViewWork: vi.fn(),
    chatViewWorkRef: { current: new ChatViewWorkRegistry() }, setMessages: vi.fn(), detachPreviousExecution: vi.fn(),
    bindAttachmentContextToConversation: vi.fn(), setPendingAttachments: vi.fn(), pendingAttachmentsRef: { current: [] },
    setSearchQuery: vi.fn(), setSearchResults: vi.fn(), setSearchError: vi.fn(),
    messageInputRef: { current: document.createElement('input') },
    conversationHistoryLoadingRef: { current: false }, conversationHistoryHasMoreRef: { current: true },
    conversationHistoryRequestRef: { current: 0 }, conversationHistoryOffsetRef: { current: 0 },
    conversationHistoryListRef: { current: null }, attachmentConversationIdRef: { current: 'current-chat' },
    setRestoringConversationId: vi.fn(), normalizePersistedMessages: vi.fn(), deletingConversationId: '', isZh: false,
    setConversationContextMenu: vi.fn(), appConfirm: vi.fn(), setDeletingConversationId: vi.fn(),
    setConversationHistoryLoading: vi.fn(), setConversationHistoryLoadingMore: vi.fn(),
  });
  const transitions = useConversationTransitions({ ...input, ...stable.current, scopedConversationUrl: producer.scopedConversationUrl,
    conversationHistory: history, setConversationHistory: setHistory, conversationHistoryHasMore: hasMore,
    setConversationHistoryHasMore: setHasMore } as unknown as Parameters<typeof useConversationTransitions>[0]);
  return { ...transitions, history, refs: stable.current };
}
const historyResponse = (id: string) => ({ ok: true, json: async () => ({ conversations: [{ id, title: id }], hasMore: false }) });
beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('real conversation URL producer scope isolation', () => {
  it('clears loaded headers and starts a fresh first page for a different account without changing domain or organization', async () => {
    const fresh = deferred<ReturnType<typeof historyResponse>>();
    const fetcher = vi.mocked(fetch).mockResolvedValueOnce(historyResponse('old-account') as Response)
      .mockImplementationOnce(() => fresh.promise as Promise<Response>);
    const first = bindings();
    const view = renderHook(({ input }) => useRealHistory(input), { initialProps: { input: first } });
    await waitFor(() => expect(view.result.current.history[0]?.id).toBe('old-account'));
    view.rerender({ input: nextScope(first, 'account') });
    expect(view.result.current.history).toEqual([]);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0]).toBe(fetcher.mock.calls[0][0]);
    expect(String(fetcher.mock.calls[1][0])).toContain('offset=0');
    await act(async () => { fresh.resolve(historyResponse('new-account')); await fresh.promise; });
    expect(view.result.current.history.map(row => row.id)).toEqual(['new-account']);
    expect(view.result.current.refs.setMessages).not.toHaveBeenCalled();
    expect(view.result.current.refs.detachPreviousExecution).not.toHaveBeenCalled();
  });

  it('rejects a pending header page after the actual account changes at the same URL', async () => {
    const old = deferred<ReturnType<typeof historyResponse>>();
    const fetcher = vi.mocked(fetch).mockImplementationOnce(() => old.promise as Promise<Response>)
      .mockResolvedValueOnce(historyResponse('new-account') as Response);
    const first = bindings();
    const view = renderHook(({ input }) => useRealHistory(input), { initialProps: { input: first } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    view.rerender({ input: nextScope(first, 'account') });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0]).toBe(fetcher.mock.calls[0][0]);
    await waitFor(() => expect(view.result.current.history[0]?.id).toBe('new-account'));
    await act(async () => { old.resolve(historyResponse('old-account')); await old.promise; });
    expect(view.result.current.history.map(row => row.id)).toEqual(['new-account']);
    expect(view.result.current.refs.setMessages).not.toHaveBeenCalled();
  });

  it.each(['account', 'organization'] as const)('hides already returned results when the actual %s scope changes with the same URL', async kind => {
    const fresh = deferred<ReturnType<typeof response>>();
    const fetcher = vi.mocked(fetch).mockResolvedValueOnce(response('old-scope') as Response)
      .mockImplementationOnce(() => fresh.promise as Promise<Response>);
    const first = bindings();
    const view = renderHook(({ input }) => useRealSearch(input), { initialProps: { input: first } });
    await waitFor(() => expect(view.result.current.search.results[0]?.conversationId).toBe('old-scope'));
    const previousCallback = view.result.current.callback;
    view.rerender({ input: nextScope(first, kind) });
    expect(view.result.current.callback).not.toBe(previousCallback);
    expect(view.result.current.search.results).toEqual([]);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0]).toBe(fetcher.mock.calls[0][0]);
    await act(async () => { fresh.resolve(response('new-scope')); await fresh.promise; });
    expect(view.result.current.search.results.map(row => row.conversationId)).toEqual(['new-scope']);
  });

  it.each(['account', 'organization'] as const)('aborts an in-flight result when the actual %s scope changes and ignores its late response', async kind => {
    const old = deferred<ReturnType<typeof response>>();
    const fetcher = vi.mocked(fetch).mockImplementationOnce(() => old.promise as Promise<Response>)
      .mockResolvedValueOnce(response('new-scope') as Response);
    const first = bindings();
    const view = renderHook(({ input }) => useRealSearch(input), { initialProps: { input: first } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const signal = fetcher.mock.calls[0][1]?.signal;
    view.rerender({ input: nextScope(first, kind) });
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0]).toBe(fetcher.mock.calls[0][0]);
    await waitFor(() => expect(view.result.current.search.results[0]?.conversationId).toBe('new-scope'));
    await act(async () => { old.resolve(response('old-scope')); await old.promise; });
    expect(view.result.current.search.results.map(row => row.conversationId)).toEqual(['new-scope']);
  });
});
