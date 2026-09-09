// @vitest-environment jsdom
import './helpers';
import React from 'react';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { EventEmitter } from 'node:events';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ sources: [] as any[], decode: vi.fn(), synthesize: vi.fn(), model: vi.fn(), preference: vi.fn(), client: null as any, notify: vi.fn(), provider: 'relay' as string | null }));
vi.mock('../server/llm/providers', () => ({ makeLLMCall: (...args: any[]) => fixture.model(...args), makeLLMCallStreaming: vi.fn(() => { throw new Error('Forbidden model path'); }) }));
vi.mock('../server/llm/user_preferences', async original => ({ ...await original<any>(), getUserPreferredLLMConfig: (...args: any[]) => fixture.preference(...args) }));
vi.mock('../server/tts/adapter', async original => ({ ...await original<any>(),
  getActiveProvider: () => fixture.provider,
  listVoices: async () => [{ voiceId: 'selected-voice', name: 'Synthetic voice', provider: 'relay' }],
  synthesizeSpeech: (...args: any[]) => fixture.synthesize(...args),
}));
vi.mock('../server/stt/adapter', () => ({ getActiveStreamingSTTProvider: () => null, createResilientStreamingSession: () => { throw new Error('No real microphone'); } }));
vi.mock('../src/lib/voiceDevicePreferences', () => ({ VOICE_DEVICE_PREFERENCE_CHANGED: 'fixture-device', applyPreferredVoiceOutputDevice: async () => {}, requestPreferredMicrophoneStream: async () => { throw new Error('No real microphone'); } }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => fixture.client }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ addNotification: fixture.notify }) }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: 'en' }) }));

import { initDatabase } from '../db_layer';
import * as database from '../db_layer';
import { randomUUID } from 'node:crypto';
import { buildScheduledProactiveInteractionId } from '../server/scheduler';
import { setVoicePreference } from '../server/config/voice_preference';
import * as memoryStore from '../server/memory/store';
import { registerVoiceHandlers } from '../server/socket/voice';
import { loadEmotionalState, saveEmotionalState } from '../server/personality/state';
import { saveGateConfig } from '../server/autonomy/safety_gate';
import { createOrg, addMember, removeMember } from '../server/org/db';
import { scopedEmotionalStateKey } from '../server/socket/scope';
import { useVoiceCall } from '../src/hooks/useVoiceCall';
import { claimVoiceCapture, releaseVoiceCapture } from '../src/lib/voiceCaptureLease';
import { ProactiveNotifications } from '../src/components/ProactiveNotifications';

class ServerSocket extends EventEmitter {
  id = `proactive-${Math.random()}`; connected = true;
  data: any = { authenticatedUserId: 'proactive-fixture-owner', authenticatedRole: 'user' };
  handshake = { address: '127.0.0.1', headers: {}, auth: {} };
  outputs: Array<[string, any]> = []; client?: ClientSocket;
  emit(event: string, data?: any): boolean { this.outputs.push([event, data]); this.client?.deliver(event, data); return true; }
  async receive(event: string, data?: any) { await Promise.all(this.listeners(event).map(listener => listener(data))); }
}
class ClientSocket extends EventEmitter {
  connected = true; outputs: Array<[string, any]> = []; pending: Promise<void>[] = [];
  constructor(readonly server: ServerSocket) { super(); server.client = this; }
  emit(event: string, data?: any): boolean { this.outputs.push([event, data]); this.pending.push(this.server.receive(event, data)); return true; }
  deliver(event: string, data?: any) { return super.emit(event, data); }
  async drain() { while (this.pending.length) await Promise.all(this.pending.splice(0)); }
}
class AudioContextFixture {
  state = 'running'; destination = {}; currentTime = 0;
  async resume() { this.state = 'running'; } async close() { this.state = 'closed'; }
  decodeAudioData() { return fixture.decode(); }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  createBufferSource() { const source = { buffer: null, onended: null as any, connect() {}, disconnect() {}, start: vi.fn(), stop: vi.fn() }; fixture.sources.push(source); return source; }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const sockets: ServerSocket[] = [];
const preference = { userId: 'proactive-fixture-owner', domain: 'personal' as const, voiceId: 'selected-voice', outputMuted: false };
function setup(overrides: Partial<NonNullable<Parameters<typeof useVoiceCall>[0]['proactive']>> = {}) {
  const server = new ServerSocket(); sockets.push(server);
  if (overrides.domain === 'work') server.data.authenticatedOrgId = overrides.orgId;
  const client = fixture.client = new ClientSocket(server);
  registerVoiceHandlers(server as any, {} as any, () => ({}), () => server.data.authenticatedUserId, { to: () => ({ emit() {} }), emit() {} } as any);
  const settings: NonNullable<Parameters<typeof useVoiceCall>[0]['proactive']> = { ...preference, ...overrides };
  const hook = renderHook(({ settings }) => useVoiceCall({ socket: client, proactive: settings }), { initialProps: { settings } });
  return { server, client, hook };
}
function returnDetection(socket: ClientSocket) {
  const file = 'src/components/DesktopUI.tsx'; const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression = '';
  function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'onIdleReport') expression = node.initializer!.getText(ast); ts.forEachChild(node, visit); }
  visit(ast); expect(expression).toContain('greeting:generate');
  return vm.runInNewContext(ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    socket, localStorage, lastIdleRef: { current: 0 }, greetedRef: { current: false },
    IDLE_AWAY_SECONDS: 120, RETURN_IDLE_SECONDS: 10, callState: 'idle', isMuted: false, volume: 60, workDomain: 'personal',
  });
}
async function persistedReminder(options: { userId?: string; domain?: string; orgId?: string; content?: string } = {}) {
  const timestamp = new Date().toISOString();
  const scope = { userId: options.userId || preference.userId, domain: (options.domain || 'personal') as 'personal' | 'work', orgId: options.orgId || '' };
  const reminderId = `rem_${randomUUID()}`;
  const executionId = `scheduler_test_${randomUUID()}`;
  const interactionId = buildScheduledProactiveInteractionId(executionId, 0, scope);
  const content = options.content || 'Take a short break';
  const db = database.readDB();
  db.reminders ||= [];
  db.reminders.push({ id: reminderId, ...scope, content, dueAt: timestamp, status: 'fired', firedAt: timestamp,
    sourceInteractionId: 'synthetic-request', createdAt: timestamp });
  db.interactions.push({ id: interactionId, ...scope, agentId: 'lumi', conversationId: '', module: 'lumi',
    message: `[reminder_check] Reminder: ${content}`, response: '', role: 'assistant', mode: 'proactive', personality: 'lumi',
    timestamp, toolCalls: JSON.stringify({ executionId, scheduledTaskId: 'reminder_check', reminderIds: [reminderId] }),
  });
  database.writeDB(db); await database.flushDBOrThrow();
  return { interactionId, reminderId, payload: { taskId: 'reminder_check', interactionId, message: `Reminder: ${content}` } };
}
async function setLowInitiative() {
  saveEmotionalState(preference.userId, { ...loadEmotionalState(preference.userId), initiative: 0.15 });
  await vi.waitFor(() => expect(loadEmotionalState(preference.userId).initiative).toBe(0.15));
}
beforeAll(async () => { await initDatabase(); });
beforeEach(() => {
  fixture.sources = []; fixture.provider = 'relay'; fixture.notify.mockReset();
  fixture.decode.mockReset().mockResolvedValue({ duration: 2 });
  fixture.model.mockReset().mockResolvedValue({ text: '欢迎回来，今天过得怎么样？' });
  fixture.preference.mockReset().mockReturnValue({ provider: 'relay', model: 'synthetic-model' });
  fixture.synthesize.mockReset().mockResolvedValue({ audioBuffer: new Uint8Array([1, 2, 3]).buffer });
  vi.stubGlobal('AudioContext', AudioContextFixture);
  vi.spyOn(Date.prototype, 'getHours').mockReturnValue(13);
  localStorage.setItem('lumi_allow_proactive_voice', 'true');
  setVoicePreference({ tts: 'relay', ttsModel: 'aliyun/cosyvoice-v3-flash' });
  saveEmotionalState(preference.userId, { ...loadEmotionalState(preference.userId), initiative: 1 });
  saveGateConfig({ quietHoursEnabled: false }, preference.userId);
});
afterEach(async () => { cleanup(); for (const socket of sockets.splice(0)) { socket.connected = false; await socket.receive('disconnect'); } vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
afterAll(() => { fixture.client = null; });

describe('proactive speech through production desktop, server and playback', () => {
  it('speaks the return greeting using the signed-in model and selected voice before any microphone call', async () => {
    const { server, client } = setup(); const onIdleReport = returnDetection(client);
    await act(async () => { onIdleReport({ idle_seconds: 180 }); onIdleReport({ idle_seconds: 0 }); await client.drain(); });
    expect(client.outputs.some(([event]) => event === 'audio:start')).toBe(false);
    expect(server.data.audioSession.userId).toBe(''); // the old uninitialized microphone session is not repurposed
    expect(fixture.preference).toHaveBeenCalledWith(preference.userId, expect.objectContaining({ domain: 'personal' }));
    expect(fixture.synthesize).toHaveBeenCalledWith('欢迎回来，今天过得怎么样？', expect.objectContaining({ provider: 'relay', voiceId: 'selected-voice', allowFallback: false }));
    expect(fixture.sources[0].start).toHaveBeenCalledOnce();
    expect(server.outputs.find(([event]) => event === 'audio:proactive_speak')?.[1]).toMatchObject({ userId: preference.userId, domain: 'personal', contextId: expect.any(String) });
  });

  it('keeps the notification-center text and speaks the same permitted proactive notification', async () => {
    const { client } = setup(); render(<ProactiveNotifications />);
    await act(async () => { client.deliver('agent:proactive', { type: 'greeting', message: '欢迎回来。' }); await client.drain(); });
    expect(fixture.notify).toHaveBeenCalledWith(expect.objectContaining({ message: '欢迎回来。' }));
    expect(fixture.synthesize).toHaveBeenCalledWith('欢迎回来。', expect.objectContaining({ voiceId: 'selected-voice' }));
    expect(fixture.sources[0].start).toHaveBeenCalledOnce();
    expect(fixture.model).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'output-muted', 'quiet-hours', 'night', 'no-provider', 'foreign-owner'] as const)('suppresses automatic synthesis when %s', async reason => {
    if (reason === 'disabled') localStorage.setItem('lumi_allow_proactive_voice', 'false');
    if (reason === 'quiet-hours') saveGateConfig({ quietHoursEnabled: true, quietHoursStart: 12, quietHoursEnd: 14 }, preference.userId);
    if (reason === 'night') vi.mocked(Date.prototype.getHours).mockReturnValue(2);
    if (reason === 'no-provider') fixture.provider = null;
    const { client } = setup({ ...(reason === 'output-muted' ? { outputMuted: true } : {}), ...(reason === 'foreign-owner' ? { userId: 'other-owner' } : {}) });
    await act(async () => { client.emit('greeting:generate', { scene: 'return' }); await client.drain(); });
    expect(fixture.synthesize).not.toHaveBeenCalled(); expect(fixture.sources).toEqual([]);
  });

  it('uses the active provider default when no particular speaker has been selected', async () => {
    const { client } = setup({ voiceId: '' });
    await act(async () => { client.emit('greeting:generate', {}); await client.drain(); });
    expect(fixture.synthesize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ voiceId: 'selected-voice' }));
  });

  it('cancels a late TTS result when the opt-in is disabled and a subsequent enabled greeting still works', async () => {
    const held = deferred<any>(); fixture.synthesize.mockImplementationOnce(() => held.promise);
    const { client, server } = setup();
    await act(async () => { client.emit('greeting:generate', {}); });
    await vi.waitFor(() => expect(fixture.synthesize).toHaveBeenCalledOnce());
    await act(async () => { localStorage.setItem('lumi_allow_proactive_voice', 'false'); window.dispatchEvent(new CustomEvent('lumi:setting-changed', { detail: { key: 'lumi_allow_proactive_voice' } })); });
    expect(fixture.synthesize.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { held.resolve({ audioBuffer: new Uint8Array([4]).buffer }); await client.drain(); });
    expect(server.outputs.some(([event]) => event === 'audio:proactive_speak')).toBe(false);
    await act(async () => { localStorage.setItem('lumi_allow_proactive_voice', 'true'); window.dispatchEvent(new CustomEvent('lumi:setting-changed')); client.emit('greeting:generate', {}); await client.drain(); });
    expect(fixture.sources[0].start).toHaveBeenCalledOnce();
  });

  it('does not play a decoded old owner result after account change', async () => {
    const held = deferred<any>(); fixture.decode.mockImplementationOnce(() => held.promise);
    const { client, hook, server } = setup();
    await act(async () => { client.emit('greeting:generate', {}); await client.drain(); });
    server.data.authenticatedUserId = 'other-owner';
    hook.rerender({ settings: { ...preference, userId: 'other-owner' } });
    await act(async () => { held.resolve({ duration: 2 }); });
    expect(fixture.sources).toEqual([]);
  });

  it('a private/meeting microphone claim stops active proactive sound and blocks another greeting', async () => {
    const { client } = setup();
    await act(async () => { client.emit('greeting:generate', {}); await client.drain(); });
    const token = Symbol('synthetic-private-call');
    try {
      await act(async () => { claimVoiceCapture(token, () => {}); client.emit('greeting:generate', {}); await client.drain(); });
      expect(fixture.sources[0].stop).toHaveBeenCalledOnce();
      expect(fixture.synthesize).toHaveBeenCalledOnce();
    } finally { await act(async () => { releaseVoiceCapture(token); }); }
  });

  it('mute stops active greeting and reconnect rejects the previous context packet', async () => {
    const { client, hook, server } = setup();
    await act(async () => { client.emit('greeting:generate', {}); await client.drain(); });
    const oldPacket = server.outputs.find(([event]) => event === 'audio:proactive_speak')![1];
    await act(async () => { hook.result.current.toggleMute(); });
    expect(fixture.sources[0].stop).toHaveBeenCalledOnce();
    await act(async () => { client.deliver('disconnect'); client.deliver('connect'); client.deliver('audio:proactive_speak', oldPacket); await client.drain(); });
    expect(fixture.sources).toHaveLength(1);
  });

  it('a revoked organization greeting cannot publish after remove/rejoin during synthesis', async () => {
    const org = createOrg('Synthetic proactive org', `synthetic-${Math.random()}`, preference.userId);
    addMember(org.id, preference.userId, 'owner');
    const key = scopedEmotionalStateKey(preference.userId, { domain: 'work', orgId: org.id });
    saveEmotionalState(key, { ...loadEmotionalState(key), initiative: 1 });
    await vi.waitFor(() => expect(loadEmotionalState(key).initiative).toBe(1));
    const { client, server } = setup({ domain: 'work', orgId: org.id });
    await act(async () => { client.emit('greeting:generate', {}); await client.drain(); });
    expect(fixture.synthesize).toHaveBeenCalledOnce();
    expect(fixture.sources[0].start).toHaveBeenCalledOnce();
    await act(async () => { fixture.sources[0].onended(); });
    const held = deferred<any>(); fixture.synthesize.mockImplementationOnce(() => held.promise);
    await act(async () => { client.emit('greeting:generate', {}); });
    await vi.waitFor(() => expect(fixture.synthesize).toHaveBeenCalledTimes(2));
    removeMember(org.id, preference.userId); addMember(org.id, preference.userId, 'owner');
    await act(async () => { held.resolve({ audioBuffer: new Uint8Array([5]).buffer }); await client.drain(); });
    expect(server.outputs.filter(([event]) => event === 'audio:proactive_speak')).toHaveLength(1);
    expect(fixture.sources).toHaveLength(1);
  });

  it('TTS failures release the optional speech lane so the next notification can play', async () => {
    fixture.synthesize.mockRejectedValueOnce(new Error('Synthetic TTS unavailable'));
    const { client, hook } = setup();
    await act(async () => { client.emit('greeting:generate', {}); await client.drain(); });
    expect(fixture.sources).toEqual([]);
    expect(fixture.synthesize).toHaveBeenCalledOnce();
    expect(hook.result.current.error).toContain('Proactive voice output is temporarily unavailable');
    await act(async () => { client.emit('proactive:request_speak', { message: '欢迎回来。' }); await client.drain(); });
    expect(fixture.sources[0].start).toHaveBeenCalledOnce();
    expect(hook.result.current.error).toBeNull();
    for (const [, config] of fixture.synthesize.mock.calls) expect(config.allowFallback).toBe(false);
  });

  it('honors opted-in return greetings at default initiative and keeps return-event deduplication', async () => {
    await setLowInitiative();
    const { client } = setup(); const onIdleReport = returnDetection(client);
    await act(async () => { onIdleReport({ idle_seconds: 180 }); onIdleReport({ idle_seconds: 0 }); onIdleReport({ idle_seconds: 0 }); await client.drain(); });
    expect(fixture.model).toHaveBeenCalledOnce();
    expect(fixture.synthesize).toHaveBeenCalledOnce();
    expect(fixture.sources[0].start).toHaveBeenCalledOnce();
    expect(loadEmotionalState(preference.userId).initiative).toBe(0.15);
  });

  it('uses one fixed greeting when text generation fails, without another model request', async () => {
    fixture.model.mockRejectedValueOnce(new Error('Synthetic text provider unavailable'));
    const { client } = setup();
    await act(async () => { client.emit('greeting:generate', {}); await client.drain(); });
    expect(fixture.model).toHaveBeenCalledOnce();
    expect(fixture.synthesize).toHaveBeenCalledExactlyOnceWith('下午好，继续吧。', expect.objectContaining({ provider: 'relay', allowFallback: false }));
    expect(fixture.sources[0].start).toHaveBeenCalledOnce();
  });

  it('speaks a durable reminder before any microphone call at low initiative, using stored content and current relay TTS', async () => {
    await setLowInitiative();
    const reminder = await persistedReminder();
    const { client, server } = setup(); render(<ProactiveNotifications />);
    await act(async () => { client.deliver('agent:proactive', { ...reminder.payload, message: 'Client replacement text' }); await client.drain(); });
    expect(fixture.synthesize).toHaveBeenCalledExactlyOnceWith(reminder.payload.message, expect.objectContaining({ provider: 'relay', model: 'aliyun/cosyvoice-v3-flash', allowFallback: false }));
    expect(fixture.sources[0].start).toHaveBeenCalledOnce();
    expect(fixture.model).not.toHaveBeenCalled();
    expect(server.data.audioSession.userId).toBe('');
    expect(server.outputs.find(([event]) => event === 'audio:proactive_speak')?.[1]).toMatchObject({ interactionId: reminder.interactionId });
    const row = database.readDB().interactions.find((row: any) => row.id === reminder.interactionId);
    expect(JSON.parse(row.toolCalls).proactiveVoiceDispatch).toMatchObject({ reservedAt: expect.any(String) });
  });

  it('deduplicates simultaneous and repeated reminder deliveries across sockets', async () => {
    const reminder = await persistedReminder(); const held = deferred<any>();
    fixture.synthesize.mockReturnValueOnce(held.promise);
    const first = setup(); const second = setup();
    const request = { message: reminder.payload.message, interactionId: reminder.interactionId };
    await act(async () => { first.client.emit('proactive:request_speak', request); });
    await vi.waitFor(() => expect(fixture.synthesize).toHaveBeenCalledOnce());
    await act(async () => { second.client.emit('proactive:request_speak', request); await second.client.drain(); });
    await act(async () => { held.resolve({ audioBuffer: new Uint8Array([5]).buffer }); await first.client.drain(); });
    await act(async () => { second.client.emit('proactive:request_speak', request); await second.client.drain(); });
    expect(fixture.synthesize).toHaveBeenCalledOnce();
    expect([...first.server.outputs, ...second.server.outputs].filter(([event]) => event === 'audio:proactive_speak')).toHaveLength(1);
  });

  it.each(['unknown-id', 'foreign-user', 'foreign-domain', 'wrong-source', 'cancelled'] as const)('rejects an unverified reminder (%s)', async reason => {
    await setLowInitiative();
    const reminder = await persistedReminder(reason === 'foreign-user' ? { userId: 'other-owner' } : reason === 'foreign-domain' ? { domain: 'work', orgId: 'other-org' } : {});
    const db = database.readDB();
    if (reason === 'wrong-source') db.interactions.find((row: any) => row.id === reminder.interactionId).mode = 'chat';
    if (reason === 'cancelled') db.reminders = db.reminders.filter((row: any) => row.id !== reminder.reminderId);
    database.writeDB(db);
    const { client } = setup();
    await act(async () => { client.emit('proactive:request_speak', { taskId: 'reminder_check', message: reminder.payload.message,
      interactionId: reason === 'unknown-id' ? 'proactive_' + '0'.repeat(24) : reminder.interactionId }); await client.drain(); });
    expect(fixture.synthesize).not.toHaveBeenCalled();
    expect(fixture.sources).toEqual([]);
  });

  it.each(['disabled', 'muted', 'quiet', 'private-call'] as const)('retains reminder voice permission gates (%s)', async reason => {
    const reminder = await persistedReminder();
    if (reason === 'disabled') localStorage.setItem('lumi_allow_proactive_voice', 'false');
    if (reason === 'quiet') saveGateConfig({ quietHoursEnabled: true, quietHoursStart: 12, quietHoursEnd: 14 }, preference.userId);
    const { client } = setup({ outputMuted: reason === 'muted' });
    const token = Symbol('private-reminder-test');
    try {
      if (reason === 'private-call') await act(async () => { claimVoiceCapture(token, () => {}); });
      await act(async () => { client.emit('proactive:request_speak', { message: reminder.payload.message, interactionId: reminder.interactionId }); await client.drain(); });
      expect(fixture.synthesize).not.toHaveBeenCalled();
      expect(fixture.sources).toEqual([]);
    } finally { if (reason === 'private-call') await act(async () => { releaseVoiceCapture(token); }); }
  });

  it.each(['cancelled', 'muted'] as const)('drops a late synthesized reminder after %s', async reason => {
    const reminder = await persistedReminder(); const held = deferred<any>(); fixture.synthesize.mockReturnValueOnce(held.promise);
    const { client, hook, server } = setup();
    await act(async () => { client.emit('proactive:request_speak', { message: reminder.payload.message, interactionId: reminder.interactionId }); });
    await vi.waitFor(() => expect(fixture.synthesize).toHaveBeenCalledOnce());
    if (reason === 'muted') await act(async () => { hook.result.current.toggleMute(); });
    else { const db = database.readDB(); db.reminders = db.reminders.filter((row: any) => row.id !== reminder.reminderId); database.writeDB(db); }
    await act(async () => { held.resolve({ audioBuffer: new Uint8Array([9]).buffer }); await client.drain(); });
    expect(server.outputs.some(([event]) => event === 'audio:proactive_speak')).toBe(false);
    expect(fixture.sources).toEqual([]);
  });

  it('does not dispatch a reminder on reservation persistence failure and permits a later retry', async () => {
    const reminder = await persistedReminder(); const { client, hook } = setup();
    const flush = vi.spyOn(database, 'flushDBOrThrow').mockRejectedValueOnce(new Error('Synthetic save failure'));
    const request = { message: reminder.payload.message, interactionId: reminder.interactionId };
    await act(async () => { client.emit('proactive:request_speak', request); await client.drain(); });
    expect(fixture.sources).toEqual([]);
    expect(hook.result.current.error).toContain('Proactive voice output');
    flush.mockRestore();
    await act(async () => { client.emit('proactive:request_speak', request); await client.drain(); });
    expect(fixture.sources[0].start).toHaveBeenCalledOnce();
  });

  it('does not repeat a dispatched greeting if saving its memory fails', async () => {
    const { client, server } = setup();
    vi.spyOn(memoryStore, 'addMemory').mockImplementationOnce(() => { throw new Error('Synthetic memory save failure'); });
    await act(async () => { client.emit('greeting:generate', {}); await client.drain(); });
    expect(fixture.model).toHaveBeenCalledOnce();
    expect(fixture.synthesize).toHaveBeenCalledOnce();
    expect(server.outputs.filter(([event]) => event === 'audio:proactive_speak')).toHaveLength(1);
    expect(fixture.sources[0].start).toHaveBeenCalledOnce();
  });

  it('reports client playback failure without pretending audio started', async () => {
    fixture.decode.mockRejectedValueOnce(new Error('Synthetic output failure'));
    const { client, hook } = setup();
    await act(async () => { client.emit('greeting:generate', {}); await client.drain(); });
    expect(fixture.sources).toEqual([]);
    expect(hook.result.current.callState).toBe('idle');
    expect(hook.result.current.error).toContain('Proactive voice output could not be played');
  });

  it('does not treat a client task label without a persisted reminder as scheduled authority', async () => {
    await setLowInitiative();
    const { client } = setup(); render(<ProactiveNotifications />);
    await act(async () => {
      client.deliver('agent:proactive', { taskId: 'reminder_check', message: 'A client supplied reminder' });
      client.emit('proactive:request_speak', { taskId: 'reminder_check', message: 'A client supplied reminder' });
      await client.drain();
    });
    expect(fixture.synthesize).not.toHaveBeenCalled();
  });

  it('rejects an in-memory reminder candidate that has not crossed the durable delivery boundary', async () => {
    const reminder = await persistedReminder();
    await database.withDatabaseSqlWriteLock(({ run }) => run('DELETE FROM interactions WHERE id = ?', [reminder.interactionId]));
    expect(database.readDB().interactions.some((row: any) => row.id === reminder.interactionId)).toBe(true);
    const { client } = setup();
    await act(async () => { client.emit('proactive:request_speak', { message: reminder.payload.message, interactionId: reminder.interactionId }); await client.drain(); });
    expect(fixture.synthesize).not.toHaveBeenCalled();
    expect(fixture.sources).toEqual([]);
  });
});
