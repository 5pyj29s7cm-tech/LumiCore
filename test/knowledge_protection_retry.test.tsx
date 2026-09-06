// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: mocks }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => null }));
vi.mock('../src/components/MemoryTree', () => ({
  MemoryTreeScene: ({ nodes, onNodeClick }: any) => <>{nodes.map((node: any) => <button key={node.id} onClick={() => onNodeClick(node.id, 10, 10)}>Select memory</button>)}</>,
  layoutTree3D: (memories: any[]) => ({ nodes: memories.map(memory => ({ ...memory, type: 'memory', title: memory.content, hue: 100 })), curves: [] }),
}));
vi.mock('../src/components/NodeDetailPanel', () => ({ NodeDetailPanel: ({ node, onToggleProtect }: any) => node
  ? <button onClick={() => onToggleProtect(node.id)}>{node.isCore ? 'Unprotect memory' : 'Protect memory'}</button> : null }));
import { KnowledgeBase } from '../src/components/KnowledgeBase';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

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
