// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ uid: 'user-a', on: vi.fn(), off: vi.fn(), domain: 'personal', orgId: '', mode: 'assistant', setMode: vi.fn(), api: vi.fn(), plans: [] as any[] }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({
  user: { uid: mocks.uid }, workDomain: mocks.domain, orgConnection: mocks.orgId ? { connected: true, orgId: mocks.orgId } : null, operationMode: mocks.mode, setOperationMode: mocks.setMode,
}) }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: mocks.api }));
vi.mock('../src/services/socketService', () => ({ socketService: { connect: () => mocks } }));
import { CommandCenterPlanner } from '../src/components/CommandCenterPlanner';

const plan = { id: 'synthetic-plan', title: 'Research public standards', instruction: 'Summarize a public source.', kind: 'daily_task',
  cadence: 'daily', timeOfDay: '09:00', dayOfWeek: 1, dayOfMonth: 1, status: 'active', nextRunAt: '', lastRuntimeTaskId: '', updatedAt: '' };
beforeEach(() => {
  mocks.uid = 'user-a'; mocks.on.mockReset(); mocks.off.mockReset(); mocks.domain = 'personal'; mocks.orgId = ''; mocks.mode = 'assistant'; mocks.setMode.mockReset(); mocks.plans = [{ ...plan }];
  mocks.api.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      mocks.plans.push({ ...plan, id: 'new-plan', ...JSON.parse(String(init.body)) });
      return { ok: true, json: async () => ({ plan: mocks.plans.at(-1) }) };
    }
    return { ok: true, json: async () => url.endsWith('/plans') ? { plans: mocks.plans } : { items: [] } };
  });
});
afterEach(cleanup);

it.each(['chat', 'assistant', 'autonomous'])('saves and shows scheduled plans without a %s mode prerequisite', async mode => {
  mocks.mode = mode;
  const view = render(<CommandCenterPlanner isZh={false} conversationId="synthetic-conversation" onDiscuss={vi.fn()} />);
  await screen.findByText(plan.title);
  expect(view.container.querySelector('[data-command-center-mode-notice]')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Enable autonomous mode' })).toBeNull();
  expect(screen.getByText('Plan status: Enabled')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^New$/ }));
  fireEvent.change(screen.getByPlaceholderText('Plan title'), { target: { value: 'New research plan' } });
  fireEvent.change(screen.getByPlaceholderText('What should Lumi execute, advance, or report?'), { target: { value: 'Research a public source.' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await screen.findByText('New research plan');
  expect(mocks.api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(mocks.setMode).not.toHaveBeenCalled();
});

it('removes mode waiting labels when autonomous and does not label manual-only plans as waiting', async () => {
  mocks.mode = 'autonomous';
  const view = render(<CommandCenterPlanner isZh={false} conversationId="synthetic" onDiscuss={vi.fn()} />);
  await screen.findByText(plan.title);
  expect(view.container.querySelector('[data-command-center-waiting-mode]')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Enable autonomous mode' })).toBeNull();
  cleanup(); mocks.mode = 'assistant'; mocks.plans = [{ ...plan, cadence: 'none' }];
  const manual = render(<CommandCenterPlanner isZh={false} conversationId="synthetic" onDiscuss={vi.fn()} />);
  await screen.findByText(plan.title);
  expect(manual.container.querySelector('[data-command-center-waiting-mode]')).toBeNull();
  expect(mocks.setMode).not.toHaveBeenCalled();
});

it('shows blocked plan authorization and requires an explicit renew action', async () => {
  mocks.plans = [{ ...plan, status: 'paused', authorizationBlockedReason: 'membership_missing' }];
  render(<CommandCenterPlanner isZh={true} conversationId="synthetic" onDiscuss={vi.fn()} />);
  await screen.findByText(plan.title);
  expect(screen.getByText(/该计划缺少组织授权记录或成员权限已变化/)).toBeTruthy();
  expect((screen.getByRole('button', { name: /^立即执行$/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('计划状态: 已暂停')).toBeTruthy();
  expect(mocks.api.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '重新授权并恢复此计划' }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/command-center/plans/synthetic-plan', expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ reauthorize: true, status: 'active' }),
  })));
  expect(mocks.setMode).not.toHaveBeenCalled();
});

it.each([['Pause', 'PUT', { status: 'paused' }], ['Delete', 'DELETE', undefined]] as const)('keeps a plan after failed %s and ignores a late response after changing workspace', async (label, method, patch) => {
  let finish!: (value: any) => void;
  const view = render(<CommandCenterPlanner isZh={false} conversationId="synthetic" onDiscuss={vi.fn()} />);
  await screen.findByText(plan.title);
  mocks.api.mockImplementation(async (url: string, init?: RequestInit) => init?.method
    ? { ok: false, status: 403, json: async () => ({ error: 'denied' }) }
    : { ok: true, json: async () => url.endsWith('/plans') ? { plans: mocks.plans } : { items: [] } });
  fireEvent.click(screen.getByTitle(label));
  await waitFor(() => expect(screen.getByText('Task control failed')).toBeTruthy());
  expect(screen.getByText(plan.title)).toBeTruthy();
  expect(mocks.api).toHaveBeenCalledWith('/api/command-center/plans/synthetic-plan', expect.objectContaining({ method, body: patch ? JSON.stringify(patch) : undefined }));
  mocks.api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByTitle(label));
  mocks.domain = 'work'; mocks.orgId = 'another-org'; mocks.plans = [];
  view.rerender(<CommandCenterPlanner isZh={false} conversationId="other" onDiscuss={vi.fn()} />);
  await act(async () => { finish({ ok: false, status: 403, json: async () => ({ error: 'old-scope-error' }) }); });
  expect(screen.queryByText(plan.title)).toBeNull();
  expect(screen.queryByText('Task control failed')).toBeNull();
});

it.each(['account', 'organization', 'refresh'])('rejects obsolete %s plan snapshots and releases listeners', async change => {
  const pending: Array<(value: any) => void> = [];
  mocks.api.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const props = { isZh: false, conversationId: 'scope-test', onDiscuss: vi.fn() };
  const view = render(<CommandCenterPlanner {...props} />);
  await waitFor(() => expect(pending).toHaveLength(2));
  if (change === 'refresh') act(() => mocks.on.mock.calls.find(([event]) => event === 'autonomous:task_completed')![1]());
  else {
    if (change === 'account') mocks.uid = 'user-b'; else { mocks.domain = 'work'; mocks.orgId = 'org-b'; }
    view.rerender(<CommandCenterPlanner {...props} />);
  }
  await waitFor(() => expect(pending).toHaveLength(4));
  const response = (index: number, payload: unknown) => pending[index]({ ok: true, json: async () => payload });
  await act(async () => { response(2, { plans: [{ ...plan, title: 'Current plan', lastRuntimeTaskId: 'task-b' }] }); response(3, { items: [{ id: 'task-b', status: 'completed' }] }); });
  expect(screen.getByText('Current plan')).toBeTruthy();
  expect(view.container.querySelector('[data-command-center-plan-run-status]')?.textContent).toContain('Done');
  await act(async () => { response(0, { plans: [{ ...plan, title: 'Obsolete plan' }] }); response(1, { items: [] }); });
  expect(screen.queryByText('Obsolete plan')).toBeNull();
  expect(screen.getByText('Current plan')).toBeTruthy();
  view.unmount();
  act(() => mocks.on.mock.calls.at(-1)![1]());
  expect(pending).toHaveLength(4);
  expect(mocks.off.mock.calls).toEqual(mocks.on.mock.calls);
});
