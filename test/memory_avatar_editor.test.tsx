// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_AVATAR_APPEARANCE, LUMI_COMPANION_APPEARANCE, type MemoryAvatar, type MemoryAvatarMaterial } from '../shared/memory_avatar';
const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), get: vi.fn(), materials: vi.fn(), addMaterial: vi.fn(), removeMaterial: vi.fn(), archive: vi.fn(), voices: vi.fn(), api: vi.fn() }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: mocks.api }));
vi.mock('../src/services/memoryAvatarService', async original => ({ ...await original<typeof import('../src/services/memoryAvatarService')>(), memoryAvatarService: mocks }));
vi.mock('../src/services/voiceService', () => ({ listVoices: mocks.voices }));
vi.mock('../src/components/MemoryAvatarPortraitSettings', () => ({ MemoryAvatarPortraitSettings: () => null }));
import { MemoryAvatarCreate } from '../src/components/MemoryAvatarCreate';
import { MemoryAvatarProfile } from '../src/components/MemoryAvatarProfile';
import { MemoryAvatarAnimationEditor } from '../src/components/MemoryAvatarAnimationEditor';
import { memoryAvatarMediaService } from '../src/services/memoryAvatarMediaService';
import { MemoryAvatarApiError } from '../src/services/memoryAvatarService';
const makeAvatar = (extra: Partial<MemoryAvatar> = {}): MemoryAvatar => ({
  id: 'avatar-a', name: 'Synthetic person', relationshipType: 'close_friend', status: 'active', revision: 1,
  narrative: 'A synthetic biography', appearance: { ...DEFAULT_MEMORY_AVATAR_APPEARANCE }, voice: {}, memoryCount: 0,
  isFrozen: true, personalityConfig: {}, evidenceMap: [], seedMemoryIds: [], createdAt: '2026-09-06', updatedAt: '2026-09-06', ...extra,
});
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let record: MemoryAvatar;
let sources: MemoryAvatarMaterial[];
beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset()); record = makeAvatar(); sources = [];
  mocks.get.mockImplementation(async () => record);
  mocks.materials.mockImplementation(async () => ({ materials: sources, revision: record.revision }));
  mocks.update.mockImplementation(async (_id, input) => { record = { ...record, ...input, revision: input.revision + 1 }; return record; });
  mocks.addMaterial.mockImplementation(async (_id, input) => {
    const material = { id: `material-${sources.length}`, title: input.title, text: input.text, kind: input.kind, createdAt: '2026-09-06', memoryCount: 1 };
    sources = [...sources, material]; record = { ...record, revision: input.revision + 1, memoryCount: sources.length };
    return { material, avatar: record };
  });
  mocks.removeMaterial.mockImplementation(async (_id, id, revision) => {
    sources = sources.filter(source => source.id !== id); record = { ...record, revision: revision + 1, memoryCount: sources.length };
    return { ok: true, avatar: record };
  });
  mocks.archive.mockResolvedValue({ ok: true });
  mocks.voices.mockResolvedValue({ premade: [{ voiceId: 'warm', name: 'Warm voice' }], cloned: [{ voiceId: 'ready', name: 'My ready voice', status: 'ready' }, { voiceId: 'training', name: 'Still training', status: 'training' }] });
});
afterEach(cleanup);
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function profile(extra: Partial<React.ComponentProps<typeof MemoryAvatarProfile>> = {}) {
  const updated = vi.fn(); const archived = vi.fn();
  function Harness() {
    const [avatar, setAvatar] = useState(record);
    return <MemoryAvatarProfile avatar={avatar} ownerId="owner-a" locale="en" onUpdated={next => { updated(next); setAvatar(next); }} onArchived={archived} onClose={vi.fn()} {...extra} />;
  }
  return { ...render(<Harness />), updated, archived };
}
async function loaded() { await act(async () => {}); }

it('offers the 2D character without the retired 3D option and replaces the old cloud portrait presentation', async () => {
  record = makeAvatar({ publicBrief: 'Approved company facts', presentation: { mode: 'portrait', mediaId: 'owned-photo' } });
  const preview = vi.fn(); profile({ onPreviewAppearance: preview }); await loaded();
  fireEvent.click(screen.getByRole('tab', { name: 'Appearance & voice' })); await loaded();
  expect(screen.queryByRole('button', { name: /Lumi · Custom 3D character/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Lumi · Relaxed conversation/ }));
  expect(preview).toHaveBeenCalledWith(expect.objectContaining({ style: 'lumi2d' }));
  expect(mocks.update).not.toHaveBeenCalled();
  fireEvent.click(button('Save details')); await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  expect(mocks.update.mock.calls[0][1]).toMatchObject({ appearance: { style: 'lumi2d' }, presentation: { mode: 'human3d' }, publicBrief: 'Approved company facts', narrative: record.narrative });
});

it('creates a blank person, and safely reuses the request ID after a failed attempt', async () => {
  const created = vi.fn(); mocks.create.mockRejectedValueOnce(new Error('save failed')).mockResolvedValueOnce(record);
  render(<MemoryAvatarCreate locale="en" ownerId="owner-a" onCreated={created} onImport={vi.fn()} onLogin={vi.fn()} />);
  change('Name', 'New companion'); fireEvent.click(button('Create and enter'));
  await screen.findByRole('alert'); expect(created).not.toHaveBeenCalled();
  expect(button('Create and enter').disabled).toBe(false);
  fireEvent.click(button('Create and enter')); await waitFor(() => expect(created).toHaveBeenCalledWith(record));
  expect(mocks.create.mock.calls[0][0]).toMatchObject({ name: 'New companion', narrative: '' });
  expect(mocks.create.mock.calls[0][0]).not.toHaveProperty('personalityConfig');
  expect(mocks.create.mock.calls[1][0].clientRequestId).toBe(mocks.create.mock.calls[0][0].clientRequestId);
});

it('ignores late creation from another owner and gives the new owner an empty, usable form', async () => {
  const gate = deferred<MemoryAvatar>(); mocks.create.mockReturnValueOnce(gate.promise).mockResolvedValue(record);
  const created = vi.fn(); const props = { locale: 'en' as const, onCreated: created, onImport: vi.fn(), onLogin: vi.fn() };
  const view = render(<MemoryAvatarCreate {...props} ownerId="owner-a" />);
  change('Name', 'Owner A'); fireEvent.click(button('Create and enter'));
  view.rerender(<MemoryAvatarCreate {...props} ownerId="owner-b" />);
  await act(async () => { gate.resolve(record); }); expect(created).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  change('Name', 'Owner B'); fireEvent.click(button('Create and enter')); await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
  expect(mocks.create.mock.calls[1][0].clientRequestId).not.toBe(mocks.create.mock.calls[0][0].clientRequestId);
});

it('adds, expands and explicitly removes a source using each freshly saved revision', async () => {
  profile(); await loaded(); fireEvent.click(screen.getByRole('tab', { name: 'Add memories' }));
  change('Source title', 'Trip'); change('Source text', 'The synthetic lake story.'); fireEvent.click(button('Add to memories'));
  await screen.findByText('This source was added to this person’s memories.');
  // The saved notice can render before the mutation releases its controls.
  await waitFor(() => expect(button('Trip').disabled).toBe(false));
  fireEvent.click(button('Trip')); await screen.findByText('The synthetic lake story.');
  fireEvent.click(button('Remove source')); expect(mocks.removeMaterial).not.toHaveBeenCalled();
  fireEvent.click(button('Click again to confirm removal')); await screen.findByText('This source was removed.');
  expect(mocks.removeMaterial).toHaveBeenCalledWith('avatar-a', 'material-0', 2);
  change('Source title', 'Next story'); change('Source text', 'Another source.');
  // Fill the required fields, then wait for the prior mutation to release
  // the form before submitting the next source.
  await waitFor(() => expect(button('Add to memories').disabled).toBe(false));
  fireEvent.click(button('Add to memories'));
  await screen.findByRole('button', { name: 'Next story' });
  expect(mocks.addMaterial.mock.calls[1][1].revision).toBe(3);
});

it('keeps the same material request ID after failure and never shows a saved notice for that failure', async () => {
  mocks.addMaterial.mockRejectedValueOnce(new MemoryAvatarApiError(503, 'save_failed', 'failed'));
  profile(); await loaded(); fireEvent.click(screen.getByRole('tab', { name: 'Add memories' }));
  change('Source title', 'Retried story'); change('Source text', 'Keep this exact source.'); fireEvent.click(button('Add to memories'));
  await screen.findByRole('alert'); expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(button('Add to memories')); await screen.findByRole('button', { name: 'Retried story' });
  expect(mocks.addMaterial.mock.calls[1][1].clientRequestId).toBe(mocks.addMaterial.mock.calls[0][1].clientRequestId);
});

it('requires reloading a conflict and then saves with the refreshed revision', async () => {
  mocks.update.mockRejectedValueOnce(new MemoryAvatarApiError(409, 'revision_conflict', 'changed'));
  profile(); await loaded(); change('Name', 'Unsaved edit'); fireEvent.click(button('Save details'));
  await screen.findByRole('alert'); expect(button('Save details').disabled).toBe(true); expect(screen.queryByRole('status')).toBeNull();
  record = makeAvatar({ revision: 5, name: 'Updated elsewhere' });
  fireEvent.click(button('Reload')); await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Updated elsewhere'));
  await waitFor(() => expect(button('Save details').disabled).toBe(false));
  change('Name', 'Fresh edit'); fireEvent.click(button('Save details'));
  await screen.findByRole('status'); expect(mocks.update.mock.calls[1][1].revision).toBe(5);
});

it('saves appearance and a configured voice, then remains editable after the parent publishes the new revision', async () => {
  const preview = vi.fn(); profile({ onPreviewAppearance: preview }); await loaded();
  fireEvent.click(screen.getByRole('tab', { name: 'Appearance & voice' }));
  await screen.findByRole('option', { name: 'My ready voice' }); expect(screen.queryByRole('option', { name: 'Still training' })).toBeNull();
  fireEvent.click(button('Soft')); change('Skin', '#abcdef'); change('Voice', 'ready');
  fireEvent.click(button('Save details')); await screen.findByRole('status');
  expect(mocks.update.mock.calls[0][1]).toMatchObject({ revision: 1, appearance: { preset: 'feminine', skinColor: '#abcdef' }, voice: { voiceId: 'ready' } });
  expect(preview).toHaveBeenLastCalledWith(null);
  await waitFor(() => expect(button('Save details').disabled).toBe(false));
  change('Voice', ''); fireEvent.click(button('Save details')); await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
  expect(mocks.update.mock.calls[1][1]).toMatchObject({ revision: 2, voice: { voiceId: '' } });
});

it('archives only after the explicit second click and waits for server confirmation', async () => {
  const gate = deferred<{ ok: true }>(); mocks.archive.mockReturnValueOnce(gate.promise);
  const h = profile(); await loaded(); fireEvent.click(button('Archive this person'));
  expect(mocks.archive).not.toHaveBeenCalled(); fireEvent.click(button('Click again to confirm archiving'));
  await waitFor(() => expect(mocks.archive).toHaveBeenCalledWith('avatar-a', 1)); expect(h.archived).not.toHaveBeenCalled();
  await act(async () => gate.resolve({ ok: true })); expect(h.archived).toHaveBeenCalledWith('avatar-a');
});

it('edits and persists public briefing separately from the private biography', async () => {
  profile(); await loaded();
  change('Public identity and briefing', 'Approved public identity');
  fireEvent.click(button('Save details')); await screen.findByRole('status');
  expect(mocks.update.mock.calls[0][1]).toMatchObject({ publicBrief: 'Approved public identity', narrative: 'A synthetic biography' });
  expect((screen.getByLabelText('Public identity and briefing') as HTMLTextAreaElement).value).toBe('Approved public identity');
});

it('previews and saves the local Lumi companion then can return to a human preset', async () => {
  const preview = vi.fn(); profile({ onPreviewAppearance: preview }); await loaded();
  fireEvent.click(screen.getByRole('tab', { name: 'Appearance & voice' }));
  fireEvent.click(screen.getByRole('button', { name: /Lumi · Original companion/ }));
  expect(preview).toHaveBeenLastCalledWith(LUMI_COMPANION_APPEARANCE);
  expect(screen.getByLabelText('Shell')).toBeTruthy(); expect(screen.getByLabelText('Visor')).toBeTruthy();
  fireEvent.click(button('Save details')); await screen.findByRole('status');
  expect(mocks.update.mock.calls[0][1].appearance).toEqual(LUMI_COMPANION_APPEARANCE);
  await waitFor(() => expect(button('Save details').disabled).toBe(false));
  fireEvent.click(button('Soft')); expect(preview).toHaveBeenLastCalledWith({ ...DEFAULT_MEMORY_AVATAR_APPEARANCE, preset: 'feminine' });
});

it('does not reuse old profile state or a late save after switching owner and avatar', async () => {
  const gate = deferred<MemoryAvatar>(); mocks.update.mockReturnValueOnce(gate.promise);
  const updated = vi.fn(); const props = { locale: 'en' as const, onUpdated: updated, onArchived: vi.fn(), onClose: vi.fn() };
  const view = render(<MemoryAvatarProfile {...props} ownerId="owner-a" avatar={record} />); await loaded();
  fireEvent.click(button('Save details')); await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
  const next = makeAvatar({ id: 'avatar-b', name: 'Owner B person' }); record = next;
  view.rerender(<MemoryAvatarProfile {...props} ownerId="owner-b" avatar={next} />); await loaded();
  await act(async () => gate.resolve(makeAvatar({ revision: 2, name: 'Late old response' })));
  expect(updated).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Owner B person');
  expect(button('Save details').disabled).toBe(false);
});

it('does not get permanently busy when the parent refreshes the revision during a pending save', async () => {
  const gate = deferred<MemoryAvatar>(); mocks.update.mockReturnValueOnce(gate.promise);
  const updated = vi.fn(); const props = { locale: 'en' as const, ownerId: 'owner-a', onUpdated: updated, onArchived: vi.fn(), onClose: vi.fn() };
  const view = render(<MemoryAvatarProfile {...props} avatar={record} />); await loaded();
  fireEvent.click(button('Save details')); await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
  record = makeAvatar({ revision: 3, name: 'Newer profile' }); view.rerender(<MemoryAvatarProfile {...props} avatar={record} />); await loaded();
  await act(async () => gate.resolve(makeAvatar({ revision: 2, name: 'Older response' })));
  expect(updated).not.toHaveBeenCalled();
  expect(button('Save details').disabled).toBe(false);
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Newer profile');
});

it('shows an initial materials loading failure and offers a real reload without claiming the empty list is authoritative', async () => {
  mocks.materials.mockRejectedValueOnce(new Error('read failed'));
  profile(); await screen.findByRole('alert'); expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Add memories' }));
  expect(screen.queryByText('No additional sources yet. A new story can begin here.')).toBeNull();
  fireEvent.click(button('Reload')); await waitFor(() => expect(mocks.get).toHaveBeenCalled());
  await screen.findByText('No additional sources yet. A new story can begin here.');
});

it('rejects malformed successful transport responses instead of manufacturing a saved record', async () => {
  const { memoryAvatarService: realService } = await vi.importActual<typeof import('../src/services/memoryAvatarService')>('../src/services/memoryAvatarService');
  mocks.api.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('invalid JSON'); } });
  await expect(realService.create({ name: 'Not confirmed', clientRequestId: 'request' })).rejects.toThrow();
  mocks.api.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
  await expect(realService.update('avatar-a', { revision: 1, name: 'Not confirmed' })).rejects.toThrow();
});

it('can leave local animation by selecting the same built-in appearance and saving', async () => {
  record = makeAvatar({ presentation: { mode: 'localportrait', mediaId: 'idle', animation: { idleMediaId: 'idle', blinkInterval: 5, breathing: .4, backgroundMotion: true } } });
  profile(); await loaded();
  fireEvent.click(screen.getByRole('tab', { name: 'Appearance & voice' }));
  fireEvent.click(button('Natural'));
  fireEvent.click(button('Save details'));
  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  expect(mocks.update.mock.calls[0][1].presentation).toEqual({ mode: 'human3d' });
});

it('saves frame choices using the current revision and releases the mutation when closed', async () => {
  const list = vi.spyOn(memoryAvatarMediaService, 'list').mockResolvedValue({ revision: 1, media: [
    { id: 'idle', title: 'Neutral image', kind: 'image', hasThumbnail: true },
    { id: 'blink', title: 'Closed-eye image', kind: 'image', hasThumbnail: true },
    { id: 'speech', title: 'Open-mouth image', kind: 'image', hasThumbnail: true },
  ] as any });
  const before = vi.fn(), updated = vi.fn(), busy = vi.fn();
  const gate = deferred<MemoryAvatar>(); mocks.update.mockReturnValueOnce(gate.promise);
  const view = render(<MemoryAvatarAnimationEditor avatar={record} locale="en" disabled={false} onBeforeMutation={before} onBusyChange={busy} onUpdated={updated} />);
  await screen.findAllByRole('option', { name: 'Neutral image' });
  change('Neutral expression', 'idle'); change('Eyes closed', 'blink'); change('Mouth open', 'speech');
  fireEvent.click(button('Save and use local animation'));
  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  expect(before).toHaveBeenCalledTimes(1);
  expect(mocks.update.mock.calls[0][1]).toMatchObject({ revision: 1, presentation: { mode: 'localportrait', animation: { idleMediaId: 'idle', blinkMediaId: 'blink', speakMediaId: 'speech' } } });
  const signal = mocks.update.mock.calls[0][2] as AbortSignal;
  view.unmount(); expect(signal.aborted).toBe(true); expect(busy).toHaveBeenLastCalledWith(false);
  await act(async () => gate.resolve(makeAvatar({ revision: 2 })));
  expect(updated).not.toHaveBeenCalled(); list.mockRestore();
});
