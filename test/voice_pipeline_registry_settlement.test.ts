import './helpers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ process: vi.fn() }));
vi.mock('../server/socket/voice_conversation_turn', () => ({ processVoiceInput: (...args: any[]) => fixture.process(...args) }));
vi.mock('../server/tts/adapter', async original => ({ ...await original<typeof import('../server/tts/adapter')>(), getActiveProvider: () => null }));
import { initDatabase, querySQL } from '../db_layer';
import { getOrCreateActiveConversation, startNewConversation } from '../server/conversation/manager';
import { getAudioSession, type VoiceInputResources } from '../server/socket/voice/session';
import { prepareVoiceIdentityAndAdmission } from '../server/socket/voice/turn/prepare_voice_identity_and_admission';
import { captureVoiceTurnOwner } from '../server/socket/voice_transport_runtime';
import { runVoiceInputPipeline } from '../server/socket/voice_input_pipeline';
import { beginChatExecutionDurably, countUnsettledChatExecutions, getChatExecution, initializeChatExecutionRegistryPersistence,
  recordChatExecutionEvent, recordChatExecutionTerminalEventDurably, resetChatExecutionRegistryForTests,
  type ChatExecutionScope } from '../server/socket/chat_execution_registry';
let sequence = 0;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function createFixture() {
  const outputs: Array<[string, any]> = [];
  const socket = { data: { authenticatedRole: 'user' }, connected: true, emit: (event: string, payload: any) => { outputs.push([event, payload]); return true; } } as any;
  const session = getAudioSession(socket);
  Object.assign(session, { userId: 'voice-registry-settlement-' + ++sequence, agentId: 'lumi', personalityId: 'lumi', isActive: true,
    isProcessing: true, sessionId: 'call-' + sequence, domain: 'personal', orgId: '' });
  session.conversationId = getOrCreateActiveConversation(session.userId, 'lumi', 'personal', '').id;
  return { socket, session, outputs };
}
type Turn = { requestId: string; controller: AbortController; scope: ChatExecutionScope; resources: VoiceInputResources };
async function admit(args: any[]): Promise<Turn> {
  const [socket, session, text, getters, sensory, io, received, authorized, timing, resources] = args;
  const accepted = await prepareVoiceIdentityAndAdmission(socket, session, text, getters, sensory, io, received, authorized, timing, resources);
  if (accepted.terminal) throw new Error('Expected real voice admission');
  const resumed = await accepted.resume();
  if (resumed.terminal) throw new Error('Expected real voice execution reservation');
  const { requestId, pipelineAbort } = resumed.context;
  session.pipelineAbortController = pipelineAbort; session.voiceTurnGeneration++; session.activeTurnRequestId = requestId;
  resources.owner = captureVoiceTurnOwner(session);
  const scope: ChatExecutionScope = { userId: session.userId, domain: session.domain, orgId: session.orgId, source: 'voice', conversationId: session.conversationId };
  expect(recordChatExecutionEvent(scope, requestId, 'agent:status', { status: 'thinking' })).toBe(true);
  return { requestId, controller: pipelineAbort, scope, resources };
}
const pipeline = (f: ReturnType<typeof createFixture>) => runVoiceInputPipeline(f.socket, f.session, 'Read the existing task status.', {} as any, () => ({}), {} as any, undefined, true);
const rows = (turn: Turn) => querySQL<any>('SELECT status, payload, updatedAt FROM chat_execution_terminal_receipts WHERE userId = ? AND requestId = ?', [turn.scope.userId, turn.requestId]);
beforeAll(async () => { await initDatabase(); });
beforeEach(() => { fixture.process.mockReset(); });
afterEach(() => { resetChatExecutionRegistryForTests(); vi.restoreAllMocks(); });
describe('settled voice executor closes its exact registry reservation', () => {
  it('waits for an aborted executor to settle even when its current authorization is unchanged', async () => {
    const f = createFixture(); const admitted = deferred(), held = deferred(); let turn!: Turn;
    fixture.process.mockImplementationOnce(async (...args: any[]) => { turn = await admit(args); admitted.resolve(); await held.promise; });
    const work = pipeline(f); await admitted.promise;
    expect(countUnsettledChatExecutions()).toBe(1); expect(getChatExecution(turn.scope, turn.requestId)?.status).toBe('planning');
    turn.controller.abort(); f.session.pipelineAbortController = null;
    expect(turn.resources.request!.authorization.isCurrent()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(getChatExecution(turn.scope, turn.requestId)?.terminal).toBe(false); expect(await rows(turn)).toHaveLength(0);
    held.resolve(); await work;
    expect(getChatExecution(turn.scope, turn.requestId)).toMatchObject({ terminal: true, status: 'cancelled', terminalEvent: { payload: { reason: 'cancelled' } } });
    expect(countUnsettledChatExecutions()).toBe(0); expect(await rows(turn)).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    expect(f.outputs).toHaveLength(0);
  });
  it('closes an old early-return rejection without touching the replacement owner or task', async () => {
    const f = createFixture(); const admitted = deferred(), held = deferred(); let turn!: Turn;
    fixture.process.mockImplementationOnce(async (...args: any[]) => { turn = await admit(args); admitted.resolve(); await held.promise; throw new Error('Old executor rejected after ownership changed'); });
    const work = pipeline(f); await admitted.promise; turn.controller.abort();
    f.session.voiceTurnGeneration++; f.session.activeTurnRequestId = 'new-voice-request'; const newController = new AbortController();
    f.session.pipelineAbortController = newController; f.session.activeTaskId = 'new-owned-task'; f.session.activeTaskRequestId = 'new-voice-request';
    const newScope = { ...turn.scope, conversationId: startNewConversation(f.session.userId, 'lumi', 'personal', '').id };
    f.session.conversationId = newScope.conversationId;
    await beginChatExecutionDurably(newScope, 'new-voice-request', {});
    const newSnapshot = getChatExecution(newScope, 'new-voice-request');
    expect(getChatExecution(turn.scope, turn.requestId)?.terminal).toBe(false);
    held.resolve(); await work;
    expect(getChatExecution(turn.scope, turn.requestId)).toMatchObject({ terminal: true, status: 'cancelled' });
    expect(getChatExecution(newScope, 'new-voice-request')).toEqual(newSnapshot);
    expect(f.session.activeTaskId).toBe('new-owned-task'); expect(f.session.activeTaskRequestId).toBe('new-voice-request');
    expect(f.session.activeTurnRequestId).toBe('new-voice-request'); expect(newController.signal.aborted).toBe(false); expect(f.outputs).toHaveLength(0);
    expect(await rows(turn)).toEqual([expect.objectContaining({ status: 'cancelled' })]);
  });
  it('marks an executor that returned without any terminal as failed, never completed', async () => {
    const f = createFixture(); let turn!: Turn;
    fixture.process.mockImplementationOnce(async (...args: any[]) => { turn = await admit(args); });
    await pipeline(f);
    expect(getChatExecution(turn.scope, turn.requestId)).toMatchObject({ terminal: true, status: 'failed', terminalEvent: { payload: { blocked: true, reason: 'voice_processing_failed' } } });
    expect(await rows(turn)).toEqual([expect.objectContaining({ status: 'failed' })]); expect(countUnsettledChatExecutions()).toBe(0);
  });
  it('preserves a genuinely committed result byte for byte after normal executor settlement', async () => {
    const f = createFixture(); let turn!: Turn; let committed: any, durable: any;
    fixture.process.mockImplementationOnce(async (...args: any[]) => {
      turn = await admit(args);
      await recordChatExecutionTerminalEventDurably(turn.scope, turn.requestId, 'agent:response', { text: 'Verified original result.', finalized: true });
      committed = getChatExecution(turn.scope, turn.requestId); durable = await rows(turn);
    });
    await pipeline(f);
    expect(getChatExecution(turn.scope, turn.requestId)).toEqual(committed); expect(await rows(turn)).toEqual(durable);
    expect(committed.status).toBe('completed'); expect(countUnsettledChatExecutions()).toBe(0);
  });
  it('quarantines primary and fallback receipt write failures rather than claiming success', async () => {
    const f = createFixture(); let turn!: Turn; const attempts: any[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fixture.process.mockImplementationOnce(async (...args: any[]) => {
      turn = await admit(args); turn.controller.abort();
      await initializeChatExecutionRegistryPersistence({ loadRecoverable: async () => [], purgeExpired: async () => {}, upsert: async receipt => {
        attempts.push(structuredClone(receipt)); throw new Error('SQLITE_IOERR simulated receipt sink failure');
      } });
    });
    await pipeline(f);
    expect(attempts.map(row => [row.status, row.payload.reason])).toEqual([['cancelled', 'cancelled'], ['failed', 'persistence_unknown']]);
    expect(getChatExecution(turn.scope, turn.requestId)).toMatchObject({ terminal: true, status: 'failed', terminalEvent: { payload: { reason: 'persistence_unknown', blocked: true } } });
    expect(await rows(turn)).toHaveLength(0); expect(f.outputs).toHaveLength(0); expect(countUnsettledChatExecutions()).toBe(0);
  });
});
