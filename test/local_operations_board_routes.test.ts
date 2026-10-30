import './helpers';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import * as DB from '../db_layer';
import * as EDB from '../server/org/db';
import { writeSetting } from '../server/persistence/settings_repository';
import { bindIndustryWorkspaceContext } from '../server/industry/workspace_context';
import { mountLocalOperationsBoardRoutes } from '../server/routes/local_operations_board_routes';
import { LOCAL_OPERATIONS_BOARD_COLUMNS, type LocalOperationsBoardId, type LocalOperationsBoardRow } from '../shared/local_operations_board';

let base = '', cleanup = () => {}, org = '', commerce = '', finance = '';
const owner = 'local-board-owner';
const rows = (boardId: LocalOperationsBoardId, note = 'Synthetic user input'): LocalOperationsBoardRow[] => [{ id: 'row-1', cells: Object.fromEntries(LOCAL_OPERATIONS_BOARD_COLUMNS[boardId].map(key => [key, key === 'notes' ? note : ''])), reviewStatus: 'pending' }];
function request(boardId = 'social-calendar', workspaceId = '_unbound', userId = owner, orgId = '', body?: unknown, query?: Record<string, string>) {
  const token = jwt.sign({ uid: userId, username: userId, role: 'user', orgId, orgRole: 'owner' }, JWT_SECRET);
  const params = new URLSearchParams(query || { userId, domain: orgId ? 'work' : 'personal', orgId });
  return fetch(`${base}/api/business/local-boards/${boardId}/${workspaceId}?${params}`, { headers: { 'Content-Type': 'application/json', Cookie: 'token=' + token }, ...(body !== undefined ? { method: 'PUT', body: JSON.stringify(body) } : {}) });
}
beforeAll(async () => {
  const app = await makeApp(); base = app.url; cleanup = app.cleanup; mountLocalOperationsBoardRoutes(app.apiRouter);
  org = EDB.createOrg('Synthetic board organization', 'board-' + Date.now(), owner).id;
  EDB.addMember(org, owner, 'owner'); EDB.addMember(org, 'board-viewer', 'viewer'); EDB.addMember(org, 'board-member', 'member');
  commerce = bindIndustryWorkspaceContext({ userId: owner, domain: 'work', orgId: org }, { productLine: 'ecommerce', name: 'Synthetic store' }).id;
  finance = bindIndustryWorkspaceContext({ userId: owner, domain: 'work', orgId: org }, { productLine: 'finance', name: 'Synthetic entity' }).id;
});
afterEach(() => vi.restoreAllMocks()); afterAll(() => cleanup());

it.each(Object.keys(LOCAL_OPERATIONS_BOARD_COLUMNS) as LocalOperationsBoardId[])('stores exact %s manual records and restores them without performing any platform action', async boardId => {
  const input = rows(boardId, '=User literal, "quotes"\nsecond line'); input[0].reviewStatus = 'reviewed';
  const saved = await request(boardId, '_unbound', owner, '', { rows: input, expectedVersion: 0 });
  expect(saved.status).toBe(200); const body = await saved.json();
  expect(body).toMatchObject({ persisted: true, scope: { userId: owner, domain: 'personal', orgId: '' }, record: { boardId, workspaceId: '_unbound', rows: input, version: 1 } });
  expect(Number.isFinite(Date.parse(body.record.updatedAt))).toBe(true);
  expect((await (await request(boardId)).json()).record).toEqual(body.record);
});
it('separates users, organizations, domains, board types and registered ecommerce workspaces', async () => {
  expect((await (await request('trend-discovery', '_unbound', 'other-user')).json()).record).toBeNull();
  expect((await (await request('trend-discovery', '_unbound', owner, org)).json()).record).toBeNull();
  const body = { rows: rows('trend-discovery'), expectedVersion: 0 };
  expect((await request('trend-discovery', commerce, owner, org, body)).status).toBe(200);
  expect((await (await request('trend-discovery', commerce, 'board-member', org)).json()).record).toBeNull();
  expect((await (await request('listing-automation', commerce, owner, org)).json()).record).toBeNull();
  expect((await request('trend-discovery', commerce, owner)).status).toBe(404);
  expect((await request('trend-discovery', finance, owner, org, body)).status).toBe(404);
  expect((await request('social-calendar', commerce, owner, org)).status).toBe(404);
  expect((await request('social-calendar', commerce, owner, org, { rows: rows('social-calendar'), expectedVersion: 0 })).status).toBe(404);
});
it.each(['userId', 'domain', 'orgId', 'missing'])('rejects stale or missing scope query %s on reads and writes', async field => {
  const query: Record<string, string> = { userId: owner, domain: 'work', orgId: org };
  if (field === 'missing') delete query.userId; else query[field] = 'obsolete-scope';
  const body = { rows: rows('social-calendar'), expectedVersion: 0 };
  expect((await request('social-calendar', '_unbound', owner, org, undefined, query)).status).toBe(409);
  expect((await request('social-calendar', '_unbound', owner, org, body, query)).status).toBe(409);
  expect((await (await request('social-calendar', '_unbound', owner, org)).json()).record).toBeNull();
});
it('uses compare-and-swap for edits, preserves a stale draft conflict, and supports explicit empty-board save', async () => {
  const first = (await (await request()).json()).record;
  expect((await request('social-calendar', '_unbound', owner, '', { rows: rows('social-calendar', 'stale'), expectedVersion: 0 })).status).toBe(409);
  expect((await (await request()).json()).record).toEqual(first);
  const edited = rows('social-calendar', 'Reviewed manually'); edited[0].reviewStatus = 'reviewed';
  const saved = await request('social-calendar', '_unbound', owner, '', { rows: edited, expectedVersion: first.version });
  expect(saved.status).toBe(200); expect((await saved.json()).record).toMatchObject({ version: 2, rows: edited });
  expect((await request('social-calendar', '_unbound', owner, '', { rows: [], expectedVersion: 2 })).status).toBe(200);
  expect((await (await request()).json()).record).toMatchObject({ version: 3, rows: [] });
});
it('keeps pending revisions unreadable, rejects duplicate writers, rolls back failed durability and permits retry', async () => {
  let reject!: (reason: Error) => void; const barrier = new Promise<void>((_, fail) => { reject = fail; });
  const flush = vi.spyOn(DB, 'flushDBOrThrow').mockImplementationOnce(() => barrier);
  const payload = { rows: rows('listing-automation'), expectedVersion: 0 };
  const pending = request('listing-automation', '_unbound', 'pending-owner', '', payload);
  await vi.waitFor(() => expect(flush).toHaveBeenCalled());
  expect((await request('listing-automation', '_unbound', 'pending-owner')).status).toBe(409);
  expect((await request('listing-automation', '_unbound', 'pending-owner', '', payload)).status).toBe(409);
  expect((await (await request('listing-automation', '_unbound', 'separate-owner')).json()).record).toBeNull();
  reject(new Error('Synthetic durability failure')); expect((await pending).status).toBe(503);
  expect((await (await request('listing-automation', '_unbound', 'pending-owner')).json()).record).toBeNull();
  expect((await request('listing-automation', '_unbound', 'pending-owner', '', payload)).status).toBe(200);
});
it('preserves a previously confirmed nonempty version when a later save cannot become durable', async () => {
  const uid = 'prior-version-owner', board = 'ai-customer-service';
  const first = await request(board, '_unbound', uid, '', { rows: rows(board, 'Confirmed exact draft'), expectedVersion: 0 });
  expect(first.status).toBe(200); const prior = (await first.json()).record;
  vi.spyOn(DB, 'flushDBOrThrow').mockRejectedValueOnce(new Error('Synthetic disk failure'));
  const changed = rows(board, 'Unconfirmed overwrite'); changed[0].reviewStatus = 'reviewed';
  expect((await request(board, '_unbound', uid, '', { rows: changed, expectedVersion: 1 })).status).toBe(503);
  expect((await (await request(board, '_unbound', uid)).json()).record).toEqual(prior);
  expect((await request(board, '_unbound', uid, '', { rows: changed, expectedVersion: 1 })).status).toBe(200);
  expect((await (await request(board, '_unbound', uid)).json()).record).toMatchObject({ rows: changed, version: 2 });
});
const invalid = [
  ['missing-column', (r: any) => { delete r[0].cells.notes; return { rows: r, expectedVersion: 0 }; }],
  ['extra-column', (r: any) => { r[0].cells.arbitrary = 'x'; return { rows: r, expectedVersion: 0 }; }],
  ['non-string-cell', (r: any) => { r[0].cells.price = 12; return { rows: r, expectedVersion: 0 }; }],
  ['extra-row-key', (r: any) => { r[0].published = true; return { rows: r, expectedVersion: 0 }; }],
  ['duplicate-ids', (r: any) => ({ rows: [r[0], r[0]], expectedVersion: 0 })],
  ['invalid-review', (r: any) => { r[0].reviewStatus = 'published'; return { rows: r, expectedVersion: 0 }; }],
  ['long-cell', (r: any) => { r[0].cells.notes = 'x'.repeat(2001); return { rows: r, expectedVersion: 0 }; }],
  ['excess-rows', (r: any) => ({ rows: Array.from({ length: 1001 }, (_, i) => ({ ...r[0], id: 'row-' + i })), expectedVersion: 0 })],
  ['invalid-id', (r: any) => { r[0].id = '../wrong'; return { rows: r, expectedVersion: 0 }; }],
  ['string-version', (r: any) => ({ rows: r, expectedVersion: '0' })],
  ['negative-version', (r: any) => ({ rows: r, expectedVersion: -1 })],
  ['unsafe-version', (r: any) => ({ rows: r, expectedVersion: Number.MAX_SAFE_INTEGER })],
] as const;
it.each(invalid)('rejects %s without creating or replacing a board', async (_name, mutate) => {
  expect((await request('listing-automation', '_unbound', 'invalid-owner', '', mutate(rows('listing-automation')))).status).toBe(400);
  expect((await (await request('listing-automation', '_unbound', 'invalid-owner')).json()).record).toBeNull();
});
it('enforces the UTF-8 byte limit even when individual cells and rows are valid', async () => {
  const input = Array.from({ length: 501 }, (_, i) => ({ ...rows('listing-automation', '\u6570'.repeat(1000))[0], id: 'row-' + i }));
  expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBeGreaterThan(1_500_000);
  expect((await request('listing-automation', '_unbound', 'large-owner', '', { rows: input, expectedVersion: 0 })).status).toBe(400);
  expect((await (await request('listing-automation', '_unbound', 'large-owner')).json()).record).toBeNull();
});
it.each(['invalid-json', 'wrong-board', 'wrong-workspace', 'invalid-row', 'invalid-version'])('rejects corrupt persisted %s state without silently treating it as empty', async kind => {
  const uid = 'corrupt-' + kind, boardId = 'ai-customer-service';
  const key = 'scoped_local_board:' + createHash('sha256').update(JSON.stringify([uid, 'personal', '', boardId, '_unbound'])).digest('hex');
  const record: any = { boardId, workspaceId: '_unbound', rows: rows(boardId), version: 1, updatedAt: '2026-10-30T00:00:00Z' };
  if (kind === 'wrong-board') record.boardId = 'social-calendar';
  if (kind === 'wrong-workspace') record.workspaceId = 'another-store';
  if (kind === 'invalid-row') record.rows = 'bad';
  if (kind === 'invalid-version') record.version = 0;
  writeSetting(key, kind === 'invalid-json' ? '{bad-json' : JSON.stringify(record));
  expect((await request(boardId, '_unbound', uid)).status).toBe(503);
  expect((await request(boardId, '_unbound', uid, '', { rows: rows(boardId), expectedVersion: 0 })).status).toBe(503);
});
it('rechecks live viewer membership instead of trusting JWT role claims for reads and writes', async () => {
  expect((await fetch(base + '/api/business/local-boards/social-calendar/_unbound')).status).toBe(401);
  expect((await request('trend-discovery', commerce, 'board-viewer', org, { rows: rows('trend-discovery'), expectedVersion: 0 })).status).toBe(403);
  expect((await request('trend-discovery', commerce, 'board-viewer', org)).status).toBe(200);
  EDB.removeMember(org, 'board-viewer');
  expect((await request('trend-discovery', commerce, 'board-viewer', org)).status).toBe(403);
  expect((await request('trend-discovery', commerce, 'board-viewer', org, { rows: rows('trend-discovery'), expectedVersion: 0 })).status).toBe(403);
});
it('rejects unsupported board and foreign workspace identities without creating records', async () => {
  expect((await request('unsupported')).status).toBe(400);
  expect((await request('constructor')).status).toBe(400);
  expect((await request('trend-discovery', 'foreign-workspace')).status).toBe(404);
});
