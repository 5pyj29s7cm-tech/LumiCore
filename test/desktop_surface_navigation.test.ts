import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BusinessWorkbench } from '../src/components/BusinessWorkbench';
import { desktopWindowCommand } from './desktop_window_harness';
import { expect, it, vi } from 'vitest';
import { extractSourceExpression } from './source_expression';
import { withRequestDeadline } from '../src/lib/requestDeadline';

const source = 'src/components/DesktopUI.tsx';
function desktop(initial: Record<string, any> = {}) {
  const state: Record<string, any> = {
    activeTab: 'home', chatOpen: false, knowledgeOpen: false, memoryLabOpen: false,
    sanctuaryOpen: false, sanctuaryAgent: null, chatPrefill: null,
    openWindows: [], minimizedWindows: [], focusedWindow: null, viewMode: 'personal',
    isSearchOpen: false, isNotificationPanelOpen: false, isDesktopWidgetMode: false, nexusReturnTarget: 'home', memoryAvatarEntry: null, ...initial,
  };
  const windowCommand = desktopWindowCommand(state);
  const scope = { userId: 'owner-a' };
  const entryScope = { ownerScope: scope, domain: 'personal', orgId: '' };
  const refs = { surfaceReturnTargetRef: { current: 'home' }, memoryAvatarOpenGenerationRef: { current: 4 },
    memoryAvatarEntryScope: entryScope, memoryAvatarEntryScopeRef: { current: entryScope }, memoryAvatarEntryRequestRef: { current: null },
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
    'openKnowledgeBase', 'closeKnowledgeBase', 'openMemoryAvatar', 'openMemoryAvatarLab', 'closeMemoryAvatar', 'cancelMemoryAvatarEntry',
    'openSurface', 'closeSurface', 'setNotificationSurface', 'toggleWindow', 'closeWindow'];
  const callbacks: Record<string, any> = Object.fromEntries(names.map(name => [name, (...args: any[]) => invoke(name, ...args)]));
  function invoke(name: string, ...args: any[]) {
    return extractSourceExpression(source, name, {
      ...state, ...refs, ...setters, ...callbacks, windowCommand, loadMemoryAvatars: load, AbortController, withRequestDeadline,
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

it('Skill Hall opened from Breath Realm returns there after closing', () => {
  const d = desktop({ viewMode: 'world' });
  d.invoke('openSurface', 'skills', 'nexus');
  expect(d.state.viewMode).toBe('personal'); expect(d.state.focusedWindow).toBe('skills');
  d.invoke('closeWindow', 'skills');
  expect(d.state.viewMode).toBe('world'); expect(d.state.activeTab).toBe('home');
});
it.each(['business', 'business-ecommerce', 'business-finance'])('the %s workspace returns to its command-center origin', id => {
  const d = desktop({ activeTab: 'command-center', chatOpen: true });
  d.invoke('openSurface', id);
  expect(d.state.chatOpen).toBe(false); expect(d.state.focusedWindow).toBe(id);
  d.invoke('closeWindow', id);
  expect(d.state.chatOpen).toBe(true); expect(d.state.activeTab).toBe('command-center');
});
it('leaving Breath Realm does not send a later direct Skill Hall opening back there', () => {
  const d = desktop({ viewMode: 'world' });
  d.invoke('openSurface', 'skills', 'nexus'); d.invoke('closeWindow', 'skills');
  d.invoke('closeSurface', 'nexus');
  d.invoke('openSurface', 'skills'); d.invoke('closeWindow', 'skills');
  expect(d.state.viewMode).toBe('personal'); expect(d.state.activeTab).toBe('home');
});
it('closing the focused relocated workspace preserves its origin with another window still open', () => {
  const d = desktop({ activeTab: 'command-center', chatOpen: true, openWindows: ['settings'], focusedWindow: 'settings' });
  d.invoke('openSurface', 'business', 'command-center'); d.invoke('closeWindow', 'business');
  expect(d.state.openWindows).toEqual(['settings']); expect(d.state.chatOpen).toBe(true);
});

function realmWheel(state: Record<string, any> = {}, event: Record<string, any> = {}, interactive = false, scrolling = false) {
  const openSurface = vi.fn();
  const closeSurface = vi.fn();
  const input = { viewMode: 'personal', activeTab: 'home', openWindows: [], minimizedWindows: [], sensorPrimerSeen: true, ...state, openSurface, closeSurface };
  const target = { closest: () => interactive ? {} : null, scrollHeight: scrolling ? 200 : 100, clientHeight: 100, parentElement: null };
  extractSourceExpression('src/components/desktop/DesktopShellView.tsx', 'handleRealmWheel', {
    input, window: { getComputedStyle: () => ({ overflowY: scrolling ? 'auto' : 'visible' }) },
  })({ deltaY: -100, deltaX: 0, deltaMode: 0, target, currentTarget: {}, stopPropagation: vi.fn(), ...event });
  return Object.assign(openSurface, { closeSurface });
}
it.each([[0, -12], [1, -1], [2, -1]])('the clear personal background supports pixel, line and page wheel units: %s', (deltaMode, deltaY) => {
  expect(realmWheel({}, { deltaMode, deltaY })).toHaveBeenCalledWith('nexus', 'home');
});
it.each([{ openWindows: ['settings'] }, { chatOpen: true }, { meetingNotesOpen: true }, { operationMode: 'meeting' },
  { isSearchOpen: true }, { isNotificationPanelOpen: true }, { isWallpaperMode: true }, { pendingOperationMode: 'meeting' },
  { showOnboarding: true }, { sensorPrimerSeen: false }, { isTrainingOpen: true }])('keeps existing surfaces in control of their wheel events: %j', state => {
  expect(realmWheel(state)).not.toHaveBeenCalled();
});
it.each([{ deltaY: -5 }, { deltaY: 100 }, { deltaX: 200 }, { ctrlKey: true }, { metaKey: true }, { defaultPrevented: true }])('ignores slight, reverse, horizontal, zoom and consumed gestures: %j', event => {
  expect(realmWheel({}, event)).not.toHaveBeenCalled();
});
it('does not navigate from controls or from a scrollable container', () => {
  expect(realmWheel({}, {}, true)).not.toHaveBeenCalled();
  expect(realmWheel({}, {}, false, true)).not.toHaveBeenCalled();
});

it.each([[0, 12], [1, 1], [2, 1]])('scrolling backward exits Breath Realm with native wheel units: %s', (deltaMode, deltaY) => {
  const action = realmWheel({ viewMode: 'world' }, { deltaMode, deltaY });
  expect(action).not.toHaveBeenCalled(); expect(action.closeSurface).toHaveBeenCalledWith('nexus');
});
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: 'section-owner' }, workbenchDrafts: new Map() }) }));
it.each([['social', '社媒运营'], ['ecommerce', '电商运营'], ['finance', '财务管理']] as const)('renders the direct %s section with its own title and without aggregate tabs', (section, title) => {
  const markup = renderToStaticMarkup(React.createElement(BusinessWorkbench, { section, lang: 'zh', domain: 'personal',
    onOpenSettings: vi.fn(), onOpenKnowledge: vi.fn(), onOpenSkills: vi.fn(), onOpenCreation: vi.fn(), onOpenDigitalHuman: vi.fn() }));
  expect(markup).toContain('>' + title + '</h2>'); expect(markup).not.toContain('<nav');
});

it('allows a cleared personal background with only minimized windows', () => {
  expect(realmWheel({ activeTab: 'settings', openWindows: ['settings'], minimizedWindows: ['settings'] })).toHaveBeenCalledWith('nexus', 'home');
});
it('consumes the captured gesture only when a page switch actually occurs', () => {
  const stopPropagation = vi.fn();
  realmWheel({}, { deltaY: -12, stopPropagation }); expect(stopPropagation).toHaveBeenCalledOnce();
  stopPropagation.mockClear(); realmWheel({}, { deltaY: -1, stopPropagation }); expect(stopPropagation).not.toHaveBeenCalled();
});
it('allows backward exit when personal windows are hidden behind Breath Realm', () => {
  const action = realmWheel({ viewMode: 'world', openWindows: ['settings'] }, { deltaY: 12 });
  expect(action.closeSurface).toHaveBeenCalledWith('nexus');
});
