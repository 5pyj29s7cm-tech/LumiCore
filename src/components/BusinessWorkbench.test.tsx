// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BusinessWorkbench } from './BusinessWorkbench';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), commerce: vi.fn() }));
const account = vi.hoisted(() => ({ user: { uid: 'business-a', role: 'user' } as { uid: string; role: string } | null, orgConnection: null as { orgId: string } | null, workbenchDrafts: new Map<string, unknown>() }));
vi.mock('@/contexts/AppContext', () => ({ useApp: () => account }));
vi.mock('./EcommerceAutomationWorkspace', () => ({ EcommerceAutomationWorkspace: (props: any) => { mocks.commerce(props); React.useEffect(() => props.onSnapshotChange(null), [props.onSnapshotChange]); return <div>Commerce {props.appId}<output>{props.snapshot?.label || 'No snapshot'}</output></div>; } }));
vi.mock('./FinanceWorkbench', () => ({ FinanceWorkbench: ({ initialWorkflowId }: any) => <div>Finance {initialWorkflowId}</div> }));
vi.mock('./ChatFilePreview', () => ({ ChatFilePreview: ({ file }: any) => <div role="dialog">Preview {file.fileName}</div> }));
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; }
const props = { lang: 'en', domain: 'personal' as const, onOpenSettings: vi.fn(), onOpenKnowledge: vi.fn(), onOpenSkills: vi.fn(), onOpenCreation: vi.fn(), onOpenDigitalHuman: vi.fn() };
const subject = (id: string) => ({ id, productLine: 'ecommerce', scopeId: account.orgConnection ? 'work:' + account.orgConnection.orgId : 'personal:' + account.user!.uid, name: id, attributes: {} });
const archive = (line: string) => ({ owner: account.user!.uid, line, tasks: [{ id: 'old', title: 'Historical report', result: 'Historical only' }], artifacts: [{ originalPath: 'D:/old/archived.xlsx', path: 'D:/private/hash.xlsx', sha256: 'a'.repeat(64) }] });
function baseFetch(url: string) {
  const route = new URL(url, 'http://synthetic.invalid').pathname;
  return Promise.resolve(reply(route === '/api/business/workspaces' ? { items: [subject('Store A')], active: { ecommerce: subject('Store A'), finance: null } }
    : route === '/api/industry/workflows' ? { tasks: [{ id: 'current', title: 'Current report', status: 'delivered', result: 'Verified balances', artifacts: [{ path: 'D:/reports/current.xlsx', status: 'verified' }] }] }
    : route === '/api/business/legacy' ? { items: [{ line: 'finance', tasks: 1 }] } : archive(route.split('/').at(-1)!)));
}
const writes = () => mocks.fetch.mock.calls.filter(([, init]) => init.method === 'POST');
beforeEach(() => { account.user = { uid: 'business-a', role: 'user' }; account.orgConnection = null; account.workbenchDrafts = new Map(); localStorage.clear(); mocks.commerce.mockReset(); mocks.fetch.mockReset().mockImplementation(baseFetch); vi.stubGlobal('fetch', mocks.fetch); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('shared business workbench', () => {
  it('restores commerce drafts across navigation and window reopening, with account-owned storage', async () => {
    const draft = { sources: { orders: { name: 'Private report' } } };
    const view = render(<BusinessWorkbench {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Commerce' })); await screen.findByText('Commerce store-data');
    act(() => mocks.commerce.mock.calls.at(-1)![0].onDraftChange(draft));
    fireEvent.click(screen.getByRole('button', { name: 'Social media' })); fireEvent.click(screen.getByRole('button', { name: 'Commerce' }));
    expect(mocks.commerce.mock.calls.at(-1)![0].draft).toBe(draft); view.unmount();
    const reopened = render(<BusinessWorkbench {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Commerce' })); await screen.findByText('Commerce store-data');
    expect(mocks.commerce.mock.calls.at(-1)![0].draft).toBe(draft);
    account.user = { uid: 'business-b', role: 'user' }; account.workbenchDrafts = new Map(); reopened.rerender(<BusinessWorkbench {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Commerce' })); await screen.findByText('Commerce store-data'); expect(mocks.commerce.mock.calls.at(-1)![0].draft).toBeUndefined();
  });
  it('switches business tools and previews current and imported artifacts from the same archive', async () => {
    const view = render(<BusinessWorkbench {...props} />);
    expect(screen.getByRole('button', { name: 'Social media', pressed: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Commerce' }));
    expect(await screen.findByText('Commerce store-data')).toBeTruthy();
    act(() => mocks.commerce.mock.calls.at(-1)![0].onSnapshotChange({ label: 'Stored snapshot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finance' }));
    expect(await screen.findByText('Finance business-dashboard')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Commerce' })); await screen.findByText('Commerce store-data');
    fireEvent.click(screen.getByRole('button', { name: 'Tasks & archive' }));
    expect(await screen.findByText('Current report')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finance · 1' }));
    expect(await screen.findByText('Historical report')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /archived.xlsx/ }));
    expect(screen.getByRole('dialog').textContent).toBe('Preview archived.xlsx');
    await waitFor(() => expect(screen.getByRole('button', { name: /current.xlsx/ })).toBeTruthy());
    account.user = { uid: 'business-b', role: 'user' }; view.rerender(<BusinessWorkbench {...props} />); expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByText('Historical report')).toBeNull();
    account.user = null; view.rerender(<BusinessWorkbench {...props} />); expect(view.container.textContent).toBe('');
  });

  it('retains denied drafts, confirms binding receipts and ignores old store snapshots', async () => {
    localStorage.setItem('lumi_auth_token', 'synthetic-token'); localStorage.setItem('lumi_desktop_session_proof', 'synthetic-proof');
    const view = render(<BusinessWorkbench {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Commerce' })); await screen.findByText('Commerce store-data');
    const oldCommerce = mocks.commerce.mock.calls.at(-1)![0], input = screen.getByRole('textbox', { name: 'Store or company name' }), form = input.closest('form')!, pending = deferred();
    fireEvent.change(input, { target: { value: ' New Store ' } }); mocks.fetch.mockReturnValueOnce(pending.promise); act(() => { fireEvent.submit(form); fireEvent.submit(form); }); expect(writes()).toHaveLength(1);
    const init = writes()[0][1]; expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-token'); expect(new Headers(init.headers).get('x-lumi-desktop-session')).toBe('synthetic-proof'); expect(JSON.parse(init.body)).toMatchObject({ productLine: 'ecommerce', name: 'New Store' }); expect(view.container.querySelector('fieldset')?.disabled).toBe(true);
    await act(async () => pending.resolve(reply({ error: 'Binding denied' }, 403))); await screen.findByRole('alert'); expect(input).toHaveProperty('value', ' New Store ');
    mocks.fetch.mockResolvedValueOnce(reply({ item: { ...subject('Wrong Store'), scopeId: 'personal:other' } })); fireEvent.submit(form); await screen.findByText('Workspace binding was not confirmed'); expect(input).toHaveProperty('value', ' New Store ');
    const count = mocks.fetch.mock.calls.length; mocks.fetch.mockResolvedValueOnce(reply({ item: subject('New Store') })); fireEvent.submit(form); await waitFor(() => expect(screen.getByRole('combobox', { name: 'Current store / company' })).toHaveProperty('value', 'New Store')); expect(mocks.fetch).toHaveBeenCalledTimes(count + 1); expect(input).toHaveProperty('value', '');
    act(() => mocks.commerce.mock.calls.at(-1)![0].onSnapshotChange({ label: 'New snapshot' })); act(() => oldCommerce.onSnapshotChange({ label: 'Obsolete snapshot' })); expect(screen.getByText('New snapshot')).toBeTruthy(); expect(screen.queryByText('Obsolete snapshot')).toBeNull();
  });

  it('cancels obsolete reads and writes across accounts and domains, and retries bad reads', async () => {
    const old = deferred(), obsolete = subject('Obsolete Store'); mocks.fetch.mockReturnValueOnce(old.promise); const view = render(<React.StrictMode><BusinessWorkbench {...props} /></React.StrictMode>), signal = mocks.fetch.mock.calls[0][1].signal;
    account.user = { uid: 'business-b', role: 'user' }; view.rerender(<BusinessWorkbench {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Commerce' })); await screen.findByText('Commerce store-data');
    await act(async () => old.resolve(reply({ items: [obsolete], active: { ecommerce: obsolete } }))); expect(signal.aborted).toBe(true); expect(screen.queryByRole('option', { name: /Obsolete Store/ })).toBeNull();
    const write = deferred(); mocks.fetch.mockReturnValueOnce(write.promise); fireEvent.change(screen.getByRole('textbox', { name: 'Store or company name' }), { target: { value: 'Late Store' } }); fireEvent.submit(view.container.querySelector('form')!); const writeSignal = writes().at(-1)![1].signal, late = subject('Late Store');
    account.orgConnection = { orgId: 'work-org' }; view.rerender(<BusinessWorkbench {...props} domain="work" />); await act(async () => write.resolve(reply({ item: late }))); expect(writeSignal.aborted).toBe(true);
    mocks.fetch.mockResolvedValueOnce(reply({ items: [], active: null })); fireEvent.click(screen.getByRole('button', { name: 'Commerce' })); await screen.findByRole('alert'); expect(screen.queryByRole('option', { name: /Late Store/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await waitFor(() => expect(screen.queryByRole('alert')).toBeNull()); expect(screen.getByRole('textbox', { name: 'Store or company name' })).toHaveProperty('value', '');
    fireEvent.click(screen.getByRole('button', { name: 'Tasks & archive' })); await screen.findByText('Current report'); expect(screen.queryByText('Retired edition history')).toBeNull();
  });

  it('serializes legacy import, rejects incomplete receipts and drops cached files on refresh', async () => {
    localStorage.setItem('lumi_desktop_session_proof', 'synthetic-proof'); render(<BusinessWorkbench {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Tasks & archive' })); await screen.findByText('Current report');
    const pending = deferred(), start = screen.getByRole('button', { name: 'Commerce · Import edition history' }); mocks.fetch.mockReturnValueOnce(pending.promise); act(() => { fireEvent.click(start); fireEvent.click(start); }); expect(writes()).toHaveLength(1); expect(new Headers(writes()[0][1].headers).get('x-lumi-desktop-session')).toBe('synthetic-proof');
    await act(async () => pending.resolve(reply({ line: 'ecommerce', tasks: 2 }))); await screen.findByText('Archive import was not confirmed'); expect(screen.queryByRole('button', { name: 'Commerce · 2' })).toBeNull();
    mocks.fetch.mockResolvedValueOnce(reply({ line: 'ecommerce', tasks: 2, persisted: true })); fireEvent.click(screen.getByRole('button', { name: 'Commerce · Import edition history' })); await screen.findByRole('button', { name: 'Commerce · 2' });
    mocks.fetch.mockResolvedValueOnce(reply({ ...archive('ecommerce'), owner: 'other-user' })); fireEvent.click(screen.getByRole('button', { name: 'Commerce · 2' })); await screen.findByText('Invalid business archive response'); expect(screen.queryByText('Historical report')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Commerce · 2' })); await screen.findByText('Historical report'); fireEvent.click(screen.getByRole('button', { name: /archived.xlsx/ })); expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await waitFor(() => expect(screen.queryByText('Historical report')).toBeNull()); expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('button', { name: /archived.xlsx/ })).toBeNull();
  });
});
