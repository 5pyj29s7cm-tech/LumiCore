// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ api: vi.fn(), json: vi.fn(), run: vi.fn(), user: { uid: 'mount-owner', role: 'user' }, domain: 'personal', orgId: '' }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: f.user, workDomain: f.domain, orgConnection: f.orgId ? { orgId: f.orgId, orgRole: 'member' } : null, workbenchDrafts: new Map() }) }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: f.api, apiJson: f.json }));
vi.mock('../src/hooks/useIndustryWorkflow', () => ({ useIndustryWorkflow: () => ({ busy: false, taskId: '', text: '', status: '', error: '', history: { loading: false, loaded: false, error: '', items: [], cursor: null }, artifacts: [], run: f.run, stop: vi.fn(), reset: vi.fn(), loadHistory: vi.fn() }) }));
import { BusinessWorkbench } from '../src/components/BusinessWorkbench';
import { EcommerceAutomationWorkspace } from '../src/components/EcommerceAutomationWorkspace';
import type { EcommerceOutcomeId } from '../src/i18n/locales/ecommerceModules';
const callbacks = { onOpenSettings: vi.fn(), onOpenKnowledge: vi.fn(), onOpenSkills: vi.fn(), onOpenCreation: vi.fn(), onOpenDigitalHuman: vi.fn() };
beforeEach(() => {
  f.domain = 'personal'; f.orgId = ''; f.run.mockReset(); f.json.mockReset();
  f.api.mockReset().mockImplementation(async (url: string, init: any) => {
    const path = new URL(url, 'https://fixture').pathname.split('/'), boardId = path.at(-2), workspaceId = path.at(-1);
    const scope = { userId: 'mount-owner', domain: f.domain, orgId: f.orgId };
    return { ok: true, status: 200, json: async () => init.method === 'PUT'
      ? { persisted: true, scope, record: { boardId, workspaceId, rows: JSON.parse(init.body).rows, version: 1, updatedAt: '2026-10-30T00:00:00.000Z' } }
      : { scope, record: null } };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('social entry mounts an independently editable calendar without requiring a commerce subject lookup', async () => {
  f.json.mockRejectedValue(new Error('Commerce subject service unavailable'));
  render(<BusinessWorkbench section="social" lang="en" domain="personal" {...callbacks} />);
  await screen.findByText('No records yet. Add your own source data to begin.');
  fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Row 1 · Campaign' }), { target: { value: 'My real planning entry' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save records' })); await screen.findByText('Saved and confirmed');
  expect(f.json).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  expect(f.api.mock.calls.every(([url]) => url.includes('/local-boards/social-calendar/_unbound?'))).toBe(true);
  fireEvent.click(screen.getByText('Open AI Creation')); expect(callbacks.onOpenCreation).toHaveBeenCalledOnce();
});

it.each([
  ['trend-discovery', 'Recorded trend observations', 'Topic'],
  ['listing-automation', 'Product listing review records', 'SKU'],
  ['ai-customer-service', 'Customer service response drafts', 'Question'],
] as const)('%s mounts its own editable records and saves only to that active workspace', async (entry, title, column) => {
  render(<EcommerceAutomationWorkspace appId={entry as EcommerceOutcomeId} workspaceId="store-actual" lang="en" onOpenSettings={callbacks.onOpenSettings} />);
  await screen.findByText('No records yet. Add your own source data to begin.'); expect(screen.getByRole('heading', { name: title })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
  fireEvent.change(screen.getByRole('textbox', { name: `Row 1 · ${column}` }), { target: { value: 'Manually provided source' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save records' })); await screen.findByText('Saved and confirmed');
  expect(f.api.mock.calls.every(([url]) => url.includes(`/local-boards/${entry}/store-actual?`))).toBe(true);
  expect(f.run).not.toHaveBeenCalled(); expect(f.json).not.toHaveBeenCalled();
  expect(screen.getByText(/External execution is not implemented here/)).toBeTruthy();
});
