import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clearedEnvKeys = ['DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'OPENAI_API_KEY', 'DOUBAO_SPEECH_KEY', 'RELAY_API_KEY', 'RELAY_BASE_URL'] as const;
let previousEnv: Partial<Record<(typeof clearedEnvKeys)[number], string | undefined>> = {};

async function loadAdapter(
  stt: 'auto' | 'local-whisper' | 'qwen' | 'ark' | 'whisper' | 'relay' = 'auto',
  sttModel?: string,
) {
  vi.resetModules();
  vi.doMock('../server/config/voice_preference', () => ({
    getVoicePreference: () => ({ stt, tts: 'auto', sttModel }),
  }));
  vi.doMock('../server/config/keys', () => ({
    getKey: () => undefined,
  }));
  vi.doMock('../server/cloud/circuit_breaker', () => ({
    isCircuitClosed: () => true,
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  }));
  vi.doMock('../server/stt/providers/local-whisper', () => ({
    isLocalWhisperAvailable: () => false,
    transcribe: vi.fn(),
  }));
  vi.doMock('../server/stt/providers/qwen', () => ({
    createStream: vi.fn(),
  }));
  vi.doMock('../server/stt/providers/whisper', () => ({
    transcribe: vi.fn(),
  }));
  vi.doMock('../server/stt/providers/ark', () => ({
    transcribe: vi.fn(),
  }));
  vi.doMock('../server/stt/providers/official', () => ({
    createStream: vi.fn(() => ({
      sendAudio: vi.fn(),
      end: vi.fn(),
      onResult: vi.fn(),
      onError: vi.fn(),
    })),
    transcribe: vi.fn(),
  }));
  return import('../server/stt/adapter');
}

describe('STT adapter provider selection', () => {
  beforeEach(() => {
    previousEnv = {};
    for (const key of clearedEnvKeys) {
      previousEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of clearedEnvKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('does not select a file-only STT provider for realtime streaming', async () => {
    const adapter = await loadAdapter('auto');
    expect(adapter.getActiveStreamingSTTProvider()).toBeNull();
  });

  it('selects Qwen realtime STT when a DashScope key is configured', async () => {
    process.env.DASHSCOPE_API_KEY = 'dashscope-test-key';
    const adapter = await loadAdapter('auto');
    expect(adapter.getActiveStreamingSTTProvider()).toBe('qwen');
  });

  it('selects Doubao realtime STT with a new-console single API key', async () => {
    process.env.DOUBAO_SPEECH_KEY = 'uuid-api-key-value';
    const adapter = await loadAdapter('auto');
    expect(adapter.getActiveStreamingSTTProvider()).toBe('ark');
    expect(adapter.getActiveSTTProvider()).toBe('ark');
  });

  it('keeps local Whisper out of realtime even when explicitly preferred', async () => {
    process.env.DASHSCOPE_API_KEY = 'dashscope-test-key';
    const adapter = await loadAdapter('local-whisper');
    expect(adapter.getActiveStreamingSTTProvider()).toBeNull();
  });

  it('does not fall through to another provider when the selected official route is unconfigured', async () => {
    process.env.DASHSCOPE_API_KEY = 'dashscope-test-key';
    const adapter = await loadAdapter('relay');
    expect(adapter.getActiveStreamingSTTProvider()).toBeNull();
  });

  it('advertises the configured official WebSocket STT adapter as realtime', async () => {
    process.env.RELAY_API_KEY = 'relay-test-key';
    process.env.RELAY_BASE_URL = 'https://relay.example.test/v1';
    const adapter = await loadAdapter('relay');
    expect(adapter.getActiveStreamingSTTProvider()).toBe('relay');
    expect(adapter.getActiveSTTProvider()).toBe('relay');
  });

  it('snapshots the persisted official STT model when opening a stream', async () => {
    process.env.RELAY_API_KEY = 'relay-test-key';
    process.env.RELAY_BASE_URL = 'https://relay.example.test/v1';
    const adapter = await loadAdapter('relay', 'aliyun/qwen-audio-3.0-asr-flash-streaming');
    const official = await import('../server/stt/providers/official');
    adapter.createStreamingSession({ provider: 'relay', language: 'zh-CN', interimResults: true });
    expect(official.createStream).toHaveBeenCalledWith(
      'zh-CN',
      true,
      { model: 'aliyun/qwen-audio-3.0-asr-flash-streaming' },
    );
  });
});
