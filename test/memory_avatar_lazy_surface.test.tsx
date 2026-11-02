// @vitest-environment jsdom
import React, { lazy, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopShellView, type DesktopShellViewInput } from '../src/components/desktop/DesktopShellView';
import { setLocale } from '../src/i18n/runtime';

const fixture = vi.hoisted(() => ({ panel: null as React.ComponentType<any> | null, closed: vi.fn(), cancel: vi.fn(), retry: vi.fn() }));
type LazyPanelModule = { default: React.ComponentType<{ isOpen: boolean }> };
vi.mock('../src/components/desktop/shell_chrome_view', () => ({ renderShellChrome: () => <span>Original desktop</span> }));
vi.mock('../src/components/desktop/core_stage_view', () => ({ renderDesktopCoreStage: () => null }));
vi.mock('../src/components/desktop/desktop_grid_view', () => ({ renderDesktopGrid: () => null }));
vi.mock('../src/components/desktop/meeting_workspace_view', () => ({ renderMeetingWorkspace: () => null }));
vi.mock('../src/components/desktop/desktop_windows_view', () => ({ renderDesktopWindows: () => null }));
vi.mock('../src/components/desktop/DesktopModeSwitch', () => ({ DesktopModeSwitch: () => null }));
vi.mock('../src/components/desktop/window_shell', () => ({ LazyPanelFallback: ({ label }: { label: string }) => <p>{label}</p> }));
vi.mock('../src/components/KnowledgeBaseEntry', () => ({ KnowledgeBaseEntry: () => null }));
vi.mock('../src/components/DesktopShellAuxiliary', () => ({ DayInkLandscape: () => null }));
vi.mock('../src/components/CursorGlow', () => ({ CursorGlow: () => null }));
vi.mock('../src/components/desktop/surface_components', () => ({
  Sanctuary: (props: any) => { const Panel = fixture.panel!; return <Panel {...props} />; },
  MemoryAvatarLab: () => null, InkWorldLazy: () => null, MeshSyncSelector: () => null,
  ContributorNodePanel: () => null, AgentChatPage: () => null, OrgPortal: () => null,
}));
vi.mock('motion/react', async () => {
  const React = await import('react');
  const Div = ({ children, initial, animate, exit, transition, ...props }: any) => React.createElement('div', props, children);
  return { AnimatePresence: ({ children }: React.PropsWithChildren) => children, motion: { div: Div } };
});

function Shell({ initiallyOpen = true, feedback = false, domain = 'personal' }: { initiallyOpen?: boolean; feedback?: boolean; domain?: 'personal' | 'work' }) {
  const [open, setOpen] = useState(initiallyOpen);
  const close = () => { fixture.closed(); setOpen(false); };
  const input = {
    resolvedAppearanceMode: 'dark', viewMode: 'personal', activeTab: 'home', workDomain: domain,
    desktopChrome: {}, isWallpaperMode: false, isWallpaperWorkbench: false, wallpaperWorkspace: 'personal',
    lang: 'en', t: {}, sanctuaryLoaded: true, sanctuaryOpen: open, sanctuaryAgent: { id: 'synthetic-person' }, memoryAvatars: [],
    chatOpen: false, chatLoaded: false, knowledgeLoaded: false, memoryLabOpen: false,
    memoryAvatarEntryState: feedback ? { status: 'error', issue: 'load' } : null,
    cancelMemoryAvatarEntry: fixture.cancel, retryMemoryAvatarEntry: fixture.retry,
    closeMemoryAvatar: close, user: { uid: 'synthetic-owner' },
  } as unknown as DesktopShellViewInput;
  return <DesktopShellView {...input} />;
}

beforeEach(() => { vi.clearAllMocks(); setLocale('en'); vi.stubGlobal('fetch', vi.fn(() => Promise.reject(Error('Network is forbidden in the lazy-surface test')))); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps a usable close action above the actual shell while the memory page chunk is pending', async () => {
  let finish!: (value: LazyPanelModule) => void;
  fixture.panel = lazy(() => new Promise<LazyPanelModule>(resolve => { finish = resolve; }));
  const view = render(<Shell />);
  expect(screen.getByRole('status').textContent).toContain('Opening Memory Territory');
  expect(screen.getByText('Original desktop')).toBeTruthy();
  const wrapper = view.container.querySelector('[data-memory-avatar-surface]') as HTMLElement;
  expect(wrapper.hidden).toBe(false); expect(wrapper.classList.contains('fixed')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(fixture.closed).toHaveBeenCalledOnce(); expect(wrapper.hidden).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => { finish({ default: ({ isOpen }: { isOpen: boolean }) => isOpen ? <p>Loaded private page</p> : null }); });
  expect(screen.queryByText('Loaded private page')).toBeNull(); expect(wrapper.hidden).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it('contains a rejected memory page chunk in the actual shell and lets the user return', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let reject!: (reason: Error) => void;
  fixture.panel = lazy(() => new Promise<LazyPanelModule>((_resolve, no) => { reject = no; }));
  const view = render(<Shell />);
  await act(async () => { reject(Error('Synthetic chunk unavailable')); await Promise.resolve(); });
  const failure = view.container.querySelector('[data-lumi-failed-surface="memory-avatar"]');
  expect(failure).not.toBeNull(); expect(failure?.closest('[data-memory-avatar-surface]')?.hasAttribute('hidden')).toBe(false);
  expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(fixture.closed).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  expect(screen.getByText('Original desktop')).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it('does not show a loading overlay for a retained inactive memory page', () => {
  fixture.panel = lazy(() => new Promise<LazyPanelModule>(() => {}));
  render(<Shell initiallyOpen={false} />);
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText('Original desktop')).toBeTruthy();
});

it('closes a real render-failure boundary without replacing the surrounding shell', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fixture.panel = () => { throw Error('Synthetic memory render failure'); };
  const view = render(<Shell />);
  expect(view.container.querySelector('[data-lumi-failed-surface="memory-avatar"]')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.getByText('Original desktop')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
});

it.each(['personal', 'work'] as const)('mounts actionable entry errors at the actual shell level in the %s domain', domain => {
  fixture.panel = () => null;
  render(<Shell initiallyOpen={false} feedback domain={domain} />);
  expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
  fireEvent.click(screen.getByRole('button', { name: 'Reload people' }));
  expect(fixture.retry).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(fixture.cancel).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});
