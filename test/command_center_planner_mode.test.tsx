// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mode: 'assistant', setMode: vi.fn(), api: vi.fn(), plans: [] as any[] }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({
  workDomain: 'personal', orgConnection: null, operationMode: mocks.mode, setOperationMode: mocks.setMode,
}) }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: mocks.api }));
vi.mock('../src/services/socketService', () => ({ socketService: { connect: () => ({ on: vi.fn(), off: vi.fn() }) } }));
import { CommandCenterPlanner } from '../src/components/CommandCenterPlanner';

const plan = { id: 'synthetic-plan', title: 'Research public standards', instruction: 'Summarize a public source.', kind: 'daily_task',
  cadence: 'daily', timeOfDay: '09:00', dayOfWeek: 1, dayOfMonth: 1, status: 'active', nextRunAt: '', lastRuntimeTaskId: '', updatedAt: '' };
beforeEach(() => {
  mocks.mode = 'assistant'; mocks.setMode.mockReset(); mocks.plans = [{ ...plan }];
  mocks.api.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      mocks.plans.push({ ...plan, id: 'new-plan', ...JSON.parse(String(init.body)) });
      return { ok: true, json: async () => ({ plan: mocks.plans.at(-1) }) };
    }
    return { ok: true, json: async () => url.endsWith('/plans') ? { plans: mocks.plans } : { items: [] } };
  });
});
afterEach(cleanup);

it('explains the mode requirement, permits saving a plan, and changes mode only on an explicit click', async () => {
  render(<CommandCenterPlanner isZh={false} conversationId="synthetic-conversation" onDiscuss={vi.fn()} />);
  expect(await screen.findByText('Automatic execution is waiting for autonomous mode.')).toBeTruthy();
  expect(screen.getByText('Plan status: Enabled')).toBeTruthy();
  expect(screen.getByText('Not run yet')).toBeTruthy();
  expect(screen.getByText(/current mode does not run scheduled tasks automatically/)).toBeTruthy();
  expect(mocks.setMode).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /^New$/ }));
  fireEvent.change(screen.getByPlaceholderText('Plan title'), { target: { value: 'New research plan' } });
  fireEvent.change(screen.getByPlaceholderText('What should Lumi execute, advance, or report?'), { target: { value: 'Research a public source.' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await screen.findByText('Plan saved. Automatic execution is waiting for autonomous mode.');
  expect(mocks.api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(mocks.setMode).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Enable autonomous mode' }));
  expect(mocks.setMode).toHaveBeenCalledExactlyOnceWith('autonomous');
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
