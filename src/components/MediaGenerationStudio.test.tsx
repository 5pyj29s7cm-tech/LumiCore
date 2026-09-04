// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  MediaGenerationStudio,
  type MediaGenerationRequest,
  type MediaGenerationStudioProps,
} from './MediaGenerationStudio';
import type { MediaGenerationArtifact } from '@/lib/mediaGenerationArtifacts';

const sourceArtifact: MediaGenerationArtifact = {
  id: 'image-1',
  kind: 'image',
  url: '/api/files/generated?path=source.png&inline=1',
  path: 'D:\\media\\source.png',
  fileName: 'source.png',
};

function studioProps(overrides: Partial<MediaGenerationStudioProps> = {}): MediaGenerationStudioProps {
  return {
    mode: 'image',
    locale: 'en',
    busy: false,
    status: 'idle',
    artifacts: [],
    onModeChange: vi.fn(),
    onClose: vi.fn(),
    onGenerate: vi.fn(),
    onOpenArtifact: vi.fn(),
    onArtifactReady: vi.fn(),
    onArtifactError: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe('MediaGenerationStudio operations', () => {
  it('offers all four operations and submits an image edit with a selected source artifact', () => {
    const onGenerate = vi.fn();
    const onOperationChange = vi.fn();
    const onSourceChange = vi.fn();
    const { container } = render(<MediaGenerationStudio {...studioProps({
      sourceArtifacts: [sourceArtifact, {
        id: 'video-1',
        kind: 'video',
        url: 'https://media.example.test/clip.mp4',
      }],
      onGenerate,
      onOperationChange,
      onSourceChange,
    })} />);

    expect(container.querySelectorAll('[data-media-generation-tab]')).toHaveLength(4);
    fireEvent.click(container.querySelector('[data-media-generation-tab="image_edit"]')!);
    fireEvent.click(screen.getAllByRole('button', { name: 'source.png' })[0]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe what to generate' }), {
      target: { value: 'Keep the subject and replace the background.' },
    });
    fireEvent.submit(container.querySelector('form')!);

    expect(onOperationChange).toHaveBeenCalledWith('image_edit');
    expect(onSourceChange).toHaveBeenCalledWith({
      operation: 'image_edit',
      slot: 'primary',
      value: 'D:\\media\\source.png',
      artifact: sourceArtifact,
    });
    expect(onGenerate).toHaveBeenCalledWith({
      mode: 'image',
      operation: 'image_edit',
      prompt: 'Keep the subject and replace the background.',
      size: '1024x1024',
      primaryImage: 'D:\\media\\source.png',
      referenceImages: [],
      primaryArtifactId: 'image-1',
    });
  });

  it('uses a result as the first frame and exposes open, save, and continuation actions', () => {
    const onGenerate = vi.fn();
    const onModeChange = vi.fn();
    const onOpenArtifact = vi.fn();
    const onSaveArtifact = vi.fn();
    const onContinueEdit = vi.fn();
    const onUseAsVideoReference = vi.fn();
    const { container } = render(<MediaGenerationStudio {...studioProps({
      artifacts: [sourceArtifact],
      onGenerate,
      onModeChange,
      onOpenArtifact,
      onSaveArtifact,
      onContinueEdit,
      onUseAsVideoReference,
    })} />);

    fireEvent.click(screen.getByRole('button', { name: 'View image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download / save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue editing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use as video first frame' }));

    expect(onOpenArtifact).toHaveBeenCalledWith(sourceArtifact);
    expect(onSaveArtifact).toHaveBeenCalledWith(sourceArtifact);
    expect(onContinueEdit).toHaveBeenCalledWith(sourceArtifact);
    expect(onUseAsVideoReference).toHaveBeenCalledWith(sourceArtifact);
    expect(onModeChange).toHaveBeenCalledWith('video');
    expect((screen.getByRole('textbox', { name: 'First-frame image' }) as HTMLInputElement).value)
      .toBe('D:\\media\\source.png');

    fireEvent.change(screen.getByRole('textbox', { name: 'Describe what to generate' }), {
      target: { value: 'A slow push forward.' },
    });
    fireEvent.submit(container.querySelector('form')!);

    expect(onGenerate).toHaveBeenCalledWith({
      mode: 'video',
      operation: 'image_to_video',
      prompt: 'A slow push forward.',
      size: '1280x720',
      duration: 6,
      referenceImage: 'D:\\media\\source.png',
      referenceArtifactId: 'image-1',
    });
  });

  it('cancels active generation and retries the exact supplied request', () => {
    const onCancel = vi.fn();
    const onRetry = vi.fn();
    const retryRequest: MediaGenerationRequest = {
      mode: 'video',
      operation: 'image_to_video',
      prompt: 'Original prompt',
      size: '720x1280',
      duration: 10,
      referenceImage: 'D:\\media\\original.png',
      referenceArtifactId: 'original-artifact',
    };
    const { rerender } = render(<MediaGenerationStudio {...studioProps({
      mode: 'video',
      operation: 'image_to_video',
      status: 'generating',
      busy: true,
      referenceImage: retryRequest.referenceImage,
      retryRequest,
      onCancel,
      onRetry,
    })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel generation' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(<MediaGenerationStudio {...studioProps({
      mode: 'video',
      operation: 'image_to_video',
      status: 'cancelled',
      retryRequest,
      onCancel,
      onRetry,
    })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry same settings' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(retryRequest);
  });
});
