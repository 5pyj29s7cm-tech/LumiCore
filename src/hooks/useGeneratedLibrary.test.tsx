// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useGeneratedLibrary } from './useGeneratedLibrary';
import { archivedMediaArtifacts } from '@/lib/generatedLibrary';
import { createChatAttachmentReference, serializeChatAttachmentContext, parseChatAttachmentContext } from '@/lib/chatAttachmentReferences';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const response = (files: unknown[]) => ({ ok: true, json: async () => ({ files }) } as Response);
describe('Account-scoped generated library', () => {
  it('discards a late response after an account switch', async () => {
    let finishOld: (value: Response) => void = () => {};
    const old = new Promise<Response>(resolve => { finishOld = resolve; });
    const fetcher = vi.fn((url: string, init: RequestInit) => init?.method === 'POST' ? Promise.resolve(response([]))
      : url.startsWith('/old') ? old : Promise.resolve(response([{ id: 'new.txt', name: 'new.txt' }])));
    vi.stubGlobal('fetch', fetcher);
    const oldUrl = (url: string) => '/old' + url, newUrl = (url: string) => '/new' + url;
    const { result, rerender } = renderHook(({ owner, url }) => useGeneratedLibrary(owner, url), { initialProps: { owner: 'old', url: oldUrl } });
    let pending: Promise<void>;
    await act(async () => { pending = result.current.refresh(); await Promise.resolve(); });
    rerender({ owner: 'new', url: newUrl });
    expect(result.current.files).toEqual([]);
    await act(async () => { await result.current.refresh(); });
    await act(async () => { finishOld(response([{ id: 'private.txt' }])); await pending; });
    expect(result.current.files.map(file => file.id)).toEqual(['new.txt']);
  });

  it('keeps archived references independent of source conversations and preserves them in attachment context', () => {
    const [media] = archivedMediaArtifacts([{ id: 'snapshot.png', name: 'photo.png', path: 'D:/vault/snapshot.png', archiveId: 'archive1', archiveKind: 'image', sourceConversationId: 'old-conversation' }], url => url + '&domain=personal');
    expect(media.url).toBe('/api/files/download/snapshot.png?inline=1&domain=personal');
    expect(media.url).not.toContain('old-conversation');
    const reference = createChatAttachmentReference({ ...media, openUrl: media.url });
    expect(parseChatAttachmentContext(serializeChatAttachmentContext([reference]))[0]).toMatchObject({ fileId: 'snapshot.png', path: 'D:/vault/snapshot.png', kind: 'image' });
  });
});
