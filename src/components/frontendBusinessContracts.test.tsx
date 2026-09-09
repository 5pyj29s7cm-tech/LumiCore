// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteMCPSettings } from './RemoteMCPSettings';
import { ContactsPanel } from './ContactsPanel';
import { KnowledgeBase } from './KnowledgeBase';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: mocks.error, success: mocks.success, info: vi.fn() } }));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => null }));
vi.mock('./NodeDetailPanel', () => ({ NodeDetailPanel: () => null }));
vi.mock('./MemoryTree', () => ({
  layoutTree3D: (_memories: any[], files: any[]) => ({ nodes: files.map(file => ({ id: file.id, name: file.name })), curves: [] }),
  MemoryTreeScene: ({ nodes }: any) => <div data-testid="knowledge-tree">{nodes.map((node: any) => node.name).join(',')}</div>,
}));
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { localStorage.clear(); for (const mock of Object.values(mocks)) mock.mockReset(); vi.stubGlobal('fetch', mocks.fetch); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('business views wait for the owning backend result', () => {
  it('can save removal of the final remote device', async () => {
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => init.method === 'PUT' ? reply({ success: true }) : reply({ devices: { speaker: 'wss://example.invalid/mcp' } }));
    const view = render(<RemoteMCPSettings />);
    await screen.findByText('speaker');
    fireEvent.click(view.container.querySelector('svg.lucide-trash2')!.closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalled());
    const write = mocks.fetch.mock.calls.find(([, init]) => init.method === 'PUT');
    expect(JSON.parse(write![1].body)).toEqual({ devices: {} });
  });
  it('retains remote device edits when the backend denies saving', async () => {
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => init.method === 'PUT' ? reply({ error: 'denied' }, 403) : reply({ devices: {} }));
    render(<RemoteMCPSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Add Device/i }));
    const fields = screen.getAllByRole('textbox');
    fireEvent.change(fields[0], { target: { value: 'speaker' } });
    fireEvent.change(fields[1], { target: { value: 'wss://example.invalid/mcp' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('speaker');
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('keeps a contact visible if deletion fails', async () => {
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => init.method === 'DELETE' ? reply({ error: 'delete denied' }, 500) : reply({ contacts: [{ id: 'contact', name: 'Synthetic contact' }] }));
    const view = render(<ContactsPanel />);
    await screen.findByText('Synthetic contact');
    fireEvent.click(view.container.querySelector('svg.lucide-trash2')!.closest('button')!);
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('delete denied'));
    expect(screen.getByText('Synthetic contact')).toBeTruthy();
  });

  it('cannot show an old personal file after entering another knowledge scope', async () => {
    const old = deferred<any>();
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.includes('/files/list') && url.includes('domain=personal')) return old.promise;
      if (url.includes('/files/list')) return reply({ files: [{ id: 'new', name: 'work-file.txt', status: 'pending' }] });
      return reply({ tree: [], vaults: [] });
    });
    const view = render(<KnowledgeBase t={{}} isOpen onClose={() => {}} domain="personal" scopeKey="user:personal" />);
    view.rerender(<KnowledgeBase t={{}} isOpen onClose={() => {}} domain="work" scopeKey="user:work:org" />);
    await waitFor(() => expect(screen.getByTestId('knowledge-tree').textContent).toBe('work-file.txt'));
    await act(async () => { old.resolve(reply({ files: [{ id: 'old', name: 'private-file.txt' }] })); });
    expect(screen.getByTestId('knowledge-tree').textContent).toBe('work-file.txt');
    expect(screen.queryByText('private-file.txt')).toBeNull();
  });
});
