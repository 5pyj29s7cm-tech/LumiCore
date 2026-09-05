import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { shouldReloadPersistedConversation } from '../src/lib/conversationSync';
import { ChatViewWorkRegistry } from '../src/lib/chatViewWork';
import { createChatAttachmentReference, mergeChatAttachmentReferences, MAX_CHAT_ATTACHMENTS } from '../src/lib/chatAttachmentReferences';

// Run the actual mounted page callbacks against delayed transport responses.
// No backend, desktop application, or real user profile is involved.
const source = fs.readFileSync(path.resolve('src/components/AgentChatPage.tsx'), 'utf8');
const ast = ts.createSourceFile('AgentChatPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string, deps: Record<string, unknown>) {
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) {
      expression = ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === 'useCallback'
        ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!expression) throw new Error(`Current callback missing: ${name}`);
  const js = ts.transpileModule(`(${expression.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return vm.runInNewContext(js, deps);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const noop = () => {};

function historyHarness() {
  const requests: Array<ReturnType<typeof deferred<any>>> = [];
  const current = { current: 'conversation-a' };
  const messagesRef = { current: [{ id: 'old-visible' }] as any[] };
  const messagesRevisionRef = { current: 0 };
  const work = new ChatViewWorkRegistry();
  const setMessages = callback('setMessages', { messagesRef, messagesRevisionRef, setMessageState: noop });
  const handler = callback('onConversationUpdated', {
    agentId: 'lumi', attachmentConversationIdRef: current,
    bindAttachmentContextToConversation: (id: string) => { current.current = id; work.invalidate(); },
    shouldReloadPersistedConversation, socket: { id: 'current-client' },
    activeChatRequestIdRef: { current: null }, textChatActiveRef: { current: false },
    streamingMsgIdsRef: { current: new Map() }, streamingRawTextRef: { current: new Map() },
    chatViewWorkRef: { current: work }, messagesRevisionRef, historyRefreshRevisionRef: { current: 0 },
    scopedConversationUrl: (url: string) => url, CHAT_HISTORY_LIMIT: 60,
    fetch: () => { const response = deferred<any>(); requests.push(response); return response.promise; },
    normalizePersistedMessages: (rows: any[]) => rows, setMessages,
  });
  return { handler, current, requests, work, setMessages, messages: () => messagesRef.current };
}
const event = { agentId: 'lumi', conversationId: 'conversation-a', source: 'voice' };
const reply = (id: string) => ({ json: async () => ({ messages: [{ id }] }) });

describe('chat view asynchronous history ownership', () => {
  it('applies history when the conversation and its messages are unchanged', async () => {
    const h = historyHarness();
    h.handler(event);
    h.requests[0].resolve(reply('history-a'));
    await settle();
    expect(h.messages()).toEqual([{ id: 'history-a' }]);
  });

  it('does not overwrite another selected conversation even if fetch ignores abort', async () => {
    const h = historyHarness();
    h.handler(event);
    h.work.invalidate();
    h.current.current = 'conversation-b';
    h.setMessages([{ id: 'history-b' }]);
    h.requests[0].resolve(reply('history-a'));
    await settle();
    expect(h.messages()).toEqual([{ id: 'history-b' }]);
  });

  it('invalidates an old user/domain scope even when its conversation id is reused', async () => {
    const h = historyHarness();
    h.handler(event);
    h.work.invalidate();
    h.requests[0].resolve(reply('old-scope-history'));
    await settle();
    expect(h.messages()).toEqual([{ id: 'old-visible' }]);
  });

  it('preserves newly sent messages and streaming text in the same conversation', async () => {
    const h = historyHarness();
    h.handler(event);
    h.setMessages((rows: any[]) => [...rows, { id: 'new-user-turn' }, { id: 'stream' }]);
    h.requests[0].resolve(reply('old-visible'));
    await settle();
    expect(h.messages().map(row => row.id)).toEqual(['old-visible', 'new-user-turn', 'stream']);
  });

  it('keeps the latest history response when two refreshes finish out of order', async () => {
    const h = historyHarness();
    h.handler(event);
    h.handler(event);
    h.requests[1].resolve(reply('new-history'));
    await settle();
    h.requests[0].resolve(reply('old-history'));
    await settle();
    expect(h.messages()).toEqual([{ id: 'new-history' }]);
  });
});

function uploadHarness() {
  const response = deferred<any>();
  const registry = new ChatViewWorkRegistry();
  const conversationAttachmentsRef = { current: [] as any[] };
  const pendingAttachmentsRef = { current: [] as any[] };
  let draft = '';
  let signal: AbortSignal | undefined;
  const toast = { error: noop, success: noop, info: noop };
  const appendPendingAttachments = callback('appendPendingAttachments', {
    conversationAttachmentsRef, pendingAttachmentsRef, mergeChatAttachmentReferences,
    setPendingAttachments: noop, toast, uiMessage: (key: string) => key,
    formatUiMessage: (key: string) => key, MAX_CHAT_ATTACHMENTS,
  });
  const acceptImportedChatFiles = callback('acceptImportedChatFiles', {
    mapImportedFilesToAttachments: (files: any[]) => files.map(createChatAttachmentReference),
    appendPendingAttachments, setOptimizationProgress: noop, setIsOptimizing: noop,
    window: { setTimeout: noop }, draftTextRef: { current: draft },
    setDraftText: (value: string) => { draft = value; }, toast,
    uiMessage: (key: string) => key, formatUiMessage: (key: string) => key,
    notifyKnowledgeUpdated: noop,
  });
  const deps = {
    isOptimizing: false, conversationAttachmentsRef, pendingAttachmentsRef,
    mergeChatAttachmentReferences, MAX_CHAT_ATTACHMENTS, toast,
    formatUiMessage: (key: string) => key, setIsOptimizing: noop,
    setOptimizationProgress: noop, activeDomain: 'personal', activeOrgId: '',
    FormData: class { append() {} },
    fetch: (_url: string, init: RequestInit) => { signal = init.signal as AbortSignal; return response.promise; },
    chatViewWorkRef: { current: registry }, scopedFileUrl: (url: string) => url,
    acceptImportedChatFiles, t: {},
  };
  return {
    upload: callback('uploadChatAttachments', deps), importPaths: callback('importChatAttachmentPaths', deps),
    response, registry, pendingAttachmentsRef, draft: () => draft, signal: () => signal,
  };
}
const uploadReply = () => ({ ok: true, json: async () => ({ files: [{
  fileId: 'synthetic-upload', fileName: 'synthetic.wav', kind: 'audio',
  path: 'C:/audit-synthetic/synthetic.wav', transcript: 'Synthetic transcript',
}] }) });

describe('chat uploads stay attached to their originating view', () => {
  it('the actual conversation binding invalidates pending work before switching references', () => {
    const registry = new ChatViewWorkRegistry();
    const pending = registry.begin();
    const current = { current: 'conversation-a' };
    const bind = callback('bindAttachmentContextToConversation', {
      attachmentConversationIdRef: current,
      invalidateChatViewWork: () => registry.invalidate(),
      attachmentContextStoragePrefix: 'synthetic-user:lumi:personal',
      setAttachmentContextStorageKey: noop, conversationAttachmentsRef: { current: [] },
      setConversationAttachments: noop, localStorage: { getItem: () => null, removeItem: noop },
      parseChatAttachmentContext: () => [],
    });
    bind('conversation-b');
    expect(current.current).toBe('conversation-b');
    expect(pending.signal.aborted).toBe(true);
    expect(pending.isCurrent()).toBe(false);
  });

  it('keeps normal same-view upload and transcription behavior', async () => {
    const h = uploadHarness();
    const job = h.upload([{ name: 'synthetic.wav' }]);
    h.response.resolve(uploadReply());
    await job;
    expect(h.pendingAttachmentsRef.current).toHaveLength(1);
    expect(h.draft()).toContain('Synthetic transcript');
  });

  for (const method of ['upload', 'importPaths'] as const) {
    it(`ignores a late ${method} result after a conversation/domain switch`, async () => {
      const h = uploadHarness();
      const job = method === 'upload' ? h.upload([{ name: 'synthetic.wav' }]) : h.importPaths(['C:/audit-synthetic/synthetic.wav']);
      h.registry.invalidate();
      h.pendingAttachmentsRef.current = [];
      expect(h.signal()?.aborted).toBe(true);
      h.response.resolve(uploadReply());
      await job;
      expect(h.pendingAttachmentsRef.current).toEqual([]);
      expect(h.draft()).toBe('');
    });
  }

  for (const change of ['conversation', 'closed-studio'] as const) {
    it(`does not reuse a media-source upload after its ${change} changes`, async () => {
      const response = deferred<any>();
      const registry = new ChatViewWorkRegistry();
      const target = { current: { operation: 'image_edit', slot: 'primary' } as any };
      const imported: any[] = [];
      const upload = callback('uploadMediaSourceImage', {
        mediaSourceUploadTargetRef: target, mediaSourceUploading: false,
        mediaGenerationText: {}, toast: { error: noop, success: noop },
        setMediaSourceUploading: noop, chatViewWorkRef: { current: registry },
        FormData: class { append() {} }, activeDomain: 'personal', activeOrgId: '',
        fetch: () => response.promise, t: {}, scopedFileUrl: (url: string) => url,
        setMediaSourceArtifacts: (value: any) => imported.push(value),
        handleMediaSourceChange: (value: any) => imported.push(value), notifyKnowledgeUpdated: noop,
      });
      const job = upload([{ name: 'source.png', type: 'image/png' }]);
      if (change === 'conversation') registry.invalidate();
      else target.current = null;
      response.resolve({ ok: true, json: async () => ({ files: [{ id: 'source', name: 'source.png', path: 'C:/synthetic/source.png' }] }) });
      await job;
      expect(imported).toEqual([]);
    });
  }
});
