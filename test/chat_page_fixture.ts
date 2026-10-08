import { chatRecoveryCopy } from '../src/i18n/locales/chatRecovery';
import { ChatExecutionWatch } from '../src/lib/chatExecutionWatch';
import { takeChatStreamBucket } from '../src/lib/chatEventReceipts';
import { extractSourceExpression as extract, readSourceAst } from './source_expression';
import vm from 'node:vm';
import ts from 'typescript';
import { vi } from 'vitest';
import { ChatAttachmentUploads } from '../src/lib/chatAttachmentUploads';
import { chatAttachmentCopy } from '../src/i18n/locales/chatAttachments';
import { ChatViewWorkRegistry } from '../src/lib/chatViewWork';
import { ChatRequestLedger } from '../src/lib/chatEventReceipts';
import { createChatAttachmentReference, mergeChatAttachmentReferences, MAX_CHAT_ATTACHMENTS, mergePendingChatAttachments, mapImportedChatAttachments, serializeChatAttachment } from '../src/lib/chatAttachmentReferences';

export const pagePath = 'src/components/AgentChatPage.tsx';

export const pageAst = readSourceAst(pagePath);
const viewAst = readSourceAst("src/components/agent_chat/chat_composer_view.tsx");

export function sendButtonDisabled(dependencies: Record<string, unknown>) {
  dependencies = { conversationTransitionPending: false, ...dependencies };
  let expression = '';
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(viewAst) === 'disabled'
      && node.initializer && ts.isJsxExpression(node.initializer)
      && node.initializer.expression?.getText(viewAst).includes('pendingAttachments.length === 0')) {
      expression = node.initializer.expression.getText(viewAst);
    }
    ts.forEachChild(node, visit);
  };
  visit(viewAst);
  if (!expression) throw new Error('Mounted send button disabled predicate missing');
  return vm.runInNewContext(expression, dependencies);
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

export const noop = () => {};

export const oldAttachment = () => createChatAttachmentReference({
  fileId: 'earlier-budget.txt', fileName: 'earlier-budget.txt',
  path: 'C:/synthetic-knowledge/earlier-budget.txt', kind: 'file', content: 'OLD_DOCUMENT_ONLY: budget 100.',
});

export const newFileReply = () => ({ ok: true, json: async () => ({ files: [{
  id: 'current-budget.txt', name: 'current-budget.txt',
  path: 'C:/synthetic-knowledge/current-budget.txt', mimeType: 'text/plain',
  content: 'NEW_DOCUMENT_ONLY: budget 250.', extractionStatus: 'indexed', rawSize: 35,
}] }) });

export function pageHarness(withOldAttachment = false, transport?: (url: string, init: any) => Promise<any>) {
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
    chatRecoveryCopy, isOfficeCommandCenter: true, mediaStudioOpenRef: { current: false }, setMediaStudioMode: noop, setMediaSources: noop,
    chatExecutionSource: 'command-center-chat', operationMode: 'standard', isZh: false,
    mergeChatAttachmentReferences, createChatAttachmentReference, MAX_CHAT_ATTACHMENTS,
    chatViewWorkRef: { current: registry }, scopedFileUrl: (url: string) => url,
    FormData: transport ? FormData : class { append() {} },
    fetch: transport || (() => response.promise),
    toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() }, t: {},
    uiMessage: (key: string) => key, formatUiMessage: (key: string) => key,
    setOptimizationProgress: noop, window: { setTimeout: noop }, notifyKnowledgeUpdated: noop,
    chatRequestLedgerRef: { current: new ChatRequestLedger() }, chatTurnUiMetaRef: { current: new Map() },
    currentTurnUiMetaRef: { current: { hadTool: false, needsEvidence: false, finalization: null } },
    chatTurnTimerGuardRef: { current: { begin: noop } },
    taskRelationLedgerRef: { current: { controlTarget: () => ({}) } },

    attachmentConversationIdRef: { current: 'synthetic-conversation' }, chatExecutionWatchesRef: { current: new Map() },
    activeMediaGenerationRef: { current: null }, mediaGenerationText: {},
    agentName: "Lumi", mediaGenerationArtifactsRef: { current: [] },
    mediaGenerationArtifactValidationRef: { current: null },
    setMediaGenerationArtifacts: noop, setMediaGeneration: noop,
    setIsTyping: noop, needsVisibleToolEvidence: () => false, clearChatProgress: noop, pushChatProgress: noop,
    setWorkflowStatus: noop, setWorkflowSteps: noop, persistActiveExecution: noop,
    clearPersistedExecution: noop, streamingMsgIdsRef: { current: new Map() }, streamingRawTextRef: { current: new Map() },
    takeChatStreamBucket, setTimeout: () => 1, clearTimeout: noop, buildChatHistoryPayload: (rows: any[]) => rows,
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
  deps.rememberConversationAttachments = extract('src/hooks/useConversationAttachments.ts', 'rememberConversationAttachments', deps);
  Object.assign(deps, { mergePendingChatAttachments, mapImportedChatAttachments, serializeChatAttachment });
  deps.ChatExecutionWatch = class extends ChatExecutionWatch {
    constructor(options: ConstructorParameters<typeof ChatExecutionWatch>[0]) { super(options, { setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout }); }
  };
  for (const name of ['createChatStreamReceivers', 'dropRequestStream', 'resumeForegroundRequest', 'settleTrackedChatRequest', 'appendPendingAttachments', 'acceptImportedChatFiles', 'rememberAttachmentContext',
    'attachChatExecutionWatch', 'sendText', 'handleSendMessage', 'runChatAttachmentUpload', 'uploadChatAttachments', 'importChatAttachmentPaths']) {
    deps[name] = extract(pagePath, name, deps);
  }
  return { deps, response, registry, emitted, upload: deps.uploadChatAttachments, send: () => deps.handleSendMessage({ preventDefault: noop }) };
}
