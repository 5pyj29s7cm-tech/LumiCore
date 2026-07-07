import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tempRoot = '';
let previousDataDir: string | undefined;
const clearedEnvKeys = [
  'OPENAI_API_KEY',
  'DASHSCOPE_API_KEY',
  'QWEN_API_KEY',
  'DOUBAO_SPEECH_KEY',
  'LUMI_DISABLE_QWEN_FILE_STT',
] as const;
let previousKeys: Partial<Record<(typeof clearedEnvKeys)[number], string | undefined>> = {};

async function loadModule() {
  return import('../server/stt/file_transcription');
}

describe('audio file transcription helper', () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_audio_test_'));
    previousDataDir = process.env.LUMI_DATA_DIR;
    process.env.LUMI_DATA_DIR = tempRoot;
    previousKeys = {};
    for (const key of clearedEnvKeys) {
      previousKeys[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.LUMI_DATA_DIR;
    else process.env.LUMI_DATA_DIR = previousDataDir;
    for (const key of clearedEnvKeys) {
      const value = previousKeys[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  });

  it('detects common audio mime types', async () => {
    const mod = await loadModule();
    expect(mod.getAudioMimeType('meeting.mp3')).toBe('audio/mpeg');
    expect(mod.getAudioMimeType('voice.wav')).toBe('audio/wav');
    expect(mod.getAudioMimeType('memo.m4a')).toBe('audio/mp4');
    expect(mod.isSupportedAudioFileName('clip.flac')).toBe(true);
    expect(mod.isSupportedAudioFileName('notes.txt')).toBe(false);
  });

  it('reports a retryable provider configuration error without network calls', async () => {
    const mod = await loadModule();
    await expect(mod.transcribeAudioFile(Buffer.from('not-a-real-audio'), {
      fileName: 'meeting.mp3',
      preferredProvider: 'auto',
      allowLocal: false,
      providerAvailability: {
        qwen: false,
        whisper: false,
        ark: false,
        'local-whisper': false,
      },
    })).rejects.toMatchObject({ code: 'NO_AUDIO_TRANSCRIPTION_PROVIDER' });
  });

  it('prioritizes DashScope Fun-ASR for automatic audio transcription', async () => {
    const mod = await loadModule();
    expect(mod.getAudioFileProviderPlan({
      preferredProvider: 'auto',
      providerAvailability: {
        qwen: true,
        whisper: true,
        ark: true,
        'local-whisper': true,
      },
    })).toEqual(['qwen', 'local-whisper', 'whisper', 'ark']);
  });

  it('can disable DashScope file ASR by local policy', async () => {
    process.env.DASHSCOPE_API_KEY = 'dashscope-test-key';
    process.env.LUMI_DISABLE_QWEN_FILE_STT = '1';
    const mod = await loadModule();
    expect(mod.getAudioFileProviderPlan({
      preferredProvider: 'qwen',
      allowLocal: false,
    })).toEqual([]);
  });

  it('transcribes with DashScope Fun-ASR async file tasks', async () => {
    process.env.DASHSCOPE_API_KEY = 'dashscope-test-key';
    const mod = await loadModule();
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string> }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url: target, method: init?.method, headers });
      if (target.includes('/api/v1/uploads?action=getPolicy')) {
        expect(init?.method).toBe('GET');
        expect(headers?.Authorization).toBe('Bearer dashscope-test-key');
        return new Response(JSON.stringify({
          data: {
            policy: 'policy',
            signature: 'signature',
            upload_dir: 'tmp/lumi',
            upload_host: 'https://oss.example/upload',
            oss_access_key_id: 'oss-ak',
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target === 'https://oss.example/upload') {
        expect(init?.method).toBe('POST');
        return new Response('', { status: 200 });
      }
      if (target.includes('/api/v1/services/audio/asr/transcription')) {
        expect(init?.method).toBe('POST');
        expect(headers?.Authorization).toBe('Bearer dashscope-test-key');
        expect(headers?.['X-DashScope-Async']).toBe('enable');
        expect(headers?.['X-DashScope-OssResourceResolve']).toBe('enable');
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.model).toBe('fun-asr');
        expect(body.input.file_urls[0]).toMatch(/^oss:\/\/tmp\/lumi\//);
        expect(body.parameters.diarization_enabled).toBe(true);
        return new Response(JSON.stringify({ output: { task_id: 'task-1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/api/v1/tasks/task-1')) {
        expect(init?.method).toBe('GET');
        return new Response(JSON.stringify({
          output: {
            task_status: 'SUCCEEDED',
            results: [{
              subtask_status: 'SUCCEEDED',
              transcription_url: 'https://result.example/transcript.json',
            }],
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target === 'https://result.example/transcript.json') {
        expect(init?.method).toBe('GET');
        return new Response(JSON.stringify({
          transcripts: [{
            channel_id: 0,
            sentences: [
              { begin_time: 0, end_time: 1000, speaker_id: 0, text: 'hello' },
              { begin_time: 1500, end_time: 2800, speaker_id: 1, text: 'world' },
            ],
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    };

    const progress: string[] = [];
    const result = await mod.transcribeAudioFile(Buffer.from('fake-audio'), {
      fileName: 'meeting.mp3',
      preferredProvider: 'qwen',
      allowLocal: false,
      fetchImpl: fetchImpl as typeof fetch,
      onProgress: (message) => progress.push(message),
    });

    expect(result.text).toContain('\u8bf4\u8bdd\u4eba1\uff1ahello');
    expect(result.text).toContain('\u8bf4\u8bdd\u4eba2\uff1aworld');
    expect(result.provider).toBe('qwen');
    expect(result.model).toBe('fun-asr');
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.speakerCount).toBe(2);
    expect(result.segments).toHaveLength(2);
    expect(result.taskId).toBe('task-1');
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST', 'POST', 'GET', 'GET']);
    expect(progress.some(message => message.includes('DashScope'))).toBe(true);
  });

});
