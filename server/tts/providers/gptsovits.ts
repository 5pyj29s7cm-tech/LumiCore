import { TTSResult, VoiceListItem } from '../types';
import { isStrictPrivacy, requireLocalEndpoint } from '../../config/privacy';
import fs from 'fs';
import path from 'path';
import { getDataPath } from '../../config/data_path';
import { withCloudResilience } from '../../cloud/resilience';
import {
  ensureGptSovitsRuntime,
  isGptSovitsRuntimeInstalled,
  isGptSovitsRuntimeReady,
  markGptSovitsActivity,
} from '../gptsovits_runtime';

const DEFAULT_BASE_URL = 'http://127.0.0.1:9880';

const SEGMENTS_DIR = getDataPath('voice_training/segments');
const TRAINING_FILE_LIST = getDataPath('voice_training/filelist.txt');
const MAX_CONCURRENT_SYNTHESIS = Math.max(1, Number(process.env.GPTSOVITS_CONCURRENCY) || 1);
let activeSynthesis = 0;
const synthesisQueue: Array<() => void> = [];

async function withSynthesisSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const index = synthesisQueue.indexOf(enter);
      if (index >= 0) synthesisQueue.splice(index, 1);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new DOMException('GPT-SoVITS request cancelled.', 'AbortError'));
    };
    const enter = () => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) { onAbort(); return; }
      // Reserve the slot before waking the waiter so another arrival cannot
      // take it between promise resolution and the waiting continuation.
      activeSynthesis += 1;
      resolve();
    };
    if (activeSynthesis >= MAX_CONCURRENT_SYNTHESIS || synthesisQueue.length) {
      synthesisQueue.push(enter);
      signal?.addEventListener('abort', onAbort, { once: true });
    } else enter();
  });
  try {
    signal?.throwIfAborted();
    return await work();
  } finally {
    activeSynthesis = Math.max(0, activeSynthesis - 1);
    while (activeSynthesis < MAX_CONCURRENT_SYNTHESIS && synthesisQueue.length) synthesisQueue.shift()!();
  }
}

function getBaseUrl(): string {
  return (process.env.GPTSOVITS_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function isConfigured(): boolean {
  try { requireLocalEndpoint(`${getBaseUrl()}/tts`, 'GPT-SoVITS'); } catch { return false; }
  if (process.env.GPTSOVITS_API_URL || process.env.GPTSOVITS_ENABLED === 'true') return true;

  return isGptSovitsRuntimeInstalled();
}

export function isReadyForAutomaticFallback(): boolean {
  return isGptSovitsRuntimeReady();
}

export function parseVoiceTrainingFileList(content: string): Record<string, string> {
  const transcripts: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 4) continue;
    const filename = path.basename(parts[0].trim());
    const transcript = parts.slice(3).join('|').trim();
    if (filename && transcript) transcripts[filename] = transcript;
  }
  return transcripts;
}

function loadReferenceTranscripts(): Record<string, string> {
  try {
    if (!fs.existsSync(TRAINING_FILE_LIST)) return {};
    return parseVoiceTrainingFileList(fs.readFileSync(TRAINING_FILE_LIST, 'utf8'));
  } catch {
    return {};
  }
}

function listReferenceFiles(): { path: string; name: string; promptText: string }[] {
  try {
    if (!fs.existsSync(SEGMENTS_DIR)) return [];
    const transcripts = loadReferenceTranscripts();
    return fs.readdirSync(SEGMENTS_DIR)
      .filter(f => f.endsWith('.wav'))
      .map(f => ({
        path: path.join(SEGMENTS_DIR, f),
        name: f.replace(/\.wav$/, '').replace(/_/g, ' '),
        promptText: transcripts[f] || '',
      }));
  } catch {
    return [];
  }
}

export function listVoices(): VoiceListItem[] {
  const refs = listReferenceFiles();
  if (refs.length === 0) {
    return [{ voiceId: 'lumi', name: 'Lumi Voice', category: 'cloned', language: 'zh' }];
  }
  return refs.map(r => ({
    voiceId: `gptsovits:${r.name.replace(/\s+/g, '_')}`,
    name: r.name,
    category: 'cloned' as const,
    language: 'zh',
  }));
}

async function synthesizeSpeechInternal(
  text: string,
  voiceId?: string,
  signal?: AbortSignal,
): Promise<TTSResult> {
  // Strict mode only contacts an existing local service. A direct provider
  // call must not start a cold model after automatic selection refused it.
  requireLocalEndpoint(`${getBaseUrl()}/tts`, 'GPT-SoVITS speech synthesis');
  if (!isStrictPrivacy()) await ensureGptSovitsRuntime(signal);
  markGptSovitsActivity();
  // Resolve reference audio based on voiceId
  let refAudioPath: string;
  let promptText: string;

  const refs = listReferenceFiles();
  if (voiceId && voiceId.startsWith('gptsovits:')) {
    const voiceName = voiceId.replace('gptsovits:', '').replace(/_/g, ' ');
    const match = refs.find(r => r.name === voiceName);
    if (match) {
      refAudioPath = match.path;
      promptText = match.promptText;
    } else {
      // Fallback to first available or default
      refAudioPath = refs.length > 0 ? refs[0].path : getDataPath('voice_training/segments/segment_0000.wav');
      promptText = refs.length > 0 ? refs[0].promptText : '各位朋友大家好，今天想和大家分享的';
    }
  } else if (refs.length > 0) {
    refAudioPath = refs[0].path;
    promptText = refs[0].promptText;
  } else {
    refAudioPath = getDataPath('voice_training/segments/segment_0000.wav');
    promptText = '各位朋友大家好，今天想和大家分享的';
  }

  const body: Record<string, unknown> = {
    text,
    text_lang: 'zh',
    ref_audio_path: refAudioPath,
    prompt_text: promptText,
    prompt_lang: 'zh',
    text_split_method: 'cut0',
    batch_size: 1,
    media_type: 'wav',
    streaming_mode: false,
  };

  const audioBuffer = await withCloudResilience(
    async operationSignal => {
      const endpoint = `${getBaseUrl()}/tts`;
      requireLocalEndpoint(endpoint, 'GPT-SoVITS speech synthesis');
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: operationSignal,
        ...(isStrictPrivacy() ? { redirect: 'error' as const } : {}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(`GPT-SoVITS TTS error (${res.status}): ${err.message || err.detail}`);
      }
      return Buffer.from(await res.arrayBuffer());
    },
    { provider: 'gptsovits', maxRetries: 2, baseDelayMs: 500, signal },
  );
  markGptSovitsActivity();
  return {
    audioBuffer,
    format: 'audio/wav',
  };
}

export function synthesizeSpeech(
  text: string,
  voiceId?: string,
  signal?: AbortSignal,
): Promise<TTSResult> {
  return withSynthesisSlot(() => synthesizeSpeechInternal(text, voiceId, signal), signal);
}

export function getRuntimeQueueStatus() {
  return {
    inFlight: activeSynthesis,
    queueLength: synthesisQueue.length,
    concurrency: MAX_CONCURRENT_SYNTHESIS,
  };
}
