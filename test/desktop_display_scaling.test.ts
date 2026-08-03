import { describe, expect, it } from 'vitest';
import {
  getCompactClientWindowMetrics,
  getDesktopDockPositionClassName,
  getDesktopChromeMetrics,
  getDesktopDensity,
  resolveDesktopWindowBounds,
  shouldUseCompactDesktopLayout,
  type ViewportSize,
} from '../src/lib/desktopLayout';

describe('desktop display scaling layout', () => {
  it('uses compact chrome for common 125%-150% logical resolutions', () => {
    expect(getDesktopDensity({ width: 1920, height: 1080 })).toBe('comfortable');
    expect(getDesktopDensity({ width: 1280, height: 720 })).toBe('compact');
    expect(getDesktopDensity({ width: 1024, height: 640 })).toBe('tight');
    expect(getDesktopDensity({ width: 720, height: 520 })).toBe('mini');
    expect(getDesktopDensity({ width: 640, height: 520 })).toBe('mini');
    expect(getDesktopDensity({ width: 520, height: 460 })).toBe('mini');
  });

  it.each<ViewportSize>([
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
    { width: 1024, height: 640 },
    { width: 720, height: 520 },
  ])('keeps normal windows between the top bar and dock at $width x $height', viewport => {
    const bounds = resolveDesktopWindowBounds(viewport, 1100, 750);
    const chrome = getDesktopChromeMetrics(viewport);

    expect(bounds.left).toBeGreaterThanOrEqual(chrome.safeInset);
    expect(bounds.top).toBeGreaterThanOrEqual(chrome.topInset);
    expect(bounds.left + bounds.width).toBeLessThanOrEqual(viewport.width - chrome.safeInset);
    expect(bounds.top + bounds.height).toBeLessThanOrEqual(viewport.height - chrome.bottomInset);
  });

  it('keeps maximized and snapped windows inside the same safe work area', () => {
    const viewport = { width: 1024, height: 640 };
    const chrome = getDesktopChromeMetrics(viewport);

    for (const snap of ['left', 'right', 'maximized'] as const) {
      const bounds = resolveDesktopWindowBounds(viewport, 900, 700, snap);
      expect(bounds.top).toBe(chrome.topInset);
      expect(bounds.height).toBe(chrome.availableHeight);
      expect(bounds.left).toBeGreaterThanOrEqual(chrome.safeInset);
      expect(bounds.left + bounds.width).toBeLessThanOrEqual(viewport.width - chrome.safeInset);
    }
  });

  it.each<ViewportSize>([
    { width: 1366, height: 728 },
    { width: 1920, height: 1040 },
    { width: 2560, height: 1400 },
  ])('fits the compact client preset inside a $width x $height work area', workArea => {
    const compact = getCompactClientWindowMetrics(workArea);

    expect(compact.width).toBeGreaterThanOrEqual(compact.minWidth);
    expect(compact.height).toBeGreaterThanOrEqual(compact.minHeight);
    expect(compact.width).toBeLessThanOrEqual(1280);
    expect(compact.height).toBeLessThanOrEqual(820);
    expect(compact.width + compact.margin * 2).toBeLessThanOrEqual(workArea.width);
    expect(compact.height + compact.margin * 2).toBeLessThanOrEqual(workArea.height);
  });

  it('keeps the compact preset stable across equivalent DPI-scaled work areas', () => {
    expect(getCompactClientWindowMetrics({ width: 1920, height: 1040 })).toEqual(
      getCompactClientWindowMetrics({ width: 2880 / 1.5, height: 1560 / 1.5 }),
    );
  });

  it('uses a roomier default preset without raising the manual resize floor', () => {
    expect(getCompactClientWindowMetrics({ width: 1920, height: 1040 })).toMatchObject({
      width: 1280,
      height: 820,
      minWidth: 520,
      minHeight: 460,
    });
  });

  it.each([
    [{ width: 1920, height: 1080 }, false],
    [{ width: 1366, height: 768 }, false],
    [{ width: 1280, height: 820 }, true],
    [{ width: 1098, height: 696 }, true],
    [{ width: 520, height: 460 }, true],
  ] as const)('derives compact composition from the rendered viewport at %o', (viewport, expected) => {
    expect(shouldUseCompactDesktopLayout(viewport)).toBe(expected);
  });

  it('never carries the centered translate class into compact Dock positioning', () => {
    expect(getDesktopDockPositionClassName(true)).toBe('left-2 right-2');
    expect(getDesktopDockPositionClassName(true)).not.toContain('translate');
    expect(getDesktopDockPositionClassName(false)).toBe('left-1/2 -translate-x-1/2');
  });
});
