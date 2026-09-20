import sharp from 'sharp';

interface ScreenGeometry { screenX: number; screenY: number; width: number; height: number; inputWidth: number; inputHeight: number }
interface WindowBounds { x: number; y: number; width: number; height: number }

/** Additional read-only detail view; never used for actuation coordinates. */
export async function playbackControlDetail(base64: string): Promise<string | null> {
  try {
    const bytes = Buffer.from(base64, 'base64');
    const meta = await sharp(bytes).metadata();
    if (!meta.width || !meta.height || meta.height < 240) return null;
    const height = Math.min(meta.height, Math.max(180, Math.ceil(meta.height * 0.25)));
    const detail = await sharp(bytes)
      .extract({ left: 0, top: meta.height - height, width: meta.width, height })
      .resize({ width: Math.min(2560, meta.width * 2), kernel: 'lanczos3' })
      .png().toBuffer();
    return detail.toString('base64');
  } catch { return null; }
}

/** Crop a verified window while preserving its virtual-desktop origin and scale. */
export async function cropPlaybackWindow(
  image: { base64: string; mime: string }, screen: ScreenGeometry, window: WindowBounds,
): Promise<{ base64: string; mime: string; screen: ScreenGeometry }> {
  const original = { ...image, screen };
  if (![screen.screenX, screen.screenY, screen.width, screen.height, screen.inputWidth, screen.inputHeight,
    window.x, window.y, window.width, window.height].every(Number.isFinite)
    || Math.min(screen.width, screen.height, screen.inputWidth, screen.inputHeight, window.width, window.height) <= 0) return original;
  try {
    const bytes = Buffer.from(image.base64, 'base64');
    const metadata = await sharp(bytes).metadata();
    // Reject stale/incorrect geometry rather than selecting a different region.
    if (metadata.width !== screen.width || metadata.height !== screen.height) return original;
    const scaleX = screen.width / screen.inputWidth, scaleY = screen.height / screen.inputHeight;
    const left = Math.max(0, Math.floor((window.x - screen.screenX) * scaleX));
    const top = Math.max(0, Math.floor((window.y - screen.screenY) * scaleY));
    const right = Math.min(screen.width, Math.ceil((window.x + window.width - screen.screenX) * scaleX));
    const bottom = Math.min(screen.height, Math.ceil((window.y + window.height - screen.screenY) * scaleY));
    const width = right - left, height = bottom - top;
    if (width < 64 || height < 64) return original;
    const cropped = await sharp(bytes).extract({ left, top, width, height }).png().toBuffer();
    return { base64: cropped.toString('base64'), mime: 'image/png', screen: {
      screenX: screen.screenX + left / scaleX, screenY: screen.screenY + top / scaleY,
      width, height, inputWidth: width / scaleX, inputHeight: height / scaleY,
    } };
  } catch { return original; }
}
