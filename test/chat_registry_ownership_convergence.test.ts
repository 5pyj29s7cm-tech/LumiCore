import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ conversationPresent: true }));
vi.mock('../server/conversation/lifecycle', () => ({ conversationExists: () => state.conversationPresent }));
import {
  beginChatExecution, beginChatExecutionDurably, beginChatSidecarExecution, getChatExecution,
  forgetConversationChatExecutionsDurably, initializeChatExecutionRegistryPersistence,
  recordChatExecutionTerminalEventDurably, recordChatExecutionPersistenceUnknownDurably, persistChatSidecarCancellationIntent, recordChatExecutionEvent,
  resetChatExecutionRegistryForTests, type ChatExecutionPersistenceAdapter,
  type ChatExecutionScope, type PersistedChatExecutionReceipt,
} from '../server/socket/chat_execution_registry';
const scope: ChatExecutionScope = { userId: 'synthetic-owner', domain: 'personal', source: 'chat', conversationId: 'synthetic-conversation', requireConversation: true };
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function persisted(requestId: string): PersistedChatExecutionReceipt {
  const now = new Date().toISOString();
  return { ...scope, orgId: '', conversationId: scope.conversationId!, requestId, status: 'completed',
    event: 'agent:response', payload: { finalized: true, text: 'old recovered result' },
    createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60000).toISOString() };
}
const adapter = (overrides: Partial<ChatExecutionPersistenceAdapter> = {}): ChatExecutionPersistenceAdapter => ({
  loadRecoverable: async () => [], upsert: async () => {}, purgeExpired: async () => {},
  deleteConversation: async () => {}, ...overrides,
});
beforeEach(() => { state.conversationPresent = true; resetChatExecutionRegistryForTests(); });
describe('chat execution identity and late publication ownership', () => {
  it('refuses a synchronous completion that has not crossed its durable receipt boundary', async () => {
    const upsert = vi.fn(async () => {});
    await initializeChatExecutionRegistryPersistence(adapter({ upsert }));
    beginChatExecution(scope, 'ordinary-terminal');
    expect(recordChatExecutionEvent(scope, 'ordinary-terminal', 'agent:response', { finalized: true, text: 'uncommitted' })).toBe(false);
    expect(getChatExecution(scope, 'ordinary-terminal')).toMatchObject({ terminal: false, status: 'acknowledged' });
    expect(upsert).not.toHaveBeenCalled();
  });
  it('does not let an error progress frame become the execution failure authority', () => {
    beginChatExecution(scope, 'progress-error');
    expect(recordChatExecutionEvent(scope, 'progress-error', 'agent:status', { status: 'error', message: 'recoverable substep' })).toBe(true);
    expect(getChatExecution(scope, 'progress-error')).toMatchObject({ terminal: false, status: 'acknowledged' });
    expect(recordChatExecutionEvent(scope, 'progress-error', 'agent:tool', { name: 'recovery-tool' })).toBe(true);
    expect(getChatExecution(scope, 'progress-error')).toMatchObject({ terminal: false, status: 'executing' });
  });
  it('separates conversation and request identifiers containing the previous key delimiter', () => {
    const first = { ...scope, conversationId: 'thread' };
    const second = { ...scope, conversationId: 'thread:part' };
    expect(beginChatSidecarExecution(first, 'part:request')).toBe(true);
    expect(beginChatSidecarExecution(second, 'request')).toBe(true);
    expect(getChatExecution(first, 'part:request')?.conversationId).toBe('thread');
    expect(getChatExecution(second, 'request')?.conversationId).toBe('thread:part');
  });
  it('allows a missing conversation recovery probe but refuses an explicitly different conversation', () => {
    beginChatExecution(scope, 'exact-request');
    expect(getChatExecution({ ...scope, conversationId: undefined }, 'exact-request')?.requestId).toBe('exact-request');
    expect(getChatExecution({ ...scope, conversationId: 'different-conversation' }, 'exact-request')).toBeNull();
  });
  it('separates organization, source and conversation fields without delimiter ambiguity', () => {
    const first: ChatExecutionScope = { ...scope, domain: 'work', orgId: 'org:chat:thread', source: 'chat', conversationId: 'end' };
    const second: ChatExecutionScope = { ...scope, domain: 'work', orgId: 'org', source: 'chat', conversationId: 'thread:chat:end' };
    beginChatExecution(first, 'first');
    expect(() => beginChatExecution(second, 'second')).not.toThrow();
    expect(getChatExecution(first)?.requestId).toBe('first');
    expect(getChatExecution(second)?.requestId).toBe('second');
  });
  it.each(['terminal', 'unknown'] as const)('does not give a late %s writer publication after the conversation was forgotten', async mode => {
    const started = deferred(), release = deferred();
    const deletion = vi.fn(async () => {});
    await initializeChatExecutionRegistryPersistence(adapter({ deleteConversation: deletion, upsert: async () => {
      started.resolve(); await release.promise;
    } }));
    beginChatExecution(scope, 'pending');
    const write = mode === 'terminal'
      ? recordChatExecutionTerminalEventDurably(scope, 'pending', 'agent:response', { finalized: true, text: 'late completion' })
      : recordChatExecutionPersistenceUnknownDurably(scope, 'pending', { text: 'late unknown' });
    const outcome = write.then(value => ({ value }), error => ({ error }));
    await started.promise;
    state.conversationPresent = false;
    const forgotten = forgetConversationChatExecutionsDurably(scope);
    expect(getChatExecution(scope, 'pending')).toBeNull();
    release.resolve();
    expect(await outcome).toEqual({ value: false });
    await forgotten;
    expect(deletion).toHaveBeenCalledOnce();
    expect(getChatExecution(scope, 'pending')).toBeNull();
  });
  it('does not reserve a replacement after its conversation was deleted while the old terminal settled', async () => {
    const started = deferred(), release = deferred();
    await initializeChatExecutionRegistryPersistence(adapter({ upsert: async () => { started.resolve(); await release.promise; } }));
    beginChatExecution(scope, 'old');
    const replacement = beginChatExecutionDurably(scope, 'new');
    const outcome = replacement.then(value => ({ value }), error => ({ error }));
    await started.promise;
    state.conversationPresent = false;
    const forgotten = forgetConversationChatExecutionsDurably(scope);
    release.resolve(); await outcome; await forgotten;
    expect(getChatExecution(scope, 'new')).toBeNull();
  });
  it('does not authorize cancellation from a retired sidecar whose intent write settled late', async () => {
    const started = deferred(), release = deferred();
    await initializeChatExecutionRegistryPersistence(adapter({ upsert: async () => { started.resolve(); await release.promise; } }));
    beginChatSidecarExecution(scope, 'stop');
    const intent = persistChatSidecarCancellationIntent(scope, 'stop', 'target');
    const outcome = intent.then(() => ({ accepted: true }), error => ({ error }));
    await started.promise; state.conversationPresent = false;
    const forgotten = forgetConversationChatExecutionsDurably(scope);
    release.resolve();
    expect(await outcome).toHaveProperty('error');
    await forgotten;
    expect(getChatExecution(scope, 'stop')).toBeNull();
  });
  it('keeps runtime terminal binding equal to its accepted durable binding when the caller mutates nested payload', async () => {
    const started = deferred(), release = deferred();
    let stored: PersistedChatExecutionReceipt | undefined;
    await initializeChatExecutionRegistryPersistence(adapter({ upsert: async receipt => { stored = structuredClone(receipt); started.resolve(); await release.promise; } }));
    beginChatExecution(scope, 'bound');
    const payload = { finalized: true, text: 'accepted', taskRelation: { taskId: 'accepted-task', revision: 2, targetRequestId: 'bound' } };
    const pending = recordChatExecutionTerminalEventDurably(scope, 'bound', 'agent:response', payload);
    await started.promise;
    payload.taskRelation.taskId = 'changed-task'; payload.taskRelation.revision = 9;
    release.resolve(); expect(await pending).toBe(true);
    expect(stored?.payload.taskBinding).toEqual({ taskId: 'accepted-task', revision: 2, targetRequestId: 'bound' });
    expect(getChatExecution(scope, 'bound')?.terminalEvent?.payload.taskRelation).toEqual(stored?.payload.taskBinding);
    const snapshot = getChatExecution(scope, 'bound')!;
    snapshot.terminalEvent!.payload.taskRelation.revision = 20;
    expect(getChatExecution(scope, 'bound')?.terminalEvent?.payload.taskRelation.revision).toBe(2);
  });
  it('keeps a process-owned reservation when recovery hydration arrives late for the same request', async () => {
    const started = deferred(), rows = deferred<PersistedChatExecutionReceipt[]>();
    const hydration = initializeChatExecutionRegistryPersistence(adapter({ loadRecoverable: async () => {
      started.resolve(); return rows.promise;
    } }));
    await started.promise;
    beginChatExecution(scope, 'current');
    rows.resolve([persisted('current')]); await hydration;
    expect(getChatExecution(scope, 'current')).toMatchObject({ status: 'acknowledged', terminal: false });
  });
  it('keeps the live foreground pointer when a later-dated historical receipt is hydrated', async () => {
    const started = deferred(), rows = deferred<PersistedChatExecutionReceipt[]>();
    const hydration = initializeChatExecutionRegistryPersistence(adapter({ loadRecoverable: async () => {
      started.resolve(); return rows.promise;
    } }));
    await started.promise;
    beginChatExecution(scope, 'current');
    const old = persisted('historical');
    old.updatedAt = new Date(Date.now() + 5000).toISOString();
    rows.resolve([old]); await hydration;
    expect(getChatExecution(scope)?.requestId).toBe('current');
    expect(getChatExecution(scope, 'historical')?.terminal).toBe(true);
  });
});
