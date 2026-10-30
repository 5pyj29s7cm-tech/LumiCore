// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OrgPortal } from '../OrgPortal';

const fixture = vi.hoisted(() => ({
  account: { user: { uid: 'portal-owner' }, orgConnection: null as any, workDomain: 'personal' as 'personal' | 'work' },
  fetch: vi.fn(), switchDomain: vi.fn(), refreshUser: vi.fn(),
}));
vi.mock('../../contexts/AppContext', () => ({ useApp: () => ({ ...fixture.account, switchDomain: fixture.switchDomain, refreshUser: fixture.refreshUser }) }));
vi.mock('../../services/apiClient', () => ({ apiFetch: (...args: any[]) => fixture.fetch(...args) }));
vi.mock('../../lib/useT', () => ({ useT: () => ({ retry: 'Retry', orgWorkSpace: 'Organization workspace' }) }));
vi.mock('../../i18n/uiMessages', () => ({ uiMessage: (key: string) => key }));
vi.mock('./OrgHub', () => ({ OrgHub: () => <h1>Verified organization workspace</h1> }));
vi.mock('./JoinOrgPage', () => ({ JoinOrgPage: () => <h1>Join organization</h1> }));

const organization = { id: 'portal-org', name: 'Known organization', role: 'owner' };
const response = (body: unknown) => ({ ok: true, json: async () => body });
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; }
function discoverOrganization() {
  fixture.fetch.mockImplementation(async (url: string) => response(url === '/api/org/status'
    ? { connected: false, orgId: null } : { orgs: [organization] }));
}
function confirmWorkDomain() {
  fixture.account.workDomain = 'work';
  fixture.account.orgConnection = { orgId: organization.id, orgName: organization.name, orgRole: organization.role, connected: true };
  return { success: true, domain: 'work', connection: fixture.account.orgConnection };
}
beforeEach(() => {
  fixture.account = { user: { uid: 'portal-owner' }, orgConnection: null, workDomain: 'personal' };
  fixture.fetch.mockReset(); fixture.switchDomain.mockReset(); fixture.refreshUser.mockReset(); localStorage.clear();
});
afterEach(cleanup);

it('preserves saved organization preference when discovery fails and retries the read', async () => {
  localStorage.setItem('lumi_org_connection', 'saved-connection'); localStorage.setItem('lumi_work_domain','work');
  let denied=true;
  fixture.fetch.mockImplementation(async (url: string) => url==='/api/org/status' ? response({connected:false,orgId:null}) : denied ? {ok:false,status:503,json:async()=>({error:'Unavailable'})} : response({orgs:[organization]}));
  fixture.switchDomain.mockImplementation(async()=>confirmWorkDomain());
  render(<OrgPortal/>); await screen.findByRole('alert', {}, {timeout:4000});
  expect(localStorage.getItem('lumi_org_connection')).toBe('saved-connection'); expect(localStorage.getItem('lumi_work_domain')).toBe('work');
  denied=false; fireEvent.click(screen.getByRole('button',{name:'重新读取'})); await screen.findByRole('heading',{name:'Verified organization workspace'});
});

it('enters an existing organization once after the user opens its portal, without another entry confirmation', async () => {
  discoverOrganization(); const pending = deferred();
  fixture.switchDomain.mockImplementation(() => pending.promise.then(() => confirmWorkDomain()));
  render(<OrgPortal />);
  await waitFor(() => expect(fixture.switchDomain).toHaveBeenCalledOnce());
  expect(fixture.switchDomain.mock.calls[0]).toEqual(['work', expect.objectContaining({ orgId: organization.id, orgName: organization.name, signal: expect.objectContaining({ aborted: false }) })]);
  expect(localStorage.getItem('lumi_org_connection')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Verified organization workspace' })).toBeNull();
  expect(screen.queryByRole('button', { name: /switch-to-work-domain/ })).toBeNull();
  await act(async () => pending.resolve(undefined));
  await screen.findByRole('heading', { name: 'Verified organization workspace' });
  expect(fixture.switchDomain).toHaveBeenCalledOnce();
  expect(screen.queryByText(/you-have-joined-an-organization/)).toBeNull();
});

it('keeps a valid organization session without switching it again', async () => {
  confirmWorkDomain(); fixture.fetch.mockResolvedValue(response({ orgId: organization.id, orgRole: 'owner' }));
  render(<OrgPortal />); await screen.findByRole('heading', { name: 'Verified organization workspace' });
  expect(fixture.switchDomain).not.toHaveBeenCalled();
  expect(fixture.fetch.mock.calls.map(([url]) => url)).toEqual(['/api/org/status']);
});

it('reports a rejected domain switch and retries the same organization before displaying its workspace', async () => {
  discoverOrganization(); fixture.switchDomain.mockResolvedValueOnce({ success: false, message: 'Organization session rejected' }).mockImplementationOnce(async () => confirmWorkDomain());
  render(<OrgPortal />); await screen.findByText('Organization session rejected');
  expect(screen.queryByRole('heading', { name: 'Verified organization workspace' })).toBeNull();
  expect(localStorage.getItem('lumi_org_connection')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('heading', { name: 'Verified organization workspace' });
  expect(fixture.switchDomain).toHaveBeenCalledTimes(2);
  expect(fixture.switchDomain.mock.calls[1]).toEqual(['work', expect.objectContaining({ orgId: organization.id, orgName: organization.name })]);
});

it.each(['status', 'discovery'])('does not start a domain switch from an obsolete %s response', async phase => {
  const pending = deferred();
  fixture.fetch.mockImplementation((url: string) => (phase === 'status' && url === '/api/org/status') || (phase === 'discovery' && url === '/api/auth/orgs')
    ? pending.promise : Promise.resolve(response({ connected: false, orgId: null })));
  const view = render(<OrgPortal />);
  await waitFor(() => expect(fixture.fetch).toHaveBeenCalledTimes(phase === 'status' ? 1 : 2));
  const signal = fixture.fetch.mock.calls.at(-1)?.[1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(response(phase === 'status' ? { connected: false, orgId: null } : { orgs: [organization] })));
  expect(fixture.switchDomain).not.toHaveBeenCalled();
  expect(localStorage.getItem('lumi_org_connection')).toBeNull();
});
