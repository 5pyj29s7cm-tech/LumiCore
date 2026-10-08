import fs from 'node:fs';
import { videoGenerationOptions } from '../../../shared/video_generation_options';
import { getUserPreferredGenerationModels } from '../../llm/generation_preferences';
import path from 'node:path';
import { normalizeStructuredMediaRequest, type StructuredMediaRequest } from '../../../shared/media_generation';
import { mediaGenerationIntent } from '../../cognition/normalized_action_intent';
import { analyzeMediaToolRouting } from '../../cognition/media_tool_routing';
import { generatedKnowledgeDirectory } from '../../files/knowledge_directory';
import type { ChatIncomingAttachment } from './attachments';

/** Bind an affirmative video request to the same exact execution lane as the studio.
 * Attachment prose never supplies instructions; local images must belong to this workspace.
 * Multiple images remain a model clarification, rather than silently choosing the first.
 */
export function resolveChatVideoRequest(
  text: string,
  attachments: ChatIncomingAttachment[],
  scope: { userId: string; domain: 'personal' | 'work'; orgId?: string },
): StructuredMediaRequest | null {
  if (mediaGenerationIntent(text)?.target !== 'generate_video' || analyzeMediaToolRouting(text).forbidGeneration) return null;
  // i18n-allow: A video cover is an image deliverable, not a video-generation instruction.
  if (/(?:视频|short video|video|clip).{0,24}(?:封面|缩略图|海报|cover|thumbnail|poster)/iu.test(text)) return null;
  const images = attachments.filter(item => item.kind === 'image');
  if (images.length > 1) return null;
  // i18n-allow: An explicit image-to-video instruction needs an actual source.
  if (!images.length && /(?:图片|图像|照片|首帧).{0,40}(?:视频|动画)|animate.{0,32}(?:image|photo|picture)/iu.test(text)) return null;
  let referenceImage: string | undefined;
  if (images.length === 1) {
    const requestedPath = images[0].path;
    if (!requestedPath || !path.isAbsolute(requestedPath)) return null;
    try {
      const directory = fs.realpathSync(generatedKnowledgeDirectory(scope));
      const source = fs.realpathSync(requestedPath);
      const relative = path.relative(directory, source);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(source).isFile()) return null;
      referenceImage = source;
    } catch { return null; }
  }
  // i18n-allow: Read requested duration and aspect ratio from the user's instruction only.
  const duration = text.match(/(\d{1,3})\s*(?:秒|seconds?|secs?\b)/iu)?.[1];
  const dimensions = text.match(/\b(\d{3,4})\s*[x×*]\s*(\d{3,4})\b/iu);
  const preferences = getUserPreferredGenerationModels(scope.userId);
  const options = videoGenerationOptions(referenceImage ? preferences.imageToVideo : preferences.video);
  const portrait = /9\s*[:：]\s*16|竖屏|竖版|portrait|tiktok/iu.test(text); // i18n-allow: User-requested portrait video.
  const size = dimensions ? dimensions[1] + 'x' + dimensions[2]
    : portrait ? options?.sizes.find(value => { const [width, height] = value.split('x').map(Number); return width < height; }) || '720x1280'
    : options?.sizes[0] || '1280x720';
  return normalizeStructuredMediaRequest({
    operation: referenceImage ? 'image_to_video' : 'text_to_video',
    prompt: text,
    size,
    duration: duration ? Number(duration) : 5,
    ...(referenceImage ? { referenceImage } : {}),
  });
}
