// @vitest-environment jsdom
import './helpers';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import * as OrgDB from '../server/org/db';
import { mountOrgRoutes } from '../server/org/routes';
import { BranchDashboard } from '../src/components/org/BranchDashboard';
import { AuditLogViewer } from '../src/components/org/AuditLogViewer';
import { canAccessOrganizationWorkspaceView } from '../shared/org_workspace';

const fixture = vi.hoisted(() => ({
  account: { user: { uid: 'dashboard-owner', role: 'user' } as any, workDomain: 'work', orgConnection: { orgId: 'fixture/a', orgName: 'Fixture organization', orgRole: 'owner' } as any },
  json: vi.fn(), fetch: vi.fn(),
}));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => fixture.account }));
vi.mock('../src/services/apiClient', () => ({ apiJson: (...args: any[]) => fixture.json(...args), apiFetch: (...args: any[]) => fixture.fetch(...args) }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: 'en', retry: 'Retry', orgAudit: 'Audit log', orgMembers: 'Members', orgKB: 'Knowledge base' }) }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key, formatUiMessage: (key: string, values: any) => key + ' ' + String(values.value0?.en ?? values.value0) }));

const labels = {
  filters: /audit-log-viewer.filters\./,
  search: /audit-log-viewer.search\./,
  clear: /audit-log-viewer.clear\./,
  export: /audit-log-viewer.export-csv\./,
  empty: /audit-log-viewer.no-audit-entries-found\./,
  exported: /audit-log-viewer.audit-csv-exported\./,
};
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function row(id: string, details = '{}') { return { id, userId: 'fixture-user-' + id, action: 'document.read.' + id, resourceType: 'document', resourceId: id, details, timestamp: '2026-10-30T01:02:03.000Z' }; }
function dashboardReply(url: string) {
  if (url === '/api/org/status') return { connected: true, orgId: 'fixture/a' };
  if (url === '/api/org/org') return [{ id: 'fixture/a' }];
  if (url.endsWith('/members')) return [{ userId: 'a' }, { userId: 'b' }];
  if (url.includes('/kb/articles')) return { articles: [{ id: 'knowledge-a' }] };
  throw new Error('Unexpected fixture path: ' + url);
}
beforeEach(() => {
  fixture.account = { user: { uid: 'dashboard-owner', role: 'user' }, workDomain: 'work', orgConnection: { orgId: 'fixture/a', orgName: 'Fixture organization', orgRole: 'owner' } };
  fixture.json.mockReset(); fixture.fetch.mockReset(); localStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('organization dashboard dynamic component', () => {
  it('waits for statistics and presents confirmed member/article counts and sync state', async () => {
    const pending = deferred<any>(); fixture.json.mockImplementation((url: string) => url === '/api/org/status' ? pending.promise : Promise.resolve(dashboardReply(url)));
    render(<BranchDashboard />); expect(screen.getByRole('button', { name: 'Refresh' })).toHaveProperty('disabled', true);
    expect(screen.queryByText('Connected')).toBeNull();
    await act(async () => pending.resolve({ connected: true, orgId: 'fixture/a' }));
    await screen.findByText('Connected'); expect(screen.getByText('2')).toBeTruthy(); expect(screen.getByText('1')).toBeTruthy();
    expect(fixture.json.mock.calls.map(([url]) => url)).toContain('/api/org/org/fixture%2Fa/members');
  });
  it('reports one unavailable count without inventing zero and recovers on refresh', async () => {
    let fail = true; fixture.json.mockImplementation(async (url: string) => { if (url.endsWith('/members') && fail) throw new Error('members unavailable'); return dashboardReply(url); });
    render(<BranchDashboard />); await screen.findByText('Some organization data is temporarily unavailable'); expect(screen.getByText('—')).toBeTruthy(); expect(screen.getByText('1')).toBeTruthy();
    fail = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await screen.findByText('2');
    expect(screen.queryByText('Some organization data is temporarily unavailable')).toBeNull();
  });
  it('shows a status failure and retries instead of claiming a connection', async () => {
    fixture.json.mockRejectedValueOnce(new Error('status fixture failed')).mockImplementation(async (url: string) => dashboardReply(url));
    render(<BranchDashboard />); await screen.findByText('status fixture failed'); expect(screen.queryByText('Connected')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await screen.findByText('Connected');
  });
  it('rejects malformed status and count payloads', async () => {
    fixture.json.mockResolvedValueOnce({ connected: 'yes' }); const view = render(<BranchDashboard />);
    await screen.findByText('Failed to load organization status'); view.unmount();
    fixture.json.mockImplementation(async (url: string) => url === '/api/org/status' ? { connected: false, orgId: 'fixture/a' } : { wrong: [] });
    render(<BranchDashboard />); await screen.findByText('Some organization data is temporarily unavailable'); expect(screen.getAllByText('—')).toHaveLength(2); await screen.findByText('Offline');
  });
  it('uses organization discovery when neither context nor status names an organization', async () => {
    fixture.account.orgConnection = null; fixture.json.mockImplementation(async (url: string) => url === '/api/org/status' ? { connected: false } : dashboardReply(url));
    render(<BranchDashboard />); await screen.findByText('2'); expect(fixture.json.mock.calls.map(([url]) => url)).toContain('/api/org/org');
  });
  it('routes authorized quick entries to their exact organization destinations', async () => {
    fixture.json.mockImplementation(async (url: string) => dashboardReply(url)); render(<BranchDashboard />); await screen.findByText('2');
    const events: any[] = [], listener = (event: Event) => events.push((event as CustomEvent).detail); window.addEventListener('lumi:navigate', listener);
    try { for (const name of ['Open knowledge base', 'Organization LumiCore', 'Members and access', 'Audit log']) fireEvent.click(screen.getByRole('button', { name: new RegExp('^' + name) })); }
    finally { window.removeEventListener('lumi:navigate', listener); }
    expect(events).toEqual(['kb', 'chat', 'members', 'audit'].map(sub => ({ tab: 'org', sub })));
  });
  it.each(['member', 'viewer'])('does not offer %s shortcuts that the workspace explicitly refuses', async role => {
    fixture.account.orgConnection.orgRole = role; fixture.json.mockImplementation(async (url: string) => dashboardReply(url));
    render(<BranchDashboard />); await screen.findByText('2');
    expect(canAccessOrganizationWorkspaceView(role, 'audit')).toBe(false);
    expect(canAccessOrganizationWorkspaceView(role, 'members')).toBe(false);
    expect(screen.queryByRole('button', { name: /^Members and access/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Audit log/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Open knowledge base/ })).toBeTruthy();
  });
  it('discards an old organization response after the scope changes', async () => {
    const pending = deferred<any>(); fixture.json.mockImplementationOnce(() => pending.promise).mockImplementation(async (url: string) => dashboardReply(url));
    const view = render(<BranchDashboard />), oldSignal = fixture.json.mock.calls[0][1].signal;
    fixture.account.orgConnection = { orgId: 'fixture/b', orgName: 'Second organization', orgRole: 'admin' }; view.rerender(<BranchDashboard />);
    await screen.findByText('2'); expect(oldSignal.aborted).toBe(true);
    await act(async () => pending.resolve({ connected: false, orgId: 'old/org' }));
    expect(screen.queryByText('Offline')).toBeNull(); expect(fixture.json.mock.calls.map(([url]) => url)).not.toContain('/api/org/org/old%2Forg/members');
  });
});

describe('organization audit dynamic component', () => {
  it('renders confirmed rows, structured details and the existing 100-row request cap', async () => {
    fixture.json.mockResolvedValue([row('confirmed', '{"reason":"fixture evidence"}')]); render(<AuditLogViewer />);
    await screen.findByText('document.read.confirmed'); expect(screen.getByTitle('{"reason":"fixture evidence"}')).toBeTruthy();
    expect(fixture.json.mock.calls[0][0]).toBe('/api/org/audit?limit=100');
    expect(screen.queryByRole('button', { name: /next|previous/i })).toBeNull();
  });
  it('shows an empty list only after a completed empty response', async () => {
    const pending = deferred<any>(); fixture.json.mockReturnValue(pending.promise); render(<AuditLogViewer />);
    expect(screen.queryByText(labels.empty)).toBeNull(); await act(async () => pending.resolve([])); await screen.findByText(labels.empty);
  });
  it('recovers a failed request using the existing filter search control', async () => {
    fixture.json.mockRejectedValueOnce(new Error('audit fixture unavailable')).mockResolvedValueOnce([row('retry')]); render(<AuditLogViewer />);
    await screen.findByText('audit fixture unavailable'); fireEvent.click(screen.getByRole('button', { name: labels.filters }));
    fireEvent.click(screen.getByRole('button', { name: labels.search })); await screen.findByText('document.read.retry'); expect(screen.queryByText('audit fixture unavailable')).toBeNull();
  });
  it('trims and encodes submitted filters, and clears them to the unfiltered list', async () => {
    fixture.json.mockResolvedValue([]); render(<AuditLogViewer />); await screen.findByText(labels.empty);
    fireEvent.click(screen.getByRole('button', { name: labels.filters })); const fields = screen.getAllByRole('textbox');
    for (const [index, value] of [' person/a ', ' document.create ', ' document '].entries()) fireEvent.change(fields[index], { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: labels.search }));
    await waitFor(() => expect(fixture.json.mock.calls.at(-1)?.[0]).toBe('/api/org/audit?userId=person%2Fa&action=document.create&resourceType=document&limit=100'));
    fireEvent.click(screen.getByRole('button', { name: labels.clear }));
    await waitFor(() => expect(fixture.json.mock.calls.at(-1)?.[0]).toBe('/api/org/audit?limit=100')); expect(fields.every(field => (field as HTMLInputElement).value === '')).toBe(true);
  });
  it('keeps the newest filter result when an older request resolves later', async () => {
    const pending = deferred<any>(); fixture.json.mockResolvedValueOnce([]).mockReturnValueOnce(pending.promise).mockResolvedValueOnce([row('new')]);
    render(<AuditLogViewer />); await screen.findByText(labels.empty); fireEvent.click(screen.getByRole('button', { name: labels.filters }));
    fireEvent.click(screen.getByRole('button', { name: labels.search })); const signal = fixture.json.mock.calls.at(-1)?.[1].signal;
    fireEvent.click(screen.getByRole('button', { name: labels.clear })); await screen.findByText('document.read.new'); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve([row('old')])); expect(screen.queryByText('document.read.old')).toBeNull();
  });
  it.each(['null', 'true', '{broken'])('keeps audit rows usable when details contain %s', async details => {
    fixture.json.mockResolvedValue([row('robust', details)]); render(<AuditLogViewer />);
    await screen.findByText('document.read.robust'); expect(screen.getByTitle('-')).toBeTruthy();
  });
  it('rejects malformed list envelopes without presenting rows', async () => {
    fixture.json.mockResolvedValue([{ id: 'bad', action: 12 }]); render(<AuditLogViewer />); await screen.findByText('Invalid audit log response');
    expect(screen.queryByText('bad')).toBeNull();
  });
  it('exports only after a successful CSV response and releases its object URL', async () => {
    fixture.json.mockResolvedValue([row('export')]); const pending = deferred<any>(); fixture.fetch.mockReturnValue(pending.promise);
    const create = vi.fn(() => 'blob:fixture-audit'), revoke = vi.fn(); Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<AuditLogViewer />); await screen.findByText('document.read.export'); fireEvent.click(screen.getByRole('button', { name: labels.export }));
    expect(click).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: labels.export })).toHaveProperty('disabled', true);
    await act(async () => pending.resolve({ ok: true, blob: async () => new Blob(['timestamp,userId\nfixture,user']) }));
    await screen.findByText(labels.exported); expect(click).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledWith('blob:fixture-audit');
  });
  it('reports denied export without download or success feedback', async () => {
    fixture.json.mockResolvedValue([]); fixture.fetch.mockResolvedValue({ ok: false, status: 403 }); const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<AuditLogViewer />); await screen.findByText(labels.empty); fireEvent.click(screen.getByRole('button', { name: labels.export }));
    await screen.findByText('Audit export failed: HTTP 403'); expect(click).not.toHaveBeenCalled(); expect(screen.queryByText(labels.exported)).toBeNull();
  });
  it('removes old-scope audit records on role change and displays the server denial', async () => {
    fixture.json.mockResolvedValueOnce([row('privileged')]).mockRejectedValueOnce(new Error('Insufficient organization role'));
    const view = render(<AuditLogViewer />); await screen.findByText('document.read.privileged');
    fixture.account.orgConnection.orgRole = 'member'; view.rerender(<AuditLogViewer />);
    await screen.findByText('Insufficient organization role'); expect(screen.queryByText('document.read.privileged')).toBeNull();
  });
});

describe('organization audit real routes on isolated fixture database', () => {
  let base = '', close = () => {}, orgA = '', orgB = '';
  const token = (uid: string, orgId = orgA, claimedRole = 'owner') => jwt.sign({ uid, username: uid, role: 'user', orgId, orgRole: claimedRole }, JWT_SECRET);
  const get = (route: string, uid = 'route-owner', orgId = orgA) => fetch(base + '/api' + route, { headers: { Cookie: 'token=' + token(uid, orgId) } });
  beforeAll(async () => {
    const app = await makeApp(); base = app.url; close = app.cleanup; mountOrgRoutes(app.apiRouter);
    orgA = OrgDB.createOrg('Synthetic audit organization', 'org-audit-' + Date.now(), 'route-owner').id;
    orgB = OrgDB.createOrg('Foreign synthetic organization', 'org-audit-other-' + Date.now(), 'foreign-owner').id;
    for (const [uid, role] of [['route-owner', 'owner'], ['route-admin', 'admin'], ['route-member', 'member'], ['route-viewer', 'viewer']] as const) OrgDB.addMember(orgA, uid, role);
    for (let index = 0; index < 5; index++) OrgDB.logAudit({ orgId: orgA, userId: index < 3 ? 'filter-user' : 'other-user', action: index < 3 ? 'document.read' : 'document.update', resourceType: 'document', resourceId: 'fixture-' + index, details: { note: 'quoted, "fixture"', index } });
    OrgDB.logAudit({ orgId: orgB, userId: 'foreign-owner', action: 'foreign.sentinel', resourceType: 'document', resourceId: 'foreign-only' });
  });
  afterAll(() => close());
  it.each(['route-owner', 'route-admin'])('allows live %s membership to read only its organization', async uid => {
    const response = await get('/org/audit?limit=100', uid); expect(response.status).toBe(200); const body = await response.json(); expect(body).toHaveLength(5); expect(body.some((entry: any) => entry.action === 'foreign.sentinel')).toBe(false);
  });
  it.each(['route-member', 'route-viewer'])('rejects %s despite a forged owner claim in the isolated token', async uid => {
    expect((await get('/org/audit', uid)).status).toBe(403); expect((await get('/org/audit/export', uid)).status).toBe(403);
  });
  it('denies anonymous and cross-organization audit reads', async () => {
    expect((await fetch(base + '/api/org/audit')).status).toBe(401);
    expect((await get('/org/audit', 'route-owner', orgB)).status).toBe(403);
  });
  it('filters before pagination and returns nonoverlapping pages', async () => {
    const first = await (await get('/org/audit?userId=filter-user&action=document.read&resourceType=document&limit=2&offset=0')).json();
    const second = await (await get('/org/audit?userId=filter-user&action=document.read&resourceType=document&limit=2&offset=2')).json();
    expect(first).toHaveLength(2); expect(second).toHaveLength(1); expect(new Set([...first, ...second].map(x => x.id)).size).toBe(3); expect([...first, ...second].every(x => x.userId === 'filter-user')).toBe(true);
  });
  it('exports filtered local rows and escaped JSON details as CSV', async () => {
    const response = await get('/org/audit/export?userId=filter-user&action=document.read'); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('attachment;'); const csv = await response.text();
    expect(csv.split('\n')).toHaveLength(4); expect(csv).toContain('""note""'); expect(csv).not.toContain('foreign.sentinel'); expect(csv).not.toContain('document.update');
  });
  it('preserves commas, quotes and line breaks in audit resource identifiers during CSV export', async () => {
    const resourceId = 'report, "quarter"\nsecond-line';
    OrgDB.logAudit({ orgId: orgA, userId: 'filter-user', action: 'csv.roundtrip', resourceType: 'document', resourceId, details: { note: 'CSV roundtrip fixture' } });
    const response = await get('/org/audit/export?action=csv.roundtrip'); expect(response.status).toBe(200);
    const csv = await response.text(), { parseString } = await import('fast-csv');
    const parsed = await new Promise<any[]>((resolve, reject) => {
      const records: any[] = [];
      parseString(csv, { headers: true }).on('error', reject).on('data', record => records.push(record)).on('end', () => resolve(records));
    });
    expect(parsed).toHaveLength(1); expect(parsed[0].resourceId).toBe(resourceId); expect(JSON.parse(parsed[0].details)).toEqual({ note: 'CSV roundtrip fixture' });
  });
  it.each([
    ['comma', 'one,two'],
    ['double-quote', 'one "two"'],
    ['CRLF', 'one\r\ntwo'],
    ['empty', ''],
  ])('preserves every CSV column when identifier text contains %s', async (label, value) => {
    const action = 'csv.field-roundtrip.' + label + ':' + value;
    OrgDB.logAudit({ orgId: orgA, userId: value, action, resourceType: value, resourceId: value, details: { note: value } });
    const query = '?action=' + encodeURIComponent(action);
    const entries = await (await get('/org/audit' + query)).json(); expect(entries).toHaveLength(1);
    const response = await get('/org/audit/export' + query); expect(response.status).toBe(200);
    const csv = await response.text(), { parseString } = await import('fast-csv');
    const parsed = await new Promise<any[]>((resolve, reject) => {
      const records: any[] = [];
      parseString(csv, { headers: true }).on('error', reject).on('data', record => records.push(record)).on('end', () => resolve(records));
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(Object.fromEntries(['timestamp', 'userId', 'action', 'resourceType', 'resourceId', 'details'].map(key => [key, String(entries[0][key] ?? '')])));
  });
});
