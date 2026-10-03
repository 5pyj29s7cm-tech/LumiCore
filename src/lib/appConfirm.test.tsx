// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { appConfirm, cancelAppConfirm, useAppConfirm } from './appConfirm';
afterEach(() => { cancelAppConfirm(); cleanup(); document.body.replaceChildren(); });

it('focuses cancellation and does not approve Enter from the page behind the dialog', async () => {
  const input = document.createElement('input'); document.body.append(input); input.focus();
  const behind = vi.fn(); document.addEventListener('keydown', behind);
  try {
    const promise = appConfirm('Delete?'); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document, { key: 'Enter' }); expect(screen.getByRole('alertdialog')).toBeTruthy(); expect(behind).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); expect(await promise).toBe(false); expect(document.activeElement).toBe(input);
  } finally { document.removeEventListener('keydown', behind); }
});

it('confirms only the selected button, traps Tab, and cancels replaced dialogs', async () => {
  const first = appConfirm('Old'), second = appConfirm('New'); expect(await first).toBe(false); expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' }); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Enter' }); expect(await second).toBe(true); expect(screen.queryByRole('alertdialog')).toBeNull();
});

it.each(['Escape', 'Enter'])('does not pass a repeated %s to the underlying window', async key => {
  const behind = vi.fn(); document.addEventListener('keydown', behind);
  try {
    const pending = appConfirm('Wait'); expect(fireEvent.keyDown(document.activeElement!, { key, repeat: true })).toBe(false);
    expect(behind).not.toHaveBeenCalled(); expect(screen.getByRole('alertdialog')).toBeTruthy(); cancelAppConfirm(); expect(await pending).toBe(false);
  } finally { document.removeEventListener('keydown', behind); }
});

it('uses Enter on the default Cancel button to cancel, never approve', async () => {
  const pending = appConfirm('Delete?'); fireEvent.keyDown(document.activeElement!, { key: 'Enter' }); expect(await pending).toBe(false);
});

it.each(['lumi:navigate', 'lumi:domain-changed', 'pagehide'])('cancels on %s', async event => {
  const pending = appConfirm('Continue?'); window.dispatchEvent(new Event(event)); expect(await pending).toBe(false); expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('cancels on hook scope change, unmount, and caller abort in StrictMode', async () => {
  const view = renderHook(({ scope }) => useAppConfirm(scope), { initialProps: { scope: 'one' }, wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode> });
  const first = view.result.current('First'); view.rerender({ scope: 'two' }); expect(await first).toBe(false);
  const controller = new AbortController(), second = view.result.current({ message: 'Second', signal: controller.signal });
  act(() => controller.abort()); expect(await second).toBe(false);
  const third = view.result.current('Third'); view.unmount(); expect(await third).toBe(false); expect(await view.result.current('Too late')).toBe(false);
});
