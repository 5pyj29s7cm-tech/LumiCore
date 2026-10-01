// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast: mocks }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => null }));
vi.mock('../src/components/MemoryTree', () => ({
  MemoryTreeScene: ({ nodes, onNodeClick }: any) => <>{nodes.map((node: any) => <button key={node.id} onClick={() => onNodeClick(node.id, 10, 10)}>Select memory</button>)}</>,
  layoutTree3D: vi.fn((memories: any[]) => ({ nodes: memories.map(memory => ({ ...memory, type: 'memory', title: memory.content, hue: 100 })), curves: [] })),
}));
vi.mock('../src/components/NodeDetailPanel', () => ({ NodeDetailPanel: ({ node, onToggleProtect }: any) => node
  ? <button onClick={() => onToggleProtect(node.id)}>{node.isCore ? 'Unprotect memory' : 'Protect memory'}</button> : null }));
import { KnowledgeBase } from '../src/components/KnowledgeBase';
import { layoutTree3D } from '../src/components/MemoryTree';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('opens knowledge without a transparent reveal and removes it immediately on close', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ files: [], tree: [], vaults: [] }))));
  const props={isOpen:true,t:{langCode:'en'},onClose:vi.fn()};
  const view=render(<KnowledgeBase {...props}/>);
  const surface=view.container.querySelector('[data-knowledge-base]') as HTMLElement;
  expect(surface).not.toBeNull();expect(surface.style.clipPath).toBe('');expect(surface.style.opacity).not.toBe('0');
  view.rerender(<KnowledgeBase {...props} isOpen={false}/>);
  expect(view.container.querySelector('[data-knowledge-base]')).toBeNull();
  await act(async()=>{});
  expect(view.container.querySelector('[data-knowledge-base]')).toBeNull();
});

it('does not report failed protection as success and retries the same target instead of reversing the server toggle', async () => {
  let tier = 'episodic'; let attempts = 0; let treeReads = 0;
  const targets: unknown[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.includes('/protect')) {
      attempts++; targets.push(JSON.parse(String(init?.body)));
      const target = JSON.parse(String(init?.body)).protected;
      tier = target ? 'core_identity' : 'growth';
      return new Response(JSON.stringify(attempts === 1 ? { code: 'PERSISTENCE_UNAVAILABLE', persistence: 'pending' } : { success: true, protected: target }), { status: attempts === 1 ? 503 : 200 });
    }
    if (input.includes('/memory/tree')) {
      treeReads++;
      return new Response(JSON.stringify({ tree: [{ node: { id: 'synthetic-memory', content: 'Synthetic note', tier, importance: 0.5 }, children: [] }] }));
    }
    return new Response(JSON.stringify(input.includes('/files/list') ? { files: [] } : { vaults: [] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<KnowledgeBase isOpen t={{ langCode: 'en' }} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Select memory' }));
  const baseline = treeReads;
  fireEvent.click(screen.getByRole('button', { name: 'Protect memory' }));
  await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
  expect(mocks.success).not.toHaveBeenCalled(); expect(treeReads).toBe(baseline);
  fireEvent.click(screen.getByRole('button', { name: 'Protect memory' }));
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Protected'));
  await act(async () => {});
  expect(targets).toEqual([{ protected: true }, { protected: true }]);
  fireEvent.click(await screen.findByRole('button', { name: 'Unprotect memory' }));
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Unprotected'));
  expect(targets[2]).toEqual({ protected: false });
});


it('continues bulk ingestion after a failed file and releases each busy state', async () => {
  const requests: string[] = []; let pending = 0; let maximum = 0; let listReads = 0;
  const files = ['first.txt', 'failed.txt', 'last.txt'].map(id => ({ id, name: id, agentIds: [], status: 'ready' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/files/ingest')) {
      pending++; maximum = Math.max(maximum, pending);
      const data = JSON.parse(String(init?.body)); requests.push(data.fileId);
      expect(data).toMatchObject({ agentId: 'lumi', domain: 'personal' });
      await Promise.resolve(); pending--;
      return new Response('{}', { status: data.fileId === 'failed.txt' ? 503 : 200 });
    }
    if (url.includes('/files/list')) listReads++;
    return new Response(JSON.stringify({ files, tree: [], vaults: [] }));
  }));
  render(<KnowledgeBase isOpen t={{ langCode: 'en', kbIngestAll: 'Absorb all' }} onClose={vi.fn()} />);
  const button = await screen.findByRole('button', { name: 'Absorb all (3)' });
  const before = listReads;
  fireEvent.click(button);
  await waitFor(() => expect(mocks.warning).toHaveBeenCalledOnce());
  expect(requests).toEqual(files.map(file => file.id)); expect(maximum).toBe(1);
  expect(listReads).toBe(before + 1); expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(mocks.error).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled();
});


it('shows load failures inline without toasts and clears them on a successful reload', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify({ files: [], tree: [], vaults: [] }),
    { status: fail && (url.includes('/files/list') || url.includes('/memory/tree')) ? 503 : 200 })));
  const props = { isOpen: true, t: { langCode: 'en' }, onClose: vi.fn() };
  const view = render(<KnowledgeBase {...props} />);
  expect(await screen.findByText('Files failed to load (503) / Memories failed to load (503)')).toBeTruthy();
  for (const notify of Object.values(mocks)) expect(notify).not.toHaveBeenCalled();
  fail = false;
  view.rerender(<KnowledgeBase {...props} isOpen={false} />);
  view.rerender(<KnowledgeBase {...props} />);
  await waitFor(() => expect(screen.queryByText(/failed to load/)).toBeNull());
});

it.each(['reload', 'scope'] as const)('retains the newest files and memory tree after a late response during %s', async change => {
  const delayed = new Map<string, (value: Response) => void>();
  let older = true;
  const payload = (name: string) => ({ files: [{ id: name + '.txt', name: name + '.txt', displayName: name + ' document' }],
    tree: [{ node: { id: name, content: name, tier: 'episodic', importance: 0.5 }, children: [] }] });
  const fetcher = vi.fn((url: string) => {
    if (older && (url.includes('/files/list') || url.includes('/memory/tree'))) {
      return new Promise<Response>(resolve => { delayed.set(url.includes('/files/list') ? 'files' : 'tree', resolve); });
    }
    return Promise.resolve(new Response(JSON.stringify(payload('current'))));
  });
  vi.stubGlobal('fetch', fetcher);
  const props = { isOpen: true, domain: 'personal' as const, scopeKey: 'first', t: { langCode: 'en' }, onClose: vi.fn() };
  const view = render(<KnowledgeBase {...props} />);
  await waitFor(() => expect(delayed.size).toBe(2));
  older = false;
  if (change === 'scope') view.rerender(<KnowledgeBase {...props} domain="work" scopeKey="second" />);
  else { view.rerender(<KnowledgeBase {...props} isOpen={false} />); view.rerender(<KnowledgeBase {...props} />); }
  expect(await screen.findByText('current document')).toBeTruthy();
  await waitFor(() => expect(vi.mocked(layoutTree3D).mock.lastCall?.[0].map(node => node.id)).toEqual(['current']));
  await act(async () => { for (const finish of delayed.values()) finish(new Response(JSON.stringify(payload('stale')))); });
  expect(screen.queryByText('stale document')).toBeNull();
  expect(screen.getByText('current document')).toBeTruthy();
  expect(vi.mocked(layoutTree3D).mock.lastCall?.[0].map(node => node.id)).toEqual(['current']);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/archive-generated'))).toHaveLength(change === 'scope' ? 2 : 1);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/files/list'))).toHaveLength(2);
  if (change === 'scope') expect(fetcher.mock.calls.filter(([url]) => url.includes('domain=work') && url.includes('/files/list'))).toHaveLength(1);
});

it('loads the memory tree while archive reconciliation is pending and reports invalid tree responses', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn((url: string) => url.includes('/archive-generated') ? new Promise<Response>(resolve => { finish = resolve; })
    : Promise.resolve(new Response(url.includes('/memory/tree') ? '{invalid json' : JSON.stringify({ files: [], vaults: [] }))));
  vi.stubGlobal('fetch', fetcher);
  render(<KnowledgeBase isOpen t={{ langCode: 'en' }} onClose={vi.fn()} />);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('/memory/tree'))).toBe(true));
  expect(fetcher.mock.calls.some(([url]) => url.includes('/files/list'))).toBe(false);
  await act(async () => { finish(new Response('{}')); });
  expect(await screen.findByText('Memories failed to load (network)')).toBeTruthy();
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/files/list'))).toHaveLength(1);
  for (const notify of Object.values(mocks)) expect(notify).not.toHaveBeenCalled();
});
