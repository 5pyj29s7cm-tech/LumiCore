import { describe, expect, it } from 'vitest';
import { buildMediaArtifactReceipt } from '../server/socket/media_artifact_receipt';

describe('media artifact socket receipt', () => {
  it('rejects a remote-only result so signed provider URLs never enter a terminal receipt', () => {
    const url = `https://media.example.test/video.mp4?signature=${'a'.repeat(900)}`;
    const receipt = buildMediaArtifactReceipt('generate_video', {
      size: '1280x720',
      duration: 6,
    }, JSON.stringify({
      ok: true,
      status: 'generated',
      verified: true,
      verificationStatus: 'verified',
      prompt: 'private creative prompt',
      provider: 'relay',
      video_url: url,
      artifacts: [{ type: 'video_url', url }],
    }));

    expect(receipt).toBeUndefined();
  });

  it('returns bounded, deduplicated local image artifacts and ignores base64', () => {
    const result = JSON.stringify({
      ok: true,
      status: 'generated',
      verified: true,
      verificationStatus: 'verified',
      images: ['D:\\LumiCore\\generated\\one.png', 'data:image/png;base64,secret'],
      artifacts: [
        { type: 'image', path: 'D:\\LumiCore\\generated\\one.png' },
        { type: 'image', path: 'D:\\LumiCore\\generated\\two.png' },
      ],
      image_base64: 'secret',
    });

    expect(buildMediaArtifactReceipt('generate_image', { size: '1024x1024', n: 2 }, result)?.artifacts).toEqual([
      { kind: 'image', path: 'D:\\LumiCore\\generated\\one.png' },
      { kind: 'image', path: 'D:\\LumiCore\\generated\\two.png' },
    ]);
  });

  it('proves an image edit had a source without exposing that private source path', () => {
    const receipt = buildMediaArtifactReceipt('ai_edit_image', {
      size: '1024x1024',
      filePath: 'D:\\private\\source.png',
    }, JSON.stringify({
      ok: true,
      verified: true,
      verificationStatus: 'verified',
      outputPath: 'D:\\lumi_output\\edited.png',
    }));

    expect(receipt).toMatchObject({
      verified: true,
      verificationStatus: 'verified',
      settings: { size: '1024x1024', hasReference: false, hasSource: true },
    });
    expect(JSON.stringify(receipt)).not.toContain('private');
  });

  it('does not create receipts for failures, unknown tools, prose, or oversized locations', () => {
    expect(buildMediaArtifactReceipt('generate_video', {}, JSON.stringify({ ok: false, video_url: 'https://example.test/x.mp4' }))).toBeUndefined();
    for (const status of ['failed', 'error', 'errored', 'timed_out', 'timeout', 'cancelled', 'canceled', 'aborted', 'blocked', 'rejected']) {
      expect(buildMediaArtifactReceipt('generate_video', {}, JSON.stringify({
        ok: true,
        success: true,
        status,
        video_url: 'https://example.test/not-completed.mp4',
      })), status).toBeUndefined();
    }
    expect(buildMediaArtifactReceipt('generate_image', {}, JSON.stringify({
      ok: true,
      success: true,
      status: 'generated',
      error: 'provider rejected the output',
      images: ['https://example.test/not-completed.png'],
    }))).toBeUndefined();
    expect(buildMediaArtifactReceipt('desktop_open', {}, JSON.stringify({ ok: true, outputPath: 'D:\\x.png' }))).toBeUndefined();
    expect(buildMediaArtifactReceipt('generate_image', {}, 'created successfully')).toBeUndefined();
    expect(buildMediaArtifactReceipt('generate_image', {}, JSON.stringify({
      ok: true,
      images: [`https://example.test/${'x'.repeat(9000)}.png`],
    }))).toBeUndefined();
  });
});
