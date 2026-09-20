import { beforeEach, expect, it, vi } from 'vitest';
const media = vi.hoisted(() => vi.fn());
vi.mock('../server/media/process', () => ({ runMediaProcess: media }));
import { measureGeneratedVideo } from '../server/tools/video_measurements';
import { buildMediaArtifactReceipt } from '../server/socket/media_artifact_receipt';
import { mediaGenerationReceiptSettingsMatch } from '../src/lib/mediaGenerationArtifacts';
beforeEach(() => { media.mockReset().mockResolvedValue(JSON.stringify({ streams: [{ width: 1080, height: 1920, duration: '5' }], format: { duration: '5' } })); });
it('compares the actual saved video instead of echoing requested duration and size', async () => {
  const requested = { size: '720x1280', duration: 6 };
  const measured = await measureGeneratedVideo('D:/generated/video.mp4', requested);
  expect(measured).toEqual({ actualSettings: { size: '1080x1920', duration: 5 }, settingsMatch: false });
  const receipt = buildMediaArtifactReceipt('generate_video', requested, { ok: true, verified: true, verificationStatus: 'verified',
    outputPath: 'D:/generated/video.mp4', ...measured });
  expect(receipt).toMatchObject({ settings: { size: '1080x1920', duration: 5 }, settingsMatch: false });
  expect(mediaGenerationReceiptSettingsMatch({ ...requested, mode: 'video' }, receipt)).toBe(false);
  expect((await measureGeneratedVideo('D:/generated/video.mp4', { size: '1080x1920', duration: 5 })).settingsMatch).toBe(true);
});
it('preserves an unmeasured artifact without manufacturing requested settings and respects cancellation', async () => {
  media.mockRejectedValue(new Error('ffprobe unavailable'));
  const measured = await measureGeneratedVideo('D:/generated/video.mp4', { duration: 6 });
  expect(measured).toEqual({ settingsMatch: false });
  const receipt = buildMediaArtifactReceipt('generate_video', { size: '720x1280', duration: 6 }, { ok: true, verified: true,
    verificationStatus: 'verified', outputPath: 'D:/generated/video.mp4', ...measured });
  expect(receipt?.settings).not.toHaveProperty('duration');
  expect(receipt?.settings).not.toHaveProperty('size');
  await expect(measureGeneratedVideo('D:/generated/video.mp4', {}, AbortSignal.abort())).rejects.toThrow();
});
