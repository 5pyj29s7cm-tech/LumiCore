import { expect, it, vi } from 'vitest';
import { extractSourceExpression } from './source_expression';
function runtime() {
  const invoke = vi.fn(), setMode = vi.fn(), toggle = vi.fn();
  const transition = extractSourceExpression('src/components/desktop/state/use_desktop_surface_controls.tsx', 'transitionDesktopWidget', {
    require: () => ({ invoke }), isTauri: true, widgetTransitions: { current: Promise.resolve(true) },
    systemService: { setAlwaysOnTop: vi.fn(async () => {}) }, isWallpaperModeRef: { current: false }, wallpaperPresentationRef: { current: 'workbench' }, chatOpen: false,
    sounds: { playClick() {} }, surfaceReturnTargetRef: { current: 'home' }, setIsNotificationPanelOpen() {}, setIsSearchOpen() {}, dismissUtilitySurfaces() {}, windowCommand() {}, setActiveTab() {},
    setIsDesktopWidgetMode: setMode, toggleWindow: toggle, toast: { error: vi.fn() }, desktopWorkflowCopy: () => ({ common: { windowControlFailed: 'failed' } }), lang: 'en',
  });
  return { invoke, setMode, toggle, transition };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
it('does not publish widget mode before native completion', async () => {
  const r = runtime(); let finish!: (value: any) => void; r.invoke.mockReturnValue(new Promise(resolve => finish = resolve));
  const result = r.transition(true); await settle(); expect(r.setMode).not.toHaveBeenCalled();
  finish({ enabled: true }); expect(await result).toBe(true); expect(r.setMode).toHaveBeenCalledExactlyOnceWith(true);
});
it.each([true, false])('preserves UI mode when native transition to %s fails', async enabled => {
  const r = runtime(); r.invoke.mockRejectedValue(Error('native rejected'));
  expect(await r.transition(enabled, 'tools')).toBe(false); expect(r.setMode).not.toHaveBeenCalled(); expect(r.toggle).not.toHaveBeenCalled(); expect(r.invoke).toHaveBeenCalledTimes(1);
});
it('serializes overlapping enter and exit requests through one owner', async () => {
  const r = runtime(); let enter!: (value: any) => void;
  r.invoke.mockImplementation(name => name === 'enter_desktop_widget_mode' ? new Promise(resolve => enter = resolve) : Promise.resolve({ enabled: false }));
  const first = r.transition(true), second = r.transition(false, 'tools'); await settle();
  expect(r.invoke).toHaveBeenCalledTimes(1); enter({ enabled: true }); expect(await first).toBe(true); expect(await second).toBe(true);
  expect(r.setMode.mock.calls).toEqual([[true], [false]]); expect(r.toggle).toHaveBeenCalledExactlyOnceWith('tools');
});
it('does not trust a native receipt that contradicts the requested mode', async () => {
  const r = runtime(); r.invoke.mockResolvedValue({ enabled: false });
  expect(await r.transition(true)).toBe(false); expect(r.setMode).not.toHaveBeenCalled();
});

it('keeps native widget mode when hiding to background fails', async () => {
  const setMode = vi.fn(), error = vi.fn();
  const hide = extractSourceExpression('src/components/desktop/state/use_desktop_surface_controls.tsx', 'hideDesktopWidgetMode', {
    require: () => ({ invoke: vi.fn(async () => { throw Error('hide failed'); }) }), isTauri: true,
    setIsDesktopWidgetMode: setMode, toast: { error }, sounds: { playClick() {} }, desktopWorkflowCopy: () => ({ common: { windowControlFailed: 'failed' } }), lang: 'en',
  });
  await hide(); expect(setMode).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledWith('hide failed');
});
