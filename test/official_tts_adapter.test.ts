import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isRelayVoiceCompatibilityError,
  listVoices,
  shouldSendRelayTtsVoice,
  synthesizeSpeech,
} from '../server/tts/providers/relay';

const originalKey = process.env.RELAY_API_KEY;
const originalBaseUrl = process.env.RELAY_BASE_URL;
const originalModel = process.env.RELAY_TTS_MODEL;
const originalVoice = process.env.RELAY_TTS_VOICE;

describe('Lumi official TTS adapter', () => {
  beforeEach(() => {
    process.env.RELAY_API_KEY = 'test-official-key';
    process.env.RELAY_BASE_URL = 'https://relay.example.test/v1';
    delete process.env.RELAY_TTS_MODEL;
    delete process.env.RELAY_TTS_VOICE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.RELAY_API_KEY;
    else process.env.RELAY_API_KEY = originalKey;
    if (originalBaseUrl === undefined) delete process.env.RELAY_BASE_URL;
    else process.env.RELAY_BASE_URL = originalBaseUrl;
    if (originalModel === undefined) delete process.env.RELAY_TTS_MODEL;
    else process.env.RELAY_TTS_MODEL = originalModel;
    if (originalVoice === undefined) delete process.env.RELAY_TTS_VOICE;
    else process.env.RELAY_TTS_VOICE = originalVoice;
  });

  it('uses a live catalog model and a compatible CosyVoice voice by default', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    });

    const result = await synthesizeSpeech('你好', 'default');
    expect(result.audioBuffer.length).toBe(4);
    expect(result.format).toBe('audio/mp3');
    expect(calls[0].url).toBe('https://relay.example.test/v1/audio/speech');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer test-official-key');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      model: 'aliyun/cosyvoice-v3-flash',
      input: '你好',
      voice: 'longxiaochun_v3',
      response_format: 'mp3',
    });
    expect((await listVoices()).some(voice => voice.voiceId === 'longxiaochun_v3')).toBe(true);
  });

  it('honors an explicit role model over a legacy deployment env override', async () => {
    process.env.RELAY_TTS_MODEL = 'aliyun/legacy-tts-model';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    });

    await synthesizeSpeech('test', 'longxiaochun_v3', undefined, undefined, undefined, undefined, 'aliyun/cosyvoice-v3-flash');
    expect(JSON.parse(String(calls[0].init?.body)).model).toBe('aliyun/cosyvoice-v3-flash');
  });

  it.each([
    'aliyun/cosyvoice-v3-plus',
    'aliyun/qwen-audio-3.0-tts-plus',
  ])('omits voice for the voice-less relay TTS model %s', async (model) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    });

    await synthesizeSpeech('test', 'longxiaochun_v3', undefined, undefined, undefined, undefined, model);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.model).toBe(model);
    expect(body).not.toHaveProperty('voice');
  });

  it('keeps voice enabled for CosyVoice v3 Flash and matches provider-qualified ids', () => {
    expect(shouldSendRelayTtsVoice('aliyun/cosyvoice-v3-flash')).toBe(true);
    expect(shouldSendRelayTtsVoice('COSYVOICE-V3-FLASH')).toBe(true);
    expect(shouldSendRelayTtsVoice('aliyun/cosyvoice-v3-plus')).toBe(false);
    expect(shouldSendRelayTtsVoice('qwen-audio-3.0-tts-plus')).toBe(false);
  });

  it('recovers a stale OpenAI voice id before the circuit breaker sees a failure', async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      calls.push({ init });
      const body = JSON.parse(String(init?.body));
      if (body.voice === 'alloy') {
        return new Response(JSON.stringify({ detail: '[cosyvoice:]Engine return error code: 418' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    });

    const result = await synthesizeSpeech('test', 'alloy', undefined, 1.1);
    expect(result.audioBuffer.length).toBe(4);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ voice: 'alloy', speed: 1.1 });
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({ voice: 'longxiaochun_v3' });
    expect(JSON.parse(String(calls[1].init?.body))).not.toHaveProperty('speed');
  });

  it('classifies only voice compatibility failures as recoverable voice errors', () => {
    expect(isRelayVoiceCompatibilityError(new Error('Engine return error code: 418'))).toBe(true);
    expect(isRelayVoiceCompatibilityError(new Error('model does not exist'))).toBe(false);
    expect(isRelayVoiceCompatibilityError(new Error('Requests rate limit exceeded'))).toBe(false);
  });
});
