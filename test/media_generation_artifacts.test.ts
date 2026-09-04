import { describe, expect, it } from 'vitest';
import {
  extractMediaGenerationArtifacts,
  mediaGenerationArgumentsMatch,
  mediaGenerationReceiptSettingsMatch,
} from '../src/lib/mediaGenerationArtifacts';

describe('media generation artifact extraction', () => {
  it('turns a verified local image artifact into the authenticated preview route', () => {
    const [artifact] = extractMediaGenerationArtifacts(JSON.stringify({
      ok: true,
      status: 'generated',
      artifacts: [{ type: 'image', path: 'C:\\Users\\Lumi\\lumi_output\\poster.png' }],
    }), 'image');

    expect(artifact).toMatchObject({
      kind: 'image',
      path: 'C:\\Users\\Lumi\\lumi_output\\poster.png',
      fileName: 'poster.png',
    });
    expect(artifact.url).toContain('/api/files/generated?path=');
    expect(artifact.url).toContain('&inline=1');
  });

  it('extracts durable and remote video artifacts from a completed tool receipt', () => {
    const artifacts = extractMediaGenerationArtifacts(JSON.stringify({
      ok: true,
      status: 'generated',
      video_url: 'https://media.example.test/result.mp4',
      outputPath: 'D:\\lumi_output\\result.mp4',
      artifacts: [{ type: 'video', path: 'D:\\lumi_output\\result.mp4' }],
    }), 'video');

    expect(artifacts).toHaveLength(2);
    expect(artifacts.map(artifact => artifact.kind)).toEqual(['video', 'video']);
    expect(artifacts.some(artifact => artifact.path === 'D:\\lumi_output\\result.mp4')).toBe(true);
    expect(artifacts.some(artifact => artifact.url === 'https://media.example.test/result.mp4')).toBe(true);
  });

  it('does not turn completion prose into a fake artifact', () => {
    expect(extractMediaGenerationArtifacts('The image is complete.', 'image')).toEqual([]);
  });

  it('rejects failed result payloads even when they contain a URL', () => {
    expect(extractMediaGenerationArtifacts(JSON.stringify({
      ok: false,
      status: 'failed',
      video_url: 'https://example.test/not-created.mp4',
    }), 'video')).toEqual([]);
  });
});

describe('media generation request binding', () => {
  it('accepts image settings only when size and count match', () => {
    expect(mediaGenerationArgumentsMatch(
      { mode: 'image', size: '1024x1024', count: 2 },
      { prompt: 'scene', size: '1024*1024', n: 2 },
    )).toBe(true);
    expect(mediaGenerationArgumentsMatch(
      { mode: 'image', size: '1024x1024', count: 2 },
      { prompt: 'scene', size: '1024x1024', n: 1 },
    )).toBe(false);
  });

  it('requires the selected video duration and first frame', () => {
    const expectation = {
      mode: 'video' as const,
      size: '1280x720',
      duration: 6,
      referenceImage: 'D:\\media\\first.png',
    };
    expect(mediaGenerationArgumentsMatch(expectation, {
      prompt: 'motion',
      size: '1280x720',
      duration: 6,
      first_frame_image: 'D:\\media\\first.png',
    })).toBe(true);
    expect(mediaGenerationArgumentsMatch(expectation, {
      prompt: 'motion',
      size: '1280x720',
      duration: 5,
    })).toBe(false);
  });

  it('matches safe replay settings without persisting the first-frame path in the receipt', () => {
    expect(mediaGenerationReceiptSettingsMatch({
      mode: 'video',
      size: '1280x720',
      duration: 6,
      referenceImage: 'D:\\media\\first.png',
    }, {
      toolName: 'generate_video',
      settings: { size: '1280x720', duration: 6, hasReference: true },
    })).toBe(true);
  });
});
