// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_AVATAR_APPEARANCE, type MemoryAvatar, type MemoryAvatarMedia } from '../shared/memory_avatar';
const mocks = vi.hoisted(() => ({
  list: vi.fn(), upload: vi.fn(), process: vi.fn(), cancel: vi.fn(), remove: vi.fn(), resource: vi.fn(),
  get: vi.fn(), update: vi.fn(), materials: vi.fn(), archive: vi.fn(), voices: vi.fn(), token: 'owner-a-token',
}));
vi.mock('../src/services/memoryAvatarMediaService', () => ({ memoryAvatarMediaService: mocks, loadMemoryAvatarMediaResource: mocks.resource }));
vi.mock('../src/services/memoryAvatarService', async original => ({ ...await original<typeof import('../src/services/memoryAvatarService')>(), memoryAvatarService: mocks }));
vi.mock('../src/services/authService', () => ({ getStoredToken: () => mocks.token }));
vi.mock('../src/services/voiceService', () => ({ listVoices: mocks.voices }));
vi.mock('../src/components/MemoryAvatarPortraitSettings', () => ({ MemoryAvatarPortraitSettings: () => null }));
import { MemoryAvatarProfile } from '../src/components/MemoryAvatarProfile';
import { MemoryAvatarMediaPanel } from '../src/components/MemoryAvatarMediaPanel';
import { MemoryAvatarMediaPreview } from '../src/components/MemoryAvatarMediaPreview';
import { MemoryAvatarApiError } from '../src/services/memoryAvatarService';

const makeAvatar = (extra: Partial<MemoryAvatar> = {}): MemoryAvatar => ({
  id: 'avatar-a', name: 'Synthetic person', relationshipType: 'close_friend', status: 'active', revision: 1,
  narrative: '', appearance: { ...DEFAULT_MEMORY_AVATAR_APPEARANCE }, voice: {}, memoryCount: 0,
  isFrozen: true, personalityConfig: {}, evidenceMap: [], seedMemoryIds: [], createdAt: '2026-09-06', updatedAt: '2026-09-06', ...extra,
});
const media = (extra: Partial<MemoryAvatarMedia> = {}): MemoryAvatarMedia => ({
  id: 'photo-a', kind: 'image', title: 'Synthetic photo', mimeType: 'image/png', sizeBytes: 100,
  createdAt: '2026-09-06', updatedAt: '2026-09-06', status: 'stored', hasThumbnail: true, hasPoster: false, hasAudio: false, ...extra,
});
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
let record: MemoryAvatar;
let rows: MemoryAvatarMedia[];
beforeEach(() => {
  Object.values(mocks).forEach(value => { if (vi.isMockFunction(value)) value.mockReset(); });
  mocks.token = 'owner-a-token'; record = makeAvatar(); rows = [];
  mocks.list.mockImplementation(async () => ({ media: rows, revision: record.revision }));
  mocks.get.mockImplementation(async () => record);
  mocks.materials.mockImplementation(async () => ({ materials: [], revision: record.revision }));
  mocks.update.mockImplementation(async (_id, input) => { record = { ...record, ...input, revision: record.revision + 1 }; return record; });
  mocks.upload.mockImplementation(async (_id, input) => {
    const item = media({ id: input.clientRequestId, title: input.file.name });
    rows.push(item); record = { ...record, revision: record.revision + 1 }; return { media: item, avatar: record };
  });
  mocks.voices.mockResolvedValue({ premade: [], cloned: [] });
  mocks.resource.mockResolvedValue({ url: 'blob:synthetic-photo', release: vi.fn() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
function panel(options: Partial<React.ComponentProps<typeof MemoryAvatarMediaPanel>> = {}, asProfile = false) {
  const updated = vi.fn(); const before = vi.fn();
  function Harness() {
    const [avatar, setAvatar] = useState(record);
    const props = { avatar, ownerId: 'owner-a', locale: 'en' as const, onUpdated: (next: MemoryAvatar) => { updated(next); setAvatar(next); }, onBeforeMutation: before, ...options };
    return asProfile ? <MemoryAvatarProfile {...props} onArchived={vi.fn()} onClose={vi.fn()} /> : <MemoryAvatarMediaPanel {...props} />;
  }
  return { ...render(<Harness />), updated, before };
}
function choose(files: File[]) { fireEvent.change(screen.getByLabelText('Choose photos, video or recordings', { selector: 'input' }), { target: { files } }); }

it('mounts the media tab in the real profile and retains partial upload receipts and exact retry IDs across profile revisions', async () => {
  const h = panel({}, true);
  await act(async () => {}); expect(mocks.list).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'Photos & audio' })); await screen.findByText('No photos, video or recordings yet.');
  const gate = deferred<any>();
  const defaultUpload = mocks.upload.getMockImplementation()!;
  mocks.upload.mockImplementationOnce(async (id, input, options) => {
    options.onProgress({ loaded: 5, total: 10 });
    await gate.promise; return defaultUpload(id, input, options);
  }).mockRejectedValueOnce(new Error('interrupted transport'));
  const first = new File(['one'], 'first.png', { type: 'image/png' });
  const second = new File(['two'], 'second.png', { type: 'image/png' });
  choose([first, second]);
  await screen.findByText('Uploading 50%');
  expect(mocks.upload).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('tab', { name: 'About' }));
  expect(button('Save details').disabled).toBe(true);
  fireEvent.click(screen.getByRole('tab', { name: 'Photos & audio' }));
  await act(async () => gate.resolve(undefined));
  await screen.findByText('Upload was not confirmed. Retry this item.');
  expect(mocks.upload).toHaveBeenCalledTimes(2);
  expect(h.updated).toHaveBeenCalledTimes(1);
  expect(mocks.upload.mock.calls[1][1].revision).toBe(2);
  const firstId = mocks.upload.mock.calls[0][1].clientRequestId;
  const retryId = mocks.upload.mock.calls[1][1].clientRequestId;
  expect(retryId).not.toBe(firstId);
  fireEvent.click(button('Retry')); await waitFor(() => expect(h.updated).toHaveBeenCalledTimes(2));
  expect(mocks.upload).toHaveBeenCalledTimes(3);
  expect(mocks.upload.mock.calls[2][1]).toMatchObject({ clientRequestId: retryId, file: second, revision: 2 });
  expect(mocks.upload.mock.calls.filter(([, input]) => input.file === first)).toHaveLength(1);
  expect(mocks.process).not.toHaveBeenCalled();
  expect(screen.getAllByText('Original saved')).toHaveLength(2);
});

it('keeps same-name distinct files as separate deliberate uploads and rejects unsupported files without a request', async () => {
  panel(); await act(async () => {});
  choose([new File(['a'], 'same.png'), new File(['b'], 'same.png'), new File(['<svg/>'], 'unsafe.svg')]);
  await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
  expect(mocks.upload.mock.calls[0][1].clientRequestId).not.toBe(mocks.upload.mock.calls[1][1].clientRequestId);
  await screen.findByText('This file type or size is not supported. Choose another file.');
});

it.each(['person', 'owner', 'token', 'close'])('aborts %s scope changes and ignores a late upload instead of binding it to the new view', async boundary => {
  const gate = deferred<any>(); mocks.upload.mockReturnValue(gate.promise);
  const updated = vi.fn(); const props = { ownerId: 'owner-a', avatar: record, locale: 'en' as const, onUpdated: updated };
  const view = render(<MemoryAvatarMediaPanel {...props} />); await act(async () => {});
  choose([new File(['a'], 'old.png')]); await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
  const signal = mocks.upload.mock.calls[0][2].signal;
  if (boundary === 'close') view.unmount();
  else {
    if (boundary === 'token') mocks.token = 'rotated-token';
    view.rerender(<MemoryAvatarMediaPanel {...props} ownerId={boundary === 'owner' ? 'owner-b' : props.ownerId} avatar={boundary === 'person' ? makeAvatar({ id: 'avatar-b' }) : record} />);
  }
  expect(signal.aborted).toBe(true);
  await act(async () => gate.resolve({ avatar: makeAvatar({ revision: 2 }), media: media({ title: 'late private photo' }) }));
  expect(updated).not.toHaveBeenCalled(); expect(screen.queryByText('late private photo')).toBeNull();
});

it('cancels an in-flight upload and exposes a recoverable retry with the same request identity', async () => {
  mocks.upload.mockImplementationOnce((_id, _input, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
  panel(); await act(async () => {}); choose([new File(['a'], 'cancel.png')]);
  await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
  fireEvent.click(button('Cancel upload: cancel.png'));
  await screen.findByText('Upload was not confirmed. Retry this item.');
  fireEvent.click(button('Retry')); await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
  expect(mocks.upload.mock.calls[1][1].clientRequestId).toBe(mocks.upload.mock.calls[0][1].clientRequestId);
});

it('selects a verified original as portrait without requiring extraction and only publishes after server confirmation', async () => {
  rows = [media()]; const gate = deferred<MemoryAvatar>(); mocks.update.mockReturnValue(gate.promise);
  const h = panel(); await screen.findByText('Synthetic photo');
  fireEvent.click(button('Use as portrait')); await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
  expect(h.before).toHaveBeenCalledTimes(1); expect(h.updated).not.toHaveBeenCalled();
  expect(mocks.update.mock.calls[0]).toEqual(['avatar-a', { revision: 1, presentation: { mode: 'portrait', mediaId: 'photo-a' } }, expect.any(AbortSignal)]);
  await act(async () => gate.resolve(makeAvatar({ revision: 2, presentation: { mode: 'portrait', mediaId: 'photo-a' } })));
  await screen.findByText('Portrait saved.'); expect(button('Current portrait').disabled).toBe(true);
  expect(mocks.process).not.toHaveBeenCalled();
});

it('does not submit a portrait update when leaving during the call-stop boundary', async () => {
  rows = [media()]; const gate = deferred<void>(); const h = panel({ onBeforeMutation: () => gate.promise });
  await screen.findByText('Synthetic photo'); fireEvent.click(button('Use as portrait')); h.unmount();
  await act(async () => gate.resolve()); expect(mocks.update).not.toHaveBeenCalled();
});

it('offers a real retry after processing failure, a cancellation receipt, and preserves portrait eligibility', async () => {
  rows = [media({ status: 'failed' })];
  mocks.process.mockImplementation(async () => { record = { ...record, revision: 2 }; return { avatar: record, media: media({ status: 'processing' }) }; });
  mocks.cancel.mockImplementation(async () => { record = { ...record, revision: 3 }; return { avatar: record, media: media({ status: 'cancelled' }) }; });
  panel(); await screen.findByText('Extraction failed'); expect(button('Use as portrait').disabled).toBe(false);
  fireEvent.click(button('Retry extraction')); await screen.findByText('Extracting records');
  expect(mocks.process.mock.calls[0].slice(0, 3)).toEqual(['avatar-a', 'photo-a', 1]);
  fireEvent.click(button('Cancel extraction')); await screen.findByText('Extraction cancelled');
  expect(mocks.cancel.mock.calls[0].slice(0, 3)).toEqual(['avatar-a', 'photo-a', 2]);
  expect(button('Use as portrait').disabled).toBe(false);
});

it('requires explicit deletion confirmation and releases the private preview after confirmed removal', async () => {
  rows = [media({ caption: 'My synthetic source description' })]; const release = vi.fn(); mocks.resource.mockResolvedValue({ url: 'blob:private-photo', release });
  const gate = deferred<any>(); mocks.remove.mockReturnValue(gate.promise);
  panel(); await screen.findByText('Synthetic photo'); fireEvent.click(button('Preview'));
  await screen.findByAltText('Synthetic photo'); expect(screen.getByText('My synthetic source description')).toBeTruthy(); fireEvent.click(button('Delete original and extracted records'));
  expect(mocks.remove).not.toHaveBeenCalled(); fireEvent.click(button('Click again to confirm deletion'));
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(1)); expect(release).not.toHaveBeenCalled();
  await act(async () => gate.resolve({ ok: true, avatar: makeAvatar({ revision: 2, presentation: { mode: 'human3d' } }) }));
  await screen.findByText('Media deleted.'); expect(release).toHaveBeenCalledTimes(1); expect(screen.queryByAltText('Synthetic photo')).toBeNull();
});

it('loads private preview on demand and releases even a late response after an owner switch', async () => {
  const gate = deferred<any>(); const release = vi.fn(); mocks.resource.mockReturnValueOnce(gate.promise);
  const props = { avatarId: 'avatar-a', media: media(), locale: 'en' as const };
  const view = render(<MemoryAvatarMediaPreview {...props} ownerId="owner-a" />);
  const signal = mocks.resource.mock.calls[0][3];
  view.rerender(<MemoryAvatarMediaPreview {...props} ownerId="owner-b" />);
  expect(signal.aborted).toBe(true);
  await act(async () => gate.resolve({ url: 'blob:old-private-photo', release }));
  expect(release).toHaveBeenCalledTimes(1);
  expect(screen.queryByAltText('Synthetic photo')?.getAttribute('src')).not.toBe('blob:old-private-photo');
});

it('shows failed loading instead of claiming no media, and reloads the actual list', async () => {
  mocks.list.mockRejectedValueOnce(new Error('transport failure')); panel();
  await screen.findByText('Media could not be loaded. Please retry.');
  expect(screen.queryByText('No photos, video or recordings yet.')).toBeNull();
  fireEvent.click(button('Reload media')); await screen.findByText('No photos, video or recordings yet.');
});

it('does not let a stale initial list overwrite a just-completed upload', async () => {
  const gate = deferred<any>(); mocks.list.mockReturnValueOnce(gate.promise); panel();
  choose([new File(['a'], 'latest.png')]); await screen.findByText('Original saved');
  await act(async () => gate.resolve({ media: [], revision: 1 }));
  expect(screen.getAllByText('latest.png')).toHaveLength(2);
});

it('refreshes only active processing and stops polling after a terminal result is visible', async () => {
  let poll: (() => void) | undefined;
  const fakeTimer = 87654321 as unknown as ReturnType<typeof window.setInterval>;
  vi.spyOn(window, 'setInterval').mockImplementation(callback => { poll = callback as () => void; return fakeTimer; });
  const clear = vi.spyOn(window, 'clearInterval');
  rows = [media({ status: 'processing' })];
  const h = panel(); await screen.findByText('Extracting records'); expect(poll).toBeTypeOf('function');
  record = makeAvatar({ revision: 2, memoryCount: 1 }); rows = [media({ status: 'ready', materialId: 'material-a' })];
  await act(async () => poll?.());
  await screen.findByText('Records extracted');
  expect(h.updated).toHaveBeenCalledWith(record); expect(mocks.process).not.toHaveBeenCalled();
  expect(clear).toHaveBeenCalledWith(87654321);
});

it('does not lose the current portrait when a new selection fails and allows an explicit retry', async () => {
  rows = [media()]; record = makeAvatar({ presentation: { mode: 'portrait', mediaId: 'previous' } });
  mocks.update.mockRejectedValueOnce(new Error('disk failed'));
  const h = panel(); await screen.findByText('Synthetic photo'); fireEvent.click(button('Use as portrait'));
  await screen.findByText('This operation was not confirmed. Please retry.');
  expect(h.updated).not.toHaveBeenCalled(); expect(screen.queryByText('Portrait saved.')).toBeNull();
  fireEvent.click(button('Use as portrait')); await screen.findByText('Portrait saved.'); expect(h.updated).toHaveBeenCalledTimes(1);
});

it('ignores extraction arriving after switching people and aborts its request', async () => {
  rows = [media()]; const gate = deferred<any>(); mocks.process.mockReturnValueOnce(gate.promise);
  const updated = vi.fn();
  const view = render(<MemoryAvatarMediaPanel avatar={record} ownerId="owner-a" locale="en" onUpdated={updated} />);
  await screen.findByText('Synthetic photo'); fireEvent.click(button('Organize as memories'));
  await waitFor(() => expect(mocks.process).toHaveBeenCalledTimes(1));
  const signal = mocks.process.mock.calls[0][3]; rows = [];
  view.rerender(<MemoryAvatarMediaPanel avatar={makeAvatar({ id: 'avatar-b' })} ownerId="owner-a" locale="en" onUpdated={updated} />);
  expect(signal.aborted).toBe(true);
  await act(async () => gate.resolve({ media: media({ status: 'ready', title: 'Old private result' }), avatar: makeAvatar({ revision: 2 }) }));
  expect(updated).not.toHaveBeenCalled(); expect(screen.queryByText('Old private result')).toBeNull();
});

it('reloads the revision after a conflict before retrying the same queued upload', async () => {
  mocks.upload.mockRejectedValueOnce(new MemoryAvatarApiError(409, 'conflict', 'changed'));
  panel(); await act(async () => {}); choose([new File(['a'], 'retry.png')]);
  await screen.findByText('The records changed elsewhere. Reload before retrying.');
  const requestId = mocks.upload.mock.calls[0][1].clientRequestId;
  record = makeAvatar({ revision: 4 }); fireEvent.click(button('Reload media'));
  await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('avatar-a', expect.any(AbortSignal)));
  await act(async () => {}); fireEvent.click(button('Retry'));
  await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
  expect(mocks.upload.mock.calls[1][1]).toMatchObject({ revision: 4, clientRequestId: requestId });
});
