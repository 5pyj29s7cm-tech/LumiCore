import { extractSourceExpression } from './source_expression';
import { expect, it, vi } from 'vitest';
import { ChatRequestLedger, upsertPersistedPendingChatExecution, removePersistedPendingChatExecution } from '../src/lib/chatEventReceipts';
import { chatExecutionStorageKey, ownedPendingChatExecutions, type ChatRecoveryOwner } from '../src/lib/chatExecutionRecovery';
import { ChatViewWorkRegistry } from '../src/lib/chatViewWork';

// Execute the real component callbacks, with synthetic storage and socket replies.
const callback = extractSourceExpression.bind(null, 'src/components/AgentChatPage.tsx');
const noop = () => {};
const owner = (userId: string): ChatRecoveryOwner => ({ userId, agentId: 'lumi', domain: 'personal', source: 'command-center-chat' });
const requestId = 'owner-a-media-request';
const reference = 'https://test.invalid/owner-a-reference.png';
function harness(currentOwner = owner('owner-a')) {
  const data = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  const seed = (persistOwner = owner('owner-a')) => {
    callback('persistActiveExecution', {
      activeDomain: persistOwner.domain, activeOrgId: persistOwner.orgId || '', chatExecutionSource: persistOwner.source,
      chatRecoveryUserId: persistOwner.userId, recoveryOwner: persistOwner,
      activeExecutionStorageKey: chatExecutionStorageKey(persistOwner), localStorage, upsertPersistedPendingChatExecution, ownedPendingChatExecutions,
      attachmentConversationIdRef: { current: 'owner-a-conversation' },
      activeMediaGenerationRef: { current: { requestId, request: { mode: 'image', operation: 'image_edit', size: '1024x1024', primaryImage: reference } } },
    })(requestId);
  };
  seed();
  const key = chatExecutionStorageKey(currentOwner);
  const ledger = new ChatRequestLedger();
  const activeMedia = { current: null as any };
  const setReference = vi.fn();
  const replies: Array<(result: any) => void> = [];
  const view = new ChatViewWorkRegistry();
  const resetMedia = vi.fn(() => { activeMedia.current = null; setReference(''); });
  const emit = vi.fn((_event: string, _payload: any, ack: any) => { replies.push(ack); });
  const dependencies = {
    localStorage, activeExecutionStorageKey: key, ownedPendingChatExecutions, recoveryOwner: currentOwner,
    agentId: currentOwner.agentId, activeDomain: currentOwner.domain, activeOrgId: currentOwner.orgId || '',
    disposed: false, recoveryAttempt: 0, chatViewWorkRef: { current: view },
    ACTIVE_CHAT_EXECUTION_TTL_MS: 86400000, clearPersistedExecution: noop,
    isOfficeCommandCenter: true, activeMediaGenerationRef: activeMedia,
    mediaStudioOpenRef: { current: false }, mediaGenerationArtifactsRef: { current: [] }, mediaGenerationArtifactValidationRef: { current: null },
    setMediaGenerationArtifacts: noop, setMediaGeneration: noop,
    setMediaStudioMode: noop, setMediaSources: vi.fn(value => { setReference(value.primaryImage); }),
    mediaGenerationText: { statusGenerating: 'generating' }, chatRequestLedgerRef: { current: ledger },
    chatTurnTimerGuardRef: { current: { begin: noop } },
    setIsTyping: vi.fn(), lastResumedRequestIdsRef: { current: new Set() }, pushChatProgress: vi.fn(),
    uiMessage: (value: string) => value, isZh: false, attachmentConversationIdRef: { current: 'current-conversation' },
    chatExecutionSource: currentOwner.source, socket: { emit }, setWorkflowStatus: vi.fn(), resetMediaGenerationSurface: resetMedia,
    settleTrackedChatRequest: (id: string) => {
      const next = removePersistedPendingChatExecution(JSON.parse(localStorage.getItem(key) || 'null'), id);
      if (next.pending.length) localStorage.setItem(key, JSON.stringify(next));
      else localStorage.removeItem(key);
      return ledger.settle(id);
    },
  };
  const resume = callback('resumeActiveExecution', dependencies);
  const accepted = { ok: true, snapshot: { requestId, source: currentOwner.source, status: 'executing', terminal: false } };
  return { data, localStorage, seed, key, ledger, activeMedia, setReference, resetMedia, emit, replies, view, dependencies, resume, accepted };
}

it('restores its own media only after the backend confirms the exact execution', async () => {
  const h = harness();
  await h.resume();
  expect(h.emit).toHaveBeenCalledTimes(1);
  expect(h.activeMedia.current).toBeNull();
  expect(h.setReference).not.toHaveBeenCalled();
  h.replies[0](h.accepted);
  expect(h.setReference).toHaveBeenCalledWith(reference);
  expect(h.activeMedia.current.requestId).toBe(requestId);
});

it.each(['different-user', 'different-org', 'different-source', 'anonymous'])('does not read or delete another recovery owner: %s', async variant => {
  const other = variant === 'different-org' ? { ...owner('owner-a'), domain: 'work' as const, orgId: 'org-b' }
    : variant === 'different-source' ? { ...owner('owner-a'), source: 'other-chat' }
      : owner(variant === 'anonymous' ? '' : 'user-b');
  const h = harness(other);
  const original = h.localStorage.getItem(chatExecutionStorageKey(owner('owner-a')));
  await h.resume();
  expect(h.emit).not.toHaveBeenCalled();
  expect(h.setReference).not.toHaveBeenCalled();
  expect(h.localStorage.getItem(chatExecutionStorageKey(owner('owner-a')))).toBe(original);
});

it('discards unowned legacy state and filters a foreign row copied into the current key', async () => {
  const h = harness(owner('user-b'));
  const foreign = h.localStorage.getItem(chatExecutionStorageKey(owner('owner-a')))!;
  const legacyKey = 'lumi_active_chat_execution:lumi:personal:';
  h.localStorage.setItem(legacyKey, foreign);
  h.localStorage.setItem(h.key, foreign);
  await h.resume();
  expect(h.emit).not.toHaveBeenCalled();
  expect(h.localStorage.getItem(legacyKey)).toBeNull();
  expect(h.setReference).not.toHaveBeenCalled();
});

it.each(['denied', 'wrong-request', 'wrong-source'])('rejects invalid acknowledgements without restoring media: %s', async variant => {
  const h = harness();
  await h.resume();
  h.replies[0](variant === 'denied' ? { ok: false } : {
    ...h.accepted, snapshot: { ...h.accepted.snapshot, ...(variant === 'wrong-request' ? { requestId: 'unrelated' } : { source: 'unrelated' }) },
  });
  expect(h.setReference).not.toHaveBeenCalled();
  expect(h.activeMedia.current).toBeNull();
  expect(h.localStorage.getItem(h.key)).toBeNull();
  expect(h.ledger.size).toBe(0);
});

it.each([true, false])('cleans rejected media only if it belongs to that request: %s', async matches => {
  const h = harness();
  await h.resume();
  h.activeMedia.current = { requestId: matches ? requestId : 'new-request' };
  h.replies[0]({ ok: false });
  expect(h.resetMedia).toHaveBeenCalledTimes(matches ? 1 : 0);
  if (!matches) expect(h.activeMedia.current.requestId).toBe('new-request');
});

it.each(['view-change', 'unmount', 'reconnect'])('ignores stale acknowledgements after %s', async variant => {
  const h = harness();
  await h.resume();
  if (variant === 'view-change') h.view.invalidate();
  else if (variant === 'unmount') h.dependencies.disposed = true;
  else await h.resume();
  h.replies[0](h.accepted);
  expect(h.setReference).not.toHaveBeenCalled();
  expect(h.localStorage.getItem(h.key)).not.toBeNull();
  if (variant === 'reconnect') {
    h.replies[1](h.accepted);
    expect(h.setReference).toHaveBeenCalledWith(reference);
  }
});

it('can recover after adopting the active conversation without dropping reference metadata', async () => {
  const h = harness();
  const stored = JSON.parse(h.localStorage.getItem(h.key)!);
  delete stored.pending[0].conversationId;
  h.localStorage.setItem(h.key, JSON.stringify(stored));
  h.dependencies.attachmentConversationIdRef.current = '';
  Object.assign(h.dependencies, {
    scopedConversationUrl: (url: string) => url,
    fetch: vi.fn(async () => ({ json: async () => ({ activeConversation: { id: 'recovered-conversation' } }) })),
    bindAttachmentContextToConversation: (id: string) => {
      h.view.invalidate();
      h.dependencies.attachmentConversationIdRef.current = id;
    },
    upsertPersistedPendingChatExecution,
  });
  await h.resume();
  expect(h.emit).toHaveBeenCalledTimes(1);
  expect(h.emit.mock.calls[0][1].conversationId).toBe('recovered-conversation');
  expect(JSON.parse(h.localStorage.getItem(h.key)!).pending[0].mediaGeneration.primaryImage).toBe(reference);
  expect(h.setReference).not.toHaveBeenCalled();
  h.replies[0](h.accepted);
  expect(h.setReference).toHaveBeenCalledWith(reference);
});

it.each(['image_edit', 'image_to_video'])('recovers all source identities atomically and clears the previous selection: %s', async operation => {
  const h = harness();
  const stored = JSON.parse(h.localStorage.getItem(h.key)!);
  const empty = { primaryImage: '', primaryArtifactId: '', referenceImages: [], referenceArtifactIds: [], referenceImage: '', referenceArtifactId: '' };
  const sources = operation === 'image_edit'
    ? { primaryImage: reference, primaryArtifactId: 'main-id', referenceImages: ['D:/ref.png'], referenceArtifactIds: ['ref-id'] }
    : { referenceImage: reference, referenceArtifactId: 'first-frame-id' };
  stored.pending[0].mediaGeneration = { mode: operation === 'image_edit' ? 'image' : 'video', operation, size: '1024x1024', prompt: 'Keep this source', ...sources };
  h.localStorage.setItem(h.key, JSON.stringify(stored));
  await h.resume();
  expect(h.dependencies.setMediaSources).not.toHaveBeenCalled();
  h.replies[0](h.accepted);
  expect(h.dependencies.setMediaSources).toHaveBeenCalledExactlyOnceWith({ ...empty, ...sources });
});
