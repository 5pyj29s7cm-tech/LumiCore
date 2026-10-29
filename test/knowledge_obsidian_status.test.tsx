// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const notices = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast: notices }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => null }));
vi.mock('../src/components/MemoryTree', () => ({
  MemoryTreeScene: () => null,
  layoutTree3D: () => ({ nodes: [], curves: [] }),
}));
vi.mock('../src/components/NodeDetailPanel', () => ({ NodeDetailPanel: () => null }));
import { KnowledgeBase } from '../src/components/KnowledgeBase';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let readStatus: () => Promise<Response>;
beforeEach(() => {
  readStatus = async () => reply({ success: true, vaults: [] });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/obsidian/status')
    ? readStatus()
    : reply({ files: [], tree: [], vaults: [] })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function openObsidian() {
  render(<KnowledgeBase isOpen t={{ langCode: 'en' }} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect Obsidian vault' }));
}

it.each(['http', 'network', 'invalid-json', 'missing-vaults'] as const)('shows an initial %s status failure rather than claiming no connected vaults', async failure => {
  readStatus = async () => {
    if (failure === 'network') throw new Error('Synthetic network failure');
    if (failure === 'invalid-json') return new Response('{invalid json');
    return failure === 'http' ? reply({ error: 'Synthetic failure' }, 503) : reply({ success: true });
  };
  openObsidian();
  expect((await screen.findByRole('alert')).textContent).toContain('Obsidian status failed to load');
  expect(screen.queryByText('No Obsidian vault connected yet')).toBeNull();
  expect(notices.error).not.toHaveBeenCalled();
});

it('retains the previous vaults with a stale warning on refresh failure, then replaces them and clears the warning on recovery', async () => {
  const vault = (name: string) => ({ id: name, name, path: `D:/synthetic/${name}`, exists: true, isObsidianVault: true });
  readStatus = async () => reply({ success: true, vaults: [vault('Previous synthetic vault')] });
  openObsidian();
  expect(await screen.findByText('Previous synthetic vault')).toBeTruthy();
  readStatus = async () => reply({ error: 'Synthetic refresh failure' }, 500);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Obsidian status failed to load');
  expect(screen.getByText('Previous synthetic vault')).toBeTruthy();
  expect(screen.getByText('Showing the previous Obsidian status; it may be out of date.')).toBeTruthy();
  expect(screen.queryByText('No Obsidian vault connected yet')).toBeNull();
  readStatus = async () => reply({ success: true, vaults: [vault('Current synthetic vault')] });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  expect(await screen.findByText('Current synthetic vault')).toBeTruthy();
  expect(screen.queryByText('Previous synthetic vault')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('Showing the previous Obsidian status; it may be out of date.')).toBeNull();
});

it('shows loading instead of a false empty state and shows empty only after a successful response', async () => {
  let finish!: (response: Response) => void;
  readStatus = () => new Promise<Response>(resolve => { finish = resolve; });
  openObsidian();
  expect(screen.getByRole('status').textContent).toContain('Loading');
  expect(screen.queryByText('No Obsidian vault connected yet')).toBeNull();
  expect((screen.getByRole('button', { name: 'Refresh status' }) as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  await act(async () => { finish(reply({ success: true, vaults: [] })); });
  expect(await screen.findByText('No Obsidian vault connected yet')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
  expect((screen.getByRole('button', { name: 'Refresh status' }) as HTMLButtonElement).disabled).toBe(false);
});
