// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useIndustryWorkflow } from '../src/hooks/useIndustryWorkflow';
import { IndustryWorkflowRecovery } from '../src/components/IndustryWorkflowRecovery';
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const fetcher = vi.fn();
const saved = { id: 'saved', title: 'Synthetic report', status: 'delivered', result: 'Saved exact result', metadata: { industryWorkflow: { entryId: 'report-delivery' }, financeDeliveryExecution: { artifacts: [] } } };
function Harness() { const flow = useIndustryWorkflow('report-delivery'); return <><button onClick={() => void flow.run({ entryId: 'report-delivery', source:'test', sourceInput:'synthetic', prompt:'local', financeInput:{ period:'fixture' } })}>Run</button><button onClick={() => void flow.stop()}>Stop</button><span>{flow.status}</span><p>{flow.text}</p><p>{flow.error}</p><IndustryWorkflowRecovery workflow={flow} lang="en" /></>; }
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('loads scoped saved tasks and restores results without executing or creating a task', async () => {
  fetcher.mockImplementation(async (url) => reply(url.includes('?entryId') ? { tasks: [saved], nextCursor:null } : {task:saved}));
  render(<Harness />); fireEvent.click(screen.getByText('Load saved tasks')); await screen.findByText(/View saved result: Synthetic report/);
  fireEvent.click(screen.getByText(/View saved result: Synthetic report/)); await screen.findByText('Saved exact result');
  expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls.every(([,init]) => !init.method || init.method === 'GET')).toBe(true);
});
it('preserves history error and provides explicit retry', async () => {
  fetcher.mockResolvedValueOnce(reply({error:'Denied'},403)).mockResolvedValueOnce(reply({tasks:[saved]}));
  render(<Harness />); fireEvent.click(screen.getByText('Load saved tasks')); await screen.findByRole('alert');
  fireEvent.click(screen.getByText('Retry loading')); await screen.findByText(/View saved result: Synthetic report/);
});
it('does not project a finance browser abort as confirmed cancellation and ignores stale delivery after acknowledgement', async () => {
  let deliver!: (value: unknown) => void, cancel!: (value: unknown) => void;
  fetcher.mockImplementation((url) => url.endsWith('/finance-delivery') ? new Promise(resolve=>{deliver=resolve;}) : url.endsWith('/finance-cancel') ? new Promise(resolve=>{cancel=resolve;}) : Promise.resolve(reply({ task:{id:'saved'}, handoffPrompt:'Bound',contract:{entryId:'report-delivery'} })));
  render(<Harness />); fireEvent.click(screen.getByText('Run')); await waitFor(()=>expect(deliver).toBeDefined());
  fireEvent.click(screen.getByText('Stop')); await screen.findByText('cancelling'); expect(screen.queryByText('cancelled')).toBeNull();
  await act(async()=>cancel(reply({ok:true,task:{...saved,status:'cancelled',result:''},status:'cancelled',cancelled:true,cancellationRequested:true})));
  await screen.findByText('cancelled');
  await act(async()=>deliver(reply({ok:true,persisted:true,status:'verified',task:{id:'saved'},artifacts:[]})));
  expect(screen.queryByText('verified')).toBeNull();
});
it('keeps a failed cancellation unconfirmed and retries the protected server request without creating another task', async () => {
  let cancelCount = 0;
  fetcher.mockImplementation((url) => url.endsWith('/finance-delivery') ? new Promise(() => {}) : url.endsWith('/finance-cancel') ? Promise.resolve(++cancelCount === 1
    ? reply({ error: 'Persistence unavailable' }, 503)
    : reply({ ok: true, task: { ...saved, status: 'cancelled', result: '' }, status: 'cancelled', cancelled: true, cancellationRequested: true }))
    : Promise.resolve(reply({ task: { id: 'saved' }, handoffPrompt: 'Bound', contract: { entryId: 'report-delivery' } })));
  render(<Harness />); fireEvent.click(screen.getByText('Run'));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith('/finance-delivery'))).toBe(true));
  fireEvent.click(screen.getByText('Stop')); await screen.findByText('cancellation_unconfirmed');
  fireEvent.click(screen.getByText('Retry server cancellation')); await screen.findByText('cancelled');
  expect(cancelCount).toBe(2);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/industry/workflows'))).toHaveLength(1);
});
it('downloads only through the authenticated task/hash route and keeps a denied file available for explicit retry', async () => {
  const hash = 'a'.repeat(64), artifact = { path: 'D:/synthetic/workbook.xlsx', basename: 'workbook.xlsx', size: 4, sha256: hash };
  const task = { ...saved, metadata: { ...saved.metadata, financeDeliveryExecution: { artifacts: [artifact] } } };
  let denied = true;
  const createUrl = vi.fn(() => 'blob:fixture'), revokeUrl = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fetcher.mockImplementation(async (url) => url.includes('/artifacts/')
    ? denied ? reply({ error: 'Permission revoked' }, 403) : { ...reply(null), blob: async () => new Blob(['data']) }
    : reply(url.includes('?entryId') ? { tasks: [task], nextCursor: null } : { task }));
  render(<Harness />); fireEvent.click(screen.getByText('Load saved tasks'));
  fireEvent.click(await screen.findByText(/View saved result: Synthetic report/));
  fireEvent.click(await screen.findByRole('button', { name: 'Download verified workbook' })); await screen.findByText(/Permission revoked/);
  expect(createUrl).not.toHaveBeenCalled(); denied = false;
  fireEvent.click(screen.getByRole('button', { name: 'Download verified workbook' })); await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  const calls = fetcher.mock.calls.filter(([url]) => url.includes('/artifacts/'));
  expect(calls).toHaveLength(2); expect(calls.every(([url, init]) => url.endsWith('/industry/workflows/saved/artifacts/' + hash) && init.credentials === 'include')).toBe(true);
  expect(fetcher.mock.calls.every(([, init]) => !init.method || init.method === 'GET')).toBe(true);
});
