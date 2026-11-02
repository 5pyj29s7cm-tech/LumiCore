// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationHistoryRail } from '../src/components/agent_chat/conversation_history_rail_view';
import type { ConversationHistoryItem } from '../src/components/agent_chat/contracts';

type RailProps = React.ComponentProps<typeof ConversationHistoryRail>;
const timestamp = '2026-10-25T08:00:00.000Z';
const header = (id: string, displayTitle: string): ConversationHistoryItem => ({
  id, displayTitle, preview: '已保存的会话预览', status: 'closed', messageCount: 4,
  createdAt: timestamp, lastActiveAt: timestamp,
});
const originalHeaders = [header('current-conversation', '当前显示的会话'), header('loaded-case', '已加载的民事案')];
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
function searchRow(conversationId: string, message: string, id = conversationId + '-message') {
  return { conversationId, message, timestamp, id, role: 'assistant' };
}
function controls(overrides: Partial<RailProps> = {}) {
  const callbacks = {
    startNewTextConversation: vi.fn(async () => undefined),
    restoreTextConversation: vi.fn(async (_id: string) => undefined),
    refreshConversationHistory: vi.fn(async () => undefined),
    loadMoreConversationHistory: vi.fn(async () => undefined),
    handleConversationHistoryScroll: vi.fn(),
    setConversationContextMenu: vi.fn(),
  };
  const currentRef = { current: 'current-conversation' };
  const props = {
    ...callbacks,
    t: {}, isZh: true, conversationHistory: originalHeaders, orderedConversationHistory: originalHeaders,
    conversationHistoryLoading: false, conversationHistoryLoadingMore: false, conversationHistoryError: '',
    conversationHistoryHasMore: true, isCreatingConversation: false, restoringConversationId: '',
    conversationHistoryListRef: { current: null }, attachmentConversationIdRef: currentRef,
    scopedConversationUrl: (url: string) => url,
    ...overrides,
  } as RailProps;
  function Harness({ input }: { input: RailProps }) {
    return <><ConversationHistoryRail {...input} />
      <main aria-label="当前会话正文">当前会话正文保持不变</main></>;
  }
  const view = render(<Harness input={props} />);
  return { ...view, props, callbacks, currentRef, rerenderProps: (next: Partial<RailProps>) => view.rerender(<Harness input={{ ...props, ...next }} />) };
}
function inputSearch(value: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索全部会话' }), { target: { value } });
}
function assertTranscriptUntouched(ui: ReturnType<typeof controls>) {
  expect(screen.getByRole('main', { name: '当前会话正文' }).textContent).toBe('当前会话正文保持不变');
  expect(ui.currentRef.current).toBe('current-conversation');
  expect(ui.callbacks.startNewTextConversation).not.toHaveBeenCalled();
}
function installSearchServer(rows: unknown[]) {
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname !== '/api/conversations/search') throw new Error('Unexpected transcript, model, or document request: ' + input);
    return reply({ results: rows, limit: 500 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected HTTP request')))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('conversation history rail interactions', () => {
  it('always shows the conversation list and search without collapse or expand controls', () => {
    const ui = controls();
    const rail = ui.container.querySelector('[data-command-center-history-rail]')!;
    expect(rail.getAttribute('aria-expanded')).toBeNull();
    expect(screen.queryByRole('button', { name: '收起会话列表' })).toBeNull();
    expect(screen.queryByRole('button', { name: '展开会话列表' })).toBeNull();
    for (const interact of [fireEvent.mouseLeave, fireEvent.blur, fireEvent.mouseEnter, fireEvent.focus]) {
      interact(rail);
      expect(screen.getByRole('searchbox', { name: '搜索全部会话' })).not.toBeNull();
      expect(screen.getByText('当前显示的会话')).not.toBeNull();
      expect(screen.getByText('已加载的民事案')).not.toBeNull();
      expect(rail.getAttribute('aria-hidden')).not.toBe('true');
    }
    assertTranscriptUntouched(ui);
    expect(ui.callbacks.restoreTextConversation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('searches persisted history beyond loaded headers, groups messages by conversation, and only restores the clicked conversation', async () => {
    const fetcher = installSearchServer([
      searchRow('loaded-case', '已加载会话中的答辩稿段落甲', 'hit-a'),
      searchRow('loaded-case', '已加载会话中的答辩稿段落乙', 'hit-b'),
      searchRow('unloaded-existing-case', '未加载会话中的既有答辩稿完整正文', 'hit-c'),
    ]);
    const ui = controls();
    inputSearch('答辩稿');
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.get('q')).toBe('答辩稿');
    expect(parsed.searchParams.get('limit')).toBe('500');
    expect(init.credentials).toBe('include');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    await screen.findAllByText(/未加载会话中的既有答辩稿完整正文/);
    const resultButtons = Array.from(ui.container.querySelectorAll<HTMLButtonElement>('[data-command-center-history-item]'));
    expect(resultButtons).toHaveLength(2);
    expect(resultButtons.filter(button => button.textContent?.includes('已加载的民事案'))).toHaveLength(1);
    const hiddenResult = resultButtons.find(button => button.textContent?.includes('未加载会话中的既有答辩稿完整正文'))!;
    fireEvent.click(hiddenResult);
    expect(ui.callbacks.restoreTextConversation).toHaveBeenCalledExactlyOnceWith('unloaded-existing-case');
    expect(ui.callbacks.refreshConversationHistory).not.toHaveBeenCalled();
    expect(ui.callbacks.loadMoreConversationHistory).not.toHaveBeenCalled();
    assertTranscriptUntouched(ui);
  });

  it('keeps search results outside the ordinary pagination viewport during refresh', async () => {
    const fetcher = installSearchServer([searchRow('unloaded-case', '少量搜索结果')]);
    const ui = controls();
    const list = ui.container.querySelector<HTMLDivElement>('.lumi-history-list')!;
    expect(ui.props.conversationHistoryListRef.current).toBe(list);
    inputSearch('搜索结果');
    expect(ui.props.conversationHistoryListRef.current).toBeNull();
    await screen.findAllByText(/少量搜索结果/);
    fireEvent.scroll(list, { target: { scrollTop: 10 } });
    expect(ui.callbacks.handleConversationHistoryScroll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '刷新会话列表' }));
    expect(ui.callbacks.refreshConversationHistory).toHaveBeenCalledOnce();
    expect(ui.props.conversationHistoryListRef.current).toBeNull();
    expect(ui.callbacks.loadMoreConversationHistory).not.toHaveBeenCalled();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    expect(ui.props.conversationHistoryListRef.current).toBe(list);
    fireEvent.scroll(list, { target: { scrollTop: 10 } });
    expect(ui.callbacks.handleConversationHistoryScroll).toHaveBeenCalledOnce();
    assertTranscriptUntouched(ui);
  });

  it('clears a search back to the original loaded headers without switching or modifying the current chat', async () => {
    const fetcher = installSearchServer([searchRow('unloaded-existing-case', '未加载会话的搜索结果')]);
    const ui = controls();
    inputSearch('搜索结果');
    await screen.findAllByText(/未加载会话的搜索结果/);
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    expect((screen.getByRole('searchbox', { name: '搜索全部会话' }) as HTMLInputElement).value).toBe('');
    expect(screen.getByText('当前显示的会话')).not.toBeNull();
    expect(screen.getByText('已加载的民事案')).not.toBeNull();
    expect(screen.queryByText(/未加载会话的搜索结果/)).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(ui.props.conversationHistory).toEqual(originalHeaders);
    expect(ui.callbacks.restoreTextConversation).not.toHaveBeenCalled();
    assertTranscriptUntouched(ui);
  });

  it('aborts a superseded search and rejects a late result even when the server ignores cancellation', async () => {
    const old = deferred<any>();
    const fetcher = installSearchServer([searchRow('new-search-case', '新的检索正文')]);
    fetcher.mockImplementationOnce(() => old.promise);
    const ui = controls();
    inputSearch('旧的检索');
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const oldSignal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    inputSearch('新的检索');
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(oldSignal.aborted).toBe(true);
    await screen.findAllByText(/新的检索正文/);
    await act(async () => { old.resolve(reply({ results: [searchRow('stale-case', '过期检索正文')], limit: 500 })); await old.promise; });
    expect(screen.queryByText(/过期检索正文/)).toBeNull();
    expect(screen.getAllByText(/新的检索正文/).length).toBeGreaterThan(0);
    expect(ui.callbacks.restoreTextConversation).not.toHaveBeenCalled();
    assertTranscriptUntouched(ui);
  });

  it('does not accept results from a previous conversation scope', async () => {
    const old = deferred<any>();
    const fetcher = installSearchServer([searchRow('org-existing-case', '组织范围现有会话')]);
    fetcher.mockImplementationOnce(() => old.promise);
    const personal = (url: string) => url + '&domain=personal';
    const ui = controls({ scopedConversationUrl: personal });
    inputSearch('现有会话');
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const oldSignal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    const organization = (url: string) => url + '&domain=work&orgId=org-scope-test';
    ui.rerenderProps({ scopedConversationUrl: organization,
      conversationHistory: [header('org-header', '组织已加载会话')],
      orderedConversationHistory: [header('org-header', '组织已加载会话')] });
    await waitFor(() => expect(oldSignal.aborted).toBe(true));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0]).toContain('domain=work&orgId=org-scope-test');
    await screen.findAllByText(/组织范围现有会话/);
    await act(async () => { old.resolve(reply({ results: [searchRow('private-case', '旧个人范围正文')], limit: 500 })); await old.promise; });
    expect(screen.queryByText(/旧个人范围正文/)).toBeNull();
    expect(ui.callbacks.restoreTextConversation).not.toHaveBeenCalled();
    assertTranscriptUntouched(ui);
  });

  it('hides a previous owner’s matches when the scope callback changes even if its URL text is unchanged', async () => {
    const fresh = deferred<any>();
    const fetcher = installSearchServer([searchRow('old-owner-case', '上一个用户的私有正文')]);
    const firstOwner = (url: string) => url;
    const ui = controls({ scopedConversationUrl: firstOwner });
    inputSearch('私有正文');
    await screen.findAllByText(/上一个用户的私有正文/);
    fetcher.mockImplementationOnce(() => fresh.promise);
    const nextOwner = (url: string) => url;
    ui.rerenderProps({ scopedConversationUrl: nextOwner });
    expect(screen.queryAllByText(/上一个用户的私有正文/)).toHaveLength(0);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0]).toBe(fetcher.mock.calls[0][0]);
    await act(async () => { fresh.resolve(reply({ results: [searchRow('new-owner-case', '新用户的私有正文')], limit: 500 })); await fresh.promise; });
    await screen.findAllByText(/新用户的私有正文/);
    expect(screen.queryAllByText(/上一个用户的私有正文/)).toHaveLength(0);
    expect(ui.callbacks.restoreTextConversation).not.toHaveBeenCalled();
    assertTranscriptUntouched(ui);
  });

  it('aborts an unfinished search when it is cleared and ignores any late response', async () => {
    const held = deferred<any>();
    const fetcher = installSearchServer([]);
    fetcher.mockImplementationOnce(() => held.promise);
    const ui = controls();
    inputSearch('尚未完成的检索');
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    expect(signal.aborted).toBe(true);
    expect(screen.getByText('当前显示的会话')).not.toBeNull();
    await act(async () => { held.resolve(reply({ results: [searchRow('late-case', '清空后迟到的结果')], limit: 500 })); await held.promise; });
    expect(screen.queryByText(/清空后迟到的结果/)).toBeNull();
    expect(ui.callbacks.restoreTextConversation).not.toHaveBeenCalled();
    assertTranscriptUntouched(ui);
  });

  it('keeps existing context-menu navigation separate from restoring a conversation', () => {
    const ui = controls();
    const row = screen.getByText('已加载的民事案').closest('button')!;
    fireEvent.contextMenu(row, { clientX: 30, clientY: 40 });
    expect(ui.callbacks.setConversationContextMenu).toHaveBeenCalledExactlyOnceWith({ conversationId: 'loaded-case', x: 30, y: 40 });
    expect(ui.callbacks.restoreTextConversation).not.toHaveBeenCalled();
    assertTranscriptUntouched(ui);
  });

  it('reports a search error and retries the same read-only search', async () => {
    const fetcher = installSearchServer([searchRow('retry-existing-case', '重试后恢复的现有会话')]);
    fetcher.mockResolvedValueOnce(reply({ error: '搜索服务暂时不可用' }, 503));
    const ui = controls();
    inputSearch('现有会话');
    await screen.findByText(/搜索服务暂时不可用/);
    fireEvent.click(screen.getByRole('button', { name: '重试搜索' }));
    await screen.findAllByText(/重试后恢复的现有会话/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe(fetcher.mock.calls[0][0]);
    expect(ui.callbacks.restoreTextConversation).not.toHaveBeenCalled();
    assertTranscriptUntouched(ui);
  });

  it('shows a search empty state without turning it into an empty history or switching chat', async () => {
    installSearchServer([]);
    const ui = controls();
    inputSearch('没有匹配的关键词');
    await screen.findByText(/没有找到|未找到|无匹配/);
    expect(ui.props.conversationHistory).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    expect(screen.getByText('当前显示的会话')).not.toBeNull();
    expect(ui.callbacks.restoreTextConversation).not.toHaveBeenCalled();
    assertTranscriptUntouched(ui);
  });

  it('keeps loaded rows visible on a history refresh failure and lets the user retry', () => {
    const ui = controls({ conversationHistoryError: '会话列表暂时不可用' });
    expect(screen.getByText('当前显示的会话')).not.toBeNull();
    expect(screen.getByText(/会话列表暂时不可用/)).not.toBeNull();
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '刷新会话列表' }));
    expect(ui.callbacks.refreshConversationHistory).toHaveBeenCalledOnce();
    expect(ui.callbacks.restoreTextConversation).not.toHaveBeenCalled();
    assertTranscriptUntouched(ui);
  });

  it('routes new conversation, refresh, and pagination buttons to their own callbacks', () => {
    const ui = controls();
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
    fireEvent.click(screen.getByRole('button', { name: '刷新会话列表' }));
    fireEvent.click(screen.getByRole('button', { name: '加载更多会话' }));
    expect(ui.callbacks.startNewTextConversation).toHaveBeenCalledOnce();
    expect(ui.callbacks.refreshConversationHistory).toHaveBeenCalledOnce();
    expect(ui.callbacks.loadMoreConversationHistory).toHaveBeenCalledOnce();
    expect(ui.callbacks.restoreTextConversation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(ui.currentRef.current).toBe('current-conversation');
  });

  it('offers a new conversation from an actually empty history without querying or restoring a transcript', () => {
    const ui = controls({ conversationHistory: [], orderedConversationHistory: [], conversationHistoryHasMore: false });
    expect(screen.getByText(/还没有会话|暂无会话|没有会话|尚无会话/)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
    expect(ui.callbacks.startNewTextConversation).toHaveBeenCalledOnce();
    expect(ui.callbacks.restoreTextConversation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts an in-flight search on unmount and never restores a late result', async () => {
    const held = deferred<any>();
    const fetcher = installSearchServer([]);
    fetcher.mockImplementationOnce(() => held.promise);
    const ui = controls();
    inputSearch('pending search');
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    ui.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { held.resolve(reply({ results: [searchRow('late-existing', 'late result')], limit: 500 })); await held.promise; });
    expect(ui.callbacks.restoreTextConversation).not.toHaveBeenCalled();
    expect(ui.callbacks.startNewTextConversation).not.toHaveBeenCalled();
    expect(ui.currentRef.current).toBe('current-conversation');
  });

  it('shows the bounded search warning for 500 message hits without claiming complete conversation pagination', async () => {
    const fetcher = installSearchServer(Array.from({ length: 500 }, (_, index) => searchRow('same-existing', 'matched content ' + index, 'match-' + index)));
    const ui = controls({ isZh: false });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search all conversations' }), { target: { value: 'matched content' } });
    await screen.findByText('Showing the first 500 matching messages. Refine your search for more.');
    expect(ui.container.querySelectorAll('[data-command-center-history-item]')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load more conversations' })).toBeNull();
    expect(screen.queryByText('All conversations loaded')).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(ui.callbacks.loadMoreConversationHistory).not.toHaveBeenCalled();
    expect(ui.callbacks.restoreTextConversation).not.toHaveBeenCalled();
    assertTranscriptUntouched(ui);
  });

});
