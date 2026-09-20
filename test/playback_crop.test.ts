import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { cropPlaybackWindow, playbackControlDetail } from '../server/desktop/playback_crop';

describe('read-only player verification framing', () => {
  it('enlarges only the actual bottom controls while leaving the source unchanged', async () => {
    const source = (await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="white"/><rect y="600" width="800" height="200" fill="#123456"/></svg>'))
      .png().toBuffer()).toString('base64');
    const detail = await playbackControlDetail(source);
    expect(detail).toBeTruthy();
    expect(await sharp(Buffer.from(detail!, 'base64')).metadata()).toMatchObject({ width: 1600, height: 400 });
    const stats = await sharp(Buffer.from(detail!, 'base64')).stats();
    expect(stats.channels[0].mean).toBe(18);
    expect(await sharp(Buffer.from(source, 'base64')).metadata()).toMatchObject({ width: 800, height: 800 });
  });
  it('maps a scaled screenshot with a negative monitor origin and clips offscreen borders', async () => {
    const image = { base64: (await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#123456"/></svg>')).png().toBuffer()).toString('base64'), mime: 'image/png' };
    const screen = { screenX: -400, screenY: 0, width: 400, height: 200, inputWidth: 800, inputHeight: 400 };
    const cropped = await cropPlaybackWindow(image, screen, { x: 0, y: -8, width: 380, height: 308 });
    expect(cropped.screen).toEqual({ screenX: 0, screenY: 0, width: 190, height: 150, inputWidth: 380, inputHeight: 300 });
    expect(await sharp(Buffer.from(cropped.base64, 'base64')).metadata()).toMatchObject({ width: 190, height: 150 });
    expect(screen.screenX).toBe(-400);
  });
  it('keeps the original when capture geometry is stale or the target lies offscreen', async () => {
    const image = { base64: (await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#123456"/></svg>')).png().toBuffer()).toString('base64'), mime: 'image/png' };
    const screen = { screenX: 0, screenY: 0, width: 100, height: 100, inputWidth: 100, inputHeight: 100 };
    expect(await cropPlaybackWindow(image, screen, { x: 110, y: 0, width: 100, height: 100 })).toEqual({ ...image, screen });
    expect((await cropPlaybackWindow(image, { ...screen, width: 200 }, { x: 0, y: 0, width: 100, height: 100 })).base64).toBe(image.base64);
  });
});
