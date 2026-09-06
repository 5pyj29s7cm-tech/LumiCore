import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { ChatAttachmentUploads } from '../src/lib/chatAttachmentUploads';
import { chatAttachmentCopy } from '../src/i18n/locales/chatAttachments';
import { ChatViewWorkRegistry } from '../src/lib/chatViewWork';
import { ChatRequestLedger } from '../src/lib/chatEventReceipts';
import { createChatAttachmentReference, mergeChatAttachmentReferences, MAX_CHAT_ATTACHMENTS } from '../src/lib/chatAttachmentReferences';
const pagePath = 'src/components/AgentChatPage.tsx';
const pageSource = fs.readFileSync(pagePath, 'utf8');
const pageAst = ts.createSourceFile(pagePath, pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
function extract(file: string, name: string, dependencies: Record<string, any>) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = file === pagePath ? pageAst : ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) {
      const init = node.initializer;
      expression = ts.isCallExpression(init) && init.expression.getText(ast) === 'useCallback'
        ? init.arguments[0].getText(ast) : init.getText(ast);
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(ast).replace(/^export\s+/, '');
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!expression) throw new Error(`Production function missing: ${file}:${name}`);
  return vm.runInNewContext(ts.transpileModule(`(${expression})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, dependencies);
}
function sendButtonDisabled(dependencies: Record<string, unknown>) {
  let expression = '';
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(pageAst) === 'disabled'
      && node.initializer && ts.isJsxExpression(node.initializer)
      && node.initializer.expression?.getText(pageAst).includes('pendingAttachments.length === 0')) {
      expression = node.initializer.expression.getText(pageAst);
    }
    ts.forEachChild(node, visit);
  };
  visit(pageAst);
  if (!expression) throw new Error('Mounted send button disabled predicate missing');
  return vm.runInNewContext(expression, dependencies);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const noop = () => {};
const oldAttachment = () => createChatAttachmentReference({
  fileId: 'earlier-budget.txt', fileName: 'earlier-budget.txt',
  path: 'C:/synthetic-knowledge/earlier-budget.txt', kind: 'file', content: 'OLD_DOCUMENT_ONLY: budget 100.',
});
const newFileReply = () => ({ ok: true, json: async () => ({ files: [{
  id: 'current-budget.txt', name: 'current-budget.txt',
  path: 'C:/synthetic-knowledge/current-budget.txt', mimeType: 'text/plain',
  content: 'NEW_DOCUMENT_ONLY: budget 250.', extractionStatus: 'indexed', rawSize: 35,
}] }) });

function pageHarness(withOldAttachment = false, transport?: (url: string, init: any) => Promise<any>) {
  const response = deferred<any>();
  const registry = new ChatViewWorkRegistry();
  const emitted: any[] = [];
  const deps: Record<string, any> = {
    conversationTransitionRef: { current: null }, conversationTransitionPending: false, setConversationTransitionPending: (value: boolean) => { deps.conversationTransitionPending = value; },
    isOptimizing: false, attachmentUploadFailures: [], chatUploadsRef: { current: new ChatAttachmentUploads() },
    attachmentUploadText: chatAttachmentCopy(false), conversationAttachmentsRef: { current: withOldAttachment ? [oldAttachment()] : [] },
    pendingAttachmentsRef: { current: [] }, pendingAttachments: [], draftTextRef: { current: 'Summarize the document I just selected.' },
    messagesRef: { current: [] }, messages: [], user: { uid: 'synthetic-owner', username: 'synthetic-owner' },
    activeDomain: 'personal', activeOrgId: '', agentId: 'lumi', agentCategory: 'assistant',
    chatExecutionSource: 'command-center-chat', operationMode: 'standard', isZh: false,
    mergeChatAttachmentReferences, createChatAttachmentReference, MAX_CHAT_ATTACHMENTS,
    chatViewWorkRef: { current: registry }, scopedFileUrl: (url: string) => url,
    FormData: transport ? FormData : class { append() {} },
    fetch: transport || (() => response.promise),
    toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() }, t: {},
    uiMessage: (key: string) => key, formatUiMessage: (key: string) => key,
    setOptimizationProgress: noop, window: { setTimeout: noop }, notifyKnowledgeUpdated: noop,
    chatRequestLedgerRef: { current: new ChatRequestLedger() }, chatTurnUiMetaRef: { current: new Map() },
    currentRequestHadToolRef: { current: false }, currentRequestNeedsEvidenceRef: { current: false },
    currentResponseFinalizationRef: { current: null }, chatTurnTimerGuardRef: { current: { begin: noop } },
    taskRelationLedgerRef: { current: { controlTarget: () => ({}) } },
    activeChatRequestIdRef: { current: null }, textChatActiveRef: { current: false },
    attachmentConversationIdRef: { current: 'synthetic-conversation' }, activeChatViewDetachersRef: { current: new Set() },
    activeMediaGenerationRef: { current: null }, mediaGenerationText: {},
    setIsTyping: noop, needsVisibleToolEvidence: () => false, clearChatProgress: noop, pushChatProgress: noop,
    setWorkflowStatus: noop, setWorkflowSteps: noop, persistActiveExecution: noop,
    setTimeout: () => 1, clearTimeout: noop, buildChatHistoryPayload: (rows: any[]) => rows,
    makeChatMessageId: (prefix: string) => `${prefix}-${Math.random()}`,
    socket: { connected: true, on: noop, off: noop, emit: (event: string, payload: any) => { emitted.push({ event, payload }); } },
  };
  deps.setAttachmentUploadFailures = (value: any[]) => { deps.attachmentUploadFailures = value; };
  deps.setIsOptimizing = (value: boolean) => { deps.isOptimizing = value; };
  deps.setDraftText = (value: string) => { deps.draftTextRef.current = value; };
  deps.setPendingAttachments = (update: any) => {
    deps.pendingAttachments = typeof update === 'function' ? update(deps.pendingAttachments) : update;
    deps.pendingAttachmentsRef.current = deps.pendingAttachments;
  };
  deps.setMessages = (update: any) => {
    deps.messages = typeof update === 'function' ? update(deps.messages) : update;
    deps.messagesRef.current = deps.messages;
  };
  deps.setConversationAttachments = (value: any) => { deps.conversationAttachmentsRef.current = value; };
  deps.attachmentContextStorageKey = '';
  for (const name of ['isImageFileName', 'isAudioFileName', 'extractAudioTranscript', 'serializeChatAttachment',
    'appendPendingAttachments', 'mapImportedFilesToAttachments', 'acceptImportedChatFiles', 'rememberAttachmentContext',
    'sendText', 'handleSendMessage', 'runChatAttachmentUpload', 'uploadChatAttachments', 'importChatAttachmentPaths']) {
    deps[name] = extract(pagePath, name, deps);
  }
  return { deps, response, registry, emitted, upload: deps.uploadChatAttachments, send: () => deps.handleSendMessage({ preventDefault: noop }) };
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
  h.deps.restoreTextConversation = extract(pagePath, 'restoreTextConversation', h.deps);
  h.deps.setIsCreatingConversation = (value: boolean) => { h.deps.isCreatingConversation = value; };
  h.deps.startNewTextConversation = extract(pagePath, 'startNewTextConversation', h.deps);
  const finish = () => messages.resolve({ ok: true, json: async () => ({ messages: [{ id: 'b-previous', type: 'assistant', text: 'Synthetic history B' }] }) });
  return { ...h, finish, restore: () => h.deps.restoreTextConversation('conversation-b') };
}

describe('conversation transition send barrier', () => {
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
