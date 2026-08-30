// Voice provider preference — shared by STT + TTS adapters.
// Persisted per-instance in db.settings. No user-id granularity needed
// since this is a system-level config.
import { readDB, writeDB } from '../../db_layer';
import {
  LUMI_OFFICIAL_DEFAULT_MODELS,
  LUMI_OFFICIAL_PROVIDER_ID,
} from '../../shared/model_provider_capabilities';
import { relayPath } from '../relay/config';

export interface VoicePreference {
  stt: 'auto' | 'local-whisper' | 'qwen' | 'ark' | 'whisper' | 'relay';
  tts: 'auto' | 'local-cosyvoice' | 'gptsovits' | 'cosyvoice' | 'ark' | 'relay';
  /** Provider-qualified official model selected for realtime STT, when set. */
  sttModel?: string;
  /** Provider-qualified official model selected for TTS, when set. */
  ttsModel?: string;
}

const DEFAULT: VoicePreference = { stt: 'auto', tts: 'auto' };
const ALLOWED_STT = new Set<VoicePreference['stt']>(['auto', 'local-whisper', 'qwen', 'ark', 'whisper', 'relay']);
const ALLOWED_TTS = new Set<VoicePreference['tts']>(['auto', 'local-cosyvoice', 'gptsovits', 'cosyvoice', 'ark', 'relay']);
const OFFICIAL_MODEL_ID = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/;

/** Keep model ids safe for both HTTP paths and WebSocket query parameters. */
export function normalizeVoiceModelId(value: unknown): string | undefined {
  const candidate = typeof value === 'string' ? value.trim().slice(0, 200) : '';
  return candidate && OFFICIAL_MODEL_ID.test(candidate) ? candidate : undefined;
}

/** Resolve the persisted model, with the documented official default as a
 * stable fallback when an older database has no role-specific model yet. */
export function getConfiguredVoiceModel(
  lane: 'stt' | 'tts',
  preference: VoicePreference = getVoicePreference(),
): string | undefined {
  const provider = lane === 'stt' ? preference.stt : preference.tts;
  if (provider !== LUMI_OFFICIAL_PROVIDER_ID) return undefined;
  const selected = normalizeVoiceModelId(lane === 'stt' ? preference.sttModel : preference.ttsModel);
  const deployment = relayPath(lane === 'stt' ? 'RELAY_STT_MODEL' : 'RELAY_TTS_MODEL');
  return selected || normalizeVoiceModelId(deployment) || (lane === 'stt'
    ? LUMI_OFFICIAL_DEFAULT_MODELS.speech_recognition
    : LUMI_OFFICIAL_DEFAULT_MODELS.speech_synthesis);
}

function normalizePreference(pref: Partial<VoicePreference>): VoicePreference {
  const stt = ALLOWED_STT.has(pref.stt as VoicePreference['stt']) ? pref.stt : DEFAULT.stt;
  const tts = ALLOWED_TTS.has(pref.tts as VoicePreference['tts']) ? pref.tts : DEFAULT.tts;
  const sttModel = normalizeVoiceModelId(pref.sttModel);
  const ttsModel = normalizeVoiceModelId(pref.ttsModel);
  return {
    stt: stt as VoicePreference['stt'],
    tts: tts as VoicePreference['tts'],
    ...(sttModel ? { sttModel } : {}),
    ...(ttsModel ? { ttsModel } : {}),
  };
}

export function getVoicePreference(): VoicePreference {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === 'voice_preference');
    if (setting) return normalizePreference({ ...DEFAULT, ...JSON.parse(setting.value) });
  } catch {}
  return { ...DEFAULT };
}

export function setVoicePreference(pref: Partial<VoicePreference>): VoicePreference {
  const current = getVoicePreference();
  const merged = normalizePreference({ ...current, ...pref });
  try {
    const db = readDB();
    if (!db.settings) db.settings = [];
    const idx = db.settings.findIndex((s: any) => s.key === 'voice_preference');
    if (idx >= 0) {
      db.settings[idx].value = JSON.stringify(merged);
    } else {
      db.settings.push({ key: 'voice_preference', value: JSON.stringify(merged) });
    }
    writeDB(db);
  } catch {}
  return merged;
}
