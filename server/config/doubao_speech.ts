import { getKey } from './keys';

export type DoubaoSpeechCredentialMode = 'api-key';

export type DoubaoSpeechCredentials = { mode: 'api-key'; apiKey: string };

const DEFAULT_STREAMING_ASR_RESOURCE_ID = 'volc.bigasr.sauc.duration';
const DEFAULT_FILE_ASR_RESOURCE_ID = 'volc.bigasr.auc_turbo';
const DEFAULT_TTS_V1_RESOURCE_ID = 'seed-tts-1.0';
const DEFAULT_TTS_V2_RESOURCE_ID = 'seed-tts-2.0';
const DEFAULT_VOICE_CLONE_V2_RESOURCE_ID = 'seed-icl-2.0';
const DEFAULT_V2_VOICE_ID = 'zh_female_vv_uranus_bigtts';

const CURRENT_VOICE_ALIASES: Record<string, string> = {
  ICL_zh_female_keainvsheng_tob: 'saturn_zh_female_keainvsheng_tob',
  ICL_zh_female_tiaopigongzhu_tob: 'saturn_zh_female_tiaopigongzhu_tob',
};

function configuredValue(): string {
  const environmentValue = String(process.env.DOUBAO_SPEECH_KEY || '').trim();
  if (environmentValue.includes(':')) delete process.env.DOUBAO_SPEECH_KEY;
  return String(process.env.DOUBAO_SPEECH_KEY || getKey('DOUBAO_SPEECH_KEY') || '').trim();
}

export function parseDoubaoSpeechCredentials(rawValue: unknown): DoubaoSpeechCredentials | null {
  const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!raw || raw.includes(':')) return null;
  return { mode: 'api-key', apiKey: raw };
}

export function getDoubaoSpeechCredentials(): DoubaoSpeechCredentials | null {
  return parseDoubaoSpeechCredentials(configuredValue());
}

export function requireDoubaoSpeechCredentials(): DoubaoSpeechCredentials {
  const credentials = getDoubaoSpeechCredentials();
  if (!credentials) {
    throw new Error('Doubao Speech is not configured. Enter a new-console API Key value in Settings -> Voice Services.');
  }
  return credentials;
}

export function hasDoubaoSpeechCredentials(): boolean {
  return getDoubaoSpeechCredentials() !== null;
}

export function getDoubaoSpeechCredentialMode(): DoubaoSpeechCredentialMode | null {
  return getDoubaoSpeechCredentials()?.mode || null;
}

export function buildDoubaoApiHeaders(credentials: DoubaoSpeechCredentials): Record<string, string> {
  return { 'X-Api-Key': credentials.apiKey };
}

export function getDoubaoStreamingAsrResourceId(): string {
  return String(process.env.DOUBAO_ASR_RESOURCE_ID || DEFAULT_STREAMING_ASR_RESOURCE_ID).trim();
}

export function getDoubaoFileAsrResourceId(): string {
  return String(process.env.DOUBAO_FILE_ASR_RESOURCE_ID || DEFAULT_FILE_ASR_RESOURCE_ID).trim();
}

export function normalizeDoubaoVoiceId(voiceId: string | undefined): string {
  const candidate = String(voiceId || '').trim();
  const aliased = CURRENT_VOICE_ALIASES[candidate] || candidate;
  return /^(?:[A-Za-z0-9_-]+_bigtts|S_[A-Za-z0-9_-]+|ICL_[A-Za-z0-9_-]+|saturn_[A-Za-z0-9_-]+|lumi_voice_[A-Za-z0-9_-]+)$/i.test(aliased)
    ? aliased
    : String(process.env.DOUBAO_TTS_VOICE_ID || DEFAULT_V2_VOICE_ID).trim();
}

export function getDoubaoTtsResourceId(voiceId: string): string {
  const configured = String(process.env.DOUBAO_TTS_RESOURCE_ID || '').trim();
  if (configured) return configured;
  const normalized = normalizeDoubaoVoiceId(voiceId);
  if (/^(?:S_|lumi_voice_)/i.test(normalized)) {
    return String(process.env.DOUBAO_VOICE_CLONE_RESOURCE_ID || DEFAULT_VOICE_CLONE_V2_RESOURCE_ID).trim();
  }
  if (/^ICL_|_(?:mars|moon)_bigtts$/i.test(normalized)) return DEFAULT_TTS_V1_RESOURCE_ID;
  return DEFAULT_TTS_V2_RESOURCE_ID;
}

export function ratioToDoubaoRate(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const ratio = Math.max(0.5, Math.min(2, Number(value)));
  return Math.round((ratio - 1) * 100);
}
