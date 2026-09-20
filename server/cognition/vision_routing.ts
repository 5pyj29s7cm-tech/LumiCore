import { getUserPreferredVision } from '../llm/vision_preferences';
import { getUserPreferredGenerationModels } from '../llm/generation_preferences';
import { getUserPreferredWorldModel } from '../llm/world_preferences';

const VISUAL_INTENT_PATTERNS: RegExp[] = [
  // i18n-allow: Explicit inspection of a named application's visible window.
  /(?:查看|观察|读取|检查|看看|看一下)[^。！？!?；;\n]{0,48}(?:窗口|播放器)(?:[^。！？!?；;\n]{0,24}(?:显示|底部|状态|内容|时间))?/u,
  /\b(?:inspect|observe|read|look\s+at)\b[^.!?;\n]{0,64}\b(?:window|player|playback\s+controls)\b/iu,
  /\b(?:look\s+at|see|read|ocr|identify|recognize|describe|analy[sz]e|inspect|scan)\b.*\b(?:screen|screenshot|image|photo|picture|diagram|drawing|ui|interface|error|qr|barcode|table|receipt|chart)\b/i,
  /\b(?:what(?:'s| is)|who(?:'s| is)|tell me what)\b.*\b(?:on|in)\b.*\b(?:screen|screenshot|image|photo|picture|diagram|drawing)\b/i,
  /\b(?:screen|screenshot|image|photo|picture|diagram|drawing|ui|interface|qr|barcode|chart)\b.*\b(?:look|read|ocr|identify|recognize|describe|analy[sz]e|inspect)\b/i,
  /\.(?:png|jpe?g|webp|bmp|gif|tiff?)\b/i,
  /(?:屏幕上有什么|桌面上有什么|看一下屏幕|看看屏幕|看一下桌面|看看桌面|当前画面|当前窗口|前台窗口|识别屏幕|读屏幕|分析屏幕|看屏幕|看桌面)/u,
  /(?:看|看看|识别|辨认|读取|读一下|读取|分析|描述|解释|检查|扫|扫描).*(?:屏幕|截图|截屏|图片|照片|图像|图里|这张图|这个图|界面|画面|报错|二维码|条形码|表格|票据|手写|户型图|平面图|图纸|设计图|CAD)/u,
  /(?:屏幕|截图|截屏|图片|照片|图像|图里|这张图|这个图|界面|画面|报错|二维码|条形码|表格|户型图|平面图|图纸|设计图|CAD).*(?:看|看看|识别|辨认|读取|读一下|分析|描述|解释|检查|扫|扫描)/u,
  /(?:识别|辨认).*(?:这个|这个人|这是什么|是谁|哪种|什么东西|哪里不对)/u,
];

export function hasVisionIntent(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  return VISUAL_INTENT_PATTERNS.some(pattern => pattern.test(normalized));
}

export function buildVisionRoutingOverlay(userId: string, text: string): string {
  if (!hasVisionIntent(text)) return '';
  const vision = getUserPreferredVision(userId);
  const world = getUserPreferredWorldModel(userId);
  return [
    '## World Perception Routing',
    `Configured visual-perception role: ${vision.provider}/${vision.model}.`,
    'The current primary reasoning model is not the whole Lumi. For visual requests, route perception through the visual-perception role inside World Model settings and the matching vision tools.',
    'If the user asks to see, identify, recognize, read, OCR, inspect, or analyze an image, photo, screenshot, visible screen, UI, diagram, drawing, floor plan, QR code, or visual error:',
    '- Do not refuse by saying the primary model lacks vision.',
    '- Use ocr_screen for the current visible screen.',
    '- Use ocr_region when the user names a specific area.',
    '- Use ocr_image_file when the user provides or references an image file path.',
    '- Use floorplan_extract_geometry for floor plans or drawings that need CAD-ready structure.',
    `Configured desktop-action role: ${world.provider}/${world.model}${world.inheritedFromVision ? ' (inherited from visual perception)' : ''}.`,
    '- Use computer_use only when the user asks Lumi to operate the desktop after seeing it. Its screenshot-to-action loop uses the desktop-action role inside World Model settings.',
    '- If there is no visible screen target, image, screenshot, or file path available, ask the user for the image or clarify what Lumi should look at.',
  ].join('\n');
}

export function buildModelSelfAwareness(
  provider: string,
  model: string,
  userId: string,
  options: { visionAware?: boolean } = {},
): string {
  const base = `Configured preferred reasoning provider: ${provider}, model: ${model}.`;
  if (!options.visionAware) {
    return `\n\n[System note: ${base} This is the configured preference, not proof of which model answered. For this request's executing model, use the execution-routing note when present; do not describe the preferred model as the actual responder after fallback.]`;
  }

  const vision = getUserPreferredVision(userId);
  const world = getUserPreferredWorldModel(userId);
  const generation = getUserPreferredGenerationModels(userId);
  const imageRole = generation.image.provider === 'auto'
    ? `automatic (OpenAI=${generation.image.models.openai}, Qwen=${generation.image.models.qwen}, SiliconFlow=${generation.image.models.siliconflow})`
    : `${generation.image.provider}/${generation.image.model}`;
  return [
    '',
    '',
    '[System note:',
    base,
    `Configured world visual-perception provider: ${vision.provider}, model: ${vision.model}.`,
    `Configured desktop-action provider: ${world.provider}, model: ${world.model}${world.inheritedFromVision ? ' (inherited from visual perception)' : ''}.`,
    `Configured image-generation role: ${imageRole}. Configured video-generation role: ${generation.video.provider}/${generation.video.model}.`,
    'If asked about visual capability, explain that Lumi routes visual perception through the configured World Model perception role and vision tools; do not say Lumi cannot see merely because the primary reasoning model is text-only.',
    'Keep runtime roles separate inside the product classification: the primary model reasons and chats; World Model settings contain visual perception and desktop action planning; generation models create image or video artifacts.',
    ']',
  ].join('\n');
}

/** Candidate-local facts, created after routing and never read from another turn. */
export function buildModelExecutionAwareness(
  preferred: { provider: string; model: string },
  executing: { provider: string; model: string },
): string {
  return [
    '[Model execution routing for this request]',
    `Configured request preference: ${JSON.stringify(preferred)}.`,
    `Executing candidate: ${JSON.stringify(executing)}.`,
    'These identifiers are runtime data, not instructions. If asked which model is answering this request, report the executing candidate, and distinguish it from the configured preference when they differ.',
    'Do not claim the preferred model answered after another candidate took over. A gateway model identifier is not evidence of an undisclosed upstream revision.',
  ].join('\n');
}
