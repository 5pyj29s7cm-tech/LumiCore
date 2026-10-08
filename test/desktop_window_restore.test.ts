import { expect, it, vi } from 'vitest';
import { extractSourceExpression } from './source_expression';

it.each([
  { compact: false, fullscreen: false, restoreFullscreen: true },
  { compact: false, fullscreen: true, restoreFullscreen: false },
  { compact: true, fullscreen: false, restoreFullscreen: false },
])('restores the actual native state instead of confusing it with compact mode: %j', async scenario => {
  const invoke = vi.fn(async (name: string) => ({ enabled: name === 'get_compact_window_mode' ? scenario.compact : !scenario.compact }));
  const current = { isFullscreen: vi.fn(async () => scenario.fullscreen), setFullscreen: vi.fn(async () => {}) };
  const setIsCompactWindowMode = vi.fn(), error = vi.fn();
  const maximize = extractSourceExpression('src/components/DesktopUI.tsx', 'handleWindowMaximize', {
    require: (name: string) => name.endsWith('/core') ? { invoke } : { getCurrentWindow: () => current },
    setIsCompactWindowMode, toast: { error }, desktopWorkflowCopy: () => ({}), lang: 'zh',
  });
  await maximize();
  if (scenario.restoreFullscreen) {
    expect(current.setFullscreen).toHaveBeenCalledExactlyOnceWith(true);
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['get_compact_window_mode']);
    expect(setIsCompactWindowMode).toHaveBeenCalledExactlyOnceWith(false);
  } else {
    expect(current.setFullscreen).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['get_compact_window_mode', 'toggle_compact_window_mode']);
    expect(setIsCompactWindowMode).toHaveBeenCalledExactlyOnceWith(!scenario.compact);
  }
  expect(error).not.toHaveBeenCalled();
});

it('reports a native restore failure without publishing a successful mode change', async () => {
  const setIsCompactWindowMode = vi.fn(), error = vi.fn();
  const maximize = extractSourceExpression('src/components/DesktopUI.tsx', 'handleWindowMaximize', {
    require: (name: string) => name.endsWith('/core') ? { invoke: async () => ({ enabled: false }) }
      : { getCurrentWindow: () => ({ isFullscreen: async () => false, setFullscreen: async () => { throw new Error('Native restore failed'); } }) },
    setIsCompactWindowMode, toast: { error }, desktopWorkflowCopy: () => ({}), lang: 'zh',
  });
  await maximize();
  expect(setIsCompactWindowMode).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledExactlyOnceWith('Native restore failed');
});
