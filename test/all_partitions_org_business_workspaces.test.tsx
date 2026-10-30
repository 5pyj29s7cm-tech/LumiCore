// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EcommerceAutomationWorkspace } from '../src/components/EcommerceAutomationWorkspace';
import { FinanceWorkbench } from '../src/components/FinanceWorkbench';
import { ecommerceModuleCommonCopy, ecommerceModuleCopy } from '../src/i18n/locales/ecommerceModules';
import { financeModuleCopy } from '../src/i18n/locales/financeModules';
import { financeDeliveryFormCopy } from '../src/i18n/locales/financeDeliveryForm';
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: 'synthetic-partition-owner', role: 'user' }, workDomain: 'personal', orgConnection: null }) }));

// Real components, hook and HTTP client. Only the transport is synthetic; no model,
// business account, external connector or production API is invoked by this file.
const requests: Array<{ url: string; init: RequestInit; body: any }> = [];
const respond = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
function stream(data: object) {
  return { ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)); controller.close();
  } }) };
}
let nextStatus = 'delivered';
beforeEach(() => {
  requests.length = 0; nextStatus = 'delivered'; localStorage.clear();
  localStorage.setItem('lumi_auth_token', 'synthetic-partition-owner');
  localStorage.setItem('lumi_desktop_session_proof', 'synthetic-partition-proof');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, init, body });
    if (url.endsWith('/api/version')) return respond({ version: 'fixture-version' });
    if (url.endsWith('/contracts')) return respond({ contracts: [{ productLine: 'finance' }] });
    if (url.includes('/business/local-boards/') || url.includes('/business/finance-worksheets/')) return respond({ record: null, scope: { userId: 'synthetic-partition-owner', domain: 'personal', orgId: '' } });
    if (url.endsWith('/finance-delivery')) return respond({ ok: true, persisted: true, status: 'verified', task: { id: 'fixture-task', result: 'Synthetic finance review only' }, artifacts: [] });
    if (url.includes('/api/chat?')) return stream({ done: true, text: 'Synthetic review result', industryWorkflow: { status: nextStatus } });
    if (url.endsWith('/api/industry/workflows')) return respond({ task: { id: 'fixture-task' }, handoffPrompt: 'Fixture-only handoff', contract: { entryId: body.entryId } });
    throw new Error('Unexpected test transport: ' + url);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const created = () => requests.filter(item => item.url.endsWith('/api/industry/workflows'));
const executions = () => requests.filter(item => item.url.includes('/api/chat?'));

describe('current commerce partition entry contracts', () => {
  it.each(['today-operations', 'trend-discovery', 'listing-automation', 'ai-customer-service'] as const)('%s sends its own source and review boundary through the real workflow client', async entry => {
    const settings = vi.fn(); const copy = ecommerceModuleCopy('en', entry);
    render(<EcommerceAutomationWorkspace appId={entry} lang="en" onOpenSettings={settings} />);
    expect(screen.getByRole('heading', { name: copy.title })).toBeTruthy();
    const start = screen.getByRole('button', { name: ecommerceModuleCommonCopy('en').start });
    expect(start).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: `  Synthetic ${entry} source; review only.  ` } });
    fireEvent.click(start); await screen.findByText('Synthetic review result');
    expect(created()).toHaveLength(1); expect(executions()).toHaveLength(1);
    expect(created()[0].body).toMatchObject({ entryId: entry, source: 'ecommerce_workspace', sourceInput: `Synthetic ${entry} source; review only.` });
    expect(executions()[0].body).toMatchObject({ industryWorkflowTaskId: 'fixture-task', industryWorkflowSourceInput: `Synthetic ${entry} source; review only.` });
    const prompt = executions()[0].body.messages[0].content;
    expect(prompt).toContain(copy.prompt); expect(prompt).toContain(copy.confirmation);
    expect(requests.every(item => /\/api\/(industry\/workflows|chat\?)/.test(item.url)
      || (!item.init.method && item.url.includes(`/api/business/local-boards/${entry}/_unbound?`)))).toBe(true);
    expect(requests.filter(item => item.url.includes('/local-boards/'))).toHaveLength(entry === 'today-operations' ? 0 : 1);
    fireEvent.click(screen.getByRole('button', { name: ecommerceModuleCommonCopy('en').openConnections })); expect(settings).toHaveBeenCalledTimes(1);
  });
  it('store-data uses the real importer and preserves its source snapshot without starting a model', () => {
    const snapshot = vi.fn();
    render(<EcommerceAutomationWorkspace appId="store-data" lang="en" onOpenSettings={vi.fn()} onSnapshotChange={snapshot} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'order_id,sku,paid_amount,product_cost\nO-1,SKU-1,100,40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze pasted data' }));
    expect(screen.getByText('Pasted data')).toBeTruthy();
    expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({ sources: expect.arrayContaining([expect.objectContaining({ kind: 'orders', rowCount: 1 })]) }));
    expect(requests).toEqual([]);
  });
  it('does not promote a blocked product-management response into a delivered action', async () => {
    nextStatus = 'blocked';
    render(<EcommerceAutomationWorkspace appId="listing-automation" lang="en" onOpenSettings={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Synthetic SKU with missing authorization' } });
    fireEvent.click(screen.getByRole('button', { name: ecommerceModuleCommonCopy('en').start }));
    await screen.findByText('blocked'); expect(screen.queryByText('delivered')).toBeNull();
    expect(created()).toHaveLength(1); expect(executions()).toHaveLength(1);
    expect(requests.filter(item => item.url.includes('/local-boards/listing-automation/_unbound?') && !item.init.method)).toHaveLength(1);
    expect(requests).toHaveLength(3);
  });
});

describe('current finance partition entry contracts', () => {
  it.each(['business-dashboard', 'invoice-tax', 'accounting', 'cash-risk'])('%s binds the selected module, source and idempotency key without external delivery', async entry => {
    const copy = financeModuleCopy('en', entry)!;
    render(<FinanceWorkbench lang="en" domain="work" initialWorkflowId={entry} onOpenKnowledge={vi.fn()} onOpenSkills={vi.fn()} />);
    expect(screen.getByRole('heading', { name: copy.title })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: `Synthetic ${entry} figures; do not post or send.` } });
    fireEvent.click(screen.getByRole('button', { name: copy.startLabel }));
    await screen.findByText('Synthetic review result');
    expect(created()).toHaveLength(1); expect(executions()).toHaveLength(1);
    expect(created()[0].body).toMatchObject({ entryId: entry, source: 'finance_workbench', idempotencyKey: expect.any(String) });
    expect(created()[0].body.sourceInput).toContain(`Synthetic ${entry} figures; do not post or send.`);
    expect(executions()[0].body.messages[0].content).toContain(`Synthetic ${entry} figures; do not post or send.`);
    expect(requests.some(item => item.url.endsWith('/finance-delivery'))).toBe(false);
    expect(new Headers(created()[0].init.headers).get('Authorization')).toBe('Bearer synthetic-partition-owner');
  });
  it.each(['tax-filing', 'report-delivery'])('%s refuses incomplete structured input and routes complete decimals to deterministic delivery', async entry => {
    const form = financeDeliveryFormCopy('en', entry)!; const copy = financeModuleCopy('en', entry)!;
    render(<FinanceWorkbench lang="en" domain="personal" initialWorkflowId={entry} onOpenKnowledge={vi.fn()} onOpenSkills={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: copy.startLabel }));
    expect(screen.getAllByText(form.requiredHint).length).toBeGreaterThan(0); expect(created()).toEqual([]);
    const values: Record<string, string> = { period: '2026-10', jurisdiction: 'CN', taxpayerType: 'Synthetic taxpayer', dueDate: '2026-11-15', taxes: 'VAT, income tax', currency: 'CNY', revenue: '100.01', deductibleCost: '40.01', deductibleExpense: '10.00', incomeTaxRate: '0.25', businessType: 'Synthetic service', dataSummary: 'Synthetic balanced statement only', totalAssets: '100.01', totalLiabilities: '40.01', totalEquity: '60.00' };
    for (const field of form.fields.filter(field => field.required)) fireEvent.change(screen.getByLabelText(field.label, { exact: false }), { target: { value: values[field.name] } });
    fireEvent.click(screen.getByRole('button', { name: copy.startLabel })); await screen.findByText('Synthetic finance review only');
    expect(created()).toHaveLength(1); expect(executions()).toEqual([]);
    const delivery = requests.find(item => item.url.endsWith('/finance-delivery'))!;
    expect(delivery.body.financeInput).toMatchObject(entry === 'tax-filing' ? { revenue: '100.01', deductibleCost: '40.01', incomeTaxRate: '0.25', taxes: ['VAT', 'income tax'] } : { statement: { totalAssets: '100.01', totalLiabilities: '40.01', totalEquity: '60.00' } });
    await waitFor(() => expect(screen.getByText('verified')).toBeTruthy());
  });
});
