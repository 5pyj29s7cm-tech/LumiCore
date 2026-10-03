// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EcommerceHub, type EcommerceWorkbenchDraft } from './EcommerceHub';
const calls = vi.hoisted(() => ({ start: vi.fn(), verify: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('../lib/industryWorkflowClient', () => ({ startIndustryWorkflow: calls.start, verifyIndustryWorkflow: calls.verify }));
vi.mock('sonner', () => ({ toast: calls }));
const csv = 'order_id,sku,paid_amount,product_cost\nO-1,SKU-1,100,40';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function paste() { fireEvent.change(screen.getByRole('textbox'), { target: { value: csv } }); fireEvent.click(screen.getByRole('button', { name: 'Analyze pasted data' })); }
beforeEach(() => { Object.values(calls).forEach(mock => mock.mockReset()); calls.verify.mockResolvedValue({ task: { id: 'archive-1' }, verification: { passed: true } }); });
afterEach(cleanup);

it('restores report rows, names, mappings and parameters as one draft after closing the view', () => {
  let draft: EcommerceWorkbenchDraft | undefined; const save = (value: EcommerceWorkbenchDraft) => { draft = value; };
  const view = render(<EcommerceHub lang="en" onDraftChange={save} />); paste();
  fireEvent.change(screen.getAllByRole('spinbutton', { hidden: true })[0], { target: { value: '42' } });
  expect(draft?.sources.orders?.name).toBe('Pasted data'); expect(draft?.sources.orders?.table.rows).toHaveLength(1); expect(draft?.grossMarginPercent).toBe(42);
  const saved = draft; view.unmount(); render(<EcommerceHub lang="en" draft={saved} onDraftChange={save} />);
  expect(screen.getByText('Pasted data')).toBeTruthy(); expect(screen.getAllByRole('spinbutton', { hidden: true })[0]).toHaveProperty('value', '42');
  expect(draft?.sources).toEqual(saved?.sources);
  fireEvent.click(screen.getByRole('button', { name: 'Clear all' })); expect(draft?.sources).toEqual({}); expect(draft?.archiveTaskId).toBe('');
});

it.each(['change-kind', 'unmount'] as const)('ignores a file read completed after %s', async mode => {
  const reading = deferred<string>(), changed = vi.fn(); const view = render(<EcommerceHub lang="en" onDraftChange={changed} />);
  const file = new File(['pending'], 'late.csv', { type: 'text/csv' }); Object.defineProperty(file, 'text', { value: () => reading.promise });
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  if (mode === 'unmount') view.unmount(); else fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
  const count = changed.mock.calls.length; await act(async () => reading.resolve(csv));
  expect(changed).toHaveBeenCalledTimes(count); expect(calls.success).not.toHaveBeenCalled(); expect(screen.queryByText('late.csv')).toBeNull();
});

it('cancels obsolete archival follow-up when the report changes and serializes double clicks', async () => {
  const pending = deferred<any>(); calls.start.mockReturnValueOnce(pending.promise);
  render(<EcommerceHub lang="en" />); paste(); calls.success.mockClear();
  const archive = screen.getByRole('button', { name: 'Verify & archive' }); act(() => { fireEvent.click(archive); fireEvent.click(archive); });
  expect(calls.start).toHaveBeenCalledOnce(); const signal = calls.start.mock.calls[0][1] as AbortSignal;
  fireEvent.click(screen.getByRole('button', { name: 'Clear all' })); expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve({ task: { id: 'obsolete' } })); expect(calls.verify).not.toHaveBeenCalled(); expect(calls.success).not.toHaveBeenCalled();
});

it('retains data when verification fails, then confirms an explicit successful retry', async () => {
  calls.start.mockResolvedValue({ task: { id: 'archive-1' } }); calls.verify.mockRejectedValueOnce(new Error('Archive not saved'));
  render(<EcommerceHub lang="en" />); paste(); calls.success.mockClear(); fireEvent.click(screen.getByRole('button', { name: 'Verify & archive' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Archive not saved'); expect(screen.getByText('Pasted data')).toBeTruthy(); expect(calls.success).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Verify & archive' })); expect(await screen.findByText('archive archive-1')).toBeTruthy(); expect(calls.success).toHaveBeenCalledOnce();
  expect(calls.verify.mock.calls.at(-1)![1]).toBe(calls.start.mock.calls.at(-1)![1]);
});
