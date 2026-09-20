import { apiFetch } from './apiClient';
import { validAliyunRtc, type AliyunAvatarConfig, type AliyunAvatarOffer } from '../../shared/aliyun_avatar';
const base = (id: string) => `/api/memory-avatars/${encodeURIComponent(id)}/portrait/aliyun`;
async function request<T>(id: string, path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await apiFetch(`${base(id)}/${path}`, { method, signal, redirect: 'error',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => null); signal?.throwIfAborted();
  if (!response.ok) throw new Error(result?.code || 'aliyun_unavailable');
  const valid = path === 'config' || path === 'cleanup' ? result?.provider === 'aliyun' && ['configured', 'enabled', 'available', 'cloudAllowed', 'cleanupPending'].every(key => typeof result[key] === 'boolean')
    && typeof result.projectId === 'string' && typeof result.instanceId === 'string'
    : method === 'POST' && path === 'streams' ? result?.provider === 'aliyun' && typeof result.portraitSessionId === 'string' && !!result.portraitSessionId
      && typeof result.sessionId === 'string' && !!result.sessionId && typeof result.callSessionId === 'string' && Number.isFinite(result.expiresAt) && validAliyunRtc(result.rtc)
      : result?.ok === true;
  if (!valid) throw new Error('aliyun_response_unconfirmed');
  return result;
}
export const aliyunAvatarService = {
  config: (id: string, signal?: AbortSignal) => request<AliyunAvatarConfig>(id, 'config', 'GET', undefined, signal),
  cleanup: (id: string, signal?: AbortSignal) => request<AliyunAvatarConfig>(id, 'cleanup', 'POST', {}, signal),
  save: (id: string, body: { accessKeyId?: string; accessKeySecret?: string; clearKey?: boolean; enabled: boolean; projectId?: string; instanceId?: string; cloudConsent?: boolean }, signal?: AbortSignal) => request<AliyunAvatarConfig>(id, 'config', 'PUT', body, signal),
  create: (id: string, callSessionId: string, clientRequestId: string, signal: AbortSignal) => request<AliyunAvatarOffer>(id, 'streams', 'POST', { callSessionId, clientRequestId, cloudConsent: true }, signal),
  ready: (id: string, callSessionId: string, portraitId: string, signal: AbortSignal) => request(id, `streams/${encodeURIComponent(portraitId)}/ready`, 'POST', { callSessionId }, signal),
  heartbeat: (id: string, callSessionId: string, portraitId: string) => request(id, `streams/${encodeURIComponent(portraitId)}/heartbeat`, 'POST', { callSessionId }, AbortSignal.timeout(10_000)),
  cancel: (id: string, callSessionId: string, clientRequestId: string) => request(id, `streams/by-request/${encodeURIComponent(clientRequestId)}`, 'DELETE', { callSessionId }, AbortSignal.timeout(30_000)),
};
