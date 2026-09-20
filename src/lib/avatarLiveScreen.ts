export interface LiveScreenFrame { image_base64: string; width: number; height: number; screen_x: number; screen_y: number }
export interface LiveScreenRegion { x: number; y: number; width: number; height: number; screenWidth: number; screenHeight: number; screenX: number; screenY: number }
export function validateLiveRegion(frame: LiveScreenFrame, region: LiveScreenRegion) {
  if (![frame.width, frame.height, frame.screen_x, frame.screen_y, ...Object.values(region)].every(Number.isFinite)
    || frame.width !== region.screenWidth || frame.height !== region.screenHeight || frame.screen_x !== region.screenX || frame.screen_y !== region.screenY
    || region.x < 0 || region.y < 0 || region.width < 32 || region.height < 32 || region.x + region.width > frame.width || region.y + region.height > frame.height) throw new Error('live_region_changed');
}
export async function captureLiveScreen(): Promise<LiveScreenFrame> {
  const { invoke, isTauri } = await import('@tauri-apps/api/core');
  if (!isTauri()) throw new Error('live_desktop_required');
  const frame = await invoke<LiveScreenFrame>('capture_screen');
  if (!frame.image_base64 || frame.width < 1 || frame.height < 1) throw new Error('live_capture_failed');
  return frame;
}
/** The complete virtual desktop remains local. Only this crop may be sent to OCR. */
export async function cropLiveScreen(frame: LiveScreenFrame, region: LiveScreenRegion): Promise<string> {
  validateLiveRegion(frame, region);
  const image = new Image();
  image.src = `data:image/png;base64,${frame.image_base64}`;
  await image.decode();
  if (image.naturalWidth !== frame.width || image.naturalHeight !== frame.height) throw new Error('live_region_changed');
  const ratio = Math.min(1, 1600 / Math.max(region.width, region.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(region.width * ratio); canvas.height = Math.round(region.height * ratio);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('live_capture_failed');
  context.drawImage(image, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}
