// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ api: vi.fn(), fetch: vi.fn(), error: vi.fn(), user: { uid: 'one', username: 'Test', balance: 12 }, notifications: [] as any[], loading: false, loadError: '', refresh: vi.fn() }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: f.user, workDomain: 'personal', orgConnection: null, toolOverrides: {}, setToolOverride: vi.fn(), notifications: f.notifications, notificationsBusy: false, notificationsLoading: f.loading, notificationsError: f.loadError, refreshNotifications: f.refresh }) }));
vi.mock('../src/services/apiClient', () => ({ apiJson: (...a: any[]) => f.api(...a), apiFetch: (...a: any[]) => f.fetch(...a) }));
vi.mock('sonner', () => ({ toast: { error: f.error, success: vi.fn() } }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: 'en' }) }));
vi.mock('../src/components/AutonomousFeed', () => ({ AutonomousFeed: () => <div /> }));
import { ToolPanel } from '../src/components/ToolPanel';
import { Profile } from '../src/components/Profile';
import { Docs } from '../src/components/Docs';
import { ExecutionWorkQueue } from '../src/components/desktop/daily_plans';
import { NotificationCenter } from '../src/components/NotificationCenter';
const response = (data: any, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data });
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('fetch', f.fetch); f.user = { uid: 'one', username: 'Test', balance: 12 }; f.notifications = []; f.loading = false; f.loadError = ''; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('recoverable local settings reads', () => {
  it('retries a failed tools read and replaces the error with registered tools', async () => {
    f.api.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([{ name: 'local-tool', securityLevel: 'safe', description: 'Test', permission: 'read' }]);
    render(<ToolPanel t={{ langCode: 'en' }} />); await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('local-tool'); expect(screen.queryByRole('alert')).toBeNull(); expect(f.api).toHaveBeenCalledTimes(2);
  });
  it('retries health failure without presenting a false healthy result', async () => {
    f.fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response({ status: 'degraded' }));
    render(<Profile t={{ langCode: 'en' }} />); await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findAllByText('Degraded'); expect(screen.queryByRole('alert')).toBeNull(); expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it('labels docs fallback after failed remote loading and retries it', async () => {
    f.fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response({ title: 'Recovered docs', sections: [] }));
    render(<Docs t={{ langCode: 'en' }} />); await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Recovered docs'); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('does not disguise initial plan read failure as an empty queue and retries', async () => {
    f.fetch.mockResolvedValueOnce(response({}, false)).mockResolvedValueOnce(response({ plans: [{ id: 'p1', title: 'Recovered plan', source: 'lumi', status: 'active' }] }));
    render(<ExecutionWorkQueue t={{ langCode: 'en' }} />); await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Recovered plan'); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('shows later active plans instead of silently truncating at eight', async () => {
    f.fetch.mockResolvedValue(response({ plans: Array.from({ length: 9 }, (_, i) => ({ id: 'p' + i, title: 'Plan ' + (i + 1), source: 'lumi', status: 'active' })) }));
    render(<ExecutionWorkQueue t={{ langCode: 'en' }} />); await screen.findByText('Plan 1'); fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Plan 9')).toBeTruthy(); expect(screen.queryByText('Plan 1')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Previous page' })); expect(screen.getByText('Plan 1')).toBeTruthy();
  });
  it('shows notification loading instead of an empty success state', () => {
    f.loading = true; render(<NotificationCenter />); expect(screen.getByRole('status').textContent).toContain('Loading'); expect(screen.queryByText('No notifications')).toBeNull();
  });
  it('exposes notification read error and invokes a separate retry', () => {
    f.loadError = 'offline'; render(<NotificationCenter />); expect(screen.getByRole('alert')).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(f.refresh).toHaveBeenCalledOnce(); expect(screen.queryByText('No notifications')).toBeNull();
  });
});
