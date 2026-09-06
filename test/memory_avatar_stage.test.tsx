// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_AVATAR_APPEARANCE } from '../shared/memory_avatar';
import { memoryTerritoryCopy } from '../src/i18n/locales/memoryTerritory';

const runtime = vi.hoisted(() => ({ canvas: vi.fn(), unmounted: vi.fn(), renderer: null as any }));
vi.mock('@react-three/fiber', async () => {
  const React = await import('react');
  return {
    Canvas: (props: any) => {
      runtime.canvas(props);
      React.useEffect(() => () => runtime.unmounted(), []);
      // Keep the real browser context-loss guard. Geometry is reviewed in the
      // running renderer; this test deliberately never initializes WebGL.
      return <div data-testid="portrait-canvas">{React.Children.toArray(props.children).filter((child: any) => child.type?.name === 'ContextLossGuard')}</div>;
    },
    useThree: (selector: any) => selector({ gl: runtime.renderer }),
    useFrame: vi.fn(),
  };
});
import MemoryAvatarStage from '../src/components/MemoryAvatarStage';

const props = { appearance: DEFAULT_MEMORY_AVATAR_APPEARANCE, outputLevelRef: { current: 0 }, name: 'Synthetic companion', locale: 'en' as const };
let context: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  runtime.canvas.mockReset(); runtime.unmounted.mockReset();
  runtime.renderer = { domElement: document.createElement('canvas') };
  context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ getExtension: () => ({ loseContext: vi.fn() }) } as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('keeps the conversation fallback visible when WebGL2 is unavailable', async () => {
  context.mockReturnValue(null);
  render(<MemoryAvatarStage {...props} />);
  expect(await screen.findByText(memoryTerritoryCopy('en').renderFallback)).toBeTruthy();
  expect(screen.getByText(props.name)).toBeTruthy();
  expect(runtime.canvas).not.toHaveBeenCalled();
});

it('does not allocate a renderer while inactive and unmounts an active renderer when closed', async () => {
  const view = render(<MemoryAvatarStage {...props} active={false} />);
  expect(context).not.toHaveBeenCalled(); expect(runtime.canvas).not.toHaveBeenCalled();
  view.rerender(<MemoryAvatarStage {...props} active />);
  expect(await screen.findByTestId('portrait-canvas')).toBeTruthy();
  expect(runtime.canvas.mock.calls.at(-1)?.[0].dpr).toEqual([1, 1.5]);
  view.rerender(<MemoryAvatarStage {...props} active={false} />);
  expect(screen.queryByTestId('portrait-canvas')).toBeNull();
  expect(runtime.unmounted).toHaveBeenCalledTimes(1);
});

it('unmounts a lost WebGL context and displays the localized text fallback', async () => {
  render(<MemoryAvatarStage {...props} locale="zh" />);
  await screen.findByTestId('portrait-canvas');
  const event = new Event('webglcontextlost', { cancelable: true });
  act(() => runtime.renderer.domElement.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(await screen.findByText(memoryTerritoryCopy('zh').renderFallback)).toBeTruthy();
  expect(screen.queryByTestId('portrait-canvas')).toBeNull();
  expect(runtime.unmounted).toHaveBeenCalledTimes(1);
});
