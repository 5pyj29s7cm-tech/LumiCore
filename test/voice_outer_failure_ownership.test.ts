import './helpers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ process: vi.fn(), boundary: vi.fn(), cancel: vi.fn() }));
vi.mock('../server/socket/voice_conversation_turn', () => ({ processVoiceInput: (...args: any[]) => fixture.process(...args) }));
vi.mock('../server/socket/chat_terminal_boundary', async original => {
  const actual = await original<typeof import('../server/socket/chat_terminal_boundary')>();
  return { ...actual, commitChatTerminalBoundary: (input: any) => fixture.boundary(input, actual.commitChatTerminalBoundary) };
});
vi.mock('../server/socket/voice_transport_runtime', async original => {
  const actual = await original<typeof import('../server/socket/voice_transport_runtime')>();
  return { ...actual, cancelActiveVoiceTurn: (...args: any[]) => fixture.cancel(args, actual.cancelActiveVoiceTurn) };
});
vi.mock('../server/tts/adapter', async original => ({ ...await original<typeof import('../server/tts/adapter')>(), getActiveProvider: () => null }));
import { initDatabase, readDB, writeDB } from '../db_layer';
import { getMessages, getMessagesForAgent, getOrCreateActiveConversation, startNewConversation } from '../server/conversation/manager';
import { reserveConversationExecution } from '../server/cognition/conversation_execution';
import { getAudioSession, type VoiceInputResources } from '../server/socket/voice/session';
import { prepareVoiceIdentityAndAdmission } from '../server/socket/voice/turn/prepare_voice_identity_and_admission';
import { runLumiEntryTurn } from '../server/cognition/turn_execution';
import { runVoiceInputPipeline } from '../server/socket/voice_input_pipeline';
let sequence = 0;
function createFixture() {
  const outputs: Array<[string, any]> = [];
  const socket = { data: { authenticatedRole: 'user' }, connected: true, emit: (event: string, payload: any) => { outputs.push([event, payload]); return true; } } as any;
  const session = getAudioSession(socket);
  Object.assign(session, { userId: 'voice-outer-failure-' + ++sequence, agentId: 'lumi', personalityId: 'lumi', isActive: true, isProcessing: true, sessionId: 'call-' + sequence, domain: 'personal', orgId: '' });
  const selected = getOrCreateActiveConversation(session.userId, 'lumi', 'personal', '');
  session.conversationId = selected.id;
  return { socket, session, selected, outputs };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function admitThenFail(socket: any, session: any, text: string, getters: any, sensory: any, io: any, received: string, authorized: boolean, timing: any, resources: VoiceInputResources) {
  const result = await prepareVoiceIdentityAndAdmission(socket, session, text, getters, sensory, io, received, authorized, timing, resources);
  if (result.terminal) return;
  const entry = result.entry!;
  return runLumiEntryTurn<void>({
    entry: { source: 'voice', channel: 'voice', historyLimit: 0, failureText: 'Voice preparation failed.', failureReason: 'voice_processing_failed' },
    identity: { userId: entry.session.userId, agentId: entry.conversationTurn.conversation.agentId,
      conversationId: entry.conversationTurn.conversation.id, requestId: entry.requestId, domain: entry.voiceScope.domain, orgId: entry.voiceScope.orgId },
    userText: entry.userText, persistence: 'preaccepted', authorization: entry.turnAuthorization, controller: entry.pipelineAbort,
    resource: { admission: resources.admission, ownedByDurableRelease: true },
    planning: async () => {
      const prepared = await result.resume!();
      if (prepared.terminal) return { terminal: undefined };
      throw new Error('synthetic failure before action lease');
    },
    assemble: () => { throw new Error('Failure injection must precede model assembly'); },
    deliver: () => { throw new Error('Failure injection must precede delivery'); },
  });
}
const runPipeline = (f: ReturnType<typeof createFixture>) => runVoiceInputPipeline(f.socket, f.session, 'An accepted voice question.', {} as any, () => ({}), {} as any, undefined, true);
beforeAll(async () => { await initDatabase(); });
beforeEach(() => {
  fixture.process.mockReset().mockImplementation(admitThenFail);
  fixture.boundary.mockReset().mockImplementation((input, actual) => actual(input));
  fixture.cancel.mockReset().mockImplementation((args, actual) => actual(...args));
});
describe('outer voice failure owns its accepted conversation and call', () => {
  it('writes an admission failure to the selected archived transcript exactly once', async () => {
    const f = createFixture(); const active = startNewConversation(f.session.userId, 'lumi', 'personal', '');
    await runPipeline(f);
    const responses = getMessages(f.selected.id).filter(row => row.role === 'assistant');
    expect(responses).toHaveLength(1);
    expect(responses[0].requestId).toMatch(/^voice_/);
    expect(getMessages(active.id)).toHaveLength(0);
    expect(getOrCreateActiveConversation(f.session.userId, 'lumi', 'personal', '').id).toBe(active.id);
    expect(f.outputs).toContainEqual(['agent:response', expect.objectContaining({ conversationId: f.selected.id, requestId: responses[0].requestId, reason: 'voice_processing_failed' })]);
    expect(f.session.isProcessing).toBe(false);
    const later = reserveConversationExecution({ userId: f.session.userId, conversationId: f.selected.id, source: 'chat' }, 'after-failed-voice');
    await later.waitForTurn(); later.release();
  });
  it('never creates a transcript when failure precedes request admission', async () => {
    const f = createFixture(); const before = readDB().conversations.length;
    f.session.conversationId = undefined;
    fixture.process.mockRejectedValueOnce(new Error('synthetic failure before identity'));
    await runPipeline(f);
    expect(readDB().conversations.length).toBe(before);
    expect(getMessages(f.selected.id)).toHaveLength(0);
    expect(f.outputs.some(([event]) => event === 'agent:response')).toBe(false);
  });
  it.each(['new-call', 'new-turn'] as const)('an old rejection cannot cancel or dequeue a %s', async replacement => {
    const f = createFixture(); const pending = deferred();
    fixture.process.mockImplementationOnce(async () => { await pending.promise; throw new Error('late old rejection'); });
    const old = runPipeline(f);
    if (replacement === 'new-call') { f.session.callControlGeneration++; f.session.sessionId = 'replacement-call'; }
    else f.session.voiceTurnGeneration++;
    const controller = new AbortController(); f.session.pipelineAbortController = controller;
    f.session.activeTurnRequestId = 'replacement-request'; f.session.isProcessing = false;
    const queued = { text: 'New call queued action', queuedAt: new Date().toISOString(), voiceAuthorized: true, inputTiming: {} };
    f.session.inputQueue = [queued]; pending.resolve(); await old;
    expect(controller.signal.aborted).toBe(false);
    expect(f.session.activeTurnRequestId).toBe('replacement-request');
    expect(f.session.inputQueue).toEqual([queued]);
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(fixture.process).toHaveBeenCalledOnce();
    expect(f.outputs).toHaveLength(0);
  });
  it('late terminal persistence keeps the old identity and cannot publish or clear the new call', async () => {
    const f = createFixture(); const pending = deferred();
    fixture.boundary.mockImplementationOnce(async (input, actual) => { await pending.promise; return actual(input); });
    const old = runPipeline(f); await vi.waitFor(() => expect(fixture.boundary).toHaveBeenCalledOnce());
    f.session.callControlGeneration++; f.session.sessionId = 'new-call'; f.session.agentId = 'new-agent'; f.session.personalityId = 'new-personality';
    const controller = new AbortController(); f.session.pipelineAbortController = controller; f.session.activeTurnRequestId = 'new-request';
    f.session.activeTaskConversationId = 'new-task-conversation'; f.session.activeTaskRequestId = 'new-request'; f.session.activeTaskId = 'new-task';
    const queued = { text: 'New action', queuedAt: new Date().toISOString(), voiceAuthorized: true, inputTiming: {} }; f.session.inputQueue = [queued];
    pending.resolve(); await old;
    expect(getMessages(f.selected.id).filter(row => row.role === 'assistant')).toHaveLength(1);
    expect(getMessagesForAgent(f.session.userId, 'new-agent')).toHaveLength(0);
    expect(controller.signal.aborted).toBe(false);
    expect(f.session.activeTurnRequestId).toBe('new-request');
    expect(f.session.activeTaskId).toBe('new-task');
    expect(f.session.inputQueue).toEqual([queued]);
    expect(f.outputs).toHaveLength(0);
  });
  it('does not clear task ownership or announce listening when cancellation cannot converge', async () => {
    const f = createFixture(); f.session.activeTaskId = 'durable-task-still-owned';
    fixture.cancel.mockResolvedValueOnce(false);
    await runPipeline(f);
    expect(f.session.activeTaskId).toBe('durable-task-still-owned');
    expect(f.session.isProcessing).toBe(true);
    expect(f.outputs.some(([event]) => event === 'audio:status')).toBe(false);
  });
  it('revokes a waiting old call before the preceding conversation owner releases', async () => {
    const f = createFixture(); const prior = reserveConversationExecution({ userId: f.session.userId, conversationId: f.selected.id, source: 'chat' }, 'prior-chat');
    await prior.waitForTurn(); const old = runPipeline(f);
    try {
      await vi.waitFor(() => expect(getMessages(f.selected.id).some(row => row.role === 'user')).toBe(true));
      const resources = fixture.process.mock.calls[0][9] as VoiceInputResources;
      await vi.waitFor(() => expect(resources.admission?.waitingForRequestId).toBe('prior-chat'));
      f.session.callControlGeneration++; f.session.sessionId = 'new-call';
      f.session.activeTurnRequestId = 'new-request'; f.session.pipelineAbortController = new AbortController();
      await vi.waitFor(() => expect(resources.admission?.controller.signal.aborted).toBe(true));
      expect(resources.admission?.waitingForRequestId).toBe('prior-chat');
      prior.release(); await old;
      expect(getMessages(f.selected.id).some(row => row.role === 'assistant')).toBe(false);
      expect(f.session.activeTurnRequestId).toBe('new-request');
      expect(f.outputs).toHaveLength(0);
    } finally { prior.release(); await old; }
  });
  it('a deleted waiting transcript releases the current lane without writing into a replacement chat', async () => {
    const f = createFixture(); const prior = reserveConversationExecution({ userId: f.session.userId, conversationId: f.selected.id, source: 'chat' }, 'before-deleted-voice');
    await prior.waitForTurn(); const old = runPipeline(f);
    try {
      await vi.waitFor(() => expect(getMessages(f.selected.id).some(row => row.role === 'user')).toBe(true));
      const resources = fixture.process.mock.calls[0][9] as VoiceInputResources;
      await vi.waitFor(() => expect(resources.admission?.waitingForRequestId).toBe('before-deleted-voice'));
      const active = startNewConversation(f.session.userId, 'lumi', 'personal', '');
      const db = readDB(); db.conversations = db.conversations.filter(row => row.id !== f.selected.id); writeDB(db);
      f.session.inputQueue = [{ text: 'Stale queued work', queuedAt: new Date().toISOString(), voiceAuthorized: true, inputTiming: {} }];
      await vi.waitFor(() => expect(resources.admission?.controller.signal.aborted).toBe(true));
      prior.release(); await old;
      expect(getMessages(active.id)).toHaveLength(0);
      expect(getOrCreateActiveConversation(f.session.userId, 'lumi', 'personal', '').id).toBe(active.id);
      expect(f.session.isProcessing).toBe(false);
      expect(f.session.inputQueue).toHaveLength(0);
      expect(f.outputs.some(([event]) => event === 'agent:response')).toBe(false);
      expect(fixture.process).toHaveBeenCalledOnce();
    } finally { prior.release(); await old; }
  });
});
