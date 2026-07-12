import { getBackendOrigin } from './apiBridge';
import { getStoredToken } from './authService';

const BASE = `${getBackendOrigin()}/api/voice`;

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

export async function cloneVoice(sampleUrls: string[], name: string, provider?: string): Promise<{ voiceId: string; name: string; provider: string; model?: string; source?: string }> {
  const res = await voiceFetch('/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sampleUrls, name, provider: provider || 'cosyvoice' }),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Clone failed'));
  }
  return res.json();
}

export async function designVoice(prompt: string, name: string, provider?: string): Promise<{ voiceId: string; name: string; provider: string; source?: string }> {
  const res = await voiceFetch('/design', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, name, provider: provider || 'cosyvoice' }),
  });
  if (!res.ok) {
    throw new Error(await readError(res, 'Voice design failed'));
  }
  return res.json();
}

export async function listVoices(): Promise<{ cloned: any[]; premade: any[] }> {
  const res = await voiceFetch('/voices');
  if (!res.ok) throw new Error(await readError(res, 'Failed to fetch voices'));
  return res.json();
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
