export type ViewportSize = {
  width: number;
  height: number;
};

export type DesktopDensity = 'comfortable' | 'compact' | 'tight' | 'mini';

export type DesktopChromeMetrics = {
  density: DesktopDensity;
  safeInset: number;
  topInset: number;
  bottomInset: number;
  availableWidth: number;
  availableHeight: number;
};

export type DesktopWindowSnap = 'none' | 'left' | 'right' | 'maximized';

export type DesktopWindowBounds = DesktopChromeMetrics & {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type CompactClientWindowMetrics = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  margin: number;
};

const finiteViewportDimension = (value: number, fallback: number) => (
  Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
);

const clamp = (value: number, minimum: number, maximum: number) => (
  Math.min(maximum, Math.max(minimum, value))
);

/** Resolve the normal (non-widget) compact client size in logical pixels. */
export function getCompactClientWindowMetrics(workArea: ViewportSize): CompactClientWindowMetrics {
  const workWidth = finiteViewportDimension(workArea.width, 1920);
  const workHeight = finiteViewportDimension(workArea.height, 1040);
  const margin = Math.max(12, Math.min(24, Math.round(Math.min(workWidth, workHeight) * 0.02)));
  const availableWidth = Math.max(360, workWidth - margin * 2);
  const availableHeight = Math.max(320, workHeight - margin * 2);
  const minWidth = Math.min(520, availableWidth);
  const minHeight = Math.min(460, availableHeight);
  const presetMinWidth = Math.min(680, availableWidth);
  const presetMinHeight = Math.min(560, availableHeight);

  return {
    width: clamp(1280, presetMinWidth, availableWidth),
    height: clamp(820, presetMinHeight, availableHeight),
    minWidth,
    minHeight,
    margin,
  };
}

export function getDesktopDensity(viewport: ViewportSize): DesktopDensity {
  const width = finiteViewportDimension(viewport.width, 1280);
  const height = finiteViewportDimension(viewport.height, 820);
  if (width < 680 || height < 540) return 'mini';
  if (width < 1040 || height < 680) return 'tight';
  if (width < 1280 || height < 760) return 'compact';
  return 'comfortable';
}

/**
 * Drive the desktop composition from the rendered viewport instead of the
 * native compact-window toggle. This keeps manual resize and DPI changes from
 * leaving the shell in a layout that no longer matches its actual size.
 */
export function shouldUseCompactDesktopLayout(viewport: ViewportSize): boolean {
  const width = finiteViewportDimension(viewport.width, 1280);
  const height = finiteViewportDimension(viewport.height, 820);
  return getDesktopDensity({ width, height }) !== 'comfortable'
    || (width <= 1320 && height <= 860);
}

/** Keep compact Dock positioning free of transform/translate overrides. */
export function getDesktopDockPositionClassName(compactLayout: boolean): string {
  return compactLayout ? 'left-2 right-2' : 'left-1/2 -translate-x-1/2';
}

export function getDesktopChromeMetrics(viewport: ViewportSize): DesktopChromeMetrics {
  const width = finiteViewportDimension(viewport.width, 1280);
  const height = finiteViewportDimension(viewport.height, 820);
  const density = getDesktopDensity({ width, height });
  const safeInset = density === 'mini' ? 4 : density === 'tight' ? 6 : density === 'compact' ? 10 : 16;
  // These match the responsive top bar and dock dimensions in index.css.
  const topInset = density === 'mini' ? 34 : density === 'tight' ? 42 : density === 'compact' ? 44 : 48;
  const bottomInset = density === 'mini' ? 48 : density === 'tight' ? 58 : density === 'compact' ? 72 : 96;

  return {
    density,
    safeInset,
    topInset,
    bottomInset,
    availableWidth: Math.max(240, width - safeInset * 2),
    availableHeight: Math.max(180, height - topInset - bottomInset),
  };
}

export function resolveDesktopWindowBounds(
  viewport: ViewportSize,
  requestedWidth: number,
  requestedHeight: number,
  snap: DesktopWindowSnap = 'none',
): DesktopWindowBounds {
  const width = finiteViewportDimension(viewport.width, 1280);
  const height = finiteViewportDimension(viewport.height, 820);
  const metrics = getDesktopChromeMetrics({ width, height });
  const roomyScale = metrics.density === 'comfortable' && width >= 1500 && height >= 850
    ? Math.min(1.18, width / 1600)
    : 1;
  const preferredWidth = Math.max(240, requestedWidth) * roomyScale;
  const preferredHeight = Math.max(180, requestedHeight) * Math.min(roomyScale, 1.12);
  const normalWidth = Math.round(Math.min(preferredWidth, metrics.availableWidth));
  const normalHeight = Math.round(Math.min(preferredHeight, metrics.availableHeight));
  const fullWidth = snap === 'maximized' || metrics.density !== 'comfortable';
  const snapped = snap !== 'none';
  const resolvedWidth = snapped
    ? (fullWidth ? metrics.availableWidth : Math.floor(metrics.availableWidth / 2))
    : normalWidth;
  const resolvedHeight = snapped ? metrics.availableHeight : normalHeight;
  const normalLeft = Math.max(metrics.safeInset, Math.round((width - normalWidth) / 2));
  const normalTop = Math.max(
    metrics.topInset,
    Math.round(metrics.topInset + (metrics.availableHeight - normalHeight) / 2),
  );
  const snappedLeft = snap === 'right' && !fullWidth
    ? metrics.safeInset + metrics.availableWidth - resolvedWidth
    : metrics.safeInset;

  return {
    ...metrics,
    left: snapped ? snappedLeft : normalLeft,
    top: snapped ? metrics.topInset : normalTop,
    width: resolvedWidth,
    height: resolvedHeight,
  };
}

export function getDesktopIconLayout(viewport: ViewportSize) {
  const density = getDesktopDensity(viewport);
  const compact = density !== 'comfortable';
  const mini = density === 'mini';
  const tight = density === 'tight' || mini;
  const startX = mini ? 4 : compact ? 8 : 40;
  const startY = compact ? 4 : 0;
  const cellWidth = mini ? 76 : tight ? 84 : compact ? 94 : 130;
  const cellHeight = mini ? 82 : tight ? 90 : compact ? 98 : 120;
  const widgetReserve = density === 'comfortable' && viewport.width >= 1280 ? 430 : 0;
  const availableWidth = Math.max(cellWidth, viewport.width - startX * 2 - widgetReserve);
  const columns = Math.max(2, Math.min(tight ? 3 : 4, Math.floor(availableWidth / cellWidth)));

  return { compact, density, startX, startY, cellWidth, cellHeight, columns };
}
