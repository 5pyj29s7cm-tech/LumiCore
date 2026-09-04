import { describe, expect, it } from 'vitest';
import {
  normalizeStructuredMediaRequest,
  structuredMediaRoutingEnvelope,
  structuredMediaToolCall,
} from '../shared/media_generation';
import {
  buildStructuredMediaDeterministicToolRecoveryCall,
  validateRuntimeOwnedDeterministicToolRecoveryCall,
} from '../server/cognition/deterministic_tool_recovery';

describe('structured media workbench requests', () => {
  it('normalizes bounded text-to-image requests and owns the exact tool arguments', () => {
    const request = normalizeStructuredMediaRequest({
      operation: 'text_to_image',
      prompt: 'A luminous spacecraft above a quiet ocean',
      size: '1024*1024',
      count: 9,
      model: 'client-must-not-select-this',
    });

    expect(request).toEqual({
      operation: 'text_to_image',
      prompt: 'A luminous spacecraft above a quiet ocean',
      size: '1024x1024',
      count: 4,
    });
    expect(structuredMediaToolCall(request!)).toEqual({
      name: 'generate_image',
      arguments: {
        prompt: 'A luminous spacecraft above a quiet ocean',
        size: '1024x1024',
        n: 4,
      },
    });
  });

  it('maps image editing and image-to-video to their dedicated tools', () => {
    const edit = normalizeStructuredMediaRequest({
      operation: 'image_edit',
      prompt: 'Keep the subject and replace the background with a studio.',
      size: '1024x1024',
      primaryImage: 'D:\\media\\source.png',
      referenceImages: ['https://assets.example.test/style.png', 'http://unsafe.test/no.png'],
    });
    expect(structuredMediaToolCall(edit!)).toEqual({
      name: 'ai_edit_image',
      arguments: {
        prompt: 'Keep the subject and replace the background with a studio.',
        size: '1024x1024',
        filePath: 'D:\\media\\source.png',
        referencePaths: ['https://assets.example.test/style.png'],
      },
    });

    const video = normalizeStructuredMediaRequest({
      operation: 'image_to_video',
      prompt: 'Slow camera push with subtle wind.',
      size: '1280x720',
      duration: 6,
      referenceImage: 'D:\\media\\first.png',
    });
    expect(structuredMediaToolCall(video!)).toMatchObject({
      name: 'generate_video',
      arguments: { first_frame_image: 'D:\\media\\first.png' },
    });
    expect(structuredMediaRoutingEnvelope(video!)).toContain('Required tool: generate_video');
  });

  it('rejects invalid operations, sizes and missing required references', () => {
    expect(normalizeStructuredMediaRequest({ operation: 'arbitrary_tool', prompt: 'x', size: '1024x1024' })).toBeNull();
    expect(normalizeStructuredMediaRequest({ operation: 'text_to_image', prompt: 'x', size: '99999x1' })).toBeNull();
    expect(normalizeStructuredMediaRequest({ operation: 'image_edit', prompt: 'x', size: '1024x1024' })).toBeNull();
    expect(normalizeStructuredMediaRequest({ operation: 'image_to_video', prompt: 'x', size: '1280x720' })).toBeNull();
  });

  it('admits a runtime-owned media call only for the exact task, revision, request and exposed tool', () => {
    const request = normalizeStructuredMediaRequest({
      operation: 'text_to_image',
      prompt: 'scene',
      size: '1024x1024',
      count: 1,
    })!;
    const candidate = buildStructuredMediaDeterministicToolRecoveryCall(request, {
      taskId: 'task-1',
      taskRevision: 3,
      requestId: 'request-1',
    });
    expect(candidate).toMatchObject({
      source: 'structured_media_request',
      name: 'generate_image',
      arguments: { prompt: 'scene', size: '1024x1024', n: 1 },
    });
    expect(validateRuntimeOwnedDeterministicToolRecoveryCall(candidate, {
      taskId: 'task-1',
      taskRevision: 3,
      requestId: 'request-1',
    }, ['generate_image'])).toMatchObject({
      name: 'generate_image',
      reason: 'structured_media_request',
    });
    expect(validateRuntimeOwnedDeterministicToolRecoveryCall(candidate, {
      taskId: 'task-1',
      taskRevision: 4,
      requestId: 'request-1',
    }, ['generate_image'])).toBeNull();
    expect(validateRuntimeOwnedDeterministicToolRecoveryCall(candidate, {
      taskId: 'task-1',
      taskRevision: 3,
      requestId: 'request-1',
    }, ['generate_video'])).toBeNull();
  });
});
