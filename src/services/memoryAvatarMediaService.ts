import type { MemoryAvatar, MemoryAvatarMedia, MemoryAvatarMediaVariant } from '../../shared/memory_avatar';
import { apiFetch, apiUrl } from './apiClient';
import { getStoredToken } from './authService';
import { MemoryAvatarApiError, validMemoryAvatar } from './memoryAvatarService';

export interface MemoryAvatarMediaReceipt { media: MemoryAvatarMedia; avatar: MemoryAvatar }
export interface MemoryAvatarUploadProgress { loaded: number; total?: number }
export interface MemoryAvatarUploadInput { file: File; revision: number; clientRequestId: string; title: string; caption?: string }
const collection = (avatarId: string) => `/api/memory-avatars/${encodeURIComponent(avatarId)}/media`;
const itemPath = (avatarId: string, mediaId: string) => `${collection(avatarId)}/${encodeURIComponent(mediaId)}`;
const object = (value: any) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export const validMemoryAvatarMedia = (value: any): boolean => object(value)
  && typeof value.id === 'string' && Boolean(value.id) && ['image', 'video', 'audio'].includes(value.kind)
  && typeof value.title === 'string' && typeof value.mimeType === 'string'
  && (value.caption === undefined || (typeof value.caption === 'string' && value.caption.length <= 2000))
  && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0
  && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
  && ['stored', 'processing', 'ready', 'failed', 'cancelled'].includes(value.status)
  && ['hasThumbnail', 'hasPoster', 'hasAudio'].every(key => typeof value[key] === 'boolean');
const validReceipt = (value: any): boolean => object(value) && validMemoryAvatarMedia(value.media) && validMemoryAvatar(value.avatar);
const invalidResponse = () => new MemoryAvatarApiError(502, 'invalid_media_response', 'The server did not confirm the media operation.');
const abortError = () => new DOMException('The request was aborted.', 'AbortError');

async function request<T>(path: string, method: string, body: unknown, signal: AbortSignal | undefined, validate: (value: any) => boolean): Promise<T> {
  const response = await apiFetch(path, { method, signal, redirect: 'error', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => null);
  signal?.throwIfAborted();
  if (!response.ok) throw new MemoryAvatarApiError(response.status, String(result?.code || ''), String(result?.error || 'Media request failed'));
  if (!validate(result)) throw invalidResponse();
  return result as T;
}

/** A single item has a stable request ID across retries; uploading never implies extraction. */
function upload(avatarId: string, input: MemoryAvatarUploadInput, options: { signal?: AbortSignal; onProgress?: (progress: MemoryAvatarUploadProgress) => void } = {}): Promise<MemoryAvatarMediaReceipt> {
  return new Promise((resolve, reject) => {
    const { signal, onProgress } = options;
    if (signal?.aborted) { reject(abortError()); return; }
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', input.file); form.append('revision', String(input.revision));
    form.append('clientRequestId', input.clientRequestId); form.append('title', input.title);
    if (input.caption) form.append('caption', input.caption);
    let finished = false;
    const settle = (error?: Error, receipt?: MemoryAvatarMediaReceipt) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      xhr.upload.onprogress = null;
      xhr.onload = null; xhr.onerror = null; xhr.onabort = null; xhr.ontimeout = null;
      if (error) reject(error); else resolve(receipt!);
    };
    const abort = () => { xhr.abort(); settle(abortError()); };
    xhr.open('POST', apiUrl(collection(avatarId)));
    xhr.withCredentials = true;
    xhr.timeout = 10 * 60 * 1000;
    const token = getStoredToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    try {
      const proof = localStorage.getItem('lumi_desktop_session_proof');
      if (proof) xhr.setRequestHeader('x-lumi-desktop-session', proof);
    } catch { /* Cookie/token authentication still applies. */ }
    xhr.upload.onprogress = event => { if (!finished && !signal?.aborted) onProgress?.({ loaded: event.loaded, ...(event.lengthComputable ? { total: event.total } : {}) }); };
    xhr.onload = () => {
      if (signal?.aborted) { settle(abortError()); return; }
      let result: any;
      try { result = JSON.parse(xhr.responseText); } catch { settle(invalidResponse()); return; }
      if (xhr.status < 200 || xhr.status >= 300) { settle(new MemoryAvatarApiError(xhr.status, String(result?.code || ''), String(result?.error || 'Upload failed'))); return; }
      if (!validReceipt(result) || result.avatar.id !== avatarId) { settle(invalidResponse()); return; }
      settle(undefined, result);
    };
    xhr.onerror = () => settle(new MemoryAvatarApiError(0, 'upload_unconfirmed', 'Upload was not confirmed.'));
    xhr.ontimeout = () => settle(new MemoryAvatarApiError(0, 'upload_timeout', 'Upload confirmation timed out.'));
    xhr.onabort = () => settle(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { xhr.send(form); } catch (error) { settle(error instanceof Error ? error : new Error('Upload failed')); }
  });
}

export const memoryAvatarMediaService = {
  list: (avatarId: string, signal?: AbortSignal) => request<{ media: MemoryAvatarMedia[]; revision: number }>(collection(avatarId), 'GET', undefined, signal,
    value => object(value) && Number.isSafeInteger(value.revision) && value.revision >= 1 && Array.isArray(value.media) && value.media.every(validMemoryAvatarMedia)),
  upload,
  process: (avatarId: string, mediaId: string, revision: number, signal?: AbortSignal) => request<MemoryAvatarMediaReceipt>(`${itemPath(avatarId, mediaId)}/process`, 'POST', { revision }, signal,
    value => validReceipt(value) && value.avatar.id === avatarId && value.media.id === mediaId),
  cancel: (avatarId: string, mediaId: string, revision: number, signal?: AbortSignal) => request<MemoryAvatarMediaReceipt>(`${itemPath(avatarId, mediaId)}/cancel`, 'POST', { revision }, signal,
    value => validReceipt(value) && value.avatar.id === avatarId && value.media.id === mediaId),
  remove: (avatarId: string, mediaId: string, revision: number, signal?: AbortSignal) => request<{ ok: true; avatar: MemoryAvatar }>(itemPath(avatarId, mediaId), 'DELETE', { revision }, signal,
    value => object(value) && value.ok === true && validMemoryAvatar(value.avatar) && value.avatar.id === avatarId),
};

export async function loadMemoryAvatarMediaResource(avatarId: string, mediaId: string, variant: MemoryAvatarMediaVariant, signal?: AbortSignal) {
  const response = await apiFetch(`${itemPath(avatarId, mediaId)}/content?variant=${encodeURIComponent(variant)}`, { signal, redirect: 'error' });
  if (!response.ok) throw new MemoryAvatarApiError(response.status, 'preview_failed', 'Private media is unavailable.');
  const blob = await response.blob();
  signal?.throwIfAborted();
  if (!/^(?:image\/(?:jpeg|png|webp)|video\/(?:mp4|quicktime|webm)|audio\/(?:wav|x-wav|mpeg|mp3|flac|x-flac|ogg|mp4|x-m4a|webm))(?:;|$)/i.test(blob.type)) throw invalidResponse();
  const url = URL.createObjectURL(blob);
  let released = false;
  return { url, release() { if (!released) { released = true; URL.revokeObjectURL(url); } } };
}
