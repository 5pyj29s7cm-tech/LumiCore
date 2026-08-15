import { getBackendOrigin } from './apiBridge';
import { getStoredToken } from './authService';

const BASE = `${getBackendOrigin()}/api/voice`;
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

function withVoiceAuth(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  const token = getStoredToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return { ...init, credentials: 'include', headers };
}

async function voiceFetch(path: string, init: RequestInit = {}) {
  return fetch(`${BASE}${path}`, withVoiceAuth(init));
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null);
  return data?.error || fallback;
}

export async function uploadSamples(files: File[]): Promise<{ urls: string[]; filenames: string[]; count: number }> {
  const form = new FormData();
  files.forEach(f => form.append('samples', f));

  const res = await voiceFetch('/samples', { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(await readError(res, 'Upload failed'));
  }
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
  if (!res.ok) {
    throw new Error(await readError(res, 'Clone failed'));
  }
  return res.json();
}

export async function getVoiceCloneStatus(voiceId: string): Promise<ClonedVoice> {
  const res = await voiceFetch(`/clone-status/${encodeURIComponent(voiceId)}`);
  if (!res.ok) throw new Error(await readError(res, 'Failed to query voice clone status'));
  return res.json();
}

export async function designVoice(prompt: string, name: string, provider?: string): Promise<{ voiceId: string; name: string; provider: string; source?: string }> {
  const res = await voiceFetch('/design', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, name, ...(provider ? { provider } : {}) }),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Voice design failed'));
  }
  return res.json();
}

export async function listVoices(provider?: string): Promise<VoiceCatalog> {
  const query = provider ? `?provider=${encodeURIComponent(provider)}` : '';
  const res = await voiceFetch(`/voices${query}`);
  if (!res.ok) throw new Error(await readError(res, 'Failed to fetch voices'));
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
  const res = await voiceFetch(`/${voiceId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await readError(res, 'Failed to delete voice'));
}

export async function synthesizeSpeech(text: string, voiceId: string, provider?: string, model?: string): Promise<ArrayBuffer> {
  const res = await voiceFetch('/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voiceId, provider, model }),
  });
  if (!res.ok) throw new Error(await readError(res, 'Speech synthesis failed'));
  return res.arrayBuffer();
}
