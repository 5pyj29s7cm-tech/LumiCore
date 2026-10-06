// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useDesktopWindows } from '../src/components/desktop/useDesktopWindows';

afterEach(cleanup);
it.each(['close', 'minimize'] as const)('batched %s cannot focus a removed or hidden window', action => {
  const hook = renderHook(() => useDesktopWindows('settings'));
  act(() => hook.result.current.command('open', 'terminal'));
  const command = hook.result.current.command;
  act(() => { command(action, 'terminal'); command(action, 'settings'); });
  expect(hook.result.current.focusedWindow).toBeNull();
  if (action === 'close') expect(hook.result.current.openWindows).toEqual([]);
  else expect(hook.result.current.minimizedWindows).toEqual(['terminal', 'settings']);
});
it('serializes mixed commands before render and only focuses existing visible windows', () => {
  const hook = renderHook(() => useDesktopWindows(null));
  const command = hook.result.current.command;
  act(() => {
    command('open', 'settings'); command('open', 'terminal'); command('minimize', 'settings');
    command('close', 'terminal'); command('focus', 'settings'); command('focus', 'unknown');
  });
  expect(hook.result.current.focusedWindow).toBeNull();
  expect(hook.result.current.openWindows).toEqual(['settings']);
  expect(hook.result.current.minimizedWindows).toEqual(['settings']);
  act(() => { command('open', 'settings'); command('minimize', 'unknown'); });
  expect(hook.result.current.focusedWindow).toBe('settings');
  expect(hook.result.current.minimizedWindows).toEqual([]);
});
it('removes virtual surfaces atomically and returns to the top visible window', () => {
  const hook = renderHook(() => useDesktopWindows('terminal'));
  const command = hook.result.current.command;
  act(() => {
    command('open', 'settings'); command('minimize', 'settings');
    command('open', 'chat'); command('open', 'command-center'); command('remove', 'chat', 'command-center');
  });
  expect(hook.result.current.focusedWindow).toBe('terminal');
  expect(hook.result.current.openWindows).toEqual(['terminal', 'settings']);
  act(() => { command('reset'); command('focus', 'terminal'); });
  expect(hook.result.current).toMatchObject({ openWindows: [], minimizedWindows: [], focusedWindow: null });
});
it('reports returning home only when closing the last focused window', () => {
  const hook = renderHook(() => useDesktopWindows('settings'));
  const command = hook.result.current.command;
  act(() => { command('open', 'terminal'); });
  act(() => {
    expect(command('close', 'missing')).toBe(false);
    expect(command('close', 'terminal')).toBe(false);
    expect(command('close', 'settings')).toBe(true);
  });
});
