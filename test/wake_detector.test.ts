import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

// ── Wake detector factory — pure logic tests ──

// Node.js doesn't have WebSocket built-in; mock it so factory doesn't throw
const originalWebSocket = (globalThis as any).WebSocket;
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: any) => void) | null = null;

  constructor(_url: string, _options?: unknown) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  error() {
    this.onerror?.();
  }

  remoteClose(code = 1000, reason = '') {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  close() {
    this.remoteClose(1000, '');
  }
}
(globalThis as any).WebSocket = MockWebSocket;

function sentEvents(socket: MockWebSocket, type: string): Array<Record<string, any>> {
  return socket.sent
    .map(payload => JSON.parse(payload) as Record<string, any>)
    .filter(event => event.type === type);
}

describe('Wake Detector Factory', () => {
  const mockGetVoicePref = vi.fn();
  const mockGetKey = vi.fn();

  afterAll(() => {
    (globalThis as any).WebSocket = originalWebSocket;
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    MockWebSocket.instances.length = 0;
    // Reset env
    delete process.env.DOUBAO_SPEECH_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.QWEN_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when no keys are configured', async () => {
    // Simulate no keys at all
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'auto', tts: 'auto' }),
    }));
    vi.doMock('../server/config/keys', () => ({
      getKey: () => undefined,
    }));

    const { createWakeDetector } = await import('../server/stt/wake_detector');
    expect(() => createWakeDetector()).toThrow('Doubao Speech');
  });

  it('selects Qwen when STT preference is qwen and key exists', async () => {
    process.env.DASHSCOPE_API_KEY = 'sk-test123';
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'qwen', tts: 'auto' }),
    }));
    vi.doMock('../server/config/keys', () => ({
      getKey: () => undefined,
    }));

    const { createWakeDetector } = await import('../server/stt/wake_detector');
    // Should not throw — Qwen key is in env
    const session = createWakeDetector();
    expect(session).toBeDefined();
    expect(session.sendAudio).toBeDefined();
    expect(session.stop).toBeDefined();
    expect(session.onWake).toBeDefined();
    expect(session.onError).toBeDefined();
    session.stop();
  });

  it('selects Ark when STT preference is ark and Doubao key has colon', async () => {
    process.env.DOUBAO_SPEECH_KEY = '12345:token-abc';
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'ark', tts: 'auto' }),
    }));
    vi.doMock('../server/config/keys', () => ({
      getKey: () => undefined,
    }));

    const { createWakeDetector } = await import('../server/stt/wake_detector');
    const session = createWakeDetector();
    expect(session).toBeDefined();
    expect(session.sendAudio).toBeDefined();
    session.stop();
  });

  it('falls back to available provider when preference cannot be satisfied', async () => {
    // User prefers ark but only Qwen key exists
    process.env.DASHSCOPE_API_KEY = 'sk-test123';
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'ark', tts: 'auto' }),
    }));
    vi.doMock('../server/config/keys', () => ({
      getKey: () => undefined,
    }));

    const { createWakeDetector } = await import('../server/stt/wake_detector');
    // Should fall back to Qwen since no valid Doubao key
    const session = createWakeDetector();
    expect(session).toBeDefined();
    session.stop();
  });

  it('prewarms a replacement before the 600-second boundary and switches audio atomically', async () => {
    vi.useFakeTimers();
    process.env.DASHSCOPE_API_KEY = 'sk-test123';
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'qwen', tts: 'auto' }),
    }));
    vi.doMock('../server/config/keys', () => ({ getKey: () => undefined }));

    const { createWakeDetector, QWEN_WAKE_ROLLOVER_MS } = await import('../server/stt/wake_detector');
    const session = createWakeDetector();
    const errors: Error[] = [];
    const wakes: string[] = [];
    session.onError(error => errors.push(error));
    session.onWake(keyword => wakes.push(keyword));

    const first = MockWebSocket.instances[0];
    first.open();
    first.message({ type: 'session.created' });
    session.sendAudio(Buffer.from([1, 2, 3, 4]));
    expect(sentEvents(first, 'input_audio_buffer.append')).toHaveLength(1);

    vi.advanceTimersByTime(QWEN_WAKE_ROLLOVER_MS);
    expect(MockWebSocket.instances).toHaveLength(2);
    const replacement = MockWebSocket.instances[1];

    // The active stream continues receiving audio while its replacement warms.
    session.sendAudio(Buffer.from([5, 6, 7, 8]));
    expect(sentEvents(first, 'input_audio_buffer.append')).toHaveLength(2);
    expect(sentEvents(replacement, 'input_audio_buffer.append')).toHaveLength(0);

    replacement.open();
    replacement.message({ type: 'session.created' });
    expect(sentEvents(replacement, 'input_audio_buffer.append')).toHaveLength(2);
    expect(sentEvents(first, 'session.finish')).toHaveLength(1);

    const oldCountAtSwitch = sentEvents(first, 'input_audio_buffer.append').length;
    session.sendAudio(Buffer.from([9, 10, 11, 12]));
    expect(sentEvents(first, 'input_audio_buffer.append')).toHaveLength(oldCountAtSwitch);
    expect(sentEvents(replacement, 'input_audio_buffer.append')).toHaveLength(3);

    // Both sessions can finish the replayed boundary utterance. Emit only once,
    // even if the ASR variants resolve to different wake keywords.
    first.message({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Lumi',
    });
    replacement.message({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Jarvis',
    });
    expect(wakes).toHaveLength(1);

    first.error();
    first.remoteClose(1011, 'Response stream timeout (timeout_seconds=600)');
    expect(errors).toHaveLength(0);

    session.stop();
    expect(first.readyState).toBe(MockWebSocket.CLOSED);
    expect(replacement.readyState).toBe(MockWebSocket.CLOSED);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers an upstream 600-second expiry internally and replays gap audio', async () => {
    vi.useFakeTimers();
    process.env.DASHSCOPE_API_KEY = 'sk-test123';
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'qwen', tts: 'auto' }),
    }));
    vi.doMock('../server/config/keys', () => ({ getKey: () => undefined }));

    const { createWakeDetector } = await import('../server/stt/wake_detector');
    const session = createWakeDetector();
    const errors: Error[] = [];
    session.onError(error => errors.push(error));

    const first = MockWebSocket.instances[0];
    first.open();
    first.message({ type: 'session.created' });
    session.sendAudio(Buffer.from([1, 1]));
    first.remoteClose(1011, 'Response stream timeout (timeout_seconds=600, elapsed_ms=600005)');

    expect(errors).toHaveLength(0);
    expect(MockWebSocket.instances).toHaveLength(2);
    const replacement = MockWebSocket.instances[1];
    session.sendAudio(Buffer.from([2, 2]));
    expect(sentEvents(replacement, 'input_audio_buffer.append')).toHaveLength(0);

    replacement.open();
    replacement.message({ type: 'session.created' });
    expect(sentEvents(replacement, 'input_audio_buffer.append')).toHaveLength(2);
    session.sendAudio(Buffer.from([3, 3]));
    expect(sentEvents(replacement, 'input_audio_buffer.append')).toHaveLength(3);

    session.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers an unexpected remote normal close without a client error', async () => {
    vi.useFakeTimers();
    process.env.DASHSCOPE_API_KEY = 'sk-test123';
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'qwen', tts: 'auto' }),
    }));
    vi.doMock('../server/config/keys', () => ({ getKey: () => undefined }));

    const { createWakeDetector } = await import('../server/stt/wake_detector');
    const session = createWakeDetector();
    const errors: Error[] = [];
    session.onError(error => errors.push(error));

    const first = MockWebSocket.instances[0];
    first.open();
    first.message({ type: 'session.created' });
    first.remoteClose(1000, '');

    expect(errors).toHaveLength(0);
    expect(MockWebSocket.instances).toHaveLength(2);
    const replacement = MockWebSocket.instances[1];
    replacement.open();
    replacement.message({ type: 'session.created' });
    session.sendAudio(Buffer.from([7, 7]));
    expect(sentEvents(replacement, 'input_audio_buffer.append')).toHaveLength(1);

    session.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers an active WebSocket error even when no close frame follows', async () => {
    vi.useFakeTimers();
    process.env.DASHSCOPE_API_KEY = 'sk-test123';
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'qwen', tts: 'auto' }),
    }));
    vi.doMock('../server/config/keys', () => ({ getKey: () => undefined }));

    const {
      createWakeDetector,
      QWEN_WAKE_ERROR_CLOSE_GRACE_MS,
    } = await import('../server/stt/wake_detector');
    const session = createWakeDetector();
    const errors: Error[] = [];
    session.onError(error => errors.push(error));

    const first = MockWebSocket.instances[0];
    first.open();
    first.message({ type: 'session.created' });
    first.error();

    vi.advanceTimersByTime(QWEN_WAKE_ERROR_CLOSE_GRACE_MS - 1);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(errors).toHaveLength(0);
    expect(MockWebSocket.instances).toHaveLength(2);

    const replacement = MockWebSocket.instances[1];
    replacement.open();
    replacement.message({ type: 'session.created' });
    session.sendAudio(Buffer.from([8, 8]));
    expect(sentEvents(replacement, 'input_audio_buffer.append')).toHaveLength(1);

    session.stop();
    expect(first.readyState).toBe(MockWebSocket.CLOSED);
    expect(replacement.readyState).toBe(MockWebSocket.CLOSED);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isWakeWord matches Chinese and English variants', async () => {
    const { isWakeWord } = await import('../server/stt/wake_detector');

    expect(isWakeWord('jarvis')).toBe('Jarvis'); // lowercased input matches 'Jarvis' first in WAKE_WORDS
    expect(isWakeWord('Jarvis')).toBe('Jarvis');
    expect(isWakeWord('贾维斯')).toBe('贾维斯');
    // 'lumi' before more specific matches in WAKE_WORDS array
    expect(isWakeWord('lumi')).toBe('lumi');
    expect(isWakeWord('Lumi')).toBe('lumi');
    expect(isWakeWord('Hey Lumi')).toBe('lumi'); // substring match: 'lumi' found before 'Hey Lumi'
    expect(isWakeWord('豆包')).toBe('豆包');
    expect(isWakeWord('豆瓣')).toBe('豆瓣');
    expect(isWakeWord('嘿 豆包')).toBe('豆包'); // '豆包' substring match comes before '嘿 豆包'

    // Non-wake words
    expect(isWakeWord('hello world')).toBeNull();
    expect(isWakeWord('今天天气不错')).toBeNull();
    expect(isWakeWord('')).toBeNull();
  });
});
