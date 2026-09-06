import { apiFetch } from './apiClient';
import { MemoryAvatarApiError } from './memoryAvatarService';

export interface MemoryAvatarPortraitConfig {
  provider: 'did'; configured: boolean; cloudAllowed: boolean; available: boolean;
  cleanupPending?: boolean;
}
export interface MemoryAvatarPortraitOffer {
  portraitSessionId: string; callSessionId: string;
  offer: RTCSessionDescriptionInit; iceServers: RTCIceServer[]; expiresAt: number;
}
const collection = (id: string) => `/api/memory-avatars/${encodeURIComponent(id)}/portrait/streams`;
const record = (value: any) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function validReceipt(path: string, method: string, result: any): boolean {
  if (!record(result)) return false;
  if (path.endsWith('/config')) return result.provider === 'did'
    && ['configured', 'cloudAllowed', 'available'].every(key => typeof result[key] === 'boolean')
    && (!result.available || (result.configured && result.cloudAllowed));
  if (method === 'POST' && path.endsWith('/streams')) return typeof result.portraitSessionId === 'string' && Boolean(result.portraitSessionId)
    && typeof result.callSessionId === 'string' && record(result.offer) && result.offer.type === 'offer'
    && typeof result.offer.sdp === 'string' && result.offer.sdp.startsWith('v=0') && result.offer.sdp.length <= 256_000
    && Number.isFinite(result.expiresAt) && Array.isArray(result.iceServers) && result.iceServers.length <= 20;
  return result.ok === true;
}
async function request<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await apiFetch(path, { method, signal, redirect: 'error',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => null);
  signal?.throwIfAborted();
  if (!response.ok) throw new MemoryAvatarApiError(response.status, String(result?.code || 'portrait_unavailable'), 'Portrait service unavailable.');
  if (!validReceipt(path, method, result)) throw new MemoryAvatarApiError(502, 'invalid_portrait_response', 'Portrait response was not confirmed.');
  return result;
}
const configPath = '/api/memory-avatar-portrait/config';
export const memoryAvatarPortraitService = {
  config: (signal?: AbortSignal) => request<MemoryAvatarPortraitConfig>(configPath, 'GET', undefined, signal),
  saveConfig: (body: { apiKey?: string; clearKey?: boolean; cloudConsent: boolean }, signal?: AbortSignal) => request<MemoryAvatarPortraitConfig>(configPath, 'PUT', body, signal),
  create: (avatarId: string, callSessionId: string, clientRequestId: string, signal?: AbortSignal) => request<MemoryAvatarPortraitOffer>(collection(avatarId), 'POST', { callSessionId, clientRequestId, cloudConsent: true }, signal),
  answer: (avatarId: string, id: string, callSessionId: string, answer: RTCSessionDescriptionInit, signal?: AbortSignal) => request(`${collection(avatarId)}/${encodeURIComponent(id)}/answer`, 'POST', { callSessionId, answer }, signal),
  ice: (avatarId: string, id: string, callSessionId: string, candidate: RTCIceCandidateInit | null, signal?: AbortSignal) => request(`${collection(avatarId)}/${encodeURIComponent(id)}/ice`, 'POST', { callSessionId, candidate }, signal),
  close: (avatarId: string, id: string, callSessionId: string) => request(`${collection(avatarId)}/${encodeURIComponent(id)}`, 'DELETE', { callSessionId }, AbortSignal.timeout(10_000)),
  cancel: (avatarId: string, callSessionId: string, clientRequestId: string) => request(`${collection(avatarId)}/by-request/${encodeURIComponent(clientRequestId)}`, 'DELETE', { callSessionId }, AbortSignal.timeout(10_000)),
};
