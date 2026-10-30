// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FINANCE_WORKSHEET_COLUMNS, type FinanceWorksheetEntry, type FinanceWorksheetRow } from '../shared/finance_local_worksheet';
const f = vi.hoisted(() => ({ api: vi.fn(), uid: 'owner', domain: 'personal', orgId: '', record: null as any, role: 'user' }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: f.uid ? { uid: f.uid, role: f.role } : null, workDomain: f.domain,
  orgConnection: f.orgId ? { orgId: f.orgId, orgRole: 'member' } : null }) }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: f.api }));
import { FinanceLocalWorksheet, financeWorksheetCsv } from '../src/components/FinanceLocalWorksheet';
const scope = () => ({ userId: f.uid, domain: f.domain, orgId: f.domain === 'work' ? f.orgId : '' });
const response = (data: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const row = (entry: FinanceWorksheetEntry, value = 'Supplied input'): FinanceWorksheetRow => ({ id: 'row-1', cells: Object.fromEntries(FINANCE_WORKSHEET_COLUMNS[entry].map((key, index) => [key, index ? '' : value])), reviewStatus: 'pending' });
const record = (entryId: FinanceWorksheetEntry = 'business-dashboard', rows = [row(entryId)], version = 1, workspaceId = '_unbound') => ({ entryId, workspaceId, rows, version, updatedAt: '2026-10-30T10:00:00.000Z' });
const page = (entryId = 'business-dashboard', workspaceId?: string, lang = 'en') => <FinanceLocalWorksheet entryId={entryId} workspaceId={workspaceId} lang={lang} />;
const load = async () => { await screen.findByText('No source records yet. Add your own data to begin.'); };
const add = () => fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save worksheet' }));
const input = (label = 'Period') => screen.getByRole('textbox', { name: `Row 1 · ${label}` });
const writes = () => f.api.mock.calls.filter(([, init]) => init.method === 'PUT');
beforeEach(() => {
  f.uid = 'owner'; f.domain = 'personal'; f.orgId = ''; f.role = 'user'; f.record = null;
  f.api.mockReset().mockImplementation(async (url: string, init: any) => {
    if (init.method === 'PUT') {
      const entry = new URL(url, 'https://fixture').pathname.split('/').at(-2) as FinanceWorksheetEntry;
      const workspace = decodeURIComponent(new URL(url, 'https://fixture').pathname.split('/').at(-1)!);
      const body = JSON.parse(init.body); f.record = record(entry, body.rows, body.expectedVersion + 1, workspace);
      return response({ persisted: true, record: f.record, scope: scope() });
    }
    return response({ record: f.record, scope: scope() });
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(Object.keys(FINANCE_WORKSHEET_COLUMNS) as FinanceWorksheetEntry[])('edits, manually reviews, saves, reloads and deletes real rows in %s', async entry => {
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

it('initial read failure cannot overwrite a saved worksheet with an empty table', async () => {
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
  if (kind === 'wrong-entry') data.record.entryId = 'cash-risk';
  if (kind === 'wrong-workspace') data.record.workspaceId = 'foreign';
  if (kind === 'bad-version') data.record.version = 0;
  if (kind === 'missing-columns') delete data.record.rows[0].cells.notes;
  f.api.mockResolvedValueOnce(response(data)); render(page()); await screen.findByRole('alert');
  expect(screen.queryByDisplayValue('Supplied input')).toBeNull(); expect(writes()).toHaveLength(0);
  expect((screen.getByRole('button', { name: 'Save worksheet' }) as HTMLButtonElement).disabled).toBe(true);
});

it.each(['persisted-false', 'wrong-scope', 'wrong-entry', 'wrong-workspace', 'old-version', 'skipped-version', 'changed-cell', 'changed-review', 'extra-row'])('retains the draft and rejects a %s save receipt', async kind => {
  render(page()); await load(); add(); fireEvent.change(input(), { target: { value: 'My draft' } });
  f.api.mockImplementationOnce(async (_url: string, init: any) => {
    const next = record('business-dashboard', JSON.parse(init.body).rows), data: any = { persisted: true, record: next, scope: scope() };
    if (kind === 'persisted-false') data.persisted = false;
    if (kind === 'wrong-scope') data.scope.userId = 'foreign';
    if (kind === 'wrong-entry') next.entryId = 'cash-risk';
    if (kind === 'wrong-workspace') next.workspaceId = 'other';
    if (kind === 'old-version') next.version = 0;
    if (kind === 'skipped-version') next.version = 2;
    if (kind === 'changed-cell') next.rows[0].cells.period = 'Not my input';
    if (kind === 'changed-review') next.rows[0].reviewStatus = 'reviewed';
    if (kind === 'extra-row') next.rows.push({ ...row('business-dashboard'), id: 'extra' });
    return response(data);
  });
  save(); await screen.findByRole('alert'); expect(screen.getByDisplayValue('My draft')).toBeTruthy();
  expect(screen.queryByText('Saved and confirmed')).toBeNull(); expect(writes()).toHaveLength(1);
  expect((screen.getByRole('button', { name: 'Save worksheet' }) as HTMLButtonElement).disabled).toBe(true);
});

it('a 409 preserves edits; failed reload cannot clear them and successful explicit reload restores the saved version', async () => {
  render(page()); await load(); add(); fireEvent.change(input(), { target: { value: 'Unsaved draft' } });
  f.api.mockResolvedValueOnce(response({ error: 'version_conflict' }, 409)); save();
  expect((await screen.findByRole('alert')).textContent).toContain('saved version changed');
  f.api.mockResolvedValueOnce(response({ error: 'still saving' }, 409));
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved version (replace draft)' })); await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be loaded'));
  expect(screen.getByDisplayValue('Unsaved draft')).toBeTruthy();
  f.record = record('business-dashboard', [row('business-dashboard', 'Other saved data')], 3);
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved version (replace draft)' }));
  await screen.findByDisplayValue('Other saved data'); expect(screen.queryByDisplayValue('Unsaved draft')).toBeNull();
  expect(writes()).toHaveLength(1); expect(screen.getByText('Saved version 3')).toBeTruthy();
});

it.each(['account', 'domain', 'organization', 'workspace', 'entry'])('discards a late read after changing %s', async kind => {
  let finish!: (value: any) => void; f.api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(page()); const oldSignal = f.api.mock.calls[0][1].signal;
  let entry = 'business-dashboard', workspace: string | undefined;
  if (kind === 'account') f.uid = 'other';
  if (kind === 'domain') f.domain = 'work';
  if (kind === 'organization') { f.domain = 'work'; f.orgId = 'other'; }
  if (kind === 'workspace') workspace = 'other';
  if (kind === 'entry') entry = 'cash-risk';
  view.rerender(page(entry, workspace)); await load();
  await act(async () => finish(response({ scope: { userId: 'owner', domain: 'personal', orgId: '' }, record: record('business-dashboard', [row('business-dashboard', 'PRIVATE OLD DATA')]) })));
  expect(oldSignal.aborted).toBe(true); expect(screen.queryByDisplayValue('PRIVATE OLD DATA')).toBeNull();
});

it('a late save cannot populate another account and changing language does not discard an edit', async () => {
  const view = render(page()); await load(); add(); fireEvent.change(input(), { target: { value: 'Private draft' } });
  view.rerender(page('business-dashboard', undefined, 'zh'));
  expect(screen.getByDisplayValue('Private draft')).toBeTruthy(); expect(f.api).toHaveBeenCalledTimes(1);
  let finish!: (value: any) => void; f.api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: '保存工作表' })); const signal = writes()[0][1].signal;
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
  expect((screen.getByRole('button', { name: 'Save worksheet' }) as HTMLButtonElement).disabled).toBe(true);
});

it('downloads only current user input as quoted literal CSV without making a server write', async () => {
  const blobs: Blob[] = [], OriginalURL = URL;
  vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:fixture'; }); static revokeObjectURL = vi.fn(); });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(page()); await load(); add(); fireEvent.change(input(), { target: { value: '=1+1' } });
  fireEvent.change(input('Source'), { target: { value: 'Original "source"\nline' } });
  fireEvent.click(screen.getByRole('button', { name: 'Download current input as CSV' }));
  expect(click).toHaveBeenCalledOnce(); expect(blobs).toHaveLength(1); expect(writes()).toHaveLength(0);
  const csv = financeWorksheetCsv('business-dashboard', [{ ...row('business-dashboard', '=1+1'), cells: { ...row('business-dashboard').cells, period: '=1+1', metric: ' \t@SUM(1)', amount: '-42', currency: '+USD', source: 'Original "source"\nline', notes: '' } }, row('business-dashboard', '')], 'en');
  expect(csv).toContain('"\'=1+1"'); expect(csv).toContain('"\' \t@SUM(1)"'); expect(csv).toContain('"\'-42"'); expect(csv).toContain('"\'+USD"');
  expect(csv).toContain('"Original ""source""\nline"'); expect(csv.split('\r\n')).toHaveLength(2);
});

it('does not query for a signed-out user or unsupported finance entry', () => {
  f.uid = ''; const view = render(page()); expect(screen.getByText('Sign in to load your worksheet.')).toBeTruthy(); expect(f.api).not.toHaveBeenCalled();
  f.uid = 'owner'; view.rerender(page('tax-filing')); expect(f.api).not.toHaveBeenCalled();
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
  await act(async () => finish(response({ persisted: true, scope: scope(), record: record('business-dashboard', body.rows) })));
  expect(screen.getByText('Saved and confirmed')).toBeTruthy();
});
