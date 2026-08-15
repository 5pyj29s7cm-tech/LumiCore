import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
  'DOUBAO_VOICE_CLONE_URL',
  'DOUBAO_VOICE_CLONE_STATUS_URL',
  'DOUBAO_VOICE_CLONE_RESOURCE_ID',
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
    expect(normalizeDoubaoVoiceId('BV001_streaming')).toBe('zh_female_vv_uranus_bigtts');
    expect(normalizeDoubaoVoiceId('zh_male_dayi_uranus_bigtts')).toBe('zh_male_dayi_uranus_bigtts');
    expect(ratioToDoubaoRate(0.5)).toBe(-50);
    expect(ratioToDoubaoRate(1)).toBe(0);
    expect(ratioToDoubaoRate(2)).toBe(100);
  });

  it('lists only current TTS 2.0 voices', async () => {
    const voices = await doubaoTts.listVoices();
    expect(voices).toHaveLength(12);
    expect(voices.every(voice => voice.model === 'seed-tts-2.0')).toBe(true);
    expect(voices.some(voice => voice.voiceId.startsWith('BV'))).toBe(false);
    expect(voices.map(voice => voice.voiceId)).toEqual(expect.arrayContaining([
      'zh_female_vv_uranus_bigtts',
      'zh_male_dayi_saturn_bigtts',
      'zh_female_tianmeitaozi_mars_bigtts',
    ]));
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

  it('uses the ICL 2.0 resource for cloned Doubao voices', async () => {
    process.env.DOUBAO_SPEECH_KEY = 'uuid-api-key-value';
    let headers: Record<string, string> = {};
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ code: 0, data: Buffer.from('clone-audio').toString('base64') }), {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    };

    await doubaoTts.synthesizeSpeech('hello', 'lumi_voice_12345678', undefined, 1, 1, 1, fetchImpl as typeof fetch);
    expect(headers['X-Api-Resource-Id']).toBe('seed-icl-2.0');
  });

  it('trains and queries a Doubao 2.0 clone with the same single API key', async () => {
    process.env.DOUBAO_SPEECH_KEY = 'uuid-api-key-value';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-doubao-clone-'));
    const samplePath = path.join(tempDir, 'sample.wav');
    fs.writeFileSync(samplePath, Buffer.from('RIFF-test-wave-data'));
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      calls.push({ url: String(url), body, headers: init?.headers as Record<string, string> });
      if (String(url).includes('/voice_clone')) {
        return new Response(JSON.stringify({
          code: 0,
          speaker_id: 'lumi_voice_test1234',
          status: 1,
          available_training_times: 15,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        code: 0,
        speaker_id: 'lumi_voice_test1234',
        status: 2,
        available_training_times: 14,
        speaker_status: [{ model_type: 5, demo_audio: 'https://example.com/demo.wav' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const result = await doubaoTts.cloneVoice({
        sampleUrls: [samplePath],
        name: 'Test voice',
        customSpeakerId: 'lumi_voice_test1234',
        language: 0,
        demoText: '你好，这是试听。',
      }, fetchImpl as typeof fetch, { intervalMs: 0, timeoutMs: 100 });

      expect(result).toMatchObject({
        voiceId: 'lumi_voice_test1234',
        status: 'ready',
        model: 'seed-icl-2.0',
        demoAudio: 'https://example.com/demo.wav',
        billingMode: 'postpaid',
      });
      expect(calls).toHaveLength(2);
      expect(calls[0].url).toContain('/api/v3/tts/voice_clone');
      expect(calls[0].headers['X-Api-Key']).toBe('uuid-api-key-value');
      expect(calls[0].headers.Authorization).toBeUndefined();
      expect(calls[0].body).toMatchObject({
        speaker_id: 'custom_speaker_id',
        custom_speaker_id: 'lumi_voice_test1234',
        language: 0,
        extra_params: { demo_text: '你好，这是试听。' },
      });
      expect(calls[0].body.audio.format).toBe('wav');
      expect(calls[1].url).toContain('/api/v3/tts/get_voice');
      expect(calls[1].body).toEqual({
        speaker_id: 'custom_speaker_id',
        custom_speaker_id: 'lumi_voice_test1234',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
