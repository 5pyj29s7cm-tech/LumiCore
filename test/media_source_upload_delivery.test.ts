import { makeApp, JWT_SECRET } from './helpers';
import fs from 'node:fs';
import sharp from 'sharp';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../src/services/apiClient';
import { ChatViewWorkRegistry } from '../src/lib/chatViewWork';
import { mediaGenerationCopy } from '../src/i18n/locales/mediaGeneration';
import { extractSourceExpression as extract } from './source_expression';
import { resolveChatVideoRequest } from '../server/socket/chat/media_request';
import { structuredMediaToolCall } from '../shared/media_generation';
import { makeChatArtifact } from '../shared/chat_artifacts';
import { registerKnowledgeImportRoutes } from '../server/files/knowledge/import_routes';
import * as extraction from '../server/files/knowledge/extraction';

const testBackend = vi.hoisted(() => ({ origin: '' }));
vi.mock('../src/services/apiBridge', () => ({ getBackendOrigin: () => testBackend.origin }));

let app: Awaited<ReturnType<typeof makeApp>>;
const owner = 'source-upload-user';
let bytes: Buffer;
const realFetch = globalThis.fetch;
let extractSpy: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  bytes = await sharp(Buffer.from('<svg width="4" height="4"><rect width="4" height="4" fill="#3366aa"/></svg>')).png().toBuffer();
  app = await makeApp(); testBackend.origin = app.url;
  registerKnowledgeImportRoutes(app.apiRouter);
  extractSpy = vi.spyOn(extraction, 'extractKnowledgeFileContent');
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'lumi_auth_token' ? jwt.sign({ uid: owner, username: owner }, JWT_SECRET) : null });
  vi.stubGlobal('fetch', (url: any, init?: RequestInit) => {
    if (new URL(String(url)).origin !== app.url) throw new Error('Unexpected cloud call while uploading a first frame');
    return realFetch(url, init);
  });
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); app.cleanup(); });

function sourceUploadHarness() {
  const deps: Record<string, any> = {
    mediaSourceUploadTargetRef: { current: null }, mediaSourceUploading: false,
    chatViewWorkRef: { current: new ChatViewWorkRegistry() }, activeDomain: 'personal', activeOrgId: '',
    mediaGenerationText: mediaGenerationCopy('en'), FormData, makeChatArtifact,
    apiFetch: (url: string, init: RequestInit) => apiFetch(app.url + url, init),
    scopedFileUrl: (url: string) => url, artifacts: [],
    toast: { error: vi.fn(), success: vi.fn() }, t: {},
    handleMediaSourceChange: vi.fn(), notifyKnowledgeUpdated: vi.fn(),
    setMediaSourceUploading: (value: boolean) => { deps.mediaSourceUploading = value; },
    setMediaSourceArtifacts: (update: any) => { deps.artifacts = update(deps.artifacts); },
  };
  return { deps, upload: extract('src/components/AgentChatPage.tsx', 'uploadMediaSourceImage', deps) };
}

describe('external first-frame upload', () => {
  it('saves actual bytes using bearer authentication without cloud analysis and binds them to chat video', async () => {
    const h = sourceUploadHarness();
    await h.upload('image_to_video', 'first_frame', [new File([bytes], 'external-photo.png', { type: 'image/png' })]);
    expect(h.deps.toast.error).not.toHaveBeenCalled();
    expect(h.deps.mediaSourceUploading).toBe(false);
    expect(h.deps.mediaSourceUploadTargetRef.current).toBeNull();
    const change = h.deps.handleMediaSourceChange.mock.calls[0][0];
    expect(fs.readFileSync(change.value)).toEqual(bytes);
    expect(change).toMatchObject({ operation: 'image_to_video', slot: 'first_frame', artifact: { fileId: 'external-photo.png', kind: 'image' } });
    expect(extractSpy).not.toHaveBeenCalled();
    const request = resolveChatVideoRequest('这个帮我做个tiktok的推广视频，30秒的', [{ fileName: 'external-photo.png', path: change.value, kind: 'image' }], { userId: owner, domain: 'personal' })!;
    expect(structuredMediaToolCall(request)).toMatchObject({ name: 'generate_video', arguments: { duration: 30, first_frame_image: fs.realpathSync(change.value) } });
    const sources = extract('src/components/AgentChatPage.tsx', 'availableMediaSourceArtifacts', {
      mediaSourceArtifacts: h.deps.artifacts, mediaGenerationArtifacts: [], messages: [],
      libraryMediaArtifacts: Array.from({ length: 80 }, (_, i) => ({ id: 'library-' + i, kind: 'image', url: '/old/' + i, path: '/old/' + i })),
    })();
    expect(sources[0].fileId).toBe('external-photo.png');
    expect(sources).toHaveLength(24);
  });
  it('rejects fake image bytes and releases the upload lock for a successful retry', async () => {
    const h = sourceUploadHarness();
    await h.upload('image_to_video', 'first_frame', [new File(['not image bytes'], 'fake.png', { type: 'image/png' })]);
    expect(h.deps.toast.error).toHaveBeenCalled();
    expect(h.deps.handleMediaSourceChange).not.toHaveBeenCalled();
    expect(h.deps.mediaSourceUploading).toBe(false);
    await h.upload('image_to_video', 'first_frame', [new File([bytes], 'retry.png', { type: 'image/png' })]);
    expect(h.deps.handleMediaSourceChange).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized local selections before sending any bytes', async () => {
    const h = sourceUploadHarness();
    const oversized = new File([], 'large.png', { type: 'image/png' });
    Object.defineProperty(oversized, 'size', { value: 21 * 1024 * 1024 });
    h.deps.apiFetch = vi.fn();
    const upload = extract('src/components/AgentChatPage.tsx', 'uploadMediaSourceImage', h.deps);
    await upload('image_to_video', 'first_frame', [oversized]);
    expect(h.deps.apiFetch).not.toHaveBeenCalled();
    expect(h.deps.handleMediaSourceChange).not.toHaveBeenCalled();
  });
});
