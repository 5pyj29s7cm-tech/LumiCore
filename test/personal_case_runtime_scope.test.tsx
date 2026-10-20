// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LegalHub } from '../src/components/org/LegalHub';
import { createEmptyLegalCase, LEGAL_CASES_CHANGED_EVENT, readLegalCaseFiles, setLegalCaseAccount } from '../src/lib/legalCaseStore';
const fx = vi.hoisted(() => ({ uid: 'scope-owner', api: vi.fn() }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: fx.uid }, workDomain: 'personal', orgConnection: null }) }));
vi.mock('../src/services/apiClient', () => ({ apiJson: (...args: any[]) => fx.api(...args) }));
vi.mock('../src/components/org/legal_hub/workspace', () => ({ LegalCaseWorkspace: (props: any) => <div><h2>{props.activeCase?.title || 'No selected case'}</h2><button onClick={() => props.onRefreshCases()}>Refresh owner cases</button></div> }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
const file = { ...createEmptyLegalCase(), id: 'existing-owner-case', title: 'Existing shared backend case', notes: 'Full backend notes', materials: [], updatedAt: '2026-10-01T00:00:00.000Z' };
const reply = () => ({ cases: [file], removedCaseIds: [] });
beforeEach(() => { localStorage.clear(); fx.uid = 'scope-owner'; setLegalCaseAccount(fx.uid); fx.api.mockReset().mockImplementation(async (url, init) => init?.method === 'POST' ? { case: JSON.parse(init.body).case } : reply()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('hydrates an empty frontend, refreshes the same owner API, and never feeds cache events back into GET', async () => {
  render(<LegalHub />); await screen.findByRole('heading', { name: file.title });
  expect(readLegalCaseFiles()[0].notes).toBe(file.notes);
  const reads = () => fx.api.mock.calls.filter(([url, init]) => url === '/api/legal/client-case-sync' && !init?.method).length;
  expect(reads()).toBe(1);
  act(() => window.dispatchEvent(new Event(LEGAL_CASES_CHANGED_EVENT))); expect(reads()).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh owner cases' })); await waitFor(() => expect(reads()).toBe(2));
  act(() => window.dispatchEvent(new Event('focus'))); await waitFor(() => expect(reads()).toBe(3));
  await act(async () => {}); expect(reads()).toBe(3);
});
it('does not display or store a late owner response after the authenticated account switches', async () => {
  let resolve!: (value: unknown) => void;
  fx.api.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<LegalHub />);
  fx.uid = 'other-scope-owner'; setLegalCaseAccount(fx.uid); fx.api.mockResolvedValue({ cases: [], removedCaseIds: [] }); view.rerender(<LegalHub />);
  await act(async () => resolve(reply()));
  expect(screen.queryByRole('heading', { name: file.title })).toBeNull(); expect(readLegalCaseFiles()).toEqual([]);
});
