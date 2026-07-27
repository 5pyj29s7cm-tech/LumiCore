import { TTSResult, VoiceListItem } from '../types';
import fs from 'fs';
import path from 'path';
import { getDataPath } from '../../config/data_path';
import { withCloudResilience } from '../../cloud/resilience';
import { ensureGptSovitsRuntime, markGptSovitsActivity } from '../gptsovits_runtime';

const DEFAULT_BASE_URL = 'http://127.0.0.1:9880';

const SEGMENTS_DIR = getDataPath('voice_training/segments');
const TRAINING_FILE_LIST = getDataPath('voice_training/filelist.txt');
const MAX_CONCURRENT_SYNTHESIS = Math.max(1, Number(process.env.GPTSOVITS_CONCURRENCY) || 1);
let activeSynthesis = 0;
const synthesisQueue: Array<() => void> = [];

async function withSynthesisSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (activeSynthesis >= MAX_CONCURRENT_SYNTHESIS) {
    await new Promise<void>((resolve, reject) => {
      const enter = () => signal?.aborted ? reject(new Error('GPT-SoVITS request was cancelled while queued.')) : resolve();
      synthesisQueue.push(enter);
    });
  }
  if (signal?.aborted) throw new Error('GPT-SoVITS request was cancelled.');
  activeSynthesis += 1;
  try {
    return await work();
  } finally {
    activeSynthesis = Math.max(0, activeSynthesis - 1);
    synthesisQueue.shift()?.();
  }
}

function getBaseUrl(): string {
  return (process.env.GPTSOVITS_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function isConfigured(): boolean {
  if (process.env.GPTSOVITS_API_URL || process.env.GPTSOVITS_ENABLED === 'true') return true;

  const localDir = path.join(process.cwd(), 'gpt-sovits-src');
  return fs.existsSync(path.join(localDir, 'venv', 'Scripts', 'python.exe'))
    && fs.existsSync(path.join(localDir, 'api_v2.py'));
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
  await ensureGptSovitsRuntime(signal);
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
    async () => {
      const res = await fetch(`${getBaseUrl()}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(`GPT-SoVITS TTS error (${res.status}): ${err.message || err.detail}`);
      }
      return Buffer.from(await res.arrayBuffer());
    },
    { provider: 'gptsovits', maxRetries: 2, baseDelayMs: 500 },
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
