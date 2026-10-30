import './helpers';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import * as DB from '../db_layer';
import * as EDB from '../server/org/db';
import { writeSetting } from '../server/persistence/settings_repository';
import { bindIndustryWorkspaceContext } from '../server/industry/workspace_context';
import { mountFinanceLocalWorksheetRoutes } from '../server/routes/finance_local_worksheet_routes';
import { FINANCE_WORKSHEET_COLUMNS, type FinanceWorksheetEntry } from '../shared/finance_local_worksheet';
let base = '', close = () => {}, org = '', workspace = '';
const rows = (entry: FinanceWorksheetEntry, note = 'Synthetic source') => [{ id: 'row-1', cells: Object.fromEntries(FINANCE_WORKSHEET_COLUMNS[entry].map(key => [key, key === 'notes' ? note : ''])), reviewStatus: 'pending' }];
const auth = (uid = 'fixture-owner', orgId = '') => ({ 'Content-Type': 'application/json', Cookie: 'token=' + jwt.sign({ uid, username: uid, role: 'user', orgId, orgRole: 'owner' }, JWT_SECRET) });
function request(entry = 'accounting', space = '_unbound', uid = 'fixture-owner', orgId = '', body?: any, query?: Record<string,string>) {
  const params = new URLSearchParams(query || { userId: uid, domain: orgId ? 'work' : 'personal', orgId });
  return fetch(base + '/api/business/finance-worksheets/' + entry + '/' + space + '?' + params, { headers: auth(uid, orgId), ...(body ? { method: 'PUT', body: JSON.stringify(body) } : {}) });
}
beforeAll(async () => {
  const app = await makeApp(); base = app.url; close = app.cleanup; mountFinanceLocalWorksheetRoutes(app.apiRouter);
  org = EDB.createOrg('Worksheet fixture', 'worksheet-' + Date.now(), 'fixture-owner').id;
  EDB.addMember(org, 'fixture-owner', 'owner'); EDB.addMember(org, 'fixture-viewer', 'viewer'); EDB.addMember(org, 'fixture-member', 'member');
  workspace = bindIndustryWorkspaceContext({ userId: 'fixture-owner', domain: 'work', orgId: org, productLine: 'finance' }, { name: 'Synthetic entity', productLine: 'finance' }).id;
});
afterEach(() => vi.restoreAllMocks()); afterAll(() => close());
describe('local finance worksheet durability and scope', () => {
  it.each(Object.keys(FINANCE_WORKSHEET_COLUMNS) as FinanceWorksheetEntry[])('persists and reads exact %s source records without posting any accounting entry', async entry => {
    const input = rows(entry); const saved = await request(entry, '_unbound', 'fixture-owner', '', { rows: input, expectedVersion: 0 });
    expect(saved.status).toBe(200); const body = await saved.json(); expect(body.persisted).toBe(true); expect(body.record).toMatchObject({ entryId: entry, workspaceId: '_unbound', version: 1, rows: input });
    expect(body.scope).toEqual({ userId: 'fixture-owner', domain: 'personal', orgId: '' });
    expect((await (await request(entry)).json()).record).toEqual(body.record);
  });
  it('isolates user, organization domain and finance entity', async () => {
    expect((await (await request('accounting', '_unbound', 'other-user')).json()).record).toBeNull();
    expect((await (await request('accounting', '_unbound', 'fixture-owner', org)).json()).record).toBeNull();
    expect((await request('accounting', workspace, 'fixture-owner', '', { rows: rows('accounting'), expectedVersion: 0 })).status).toBe(404);
    const saved = await request('accounting', workspace, 'fixture-owner', org, { rows: rows('accounting'), expectedVersion: 0 }); expect(saved.status).toBe(200);
    expect((await (await request('accounting', workspace, 'fixture-member', org)).json()).record).toBeNull();
    expect((await request('accounting', workspace, 'other-user')).status).toBe(404);
  });
  it('refuses stale UI scope instead of reading or writing a different authenticated domain', async () => {
    const stale = { userId: 'fixture-owner', domain: 'personal', orgId: '' };
    expect((await request('accounting', '_unbound', 'fixture-owner', org, undefined, stale)).status).toBe(409);
    expect((await request('accounting', '_unbound', 'fixture-owner', org, { rows: rows('accounting'), expectedVersion: 0 }, stale)).status).toBe(409);
    expect((await (await request('accounting', '_unbound', 'fixture-owner', org)).json()).record).toBeNull();
  });
  it('retains the stored version on a conflicting save and permits explicit reload followed by review changes', async () => {
    const stale = await request('accounting', '_unbound', 'fixture-owner', '', { rows: rows('accounting', 'Unconfirmed overwrite'), expectedVersion: 0 }); expect(stale.status).toBe(409);
    const before = (await (await request()).json()).record; expect(before.rows[0].cells.notes).toBe('Synthetic source');
    before.rows[0].reviewStatus = 'reviewed'; const saved = await request('accounting', '_unbound', 'fixture-owner', '', { rows: before.rows, expectedVersion: before.version });
    expect(saved.status).toBe(200); expect((await saved.json()).record).toMatchObject({ version: 2, rows: before.rows });
  });
  it('does not expose an uncommitted revision, reject duplicate writers, and rolls back failed persistence', async () => {
    let reject!: (reason: Error) => void; const barrier = new Promise<void>((_, fail) => { reject = fail; });
    const flush = vi.spyOn(DB, 'flushDBOrThrow').mockImplementationOnce(() => barrier);
    const pending = request('cash-risk', '_unbound', 'pending-user', '', { rows: rows('cash-risk'), expectedVersion: 0 });
    await vi.waitFor(() => expect(flush).toHaveBeenCalled());
    expect((await request('cash-risk', '_unbound', 'pending-user')).status).toBe(409);
    expect((await request('cash-risk', '_unbound', 'pending-user', '', { rows: rows('cash-risk'), expectedVersion: 0 })).status).toBe(409);
    reject(new Error('Synthetic persistence outage')); expect((await pending).status).toBe(503);
    expect((await (await request('cash-risk', '_unbound', 'pending-user')).json()).record).toBeNull();
    expect((await request('cash-risk', '_unbound', 'pending-user', '', { rows: rows('cash-risk'), expectedVersion: 0 })).status).toBe(200);
  });
  it('rejects malformed columns, duplicate IDs, extra keys and invalid versions without replacing data', async () => {
    const good = rows('accounting'); const mutations = [
      { rows: [{ ...good[0], cells: { ...good[0].cells, arbitrary: 'x' } }], expectedVersion: 2 },
      { rows: [good[0],good[0]], expectedVersion: 2 }, { rows: [{ ...good[0], reviewStatus: 'posted' }], expectedVersion: 2 },
      { rows: [{ ...good[0], cells: { ...good[0].cells, notes: 'x'.repeat(2001) } }], expectedVersion: 2 },
      { rows: good, expectedVersion: '2' }, { rows: good, expectedVersion: -1 },
      { rows: Array.from({ length: 1001 }, (_, i) => ({ ...good[0], id: 'row-' + i })), expectedVersion: 2 },
    ];
    for (const body of mutations) expect((await request('accounting', '_unbound', 'fixture-owner', '', body)).status).toBe(400);
    expect((await (await request()).json()).record.version).toBe(2);
  });
  it('distinguishes corrupt persisted state from an empty worksheet and refuses overwrite', async () => {
    const key = 'finance_local_worksheet:' + createHash('sha256').update(JSON.stringify(['corrupt-user','personal','','accounting','_unbound'])).digest('hex');
    writeSetting(key, '{invalid'); expect((await request('accounting', '_unbound', 'corrupt-user')).status).toBe(503);
    expect((await request('accounting', '_unbound', 'corrupt-user', '', { rows: rows('accounting'), expectedVersion: 0 })).status).toBe(503);
  });
  it('rejects an oversized UTF-8 worksheet even when every cell and row count is individually valid', async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ ...rows('accounting', '\u6570'.repeat(1000))[0], id: 'row-' + i }));
    expect(Buffer.byteLength(JSON.stringify(many), 'utf8')).toBeGreaterThan(1_500_000);
    const response = await request('accounting', '_unbound', 'large-user', '', { rows: many, expectedVersion: 0 }); expect(response.status).toBe(400);
    expect((await (await request('accounting', '_unbound', 'large-user')).json()).record).toBeNull();
  });
  it('rejects anonymous, viewer writes and revoked memberships despite forged role claims', async () => {
    expect((await fetch(base + '/api/business/finance-worksheets/accounting/_unbound')).status).toBe(401);
    expect((await request('accounting', workspace, 'fixture-viewer', org, { rows: rows('accounting'), expectedVersion: 0 })).status).toBe(403);
    expect((await request('accounting', workspace, 'fixture-viewer', org)).status).toBe(200);
    EDB.removeMember(org, 'fixture-viewer'); expect((await request('accounting', workspace, 'fixture-viewer', org)).status).toBe(403);
  });
  it('does not offer worksheet writes for excluded legal or unsupported modules', async () => {
    for (const entry of ['legal','tax-filing','report-delivery','unknown']) expect((await request(entry)).status).toBe(400);
  });
});
