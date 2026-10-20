import fs from 'node:fs';
import { requestedVideoDuration, videoGenerationOptions } from '../../../shared/video_generation_options';
import { getUserPreferredGenerationModels } from '../../llm/generation_preferences';
import path from 'node:path';
import { normalizeStructuredMediaRequest, type StructuredMediaRequest } from '../../../shared/media_generation';
import { mediaGenerationIntent, normalizeActionIntent } from '../../cognition/normalized_action_intent';
import { analyzeMediaToolRouting } from '../../cognition/media_tool_routing';
import { hasExplicitNoMutationInstruction, hasExplicitNoToolInstruction, hasRequestedArtifactMutation } from '../../cognition/tool_intent';
import { generatedKnowledgeDirectory } from '../../files/knowledge_directory';
import { explicitlyReferencesUnfinishedTask, type ActionContinuationHistoryItem } from '../../cognition/action_continuation';
import { isGuardGeneratedConversationRecord } from '../../conversation/guard_history';
import { parseNestedJson, toolRecordTerminalPayload } from '../../tools/receipt_payload';
import { buildMediaArtifactReceipt } from '../media_artifact_receipt';
import type { ChatIncomingAttachment } from './attachments';

type MediaHistoryMessage = ActionContinuationHistoryItem;

// i18n-allow: Explicit approval/version selection, not status questions or new instructions.
const VIDEO_APPROVAL_RE = /^(?:(?:好|好的|可以|确认|确定|开始|继续|就这样|yes|ok|okay)[。！!\s]*$|(?:按|按照|照|就用|用|选).{1,100}(?:来|生成|制作|版本|版)[。！!\s]*$)/iu;
const historyUserText = (item: MediaHistoryMessage) => String(item.message || '').split('\n\n[Attachments]')[0].trim();
const explicitResume = (text: string) => explicitlyReferencesUnfinishedTask(text) && normalizeActionIntent(text).kind !== 'status_query'
  && !hasExplicitNoToolInstruction(text) && !hasExplicitNoMutationInstruction(text) && !hasRequestedArtifactMutation(text);

/** A version choice binds only to the adjacent video proposal and a real user brief. */
function acceptedVideoBrief(text: string, history: readonly MediaHistoryMessage[]): string | null {
  const resume = explicitResume(text) || /^(?:继续|continue)[。！!\s]*$/iu.test(text.trim()); // i18n-allow: Adjacent video continuation only.
  if (!resume && !VIDEO_APPROVAL_RE.test(text.trim())) return null;
  const recent = history.filter(item => item.role !== 'tool').slice(-32).filter(item => {
    if (!isGuardGeneratedConversationRecord(item)) return true;
    // Guard prose cannot replace the creative brief. A real delivered media
    // receipt still closes it, even when the old reply was guard-marked.
    const calls = parseNestedJson(item.toolCalls);
    return Array.isArray(calls) && calls.some(record => buildMediaArtifactReceipt(record.name, record.arguments, toolRecordTerminalPayload(record), record.error));
  });
  const selections = [text];
  if (resume) while (recent.at(-1)?.role === 'user') {
    const selection = historyUserText(recent.pop()!);
    if (!explicitResume(selection) && !VIDEO_APPROVAL_RE.test(selection)) return null;
    selections.unshift(selection);
  }
  const previous = recent.at(-1);
  const proposal = String(previous?.message || previous?.response || '').trim();
  // i18n-allow: The adjacent assistant must still be discussing a video deliverable.
  if (previous?.role !== 'assistant' || !/(?:视频|成片|video|clip)/iu.test(proposal)) return null;
  // i18n-allow: An acknowledgement authorizes creation only after an actual generation/version proposal.
  if (!/(?:需要我|要不要我|要我|是否).{0,100}(?:生成|制作|做)|(?:按|选|用).{0,80}(?:版|风格).{0,20}[？?]|(?:需要你|请你|你回(?:一句)?|请回复).{0,50}(?:确认|确定)|(?:确认|同意).{0,50}(?:后|就).{0,80}(?:生成|制作|成片)|(?:shall I|would you like me).{0,100}(?:generate|create|make)|which.{0,50}(?:version|style)/iu.test(proposal)) return null;
  const revisions: string[] = [];
  for (const item of [...recent].reverse()) {
    if (item.role !== 'user') continue;
    const brief = historyUserText(item);
    const intent = mediaGenerationIntent(brief);
    if (intent?.target === 'generate_video' && intent.operation === 'create') {
      // A proposed script is creative data inside the same validated envelope,
      // never authority to call diagnostics or any other tool.
      // i18n-allow: Strip the assistant approval question from proposed creative content.
      const script = proposal.split(/(?:需要我|要不要我|would you like me|shall I)/iu)[0].split('\n')
        .filter(line => !/(?:执行合同|(?:视频生成|本轮|这轮|调用|开放|启用|关闭|可用).{0,20}工具|能力查询|不能假装|没法直接|卡点|选一个|需要你.*确认)/iu.test(line)).join('\n').trim().slice(0,12000);
      return [brief, script, ...revisions.reverse(), ...selections].filter(Boolean).join('\n\n');
    }
    // i18n-allow: A past-generation complaint with an explicit new video setting is a revision, not a file-write instruction.
    const videoRevision = /(?:画面|视频|比例|尺寸|分辨率|时长|配音|声音).{0,24}(?:要|改为|改成|换成|调整)/u.test(brief)
      && !/(?:Word|文档|报告|脚本|封面)/iu.test(brief); // i18n-allow: Non-video deliverable boundary.
    if ((hasRequestedArtifactMutation(brief) && !videoRevision) || hasExplicitNoToolInstruction(brief) || hasExplicitNoMutationInstruction(brief)) return null;
    if (explicitResume(brief) || VIDEO_APPROVAL_RE.test(brief)) continue;
    if (!['none', 'status_query'].includes(normalizeActionIntent(brief).kind)) return null;
    revisions.push(brief);
  }
  return null;
}

/** Bind video creation to the studio execution lane; verify source ownership and ambiguity here. */
export function resolveChatVideoRequest(
  text: string,
  attachments: ChatIncomingAttachment[],
  scope: { userId: string; domain: 'personal' | 'work'; orgId?: string },
  history: readonly MediaHistoryMessage[] = [],
): StructuredMediaRequest | null {
  if (analyzeMediaToolRouting(text).forbidGeneration) return null;
  const intent = mediaGenerationIntent(text);
  if (intent?.target === 'generate_video' && intent.operation === 'mutate') return null;
  const prompt = intent?.target === 'generate_video' ? text : acceptedVideoBrief(text, history);
  if (!prompt) return null;
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
  const duration = requestedVideoDuration(text) ?? requestedVideoDuration(prompt);
  // The latest explicit shape wins over earlier dimensions and platform defaults.
  // i18n-allow: User dimensions, aspect-ratio separators and orientation names.
  const shape = [...prompt.matchAll(/\b(\d{3,4})\s*[x×*]\s*(\d{3,4})\b|(?:16\s*[:：比]\s*9|9\s*[:：比]\s*16)|横屏|横版|竖屏|竖版|landscape|portrait/giu)].at(-1);
  const preferences = getUserPreferredGenerationModels(scope.userId);
  const options = videoGenerationOptions(referenceImage ? preferences.imageToVideo : preferences.video);
  const portrait = shape ? /9\s*[:：比]\s*16|竖屏|竖版|portrait/iu.test(shape[0]) : /tiktok/iu.test(prompt); // i18n-allow: Explicit orientation before platform default.
  const ratio = portrait ? 9 / 16 : 16 / 9;
  const quality = [...prompt.matchAll(/(480|720|1080)\s*p\b/giu)].at(-1)?.[1];
  const longEdge = quality === '480' ? '832' : quality === '720' ? '1280' : '1920';
  const size = shape?.[1] ? shape[1] + 'x' + shape[2]
    : quality ? (portrait ? quality + 'x' + longEdge : longEdge + 'x' + quality)
    : options?.sizes.find(value => { const [width, height] = value.split('x').map(Number); return Math.abs(width / height - ratio) < 0.02; })
      || (portrait ? '1080x1920' : '1920x1080');
  return normalizeStructuredMediaRequest({
    operation: referenceImage ? 'image_to_video' : 'text_to_video',
    prompt,
    size,
    duration: duration ?? 5,
    ...(referenceImage ? { referenceImage } : {}),
  });
}
