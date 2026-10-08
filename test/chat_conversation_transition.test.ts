import { pagePath, pageAst, sendButtonDisabled, deferred, noop, pageHarness } from './chat_page_fixture';
import { extractSourceExpression as extract } from './source_expression';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function initialHistoryEffect(dependencies: Record<string, any>) {
  let expression = '';
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(pageAst) === 'useEffect'
      && node.arguments[0]?.getText(pageAst).includes('const initialConversationId = attachmentConversationIdRef.current')) expression = node.arguments[0].getText(pageAst);
    ts.forEachChild(node, visit);
  };
  visit(pageAst);
  if (!expression) throw new Error('Missing mounted initial history effect');
  return vm.runInNewContext(ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, dependencies)();
}

function switchingHarness() {
  const h = pageHarness();
  const messages = deferred<any>();
  Object.assign(h.deps, {
    restoringConversationId: '', isCreatingConversation: false, CHAT_HISTORY_LIMIT: 120,
    scopedConversationUrl: (url: string) => url,
    invalidateChatViewWork: () => h.registry.invalidate(),
    setRestoringConversationId: (id: string) => { h.deps.restoringConversationId = id; },
    fetch: vi.fn(async (url: string) => url.endsWith('/activate')
      ? { ok: true, json: async () => ({ conversation: { id: 'conversation-b' } }) }
      : messages.promise),
    clearPersistedExecution: vi.fn(), lastResumedRequestIdsRef: { current: new Set() },
    streamingMsgIdsRef: { current: new Set() }, streamingRawTextRef: { current: new Map() },
    chatTurnTimerGuardRef: { current: { begin: noop, invalidate: noop } },
    resetMediaGenerationSurface: noop,
    bindAttachmentContextToConversation: (id: string) => { h.deps.attachmentConversationIdRef.current = id; },
    normalizePersistedMessages: (rows: any[]) => rows,
    setSearchQuery: noop, setSearchResults: noop, setSearchError: noop,
    seenWorkflowToolEvents: { current: new Set() }, setConversationHistory: noop,
    setConversationHistorySelectorExpanded: noop, requestAnimationFrame: noop,
  });
  h.deps.detachPreviousExecution = extract(pagePath, 'detachPreviousExecution', h.deps);
  h.deps.activateTranscript = extract(pagePath, 'activateTranscript', h.deps);
  h.deps.restoreTextConversation = extract(pagePath, 'restoreTextConversation', h.deps);
  h.deps.setIsCreatingConversation = (value: boolean) => { h.deps.isCreatingConversation = value; };
  h.deps.startNewTextConversation = extract(pagePath, 'startNewTextConversation', h.deps);
  const finish = () => messages.resolve({ ok: true, json: async () => ({ messages: [{ id: 'b-previous', type: 'assistant', text: 'Synthetic history B' }] }) });
  return { ...h, finish, restore: () => h.deps.restoreTextConversation('conversation-b') };
}

describe('conversation transition send barrier', () => {
  it('keeps server-owned finalization metadata for the foreground request', async () => {
    const h = switchingHarness();
    h.send();
    const requestId = h.emitted[0].payload.requestId;
    const metadata = h.deps.chatTurnUiMetaRef.current.get(requestId);
    expect(metadata).toEqual({ hadTool: false, finalization: null });
    expect(h.deps.currentTurnUiMetaRef.current).toBe(metadata);
    metadata.hadTool = true;
    expect(h.deps.currentTurnUiMetaRef.current.hadTool).toBe(true);
    const pending = h.restore(); h.finish(); await pending;
    expect(h.deps.currentTurnUiMetaRef.current).toEqual({ hadTool: false, finalization: null });
    expect(h.deps.chatTurnUiMetaRef.current.size).toBe(0);
  });

  it('keeps queued metadata separate and resumes the next request by reference', () => {
    const h = switchingHarness();
    h.send();
    const first = h.deps.currentTurnUiMetaRef.current;
    first.hadTool = true;
    h.deps.setDraftText('A queued request'); h.send();
    const nextId = h.emitted[1].payload.requestId;
    const next = h.deps.chatTurnUiMetaRef.current.get(nextId);
    expect(next).not.toBe(first);
    expect(h.deps.currentTurnUiMetaRef.current).toBe(first);
    expect(next.hadTool).toBe(false);
    extract(pagePath, 'resumeForegroundRequest', h.deps)(nextId);
    expect(h.deps.currentTurnUiMetaRef.current).toBe(next);
    next.finalization = { finalized: true, blocked: true, reason: 'synthetic' };
    expect(h.deps.currentTurnUiMetaRef.current.finalization).toBe(next.finalization);
  });

  it('control: after switching finishes, send goes to the selected conversation and remains visible', async () => {
    const h = switchingHarness();
    const pending = h.restore(); h.finish(); await pending;
    h.deps.setDraftText('A fresh request for B'); h.send();
    expect(h.emitted[0].payload.conversationId).toBe('conversation-b');
    expect(h.deps.messages.at(-1).text).toBe('A fresh request for B');
    expect(h.deps.chatRequestLedgerRef.current.size).toBe(1);
  });

  it('blocks every send entry while history loads and keeps the typed draft for B', async () => {
    const h = switchingHarness();
    const pending = h.restore();
    await vi.waitFor(() => expect(h.deps.fetch).toHaveBeenCalledTimes(2));
    expect(sendButtonDisabled({ ...h.deps, hasDraftText: true })).toBe(true);
    h.deps.setDraftText('A request typed while switching to B');
    h.send();
    await h.deps.sendText('suggested prompt');
    expect(h.emitted).toEqual([]);
    expect(h.deps.chatRequestLedgerRef.current.size).toBe(0);
    h.finish(); await pending;
    expect(h.deps.draftTextRef.current).toBe('A request typed while switching to B');
    expect(h.deps.conversationTransitionRef.current).toBeNull();
    h.send();
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].payload.conversationId).toBe('conversation-b');
    expect(h.deps.chatRequestLedgerRef.current.size).toBe(1);
    expect(h.deps.messages.at(-1).text).toBe('A request typed while switching to B');
  });

  it('reserves a new conversation before React commits state and preserves its draft', async () => {
    const h = switchingHarness();
    const created = deferred<any>();
    h.deps.fetch = vi.fn(() => created.promise);
    h.deps.setIsCreatingConversation = vi.fn(); // no React re-render yet
    const pending = h.deps.startNewTextConversation();
    await h.deps.startNewTextConversation();
    await h.restore();
    h.deps.setDraftText('New conversation draft'); h.send();
    expect(h.deps.fetch).toHaveBeenCalledTimes(1);
    expect(h.emitted).toEqual([]);
    created.resolve({ ok: true, json: async () => ({ conversation: { id: 'new-c' } }) });
    await pending;
    expect(h.deps.draftTextRef.current).toBe('New conversation draft');
    h.send();
    expect(h.emitted[0].payload.conversationId).toBe('new-c');
    expect(h.deps.chatRequestLedgerRef.current.size).toBe(1);
  });

  it('releases a failed switch without clearing the draft or old request ledger', async () => {
    const h = switchingHarness();
    h.send();
    h.deps.setDraftText('Keep this draft');
    h.deps.fetch = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Synthetic unavailable history' }) }));
    await h.restore();
    expect(h.deps.toast.error).toHaveBeenCalledOnce();
    expect(h.deps.draftTextRef.current).toBe('Keep this draft');
    expect(h.deps.chatRequestLedgerRef.current.size).toBe(1);
    expect(h.deps.conversationTransitionRef.current).toBeNull();
    expect(h.deps.attachmentConversationIdRef.current).toBe('synthetic-conversation');
  });

  it('a superseded history completion cannot unlock the new scope or replace its ledger', async () => {
    const h = switchingHarness();
    const pending = h.restore();
    await vi.waitFor(() => expect(h.deps.fetch).toHaveBeenCalledTimes(2));
    h.registry.invalidate();
    const newScope = Symbol('new-scope');
    h.deps.conversationTransitionRef.current = newScope;
    h.deps.setDraftText('New scope draft');
    h.finish(); await pending;
    expect(h.deps.conversationTransitionRef.current).toBe(newScope);
    expect(h.deps.draftTextRef.current).toBe('New scope draft');
    h.send(); expect(h.emitted).toEqual([]);
  });

  it('initial history loading also blocks sending and retains the draft until the active transcript is ready', async () => {
    const h = switchingHarness(); const active = deferred<any>();
    Object.assign(h.deps, {
      isFounder: false, lastConversationScopeRef: { current: 'synthetic-scope' }, initialLoadDoneRef: { current: false },
      buildChatConversationScopeKey: () => 'scope', attachmentContextStoragePrefix: '',
      terminalReceiptsRef: { current: new Set() }, localStorage: { removeItem: noop },
      shouldApplyInitialConversationMessages: () => true,
      fetch: vi.fn(async (url: string) => url.includes('/active?') || url.endsWith('/active') ? active.promise : { ok: true, json: async () => ({ messages: [{ id: 'old', text: 'Earlier history' }] }) }),
    });
    const unmount = initialHistoryEffect(h.deps);
    h.deps.setDraftText('Draft during initial history'); h.send();
    expect(h.emitted).toEqual([]);
    expect(h.deps.conversationTransitionRef.current).not.toBeNull();
    active.resolve({ ok: true, json: async () => ({ activeConversation: { id: 'initial-active' } }) });
    await vi.waitFor(() => expect(h.deps.conversationTransitionRef.current).toBeNull());
    expect(h.deps.draftTextRef.current).toBe('Draft during initial history');
    h.send();
    expect(h.emitted[0].payload.conversationId).toBe('initial-active');
    expect(h.deps.chatRequestLedgerRef.current.size).toBe(1);
    unmount();
  });
});

describe('scope detachment ownership', () => {
  function scopeHarness(founder: boolean) {
    const h = switchingHarness(); h.send();
    Object.assign(h.deps, {
      isFounder: founder, lastConversationScopeRef: { current: h.deps.user.username + ':scope' },
      initialLoadDoneRef: { current: true }, buildChatConversationScopeKey: (id: string) => id === 'founder' ? 'founder-scope' : 'scope',
      attachmentContextStoragePrefix: '', terminalReceiptsRef: { current: new Set() },
      localStorage: { removeItem: noop }, setIsTyping: vi.fn(),
      fetch: vi.fn(async () => ({ json: async () => ({}) })),
    });
    return h;
  }
  it('a changed uid detaches the old view even when the username stays the same', () => {
    const h = scopeHarness(false); h.deps.user = { ...h.deps.user, uid: 'second-owner' };
    initialHistoryEffect(h.deps);
    expect(h.deps.chatRequestLedgerRef.current.size).toBe(0);
    expect(h.deps.chatExecutionWatchesRef.current.size).toBe(0);
    expect(h.deps.currentTurnUiMetaRef.current).toEqual({ hadTool: false, finalization: null });
    expect(h.deps.setIsTyping).toHaveBeenCalledWith(false);
    expect(h.deps.clearPersistedExecution).not.toHaveBeenCalled();
  });
  it('a founder surface switch detaches text watches before skipping history loading', () => {
    const h = scopeHarness(true); h.deps.agentId = 'founder';
    initialHistoryEffect(h.deps);
    expect(h.deps.chatRequestLedgerRef.current.size).toBe(0);
    expect(h.deps.chatExecutionWatchesRef.current.size).toBe(0);
    expect(h.deps.fetch).not.toHaveBeenCalled();
  });
});
