// @vitest-environment jsdom
import React, { useEffect, useState } from 'react';
import { extractSourceExpression } from '../../test/source_expression';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  MediaGenerationStudio,
  EMPTY_MEDIA_GENERATION_SOURCES,
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
    ...EMPTY_MEDIA_GENERATION_SOURCES,
    onSourceChange: vi.fn(),
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

function StudioHarness(props: MediaGenerationStudioProps) {
  const { primaryImage, referenceImages, referenceImage, primaryArtifactId, referenceArtifactIds, referenceArtifactId } = props;
  const initial = { primaryImage, referenceImages, referenceImage, primaryArtifactId, referenceArtifactIds, referenceArtifactId };
  const [sources, setMediaSources] = useState(initial);
  useEffect(() => { setMediaSources(initial); }, [primaryImage, referenceImages, referenceImage, primaryArtifactId, referenceArtifactIds, referenceArtifactId]);
  const change = extractSourceExpression('src/components/AgentChatPage.tsx', 'handleMediaSourceChange', { setMediaSources });
  return <MediaGenerationStudio {...props} {...sources} onSourceChange={value => { change(value); props.onSourceChange(value); }} />;
}

afterEach(cleanup);

describe('MediaGenerationStudio operations', () => {
  it('previews and references archived content while keeping current generation status separate', () => {
    const archived = { ...sourceArtifact, id: 'archive-1', fileId: 'archived.png', url: '/api/files/download/archived.png?inline=1' };
    const props = studioProps({ libraryArtifacts: [archived], onReferenceArtifact: vi.fn(), onRefreshLibrary: vi.fn() });
    const { container, rerender } = render(<StudioHarness {...props} />);
    expect(screen.getByRole('tab', { name: 'Image library (1)' }).getAttribute('aria-selected')).toBe('true');
    const image = container.querySelector('[data-media-generation-results] img')!;
    fireEvent.load(image); fireEvent.error(image);
    expect(props.onArtifactReady).not.toHaveBeenCalled(); expect(props.onArtifactError).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reference in chat' }));
    expect(props.onReferenceArtifact).toHaveBeenCalledWith(archived);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search archived files' }), { target: { value: 'unmatched' } });
    expect(container.querySelectorAll('[data-media-generation-results] article')).toHaveLength(0);
    rerender(<StudioHarness {...props} busy status="generating" />);
    expect(screen.getByRole('tab', { name: 'This generation' }).getAttribute('aria-selected')).toBe('true');
    expect(container.querySelectorAll('[data-media-generation-results] article')).toHaveLength(0);
    fireEvent.click(screen.getByRole('tab', { name: 'Image library (1)' }));
    expect(props.onRefreshLibrary).toHaveBeenCalled();
  });
  it('offers image operations and submits an image edit with a selected source artifact', () => {
    const onGenerate = vi.fn();
    const onOperationChange = vi.fn();
    const onSourceChange = vi.fn();
    const { container } = render(<StudioHarness {...studioProps({
      sourceArtifacts: [sourceArtifact, {
        id: 'video-1',
        kind: 'video',
        url: 'https://media.example.test/clip.mp4',
      }],
      onGenerate,
      onOperationChange,
      onSourceChange,
    })} />);

    expect(container.querySelectorAll('[data-media-generation-tab]')).toHaveLength(2);
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

  it('groups creation types under one header and preserves work when switching to the song workflow', () => {
    function Studio() {
      const [mode, setMode] = React.useState<'image' | 'video'>('image');
      const [song, setSong] = React.useState(false);
      return <StudioHarness {...studioProps()} mode={mode} onModeChange={setMode}
        chatSongActive={song} onOpenChatSong={() => setSong(true)}
        onSelectMedia={kind => { setMode(kind); setSong(false); }}
        chatSongContent={<input aria-label="Episode draft" defaultValue="" />} />;
    }
    const { container } = render(<Studio />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe what to generate' }), { target: { value: 'Keep this prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Video' }));
    expect(screen.getByRole('button', { name: 'Text to video' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Image to video' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit image' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Chat-song' }));
    expect(screen.getByRole('heading', { name: 'AI Creation' })).toBeTruthy();
    expect(container.querySelector('header')?.textContent).not.toContain('Chat-song');
    fireEvent.change(screen.getByRole('textbox', { name: 'Episode draft' }), { target: { value: 'Keep this dialogue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    expect(screen.queryByRole('textbox', { name: 'Episode draft' })).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Describe what to generate' }) as HTMLTextAreaElement).value).toBe('Keep this prompt');
    fireEvent.click(screen.getByRole('button', { name: 'Chat-song' }));
    expect((screen.getByRole('textbox', { name: 'Episode draft' }) as HTMLInputElement).value).toBe('Keep this dialogue');
  });

  it('uses a result as the first frame and exposes open, save, and continuation actions', () => {
    const onGenerate = vi.fn();
    const onModeChange = vi.fn();
    const onOpenArtifact = vi.fn();
    const onSaveArtifact = vi.fn();
    const onContinueEdit = vi.fn();
    const onUseAsVideoReference = vi.fn();
    const { container } = render(<StudioHarness {...studioProps({
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
    const { rerender } = render(<StudioHarness {...studioProps({
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

    rerender(<StudioHarness {...studioProps({
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
  it.each(['image_edit', 'image_to_video'] as const)('clears stale artifact identity when a %s source is replaced manually', operation => {
    const onGenerate = vi.fn();
    const props = studioProps({ onGenerate, operation, mode: operation === 'image_edit' ? 'image' : 'video', sourceArtifacts: [sourceArtifact] });
    const { container } = render(<StudioHarness {...props} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'source.png' })[0]);
    const input = container.querySelector('fieldset input')!;
    fireEvent.change(input, { target: { value: 'D:/media/replacement.png' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe what to generate' }), { target: { value: 'Animate this image' } });
    fireEvent.submit(container.querySelector('form')!);
    const request = onGenerate.mock.calls[0][0];
    expect(request[operation === 'image_edit' ? 'primaryImage' : 'referenceImage']).toBe('D:/media/replacement.png');
    expect(request).not.toHaveProperty(operation === 'image_edit' ? 'primaryArtifactId' : 'referenceArtifactId');
    expect(screen.getAllByRole('button', { name: 'source.png' })[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('uses the parent selection after recovery, clearing old source identities and supporting an optional reference', () => {
    const onGenerate = vi.fn();
    const props = studioProps({ operation: 'image_edit', sourceArtifacts: [sourceArtifact, { ...sourceArtifact, id: 'style-id', fileName: 'style.png', path: 'D:/style.png' }], onGenerate });
    const { container, rerender } = render(<StudioHarness {...props} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'source.png' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'style.png' })[1]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe what to generate' }), { target: { value: 'Keep both characters' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(onGenerate.mock.calls[0][0]).toMatchObject({ primaryArtifactId: 'image-1', referenceArtifactIds: ['style-id'] });
    fireEvent.change(container.querySelectorAll('fieldset input')[1], { target: { value: '' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(onGenerate.mock.calls[1][0]).toMatchObject({ primaryArtifactId: 'image-1', referenceImages: [] });
    expect(onGenerate.mock.calls[1][0]).not.toHaveProperty('referenceArtifactIds');
    rerender(<StudioHarness {...props} primaryImage="D:/media/recovered.png" primaryArtifactId="recovered-id" />);
    fireEvent.submit(container.querySelector('form')!);
    expect(onGenerate.mock.calls[2][0]).toMatchObject({ primaryImage: 'D:/media/recovered.png', primaryArtifactId: 'recovered-id', referenceImages: [] });
    expect(onGenerate.mock.calls[2][0]).not.toHaveProperty('referenceArtifactIds');
    rerender(<StudioHarness {...props} />);
    fireEvent.submit(container.querySelector('form')!);
    expect(onGenerate).toHaveBeenCalledTimes(3);
    expect(container.querySelector('fieldset input')).toHaveProperty('value', '');
  });

});
