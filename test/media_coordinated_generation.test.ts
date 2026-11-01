import { describe, expect, it } from 'vitest';
import { mediaAuthoringMutationScope } from '../server/cognition/media_creation_intent';
import { analyzeMediaToolRouting } from '../server/cognition/media_tool_routing';

describe('coordinated planning and explicit media generation', () => {
  it.each([
    'Create a video script and then generate the video',
    'Write a video outline then generate the video',
    'Create an image prompt and then generate an image',
  ])('keeps the requested final media producer: %s', text => {
    expect(mediaAuthoringMutationScope(text)?.generator).toBe(text.includes('image') ? 'generate_image' : 'generate_video');
    expect(analyzeMediaToolRouting(text).forbidGeneration).toBe(false);
  });
  it.each([
    'Do not create a video script and then generate the video',
    'Create a video script and then generate the video. Do not generate any video.',
    'Explain how to create a video script and then generate the video',
    '请解释如何写视频脚本，然后生成视频。',
    'If we create a video script and then generate the video, what happens?',
    'Read this sentence: "Create a video script and then generate the video".',
    'Create a video script and then generate a video outline',
  ])('does not turn prohibited, quoted, hypothetical or planning text into paid generation: %s', text => {
    expect(mediaAuthoringMutationScope(text)).toBeNull();
  });
});
