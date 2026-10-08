// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MobilePlatform } from '../src/platforms/mobile/MobilePlatform';
const mock = vi.hoisted(() => ({ runtime: vi.fn(), registration: { status: 'disconnected' } as any }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => null }));
vi.mock('../src/hooks/useVoiceCall', () => ({ useVoiceCall: () => ({ callState: 'idle', startCall: vi.fn(), endCall: vi.fn() }) }));
vi.mock('../src/hooks/useRuntimeStatus', () => ({ useRuntimeStatus: mock.runtime }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ workDomain: 'personal', orgConnection: null }) }));
vi.mock('../src/services/socketService', () => ({ socketService: { getDeviceRegistration: () => mock.registration, subscribeDeviceRegistration: () => () => {} } }));
afterEach(() => cleanup());
function mobile() { return render(<MobilePlatform t={{}} user={{ uid: 'synthetic', orgId: '' }} lang="en" setLang={vi.fn()} onLogin={vi.fn()} renderTabContent={() => null} />); }
it('shows unavailable runtime and disconnected device instead of fixed success or percentages', () => {
  mock.registration = { status: 'disconnected' }; mock.runtime.mockReturnValue({ status: null, loading: false, error: 'offline' });
  const view = mobile(); expect(view.getByText('Runtime state is temporarily unavailable')).toBeTruthy(); expect(view.getByText('Disconnected')).toBeTruthy();
  for (const fake of ['192.168.1.44', '98.2%', '42%', 'Local Shard Integrity Verified', 'Linked']) expect(view.container.textContent).not.toContain(fake);
  expect(mock.runtime).toHaveBeenLastCalledWith({ enabled: true, userId: 'synthetic', scopeKey: 'personal' });
});
it('projects real task counts and registration rejection', () => {
  mock.registration = { status: 'rejected', code: 'DESKTOP_SESSION_PROOF_REQUIRED' };
  mock.runtime.mockReturnValue({ loading: false, error: '', status: { level: 'attention', counts: { activeTasks: 2, waitingConfirmation: 1, blockedTasks: 4, durableBlocked: 0 }, attentionReasons: ['blocked_tasks'], tasks: [] } });
  const view = mobile(); expect(view.getByText('4')).toBeTruthy(); expect(view.getByText('2')).toBeTruthy(); expect(view.getAllByText('Needs attention')).toHaveLength(2); expect(view.getByRole('alert').textContent).toContain('identity verification needs renewal');
});
