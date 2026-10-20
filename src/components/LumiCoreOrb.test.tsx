// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LumiCoreOrb } from './LumiCoreOrb';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: new Proxy({}, { get: (_target, tag: string) => tag }),
  useReducedMotion: () => true,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('repaints the same static canvas with the new theme without starting an animation loop', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const filledColors: string[] = [];
  const context = {
    clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(),
    fillStyle: '', shadowColor: '', shadowBlur: 0, globalAlpha: 1,
    fill() { filledColors.push(this.fillStyle); },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const requestFrame = vi.fn();
  vi.stubGlobal('requestAnimationFrame', requestFrame);

  const view = render(<LumiCoreOrb isLightMode={false} />);
  const canvas = view.container.querySelector('canvas');
  expect(context.clearRect).toHaveBeenCalledTimes(1);
  expect(filledColors.length).toBeGreaterThan(0);
  expect(new Set(filledColors)).toEqual(new Set(['#ffffff']));
  const firstFrameCount = filledColors.length;

  view.rerender(<LumiCoreOrb isLightMode />);
  expect(view.container.querySelector('canvas')).toBe(canvas);
  expect(context.clearRect).toHaveBeenCalledTimes(2);
  expect(filledColors.length).toBeGreaterThan(firstFrameCount);
  expect(new Set(filledColors.slice(firstFrameCount))).toEqual(new Set(['#2d5f88']));
  expect(requestFrame).not.toHaveBeenCalled();
});
