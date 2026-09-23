// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BusinessWorkbench } from './BusinessWorkbench';
vi.mock('./EcommerceAutomationWorkspace', () => ({ EcommerceAutomationWorkspace: ({ appId }: any) => <div>Commerce {appId}</div> }));
vi.mock('./FinanceWorkbench', () => ({ FinanceWorkbench: ({ initialWorkflowId }: any) => <div>Finance {initialWorkflowId}</div> }));
vi.mock('./ChatFilePreview', () => ({ ChatFilePreview: ({ file }: any) => <div role="dialog">Preview {file.fileName}</div> }));
vi.mock('../services/authService', () => ({ getDesktopSessionProof: () => 'local-proof' }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('shared business workbench', () => {
  it('switches business tools and previews current and imported artifacts from the same archive', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url === '/api/business/workspaces'
      ? { items: [], active: {} }
      : url === '/api/industry/workflows' ? { tasks: [{ id: 'current', title: 'Current report', status: 'delivered', result: 'Verified balances', artifacts: [{ path: 'D:/reports/current.xlsx', status: 'verified' }] }] }
      : url === '/api/business/legacy' ? { items: [{ line: 'finance', tasks: 1 }] }
      : { tasks: [{ id: 'old', title: 'Historical report', result: 'Historical only' }], artifacts: [{ originalPath: 'D:/old/archived.xlsx', path: 'D:/private/hash.xlsx', sha256: 'a'.repeat(64) }] } })));
    render(<BusinessWorkbench lang="en" domain="personal" onOpenSettings={vi.fn()} onOpenKnowledge={vi.fn()} onOpenSkills={vi.fn()} onOpenCreation={vi.fn()} onOpenDigitalHuman={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Social media', pressed: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Commerce' }));
    expect(await screen.findByText('Commerce store-data')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finance' }));
    expect(await screen.findByText('Finance business-dashboard')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tasks & archive' }));
    expect(await screen.findByText('Current report')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finance · 1' }));
    expect(await screen.findByText('Historical report')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /archived.xlsx/ }));
    expect(screen.getByRole('dialog').textContent).toBe('Preview archived.xlsx');
    await waitFor(() => expect(screen.getByRole('button', { name: /current.xlsx/ })).toBeTruthy());
  });
});
