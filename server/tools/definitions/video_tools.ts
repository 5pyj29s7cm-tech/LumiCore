import fs from 'fs';
import path from 'path';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { loadKeys } from '../../config/keys';
import {
  DEFAULT_IMAGE_TO_VIDEO_MODELS,
  DEFAULT_VIDEO_GENERATION_MODELS,
  getUserPreferredGenerationModels,
  type VideoGenerationProvider,
} from '../../llm/generation_preferences';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { getGeneratedOutputDir } from '../../config/data_path';
import {
  officialApiBinary,
  officialApiModel,
  officialApiPath,
  officialApiRequest,
} from '../../llm/official_api';
import { assertPublicMediaUrl, downloadPublicMedia, readResponseBytes } from '../media_artifact';

const OUTPUT_DIR = getGeneratedOutputDir();
const POLL_DELAY_MS = process.env.NODE_ENV === 'test' ? 0 : 5_000;
const MAX_POLLS = 120;
const MAX_REMOTE_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const REMOTE_MEDIA_TIMEOUT_MS = 90_000;

function ensureOutputDir(): string {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}

function waitForNextPoll(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, POLL_DELAY_MS));
}

function normalizeSize(value: unknown, separator: 'x' | '*'): string {
  const raw = String(value || '1280x720').trim().replace(/[x*]/i, separator);
  return /^\d{3,4}[x*]\d{3,4}$/i.test(raw) ? raw : `1280${separator}720`;
}

function imageMimeType(filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  return null;
}

async function normalizeVideoReference(value: unknown, label: string): Promise<string | undefined> {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  const dataUrl = raw.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (dataUrl) {
    const normalized = dataUrl[2].replace(/\s+/g, '');
    if (Math.ceil(normalized.length * 3 / 4) > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error(`${label} exceeds the ${MAX_REFERENCE_IMAGE_BYTES} byte limit.`);
    }
    return `data:${dataUrl[1].toLowerCase()};base64,${normalized}`;
  }
  if (/^https:/i.test(raw)) {
    return (await assertPublicMediaUrl(raw)).toString();
  }
  if (/^https?:/i.test(raw)) throw new Error(`${label} must use HTTPS.`);
  if (!path.isAbsolute(raw) || !fs.existsSync(raw) || !fs.statSync(raw).isFile()) {
    throw new Error(`${label} must be an existing local image, an HTTPS URL, or an image data URL.`);
  }
  const bytes = fs.readFileSync(raw);
  if (bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_REFERENCE_IMAGE_BYTES} byte limit.`);
  }
  const mimeType = imageMimeType(raw);
  if (!mimeType) throw new Error(`${label} must be a PNG, JPEG, WebP, or GIF image.`);
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function isI2VModel(model: string): boolean {
  return /(?:^|[\/_-])i2v(?:[\/_-]|$)|image[-_]?to[-_]?video/i.test(model);
}

function isT2VModel(model: string): boolean {
  return /(?:^|[\/_-])t2v(?:[\/_-]|$)|text[-_]?to[-_]?video/i.test(model);
}

function providerKey(provider: VideoGenerationProvider): string {
  const keys = loadKeys();
  if (provider === 'qwen') {
    return process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY
      || keys.DASHSCOPE_API_KEY || keys.QWEN_API_KEY || '';
  }
  if (provider === 'minimax') return process.env.MINIMAX_API_KEY || keys.MINIMAX_API_KEY || '';
  if (provider === 'siliconflow') return process.env.SILICONFLOW_API_KEY || keys.SILICONFLOW_API_KEY || '';
  return process.env.OPENAI_API_KEY || keys.OPENAI_API_KEY || '';
}

async function fetchJson(url: string, init: RequestInit, provider: string): Promise<any> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || body?.message || body?.reason || `HTTP ${response.status}`;
    throw new Error(`${provider} video request failed: ${String(message).slice(0, 400)}`);
  }
  return body;
}

async function persistRemoteVideo(
  url: string,
  provider: string,
  headers: Record<string, string> = {},
): Promise<{ outputPath?: string; downloadError?: string }> {
  try {
    const { bytes } = await downloadPublicMedia(url, {
      headers,
      maxBytes: MAX_REMOTE_VIDEO_BYTES,
      timeoutMs: REMOTE_MEDIA_TIMEOUT_MS,
    });
    const outputPath = path.join(ensureOutputDir(), `${provider}_video_${Date.now()}.mp4`);
    fs.writeFileSync(outputPath, bytes);
    return { outputPath };
  } catch (error: any) {
    return { downloadError: String(error?.message || error).slice(0, 300) };
  }
}

function completedResult(input: {
  provider: VideoGenerationProvider;
  model: string;
  prompt: string;
  taskId: string;
  videoUrl?: string;
  outputPath?: string;
  downloadError?: string;
  generationMode?: 'text_to_video' | 'image_to_video';
  inputReferenceAccepted?: boolean;
  selectionReason?: 'explicit_model' | 'configured_text_to_video_role' | 'configured_image_to_video_role';
}): string {
  const artifacts = input.outputPath
    ? [{ type: 'video', path: input.outputPath }]
    : input.videoUrl
      ? [{ type: 'video_url', url: input.videoUrl }]
      : [];
  return JSON.stringify({
    ok: true,
    status: 'generated',
    success: true,
    provider: input.provider,
    model: input.model,
    prompt: input.prompt,
    taskId: input.taskId,
    generationMode: input.generationMode || 'text_to_video',
    inputReferenceAccepted: input.inputReferenceAccepted === true,
    selectionReason: input.selectionReason || 'configured_text_to_video_role',
    artifactDurability: input.outputPath ? 'local_file' : 'remote_only',
    video_url: input.videoUrl,
    outputPath: input.outputPath,
    artifacts,
    downloadError: input.downloadError,
    tip: input.outputPath
      ? 'Video generation completed and the MP4 was saved locally.'
      : 'Video generation completed. The remote URL may expire; save it locally before expiry.',
  });
}

function completionMetadata(args: Record<string, any>) {
  const imageToVideo = Boolean(args.first_frame_image);
  return {
    generationMode: imageToVideo ? 'image_to_video' as const : 'text_to_video' as const,
    inputReferenceAccepted: imageToVideo,
    selectionReason: (args.__selectionReason || (imageToVideo
      ? 'configured_image_to_video_role'
      : 'configured_text_to_video_role')) as 'explicit_model' | 'configured_text_to_video_role' | 'configured_image_to_video_role',
  };
}

async function generateQwenVideo(args: Record<string, any>, model: string): Promise<string> {
  const apiKey = providerKey('qwen');
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY is not configured in Settings > AI Providers.');
  const prompt = String(args.prompt || '').trim();
  const task = await fetchJson(
    'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify({
        model,
        input: { prompt },
        parameters: {
          size: normalizeSize(args.size, '*'),
          prompt_extend: args.prompt_extend !== false,
          watermark: false,
          seed: Number.isFinite(Number(args.seed)) ? Number(args.seed) : Math.floor(Math.random() * 2_147_483_647),
        },
      }),
    },
    'Qwen / DashScope',
  );
  if (task.code) throw new Error(`DashScope video error (${task.code}): ${task.message || 'unknown error'}`);
  const taskId = String(task.output?.task_id || '');
  if (!taskId) throw new Error('DashScope video generation returned no task ID.');

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await waitForNextPoll();
    const status = await fetchJson(
      `https://dashscope.aliyuncs.com/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      'Qwen / DashScope',
    );
    const state = status.output?.task_status;
    if (state === 'SUCCEEDED') {
      const videoUrl = String(status.output?.video_url || '');
      if (!videoUrl) throw new Error('DashScope completed the task but returned no video URL.');
      const saved = await persistRemoteVideo(videoUrl, 'qwen');
      return completedResult({ provider: 'qwen', model, prompt, taskId, videoUrl, ...saved, ...completionMetadata(args) });
    }
    if (state === 'FAILED' || status.code) {
      throw new Error(`DashScope video generation failed: ${status.output?.message || status.message || 'unknown error'}`);
    }
  }
  throw new Error(`DashScope video generation timed out. Task: ${taskId}`);
}

async function generateMiniMaxVideo(args: Record<string, any>, model: string): Promise<string> {
  const apiKey = providerKey('minimax');
  if (!apiKey) throw new Error('MINIMAX_API_KEY is not configured in Settings > AI Providers.');
  const prompt = String(args.prompt || '').trim();
  const payload: Record<string, unknown> = {
    model,
    prompt,
    duration: Math.max(1, Math.round(Number(args.duration) || 6)),
    resolution: String(args.resolution || '1080P'),
  };
  if (args.first_frame_image) payload.first_frame_image = String(args.first_frame_image);
  if (args.last_frame_image) payload.last_frame_image = String(args.last_frame_image);

  const task = await fetchJson('https://api.minimaxi.com/v1/video_generation', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 'MiniMax');
  const taskId = String(task.task_id || '');
  if (!taskId) throw new Error(`MiniMax video generation returned no task ID: ${task.base_resp?.status_msg || 'unknown response'}`);

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await waitForNextPoll();
    const status = await fetchJson(
      `https://api.minimaxi.com/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      'MiniMax',
    );
    if (status.status === 'Success') {
      const fileId = String(status.file_id || '');
      if (!fileId) throw new Error('MiniMax completed the task but returned no file ID.');
      const file = await fetchJson(
        `https://api.minimaxi.com/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
        'MiniMax',
      );
      const videoUrl = String(file.file?.download_url || '');
      if (!videoUrl) throw new Error('MiniMax returned no video download URL.');
      const saved = await persistRemoteVideo(videoUrl, 'minimax');
      return completedResult({ provider: 'minimax', model, prompt, taskId, videoUrl, ...saved, ...completionMetadata(args) });
    }
    if (status.status === 'Fail') {
      throw new Error(`MiniMax video generation failed: ${status.error_message || status.base_resp?.status_msg || 'unknown error'}`);
    }
  }
  throw new Error(`MiniMax video generation timed out. Task: ${taskId}`);
}

function siliconFlowBaseUrl(): string {
  return String(process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
}

async function generateSiliconFlowVideo(args: Record<string, any>, model: string): Promise<string> {
  const apiKey = providerKey('siliconflow');
  if (!apiKey) throw new Error('SILICONFLOW_API_KEY is not configured in Settings > AI Providers.');
  const prompt = String(args.prompt || '').trim();
  const baseUrl = siliconFlowBaseUrl();
  const task = await fetchJson(`${baseUrl}/video/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      image_size: normalizeSize(args.size, 'x'),
      negative_prompt: args.negative_prompt ? String(args.negative_prompt) : undefined,
      seed: Number.isFinite(Number(args.seed)) ? Number(args.seed) : undefined,
    }),
  }, 'SiliconFlow');
  const taskId = String(task.requestId || '');
  if (!taskId) throw new Error(`SiliconFlow video generation returned no request ID: ${task.message || 'unknown response'}`);

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await waitForNextPoll();
    const status = await fetchJson(`${baseUrl}/video/status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: taskId }),
    }, 'SiliconFlow');
    if (status.status === 'Succeed') {
      const videoUrl = String(status.results?.videos?.[0]?.url || '');
      if (!videoUrl) throw new Error('SiliconFlow completed the task but returned no video URL.');
      const saved = await persistRemoteVideo(videoUrl, 'siliconflow');
      return completedResult({ provider: 'siliconflow', model, prompt, taskId, videoUrl, ...saved, ...completionMetadata(args) });
    }
    if (status.status === 'Failed') {
      throw new Error(`SiliconFlow video generation failed: ${status.reason || status.message || 'unknown error'}`);
    }
  }
  throw new Error(`SiliconFlow video generation timed out. Task: ${taskId}`);
}

function openAIBaseUrl(): string {
  const keys = loadKeys();
  const configured = String(process.env.OPENAI_BASE_URL || keys.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
  return /\/v1$/i.test(configured) ? configured : `${configured}/v1`;
}

function openAIDuration(value: unknown): string {
  const requested = Number(value) || 4;
  return String([4, 8, 12].reduce((best, current) => (
    Math.abs(current - requested) < Math.abs(best - requested) ? current : best
  ), 4));
}

async function generateOpenAIVideo(args: Record<string, any>, model: string): Promise<string> {
  const apiKey = providerKey('openai');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured in Settings > AI Providers.');
  const prompt = String(args.prompt || '').trim();
  const baseUrl = openAIBaseUrl();
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', prompt);
  form.set('seconds', openAIDuration(args.duration));
  form.set('size', normalizeSize(args.size, 'x'));
  const task = await fetchJson(`${baseUrl}/videos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  }, 'OpenAI');
  const taskId = String(task.id || '');
  if (!taskId) throw new Error('OpenAI video generation returned no video ID.');

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await waitForNextPoll();
    const status = await fetchJson(
      `${baseUrl}/videos/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      'OpenAI',
    );
    if (status.status === 'completed') {
      const response = await fetch(`${baseUrl}/videos/${encodeURIComponent(taskId)}/content`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) throw new Error(`OpenAI video download failed: HTTP ${response.status}`);
      const outputPath = path.join(ensureOutputDir(), `openai_video_${Date.now()}.mp4`);
      fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
      return completedResult({ provider: 'openai', model, prompt, taskId, outputPath, ...completionMetadata(args) });
    }
    if (status.status === 'failed') {
      throw new Error(`OpenAI video generation failed: ${status.error?.message || 'unknown error'}`);
    }
  }
  throw new Error(`OpenAI video generation timed out. Video ID: ${taskId}`);
}

function officialVideoPayload(args: Record<string, any>, model: string): FormData {
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', String(args.prompt || '').trim());
  form.set('duration', String(Math.max(1, Math.round(Number(args.duration) || 4))));
  form.set('size', normalizeSize(args.size, 'x'));
  if (args.first_frame_image) form.set('input_reference', String(args.first_frame_image));
  if (args.last_frame_image) form.set('last_frame_image', String(args.last_frame_image));
  return form;
}

function officialVideoTaskId(body: any): string {
  return String(body?.id || body?.task_id || body?.data?.id || body?.data?.task_id || body?.output?.task_id || '').trim();
}

function officialVideoUrl(body: any): string {
  return String(body?.video_url || body?.url || body?.data?.video_url || body?.data?.url
    || body?.output?.video_url || body?.output?.url || body?.result?.video_url
    || body?.result?.url || body?.result_url || body?.data?.result_url || '').trim();
}

function saveBase64Video(value: unknown): string | undefined {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:[^;,]+;base64,(.+)$/i);
  const encoded = match?.[1] || (/^[A-Za-z0-9+/=\r\n]+$/.test(raw) && raw.length > 100 ? raw : '');
  if (!encoded) return undefined;
  if (Math.ceil(encoded.replace(/\s+/g, '').length * 3 / 4) > MAX_REMOTE_VIDEO_BYTES) {
    throw new Error(`Generated video exceeds the ${MAX_REMOTE_VIDEO_BYTES} byte limit.`);
  }
  const outputPath = path.join(ensureOutputDir(), `official_video_${Date.now()}.mp4`);
  fs.writeFileSync(outputPath, Buffer.from(encoded.replace(/\s+/g, ''), 'base64'));
  return outputPath;
}

/** OpenAI-compatible asynchronous video generation through Lumi's gateway. */
async function generateOfficialVideo(args: Record<string, any>, selectedModel: string): Promise<string> {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');
  const imageToVideo = Boolean(args.first_frame_image);
  const model = officialApiModel(
    imageToVideo ? 'RELAY_IMAGE_TO_VIDEO_MODEL' : 'RELAY_VIDEO_MODEL',
    selectedModel || (imageToVideo ? DEFAULT_IMAGE_TO_VIDEO_MODELS.relay : DEFAULT_VIDEO_GENERATION_MODELS.relay),
  );
  // ModelDepot documents JSON POST /v1/videos/generations. A deployment can
  // opt into multipart for an OpenAI-compatible gateway with the explicit
  // override rather than making the documented path an accidental fallback.
  const pathName = officialApiPath('RELAY_VIDEO_PATH', '/videos/generations');
  const useJson = process.env.RELAY_VIDEO_REQUEST_FORMAT?.toLowerCase() !== 'multipart';
  const payload = {
    model,
    prompt,
    duration: Math.max(1, Math.round(Number(args.duration) || 4)),
    size: normalizeSize(args.size, 'x'),
    ...(args.first_frame_image ? { input_reference: String(args.first_frame_image) } : {}),
    ...(args.last_frame_image ? { last_frame_image: String(args.last_frame_image) } : {}),
  };
  const request = await officialApiRequest<any>(pathName, {
    method: 'POST',
    headers: useJson ? { 'Content-Type': 'application/json' } : {},
    body: useJson ? JSON.stringify(payload) : officialVideoPayload(args, model),
    timeoutMs: 90_000,
  });
  const taskId = officialVideoTaskId(request.body);
  const immediateUrl = officialVideoUrl(request.body);
  const immediatePath = saveBase64Video(request.body?.b64_json || request.body?.base64 || request.body?.video_base64);
  if (!taskId && !immediateUrl && !immediatePath) throw new Error('Lumi Official API video generation returned no task or video reference.');
  if (!taskId) {
    const saved = immediatePath ? { outputPath: immediatePath } : immediateUrl ? await persistRemoteVideo(immediateUrl, 'official') : {};
    return completedResult({ provider: 'relay', model, prompt, taskId: 'completed', videoUrl: immediateUrl, ...saved, ...completionMetadata(args) });
  }

  const statusTemplate = officialApiPath('RELAY_VIDEO_STATUS_PATH', '/videos/generations/{id}');
  const contentTemplate = officialApiPath('RELAY_VIDEO_CONTENT_PATH', '/videos/generations/{id}/content');
  const maxPolls = Math.max(1, Math.min(120, Number(process.env.RELAY_VIDEO_MAX_POLLS) || MAX_POLLS));
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    await waitForNextPoll();
    const encodedId = encodeURIComponent(taskId);
    const statusPath = statusTemplate.replace(/\{id\}/gi, encodedId);
    const { body } = await officialApiRequest<any>(statusPath, { timeoutMs: 90_000 });
    const state = String(body?.status || body?.state || body?.output?.status || '').toLowerCase();
    const videoUrl = officialVideoUrl(body);
    const base64Path = saveBase64Video(body?.b64_json || body?.base64 || body?.video_base64);
    if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(state) || videoUrl || base64Path) {
      if (base64Path) return completedResult({ provider: 'relay', model, prompt, taskId, videoUrl, outputPath: base64Path, ...completionMetadata(args) });
      if (videoUrl) {
        const saved = await persistRemoteVideo(videoUrl, 'official');
        return completedResult({ provider: 'relay', model, prompt, taskId, videoUrl, ...saved, ...completionMetadata(args) });
      }
      // Some gateways return a completed task without a URL in the status
      // body and expose the bytes at a separate content endpoint.
      try {
        const content = await officialApiBinary(contentTemplate.replace(/\{id\}/gi, encodedId));
        const outputPath = path.join(ensureOutputDir(), `official_video_${Date.now()}.mp4`);
        fs.writeFileSync(outputPath, await readResponseBytes(content, MAX_REMOTE_VIDEO_BYTES));
        return completedResult({ provider: 'relay', model, prompt, taskId, outputPath, ...completionMetadata(args) });
      } catch (error: any) {
        throw new Error(`Lumi Official API video completed but content download failed: ${String(error?.message || error).slice(0, 300)}`);
      }
    }
    if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(state)) {
      throw new Error(`Lumi Official API video generation failed: ${String(body?.error?.message || body?.message || body?.error || 'unknown error').slice(0, 300)}`);
    }
  }
  throw new Error(`Lumi Official API video generation timed out. Task: ${taskId}`);
}

async function generateVideo(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');

  const firstFrame = await normalizeVideoReference(args.first_frame_image, 'first_frame_image');
  const lastFrame = await normalizeVideoReference(args.last_frame_image, 'last_frame_image');
  if (lastFrame && !firstFrame) throw new Error('last_frame_image requires first_frame_image.');
  const generationMode = firstFrame ? 'image_to_video' : 'text_to_video';
  const preferences = getUserPreferredGenerationModels(context?.userId || 'anonymous');
  const preference = generationMode === 'image_to_video' ? preferences.imageToVideo : preferences.video;
  const provider = preference.provider;
  const model = String(
    args.model
    || preference.model
    || preference.models[provider]
    || (generationMode === 'image_to_video'
      ? DEFAULT_IMAGE_TO_VIDEO_MODELS[provider]
      : DEFAULT_VIDEO_GENERATION_MODELS[provider])
    || '',
  ).trim();
  if (!model) throw new Error(`No video generation model is configured for ${provider}.`);
  if (generationMode === 'image_to_video' && isT2VModel(model)) {
    throw new Error(`The selected model ${model} is text-to-video only. Configure an image-to-video model.`);
  }
  if (generationMode === 'text_to_video' && isI2VModel(model)) {
    throw new Error(`The selected model ${model} requires a reference image.`);
  }
  if (generationMode === 'image_to_video' && provider !== 'relay' && provider !== 'minimax') {
    throw new Error(`${provider} does not have a verified image-to-video input adapter in this build.`);
  }

  const normalizedArgs = {
    ...args,
    ...(firstFrame ? { first_frame_image: firstFrame } : {}),
    ...(lastFrame ? { last_frame_image: lastFrame } : {}),
    __selectionReason: args.model
      ? 'explicit_model'
      : generationMode === 'image_to_video'
        ? 'configured_image_to_video_role'
        : 'configured_text_to_video_role',
  };

  if (provider === 'qwen') return generateQwenVideo(normalizedArgs, model);
  if (provider === 'minimax') return generateMiniMaxVideo(normalizedArgs, model);
  if (provider === 'siliconflow') return generateSiliconFlowVideo(normalizedArgs, model);
  if (provider === 'relay') return generateOfficialVideo(normalizedArgs, model);
  return generateOpenAIVideo(normalizedArgs, model);
}

export function registerVideoTools(registry: ToolRegistry): void {
  registry.register({
    name: 'generate_video',
    description: 'Generate text-to-video or image-to-video output with the separately configured model for that mode. A local reference image is safely converted to a bounded data URL before a verified I2V adapter is called; unsupported providers fail instead of silently falling back to text-to-video.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Describe the scene, motion, lighting, camera angle, and style.' },
        model: { type: 'string', description: 'Optional explicit model override. Otherwise the configured video model is used.' },
        size: { type: 'string', description: 'Requested output size, such as 1280x720, 720x1280, or 960x960.' },
        duration: { type: 'number', description: 'Requested duration in seconds. The selected provider may normalize it to a supported duration.' },
        resolution: { type: 'string', description: 'MiniMax resolution, such as 1080P or 768P.' },
        first_frame_image: { type: 'string', description: 'Optional first-frame image: absolute local path, HTTPS URL, or image data URL. Its presence selects the image-to-video role.' },
        last_frame_image: { type: 'string', description: 'Optional last-frame image in the same formats; requires first_frame_image and provider support.' },
        negative_prompt: { type: 'string', description: 'Optional SiliconFlow negative prompt.' },
        prompt_extend: { type: 'boolean', description: 'Qwen prompt expansion. Defaults to true.' },
        seed: { type: 'number', description: 'Random seed when supported by the selected provider.' },
      },
      required: ['prompt'],
    },
    handler: (args, context) => generateVideo(args, context),
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'media.video.generate',
      family: 'media-generation',
      lane: 'media',
      operation: 'create',
      risk: 'medium',
      sideEffects: [
        { type: 'external_state_change', scope: 'configured video generation provider task', reversible: false },
        { type: 'local_write', scope: 'generated MP4 when provider output can be downloaded', reversible: true },
      ],
      verification: {
        strategy: 'provider_ack',
        required: true,
        requiredFields: ['ok', 'status', 'provider', 'model', 'taskId', 'generationMode', 'inputReferenceAccepted', 'selectionReason', 'artifactDurability', 'artifacts'],
        requiredValues: { ok: true },
        successStatuses: ['generated'],
        failureStatuses: ['failed', 'timed_out'],
        successSignals: ['provider task completed and returned a local artifact or remote video reference'],
        limitations: ['A remote video URL is provider completion evidence, not proof of a durable local MP4.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'media.video.generate',
      operation: 'create',
      limitations: ['If local download fails, completion is limited to the provider result and must be reported as such.'],
    }),
  });
}
