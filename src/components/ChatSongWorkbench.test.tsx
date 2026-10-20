// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ChatSongWorkbench, { type ChatSongWorkbenchHandle } from './ChatSongWorkbench';
import { ChatSongPreview } from './ChatSongPreview';
import { CHAT_SONG_DEFAULT_BRIEF, type ChatSongProject, type ChatSongReactionCandidate, type ChatSongReactionSearch } from '../../shared/chat_song';
import { chatSongStripLayout } from '../../shared/chat_song_layout';
const mock = vi.hoisted(() => ({ api: vi.fn(), save: vi.fn(), upload: vi.fn() }));
vi.mock('@/services/apiClient', () => ({ apiJson: (...args: any[]) => mock.api(...args), apiFetch: (...args: any[]) => mock.upload(...args) }));
vi.mock('@/services/fileResource', async original => ({ ...await original<typeof import('@/services/fileResource')>(), saveFileResource: (...args: any[]) => mock.save(...args) }));
vi.mock('@/hooks/useFileResource', () => ({ useFileResource: (url: string) => ({ url: 'blob:' + url }) }));
vi.mock('./FileResourceMedia', () => ({ FileResourceImage: (props: any) => <img {...props} />, FileResourceVideo: (props: any) => <video {...props} /> }));
const project: ChatSongProject = {
  id: '11111111-1111-4111-8111-111111111111', revision: 2, scriptRevision: 1, title: 'Episode', brief: { ...CHAT_SONG_DEFAULT_BRIEF },
  lines: [{ id: '01', role: 'A', text: 'Where?', group: 1, reaction: '' }, { id: '02', role: 'B', text: 'At home.', group: 1, reaction: '' }],
  scriptLocked: true, assets: [], song: null, timings: [], updatedAt: '2026-09-16T00:00:00Z',
};
const props = () => ({ locale: 'en' as const, files: [], busy: false, onRefreshLibrary: vi.fn(), onClose: vi.fn(), onGenerate: vi.fn(), onTask: vi.fn().mockResolvedValue(undefined) });
const reactionCandidate = (id: string): ChatSongReactionCandidate => ({ id, lineId: '01', title: id, query: '惊讶', sourceUrl: `https://example.com/memes/${id}`, imageUrl: `https://images.example.com/${id}.png`, previewUrl: `/api/creative/chat-songs/${project.id}/reactions/${id}/preview`, width: 128, height: 128, sha256: 'a'.repeat(64) });
function chooseVideoFormat(name: RegExp) {
  fireEvent.click(screen.getByRole('tab', { name: '1 · Dialogue & style' }));
  fireEvent.click(screen.getByRole('radio', { name }));
  fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' }));
}
beforeEach(() => {
  mock.upload.mockReset();
  mock.api.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/handoff')) return { lyrics: 'Where?\nAt home.', singing: 'Sing exactly.', prompts: [{ kind: 'background', lineId: '', prompt: 'A quiet room' }] };
    if (!init) return { projects: [structuredClone(project)] };
    if (init.method === 'PATCH') { const body = JSON.parse(String(init.body)); return { ...project, ...body.project, revision: 3 }; }
    return { projects: [structuredClone(project)] };
  });
});
afterEach(cleanup);
it('preserves unsaved text and keeps the workbench open after a failed save', async () => {
  const p = props(); render(<ChatSongWorkbench {...p} />);
  await screen.findByDisplayValue('Episode');
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'My new episode' } });
  mock.api.mockImplementation(async (_path: string, init?: RequestInit) => { if (init?.method === 'PATCH') throw new Error('Disk unavailable'); return {}; });
  fireEvent.click(screen.getByRole('button', { name: 'Back to AI Creation' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Disk unavailable');
  expect(screen.getByDisplayValue('My new episode')).toBeTruthy(); expect(p.onClose).not.toHaveBeenCalled();
});
it('reviews a draft before atomically saving dialogue through the authenticated API client', async () => {
  const p = props(); render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  const implementation = mock.api.getMockImplementation()!;
  const lines = [{ ...project.lines[0], text: 'New draft' }, project.lines[1]];
  mock.api.mockImplementation(async (path: string, init?: RequestInit) => path.endsWith('/draft') ? { revision: 2, lines, reactions: [] } : path.endsWith('/action') ? { ...project, lines, revision: 3 } : implementation(path, init));
  fireEvent.click(screen.getByRole('button', { name: 'Draft with Lumi Official API' }));
  await screen.findByText('Review the AI draft before adopting and saving it.');
  expect(screen.getByDisplayValue('Where?')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Use draft' }));
  await screen.findByDisplayValue('New draft');
  const save = mock.api.mock.calls.find(([path]) => path.endsWith('/action'))!;
  expect(JSON.parse(String(save[1].body))).toEqual({ revision: 2, action: 'save', value: { title: project.title, brief: project.brief, lines: lines.map(({ id: _id, ...line }) => line), reactions: [] } });
  expect(mock.api.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  expect(p.onRefreshLibrary).toHaveBeenCalled();
});
it('previews prepared web memes, selects a different candidate and adopts it with the draft in one save', async () => {
  const p = props(), candidates = [reactionCandidate('Surprised one'), reactionCandidate('Surprised two')];
  const lines = [{ ...project.lines[0], text: 'A new line', reaction: '惊讶' }, { ...project.lines[1], reaction: '无奈' }];
  const reactions: ChatSongReactionSearch[] = [{ lineId: '01', query: '惊讶', status: 'matched', candidates }, { lineId: '02', query: '无奈', status: 'no_match', candidates: [] }];
  const implementation = mock.api.getMockImplementation()!;
  mock.api.mockImplementation(async (path: string, init?: RequestInit) => path.endsWith('/draft') ? { revision: 2, lines, reactions } : path.endsWith('/action') ? { ...project, lines, revision: 3 } : implementation(path, init));
  render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  fireEvent.click(screen.getByRole('button', { name: 'Draft with Lumi Official API' }));
  const first = await screen.findByRole('radio', { name: 'Surprised one' });
  expect((first as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole('img', { name: 'Surprised one' }).getAttribute('src')).toBe(candidates[0].previewUrl);
  expect(screen.getByRole('link', { name: 'Source · Surprised one' }).getAttribute('href')).toBe(candidates[0].sourceUrl);
  expect(document.querySelector(`img[src="${candidates[0].imageUrl}"]`)).toBeNull();
  expect(screen.getByText('No matching meme found. Upload your own image or continue without one.')).toBeTruthy();
  expect(screen.getByDisplayValue('Where?')).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: 'Surprised two' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use draft' })); await screen.findByDisplayValue('A new line');
  const writes = mock.api.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes.map(([path]) => path.split('/').at(-1))).toEqual(['draft', 'action']);
  expect(JSON.parse(String(writes[1][1].body))).toEqual({ revision: 2, action: 'save', value: { title: project.title, brief: project.brief, lines: lines.map(({ id: _id, ...line }) => line), reactions: [{ lineId: '01', candidateId: candidates[1].id }] } });
  expect(mock.api.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  expect(p.onGenerate).not.toHaveBeenCalled(); expect(p.onTask).not.toHaveBeenCalled();
});
it('lets the owner skip a prepared meme and keeps a failed atomic adoption available to retry', async () => {
  const candidate = reactionCandidate('Surprised'), p = props();
  const implementation = mock.api.getMockImplementation()!;
  mock.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/draft')) return { revision: 2, lines: project.lines, reactions: [{ lineId: '01', query: '惊讶', status: 'matched', candidates: [candidate] }] };
    if (path.endsWith('/action')) throw new Error('Candidates expired; search again');
    return implementation(path, init);
  });
  render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  fireEvent.click(screen.getByRole('button', { name: 'Draft with Lumi Official API' }));
  fireEvent.click(await screen.findByRole('radio', { name: 'Do not use a meme' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use draft' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Candidates expired; search again');
  expect((screen.getByRole('radio', { name: 'Do not use a meme' }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole('button', { name: 'Use draft' })).toBeTruthy();
  expect(JSON.parse(String(mock.api.mock.calls.find(([path]) => path.endsWith('/action'))![1].body)).value.reactions).toEqual([]);
  expect(mock.api.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false); expect(p.onGenerate).not.toHaveBeenCalled();
});
it.each([
  ['privacy_blocked', 'Privacy settings prevent sending reaction keywords. Upload your own image instead.'],
  ['skipped', 'Character animation does not search for memes.'],
  ['unavailable', 'Meme search is unavailable. Retry or upload your own image.'],
  ['empty', 'No reaction keywords. Add a reaction suggestion or upload an image.'],
] as const)('shows the real %s draft search status without inventing a candidate', async (status, message) => {
  const implementation = mock.api.getMockImplementation()!;
  mock.api.mockImplementation(async (path: string, init?: RequestInit) => path.endsWith('/draft') ? { revision: 2, lines: [project.lines[0]], reactions: [{ lineId: '01', query: '', status, candidates: [] }] } : implementation(path, init));
  const p = props(); render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  fireEvent.click(screen.getByRole('button', { name: 'Draft with Lumi Official API' }));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.queryByRole('img')).toBeNull(); expect(p.onGenerate).not.toHaveBeenCalled();
});
it('searches and adopts a web meme in the reaction slot while keeping other image slots and uploads available', async () => {
  const p = props(), candidates = [reactionCandidate('Meme first'), reactionCandidate('Meme second')];
  const current = { ...project, lines: [{ ...project.lines[0], reaction: '惊讶' }, project.lines[1]] };
  const implementation = mock.api.getMockImplementation()!;
  mock.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/reactions/search')) return { revision: 2, reactions: [{ lineId: '01', query: '惊讶', status: 'matched', candidates }] };
    if (path.endsWith('/action')) return { ...current, revision: 3, assets: [{ id: 'meme', kind: 'reaction', lineId: '01', fileId: 'meme.png', name: 'Meme second', sha256: 'sha', reactionSource: { title: 'Meme second', query: '惊讶', sourceUrl: candidates[1].sourceUrl, imageUrl: candidates[1].imageUrl, sha256: candidates[1].sha256 } }] };
    if (path === '/api/creative/chat-songs') return { projects: [current] };
    return implementation(path, init);
  });
  render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' }));
  const slot = within(screen.getByRole('heading', { name: 'Reaction image · 01' }).closest('article')!);
  expect(slot.queryByRole('button', { name: 'Generate image (Lumi Official API)' })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Generate image (Lumi Official API)' })).toHaveLength(3);
  expect(slot.getByLabelText('Upload and use · Reaction image · 01')).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name: 'Search matching memes' }));
  await waitFor(() => expect((slot.getByRole('radio', { name: 'Meme first' }) as HTMLInputElement).checked).toBe(true));
  fireEvent.click(slot.getByRole('radio', { name: 'Meme second' }));
  fireEvent.click(slot.getByRole('button', { name: 'Use selected meme' }));
  await slot.findByText('Selected · Meme second');
  expect(JSON.parse(String(mock.api.mock.calls.find(([path]) => path.endsWith('/reactions/search'))![1].body))).toEqual({ revision: 2 });
  expect(JSON.parse(String(mock.api.mock.calls.find(([path]) => path.endsWith('/action'))![1].body))).toEqual({ revision: 2, action: 'attach-asset', value: { kind: 'reaction', lineId: '01', candidateId: candidates[1].id } });
  expect(slot.getByRole('link', { name: 'Source · Meme second' }).getAttribute('href')).toBe(candidates[1].sourceUrl);
  expect(mock.api.mock.calls.some(([path]) => path.endsWith('/media-preflight'))).toBe(false);
  expect(p.onGenerate).not.toHaveBeenCalled(); expect(p.onTask).not.toHaveBeenCalled(); expect(mock.upload).not.toHaveBeenCalled();
});
it('sends image creation into the existing pipeline with the official-only restriction', async () => {
  const p = props(); render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' }));
  fireEvent.click(await screen.findAllByRole('button', { name: 'Generate image (Lumi Official API)' }).then(items => items[0]));
  await waitFor(() => expect(p.onGenerate).toHaveBeenCalledWith(expect.objectContaining({ mode: 'image', officialOnly: true, prompt: 'A quiet room' })));
  expect(mock.api.mock.calls.some(([path]) => path.endsWith('/media-preflight'))).toBe(true);
});
it('keeps a failed task handoff open and never implies the film has been exported', async () => {
  const p = props(); render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  const implementation = mock.api.getMockImplementation()!;
  mock.api.mockImplementation(async (path: string, init?: RequestInit) => path.endsWith('/export') ? { fileId: 'pack.zip', url: '/api/files/download/pack.zip', timed: false, warnings: [], handoffs: { music: 'Real task', edit: '' } } : implementation(path, init));
  fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' }));
  expect((screen.getByRole('button', { name: 'Compose & export with Lumi' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('tab', { name: '2 · Generate song' }));
  fireEvent.click(screen.getByRole('button', { name: 'Ask Lumi to make the song (trial)' }));
  expect((await screen.findByRole('alert')).textContent).toContain('No task created'); expect(p.onClose).not.toHaveBeenCalled(); expect(p.onTask).toHaveBeenCalledWith('Real task');
});
it('keeps timing inputs editable while dirty and saves them before closing', async () => {
  const timedProject = { ...project, song: { fileId: 'song.wav', name: 'song.wav', sha256: 'hash', duration: 10, scriptRevision: 1, confirmed: true }, timings: [{ lineId: '01', start: 1, end: 3 }, { lineId: '02', start: 4, end: 6 }] };
  mock.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/handoff')) return { lyrics: '', singing: '', prompts: [] };
    if (path.endsWith('/action')) return { ...timedProject, revision: 3, timings: JSON.parse(String(init?.body)).value };
    return { projects: [timedProject] };
  });
  const p = props(); render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' }));
  const start = screen.getAllByRole('spinbutton')[0]; fireEvent.change(start, { target: { value: '1.5' } });
  expect((start as HTMLInputElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Back to AI Creation' }));
  await waitFor(() => expect(p.onClose).toHaveBeenCalled());
  const action = mock.api.mock.calls.find(([path]) => path.endsWith('/action'))!;
  expect(JSON.parse(String(action[1].body))).toMatchObject({ action: 'set-timings', value: [{ lineId: '01', start: 1.5, end: 3 }, { lineId: '02', start: 4, end: 6 }] });
});
it('shows only the chosen production branch, without generating anything on selection or mount', async () => {
  const p = props(); render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  expect(screen.queryByLabelText('Music style')).toBeNull();
  expect(screen.getAllByRole('tab')).toHaveLength(3);
  expect(screen.getAllByRole('radio')).toHaveLength(2);
  fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' }));
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Generate video (Lumi Official API)' })).toBeNull();
  expect((await screen.findAllByRole('button', { name: 'Generate image (Lumi Official API)' }).then(items => items[0]) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '1 · Dialogue & style' }));
  expect(screen.getByRole('tab', { name: '1 · Dialogue & style' }).getAttribute('aria-selected')).toBe('true');
  expect((screen.getByRole('radio', { name: /^Chat records/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: /^Character animation/ }));
  fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' }));
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.getByRole('group', { name: 'Video format' }).textContent).toContain('Character animation');
  expect(screen.queryByRole('button', { name: 'Generate image (Lumi Official API)' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Compose & export with Lumi' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Generate video (Lumi Official API)' }) as HTMLButtonElement).disabled).toBe(true);
  expect(p.onGenerate).not.toHaveBeenCalled(); expect(p.onTask).not.toHaveBeenCalled();
  expect(mock.api.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Select the song first' }));
  expect(screen.getByRole('tab', { name: '2 · Generate song' }).getAttribute('aria-selected')).toBe('true');
});
it('generates video for an unreviewed selected song without claiming a human check', async () => {
  const confirmed = { ...project, brief: { ...project.brief, outputStyle: 'animation' as const }, song: { fileId: 'song.wav', name: 'song.wav', sha256: 'hash', duration: 10, scriptRevision: 1, confirmed: false } };
  mock.api.mockImplementation(async (path: string) => {
    if (path.endsWith('/handoff')) return { lyrics: '', singing: '', prompts: [{ kind: 'clip', lineId: '01', prompt: 'Video for the first line' }] };
    return { projects: [confirmed] };
  });
  const p = props(); render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' }));
  fireEvent.click(screen.getByRole('button', { name: 'Generate video (Lumi Official API)' }));
  await waitFor(() => expect(p.onGenerate).toHaveBeenCalledWith(expect.objectContaining({ mode: 'video', operation: 'text_to_video', officialOnly: true, prompt: 'Video for the first line' })));
  expect(screen.queryByText('Lyrics reviewed by user')).toBeNull();
  expect(JSON.parse(mock.api.mock.calls.find(([p]) => p.endsWith('/media-preflight'))![1].body)).toEqual({ mode: 'video', revision: 2 });
});
it('composes locally, previews the verified result and refreshes the shared library without a Jianying task', async () => {
  const ready = { ...project, song: { fileId: 'song.wav', name: 'song.wav', sha256: 'hash', duration: 10, scriptRevision: 1, confirmed: false }, timings: [{ lineId: '01', start: 1, end: 3 }, { lineId: '02', start: 4, end: 6 }] };
  mock.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/handoff')) return { lyrics: '', singing: '', prompts: [] };
    if (path.endsWith('/render')) return { render: init?.method === 'POST' ? { fileId: 'finished.mp4', sha256: 'output-hash', sourceRevision: 2, warnings: [] } : null };
    return { projects: [ready] };
  });
  const p = props(); render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' }));
  fireEvent.click(screen.getByRole('button', { name: 'Compose & export with Lumi' }));
  await screen.findByRole('heading', { name: 'Finished video' });
  expect(mock.api.mock.calls.some(([,init])=>init?.body && String(init.body).includes('confirm-song'))).toBe(false);
  expect(p.onTask).not.toHaveBeenCalled(); expect(p.onRefreshLibrary).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Download MP4' }));
  await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.stringContaining('finished.mp4'), 'finished.mp4'));
});
it('protects unsaved work when the shared AI Creation shell is closed', async () => {
  const ref = React.createRef<ChatSongWorkbenchHandle>();
  render(<ChatSongWorkbench {...props()} embedded ref={ref} />);
  await screen.findByDisplayValue('Episode');
  expect(screen.queryByRole('button', { name: 'Back to AI Creation' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Keep my changes' } });
  const implementation = mock.api.getMockImplementation()!;
  mock.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') throw new Error('Disk unavailable');
    return implementation(path, init);
  });
  await act(async () => { expect(await ref.current!.prepareToLeave()).toBe(false); });
  expect(screen.getByRole('alert').textContent).toContain('Disk unavailable');
  expect(screen.getByDisplayValue('Keep my changes')).toBeTruthy();
  mock.api.mockImplementation(implementation);
  await act(async () => { expect(await ref.current!.prepareToLeave()).toBe(true); });
  expect(screen.queryByText('Unsaved changes')).toBeNull();
  expect(mock.api.mock.calls.some(([, init]) => init?.method === 'PATCH' && JSON.parse(String(init.body)).project.title === 'Keep my changes')).toBe(true);
});

it('offers native-audio video containers in the song picker without treating them as confirmed songs', async () => {
  const p = props();
  render(<ChatSongWorkbench {...p} files={[{ id: 'native.MP4', name: 'Native song video', type: 'video', size: 1 } as any]} />);
  await screen.findByDisplayValue('Episode');
  fireEvent.click(screen.getByRole('tab', { name: '2 · Generate song' }));
  expect(screen.getByRole('option', { name: 'Native song video' })).toBeTruthy();
  expect(Array.from(document.querySelectorAll<HTMLInputElement>('input[type=file]')).some(input => input.accept.includes('.mp4') && input.accept.includes('.wav'))).toBe(true);
  expect(mock.api.mock.calls.some(([url]) => String(url).includes('/action'))).toBe(false);
});


it('switches between two existing project versions and downloads the selected file without rendering', async () => {
  const ready = { ...project, song: { fileId: 'song.wav', name: 'song.wav', sha256: 'song-sha', duration: 10, scriptRevision: 1, confirmed: false } };
  const main = { fileId: 'main.mp4', sha256: 'main-sha', sourceRevision: 2, templateVersion: 1, duration: 10, width: 1080, height: 1440, createdAt: 'now', warnings: [] };
  const animation = { fileId: 'animation.mp4', sha256: 'animation-sha', sourceRevision: 2, scriptRevision: 1, songSha256: 'song-sha', duration: 10, createdAt: 'now' };
  mock.api.mockImplementation(async (path: string) => path.endsWith('/render') ? { render: main, animation } : path.endsWith('/handoff') ? { lyrics: '', singing: '', prompts: [] } : { projects: [ready] });
  const p = props(); render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode'); fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' }));
  await waitFor(() => expect(document.querySelector('video')?.getAttribute('src')).toContain('main.mp4'));
  expect(screen.getByRole('group', { name: 'Video format' }).compareDocumentPosition(screen.getByText('Time each sung line')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const writes = mock.api.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET').length;
  chooseVideoFormat(/^Character animation/);
  expect(document.querySelector('video')?.getAttribute('src')).toContain('animation.mp4');
  expect(document.querySelectorAll('video')).toHaveLength(1); expect(screen.queryByRole('radio')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Download MP4' }));
  await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.stringContaining('animation.mp4'), 'animation.mp4'));
  expect(mock.api.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET')).toHaveLength(writes); expect(p.onGenerate).not.toHaveBeenCalled(); expect(p.onTask).not.toHaveBeenCalled();
  chooseVideoFormat(/^Chat records/); expect(document.querySelector('video')?.getAttribute('src')).toContain('main.mp4'); expect(document.querySelectorAll('video')).toHaveLength(1);
  expect(ready.song.confirmed).toBe(false);
});

it('binds a library animation with the existing asset action and keeps the main render', async () => {
  const ready = { ...project, brief: { ...project.brief, outputStyle: 'animation' as const }, song: { fileId: 'song.wav', name: 'song.wav', sha256: 'song-sha', duration: 10, scriptRevision: 1, confirmed: false } };
  const main = { fileId: 'main.mp4', sha256: 'main-sha', sourceRevision: 2, templateVersion: 1, duration: 10, width: 1080, height: 1440, createdAt: 'now', warnings: [] };
  const animation = { fileId: 'animation.mp4', sha256: 'animation-sha', sourceRevision: 2, scriptRevision: 1, songSha256: 'song-sha', duration: 10, createdAt: 'now' };
  let bound = false;
  mock.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/render')) return { render: main, animation: bound ? animation : null };
    if (path.endsWith('/action')) { expect(JSON.parse(String(init?.body))).toEqual({ revision: 2, action: 'attach-asset', value: { kind: 'animation', fileId: 'animation.mp4' } }); bound = true; return ready; }
    if (path.endsWith('/handoff')) return { lyrics: '', singing: '', prompts: [] };
    return { projects: [ready] };
  });
  const p = props(); render(<ChatSongWorkbench {...p} files={[{ id: 'animation.mp4', name: 'Animation V5' } as any]} />); await screen.findByDisplayValue('Episode');
  fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' }));
  expect(await screen.findByText('No animation video is bound.')).toBeTruthy(); fireEvent.change(screen.getByLabelText('Bind existing animation video'), { target: { value: 'animation.mp4' } }); fireEvent.click(screen.getByRole('button', { name: 'Bind existing animation video' }));
  await waitFor(() => expect(document.querySelector('video')?.getAttribute('src')).toContain('animation.mp4'));
  expect(mock.api.mock.calls.filter(([path, init]) => path.endsWith('/action') && init?.method === 'POST')).toHaveLength(1); expect(mock.api.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  expect(ready.revision).toBe(2); expect(ready.song.confirmed).toBe(false); expect(p.onGenerate).not.toHaveBeenCalled();
  chooseVideoFormat(/^Chat records/); expect(document.querySelector('video')?.getAttribute('src')).toContain('main.mp4');
});

it('labels a bound animation as historical after project or song changes without discarding it', async () => {
  const ready = { ...project, brief: { ...project.brief, outputStyle: 'animation' as const }, revision: 3, scriptRevision: 2, song: null };
  mock.api.mockImplementation(async (path: string) => path.endsWith('/render') ? { render: null, animation: { fileId: 'old.mp4', sha256: 'old-sha', sourceRevision: 2, scriptRevision: 1, songSha256: 'old-song', duration: 10, createdAt: 'now' } } : path.endsWith('/handoff') ? { lyrics: '', singing: '', prompts: [] } : { projects: [ready] });
  render(<ChatSongWorkbench {...props()} />); await screen.findByDisplayValue('Episode'); fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' }));
  expect(await screen.findByText('This animation was bound before project changes. Check it and bind the matching version again.')).toBeTruthy(); expect(document.querySelector('video')?.getAttribute('src')).toContain('old.mp4');
});

it('does not restore a previous project animation after its late response', async () => {
  const other = { ...project, id: '22222222-2222-4222-8222-222222222222', title: 'Other episode' };
  let resolveFirst!: (value: unknown) => void;
  mock.api.mockImplementation(async (path: string) => {
    if (path.endsWith(project.id + '/render')) return new Promise(resolve => { resolveFirst = resolve; });
    if (path.endsWith(other.id + '/render')) return { render: null, animation: { fileId: 'other.mp4', sha256: 'other-sha', sourceRevision: 2, scriptRevision: 1, songSha256: '', duration: 10, createdAt: 'now' } };
    if (path.endsWith('/handoff')) return { lyrics: '', singing: '', prompts: [] };
    if (path.endsWith(other.id)) return other;
    return { projects: [project, other] };
  });
  render(<ChatSongWorkbench {...props()} />); await screen.findByDisplayValue('Episode'); await waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: /Other episode/ })); await screen.findByDisplayValue('Other episode'); chooseVideoFormat(/^Character animation/);
  await waitFor(() => expect(document.querySelector('video')?.getAttribute('src')).toContain('other.mp4'));
  await act(async () => { resolveFirst({ render: null, animation: { fileId: 'late-first.mp4', sha256: 'late', sourceRevision: 2, scriptRevision: 1, songSha256: '', duration: 10, createdAt: 'now' } }); });
  expect(document.querySelector('video')?.getAttribute('src')).toContain('other.mp4');
});


it('does not overwrite a newly bound animation with a late initial output lookup', async () => {
  const ready = { ...project, brief: { ...project.brief, outputStyle: 'animation' as const }, song: { fileId: 'song.wav', name: 'song.wav', sha256: 'song-sha', duration: 10, scriptRevision: 1, confirmed: false } };
  const animation = { fileId: 'animation.mp4', sha256: 'bound-sha', sourceRevision: 2, scriptRevision: 1, songSha256: 'song-sha', duration: 10, createdAt: 'now' };
  let resolveInitial!: (value: unknown) => void, lookups = 0;
  mock.api.mockImplementation(async (path: string) => {
    if (path.endsWith('/render')) { if (++lookups === 1) return new Promise(resolve => { resolveInitial = resolve; }); return { render: null, animation }; }
    if (path.endsWith('/action')) return ready;
    if (path.endsWith('/handoff')) return { lyrics: '', singing: '', prompts: [] };
    return { projects: [ready] };
  });
  render(<ChatSongWorkbench {...props()} files={[{ id: 'animation.mp4', name: 'Animation' } as any]} />); await screen.findByDisplayValue('Episode'); await waitFor(() => expect(resolveInitial).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' })); fireEvent.change(screen.getByLabelText('Bind existing animation video'), { target: { value: 'animation.mp4' } }); fireEvent.click(screen.getByRole('button', { name: 'Bind existing animation video' }));
  await waitFor(() => expect(document.querySelector('video')?.getAttribute('src')).toContain('animation.mp4'));
  await act(async () => { resolveInitial({ render: null, animation: null }); }); expect(document.querySelector('video')?.getAttribute('src')).toContain('animation.mp4');
});


it('saves custom nicknames and layout, then uploads a background directly into its slot without generating media', async () => {
  let current = structuredClone(project);
  mock.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/handoff')) return { lyrics: '', singing: '', prompts: [{ kind: 'background', lineId: '', prompt: 'Room' }] };
    if (path.endsWith('/render')) return { render: null, animation: null };
    if (init?.method === 'PATCH') { const body = JSON.parse(String(init.body)); current = { ...current, ...body.project, lines: body.project.lines.map((line: object, index: number) => ({ ...line, id: current.lines[index].id })), revision: 3 }; return current; }
    if (path.endsWith('/action')) { const body = JSON.parse(String(init?.body)); expect(body).toEqual({ revision: 3, action: 'attach-asset', value: { kind: 'background', lineId: '', fileId: 'my-room.png' } }); return { ...current, revision: 4, assets: [{ id: 'wallpaper', kind: 'background', lineId: '', fileId: 'my-room.png', name: 'My room', sha256: 'sha' }] }; }
    return { projects: [current] };
  });
  mock.upload.mockResolvedValue({ ok: true, json: async () => ({ success: true, files: [{ id: 'my-room.png', name: 'My room' }] }) });
  const p = props(); render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' }));
  fireEvent.change(screen.getByLabelText('Right nickname'), { target: { value: '小林' } });
  fireEvent.change(screen.getByLabelText('Left nickname'), { target: { value: '张律师' } });
  fireEvent.change(screen.getByLabelText('Message appearance'), { target: { value: 'conversation' } });
  fireEvent.change(screen.getByLabelText('Upload and use · Background'), { target: { files: [new File(['image'], 'my-room.png', { type: 'image/png' })] } });
  await waitFor(() => expect(mock.api.mock.calls.some(([path]) => path.endsWith('/action'))).toBe(true));
  await screen.findByText('Selected · My room');
  expect(current.brief).toMatchObject({ displayNameA: '小林', displayNameB: '张律师', messageLayout: 'conversation' });
  expect(current.brief.roleA).toBe(project.brief.roleA); expect(current.brief.roleB).toBe(project.brief.roleB);
  expect(mock.upload.mock.calls[0][1].body.get('purpose')).toBe('media_source');
  expect(mock.upload).toHaveBeenCalledTimes(1); expect(p.onGenerate).not.toHaveBeenCalled(); expect(p.onTask).not.toHaveBeenCalled();
  expect(p.onRefreshLibrary).toHaveBeenCalled();
});

it('previews one message by default and shows the conversation only when explicitly selected', async () => {
  const current = { ...project, brief: { ...project.brief, displayNameA: '张律师', displayNameB: '林女士' } };
  mock.api.mockImplementation(async (path: string) => path.endsWith('/handoff') ? { lyrics: '', singing: '', prompts: [] } : path.endsWith('/render') ? { render: null, animation: null } : { projects: [current] });
  render(<ChatSongWorkbench {...props()} />); await screen.findByDisplayValue('Episode');
  fireEvent.click(screen.getByRole('tab', { name: '3 · Create & export video' }));
  const preview = document.querySelector('svg[viewBox="0 0 1080 1440"]')!;
  expect(preview.textContent).toContain('张律师'); expect(preview.textContent).toContain('Where?');
  expect(preview.textContent).not.toContain('林女士'); expect(preview.textContent).not.toContain('At home.');
  expect(preview.querySelector('rect[fill="#f7f7f7"]')).toBeTruthy();
  expect(preview.querySelector('rect[fill="#95ec69"]')).toBeTruthy();
  expect(preview.querySelector('rect[fill="#ededed"]')).toBeNull();
  fireEvent.change(screen.getByLabelText('Message appearance'), { target: { value: 'conversation' } });
  expect(preview.textContent).toContain('林女士'); expect(preview.textContent).toContain('张律师'); expect(preview.textContent).toContain('At home.');
  expect(preview.querySelector('rect[fill="#ededed"]')).toBeTruthy();
});

it('previews tight per-message screenshots with the lawyer on the right and each avatar bound to its own role', () => {
  const current: ChatSongProject = {
    ...project,
    brief: { ...project.brief, roleA: '男律师', roleB: '女客户', displayNameA: '张律师', displayNameB: '林女士', messageLayout: 'conversation' },
    assets: [
      { id: 'bg', kind: 'background', lineId: '', fileId: 'wallpaper.png', name: 'Wallpaper', sha256: 'bg-sha' },
      { id: 'a', kind: 'avatarA', lineId: '', fileId: 'lawyer.png', name: 'Lawyer', sha256: 'lawyer-sha' },
      { id: 'b', kind: 'avatarB', lineId: '', fileId: 'customer.png', name: 'Customer', sha256: 'customer-sha' },
    ],
  };
  const { container, rerender } = render(<ChatSongPreview project={current} lines={current.lines} />);
  const svg = container.querySelector('svg')!;
  expect(Array.from(svg.children).some(child => child.tagName === 'rect' && child.getAttribute('fill') === '#f7f7f7')).toBe(false);
  const lawyerName = screen.getByText('张律师'), customerName = screen.getByText('林女士');
  const lawyer = lawyerName.parentElement!, customer = customerName.parentElement!;
  for (const [name, anchor] of [[lawyerName, 'end'], [customerName, 'start']] as const) {
    expect(name.getAttribute('text-anchor')).toBe(anchor);
    expect(name.getAttribute('fill')).toBe('#8c8c8c');
    expect(name.hasAttribute('stroke')).toBe(false);
    expect(name.hasAttribute('paint-order')).toBe(false);
  }
  expect(lawyer.querySelector('rect[fill="#95ec69"]')).toBeTruthy();
  expect(customer.querySelector('rect[fill="#ededed"]')).toBeTruthy();
  expect(lawyer.querySelector('image')?.getAttribute('href')).toContain('lawyer.png');
  expect(customer.querySelector('image')?.getAttribute('href')).toContain('customer.png');
  expect(lawyer.querySelector('image')?.getAttribute('x')).toBe('952');
  expect(customer.querySelector('image')?.getAttribute('x')).toBe('28');
  for (const [message, direction, line, name] of [[lawyer, 1, current.lines[0], '张律师'], [customer, -1, current.lines[1], '林女士']] as const) {
    const screenshot = message.querySelector('rect[fill="#f7f7f7"]')!;
    const strip = chatSongStripLayout(line, name);
    expect(screenshot.getAttribute('y')).toBe('0');
    expect(Number(screenshot.getAttribute('height'))).toBe(strip.height);
    expect(Number(screenshot.getAttribute('width'))).toBe(strip.screenshot.width);
    expect(Number(screenshot.getAttribute('width'))).toBeLessThan(1080);
    expect(Number(screenshot.getAttribute('x'))).toBe(strip.screenshot.left);
    const tail = message.querySelector('polygon')!.getAttribute('points')!.split(' ').map(point => Number(point.split(',')[0]));
    expect(tail[1] - tail[0]).toBe(direction * 12);
    expect(message.querySelector('animate')).toBeNull();
  }
  rerender(<ChatSongPreview project={current} lines={[]} />);
  expect(svg.querySelector('rect[fill="#f7f7f7"]')).toBeNull();
  expect(mock.api).not.toHaveBeenCalled(); expect(mock.upload).not.toHaveBeenCalled();
});
