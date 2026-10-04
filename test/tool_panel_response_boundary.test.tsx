// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolPanel } from '../src/components/ToolPanel';

vi.mock('../src/contexts/AppContext', () => ({
  useApp: () => ({ toolOverrides: {}, setToolOverride: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.setItem('lumi_auth_token', 'synthetic-session');
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('tool panel HTTP and schema boundaries', () => {
  it.each([
    [401, { error: 'Authentication required' }],
    [200, { error: 'unexpected object' }],
    [200, [null]],
  ])('keeps the UI rendered after HTTP %s or an invalid catalog', async (status, body) => {
    fetchMock.mockResolvedValue({ ok: status === 200, status, json: async () => body });
    const view = render(<ToolPanel />);
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('Failed to load tools'));
    expect(view.getByText('Tool Control Panel')).toBeTruthy();
    expect(view.queryByText('unexpected object')).toBeNull();
  });

  it('loads the authenticated catalog and renders its actual categories', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [
      { name: 'fixture_read', description: 'Read fixture', permission: 'local', securityLevel: 'safe' },
      { name: 'fixture_write', description: 'Write fixture', permission: 'local', securityLevel: 'confirm' },
    ] });
    const view = render(<ToolPanel />);
    await waitFor(() => expect(view.getByText('fixture_write')).toBeTruthy());
    expect(view.getByText('fixture_read')).toBeTruthy();
    expect(view.queryByRole('alert')).toBeNull();
    const [, request] = fetchMock.mock.calls[0];
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer synthetic-session');
    expect(view.getByText('autoExecute (1)')).toBeTruthy();
    expect(view.getByText('requireConfirmation (1)')).toBeTruthy();
  });
});
