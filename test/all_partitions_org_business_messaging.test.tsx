// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessagingHub } from '../src/components/MessagingHub';

// Both channel settings are real components; every transport result below is a
// synthetic fixture. The tests never configure or send through a real channel.
const ui = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), confirm: vi.fn() }));
vi.mock('sonner', () => ({ toast: ui }));
vi.mock('../src/lib/appConfirm', () => ({ useAppConfirm: () => ui.confirm }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key, formatUiMessage: (key: string) => key }));
const requests: Array<{ url: string; init: RequestInit }> = [];
let denied = true;
const reply = (data: object, status = 200) => ({ ok: status < 400, status, json: async () => data });
beforeEach(() => {
  Object.values(ui).forEach(mock => mock.mockReset()); requests.length = 0; denied = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/bindings/code')) return denied ? reply({ error: 'Synthetic permission denied' }, 403) : reply({ code: 'FIXTURE-ONLY-CODE', expiresAt: '2099-01-01T00:00:00Z' });
    if (url.endsWith('/bindings')) return reply({ bindings: [] });
    if (url === '/api/feishu/config') return reply({ enabled: false, appId: 'cli_synthetic', transport: 'long_connection' });
    if (url === '/api/wecom/config') return reply({ enabled: false, botId: 'bot_synthetic', hasBotSecret: true, mode: 'aibot_long_connection' });
    if (url.endsWith('/status')) return reply({ configured: false });
    throw new Error('Unexpected fixture request: ' + url);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['feishu', 'wecom'] as const)('%s tab loads its own configuration and waits for a successful binding receipt', async channel => {
  const view = render(<MessagingHub t={{ langCode: 'en', feishu: 'Feishu', wecom: 'WeCom' }} />);
  await screen.findByPlaceholderText('cli_xxxxxxxxxxxxxxxx');
  if (channel === 'wecom') {
    fireEvent.click(screen.getByRole('button', { name: 'WeCom' }));
    await screen.findByPlaceholderText('bot_...');
  }
  const prefix = channel === 'wecom' ? 'we-com-settings' : 'feishu-settings';
  const generate = () => screen.getByRole('button', { name: `${prefix}.generate-code.099ef173d3` });
  fireEvent.click(generate());
  await waitFor(() => expect(ui.error).toHaveBeenCalledWith('Synthetic permission denied'));
  expect(ui.success).not.toHaveBeenCalled(); expect(screen.queryByText(/FIXTURE-ONLY-CODE/)).toBeNull();
  denied = false; fireEvent.click(generate());
  await screen.findByText(/FIXTURE-ONLY-CODE/);
  const writes = requests.filter(item => item.init.method === 'POST');
  expect(writes.map(item => item.url)).toEqual([`/api/${channel}/bindings/code`, `/api/${channel}/bindings/code`]);
  for (const { init } of writes) { expect(init.credentials).toBe('include'); expect(JSON.parse(String(init.body))).toEqual({}); }
  expect(ui.success).toHaveBeenCalledTimes(1);
  expect(requests.every(item => /^\/api\/(feishu|wecom)\/(config|bindings|bindings\/code|status)$/.test(item.url))).toBe(true);
  view.unmount();
});
