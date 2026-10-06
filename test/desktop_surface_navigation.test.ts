import { desktopWindowCommand } from './desktop_window_harness';
import { expect, it, vi } from 'vitest';
import { extractSourceExpression } from './source_expression';

const source = 'src/components/DesktopUI.tsx';
function desktop(initial: Record<string, any> = {}) {
  const state: Record<string, any> = {
    activeTab: 'home', chatOpen: false, knowledgeOpen: false, memoryLabOpen: false,
    sanctuaryOpen: false, sanctuaryAgent: null, chatPrefill: null,
    openWindows: [], minimizedWindows: [], focusedWindow: null, viewMode: 'personal',
    isSearchOpen: false, isNotificationPanelOpen: false, isDesktopWidgetMode: false, nexusReturnTarget: 'home', ...initial,
  };
  const windowCommand = desktopWindowCommand(state);
  const scope = { userId: 'owner-a' };
  const refs = { surfaceReturnTargetRef: { current: 'home' }, memoryAvatarOpenGenerationRef: { current: 4 },
    memoryAvatarOwnerScope: scope, memoryAvatarOwnerRef: { current: scope }, memoryAvatarSurfaceGeneration: 4 };
  const load = vi.fn(async () => [{ id: 'avatar-a' }]);
  const timers: Array<() => void> = [];
  const setters: Record<string, any> = {};
  for (const key of [...Object.keys(state), 'chatLoaded', 'knowledgeLoaded', 'sanctuaryLoaded', 'commandCenterView']) {
    setters['set' + key[0].toUpperCase() + key.slice(1)] = (value: any) => {
      state[key] = typeof value === 'function' ? value(state[key]) : value;
    };
  }
  const names = ['dismissUtilitySurfaces', 'openCommandCenter', 'inferSurfaceReturnTarget', 'restoreSurfaceReturnTarget',
    'openKnowledgeBase', 'closeKnowledgeBase', 'openMemoryAvatar', 'openMemoryAvatarLab', 'closeMemoryAvatar',
    'openSurface', 'closeSurface', 'setNotificationSurface', 'toggleWindow', 'closeWindow'];
  const callbacks: Record<string, any> = Object.fromEntries(names.map(name => [name, (...args: any[]) => invoke(name, ...args)]));
  function invoke(name: string, ...args: any[]) {
    return extractSourceExpression(source, name, {
      ...state, ...refs, ...setters, ...callbacks, windowCommand, loadMemoryAvatars: load,
      normalizeTarget: (value: string) => ({ memory: 'knowledge', files: 'knowledge', sync: 'devices',
        chat: 'command-center', sanctuary: 'memory-avatar', sound: 'personalization', 'avatar-studio': 'personalization',
        world: 'nexus', 'nexus-view': 'nexus', 'cloud-canvas': 'nexus', 'memory-avatars': 'memory-avatar' }[value] || value),
      sounds: { playClick: vi.fn() }, isTauri: false,
      window: { setTimeout: (fn: () => void) => timers.push(fn), dispatchEvent: vi.fn() },
      CustomEvent: class { constructor(public type: string) {} },
    })(...args);
  }
  return { state, refs, load, invoke, timers };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; }

it('returning home through the desktop button dismisses the command center and utility focus owners', () => {
  const d = desktop({ activeTab: 'command-center', chatOpen: true, chatPrefill: { text: 'draft', source: 'test' },
    sanctuaryOpen: true, sanctuaryAgent: { id: 'a' }, isSearchOpen: true, isNotificationPanelOpen: true });
  d.invoke('toggleWindow', 'home');
  expect(d.state.chatOpen).toBe(false); expect(d.state.chatPrefill).toBeNull();
  expect(d.state.sanctuaryOpen).toBe(false); expect(d.state.isSearchOpen).toBe(false);
  expect(d.state.isNotificationPanelOpen).toBe(false); expect(d.state.activeTab).toBe('home');
});
it('a window opened by the dock replaces utility focus without losing its window order', () => {
  const d = desktop({ sanctuaryOpen: true, sanctuaryAgent: { id: 'a' }, openWindows: ['terminal', 'settings'], minimizedWindows: ['settings'] });
  d.invoke('toggleWindow', 'settings');
  expect(d.state.sanctuaryOpen).toBe(false); expect(d.state.sanctuaryAgent).toBeNull();
  expect(d.state.openWindows).toEqual(['terminal', 'settings']); expect(d.state.minimizedWindows).toEqual([]);
  expect(d.state.focusedWindow).toBe('settings');
});
it('a knowledge-to-avatar hop keeps the original command-center return destination', async () => {
  const d = desktop({ activeTab: 'knowledge', knowledgeOpen: true }); d.refs.surfaceReturnTargetRef.current = 'command-center';
  await d.invoke('openMemoryAvatar');
  expect(d.refs.surfaceReturnTargetRef.current).toBe('command-center');
  d.invoke('closeMemoryAvatar'); expect(d.state.chatOpen).toBe(true); expect(d.state.activeTab).toBe('command-center');
});
it('opening an empty avatar lab from the command center records that origin', () => {
  const d = desktop({ activeTab: 'command-center', chatOpen: true }); d.invoke('openMemoryAvatarLab');
  expect(d.refs.surfaceReturnTargetRef.current).toBe('command-center');
  d.invoke('closeMemoryAvatar'); expect(d.state.chatOpen).toBe(true);
});
it.each(['openCommandCenter', 'openKnowledgeBase'])('a delayed avatar list cannot reopen an avatar after %s replaces the surface', async replacement => {
  const d = desktop(); const gate = deferred<any[]>(); d.load.mockReturnValueOnce(gate.promise);
  const pending = d.invoke('openMemoryAvatar'); d.invoke(replacement);
  gate.resolve([{ id: 'late-avatar' }]); await pending;
  expect(d.state.sanctuaryOpen).toBe(false); expect(d.state.sanctuaryAgent).toBeNull();
  expect(d.state[replacement === 'openCommandCenter' ? 'chatOpen' : 'knowledgeOpen']).toBe(true);
});
it('opening the command center preserves a proactive prefill and still requests native-input focus', () => {
  const prefill = { text: 'next action', source: 'proactive' }; const d = desktop({ chatPrefill: prefill, knowledgeOpen: true });
  d.invoke('openCommandCenter', 'office'); expect(d.state.chatPrefill).toBe(prefill);
  expect(d.state.knowledgeOpen).toBe(false); expect(d.state.chatOpen).toBe(true); expect(d.timers).toHaveLength(1);
});
it('a stale explicit avatar id keeps the current surface rather than silently opening another avatar', async () => {
  const d = desktop({ knowledgeOpen: true, activeTab: 'knowledge' }); await d.invoke('openMemoryAvatar', 'missing');
  expect(d.state.knowledgeOpen).toBe(true); expect(d.state.sanctuaryOpen).toBe(false);
});
it('notification clicks remain a side-panel toggle while direct client opening stays idempotent', () => {
  const d = desktop({ chatOpen: true, activeTab: 'command-center' });
  d.invoke('toggleWindow', 'notifications'); expect(d.state.isNotificationPanelOpen).toBe(true); expect(d.state.chatOpen).toBe(true);
  d.invoke('toggleWindow', 'notifications'); expect(d.state.isNotificationPanelOpen).toBe(false);
  d.invoke('openSurface', 'notifications'); d.invoke('openSurface', 'notifications'); expect(d.state.isNotificationPanelOpen).toBe(true);
});

it('closing knowledge invalidates an avatar request still waiting for its list', async () => {
  const d = desktop({ knowledgeOpen: true, activeTab: 'knowledge' }); const gate = deferred<any[]>();
  d.load.mockReturnValueOnce(gate.promise); const pending = d.invoke('openMemoryAvatar'); d.invoke('closeKnowledgeBase');
  gate.resolve([{ id: 'late-avatar' }]); await pending;
  expect(d.state.sanctuaryOpen).toBe(false); expect(d.state.activeTab).toBe('home');
});
it('toggling a notification side panel preserves the utility return origin', () => {
  const d = desktop({ knowledgeOpen: true, activeTab: 'knowledge' }); d.refs.surfaceReturnTargetRef.current = 'command-center';
  d.invoke('toggleWindow', 'notifications'); d.invoke('toggleWindow', 'notifications'); d.invoke('closeKnowledgeBase');
  expect(d.state.chatOpen).toBe(true); expect(d.state.activeTab).toBe('command-center');
});
it('opening and closing Nexus uses the same recorded origin as the command-center rail', () => {
  const d = desktop({ chatOpen: true, activeTab: 'command-center' });
  d.invoke('openSurface', 'nexus', 'command-center'); expect(d.state.viewMode).toBe('world'); expect(d.state.chatOpen).toBe(false);
  d.invoke('closeSurface', 'nexus'); expect(d.state.viewMode).toBe('personal'); expect(d.state.chatOpen).toBe(true);
  expect(d.state.nexusReturnTarget).toBe('home');
});
