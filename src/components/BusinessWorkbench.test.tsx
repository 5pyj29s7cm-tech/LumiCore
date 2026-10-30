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
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; }
const props = { lang: 'en', domain: 'personal' as const, onOpenSettings: vi.fn(), onOpenKnowledge: vi.fn(), onOpenSkills: vi.fn(), onOpenCreation: vi.fn(), onOpenDigitalHuman: vi.fn() };
const subject = (id: string) => ({ id, productLine: 'ecommerce', scopeId: account.orgConnection ? 'work:' + account.orgConnection.orgId : 'personal:' + account.user!.uid, name: id, attributes: {} });
function baseFetch(url: string) {
  const route = new URL(url, 'http://synthetic.invalid').pathname;
  if (route === '/api/business/local-boards/social-calendar/_unbound') return Promise.resolve(reply({ record: null, scope: { userId: account.user!.uid, domain: 'personal', orgId: '' } }));
  if (route !== '/api/business/workspaces') throw new Error('Unexpected business request: ' + route);
  return Promise.resolve(reply({ items: [subject('Store A')], active: { ecommerce: subject('Store A'), finance: null } }));
}
const writes = () => mocks.fetch.mock.calls.filter(([, init]) => init.method === 'POST');
beforeEach(() => { account.user = { uid: 'business-a', role: 'user' }; account.orgConnection = null; account.workbenchDrafts = new Map(); localStorage.clear(); mocks.commerce.mockReset(); mocks.fetch.mockReset().mockImplementation(baseFetch); vi.stubGlobal('fetch', mocks.fetch); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('shared business workbench', () => {
  it('restores commerce drafts across navigation and window reopening, with account-owned storage', async () => {
    const draft = { sources: { orders: { name: 'Private report' } } };
    const view = render(<BusinessWorkbench {...props} section="ecommerce" />); await screen.findByText('Commerce store-data');
    act(() => mocks.commerce.mock.calls.at(-1)![0].onDraftChange(draft));
    view.rerender(<BusinessWorkbench {...props} section="social" />); view.rerender(<BusinessWorkbench {...props} section="ecommerce" />); await screen.findByText('Commerce store-data');
    expect(mocks.commerce.mock.calls.at(-1)![0].draft).toBe(draft); view.unmount();
    const reopened = render(<BusinessWorkbench {...props} section="ecommerce" />); await screen.findByText('Commerce store-data');
    expect(mocks.commerce.mock.calls.at(-1)![0].draft).toBe(draft);
    account.user = { uid: 'business-b', role: 'user' }; account.workbenchDrafts = new Map(); reopened.rerender(<BusinessWorkbench {...props} section="ecommerce" />);
    await screen.findByText('Commerce store-data'); expect(mocks.commerce.mock.calls.at(-1)![0].draft).toBeUndefined();
    account.user = null; reopened.rerender(<BusinessWorkbench {...props} section="ecommerce" />); expect(reopened.container.textContent).toBe('');
  });
  it.each([['social', 'Social media'], ['ecommerce', 'Commerce'], ['finance', 'Finance']] as const)('opens the direct %s workspace without archive UI or archive list requests', async (section, title) => {
    render(<BusinessWorkbench {...props} section={section} />);
    expect(screen.getByRole('heading', { name: title, level: 2 })).toBeTruthy();
    if (section === 'ecommerce') await screen.findByText('Commerce store-data');
    else if (section === 'finance') await screen.findByText('Finance business-dashboard');
    else await act(async () => {});
    expect(screen.queryByText('Tasks & archive')).toBeNull(); expect(screen.queryByText('Retired edition history')).toBeNull();
    expect(mocks.fetch.mock.calls.map(([url]) => new URL(url, 'http://synthetic.invalid').pathname)).toEqual([section === 'social' ? '/api/business/local-boards/social-calendar/_unbound' : '/api/business/workspaces']);
    expect(writes()).toHaveLength(0);
  });
  it('retains social creation links and finance workflow selection through their direct sections', async () => {
    const view = render(<BusinessWorkbench {...props} section="social" />);
    await act(async () => {});
    fireEvent.click(screen.getByText('Open AI Creation')); expect(props.onOpenCreation).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('Open knowledge base')); expect(props.onOpenKnowledge).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('Open Memory Territory')); expect(props.onOpenDigitalHuman).toHaveBeenCalledOnce();
    view.rerender(<BusinessWorkbench {...props} section="finance" />); await screen.findByText('Finance business-dashboard');
    fireEvent.click(screen.getByRole('button', { name: 'Report delivery' })); expect(await screen.findByText('Finance report-delivery')).toBeTruthy();
  });

  it('retains denied drafts, confirms binding receipts and ignores old store snapshots', async () => {
    localStorage.setItem('lumi_auth_token', 'synthetic-token'); localStorage.setItem('lumi_desktop_session_proof', 'synthetic-proof');
    const view = render(<BusinessWorkbench {...props} section="ecommerce" />); await screen.findByText('Commerce store-data');
    const oldCommerce = mocks.commerce.mock.calls.at(-1)![0], input = screen.getByRole('textbox', { name: 'Store or company name' }), form = input.closest('form')!, pending = deferred();
    fireEvent.change(input, { target: { value: ' New Store ' } }); mocks.fetch.mockReturnValueOnce(pending.promise); act(() => { fireEvent.submit(form); fireEvent.submit(form); }); expect(writes()).toHaveLength(1);
    const init = writes()[0][1]; expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-token'); expect(new Headers(init.headers).get('x-lumi-desktop-session')).toBe('synthetic-proof'); expect(JSON.parse(init.body)).toMatchObject({ productLine: 'ecommerce', name: 'New Store' }); expect(view.container.querySelector('fieldset')?.disabled).toBe(true);
    await act(async () => pending.resolve(reply({ error: 'Binding denied' }, 403))); await screen.findByRole('alert'); expect(input).toHaveProperty('value', ' New Store ');
    mocks.fetch.mockResolvedValueOnce(reply({ item: { ...subject('Wrong Store'), scopeId: 'personal:other' } })); fireEvent.submit(form); await screen.findByText('Workspace binding was not confirmed'); expect(input).toHaveProperty('value', ' New Store ');
    const count = mocks.fetch.mock.calls.length; mocks.fetch.mockResolvedValueOnce(reply({ item: subject('New Store') })); await act(async () => { fireEvent.submit(form); }); await waitFor(() => expect(screen.getByRole('combobox', { name: 'Current store / company' })).toHaveProperty('value', 'New Store')); expect(mocks.fetch).toHaveBeenCalledTimes(count + 1); expect(input).toHaveProperty('value', '');
    act(() => mocks.commerce.mock.calls.at(-1)![0].onSnapshotChange({ label: 'New snapshot' })); act(() => oldCommerce.onSnapshotChange({ label: 'Obsolete snapshot' })); expect(screen.getByText('New snapshot')).toBeTruthy(); expect(screen.queryByText('Obsolete snapshot')).toBeNull();
  });

  it('cancels obsolete reads and writes across accounts and domains, and retries bad reads', async () => {
    const old = deferred(), obsolete = subject('Obsolete Store'); mocks.fetch.mockReturnValueOnce(old.promise); const view = render(<React.StrictMode><BusinessWorkbench {...props} section="ecommerce" /></React.StrictMode>), signal = mocks.fetch.mock.calls[0][1].signal;
    account.user = { uid: 'business-b', role: 'user' }; view.rerender(<BusinessWorkbench {...props} section="ecommerce" />); await screen.findByText('Commerce store-data');
    await act(async () => old.resolve(reply({ items: [obsolete], active: { ecommerce: obsolete } }))); expect(signal.aborted).toBe(true); expect(screen.queryByRole('option', { name: /Obsolete Store/ })).toBeNull();
    const write = deferred(); mocks.fetch.mockReturnValueOnce(write.promise); fireEvent.change(screen.getByRole('textbox', { name: 'Store or company name' }), { target: { value: 'Late Store' } }); fireEvent.submit(view.container.querySelector('form')!); const writeSignal = writes().at(-1)![1].signal, late = subject('Late Store');
    account.orgConnection = { orgId: 'work-org' }; mocks.fetch.mockResolvedValueOnce(reply({ items: [], active: null })); view.rerender(<BusinessWorkbench {...props} section="ecommerce" domain="work" />); await act(async () => write.resolve(reply({ item: late }))); expect(writeSignal.aborted).toBe(true);
    await screen.findByRole('alert'); expect(screen.queryByRole('option', { name: /Late Store/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await waitFor(() => expect(screen.queryByRole('alert')).toBeNull()); expect(screen.getByRole('textbox', { name: 'Store or company name' })).toHaveProperty('value', '');
    expect(screen.queryByText('Retired edition history')).toBeNull();
  });
});
