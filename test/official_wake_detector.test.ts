import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 0;
    sent: Array<string | Buffer> = [];
    handlers = new Map<string, Array<(...args: any[]) => void>>();
    constructor(public url: string) { Socket.instances.push(this); }
    on(name: string, callback: (...args: any[]) => void) { this.handlers.set(name, [...(this.handlers.get(name) || []), callback]); return this; }
    emit(name: string, ...args: any[]) { for (const callback of this.handlers.get(name) || []) callback(...args); }
    send(data: string | Buffer) { this.sent.push(typeof data === 'string' ? data : Buffer.from(data)); }
    open() { this.readyState = 1; this.emit('open'); }
    taskId() { return JSON.parse(this.sent.find(item => typeof item === 'string') as string).header.task_id; }
    message(event: string, payload: unknown = {}, taskId = this.taskId()) { this.emit('message', Buffer.from(JSON.stringify({ header: { event, task_id: taskId }, payload })), false); }
    ready() { this.message('task-started'); }
    transcript(text: string, final = true) { this.message('result-generated', { output: { sentence: { text, sentence_end: final } } }); }
    close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', code, Buffer.from(reason)); }
    terminate() { this.close(1006); }
  }
  return { Socket, configured: true, model: 'aliyun/selected-asr', preference: 'relay' };
});
vi.mock('ws', () => ({ WebSocket: fixture.Socket, default: fixture.Socket }));
vi.mock('../server/config/keys', () => ({ getKey: (name: string) => ({
  RELAY_API_KEY: fixture.configured ? 'synthetic-key' : '', RELAY_BASE_URL: 'https://official.example.test/v1',
  DASHSCOPE_API_KEY: 'unrelated-direct-key',
} as Record<string, string>)[name] }));
vi.mock('../server/config/voice_preference', () => ({
  getVoicePreference: () => ({ stt: fixture.preference, sttModel: fixture.model, tts: 'auto' }),
  getConfiguredVoiceModel: () => fixture.model,
}));
vi.mock('../server/config/privacy', () => ({ requireNotStrict: vi.fn(), isStrictPrivacy: () => false }));

import { createWakeDetector, OFFICIAL_WAKE_ROLLOVER_MS, OFFICIAL_WAKE_READY_TIMEOUT_MS } from '../server/stt/wake_detector';
import { getActiveStreamingSTTProvider } from '../server/stt/adapter';
import { recordFailure, resetCircuit } from '../server/cloud/circuit_breaker';

let detector: ReturnType<typeof createWakeDetector> | undefined;
beforeEach(() => { vi.useFakeTimers(); resetCircuit(); fixture.Socket.instances.length = 0; fixture.configured = true; fixture.preference = 'relay'; fixture.model = 'aliyun/selected-asr'; });
afterEach(() => { detector?.stop(); detector = undefined; resetCircuit(); vi.useRealTimers(); });

describe('official wake listener uses the production STT adapter', () => {
  it('uses the selected official model and waits for its task acknowledgement', () => {
    detector = createWakeDetector();
    const ready = vi.fn(); detector.onReady?.(ready);
    const ws = fixture.Socket.instances[0];
    expect(ws.url).toBe('wss://official.example.test/v1/audio/transcriptions/stream?model=aliyun%2Fselected-asr');
    ws.open(); expect(ready).not.toHaveBeenCalled();
    expect(JSON.parse(ws.sent[0] as string).payload.model).toBe(fixture.model);
    ws.ready(); expect(ready).toHaveBeenCalledOnce();
    ws.ready(); expect(ready).toHaveBeenCalledOnce();
    expect(fixture.Socket.instances).toHaveLength(1);
  });

  it('never routes a missing or unhealthy official selection through an unrelated direct key', () => {
    fixture.configured = false;
    expect(() => createWakeDetector()).toThrow('not configured');
    expect(getActiveStreamingSTTProvider({ requireHealthy: true })).toBeNull();
    fixture.configured = true;
    recordFailure('relay-stt', fixture.model, new Error('403 denied'), { openImmediately: true });
    expect(() => createWakeDetector()).toThrow('circuit is open');
    expect(getActiveStreamingSTTProvider({ requireHealthy: true })).toBeNull();
    expect(fixture.Socket.instances).toHaveLength(0);
  });

  it('filters echoes and partial transcripts through the existing wake-word matcher', () => {
    detector = createWakeDetector(undefined, text => text === 'echo Lumi');
    const wake = vi.fn(); detector.onWake(wake);
    const ws = fixture.Socket.instances[0]; ws.open(); ws.ready();
    ws.transcript('Lumi', false); ws.transcript('echo Lumi'); ws.transcript('ordinary sentence');
    expect(wake).not.toHaveBeenCalled();
    ws.transcript('hey Lumi'); expect(wake).toHaveBeenCalledOnce();
  });

  it('warms a replacement before switching and suppresses a replayed wake at handoff', () => {
    detector = createWakeDetector();
    const wake = vi.fn(); detector.onWake(wake);
    const first = fixture.Socket.instances[0]; first.open(); first.ready();
    detector.sendAudio(Buffer.alloc(96_000, 1));
    vi.advanceTimersByTime(OFFICIAL_WAKE_ROLLOVER_MS);
    const second = fixture.Socket.instances[1];
    expect(first.readyState).toBe(1); expect(second.readyState).toBe(0);
    first.transcript('Lumi'); expect(wake).toHaveBeenCalledOnce();
    second.open(); second.ready();
    expect(first.readyState).toBe(3);
    expect((second.sent.find(Buffer.isBuffer) as Buffer).length).toBe(64_000);
    second.transcript('Lumi'); expect(wake).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(3_001); second.transcript('Lumi'); expect(wake).toHaveBeenCalledTimes(2);
  });

  it('recovers a remotely finished task through the existing resilient STT lifecycle', () => {
    detector = createWakeDetector();
    const first = fixture.Socket.instances[0]; first.open(); first.ready();
    first.message('task-finished');
    vi.advanceTimersByTime(250);
    expect(fixture.Socket.instances).toHaveLength(2);
    const second = fixture.Socket.instances[1]; second.open(); second.ready();
    const wake = vi.fn(); detector.onWake(wake); second.transcript('Lumi'); expect(wake).toHaveBeenCalledOnce();
  });

  it('keeps a healthy active listener while retrying a failed warmup within a fixed budget', () => {
    detector = createWakeDetector();
    const error = vi.fn(); const wake = vi.fn(); detector.onError(error); detector.onWake(wake);
    const first = fixture.Socket.instances[0]; first.open(); first.ready();
    vi.advanceTimersByTime(OFFICIAL_WAKE_ROLLOVER_MS);
    for (const retryDelay of [5_000, 10_000, 20_000]) {
      vi.advanceTimersByTime(OFFICIAL_WAKE_READY_TIMEOUT_MS);
      expect(first.readyState).toBe(1); expect(error).not.toHaveBeenCalled();
      vi.advanceTimersByTime(retryDelay);
    }
    vi.advanceTimersByTime(OFFICIAL_WAKE_READY_TIMEOUT_MS + 60_000);
    expect(fixture.Socket.instances).toHaveLength(5);
    expect(first.readyState).toBe(1); first.transcript('Lumi'); expect(wake).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('ends the listener on an explicit account denial instead of retrying or using a direct provider', () => {
    detector = createWakeDetector();
    const error = vi.fn(); detector.onError(error);
    const first = fixture.Socket.instances[0]; first.open(); first.ready();
    vi.advanceTimersByTime(OFFICIAL_WAKE_ROLLOVER_MS);
    const replacement = fixture.Socket.instances[1]; replacement.open();
    replacement.emit('message', Buffer.from(JSON.stringify({ error: { message: '403 access denied' } })), false);
    expect(error).toHaveBeenCalledOnce();
    expect(first.readyState).toBe(3);
    vi.advanceTimersByTime(60_000); expect(fixture.Socket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not kill the healthy stream when failed replacement connections open their circuit', () => {
    detector = createWakeDetector();
    const error = vi.fn(); detector.onError(error);
    const first = fixture.Socket.instances[0]; first.open(); first.ready();
    vi.advanceTimersByTime(OFFICIAL_WAKE_ROLLOVER_MS);
    for (const delay of [250, 750, 2_000]) {
      const replacement = fixture.Socket.instances.at(-1)!;
      replacement.open(); replacement.emit('error', new Error('synthetic network disconnect'));
      vi.advanceTimersByTime(delay);
    }
    expect(first.readyState).toBe(1);
    expect(error).not.toHaveBeenCalled();
    detector.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it('fails a silent handshake once and releases the underlying connection and timers', () => {
    detector = createWakeDetector();
    const error = vi.fn(); detector.onError(error);
    vi.advanceTimersByTime(OFFICIAL_WAKE_READY_TIMEOUT_MS);
    expect(error).toHaveBeenCalledOnce();
    expect(fixture.Socket.instances[0].readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a task acknowledgement for the wrong task without falsely becoming ready', () => {
    detector = createWakeDetector();
    const ready = vi.fn(); detector.onReady?.(ready);
    const ws = fixture.Socket.instances[0]; ws.open(); ws.message('task-started', {}, 'unrelated-task');
    expect(ready).not.toHaveBeenCalled();
    detector.stop(); vi.advanceTimersByTime(30_000);
    expect(fixture.Socket.instances).toHaveLength(1);
  });

  it('stops both active and warming sessions and ignores late events', () => {
    detector = createWakeDetector();
    const wake = vi.fn(); detector.onWake(wake);
    const first = fixture.Socket.instances[0]; first.open(); first.ready();
    vi.advanceTimersByTime(OFFICIAL_WAKE_ROLLOVER_MS);
    detector.stop(); detector.stop(); first.transcript('Lumi');
    vi.advanceTimersByTime(OFFICIAL_WAKE_ROLLOVER_MS);
    expect(fixture.Socket.instances.every(ws => ws.readyState === 3)).toBe(true);
    expect(fixture.Socket.instances).toHaveLength(2);
    expect(wake).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
