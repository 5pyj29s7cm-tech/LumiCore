// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ api: vi.fn(), network: vi.fn() }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: 'synthetic-profile', username: 'Fixture', balance: 73.25 } }) }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: (...args: any[]) => f.api(...args) }));
vi.mock('motion/react', () => ({ motion: { div: ({ children, initial, animate, transition, whileHover, whileTap, ...props }: any) => <div {...props}>{children}</div> } }));
import { Profile } from '../src/components/Profile';
const copies = [
  { langCode: 'en', withdraw: 'Withdraw', topUp: 'Top Up', paymentUnavailable: 'Payments and withdrawals are not connected.', notCollected: 'Not collected', profile: 'Account profile' },
  { langCode: 'zh', withdraw: '提现', topUp: '充值', paymentUnavailable: '尚未接入充值与提现服务。', notCollected: '未采集', profile: '账号资料' },
];
beforeEach(() => { vi.resetAllMocks(); f.api.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'ok', process: { uptimeSec: 3600 }, database: { interactions: 12 } }) }); vi.stubGlobal('fetch', f.network); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each(copies)('disables unavailable payment actions with an explicit $langCode explanation and preserves real balance', async copy => {
  render(<Profile t={copy} />); const withdraw = screen.getByRole('button', { name: copy.withdraw }), topUp = screen.getByRole('button', { name: copy.topUp });
  expect(withdraw).toHaveProperty('disabled', true); expect(topUp).toHaveProperty('disabled', true);
  expect(screen.getByText(copy.paymentUnavailable)).toBeTruthy(); expect(screen.getByText('73.25')).toBeTruthy();
  fireEvent.click(withdraw); fireEvent.click(topUp); expect(f.network).not.toHaveBeenCalled();
  await screen.findByText('1h 0m'); expect(f.api.mock.calls.every(([url]) => url === '/api/health?details=1')).toBe(true);
});
it.each(copies)('uses explicit uncollected $langCode metrics and does not invent account verification or rank', async copy => {
  render(<Profile t={copy} />); expect(screen.queryByText('1.2 TB')).toBeNull(); expect(screen.queryByText('850 GFLOPS')).toBeNull();
  expect(screen.getAllByText(copy.notCollected)).toHaveLength(2); expect(screen.getByText(copy.profile)).toBeTruthy();
  for (const label of ['Verified Node', 'Level 12 Architect', 'Early Explorer']) expect(screen.queryByText(label)).toBeNull();
  await screen.findByText('1h 0m'); expect(screen.getByText('12')).toBeTruthy();
});
