// @vitest-environment jsdom
import './helpers';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgMembers } from '../src/components/org/OrgMembers';
import { OrgSettings } from '../src/components/org/OrgSettings';
const fixture = vi.hoisted(() => ({
  account: { user: { uid: 'owner', role: 'user' }, workDomain: 'work', orgConnection: { orgId: 'fixture/org', orgRole: 'owner' } } as any,
  json: vi.fn(), confirm: vi.fn(), switchDomain: vi.fn(),
}));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ ...fixture.account, switchDomain: fixture.switchDomain }) }));
vi.mock('../src/services/apiClient', () => ({ apiJson: (...args: any[]) => fixture.json(...args) }));
vi.mock('../src/lib/appConfirm', () => ({ useAppConfirm: () => fixture.confirm }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: 'en', orgRoleOwner: 'Owner', orgRoleAdmin: 'Administrator', orgRoleMember: 'Member', orgRoleViewer: 'Viewer' }) }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key, formatUiMessage: (key: string) => key }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const member = (userId: string, role = 'member', status = 'active') => ({ id: 'm-' + userId, orgId: 'fixture/org', userId, role, status });
const organization = (ownerUid = 'owner') => ({ id: 'fixture/org', name: 'Fixture', slug: 'fixture', ownerUid });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  fixture.account = { user: { uid: 'owner', role: 'user' }, workDomain: 'work', orgConnection: { orgId: 'fixture/org', orgRole: 'owner' } };
  fixture.json.mockReset(); fixture.confirm.mockReset().mockResolvedValue(true); fixture.switchDomain.mockReset().mockResolvedValue({ success: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('organization role controls', () => {
  const load = () => fixture.json.mockResolvedValueOnce([member('owner', 'owner'), member('target')]);
  it('requires a specific confirmation and accepts only the requested role receipt', async () => {
    load().mockResolvedValueOnce(member('target', 'viewer')); render(<OrgMembers />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Role for target' }), { target: { value: 'viewer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save role' })); await screen.findByText('Member role confirmed.');
    expect(fixture.confirm.mock.calls[0][0].message).toContain('target'); expect(fixture.confirm.mock.calls[0][0].message).toContain('Viewer');
    expect(fixture.json.mock.calls[1][0]).toBe('/api/org/org/fixture%2Forg/members/target/role');
    expect(JSON.parse(fixture.json.mock.calls[1][1].body)).toEqual({ role: 'viewer' });
  });
  it('does not mutate when the confirmation is cancelled', async () => {
    load(); fixture.confirm.mockResolvedValue(false); render(<OrgMembers />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Role for target' }), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save role' })); await waitFor(() => expect(fixture.confirm).toHaveBeenCalled());
    expect(fixture.json).toHaveBeenCalledTimes(1);
  });
  it.each([member('target', 'member'), { ...member('target', 'viewer'), orgId: 'foreign' }, member('other', 'viewer')])('retains the draft and reports an unconfirmed receipt', async receipt => {
    load().mockResolvedValueOnce(receipt).mockResolvedValueOnce(member('target', 'viewer')); render(<OrgMembers />);
    const select = await screen.findByRole('combobox', { name: 'Role for target' }); fireEvent.change(select, { target: { value: 'viewer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save role' })); await screen.findByText('Save was not confirmed');
    expect(screen.queryByText('Member role confirmed.')).toBeNull(); expect(select).toHaveProperty('value', 'viewer');
    fireEvent.click(screen.getByRole('button', { name: 'Save role' })); await screen.findByText('Member role confirmed.');
  });
  it('uses live member privileges instead of the stale owner context', async () => {
    fixture.json.mockResolvedValue([member('owner', 'admin'), member('administrator', 'admin'), member('target')]); render(<OrgMembers />);
    const control = await screen.findByRole('combobox', { name: 'Role for target' });
    expect(control.querySelector('option[value="admin"]')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Role for administrator' })).toBeNull(); expect(screen.queryByRole('combobox', { name: 'Role for owner' })).toBeNull();
  });
});
describe('organization ownership control', () => {
  function load() { fixture.json.mockResolvedValueOnce(organization()).mockResolvedValueOnce([member('owner', 'owner'), member('target'), member('inactive', 'viewer', 'revoked')]); }
  async function selectTarget() {
    render(<OrgSettings />); fireEvent.click(await screen.findByRole('button', { name: 'Load eligible members' }));
    const select = await screen.findByRole('combobox', { name: 'New owner' }); expect(select.querySelector('option[value="inactive"]')).toBeNull();
    fireEvent.change(select, { target: { value: 'target' } });
  }
  it('confirms the target, waits for its receipt, then refreshes server-issued access', async () => {
    load(); const pending = deferred<any>(); fixture.json.mockReturnValueOnce(pending.promise); await selectTarget();
    fireEvent.click(screen.getByRole('button', { name: 'Transfer organization ownership' }));
    await waitFor(() => expect(fixture.json).toHaveBeenCalledTimes(3)); expect(fixture.switchDomain).not.toHaveBeenCalled();
    expect(fixture.confirm.mock.calls[0][0].message).toContain('target');
    await act(async () => pending.resolve(organization('target'))); await screen.findByText('Ownership transfer confirmed.');
    await waitFor(() => expect(fixture.switchDomain).toHaveBeenCalledWith('work', expect.objectContaining({ orgId: 'fixture/org' })));
    expect(screen.queryByRole('button', { name: 'Transfer organization ownership' })).toBeNull();
  });
  it('does not transfer or refresh access when confirmation is cancelled', async () => {
    load(); fixture.confirm.mockResolvedValue(false); await selectTarget(); fireEvent.click(screen.getByRole('button', { name: 'Transfer organization ownership' }));
    await waitFor(() => expect(fixture.confirm).toHaveBeenCalled()); expect(fixture.json).toHaveBeenCalledTimes(2); expect(fixture.switchDomain).not.toHaveBeenCalled();
  });
  it('rejects a receipt for an unexpected owner and offers state reload', async () => {
    load(); fixture.json.mockResolvedValueOnce(organization('unexpected')); await selectTarget();
    fireEvent.click(screen.getByRole('button', { name: 'Transfer organization ownership' }));
    await screen.findByText('Ownership transfer was not confirmed. Reload the organization before trying again.');
    expect(fixture.switchDomain).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: /org-settings.reload/ })).toBeTruthy();
  });
  it('retries access refresh without replaying the ownership mutation', async () => {
    load(); fixture.json.mockResolvedValueOnce(organization('target')); fixture.switchDomain.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true }); await selectTarget();
    fireEvent.click(screen.getByRole('button', { name: 'Transfer organization ownership' }));
    await screen.findByText('Ownership changed, but session access could not be refreshed. Refresh access to continue.');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh organization access' })); await waitFor(() => expect(fixture.switchDomain).toHaveBeenCalledTimes(2));
    expect(fixture.json.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
  it('discards a delayed transfer receipt after account scope changes', async () => {
    load(); const pending = deferred<any>(); fixture.json.mockReturnValueOnce(pending.promise);
    const view = render(<OrgSettings />); fireEvent.click(await screen.findByRole('button', { name: 'Load eligible members' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'New owner' }), { target: { value: 'target' } }); fireEvent.click(screen.getByRole('button', { name: 'Transfer organization ownership' }));
    await waitFor(() => expect(fixture.json).toHaveBeenCalledTimes(3)); const signal = fixture.json.mock.calls[2][1].signal;
    fixture.account.user.uid = 'new-account'; fixture.json.mockResolvedValue(organization('target')); view.rerender(<OrgSettings />);
    await act(async () => pending.resolve(organization('target'))); expect(signal.aborted).toBe(true); expect(fixture.switchDomain).not.toHaveBeenCalled(); expect(screen.queryByText('Ownership transfer confirmed.')).toBeNull();
  });
});
