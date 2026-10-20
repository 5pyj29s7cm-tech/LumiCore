import type { StructuredMediaRequest } from '../../../shared/media_generation';
import { structuredMediaToolCall } from '../../../shared/media_generation';
import { requestedVideoAudio, requestedVideoDuration } from '../../../shared/video_generation_options';
import { buildMediaArtifactReceipt } from '../../socket/media_artifact_receipt';
import { artifactRecordMatchesTurn } from '../../tools/artifact_evidence';
import { toolRecordTerminalPayload } from '../../tools/receipt_payload';
import type { ToolExecutionRecord } from '../../tools/types';
import type { LumiActionContract } from './contracts';
import { withDefaults } from './contracts';

export function buildMediaGenerationContract(
  toolName: NonNullable<LumiActionContract['mediaGeneration']>['toolName'],
  text: string,
  request?: StructuredMediaRequest,
  sourceVideoRequired = false,
): LumiActionContract {
  const countText = text.match(/(?:生成|创建|制作|画|绘制)\s*([一二两三四五六七八九十\d]+)\s*张/u)?.[1]; // i18n-allow: explicit media count.
  const counts: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }; // i18n-allow: input numbers.
  const brief = request?.prompt || text;
  // A structured creative brief is data. "Open the box" is not a desktop action.
  // Natural compound requests retain their additional delivery/open obligations.
  const multipleKinds = /(?:图片|图像).{0,12}(?:和|以及|再|并).{0,12}视频|\b(?:image|picture).{0,12}(?:and|then).{0,12}video\b/iu.test(text); // i18n-allow: multiple requested media outputs.
  const standalone = Boolean(request) || !multipleKinds && !/(?:发送|发给|上传|发布|导出|写入|保存到|CAD|图纸|文档|PPT)|打开.{0,16}(?:视频|文件|播放器)|\b(?:send|upload|publish|export|document|save to|cad)\b|\bopen\b.{0,32}\b(?:video|file|player)\b/iu.test(text); // i18n-allow: explicit follow-up operations.
  return withDefaults({
    kind: 'media_generation', label: 'Verified media generation',
    mediaGeneration: {
      toolName, standalone,
      ...(sourceVideoRequired ? { sourceVideoRequired: true } : {}),
      duration: request?.duration ?? requestedVideoDuration(brief),
      size: request?.size,
      count: request?.count ?? (countText ? counts[countText] || Number(countText) : 1),
      audioRequired: toolName === 'generate_video' && requestedVideoAudio(brief),
    },
    coreAction: 'Generate the requested media and verify its actual artifact, duration, size and requested audio.',
    preparationIsNotCompletion: ['scripts or storyboards', 'capability checks', 'a different media kind', 'unverified generation claims'],
    requiredEvidence: ['verified current-task media artifact matching the accepted generation requirements'],
    preferredTools: [toolName], verificationTools: [toolName],
    nextStep: 'Use the admitted generation once and verify the existing result; preserve paid output before any recovery.',
    caution: 'Creative brief words do not authorize playback, desktop operations or publication. Artifact verification does not prove advertising quality.',
  });
}

export function mediaContractForRequest(request: StructuredMediaRequest): LumiActionContract {
  return buildMediaGenerationContract(structuredMediaToolCall(request).name, request.prompt, request);
}

/** One evidence verdict for display, task feedback and durable task completion. */
export function evaluateMediaGenerationEvidence(
  contract: LumiActionContract,
  records: ToolExecutionRecord[],
  scope: { taskId?: string; requestId?: string } = {},
) {
  const requirement = contract.mediaGeneration;
  const scoped = records.filter(record => !record.error
    && record.terminalVerification?.status === 'verified'
    && artifactRecordMatchesTurn(record, scope));
  const receipts = scoped.map(record => buildMediaArtifactReceipt(record.name, record.arguments, toolRecordTerminalPayload(record)))
    .filter((receipt): receipt is NonNullable<typeof receipt> => Boolean(receipt));
  const receipt = [...receipts].reverse().find(candidate => candidate.toolName === requirement?.toolName);
  if (!requirement || !requirement.standalone) return { complete: false, receipt, reason: 'media_followup_unverified' as const };
  // This adapter produces T2V/I2V artifacts; none proves an existing-video edit.
  if (!receipt || requirement.sourceVideoRequired) return { complete: false, receipt, reason: 'media_output_type_mismatch' as const };
  if (requirement.toolName === 'generate_video' && requirement.audioRequired && receipt.settings.hasAudio !== true) {
    return { complete: false, receipt, reason: 'media_audio_requirement_unmet' as const };
  }
  if (receipt.settingsMatch === false
    || requirement.duration !== undefined && (!Number.isFinite(receipt.settings.duration)
      || Math.abs(Number(receipt.settings.duration) - requirement.duration) > 0.35)
    || requirement.size && receipt.settings.size !== requirement.size
    || !Number.isSafeInteger(requirement.count) || receipt.artifacts.length < requirement.count) {
    return { complete: false, receipt, reason: 'media_settings_mismatch' as const };
  }
  return { complete: true, receipt, reason: undefined };
}
