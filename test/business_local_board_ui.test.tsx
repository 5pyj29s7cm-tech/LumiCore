// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LOCAL_OPERATIONS_BOARD_COLUMNS, type LocalOperationsBoardId, type LocalOperationsBoardRow } from '../shared/local_operations_board';
const f = vi.hoisted(() => ({ api: vi.fn(), uid: 'owner', domain: 'personal', orgId: '', record: null as any, role: 'user' }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: f.uid ? { uid: f.uid, role: f.role } : null, workDomain: f.domain,
  orgConnection: f.orgId ? { orgId: f.orgId, orgRole: 'member' } : null }) }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: f.api }));
import { BusinessLocalBoard, operationsBoardCsv } from '../src/components/BusinessLocalBoard';
const scope = () => ({ userId: f.uid, domain: f.domain, orgId: f.domain === 'work' ? f.orgId : '' });
const response = (data: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const row = (entry: LocalOperationsBoardId, value = 'Supplied input'): LocalOperationsBoardRow => ({ id: 'row-1', cells: Object.fromEntries(LOCAL_OPERATIONS_BOARD_COLUMNS[entry].map((key, index) => [key, index ? '' : value])), reviewStatus: 'pending' });
const record = (boardId: LocalOperationsBoardId = 'listing-automation', rows = [row(boardId)], version = 1, workspaceId = '_unbound') => ({ boardId, workspaceId, rows, version, updatedAt: '2026-10-30T10:00:00.000Z' });
const page = (boardId = 'listing-automation', workspaceId?: string, lang = 'en') => <BusinessLocalBoard boardId={boardId} workspaceId={workspaceId} lang={lang} />;
const load = async () => { await screen.findByText('No records yet. Add your own source data to begin.'); };
const add = () => fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save records' }));
const input = (label = 'SKU') => screen.getByRole('textbox', { name: `Row 1 · ${label}` });
const writes = () => f.api.mock.calls.filter(([, init]) => init.method === 'PUT');
beforeEach(() => {
  f.uid = 'owner'; f.domain = 'personal'; f.orgId = ''; f.role = 'user'; f.record = null;
  f.api.mockReset().mockImplementation(async (url: string, init: any) => {
    if (init.method === 'PUT') {
      const entry = new URL(url, 'https://fixture').pathname.split('/').at(-2) as LocalOperationsBoardId;
      const workspace = decodeURIComponent(new URL(url, 'https://fixture').pathname.split('/').at(-1)!);
      const body = JSON.parse(init.body); f.record = record(entry, body.rows, body.expectedVersion + 1, workspace);
      return response({ persisted: true, record: f.record, scope: scope() });
    }
    return response({ record: f.record, scope: scope() });
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(Object.keys(LOCAL_OPERATIONS_BOARD_COLUMNS) as LocalOperationsBoardId[])('edits, manually reviews, saves, reloads and deletes real rows in %s', async entry => {
  const view = render(page(entry)); await load(); add();
  const first = screen.getAllByRole('textbox')[0]; fireEvent.change(first, { target: { value: 'User supplied source' } });
  const status = screen.getByRole('combobox', { name: 'Row 1 · Review status' });
  expect((status as HTMLSelectElement).value).toBe('pending');
  fireEvent.change(status, { target: { value: 'reviewed' } });
  fireEvent.change(first, { target: { value: 'Corrected source' } }); expect((status as HTMLSelectElement).value).toBe('pending');
  fireEvent.change(status, { target: { value: 'reviewed' } }); save();
  await screen.findByText('Saved and confirmed'); expect(writes()).toHaveLength(1);
  expect(JSON.parse(writes()[0][1].body)).toMatchObject({ expectedVersion: 0, rows: [{ reviewStatus: 'reviewed' }] });
  expect(new URL(writes()[0][0], 'https://fixture').searchParams.get('userId')).toBe('owner');
  view.unmount(); render(page(entry)); await screen.findByDisplayValue('Corrected source');
  expect(screen.getByText('Saved version 1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Row 1 · Delete row' })); save();
  await screen.findByText('Saved and confirmed'); expect(f.record.rows).toEqual([]); expect(f.record.version).toBe(2);
});

it('initial read failure cannot overwrite a saved board with an empty table', async () => {
  f.api.mockResolvedValueOnce(response({ error: 'offline' }, 503)); render(page());
  await screen.findByRole('alert'); expect((screen.getByRole('button', { name: 'Add row' }) as HTMLButtonElement).disabled).toBe(true);
  save(); expect(writes()).toHaveLength(0);
  f.record = record(); fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
  await screen.findByDisplayValue('Supplied input'); expect(writes()).toHaveLength(0);
});

it.each(['missing-scope', 'wrong-user', 'wrong-domain', 'wrong-org', 'wrong-entry', 'wrong-workspace', 'bad-version', 'missing-columns'])('rejects a %s load receipt', async kind => {
  const data: any = { record: record(), scope: scope() };
  if (kind === 'missing-scope') delete data.scope;
  if (kind === 'wrong-user') data.scope.userId = 'foreign';
  if (kind === 'wrong-domain') data.scope.domain = 'work';
  if (kind === 'wrong-org') data.scope.orgId = 'foreign';
  if (kind === 'wrong-entry') data.record.boardId = 'ai-customer-service';
  if (kind === 'wrong-workspace') data.record.workspaceId = 'foreign';
  if (kind === 'bad-version') data.record.version = 0;
  if (kind === 'missing-columns') delete data.record.rows[0].cells.notes;
  f.api.mockResolvedValueOnce(response(data)); render(page()); await screen.findByRole('alert');
  expect(screen.queryByDisplayValue('Supplied input')).toBeNull(); expect(writes()).toHaveLength(0);
  expect((screen.getByRole('button', { name: 'Save records' }) as HTMLButtonElement).disabled).toBe(true);
});

it.each(['persisted-false', 'wrong-scope', 'wrong-entry', 'wrong-workspace', 'old-version', 'skipped-version', 'changed-cell', 'changed-review', 'extra-row'])('retains the draft and rejects a %s save receipt', async kind => {
  render(page()); await load(); add(); fireEvent.change(input(), { target: { value: 'My draft' } });
  f.api.mockImplementationOnce(async (_url: string, init: any) => {
    const next = record('listing-automation', JSON.parse(init.body).rows), data: any = { persisted: true, record: next, scope: scope() };
    if (kind === 'persisted-false') data.persisted = false;
    if (kind === 'wrong-scope') data.scope.userId = 'foreign';
    if (kind === 'wrong-entry') next.boardId = 'ai-customer-service';
    if (kind === 'wrong-workspace') next.workspaceId = 'other';
    if (kind === 'old-version') next.version = 0;
    if (kind === 'skipped-version') next.version = 2;
    if (kind === 'changed-cell') next.rows[0].cells.sku = 'Not my input';
    if (kind === 'changed-review') next.rows[0].reviewStatus = 'reviewed';
    if (kind === 'extra-row') next.rows.push({ ...row('listing-automation'), id: 'extra' });
    return response(data);
  });
  save(); await screen.findByRole('alert'); expect(screen.getByDisplayValue('My draft')).toBeTruthy();
  expect(screen.queryByText('Saved and confirmed')).toBeNull(); expect(writes()).toHaveLength(1);
  expect((screen.getByRole('button', { name: 'Save records' }) as HTMLButtonElement).disabled).toBe(true);
});

it('a 409 preserves edits; failed reload cannot clear them and successful explicit reload restores the saved version', async () => {
  render(page()); await load(); add(); fireEvent.change(input(), { target: { value: 'Unsaved draft' } });
  f.api.mockResolvedValueOnce(response({ error: 'version_conflict' }, 409)); save();
  expect((await screen.findByRole('alert')).textContent).toContain('saved version changed');
  f.api.mockResolvedValueOnce(response({ error: 'still saving' }, 409));
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved version (replace draft)' })); await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be loaded'));
  expect(screen.getByDisplayValue('Unsaved draft')).toBeTruthy();
  f.record = record('listing-automation', [row('listing-automation', 'Other saved data')], 3);
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved version (replace draft)' }));
  await screen.findByDisplayValue('Other saved data'); expect(screen.queryByDisplayValue('Unsaved draft')).toBeNull();
  expect(writes()).toHaveLength(1); expect(screen.getByText('Saved version 3')).toBeTruthy();
});

it.each(['account', 'domain', 'organization', 'workspace', 'entry'])('discards a late read after changing %s', async kind => {
  let finish!: (value: any) => void; f.api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(page()); const oldSignal = f.api.mock.calls[0][1].signal;
  let entry = 'listing-automation', workspace: string | undefined;
  if (kind === 'account') f.uid = 'other';
  if (kind === 'domain') f.domain = 'work';
  if (kind === 'organization') { f.domain = 'work'; f.orgId = 'other'; }
  if (kind === 'workspace') workspace = 'other';
  if (kind === 'entry') entry = 'ai-customer-service';
  view.rerender(page(entry, workspace)); await load();
  await act(async () => finish(response({ scope: { userId: 'owner', domain: 'personal', orgId: '' }, record: record('listing-automation', [row('listing-automation', 'PRIVATE OLD DATA')]) })));
  expect(oldSignal.aborted).toBe(true); expect(screen.queryByDisplayValue('PRIVATE OLD DATA')).toBeNull();
});

it('a late save cannot populate another account and changing language does not discard an edit', async () => {
  const view = render(page()); await load(); add(); fireEvent.change(input(), { target: { value: 'Private draft' } });
  view.rerender(page('listing-automation', undefined, 'zh'));
  expect(screen.getByDisplayValue('Private draft')).toBeTruthy(); expect(f.api).toHaveBeenCalledTimes(1);
  let finish!: (value: any) => void; f.api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: '保存记录' })); const signal = writes()[0][1].signal;
  f.uid = 'other'; view.rerender(page()); await load();
  await act(async () => finish(response({ persisted: true, scope: { userId: 'owner', domain: 'personal', orgId: '' }, record: record() })));
  expect(signal.aborted).toBe(true); expect(screen.queryByDisplayValue('Private draft')).toBeNull(); expect(screen.queryByText('Saved and confirmed')).toBeNull();
});

it('times out read and write requests, releases busy state, and never automatically repeats a write', async () => {
  vi.useFakeTimers(); f.api.mockImplementationOnce(() => new Promise(() => {})); render(page());
  await act(async () => { await vi.advanceTimersByTimeAsync(10_001); }); expect(screen.getByRole('alert')).toBeTruthy();
  expect(f.api.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }))); add(); fireEvent.change(input(), { target: { value: 'Held draft' } });
  f.api.mockImplementationOnce(() => new Promise(() => {})); save();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
  expect(writes()[0][1].signal.aborted).toBe(true); expect(writes()).toHaveLength(1); expect(screen.getByDisplayValue('Held draft')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save records' }) as HTMLButtonElement).disabled).toBe(true);
});

it('downloads only current user input as quoted literal CSV without making a server write', async () => {
  const blobs: Blob[] = [], OriginalURL = URL;
  vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:fixture'; }); static revokeObjectURL = vi.fn(); });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(page()); await load(); add(); fireEvent.change(input(), { target: { value: '=1+1' } });
  fireEvent.change(input('Source'), { target: { value: 'Original "source"\nline' } });
  fireEvent.click(screen.getByRole('button', { name: 'Download current input as CSV' }));
  expect(click).toHaveBeenCalledOnce(); expect(blobs).toHaveLength(1); expect(writes()).toHaveLength(0);
  const csv = operationsBoardCsv('listing-automation', [{ ...row('listing-automation', '=1+1'), cells: { ...row('listing-automation').cells, sku: '=1+1', platform: ' \t@SUM(1)', title: '-42', price: '+USD', source: 'Original "source"\nline', notes: '' } }, row('listing-automation', '')], 'en');
  expect(csv).toContain('"\'=1+1"'); expect(csv).toContain('"\' \t@SUM(1)"'); expect(csv).toContain('"\'-42"'); expect(csv).toContain('"\'+USD"');
  expect(csv).toContain('"Original ""source""\nline"'); expect(csv.split('\r\n')).toHaveLength(2);
});

it('does not query for a signed-out user or unsupported board', () => {
  f.uid = ''; const view = render(page()); expect(screen.getByText('Sign in to load your records.')).toBeTruthy(); expect(f.api).not.toHaveBeenCalled();
  f.uid = 'owner'; view.rerender(page('tax-filing')); expect(f.api).not.toHaveBeenCalled();
});

const detailedRow = (board: LocalOperationsBoardId, id: string, cells: Record<string, string>): LocalOperationsBoardRow => ({ ...row(board, ''), id, cells: { ...row(board, '').cells, ...cells } });
it('social calendar is independent of commerce workspaces and totals only valid manual values within its sorted date range', async () => {
  f.record = record('social-calendar', [
    detailedRow('social-calendar', 'later', { date: '2026-11-02', campaign: 'Later activity', views: '20', interactions: '-2' }),
    detailedRow('social-calendar', 'early', { date: '2026-10-30', campaign: 'Earlier activity', views: '12', interactions: '3' }),
    detailedRow('social-calendar', 'invalid', { date: '2026-02-30', campaign: 'Invalid date', views: '999', interactions: '999' }),
    detailedRow('social-calendar', 'empty', { date: '2026-11-03', campaign: 'Manual empty metrics', views: '', interactions: '=10' }),
    detailedRow('social-calendar', 'zero', { date: '2026-11-04', campaign: 'Zero metrics', views: '0', interactions: '0' }),
  ]);
  render(page('social-calendar', 'must-not-bind-social')); const calendar = await screen.findByRole('region', { name: 'Schedule by date' });
  expect(new URL(f.api.mock.calls[0][0], 'https://fixture').pathname).toBe('/api/business/local-boards/social-calendar/_unbound');
  expect(within(calendar).getAllByRole('listitem').map(li => li.querySelector('time')!.dateTime)).toEqual(['2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04']);
  expect(within(calendar).getByText('Views: 32 · 3 valid manual value(s)')).toBeTruthy();
  expect(within(calendar).getByText('Interactions: 3 · 2 valid manual value(s)')).toBeTruthy();
  expect(within(calendar).queryByText('Invalid date')).toBeNull(); expect(screen.getByDisplayValue('Invalid date')).toBeTruthy();
  fireEvent.change(within(calendar).getByLabelText('From date'), { target: { value: '2026-11-01' } });
  fireEvent.change(within(calendar).getByLabelText('To date'), { target: { value: '2026-11-02' } });
  expect(within(calendar).getAllByRole('listitem')).toHaveLength(1); expect(within(calendar).getByText('Views: 20 · 1 valid manual value(s)')).toBeTruthy();
  expect(within(calendar).getByText('Interactions: Unavailable · 0 valid manual value(s)')).toBeTruthy();
  fireEvent.change(within(calendar).getByLabelText('From date'), { target: { value: '2026-12-01' } });
  expect(within(calendar).getByRole('alert').textContent).toContain('start date'); expect(within(calendar).queryByRole('listitem')).toBeNull();
  fireEvent.click(within(calendar).getByRole('button', { name: 'Clear filters' })); expect(within(calendar).getAllByRole('listitem')).toHaveLength(4);
  expect(writes()).toHaveLength(0);
});

it('manual invalid and overflowing metrics never show fabricated numeric totals', async () => {
  f.record = record('social-calendar', [detailedRow('social-calendar', 'a', { date: '2026-10-30', views: '9'.repeat(308), interactions: 'NaN' }), detailedRow('social-calendar', 'b', { date: '2026-10-30', views: '9'.repeat(308), interactions: 'Infinity' })]);
  render(page('social-calendar')); const calendar = await screen.findByRole('region', { name: 'Schedule by date' });
  expect(within(calendar).getByText('Views: Unavailable · 2 valid manual value(s)')).toBeTruthy();
  expect(within(calendar).getByText('Interactions: Unavailable · 0 valid manual value(s)')).toBeTruthy();
});

it('trend observations show only actual valid records sorted by date, with independent topic, metric and unit filters', async () => {
  const tr = (id: string, cells: Record<string, string>) => detailedRow('trend-discovery', id, { date: '2026-10-30', topic: 'Tea', metric: 'Demand', unit: 'orders', value: '12', source: id, ...cells });
  f.record = record('trend-discovery', [tr('later', { date: '2026-11-02', value: '21' }), tr('early', { value: '12' }), tr('other-unit', { unit: 'USD', value: '50' }), tr('other-metric', { metric: 'Returns', value: '-2' }), tr('other-topic', { topic: 'Coffee', value: '4' }), tr('invalid-number', { value: '1e3' }), tr('invalid-date', { date: '2026-02-30' }), tr('missing-unit', { unit: '' })]);
  render(page('trend-discovery')); const trend = await screen.findByRole('region', { name: 'Trend observations by date' });
  expect(within(trend).getAllByRole('row')).toHaveLength(6); expect(within(trend).queryByText('invalid-number')).toBeNull();
  for (const [name, value] of [['Topic', 'Tea'], ['Metric', 'Demand'], ['Unit', 'orders']]) fireEvent.change(within(trend).getByRole('combobox', { name }), { target: { value } });
  const cells = within(trend).getAllByRole('row').slice(1).map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.textContent));
  expect(cells).toEqual([['2026-10-30', 'Tea', 'Demand', 'orders', '12', 'early'], ['2026-11-02', 'Tea', 'Demand', 'orders', '21', 'later']]);
  expect(within(trend).getByText(/3 row\(s\) lack/)).toBeTruthy();
  fireEvent.change(within(trend).getByRole('combobox', { name: 'Unit' }), { target: { value: 'USD' } });
  expect(within(trend).getAllByRole('row')).toHaveLength(2); expect(within(trend).getByText('50')).toBeTruthy();
  fireEvent.click(within(trend).getByRole('button', { name: 'Clear filters' })); expect(within(trend).getAllByRole('row')).toHaveLength(6);
  expect(writes()).toHaveLength(0);
});

it('empty trends do not fabricate a chart, and unsaved input enters the trend view only when date, value and labels are valid', async () => {
  render(page('trend-discovery')); await load(); const trend = screen.getByRole('region', { name: 'Trend observations by date' });
  expect(within(trend).queryByRole('table')).toBeNull(); expect(trend.querySelector('svg')).toBeNull(); add();
  for (const [name, value] of [['Date', '2026-10-30'], ['Topic', 'Tea'], ['Metric', 'Stock'], ['Value', '0']]) fireEvent.change(input(name), { target: { value } });
  expect(within(trend).queryByRole('table')).toBeNull(); fireEvent.change(input('Unit'), { target: { value: 'boxes' } });
  expect(within(trend).getByRole('table')).toBeTruthy(); expect(within(trend).getByText('0')).toBeTruthy();
  expect(screen.getByText(/Unsaved edits/)).toBeTruthy(); expect(writes()).toHaveLength(0);
});

it('draws separate date-scaled series for each exact topic, metric and unit using only the recorded values', async () => {
  const tr = (id: string, date: string, value: string, unit: string, topic = 'Tea', metric = 'Demand') => detailedRow('trend-discovery', id, { date, value, topic, metric, unit, source: id });
  f.record = record('trend-discovery', [tr('a', '2026-10-01', '10', 'orders'), tr('b', '2026-10-02', '20', 'orders'), tr('c', '2026-10-05', '15', 'orders'), tr('usd-a', '2026-10-01', '-5', 'USD'), tr('usd-b', '2026-10-05', '5', 'USD'), tr('coffee', '2026-10-01', '999', 'orders', 'Coffee'), tr('returns', '2026-10-01', '7', 'orders', 'Tea', 'Returns')]);
  render(page('trend-discovery')); const trend = await screen.findByRole('region', { name: 'Trend observations by date' });
  expect(within(trend).getAllByRole('img')).toHaveLength(2);
  const orders = within(trend).getByRole('img', { name: 'Manual observation series: Tea · Demand · orders' });
  const dollars = within(trend).getByRole('img', { name: 'Manual observation series: Tea · Demand · USD' });
  expect(orders.querySelector('polyline')!.getAttribute('points')).toBe('40,120 105,20 300,70');
  expect(dollars.querySelector('polyline')!.getAttribute('points')).toBe('40,120 300,20');
  expect(Array.from(orders.querySelectorAll('circle title')).map(n => n.textContent)).toEqual(['2026-10-01: 10 orders · a', '2026-10-02: 20 orders · b', '2026-10-05: 15 orders · c']);
  expect(within(trend).getAllByText(/A line chart requires/)).toHaveLength(2);
  fireEvent.change(within(trend).getByRole('combobox', { name: 'Unit' }), { target: { value: 'USD' } });
  expect(within(trend).getAllByRole('img')).toHaveLength(1); expect(within(trend).queryByRole('img', { name: /orders/ })).toBeNull();
});

it('does not connect ambiguous same-date values or an overflowing range, while retaining their exact source table', async () => {
  const tr = (id: string, date: string, value: string, topic: string) => detailedRow('trend-discovery', id, { date, value, topic, metric: 'Demand', unit: 'units', source: id });
  const huge = '9' + '0'.repeat(307);
  f.record = record('trend-discovery', [tr('same-a', '2026-10-01', '1', 'Same date'), tr('same-b', '2026-10-01', '2', 'Same date'), tr('later', '2026-10-02', '3', 'Same date'), tr('large-a', '2026-10-01', huge, 'Large range'), tr('large-b', '2026-10-02', '-' + huge, 'Large range')]);
  render(page('trend-discovery')); const trend = await screen.findByRole('region', { name: 'Trend observations by date' });
  expect(within(trend).queryByRole('img')).toBeNull(); expect(within(trend).getByText(/A line chart requires/)).toBeTruthy();
  expect(within(trend).getByText(/numeric range cannot be plotted/)).toBeTruthy(); expect(within(trend).getAllByRole('row')).toHaveLength(6);
  expect(within(trend).getByText(huge)).toBeTruthy(); expect(within(trend).getByText('-' + huge)).toBeTruthy();
});

it('work scope is explicit in reads and writes and reviewed remains a manual status, never an external execution receipt', async () => {
  f.domain = 'work'; f.orgId = 'org-1'; render(page('ai-customer-service', 'store-1')); await load(); add();
  fireEvent.change(input('Question'), { target: { value: 'Where is my order?' } });
  fireEvent.change(input('Response draft'), { target: { value: 'A manually proposed reply, not sent.' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Row 1 · Review status' }), { target: { value: 'reviewed' } }); save();
  await screen.findByText('Saved and confirmed');
  for (const [url] of f.api.mock.calls) expect(Object.fromEntries(new URL(url, 'https://fixture').searchParams)).toEqual({ userId: 'owner', domain: 'work', orgId: 'org-1' });
  expect(f.api.mock.calls).toHaveLength(2); expect(writes()).toHaveLength(1); expect(f.record.rows[0].reviewStatus).toBe('reviewed');
  expect(screen.getByText(/External execution is not implemented here/)).toBeTruthy();
});
it('rejects oversized cell data before PUT and allows correction without losing the rest of the row', async () => {
  render(page()); await load(); add(); fireEvent.change(input('Source'), { target: { value: 'Actual source reference' } });
  fireEvent.change(input(), { target: { value: 'x'.repeat(2001) } }); save();
  expect(screen.getByRole('alert').textContent).toContain('invalid or oversized'); expect(writes()).toHaveLength(0);
  fireEvent.change(input(), { target: { value: '2026-10' } }); save(); await screen.findByText('Saved and confirmed');
  expect(f.record.rows[0].cells.source).toBe('Actual source reference');
});
it('serializes a save and does not accept a success receipt until the durable response arrives', async () => {
  render(page()); await load(); add(); fireEvent.change(input(), { target: { value: 'Draft' } });
  let finish!: (value: any) => void; f.api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => { save(); save(); }); expect(writes()).toHaveLength(1);
  expect(screen.queryByText('Saved and confirmed')).toBeNull();
  const body = JSON.parse(writes()[0][1].body);
  await act(async () => finish(response({ persisted: true, scope: scope(), record: record('listing-automation', body.rows) })));
  expect(screen.getByText('Saved and confirmed')).toBeTruthy();
});
