// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatSongWorkbench from './ChatSongWorkbench';
import { CHAT_SONG_DEFAULT_BRIEF, type ChatSongProject } from '../../shared/chat_song';
const mock = vi.hoisted(() => ({ api: vi.fn(), save: vi.fn() }));
vi.mock('@/services/apiClient', () => ({ apiJson: (...args: any[]) => mock.api(...args), apiFetch: vi.fn() }));
vi.mock('@/services/fileResource', () => ({ saveFileResource: (...args: any[]) => mock.save(...args) }));
vi.mock('@/hooks/useFileResource', () => ({ useFileResource: () => ({ url: 'blob:test' }) }));
vi.mock('./FileResourceMedia', () => ({ FileResourceImage: (props: any) => <img {...props} />, FileResourceVideo: (props: any) => <video {...props} /> }));
const project: ChatSongProject = {
  id: '11111111-1111-4111-8111-111111111111', revision: 2, scriptRevision: 1, title: 'Episode', brief: { ...CHAT_SONG_DEFAULT_BRIEF },
  lines: [{ id: '01', role: 'A', text: 'Where?', group: 1, reaction: '' }, { id: '02', role: 'B', text: 'At home.', group: 1, reaction: '' }],
  scriptLocked: true, assets: [], song: null, timings: [], updatedAt: '2026-09-16T00:00:00Z',
};
const props = () => ({ locale: 'en' as const, files: [], busy: false, onRefreshLibrary: vi.fn(), onClose: vi.fn(), onGenerate: vi.fn(), onTask: vi.fn().mockResolvedValue(undefined) });
beforeEach(() => {
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
  fireEvent.click(screen.getByRole('button', { name: 'Back to video studio' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Disk unavailable');
  expect(screen.getByDisplayValue('My new episode')).toBeTruthy(); expect(p.onClose).not.toHaveBeenCalled();
});
it('reviews a draft before replacing dialogue, and saves only through the authenticated API client', async () => {
  const p = props(); render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  const implementation = mock.api.getMockImplementation()!;
  mock.api.mockImplementation(async (path: string, init?: RequestInit) => path.endsWith('/draft') ? { revision: 2, lines: [{ ...project.lines[0], text: 'New draft' }, project.lines[1]] } : implementation(path, init));
  fireEvent.click(screen.getByRole('button', { name: 'Draft with Lumi Official API' }));
  await screen.findByText('Review the AI draft before adopting and saving it.');
  expect(screen.getByDisplayValue('Where?')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Use draft' }));
  expect(screen.getByDisplayValue('New draft')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(mock.api.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
});
it('sends image creation into the existing pipeline with the official-only restriction', async () => {
  const p = props(); render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  fireEvent.click(screen.getByRole('tab', { name: 'Visual assets' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Generate with Official API' }));
  await waitFor(() => expect(p.onGenerate).toHaveBeenCalledWith(expect.objectContaining({ mode: 'image', officialOnly: true, prompt: 'A quiet room' })));
  expect(mock.api.mock.calls.some(([path]) => path.endsWith('/media-preflight'))).toBe(true);
});
it('keeps a failed task handoff open and never implies the film has been exported', async () => {
  const p = props(); render(<ChatSongWorkbench {...p} />); await screen.findByDisplayValue('Episode');
  const implementation = mock.api.getMockImplementation()!;
  mock.api.mockImplementation(async (path: string, init?: RequestInit) => path.endsWith('/export') ? { fileId: 'pack.zip', url: '/api/files/download/pack.zip', timed: false, warnings: [], handoffs: { music: 'Real task', edit: '' } } : implementation(path, init));
  fireEvent.click(screen.getByRole('tab', { name: 'Editing handoff' }));
  expect((screen.getByRole('button', { name: 'Ask Lumi to edit in Jianying (trial)' }) as HTMLButtonElement).disabled).toBe(true);
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
  fireEvent.click(screen.getByRole('tab', { name: 'Song & timing' }));
  const start = screen.getAllByRole('spinbutton')[0]; fireEvent.change(start, { target: { value: '1.5' } });
  expect((start as HTMLInputElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Back to video studio' }));
  await waitFor(() => expect(p.onClose).toHaveBeenCalled());
  const action = mock.api.mock.calls.find(([path]) => path.endsWith('/action'))!;
  expect(JSON.parse(String(action[1].body))).toMatchObject({ action: 'set-timings', value: [{ lineId: '01', start: 1.5, end: 3 }, { lineId: '02', start: 4, end: 6 }] });
});
