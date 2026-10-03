// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EcommerceAutomationWorkspace } from './EcommerceAutomationWorkspace';
import { FinanceWorkbench } from './FinanceWorkbench';
import { financeDeliveryFormCopy } from '../i18n/locales/financeDeliveryForm';

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const started = (id: string, entryId: string) => reply({ task: { id }, handoffPrompt: 'Confirmed handoff', contract: { entryId } });
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; }
function stream(events: object[], close = true) {
  const cancel = vi.fn(), body = new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); if (close) controller.close(); }, cancel });
  return { ok: true, body, cancel };
}
const fetcher = vi.fn(), create = vi.fn(), execute = vi.fn(), deliver = vi.fn();
const financeProps = { lang: 'en', domain: 'personal' as const, onOpenKnowledge: vi.fn(), onOpenSkills: vi.fn() };
const page = (kind: string, next = false) => kind === 'commerce'
  ? <EcommerceAutomationWorkspace appId={next ? 'trend-discovery' : 'today-operations'} lang="en" onOpenSettings={() => {}} />
  : <FinanceWorkbench {...financeProps} initialWorkflowId={next ? 'cash-risk' : 'accounting'} />;
const startButton = () => screen.getByRole('button', { name: /^(Start with Lumi|Create task and hand off to Lumi)$/ });
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('lumi_auth_token', 'test-token'); localStorage.setItem('lumi_desktop_session_proof', 'test-proof');
  create.mockReset().mockImplementation(async (body) => started('current-task', body.entryId)); deliver.mockReset(); execute.mockReset().mockImplementation(async () => stream([{ done: true, text: 'Verified output', industryWorkflow: { status: 'delivered' } }]));
  fetcher.mockReset().mockImplementation((url, init) => {
    if (url.endsWith('/api/version')) return Promise.resolve(reply({ version: '3.1.0' }));
    if (url.endsWith('/contracts')) return Promise.resolve(reply({ contracts: [{ productLine: 'finance' }] }));
    const body = JSON.parse(init.body); return url.endsWith('/finance-delivery') ? deliver(body, init) : url.includes('/api/chat?') ? execute(body, init) : create(body, init);
  }); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['commerce', 'finance'])('%s owns creation, restart and stream cancellation across entry changes', async kind => {
  const old = deferred(), next = deferred(), output = stream([{ chunk: 'Current progress' }], false);
  create.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise); execute.mockResolvedValue(output);
  const view = render(<React.StrictMode>{page(kind)}</React.StrictMode>); fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Synthetic source' } });
  act(() => { fireEvent.click(startButton()); fireEvent.click(startButton()); }); await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('textbox')).toHaveProperty('disabled', true); const firstSignal = create.mock.calls[0][1].signal;
  fireEvent.click(screen.getByRole('button', { name: 'Stop this run' })); expect(firstSignal.aborted).toBe(true); expect(screen.getByText('interrupted')).toBeTruthy();
  fireEvent.click(startButton()); await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  await act(async () => old.resolve(started('obsolete-task', create.mock.calls[0][0].entryId))); expect(execute).not.toHaveBeenCalled(); expect(screen.getByRole('textbox')).toHaveProperty('disabled', true);
  await act(async () => next.resolve(started('current-task', create.mock.calls[1][0].entryId))); await screen.findByText('Current progress');
  expect(execute.mock.calls[0][0]).toMatchObject({ industryWorkflowTaskId: 'current-task' }); const executionSignal = execute.mock.calls[0][1].signal;
  view.rerender(<React.StrictMode>{page(kind, true)}</React.StrictMode>); await waitFor(() => expect(output.cancel).toHaveBeenCalledTimes(1));
  expect(executionSignal.aborted).toBe(true); expect(screen.queryByText('Current progress')).toBeNull(); expect(screen.getByRole('textbox')).toHaveProperty('value', ''); expect(output.body.locked).toBe(false);
});

it.each(['commerce', 'finance'])('%s retains failed drafts, retries explicitly and resets confirmed output on edits', async kind => {
  create.mockResolvedValueOnce(reply({ error: 'Start denied' }, 403)); render(page(kind)); fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Synthetic source' } });
  fireEvent.click(startButton()); await screen.findByText('Start denied'); expect(screen.getByRole('textbox')).toHaveProperty('value', 'Synthetic source'); expect(create).toHaveBeenCalledTimes(1);
  fireEvent.click(startButton()); await screen.findByText('Verified output'); expect(screen.getByText('delivered')).toBeTruthy(); expect(create).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0][0].messages[0].content).toContain('Confirmed handoff\n\n'); expect(execute.mock.calls[0][0].messages[0].content).toContain('Synthetic source');
  if (kind === 'finance') { expect(create.mock.calls[0][0].idempotencyKey).toBe(create.mock.calls[1][0].idempotencyKey); expect(screen.getByText('Local finance and tax runtime ready')).toBeTruthy(); }
  for (const [, init] of fetcher.mock.calls) { expect(init.credentials).toBe('include'); expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token'); expect(new Headers(init.headers).get('x-lumi-desktop-session')).toBe('test-proof'); }
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Changed source' } }); expect(screen.queryByText('Verified output')).toBeNull(); expect(screen.queryByText('Start denied')).toBeNull(); expect(screen.queryByText('current-task')).toBeNull();
});

it.each(['tax-filing', 'report-delivery'])('%s validates fields and preserves deterministic delivery and evidence', async entry => {
  const pending = deferred(); deliver.mockReturnValue(pending.promise); const view = render(<FinanceWorkbench {...financeProps} initialWorkflowId={entry} />);
  const form = financeDeliveryFormCopy('en', entry)!; fireEvent.click(startButton()); expect(screen.getAllByText(form.requiredHint).length).toBeGreaterThan(0); expect(create).not.toHaveBeenCalled();
  const values: Record<string, string> = { period: '2026-Q3', jurisdiction: 'CN', taxpayerType: 'General taxpayer', dueDate: '2026-10-15', taxes: 'VAT, income tax', currency: 'CNY', revenue: '300', deductibleCost: '100', deductibleExpense: '50', incomeTaxRate: '0.25', businessType: 'Software', dataSummary: 'Synthetic statement', totalAssets: '300', totalLiabilities: '100', totalEquity: '200' };
  for (const field of form.fields.filter(field => field.required)) fireEvent.change(screen.getByLabelText(field.label, { exact: false }), { target: { value: values[field.name] } });
  fireEvent.click(startButton()); await waitFor(() => expect(deliver).toHaveBeenCalledTimes(1)); expect(execute).not.toHaveBeenCalled();
  const data = deliver.mock.calls[0][0].financeInput; expect(data.period).toBe('2026-Q3'); expect(data.currency).toBe('CNY');
  expect(entry === 'tax-filing' ? data.taxes : data.statement).toEqual(entry === 'tax-filing' ? ['VAT', 'income tax'] : { totalAssets: '300', totalLiabilities: '100', totalEquity: '200' });
  await act(async () => pending.resolve(reply({ ok: true, persisted: true, status: 'verified', task: { id: 'current-task', result: 'Delivery confirmed' }, artifacts: [{ path: 'D:/synthetic/output.xlsx', sha256: 'abc' }] })));
  expect(screen.getByText('verified')).toBeTruthy(); expect(screen.getByText(/Delivery confirmed/).textContent).toContain('D:/synthetic/output.xlsx\nSHA-256 abc');
  const obsolete = deferred(); deliver.mockReturnValueOnce(obsolete.promise); fireEvent.click(startButton()); await waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
  view.rerender(<FinanceWorkbench {...financeProps} domain="work" initialWorkflowId={entry} />); expect(deliver.mock.calls[1][1].signal.aborted).toBe(true);
  await act(async () => obsolete.resolve(reply({ ok: true, persisted: true, status: 'verified', task: { id: 'current-task', result: 'Obsolete delivery' }, artifacts: [] })));
  expect(screen.queryByText(/Delivery confirmed|Obsolete delivery/)).toBeNull(); expect(screen.getByLabelText(form.fields[0].label, { exact: false })).toHaveProperty('value', '');
});

it('stops finance preparation before hashing can create a task', async () => {
  const pending = deferred(); vi.stubGlobal('crypto', { subtle: { digest: () => pending.promise } }); render(page('finance'));
  fireEvent.click(startButton()); fireEvent.click(screen.getByRole('button', { name: 'Stop this run' }));
  await act(async () => pending.resolve(new Uint8Array([1, 2]).buffer)); expect(create).not.toHaveBeenCalled(); expect(screen.getByText('interrupted')).toBeTruthy();
});

it('releases a timed out creation for explicit retry without replaying it', async () => {
  const deadline = new AbortController(), timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  create.mockImplementationOnce((_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  render(page('commerce')); fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Synthetic source' } }); fireEvent.click(startButton());
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1)); act(() => deadline.abort(new DOMException('Creation timed out', 'TimeoutError')));
  await screen.findByText(/Creation timed out/); expect(screen.getByText('blocked')).toBeTruthy(); expect(startButton()).toHaveProperty('disabled', false); expect(create).toHaveBeenCalledTimes(1);
  timeout.mockRestore(); fireEvent.click(startButton()); await screen.findByText('Verified output'); expect(create).toHaveBeenCalledTimes(2);
});
