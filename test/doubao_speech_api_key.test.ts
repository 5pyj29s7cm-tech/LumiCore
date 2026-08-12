import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import {
  buildDoubaoApiHeaders,
  getDoubaoSpeechCredentials,
  normalizeDoubaoVoiceId,
  parseDoubaoSpeechCredentials,
  ratioToDoubaoRate,
} from '../server/config/doubao_speech';
import { loadKeys, saveKeys } from '../server/config/keys';
import * as doubaoTts from '../server/tts/providers/ark';
import * as doubaoAsr from '../server/stt/providers/ark';

const ENV_KEYS = [
  'DOUBAO_SPEECH_KEY',
  'DOUBAO_TTS_RESOURCE_ID',
  'DOUBAO_TTS_VOICE_ID',
  'DOUBAO_TTS_V3_URL',
  'DOUBAO_FILE_ASR_RESOURCE_ID',
  'DOUBAO_FILE_ASR_URL',
] as const;

let previous: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  resetCircuit();
  previous = {};
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  resetCircuit();
  for (const key of ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('Doubao Speech API Key validation', () => {
  it('accepts a new-console API key and rejects legacy AppID:AccessToken credentials', () => {
    const modern = parseDoubaoSpeechCredentials('uuid-api-key-value');

    expect(modern).toEqual({ mode: 'api-key', apiKey: 'uuid-api-key-value' });
    expect(buildDoubaoApiHeaders(modern!)).toEqual({ 'X-Api-Key': 'uuid-api-key-value' });
    expect(parseDoubaoSpeechCredentials('123456789:legacy-token')).toBeNull();
    expect(parseDoubaoSpeechCredentials('appid:')).toBeNull();
  });

  it('purges a retired Doubao credential from the persisted store and process environment', () => {
    saveKeys({ DOUBAO_SPEECH_KEY: '123456789:legacy-token' });

    expect(loadKeys().DOUBAO_SPEECH_KEY).toBeUndefined();
    expect(getDoubaoSpeechCredentials()).toBeNull();
    expect(process.env.DOUBAO_SPEECH_KEY).toBeUndefined();
  });

  it('maps non-Doubao voice selections to a current API default', () => {
    expect(normalizeDoubaoVoiceId('longxiaochun_v3')).toBe('zh_female_vv_uranus_bigtts');
    expect(normalizeDoubaoVoiceId('zh_male_dayi_uranus_bigtts')).toBe('zh_male_dayi_uranus_bigtts');
    expect(ratioToDoubaoRate(0.5)).toBe(-50);
    expect(ratioToDoubaoRate(1)).toBe(0);
    expect(ratioToDoubaoRate(2)).toBe(100);
  });
});

describe('Doubao Speech new-console API calls', () => {
  it('synthesizes through TTS V3 with one X-Api-Key and parses chunked JSON audio', async () => {
    process.env.DOUBAO_SPEECH_KEY = 'uuid-api-key-value';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response([
        JSON.stringify({ code: 0, data: Buffer.from('first-').toString('base64') }),
        JSON.stringify({ code: 0, data: Buffer.from('second').toString('base64') }),
        JSON.stringify({ code: 20000000, message: 'OK' }),
      ].join('\n'), {
        status: 200,
        headers: { 'Content-Type': 'text/plain', 'X-Tt-Logid': 'test-log-id' },
      });
    };

    const result = await doubaoTts.synthesizeSpeech(
      'hello',
      'longxiaochun_v3',
      undefined,
      1.25,
      1,
      1,
      fetchImpl as typeof fetch,
    );

    expect(result.audioBuffer.toString()).toBe('first-second');
    expect(result.format).toBe('audio/mp3');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/v3/tts/unidirectional');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('uuid-api-key-value');
    expect(headers['X-Api-Resource-Id']).toBe('seed-tts-2.0');
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.req_params.speaker).toBe('zh_female_vv_uranus_bigtts');
    expect(body.req_params.audio_params).toMatchObject({ speech_rate: 25, pitch_rate: 0, loudness_rate: 0 });
  });

  it('transcribes a file through the current JSON API with one X-Api-Key', async () => {
    process.env.DOUBAO_SPEECH_KEY = 'uuid-api-key-value';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ result: { text: 'recognized text' } }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Status-Code': '20000000',
          'X-Tt-Logid': 'test-asr-log-id',
        },
      });
    };

    const result = await doubaoAsr.transcribe(Buffer.from('wave-data'), 'zh', {
      fileName: 'sample.wav',
      mimeType: 'audio/wav',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result.text).toBe('recognized text');
    expect(result.isFinal).toBe(true);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('uuid-api-key-value');
    expect(headers['X-Api-Resource-Id']).toBe('volc.bigasr.auc_turbo');
    expect(headers['X-Api-Sequence']).toBe('-1');
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.audio).toEqual({ data: Buffer.from('wave-data').toString('base64'), format: 'wav' });
    expect(body.request.model_name).toBe('bigmodel');
  });
});
