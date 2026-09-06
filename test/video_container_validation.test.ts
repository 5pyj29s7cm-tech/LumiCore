import { describe, expect, it } from 'vitest';
import { validateVideoContainer } from '../server/tools/video_container';
import { VALID_MP4, VALID_FRAGMENTED_MP4, VALID_WEBM } from './fixtures/synthetic_video';

describe('bounded generated video container validation', () => {
  it.each([['MP4', VALID_MP4, 'mp4'], ['fragmented MP4', VALID_FRAGMENTED_MP4, 'mp4'], ['WebM', VALID_WEBM, 'webm']] as const)(
    'accepts real synthetic %s video streams without a system parser', (_kind, bytes, extension) => {
      expect(validateVideoContainer(bytes)).toMatchObject({ extension, verification: {
        strategy: 'container_and_video_samples', videoTracks: 1, videoSamples: 2, decoded: false,
      } });
    },
  );
  it.each([Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]),
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]),
    VALID_MP4.subarray(0, -1), VALID_FRAGMENTED_MP4.subarray(0, -1), VALID_WEBM.subarray(0, -1),
  ])('rejects headers and truncated containers', bytes => expect(() => validateVideoContainer(bytes)).toThrow(/container validation failed/));

  it('rejects a movie with no video track', () => {
    const bytes = Buffer.from(VALID_MP4); bytes.write('soun', bytes.indexOf('vide'));
    expect(() => validateVideoContainer(bytes)).toThrow(/no video track/);
  });
  it('rejects a classic MP4 sample offset outside mdat', () => {
    const bytes = Buffer.from(VALID_MP4); const chunkTable = bytes.indexOf('stco');
    expect(chunkTable).toBeGreaterThan(0); bytes.writeUInt32BE(bytes.length + 100, chunkTable + 12);
    expect(() => validateVideoContainer(bytes)).toThrow(/outside media data/);
  });
  it('rejects external data references even when local byte offsets happen to fit', () => {
    const bytes = Buffer.from(VALID_MP4); const reference = bytes.indexOf('url ');
    expect(reference).toBeGreaterThan(0); bytes.writeUInt32BE(0, reference + 4);
    expect(() => validateVideoContainer(bytes)).toThrow(/external video data references/);
  });
  it('rejects a fragmented MP4 sample offset outside mdat', () => {
    const bytes = Buffer.from(VALID_FRAGMENTED_MP4); const run = bytes.indexOf('trun');
    expect(run).toBeGreaterThan(0); bytes.writeInt32BE(bytes.length + 100, run + 12);
    expect(() => validateVideoContainer(bytes)).toThrow(/outside media data/);
  });
  it('rejects a WebM video track with invalid dimensions', () => {
    const bytes = Buffer.from(VALID_WEBM); const width = bytes.indexOf(Buffer.from([0xb0, 0x81, 0x10]));
    expect(width).toBeGreaterThan(0); bytes[width + 2] = 0;
    expect(() => validateVideoContainer(bytes)).toThrow(/dimensions/);
  });
  it('rejects unsupported container data without consulting PATH or downloading anything', () => {
    expect(() => validateVideoContainer(Buffer.from('not a generated video'))).toThrow(/container validation failed/);
  });
});
