// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OrgSettings } from './OrgSettings';
import { JoinOrgPage } from './JoinOrgPage';
import { OrgBranchPanel } from '../OrgBranchPanel';
import { cancelAppConfirm } from '../../lib/appConfirm';
const mocks = vi.hoisted(() => ({ json: vi.fn(), switchDomain: vi.fn(), account: { user: { uid: 'owner', role: 'user' }, workDomain: 'work', orgConnection: { orgId: 'org-a', orgRole: 'owner' } } }));
vi.mock('../../contexts/AppContext', () => ({ useApp: () => ({ ...mocks.account, switchDomain: mocks.switchDomain }) }));
vi.mock('../../services/apiClient', () => ({ apiJson: mocks.json }));
vi.mock('../../lib/useT', () => ({ useT: () => ({ langCode: 'en' }) }));
vi.mock('../../i18n/uiMessages', () => ({ uiMessage: (key: string) => key, formatUiMessage: (key: string) => key }));
const org = (id = 'org-a') => ({ id, name: id, slug: id });
const disconnected = { orgId: null, companyUrl: null, status: 'disconnected', connected: false, tokenConfigured: false, currentDomain: 'personal', lastSyncAt: null, lastHeartbeatAt: null };
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { mocks.account = { user: { uid: 'owner', role: 'user' }, workDomain: 'work', orgConnection: { orgId: 'org-a', orgRole: 'owner' } }; mocks.json.mockReset().mockResolvedValue(org()); mocks.switchDomain.mockReset(); localStorage.clear(); });
afterEach(() => { cancelAppConfirm(); cleanup(); vi.restoreAllMocks(); });
const button = (name: RegExp) => screen.getByRole('button', { name });

it('retains the name after rejected saves and requires an exact organization receipt', async () => {
  render(<OrgSettings />); const input = await screen.findByRole('textbox'); fireEvent.change(input, { target: { value: 'New name' } });
  const pending = deferred(); mocks.json.mockReturnValueOnce(pending.promise); act(() => { fireEvent.click(button(/save-changes/)); fireEvent.click(button(/save-changes/)); });
  expect(mocks.json).toHaveBeenCalledTimes(2); await act(async () => pending.resolve(org('other-org')));
  await screen.findByText('Organization receipt was not confirmed'); expect(input).toHaveProperty('value', 'New name');
  mocks.json.mockResolvedValueOnce({ ...org(), name: 'New name' }); fireEvent.click(button(/save-changes/)); await screen.findByText(/organization-settings-saved/);
});

it('ignores late organization reads and closes delete confirmation on account changes', async () => {
  const pending = deferred(); mocks.json.mockReturnValueOnce(pending.promise).mockResolvedValue(org('org-b'));
  const view = render(<OrgSettings />); const signal = mocks.json.mock.calls[0][1].signal;
  mocks.account.user.uid = 'next'; mocks.account.orgConnection.orgId = 'org-b'; view.rerender(<OrgSettings />);
  expect(await screen.findByRole('textbox')).toHaveProperty('value', 'org-b'); await act(async () => pending.resolve(org()));
  expect(signal.aborted).toBe(true); expect(screen.getByRole('textbox')).toHaveProperty('value', 'org-b');
  fireEvent.click(button(/delete-organization/)); expect(screen.getByRole('alertdialog')).toBeTruthy(); view.unmount();
  await act(async () => {}); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(mocks.json.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(false);
});

it('does not display a code from the wrong organization or claim a failed copy succeeded', async () => {
  render(<OrgSettings />); await screen.findByRole('textbox'); mocks.json.mockResolvedValueOnce({ orgId: 'other', role: 'member', code: 'PRIVATE' });
  fireEvent.click(button(/generate-code/)); await screen.findByText('Invitation receipt was not confirmed'); expect(screen.queryByText('PRIVATE')).toBeNull();
  mocks.json.mockResolvedValueOnce({ orgId: 'org-a', role: 'member', code: 'APPROVED' }); fireEvent.click(button(/generate-code/)); await screen.findByText('APPROVED');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard denied')) } });
    fireEvent.click(button(/org-settings.copy\./)); await screen.findByText('clipboard denied'); expect(screen.queryByText(/org-settings.copied\./)).toBeNull();
  } finally { if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor); else Reflect.deleteProperty(navigator, 'clipboard'); }
});

it('shows a failed branch read and retries without copying the local login token', async () => {
  localStorage.setItem('lumi_auth_token', 'local-private-token'); mocks.json.mockRejectedValueOnce(new Error('status unavailable')).mockResolvedValue(disconnected);
  const view = render(<OrgBranchPanel />); expect((await screen.findByRole('alert')).textContent).toBe('status unavailable');
  fireEvent.click(button(/retry/)); await screen.findByText(/org-branch-panel.not-connected-to/);
  expect(view.container.querySelector('input[type="password"]')).toHaveProperty('value', '');
  expect(view.container.textContent).not.toContain('local-private-token');
});

it('freezes the validated organization and retries domain entry without repeating a confirmed join', async () => {
  mocks.json.mockResolvedValueOnce({ valid: true, org: org('new-org'), role: 'member' }).mockResolvedValueOnce({ success: true, orgId: 'new-org' });
  mocks.switchDomain.mockResolvedValueOnce({ success: false, message: 'switch failed' }).mockResolvedValueOnce({ success: true, connection: { orgId: 'new-org' } });
  render(<JoinOrgPage />); fireEvent.change(screen.getByPlaceholderText('ABCD1234'), { target: { value: 'abcdef12' } });
  fireEvent.click(button(/validate-code/)); await screen.findByText('new-org'); fireEvent.click(button(/join-org-page.join\./));
  await screen.findByText('switch failed'); expect(mocks.json.mock.calls[1][0]).toBe('/api/org/invitations/ABCDEF12/accept');
  fireEvent.click(button(/already-joined-return/)); await waitFor(() => expect(mocks.switchDomain).toHaveBeenCalledTimes(2));
  expect(mocks.switchDomain.mock.calls[1][1]).toMatchObject({ orgId: 'new-org', orgName: 'new-org' }); expect(mocks.json).toHaveBeenCalledTimes(2);
});
