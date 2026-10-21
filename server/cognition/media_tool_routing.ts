import { mediaCreationInstruction } from './media_creation_intent';

/** Pure media routing facts computed once for the authoritative instruction. */
export function analyzeMediaToolRouting(text: string) {
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const creationInstruction = mediaCreationInstruction(text);
  const routingInstruction = creationInstruction || text;
  // i18n-allow: Existing structured media operation input grammar.
  const structuredMediaCategory = /^(?:生成|创建|制作)图片\s*(?:\r?\n|$)/u.test(text)
    || /^(?:generate|create|make) (?:an? |some )?images?\s*(?:\r?\n|$)/iu.test(text)
    ? 'image_generation'
    : /^edit image\s*(?:\r?\n|$)/iu.test(text)
      ? 'image_editing'
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    : /^(?:生成|创建|制作)视频\s*(?:\r?\n|$)/u.test(text)
      || /^(?:generate|create|make) (?:a )?video\s*(?:\r?\n|$)/iu.test(text)
      ? 'video_generation'
      : null;
  // i18n-allow: Reviewed Chinese image-editing input recognition; not user-visible copy.
  const generativeImageEditRequest = structuredMediaCategory === 'image_editing' || (
    /^(?:请)?(?:帮我)?(?:编辑|修改|重做|重绘|替换|变更).{0,48}(?:图片|图像|照片|海报|主图)/u.test(routingInstruction)
    || /^(?:please\s+)?(?:edit|modify|rework|redraw|replace|change)\b.{0,64}\b(?:image|picture|photo|poster|artwork)\b/iu.test(routingInstruction)
  );
  const mediaGenerationExplicitlyNegated = !structuredMediaCategory && !creationInstruction && (
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    /不再生图|(?:不要|别|无需|不用|不需要|禁止)[\s\S]{0,18}(?:实际)?(?:生成|创建|制作|产出|做)[\s\S]{0,28}(?:图片|图像|插画|海报|视频|短视频|短片|动画|成片)/u.test(routingInstruction)
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    || /(?:不要|别|无需|不用|不需要)[\s\S]{0,8}(?:实际)?(?:生成|创建|制作|产出)/u.test(routingInstruction)
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    || /(?:不是|并非)(?:想|要)?[\s\S]{0,8}(?:生成|创建|制作|产出)/u.test(routingInstruction)
    || /\b(?:do\s+not|don't|never)\b[\s\S]{0,28}\b(?:generate|create|make|produce|render)\b[\s\S]{0,36}\b(?:image|picture|poster|video|clip|animation|movie|short\s+film|reel)\b/i.test(routingInstruction)
    || /\bwithout\b[\s\S]{0,20}\b(?:generating|creating|making|producing|rendering)\b[\s\S]{0,36}\b(?:image|picture|poster|video|clip|animation|movie|short\s+film|reel)\b/i.test(routingInstruction)
  );
  const mediaGenerationMetaQuestion = !structuredMediaCategory && (
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    /^(?:为什么|怎么|如何|是否|能否|图片生成|图像生成|视频生成|短视频生成)[\s\S]{0,80}(?:图片生成|图像生成|视频生成|短视频生成|模型|配置|失败|可用|费用|价格|多少钱|前端|容器|怎么|如何|为什么|是否|能否|吗|？|\?)/u.test(routingInstruction)
    || /^\s*(?:why|how|what|which|is|are|can|could|does|did)\b[\s\S]{0,100}\b(?:image|video)\s+generation\b/i.test(routingInstruction)
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    || /^(?:介绍|说明|解释|讲讲|告诉我)[\s\S]{0,60}(?:图片|图像|视频|短视频)生成(?:功能|能力|模型)?/u.test(routingInstruction)
    || /^\s*(?:image|video)\s+generation\b[\s\S]{0,100}\b(?:model|configure|configuration|fail|available|cost|price|pricing|frontend|container|why|how)\b/i.test(routingInstruction)
    || /^\s*(?:explain|describe|introduce|tell\s+me\s+about)\b[\s\S]{0,80}\b(?:image|video)\s+generation\b/i.test(routingInstruction)
  );
  const existingMediaArtifactAction = !structuredMediaCategory && !generativeImageEditRequest && (
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    /^(?:请|麻烦)?(?:帮我)?(?:查看|打开|删除|分析|检查|编辑|修改|发布|上传|发送|保存|下载|分享|播放)[\s\S]{0,32}(?:刚|已|已经|先前|之前)?(?:生成|创建|制作|产出)(?:的)?[\s\S]{0,20}(?:图|图片|图像|视频|短视频|短片|动画|成片)/u.test(routingInstruction)
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    || /^(?:请|麻烦)?(?:帮我)?(?:把|将)[\s\S]{0,20}(?:刚|已|已经|先前|之前)?(?:生成|创建|制作|产出)[\s\S]{0,20}(?:图片|图像|视频|短视频|短片|动画|成片)[\s\S]{0,24}(?:查看|打开|删除|分析|检查|编辑|修改|发布|上传|发送|保存|下载|分享|播放)/u.test(routingInstruction)
    || /^\s*(?:please\s+)?(?:view|open|delete|analy[sz]e|inspect|check|edit|modify|publish|upload|send|save|download|share|play)\b[\s\S]{0,48}\b(?:generated|created|rendered)\b[\s\S]{0,24}\b(?:image|picture|video|clip|animation|movie)\b/i.test(routingInstruction)
  );
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const requestsCombinedVideoArtifact = /(?:脚本[\s\S]{0,40}(?:再|然后|并|以及|同时)[\s\S]{0,30}(?:生成|创建|制作|产出)[\s\S]{0,24}(?:视频|短视频|成片)|脚本[\s\S]{0,24}(?:和|并|以及|同时)[\s\S]{0,16}(?:视频|短视频|成片))/u.test(routingInstruction)
    || /\b(?:script|copy|outline|prompt)\b[\s\S]{0,48}\b(?:and\s+then|then|and)\b[\s\S]{0,32}\b(?:generate|create|make|produce|render)\b[\s\S]{0,24}\b(?:video|clip|movie)\b/i.test(routingInstruction);
  const mediaTextDeliverableOnly = !structuredMediaCategory && !requestsCombinedVideoArtifact && (
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    /^(?:请|麻烦)?(?:帮我)?(?:生成|创建|制作|编写|写)[\s\S]{0,40}(?:图片|图像|海报|封面|视频|短视频|动画)[\s\S]{0,16}(?:提示词|文案|脚本|大纲|方案|字幕|标题|文字|旁白|分镜)/u.test(routingInstruction)
    || /^\s*(?:please\s+)?(?:generate|create|make|produce|write)\b[\s\S]{0,52}\b(?:copy|brief|prompt|script|outline|plan|subtitles?|titles?|caption|text|narration|storyboard)\b[\s\S]{0,52}\b(?:image|picture|poster|cover|thumbnail|video|clip|movie|animation|short\s+film|reel)\b/i.test(routingInstruction)
    || /^\s*(?:please\s+)?(?:generate|create|make|produce|write)\b[\s\S]{0,52}\b(?:image|picture|poster|cover|thumbnail|video|clip|movie|animation|short\s+film|reel)\b[\s\S]{0,32}\b(?:copy|brief|prompt|script|outline|plan|subtitles?|titles?|caption|text|narration|storyboard)\b/i.test(routingInstruction)
  );
  const mediaCodeOrOfficeDeliverable = !structuredMediaCategory
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    && /(?:\b(?:CSS|HTML|JavaScript|TypeScript|React|Vue|PPT|PowerPoint)\b|组件|网页|页面|幻灯片|演示文稿|播放器|画廊|上传组件)/iu.test(routingInstruction)
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    && /(?:图片|图像|视频|动画|image|video|animation|gallery|player)/iu.test(routingInstruction);
  const forbidGeneration = mediaGenerationExplicitlyNegated
    || mediaGenerationMetaQuestion
    || existingMediaArtifactAction
    || mediaTextDeliverableOnly
    || mediaCodeOrOfficeDeliverable;

  return { structuredMediaCategory, creationInstruction, forbidGeneration };
}
