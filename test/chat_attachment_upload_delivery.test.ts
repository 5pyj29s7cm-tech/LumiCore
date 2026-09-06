import { makeApp, JWT_SECRET } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import jwt from 'jsonwebtoken';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatAttachmentUploads } from '../src/lib/chatAttachmentUploads';
import { chatAttachmentCopy } from '../src/i18n/locales/chatAttachments';
import { ChatViewWorkRegistry } from '../src/lib/chatViewWork';
import { ChatRequestLedger } from '../src/lib/chatEventReceipts';
import { createChatAttachmentReference, mergeChatAttachmentReferences, MAX_CHAT_ATTACHMENTS } from '../src/lib/chatAttachmentReferences';

// Execute production page callbacks and real HTTP routes using synthetic files.
// These are regression assertions for upload/send ownership and partial retries.
const ingestion = vi.hoisted(() => vi.fn(async (_uid: string, _agent: string, name: string, _content: string, _options: any) => ({
  chunkCount: 1,
  manifest: { manifestId: `synthetic-${name}`, status: 'indexed', coverage: {}, chunks: [{}], sourceRevision: name },
})));
vi.mock('../server/agents/rag', async importOriginal => ({
  ...await importOriginal<any>(), ingestDocument: ingestion,
}));
vi.mock('../server/llm/embedding_provider', async importOriginal => ({
  ...await importOriginal<any>(),
  generateConfiguredEmbedding: vi.fn(async () => ({ vector: [1, 0, 0], provider: 'synthetic', model: 'offline-fixture' })),
}));

const pagePath = 'src/components/AgentChatPage.tsx';
const pageSource = fs.readFileSync(pagePath, 'utf8');
const pageAst = ts.createSourceFile(pagePath, pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
  dependencies = { conversationTransitionPending: false, ...dependencies };
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
    conversationTransitionRef: { current: null }, conversationTransitionPending: false, isOptimizing: false, attachmentUploadFailures: [], chatUploadsRef: { current: new ChatAttachmentUploads() },
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
const buildBackendAttachmentContext = extract('server/socket/chat.ts', 'buildChatAttachmentContext', {
  getAudioAttachmentTranscript: extract('server/socket/chat.ts', 'getAudioAttachmentTranscript', {}),
});

it('retries the latest selected bytes even when browser file metadata is unchanged', async () => {
  const uploads = new ChatAttachmentUploads();
  const original = new File(['old'], 'notes.txt', { lastModified: 1000 });
  const updated = new File(['new'], 'notes.txt', { lastModified: 1000 });
  const first = uploads.begin('files', [original], 8)!;
  uploads.complete(first, null, 'Synthetic failure'); uploads.finish(first);
  const reselected = uploads.begin('files', [updated], 8)!;
  expect(reselected.batch.id).toBe(first.batch.id);
  uploads.complete(reselected, null, 'Synthetic second failure'); uploads.finish(reselected);
  const retry = uploads.begin('files', [], 8, true)!;
  expect(await (retry.items[0].source as File).text()).toBe('new');
  uploads.finish(retry);
});

it('keeps unattempted failed items visible when only some retry slots remain', () => {
  const uploads = new ChatAttachmentUploads();
  const first = uploads.begin('files', selectedBatch(), 8)!;
  uploads.complete(first, null, 'Synthetic failure'); uploads.finish(first);
  const retry = uploads.begin('files', [], 1, true)!;
  const remaining = uploads.complete(retry, { files: [{ uploadItemId: 'item_0' }] }, 'Unknown');
  expect(remaining).toEqual([{ name: 'second-doc.txt', error: 'Synthetic failure' }]);
  expect(uploads.canRetry).toBe(true);
  uploads.finish(retry);
});

describe('chat sends wait for selected attachments', () => {
  it('normal control: awaiting the actual upload callback includes the new document in the sent payload', async () => {
    const h = pageHarness();
    const pending = h.upload([{ name: 'current-budget.txt' }]);
    h.response.resolve(newFileReply());
    await pending;
    h.send();
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].payload.attachments.map((item: any) => item.fileName)).toEqual(['current-budget.txt']);
    expect(buildBackendAttachmentContext(h.emitted[0].payload.attachments)).toContain('NEW_DOCUMENT_ONLY');
    expect(h.deps.pendingAttachmentsRef.current).toEqual([]);
  });

  it.each([false, true])('keeps the draft and blocks every form send until upload finishes (old materials=%s)', async withOld => {
    const h = pageHarness(withOld);
    const pending = h.upload([{ name: 'current-budget.txt' }]);
    expect(h.deps.isOptimizing).toBe(true);
    expect(sendButtonDisabled({ hasDraftText: true, pendingAttachments: [], isOptimizing: true, attachmentUploadFailures: [] })).toBe(true);
    h.send();
    await h.deps.sendText(h.deps.draftTextRef.current, h.deps.pendingAttachmentsRef.current);
    expect(h.emitted).toHaveLength(0);
    expect(h.deps.draftTextRef.current).toBe('Summarize the document I just selected.');
    h.response.resolve(newFileReply());
    await pending;
    expect(h.deps.pendingAttachmentsRef.current.map((item: any) => item.fileName)).toEqual(['current-budget.txt']);
    expect(h.deps.isOptimizing).toBe(false);
    h.send();
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].payload.text).toBe('Summarize the document I just selected.');
    expect(buildBackendAttachmentContext(h.emitted[0].payload.attachments)).toContain('NEW_DOCUMENT_ONLY');
    expect(h.deps.pendingAttachmentsRef.current).toEqual([]);
  });

  it('blocks the synchronous second drop and does not let an old completion release a new view upload', async () => {
    const h = pageHarness();
    const first = h.upload([{ name: 'first.txt' }]);
    const oldBatch = h.deps.chatUploadsRef.current;
    await h.upload([{ name: 'duplicate-drop.txt' }]);
    expect(oldBatch.busy).toBe(true);
    h.registry.invalidate();
    oldBatch.reset();
    h.deps.pendingAttachmentsRef.current = [];
    const newer = oldBatch.begin('files', [new File(['new'], 'new-view.txt')], 8);
    h.response.resolve(newFileReply());
    await first;
    expect(oldBatch.busy).toBe(true);
    expect(h.deps.pendingAttachmentsRef.current).toEqual([]);
    oldBatch.finish(newer!);
  });

  it('applies the same send barrier to native path imports', async () => {
    const h = pageHarness();
    const uploading = h.deps.importChatAttachmentPaths(['C:/synthetic/current-budget.txt']);
    h.send();
    expect(h.emitted).toHaveLength(0);
    h.response.resolve(newFileReply());
    await uploading;
    h.send();
    expect(buildBackendAttachmentContext(h.emitted[0].payload.attachments)).toContain('NEW_DOCUMENT_ONLY');
  });

});

let app: Awaited<ReturnType<typeof makeApp>>;
const stagedFiles = new Set<string>();
const unexpectedNetwork: string[] = [];
const realFetch = globalThis.fetch.bind(globalThis);
beforeAll(async () => {
  app = await makeApp();
  const fileRoutes = await import('../routes/files');
  app.apiRouter.use('/', fileRoutes.default);
  vi.stubGlobal('fetch', async (input: any, init: any) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (target.origin !== app.url) {
      unexpectedNetwork.push(target.origin);
      throw new Error('Only the isolated upload HTTP server is allowed in this test');
    }
    return realFetch(input, init);
  });
});
afterEach(() => { vi.restoreAllMocks(); ingestion.mockClear(); });
afterAll(() => {
  vi.unstubAllGlobals();
  app?.cleanup();
  // Only the failed request's own multer temporary file, captured below.
  for (const file of stagedFiles) if (fs.existsSync(file)) fs.unlinkSync(file);
  expect(unexpectedNetwork).toEqual([]);
});

function httpPageHarness(uid: string, bodies: any[]) {
  const token = jwt.sign({ uid, username: uid }, JWT_SECRET);
  return pageHarness(false, async (_url, init) => {
    const response = await fetch(`${app.url}/api/files/upload`, {
      ...init, headers: { Cookie: `token=${token}` },
    });
    bodies.push({ status: response.status, body: await response.clone().json() });
    return response;
  });
}
function selectedBatch() {
  return [
    new File(['FIRST_SYNTHETIC_DOCUMENT'], 'first-doc.txt', { type: 'text/plain', lastModified: 1000 }),
    new File(['SECOND_SYNTHETIC_DOCUMENT'], 'second-doc.txt', { type: 'text/plain', lastModified: 1000 }),
  ];
}

describe('partial HTTP uploads retain receipts and retry only missing items', () => {
  it('normal control: real multi-file upload returns and attaches both saved files', async () => {
    const bodies: any[] = [];
    const h = httpPageHarness('round8-normal-owner', bodies);
    await h.upload(selectedBatch());
    expect(bodies[0].status).toBe(200);
    expect(bodies[0].body.files.map((row: any) => row.name)).toEqual(['first-doc.txt', 'second-doc.txt']);
    expect(h.deps.pendingAttachmentsRef.current).toHaveLength(2);
    expect(ingestion.mock.calls).toHaveLength(2);
  });

  it.each(['retry-button', 'reselect-batch'])('keeps first success and avoids duplicate files using %s after a later I/O failure', async retryMethod => {
    const bodies: any[] = [];
    const uid = `partial-owner-${retryMethod}`;
    const h = httpPageHarness(uid, bodies);
    const rename = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.basename(String(to)) === 'second-doc.txt') {
        stagedFiles.add(String(from));
        throw Object.assign(new Error('Synthetic ENOSPC on second attachment'), { code: 'ENOSPC' });
      }
      return rename(from, to);
    });
    await h.upload(selectedBatch());
    renameSpy.mockRestore();
    expect(bodies[0].status).toBe(200);
    expect(bodies[0].body.partial).toBe(true);
    expect(bodies[0].body.files.map((row: any) => row.name)).toEqual(['first-doc.txt']);
    expect(bodies[0].body.failed).toEqual([expect.objectContaining({ index: 1, itemId: 'item_1', fileName: 'second-doc.txt' })]);
    expect(h.deps.pendingAttachmentsRef.current.map((row: any) => row.fileName)).toEqual(['first-doc.txt']);
    expect(h.deps.attachmentUploadFailures).toEqual([{ name: 'second-doc.txt', error: 'Synthetic ENOSPC on second attachment' }]);
    h.send();
    expect(h.emitted).toHaveLength(0);
    expect(h.deps.draftTextRef.current).toBe('Summarize the document I just selected.');
    const { readDB } = await import('../db_layer');
    const rows = () => readDB().knowledgeFiles.filter((row: any) => row.userId === uid);
    expect(rows().map((row: any) => row.filename)).toEqual(['first-doc.txt']);
    const firstPath = (ingestion.mock.calls[0] as unknown as any[])[4].filePath;
    expect(fs.readFileSync(firstPath, 'utf8')).toBe('FIRST_SYNTHETIC_DOCUMENT');
    if (retryMethod === 'retry-button') await h.deps.runChatAttachmentUpload('files', [], true);
    else await h.upload(selectedBatch());
    expect(bodies[1].status).toBe(200);
    expect(rows().map((row: any) => row.filename)).toEqual(['first-doc.txt', 'second-doc.txt']);
    expect(ingestion.mock.calls.map(call => call[2])).toEqual(['first-doc.txt', 'second-doc.txt']);
    expect(h.deps.pendingAttachmentsRef.current.map((item: any) => item.fileName)).toEqual(['first-doc.txt', 'second-doc.txt']);
    expect(h.deps.attachmentUploadFailures).toEqual([]);
    h.send();
    expect(h.emitted[0].payload.attachments).toHaveLength(2);
    expect([...stagedFiles].every(file => !fs.existsSync(file))).toBe(true);
  });

  it('replays confirmed server results when the first HTTP response is lost', async () => {
    const bodies: any[] = [];
    const h = httpPageHarness('lost-response-owner', bodies);
    const fetchWithResponse = h.deps.fetch;
    let dropResponse = true;
    h.deps.fetch = async (...args: any[]) => {
      const response = await fetchWithResponse(...args);
      if (dropResponse) { dropResponse = false; throw new Error('Synthetic response loss'); }
      return response;
    };
    await h.upload(selectedBatch());
    expect(h.deps.pendingAttachmentsRef.current).toEqual([]);
    expect(h.deps.attachmentUploadFailures).toHaveLength(2);
    await h.deps.runChatAttachmentUpload('files', [], true);
    expect(ingestion.mock.calls).toHaveLength(2);
    expect(bodies[1].body.files.every((row: any) => row.reused)).toBe(true);
    expect(h.deps.pendingAttachmentsRef.current).toHaveLength(2);
  });
});

async function requestFile(uid: string, batchId: string, content: string, orgId?: string) {
  const form = new FormData();
  form.append('files', new File([content], 'same-name.txt', { type: 'text/plain', lastModified: 1000 }));
  form.append('uploadBatchId', batchId);
  form.append('uploadItemIds', JSON.stringify(['same-item']));
  form.append('domain', orgId ? 'work' : 'personal');
  if (orgId) form.append('orgId', orgId);
  const token = jwt.sign({ uid, username: uid, ...(orgId ? { orgId, orgRole: 'owner' } : {}) }, JWT_SECRET);
  const res = await fetch(`${app.url}/api/files/upload`, { method: 'POST', body: form, headers: { Cookie: `token=${token}` } });
  return { status: res.status, body: await res.json() };
}

describe('upload receipts bind identity and source bytes', () => {
  it.each(['initial-hash', 'receipt-replay'] as const)('rejects revoked/rejoined membership after the %s await without returning an old receipt', async phase => {
    const { createOrg, addMember, removeMember } = await import('../server/org/db');
    const uid = `revoked-${phase}`;
    const org = createOrg('Synthetic guarded upload', `guarded-${phase}`, uid);
    addMember(org.id, uid, 'owner');
    let savedPath = '';
    if (phase === 'receipt-replay') {
      const initial = await requestFile(uid, 'batch-guarded-upload', 'GUARDED_CONTENT', org.id);
      expect(initial.status).toBe(200);
      savedPath = initial.body.files[0].path;
    }
    const entered = deferred<void>();
    const release = deferred<void>();
    const createReadStream = fs.createReadStream.bind(fs);
    let held = false;
    const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((filePath, options) => {
      if (!held && (phase === 'initial-hash' || String(filePath) === savedPath)) {
        held = true;
        return Readable.from((async function* () {
          entered.resolve(); await release.promise; yield fs.readFileSync(filePath);
        })()) as fs.ReadStream;
      }
      return createReadStream(filePath, options);
    });
    const pending = requestFile(uid, 'batch-guarded-upload', 'GUARDED_CONTENT', org.id);
    await entered.promise;
    removeMember(org.id, uid);
    addMember(org.id, uid, 'owner');
    release.resolve();
    const response = await pending;
    spy.mockRestore();
    expect(response.status).toBe(403);
    expect(response.body.files).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('GUARDED_CONTENT');
    if (phase === 'initial-hash') {
      const { readDB } = await import('../db_layer');
      expect(readDB().knowledgeFiles.filter((row: any) => row.orgId === org.id)).toEqual([]);
    }
  });

  it('does not report item success through a failed receipt flush, and retry reuses the saved file', async () => {
    const db = await import('../db_layer');
    const flush = vi.spyOn(db, 'flushDBOrThrow').mockRejectedValueOnce(new Error('Synthetic receipt persistence failure'));
    const first = await requestFile('flush-retry-owner', 'batch-flush-retry', 'SYNTHETIC_CONTENT');
    expect(first.status).toBe(400);
    expect(first.body.files).toEqual([]);
    expect(first.body.failed[0].error).toBe('Synthetic receipt persistence failure');
    flush.mockRestore();
    const retry = await requestFile('flush-retry-owner', 'batch-flush-retry', 'SYNTHETIC_CONTENT');
    expect(retry.status).toBe(200);
    expect(retry.body.files[0].id).toBe('same-name.txt');
    expect(retry.body.files[0].reused).toBe(true);
    expect(ingestion).toHaveBeenCalledTimes(1);
  });
  it('keeps same-name different-content uploads, and permits an intentional identical copy in a new batch', async () => {
    const first = await requestFile('identity-owner', 'batch-identical-1', 'FIRST_CONTENT');
    const changed = await requestFile('identity-owner', 'batch-identical-1', 'OTHER_CONTENT');
    const copy = await requestFile('identity-owner', 'batch-identical-2', 'FIRST_CONTENT');
    expect([first.status, changed.status, copy.status]).toEqual([200, 200, 200]);
    expect([first.body.files[0].id, changed.body.files[0].id, copy.body.files[0].id])
      .toEqual(['same-name.txt', 'same-name (1).txt', 'same-name (2).txt']);
    expect(fs.readFileSync(changed.body.files[0].path, 'utf8')).toBe('OTHER_CONTENT');
    expect(ingestion.mock.calls).toHaveLength(3);
  });

  it.each(['bytes', 'name'])('does not replay a stale result after the saved file %s changes', async change => {
    const uid = `modified-${change}-owner`;
    const first = await requestFile(uid, 'batch-modified-1', 'ORIGINAL');
    if (change === 'bytes') fs.writeFileSync(first.body.files[0].path, 'MODIFIED_EXTERNALLY', 'utf8');
    else {
      const { readDB, writeDB } = await import('../db_layer');
      const db = readDB();
      const meta = db.knowledgeFiles.find((row: any) => row.userId === uid);
      fs.renameSync(first.body.files[0].path, path.join(path.dirname(first.body.files[0].path), 'renamed.txt'));
      meta.filename = 'renamed.txt';
      writeDB(db);
    }
    const retried = await requestFile(uid, 'batch-modified-1', 'ORIGINAL');
    expect(retried.body.files[0].id).toBe(change === 'bytes' ? 'same-name (1).txt' : 'same-name.txt');
    expect(retried.body.files[0].content).toBe('ORIGINAL');
    expect(ingestion.mock.calls).toHaveLength(2);
  });

  it('never replays another authenticated user or organization scope', async () => {
    const a = await requestFile('scope-a', 'batch-scoped-1', 'SYNTHETIC_CONTENT');
    const b = await requestFile('scope-b', 'batch-scoped-1', 'SYNTHETIC_CONTENT');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.files[0].path).not.toBe(b.body.files[0].path);
    expect(b.body.files[0].reused).not.toBe(true);
    const { createOrg, addMember, getKbEmbeddings } = await import('../server/org/db');
    const orgA = createOrg('Synthetic upload A', 'synthetic-upload-a', 'scope-a');
    const orgB = createOrg('Synthetic upload B', 'synthetic-upload-b', 'scope-a');
    addMember(orgA.id, 'scope-a', 'owner');
    addMember(orgB.id, 'scope-a', 'owner');
    const firstOrg = await requestFile('scope-a', 'batch-scoped-1', 'SYNTHETIC_CONTENT', orgA.id);
    const otherOrg = await requestFile('scope-a', 'batch-scoped-1', 'SYNTHETIC_CONTENT', orgB.id);
    expect(firstOrg.status).toBe(200);
    expect(otherOrg.status).toBe(200);
    expect(firstOrg.body.files[0].path).not.toBe(otherOrg.body.files[0].path);
    expect(otherOrg.body.files[0].reused).not.toBe(true);
    expect(getKbEmbeddings(firstOrg.body.files[0].orgArticleId)).toEqual([
      expect.objectContaining({ embedding: '[1,0,0]', modelName: 'synthetic/offline-fixture' }),
    ]);
  });

  it('shares actual concurrent same-item uploads through the durable result', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const normal = ingestion.getMockImplementation()!;
    ingestion.mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return normal(...args); });
    const first = requestFile('concurrent-owner', 'batch-concurrent-1', 'CONCURRENT_CONTENT');
    await entered.promise;
    const second = requestFile('concurrent-owner', 'batch-concurrent-1', 'CONCURRENT_CONTENT');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(ingestion).toHaveBeenCalledTimes(1);
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.files[0].path).toBe(b.body.files[0].path);
    expect(ingestion).toHaveBeenCalledTimes(1);
  });
});
