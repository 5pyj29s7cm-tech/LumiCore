import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clearedEnvKeys = ['DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'OPENAI_API_KEY'] as const;
let previousEnv: Partial<Record<(typeof clearedEnvKeys)[number], string | undefined>> = {};

async function loadAdapter(stt: 'auto' | 'local-whisper' | 'qwen' | 'ark' | 'whisper' = 'auto') {
  vi.resetModules();
  vi.doMock('../server/config/voice_preference', () => ({
    getVoicePreference: () => ({ stt, tts: 'auto' }),
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

  it('keeps local Whisper out of realtime even when explicitly preferred', async () => {
    process.env.DASHSCOPE_API_KEY = 'dashscope-test-key';
    const adapter = await loadAdapter('local-whisper');
    expect(adapter.getActiveStreamingSTTProvider()).toBeNull();
  });
});
