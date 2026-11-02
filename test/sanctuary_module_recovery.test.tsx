// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SanctuaryLazyPanel, SANCTUARY_MODULE_TIMEOUT_MS } from '../src/components/SanctuaryLazyPanel';
import { sanctuaryModulesCopy } from '../src/i18n/locales/sanctuaryModules';

type Module = { default: React.ComponentType };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const loaded: Module = { default: () => <p data-testid="loaded-panel">Synthetic loaded panel</p> };
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['en', 'zh'] as const)('shows a localized module error, retains back and retries only that loader (%s)', async locale => {
  const first = deferred<Module>(); const back = vi.fn();
  const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(loaded);
  render(<SanctuaryLazyPanel load={load} kind="profile" locale={locale} onBack={back}>{Content => <Content />}</SanctuaryLazyPanel>);
  const copy = sanctuaryModulesCopy(locale);
  expect(screen.getByRole('status').textContent).toContain(copy.modules.profile.loading);
  expect(screen.getByRole('button', { name: copy.modules.profile.back })).toBeTruthy();
  await act(async () => first.reject(Error('Private module path D:/synthetic-private/runtime-file.ts')));
  expect(screen.getByRole('alert').textContent).toContain(copy.modules.profile.failed);
  expect(document.body.textContent).not.toContain('synthetic-private');
  fireEvent.click(screen.getByRole('button', { name: copy.retry })); await settle();
  expect(screen.getByTestId('loaded-panel')).toBeTruthy(); expect(load).toHaveBeenCalledTimes(2); expect(back).not.toHaveBeenCalled();
});

it('bounds an unresolved module and ignores its late result after an explicit retry', async () => {
  vi.useFakeTimers(); const old = deferred<Module>(); const current = deferred<Module>();
  const load = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  render(<SanctuaryLazyPanel load={load} kind="live" locale="en" onBack={vi.fn()}>{Content => <Content />}</SanctuaryLazyPanel>);
  await act(async () => { await vi.advanceTimersByTimeAsync(SANCTUARY_MODULE_TIMEOUT_MS); });
  const copy = sanctuaryModulesCopy('en'); expect(screen.getByRole('alert').textContent).toContain(copy.modules.live.timeout);
  fireEvent.click(screen.getByRole('button', { name: copy.retry })); await settle();
  await act(async () => old.resolve({ default: () => <p data-testid="obsolete-module">Obsolete</p> }));
  expect(screen.queryByTestId('obsolete-module')).toBeNull(); expect(screen.getByRole('status')).toBeTruthy();
  await act(async () => current.resolve(loaded));
  expect(screen.getByTestId('loaded-panel')).toBeTruthy(); expect(load).toHaveBeenCalledTimes(2);
});

it('can leave a pending module and never mounts a late module after unmount', async () => {
  const pending = deferred<Module>(); const mounts = vi.fn(); const back = vi.fn(); const load = vi.fn(() => pending.promise);
  const view = render(<SanctuaryLazyPanel load={load} kind="scene" locale="en" onBack={back}>{Content => <Content />}</SanctuaryLazyPanel>);
  fireEvent.click(screen.getByRole('button', { name: sanctuaryModulesCopy('en').modules.scene.back })); expect(back).toHaveBeenCalledOnce();
  view.unmount();
  await act(async () => pending.resolve({ default: () => { mounts(); return <p>Late scene</p>; } }));
  expect(mounts).not.toHaveBeenCalled(); expect(screen.queryByText('Late scene')).toBeNull(); expect(load).toHaveBeenCalledOnce();
});
