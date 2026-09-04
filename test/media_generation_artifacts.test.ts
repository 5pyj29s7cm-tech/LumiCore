import { describe, expect, it } from 'vitest';
import {
  defaultMediaGenerationOperation,
  extractMediaGenerationArtifacts,
  mediaGenerationArgumentsMatch,
  mediaGenerationKindForOperation,
  mediaGenerationReceiptSettingsMatch,
  mediaGenerationToolForOperation,
  resolveMediaGenerationOperation,
} from '../src/lib/mediaGenerationArtifacts';
import { mediaGenerationCopy } from '../src/i18n/locales/mediaGeneration';

describe('media generation artifact extraction', () => {
  it('turns a verified local image artifact into the authenticated preview route', () => {
    const [artifact] = extractMediaGenerationArtifacts(JSON.stringify({
      ok: true,
      status: 'generated',
      verified: true,
      verificationStatus: 'verified',
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

  it('extracts only the durable local video artifact from a verified result', () => {
    const artifacts = extractMediaGenerationArtifacts(JSON.stringify({
      ok: true,
      status: 'generated',
      verified: true,
      verificationStatus: 'verified',
      video_url: 'https://media.example.test/result.mp4',
      outputPath: 'D:\\lumi_output\\result.mp4',
      artifacts: [{ type: 'video', path: 'D:\\lumi_output\\result.mp4' }],
    }), 'video');

    expect(artifacts).toHaveLength(1);
    expect(artifacts.map(artifact => artifact.kind)).toEqual(['video']);
    expect(artifacts.some(artifact => artifact.path === 'D:\\lumi_output\\result.mp4')).toBe(true);
    expect(artifacts.some(artifact => artifact.url === 'https://media.example.test/result.mp4')).toBe(false);
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
  it('maps exact operations to their legacy kind and concrete tool', () => {
    expect(defaultMediaGenerationOperation('image')).toBe('text_to_image');
    expect(defaultMediaGenerationOperation('video')).toBe('text_to_video');
    expect(mediaGenerationKindForOperation('image_edit')).toBe('image');
    expect(mediaGenerationKindForOperation('image_to_video')).toBe('video');
    expect(mediaGenerationToolForOperation('image_edit')).toBe('ai_edit_image');
    expect(resolveMediaGenerationOperation({
      mode: 'video',
      size: '1280x720',
      referenceImage: 'D:\\media\\first.png',
    })).toBe('image_to_video');
  });

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

  it('requires the exact primary and reference images for image editing', () => {
    const expectation = {
      mode: 'image' as const,
      operation: 'image_edit' as const,
      size: '1024x1024',
      primaryImage: 'D:\\media\\source.png',
      referenceImages: ['https://assets.example.test/style.png'],
    };
    expect(mediaGenerationArgumentsMatch(expectation, {
      prompt: 'replace the background',
      size: '1024*1024',
      filePath: 'D:\\media\\source.png',
      referencePaths: ['https://assets.example.test/style.png'],
    })).toBe(true);
    expect(mediaGenerationArgumentsMatch(expectation, {
      prompt: 'replace the background',
      size: '1024x1024',
      filePath: 'D:\\media\\other.png',
      referencePaths: ['https://assets.example.test/style.png'],
    })).toBe(false);
    expect(mediaGenerationArgumentsMatch(expectation, {
      prompt: 'replace the background',
      size: '1024x1024',
      filePath: 'D:\\media\\source.png',
      referencePaths: [],
    })).toBe(false);
  });

  it('does not let an operation claim the wrong kind or silently add a first frame', () => {
    expect(mediaGenerationArgumentsMatch({
      mode: 'image',
      operation: 'text_to_video',
      size: '1280x720',
      duration: 6,
    }, {
      size: '1280x720',
      duration: 6,
    })).toBe(false);
    expect(mediaGenerationArgumentsMatch({
      mode: 'video',
      operation: 'text_to_video',
      size: '1280x720',
      duration: 6,
    }, {
      size: '1280x720',
      duration: 6,
      first_frame_image: 'D:\\media\\unexpected.png',
    })).toBe(false);
  });

  it('matches safe replay settings without persisting the first-frame path in the receipt', () => {
    expect(mediaGenerationReceiptSettingsMatch({
      mode: 'video',
      size: '1280x720',
      duration: 6,
      referenceImage: 'D:\\media\\first.png',
    }, {
      verified: true,
      verificationStatus: 'verified',
      toolName: 'generate_video',
      settings: { size: '1280x720', duration: 6, hasReference: true },
    })).toBe(true);
  });

  it('requires an image-edit receipt from the edit tool with a source assertion when provided', () => {
    const expectation = {
      mode: 'image' as const,
      operation: 'image_edit' as const,
      size: '1024x1024',
      primaryImage: 'D:\\media\\source.png',
    };
    expect(mediaGenerationReceiptSettingsMatch(expectation, {
      verified: true,
      verificationStatus: 'verified',
      toolName: 'ai_edit_image',
      settings: { size: '1024x1024', hasSource: true },
    })).toBe(true);
    expect(mediaGenerationReceiptSettingsMatch(expectation, {
      verified: true,
      verificationStatus: 'verified',
      toolName: 'generate_image',
      settings: { size: '1024x1024', hasSource: true },
    })).toBe(false);
    expect(mediaGenerationReceiptSettingsMatch(expectation, {
      verified: true,
      verificationStatus: 'verified',
      toolName: 'ai_edit_image',
      settings: { size: '1024x1024', hasSource: false },
    })).toBe(false);
  });
});

describe('media generation routing copy', () => {
  it('keeps deterministic routing headings in both locales', () => {
    for (const locale of ['en', 'zh'] as const) {
      const copy = mediaGenerationCopy(locale);
      expect(copy.imageRequest({ prompt: 'scene', size: '1024x1024', count: 1 }).split('\n')[0])
        .toBe('Generate images');
      expect(copy.imageEditRequest({
        prompt: 'edit',
        size: '1024x1024',
        primaryImage: 'D:\\media\\source.png',
      }).split('\n')[0]).toBe('Edit image');
      expect(copy.videoRequest({ prompt: 'motion', size: '1280x720', duration: 6 }).split('\n')[0])
        .toBe('Generate a video');
    }
  });
});
