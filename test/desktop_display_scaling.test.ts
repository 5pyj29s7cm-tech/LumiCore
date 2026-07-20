import { describe, expect, it } from 'vitest';
import {
  getDesktopChromeMetrics,
  getDesktopDensity,
  resolveDesktopWindowBounds,
  type ViewportSize,
} from '../src/lib/desktopLayout';

describe('desktop display scaling layout', () => {
  it('uses compact chrome for common 125%-150% logical resolutions', () => {
    expect(getDesktopDensity({ width: 1920, height: 1080 })).toBe('comfortable');
    expect(getDesktopDensity({ width: 1280, height: 720 })).toBe('compact');
    expect(getDesktopDensity({ width: 1024, height: 640 })).toBe('tight');
    expect(getDesktopDensity({ width: 720, height: 520 })).toBe('tight');
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
});
