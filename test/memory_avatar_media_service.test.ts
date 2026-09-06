// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_AVATAR_APPEARANCE } from '../shared/memory_avatar';
const mocks = vi.hoisted(() => ({ api: vi.fn(), token: 'private-token' }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: mocks.api, apiUrl: (path: string) => `http://127.0.0.1:3000${path}` }));
vi.mock('../src/services/authService', () => ({ getStoredToken: () => mocks.token }));
import { loadMemoryAvatarMediaResource, memoryAvatarMediaService } from '../src/services/memoryAvatarMediaService';
import { memoryAvatarService } from '../src/services/memoryAvatarService';
const avatar = { id: 'person/a', name: 'Person', relationshipType: 'close_friend', status: 'active', revision: 2, narrative: '', appearance: DEFAULT_MEMORY_AVATAR_APPEARANCE, voice: {}, memoryCount: 0 };
const media = { id: 'media/a', title: 'Portrait', kind: 'image', mimeType: 'image/png', sizeBytes: 3, status: 'stored', createdAt: 'now', updatedAt: 'now', hasThumbnail: true, hasPoster: false, hasAudio: false };
class ControlledXhr {
  static instances: ControlledXhr[] = [];
  constructor() { ControlledXhr.instances.push(this); }
  upload = { onprogress: null as ((event: any) => void) | null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null;
  onabort: (() => void) | null = null; ontimeout: (() => void) | null = null;
  method = ''; url = ''; withCredentials = false; timeout = 0; headers: Record<string, string> = {};
  body?: FormData; responseText = ''; status = 0; aborted = false;
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: FormData) { this.body = body; }
  abort() { this.aborted = true; this.onabort?.(); }
  respond(status: number, body: any) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.(); }
}
beforeEach(() => {
  mocks.api.mockReset(); ControlledXhr.instances = []; localStorage.clear();
  vi.stubGlobal('XMLHttpRequest', ControlledXhr);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:private-resource') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
const input = () => ({ file: new File(['png'], 'portrait.png', { type: 'image/png' }), revision: 1, clientRequestId: 'stable-attempt', title: 'Portrait', caption: 'A synthetic portrait' });

it('uploads one authenticated private item with real transport progress and explicit receipt validation', async () => {
  localStorage.setItem('lumi_desktop_session_proof', 'desktop-proof');
  const progress = vi.fn(); const pending = memoryAvatarMediaService.upload('person/a', input(), { onProgress: progress });
  const xhr = ControlledXhr.instances[0];
  expect(xhr.method).toBe('POST'); expect(xhr.url).toBe('http://127.0.0.1:3000/api/memory-avatars/person%2Fa/media');
  expect(xhr.withCredentials).toBe(true); expect(xhr.headers).toEqual({ Authorization: 'Bearer private-token', 'x-lumi-desktop-session': 'desktop-proof' });
  expect(xhr.body?.get('clientRequestId')).toBe('stable-attempt'); expect(xhr.body?.get('revision')).toBe('1');
  expect(xhr.body?.get('caption')).toBe('A synthetic portrait'); expect(xhr.body?.get('file')).toBeInstanceOf(File);
  xhr.upload.onprogress?.({ loaded: 3, total: 6, lengthComputable: true });
  expect(progress).toHaveBeenCalledWith({ loaded: 3, total: 6 });
  xhr.respond(201, { media, avatar });
  await expect(pending).resolves.toMatchObject({ media: { status: 'stored' }, avatar: { revision: 2 } });
  expect(xhr.onload).toBeNull(); expect(mocks.api).not.toHaveBeenCalled();
});

it.each([{}, { media, avatar: {} }, { media: { ...media, status: 'pretend' }, avatar }, { media, avatar: { ...avatar, id: 'another-person' } }])('rejects malformed successful upload receipts (%j)', async payload => {
  const pending = memoryAvatarMediaService.upload('person/a', input());
  ControlledXhr.instances[0].respond(201, payload);
  await expect(pending).rejects.toMatchObject({ code: 'invalid_media_response' });
});

it('aborts an upload without issuing an automatic retry, and removes late handlers', async () => {
  const controller = new AbortController(); const pending = memoryAvatarMediaService.upload('person/a', input(), { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const xhr = ControlledXhr.instances[0]; expect(xhr.aborted).toBe(true); expect(xhr.onload).toBeNull();
  expect(ControlledXhr.instances).toHaveLength(1);
});

it('preserves the status and error code of a failed upload for an explicit retry', async () => {
  const pending = memoryAvatarMediaService.upload('person/a', input());
  ControlledXhr.instances[0].respond(409, { code: 'revision_conflict', error: 'Changed elsewhere' });
  await expect(pending).rejects.toMatchObject({ status: 409, code: 'revision_conflict' });
  expect(ControlledXhr.instances).toHaveLength(1);
});

it('loads preview through the authenticated private route and revokes its Blob exactly once', async () => {
  mocks.api.mockResolvedValue({ ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }) });
  const controller = new AbortController(); const resource = await loadMemoryAvatarMediaResource('person/a', 'media/a', 'thumbnail', controller.signal);
  expect(mocks.api).toHaveBeenCalledWith('/api/memory-avatars/person%2Fa/media/media%2Fa/content?variant=thumbnail', { signal: controller.signal, redirect: 'error' });
  expect(resource.url).toBe('blob:private-resource'); resource.release(); resource.release();
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:private-resource');
});

it('does not manufacture an image Blob after abort during body reading or for active HTML/SVG payloads', async () => {
  const controller = new AbortController();
  mocks.api.mockResolvedValueOnce({ ok: true, blob: async () => { controller.abort(); return new Blob(['png'], { type: 'image/png' }); } });
  await expect(loadMemoryAvatarMediaResource('a', 'm', 'original', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  for (const type of ['text/html', 'image/svg+xml']) {
    mocks.api.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['unsafe'], { type }) });
    await expect(loadMemoryAvatarMediaResource('a', 'm', 'original')).rejects.toMatchObject({ code: 'invalid_media_response' });
  }
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('uses revisioned explicit process, cancel and remove requests, with abort support', async () => {
  const scopedAvatar = { ...avatar, id: 'a' }; const scopedMedia = { ...media, id: 'm' };
  mocks.api.mockResolvedValueOnce({ ok: true, json: async () => ({ media: scopedMedia, avatar: scopedAvatar }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ media: { ...scopedMedia, status: 'cancelled' }, avatar: scopedAvatar }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, avatar: scopedAvatar }) });
  const controller = new AbortController();
  await memoryAvatarMediaService.process('a', 'm', 2, controller.signal);
  await memoryAvatarMediaService.cancel('a', 'm', 3, controller.signal);
  await memoryAvatarMediaService.remove('a', 'm', 4, controller.signal);
  expect(mocks.api.mock.calls.map(([path, request]) => [path, request.method, JSON.parse(request.body), request.signal])).toEqual([
    ['/api/memory-avatars/a/media/m/process', 'POST', { revision: 2 }, controller.signal],
    ['/api/memory-avatars/a/media/m/cancel', 'POST', { revision: 3 }, controller.signal],
    ['/api/memory-avatars/a/media/m', 'DELETE', { revision: 4 }, controller.signal],
  ]);
});

it('validates portrait selection and passes cancellation through the real avatar update service', async () => {
  const controller = new AbortController();
  mocks.api.mockResolvedValue({ ok: true, json: async () => ({ ...avatar, presentation: { mode: 'portrait', mediaId: 'media/a' } }) });
  await memoryAvatarService.update('person/a', { revision: 1, presentation: { mode: 'portrait', mediaId: 'media/a' } }, controller.signal);
  expect(mocks.api.mock.calls[0][1].signal).toBe(controller.signal);
  mocks.api.mockResolvedValue({ ok: true, json: async () => ({ ...avatar, presentation: { mode: 'portrait' } }) });
  await expect(memoryAvatarService.get('person/a')).rejects.toMatchObject({ code: 'invalid_memory_avatar_response' });
});
