import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { getGeneratedOutputDir } from '../server/config/data_path';
import { ToolRegistry } from '../server/tools/registry';
import { registerDocumentTools } from '../server/tools/definitions/document_tools';
import { getAudioFileProviderPlan, transcribeAudioFile } from '../server/stt/file_transcription';
import * as whisper from '../server/stt/providers/whisper';
import * as ark from '../server/stt/providers/ark';
import * as dashscope from '../server/stt/providers/dashscope-file';
import * as official from '../server/stt/providers/official';
import { resetCircuit } from '../server/cloud/circuit_breaker';

vi.mock('../server/config/keys', () => ({
  getKey: (key: string) => key === 'OPENAI_API_KEY' ? 'synthetic-round3-audio-key' : '',
  loadKeys: () => ({ OPENAI_API_KEY: 'synthetic-round3-audio-key' }),
}));
vi.mock('../server/stt/providers/local-whisper', () => ({ isLocalWhisperAvailable: () => false }));
vi.mock('../server/config/doubao_speech', () => ({ hasDoubaoSpeechCredentials: () => false }));
vi.mock('../server/relay/config', () => ({ relayConfigured: () => false }));
vi.mock('../server/config/voice_preference', () => ({ getVoicePreference: () => ({ stt: 'whisper' }) }));

beforeAll(async () => { await initDatabase(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetCircuit(); });
function fixture(name: string) {
  for (const key of ['OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY']) vi.stubEnv(key, '');
  const directory = getGeneratedOutputDir();
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${name}.wav`);
  fs.writeFileSync(filePath, 'synthetic audio only');
  const registry = new ToolRegistry();
  registerDocumentTools(registry);
  return { registry, filePath };
}

describe('audio transcription privacy and cancellation', () => {
  it('blocks the real file tool before sending audio in strict privacy', async () => {
    const { registry, filePath } = fixture('strict-audio');
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'synthetic transcript' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(registry.execute('transcribe_audio_to_text_file', { filePath, preferredProvider: 'whisper', allowLocal: false }, { userId: 'round3-audio', requestConfirmation: async () => true })).rejects.toThrow('Strict privacy');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not write a late transcript even if a transport ignores cancellation', async () => {
    const { registry, filePath } = fixture('cancel-audio');
    vi.stubEnv('LUMI_PRIVACY', 'standard');
    let complete!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { complete = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const before = fs.readdirSync(getGeneratedOutputDir());
    let settled = false;
    const pending = registry.execute('transcribe_audio_to_text_file', { filePath, preferredProvider: 'whisper', allowLocal: false }, { userId: 'round3-audio', requestConfirmation: async () => true, executionSignal: controller.signal, isCancelled: () => controller.signal.aborted }).finally(() => { settled = true; });
    pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      controller.abort(new Error('synthetic user cancellation'));
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      expect((fetchMock.mock.calls as any[])[0][1].signal.aborted).toBe(true);
      complete(new Response(JSON.stringify({ text: 'late synthetic transcript' }), { status: 200 }));
      await expect(pending).rejects.toThrow('synthetic user cancellation');
      expect(fs.readdirSync(getGeneratedOutputDir())).toEqual(before);
    } finally {
      complete?.(new Response(JSON.stringify({ text: 'cleanup transcript' }), { status: 200 }));
      await pending.catch(() => undefined);
    }
  });

  it('uses only local transcription in strict mode even with every cloud engine available', () => {
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    expect(getAudioFileProviderPlan({ preferredProvider: 'relay', providerAvailability: { relay: true, qwen: true, whisper: true, ark: true, 'local-whisper': true } })).toEqual(['local-whisper']);
  });

  it('blocks direct cloud adapters as well as the unified plan', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const provider of [whisper, ark, dashscope, official]) {
      await expect(provider.transcribe(Buffer.from('synthetic audio'), 'zh')).rejects.toThrow('Strict mode');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts the provider request promptly and does not fall back or write output', async () => {
    const { registry, filePath } = fixture('abort-audio');
    vi.stubEnv('LUMI_PRIVACY', 'standard');
    const controller = new AbortController();
    const before = fs.readdirSync(getGeneratedOutputDir());
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = registry.execute('transcribe_audio_to_text_file', { filePath, preferredProvider: 'whisper', allowLocal: false }, { userId: 'round3-audio', requestConfirmation: async () => true, executionSignal: controller.signal });
    const stopped = expect(pending).rejects.toThrow('stop audio now');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new Error('stop audio now'));
    await stopped;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fs.readdirSync(getGeneratedOutputDir())).toEqual(before);
  });

  it('does not start a provider for a previously cancelled operation', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'standard');
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const fetchMock = vi.fn();
    await expect(transcribeAudioFile(Buffer.from('synthetic'), { signal: controller.signal, fetchImpl: fetchMock })).rejects.toThrow('already cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds a stalled Whisper request with an application deadline', async () => {
    fixture('deadline-audio');
    vi.stubEnv('LUMI_PRIVACY', 'standard');
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const pending = whisper.transcribe(Buffer.from('synthetic'), 'zh', { fetchImpl: fetchMock });
    const stopped = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await stopped;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('cancels DashScope polling without another request or fallback', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'standard');
    vi.stubEnv('DASHSCOPE_API_KEY', 'synthetic-dashscope-key');
    const controller = new AbortController();
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      const url = String(input);
      let result: unknown;
      if (url.includes('getPolicy')) result = { data: { policy: 'synthetic', signature: 'synthetic', upload_dir: 'tmp/test', upload_host: 'https://upload.example.invalid', oss_access_key_id: 'synthetic' } };
      else if (url === 'https://upload.example.invalid') return new Response('');
      else if (url.includes('/asr/transcription')) result = { output: { task_id: 'synthetic-task' } };
      else result = { output: { task_status: 'RUNNING' } };
      return new Response(JSON.stringify(result));
    });
    const pending = transcribeAudioFile(Buffer.from('synthetic'), {
      preferredProvider: 'qwen', allowLocal: false, signal: controller.signal, fetchImpl: fetchMock,
      providerAvailability: { qwen: true, whisper: true, ark: false, relay: false, 'local-whisper': false },
      onProgress: message => { if (message.includes('RUNNING')) controller.abort(new Error('stop polling')); },
    });
    await expect(pending).rejects.toThrow('stop polling');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
