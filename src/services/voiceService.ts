import { apiFetch } from './apiClient';

export const VOICE_PROVIDER_CHANGED_EVENT = 'lumi:voice-provider-changed';

export interface VoiceCatalog {
  provider: string | null;
  configured: boolean;
  capabilities: { clone: boolean; design: boolean };
  cloned: any[];
  premade: any[];
}

export interface CloneVoiceOptions {
  speakerId?: string;
  language?: number;
  sampleText?: string;
  demoText?: string;
  enableAudioDenoise?: boolean;
  disableVolumeNormalization?: boolean;
  confirmPostpaidBilling?: boolean;
}

export interface ClonedVoice {
  voiceId: string;
  name: string;
  provider: string;
  model?: string;
  source?: string;
  status?: 'not_found' | 'training' | 'ready' | 'failed';
  demoAudio?: string;
  billingMode?: 'prepaid' | 'postpaid';
  availableTrainingTimes?: number;
  message?: string;
}

async function voiceFetch(path: string, init: RequestInit = {}) {
  const response = await apiFetch(`/api/voice${path}`, init);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return response;
}

export async function uploadSamples(files: File[]): Promise<{ urls: string[]; filenames: string[]; count: number }> {
  const form = new FormData();
  files.forEach(f => form.append('samples', f));

  const res = await voiceFetch('/samples', { method: 'POST', body: form });
  return res.json();
}

export async function cloneVoice(
  sampleUrls: string[],
  name: string,
  provider?: string,
  options: CloneVoiceOptions = {},
): Promise<ClonedVoice> {
  const res = await voiceFetch('/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sampleUrls, name, ...(provider ? { provider } : {}), ...options }),
  });
  return res.json();
}

export async function getVoiceCloneStatus(voiceId: string): Promise<ClonedVoice> {
  const res = await voiceFetch(`/clone-status/${encodeURIComponent(voiceId)}`);
  return res.json();
}

export async function designVoice(prompt: string, name: string, provider?: string): Promise<{ voiceId: string; name: string; provider: string; source?: string }> {
  const res = await voiceFetch('/design', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, name, ...(provider ? { provider } : {}) }),
  });
  return res.json();
}

export async function listVoices(provider?: string): Promise<VoiceCatalog> {
  const query = provider ? `?provider=${encodeURIComponent(provider)}` : '';
  const res = await voiceFetch(`/voices${query}`);
  const data = await res.json();
  return {
    provider: data.provider || null,
    configured: Boolean(data.configured),
    capabilities: {
      clone: Boolean(data.capabilities?.clone),
      design: Boolean(data.capabilities?.design),
    },
    cloned: Array.isArray(data.cloned) ? data.cloned : [],
    premade: Array.isArray(data.premade) ? data.premade : [],
  };
}

export async function deleteVoice(voiceId: string): Promise<void> {
  await voiceFetch(`/${encodeURIComponent(voiceId)}`, { method: 'DELETE' });
}

export async function synthesizeSpeech(text: string, voiceId: string, provider?: string, model?: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await voiceFetch('/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voiceId, provider, model }),
    signal,
  });
  return res.arrayBuffer();
}
