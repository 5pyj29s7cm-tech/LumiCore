import fs from 'fs';
import { classifyCloudError } from '../../cloud/core';
import { mediaGenerationIntent } from '../../cognition/normalized_action_intent';
import { generateVideoSequence } from '../video_composition';
import { videoGenerationOptions } from '../../../shared/video_generation_options';
import { requireNotStrict } from '../../config/privacy';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { loadKeys } from '../../config/keys';
import {
  DEFAULT_IMAGE_TO_VIDEO_MODELS,
  DEFAULT_VIDEO_GENERATION_MODELS,
  getUserPreferredGenerationModels,
  type VideoGenerationProvider,
  assertOfficialGenerationModel,
} from '../../llm/generation_preferences';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { getGeneratedOutputDir } from '../../config/data_path';
import {
  officialApiBinary,
  officialApiModel,
  officialApiPath,
  officialApiRequest,
  listOfficialApiModels,
  OfficialApiHttpError,
  getOfficialApiConfig,
  isDefiniteOfficialVideoRejection,
} from '../../llm/official_api';
import { assertMediaTaskOwner, prepareVideoGenerationTask, readVideoGenerationTask, saveMediaGenerationTask,
  videoGenerationRecoveryId, type OfficialVideoGenerationTask } from '../media_generation_journal';
import { executionIdempotencyKey } from '../registry';
import { downloadPublicMedia, readResponseBytes } from '../media_artifact';
import { cancelDashScopeTaskBestEffort } from '../dashscope_async_task';
import { CN_MEDIA_PROGRESS } from '../../regions/packs/cn/media_progress';
import { validateVideoContainer } from '../video_container';
import { measureGeneratedVideo, fitGeneratedVideoSize, type VideoSettings } from '../video_measurements';

const OUTPUT_DIR = getGeneratedOutputDir();
const POLL_DELAY_MS = process.env.NODE_ENV === 'test' ? 0 : 5_000;
const MAX_POLLS = 120;
const MAX_REMOTE_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_DECODED_REFERENCE_PIXELS = 40_000_000;
const REMOTE_MEDIA_TIMEOUT_MS = 90_000;
const require = createRequire(import.meta.url);

type VideoProgressReporter = ToolContext['onProgress'];

function reportVideoProgress(onProgress: VideoProgressReporter, message: string): void {
  try { onProgress?.(message); } catch {
    // Progress reporting is observational and must not change the generation outcome.
  }
}

function reportSubmitted(onProgress: VideoProgressReporter, provider: string): void {
  reportVideoProgress(onProgress, CN_MEDIA_PROGRESS.providerVideoSubmitted(provider));
  reportVideoProgress(onProgress, CN_MEDIA_PROGRESS.providerVideoRunning(provider));
}

async function tryCancelDashScopeVideoTask(
  taskId: string,
  apiKey: string,
  onProgress?: VideoProgressReporter,
): Promise<void> {
  const { outcome } = await cancelDashScopeTaskBestEffort(taskId, apiKey);
  if (outcome === 'remote_cancelled') {
    reportVideoProgress(onProgress, CN_MEDIA_PROGRESS.qwenRemoteCancelled);
    return;
  }
  if (outcome === 'remote_cancel_rejected_state') {
    reportVideoProgress(onProgress, CN_MEDIA_PROGRESS.qwenRemoteCancelUnavailable);
    return;
  }
  reportVideoProgress(onProgress, CN_MEDIA_PROGRESS.qwenRemoteCancelFailed);
}

function ensureOutputDir(): string {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}

function writeVideoAtomically(
  bytes: Buffer,
  provider: string,
  signal?: AbortSignal,
  onBeforeWrite?: () => void,
): string {
  throwIfAborted(signal);
  const { extension } = validateVideoContainer(bytes);
  throwIfAborted(signal);
  onBeforeWrite?.();
  const outputDir = ensureOutputDir();
  const uniqueSuffix = `${Date.now()}_${crypto.randomUUID()}`;
  const outputPath = path.join(outputDir, `${provider}_video_${uniqueSuffix}.${extension}`);
  const temporaryPath = path.join(outputDir, `.${provider}_video_${uniqueSuffix}.${crypto.randomUUID()}.partial`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx');
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    throwIfAborted(signal);
    fs.renameSync(temporaryPath, outputPath);
    return outputPath;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason || new DOMException('Video generation cancelled', 'AbortError');
}

function waitForNextPoll(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, POLL_DELAY_MS);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new DOMException('Video generation cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function normalizeSize(value: unknown, separator: 'x' | '*'): string {
  const raw = String(value || '1280x720').trim().replace(/[x*]/i, separator);
  return /^\d{3,4}[x*]\d{3,4}$/i.test(raw) ? raw : `1280${separator}720`;
}

async function verifiedReferenceMimeType(
  bytes: Buffer,
  label: string,
  signal?: AbortSignal,
): Promise<'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'> {
  throwIfAborted(signal);
  if (bytes.length === 0) throw new Error(`${label} is empty.`);
  if (bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_REFERENCE_IMAGE_BYTES} byte limit.`);
  }
  try {
    const sharp = require('sharp');
    const inputOptions = { failOn: 'error' as const, limitInputPixels: MAX_DECODED_REFERENCE_PIXELS };
    const metadata = await sharp(bytes, inputOptions).metadata();
    const format = String(metadata?.format || '').toLowerCase();
    const mimeType = format === 'png' ? 'image/png'
      : format === 'jpeg' || format === 'jpg' ? 'image/jpeg'
        : format === 'webp' ? 'image/webp'
          : format === 'gif' ? 'image/gif'
            : null;
    if (!mimeType || !metadata?.width || !metadata?.height) throw new Error('unsupported image format');
    // metadata alone only proves a plausible container; stats forces a real
    // pixel decode before the bytes are sent to a paid video provider.
    await sharp(bytes, inputOptions).stats();
    throwIfAborted(signal);
    return mimeType;
  } catch (error) {
    throwIfAborted(signal);
    throw new Error(`${label} is not a decodable PNG, JPEG, WebP, or GIF image.`, { cause: error });
  }
}

async function normalizeVideoReference(
  value: unknown,
  label: string,
  signal?: AbortSignal,
  size?: string,
): Promise<string | undefined> {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  const dataUrl = raw.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  let bytes: Buffer;
  if (dataUrl) {
    bytes = Buffer.from(dataUrl[2].replace(/\s+/g, ''), 'base64');
  } else if (/^https:/i.test(raw)) {
    ({ bytes } = await downloadPublicMedia(raw, {
      maxBytes: MAX_REFERENCE_IMAGE_BYTES,
      timeoutMs: REMOTE_MEDIA_TIMEOUT_MS,
      signal,
    }));
  } else {
    if (/^https?:/i.test(raw)) throw new Error(`${label} must use HTTPS.`);
    if (!path.isAbsolute(raw) || !fs.existsSync(raw) || !fs.statSync(raw).isFile()) {
      throw new Error(`${label} must be an existing local image, an HTTPS URL, or an image data URL.`);
    }
    bytes = fs.readFileSync(raw);
  }
  let mimeType = await verifiedReferenceMimeType(bytes, label, signal);
  if (size) {
    const [width, height] = normalizeSize(size, 'x').split('x').map(Number);
    bytes = await require('sharp')(bytes, { limitInputPixels: MAX_DECODED_REFERENCE_PIXELS })
      .rotate().resize(width, height, { fit: 'contain', background: '#000000' }).png().toBuffer();
    mimeType = 'image/png';
    throwIfAborted(signal);
  }
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
  signal?: AbortSignal,
  onBeforeWrite?: () => void,
): Promise<{ outputPath: string }> {
  try {
    const { bytes } = await downloadPublicMedia(url, {
      headers,
      maxBytes: MAX_REMOTE_VIDEO_BYTES,
      timeoutMs: REMOTE_MEDIA_TIMEOUT_MS,
      signal,
    });
    throwIfAborted(signal);
    onBeforeWrite?.();
    const outputPath = writeVideoAtomically(bytes, provider, signal);
    return { outputPath };
  } catch (error: any) {
    throwIfAborted(signal);
    throw new Error(
      `${provider} completed video generation, but LumiCore could not verify and save the returned media: ${String(error?.message || error).slice(0, 300)}`,
      { cause: error },
    );
  }
}

async function completedResult(input: {
  provider: VideoGenerationProvider;
  model: string;
  prompt: string;
  taskId: string;
  videoUrl?: string;
  outputPath: string;
  requestedSettings: VideoSettings;
  generationMode?: 'text_to_video' | 'image_to_video';
  inputReferenceAccepted?: boolean;
  selectionReason?: 'explicit_model' | 'configured_text_to_video_role' | 'configured_image_to_video_role';
  signal?: AbortSignal;
  onProgress?: VideoProgressReporter;
}): Promise<string> {
  throwIfAborted(input.signal);
  let measurements = await measureGeneratedVideo(input.outputPath, input.requestedSettings, input.signal);
  if (input.provider === 'relay' && input.generationMode === 'image_to_video' && videoGenerationOptions(input)?.fixedDuration) {
    measurements = await fitGeneratedVideoSize(input.outputPath, input.requestedSettings, measurements, input.signal);
  }
  throwIfAborted(input.signal);
  const artifacts = [{ type: 'video', path: input.outputPath }];
  const result = JSON.stringify({
    ok: true,
    status: 'generated',
    success: true,
    verified: true,
    verificationStatus: 'verified',
    verification: { strategy: 'container_and_video_samples', decoded: false },
    ...measurements,
    requestedSettings: input.requestedSettings,
    provider: input.provider,
    model: input.model,
    prompt: input.prompt,
    taskId: input.taskId,
    generationMode: input.generationMode || 'text_to_video',
    inputReferenceAccepted: input.inputReferenceAccepted === true,
    selectionReason: input.selectionReason || 'configured_text_to_video_role',
    artifactDurability: 'local_file',
    outputPath: input.outputPath,
    artifacts,
    tip: [measurements.settingsMatch ? 'Video saved; measured size and duration match the request.'
      : 'Video saved, but its output settings do not match the request or could not be measured. Preserve this file and report its actual settings; do not claim the requested settings or automatically regenerate.',
      measurements.actualSettings?.hasAudio === true ? 'An audio track was detected; its speech, music and content are not verified.'
        : measurements.actualSettings?.hasAudio === false ? 'No audio track was found. Do not claim voice, music or sound effects were generated; do not automatically regenerate.'
          : 'Audio could not be verified. Do not claim voice, music or sound effects were generated.'].join(' '),
  });
  reportVideoProgress(
    input.onProgress,
    (measurements.settingsMatch ? CN_MEDIA_PROGRESS.videoCompleteSaved : CN_MEDIA_PROGRESS.videoSettingsReview) + ' ' + CN_MEDIA_PROGRESS.videoAudioStatus(measurements.actualSettings?.hasAudio),
  );
  return result;
}

function completionMetadata(args: Record<string, any>) {
  const imageToVideo = Boolean(args.first_frame_image);
  return {
    requestedSettings: {
      ...(String(args.size || '').trim() ? { size: String(args.size).trim().replace('*', 'x') } : {}),
      ...(Number(args.duration) > 0 ? { duration: Number(args.duration) } : {}),
    },
    generationMode: imageToVideo ? 'image_to_video' as const : 'text_to_video' as const,
    inputReferenceAccepted: imageToVideo,
    selectionReason: (args.__selectionReason || (imageToVideo
      ? 'configured_image_to_video_role'
      : 'configured_text_to_video_role')) as 'explicit_model' | 'configured_text_to_video_role' | 'configured_image_to_video_role',
  };
}

async function generateQwenVideo(
  args: Record<string, any>,
  model: string,
  signal?: AbortSignal,
  onProgress?: VideoProgressReporter,
): Promise<string> {
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
      signal,
    },
    'Qwen / DashScope',
  );
  if (task.code) throw new Error(`DashScope video error (${task.code}): ${task.message || 'unknown error'}`);
  const taskId = String(task.output?.task_id || '');
  if (!taskId) throw new Error('DashScope video generation returned no task ID.');
  reportSubmitted(onProgress, 'DashScope');

  try {
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      await waitForNextPoll(signal);
      const status = await fetchJson(
        `https://dashscope.aliyuncs.com/api/v1/tasks/${encodeURIComponent(taskId)}`,
        { headers: { Authorization: `Bearer ${apiKey}` }, signal },
        'Qwen / DashScope',
      );
      const state = status.output?.task_status;
      if (state === 'SUCCEEDED') {
        const videoUrl = String(status.output?.video_url || '');
        if (!videoUrl) throw new Error('DashScope completed the task but returned no video URL.');
        reportVideoProgress(onProgress, CN_MEDIA_PROGRESS.videoDownloading);
        const saved = await persistRemoteVideo(videoUrl, 'qwen', {}, signal);
        return completedResult({ provider: 'qwen', model, prompt, taskId, videoUrl, ...saved, ...completionMetadata(args), signal, onProgress });
      }
      if (state === 'FAILED' || status.code) {
        throw new Error(`DashScope video generation failed: ${status.output?.message || status.message || 'unknown error'}`);
      }
    }
  } catch (error: any) {
    if (signal?.aborted) {
      await tryCancelDashScopeVideoTask(taskId, apiKey, onProgress);
      throw signal?.reason || error;
    }
    throw error;
  }
  throw new Error(`DashScope video generation timed out. Task: ${taskId}`);
}

async function generateMiniMaxVideo(
  args: Record<string, any>,
  model: string,
  signal?: AbortSignal,
  onProgress?: VideoProgressReporter,
): Promise<string> {
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
    signal,
  }, 'MiniMax');
  const taskId = String(task.task_id || '');
  if (!taskId) throw new Error(`MiniMax video generation returned no task ID: ${task.base_resp?.status_msg || 'unknown response'}`);
  reportSubmitted(onProgress, 'MiniMax');

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await waitForNextPoll(signal);
    const status = await fetchJson(
      `https://api.minimaxi.com/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal },
      'MiniMax',
    );
    if (status.status === 'Success') {
      reportVideoProgress(onProgress, CN_MEDIA_PROGRESS.videoRetrieving);
      const fileId = String(status.file_id || '');
      if (!fileId) throw new Error('MiniMax completed the task but returned no file ID.');
      const file = await fetchJson(
        `https://api.minimaxi.com/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
        { headers: { Authorization: `Bearer ${apiKey}` }, signal },
        'MiniMax',
      );
      const videoUrl = String(file.file?.download_url || '');
      if (!videoUrl) throw new Error('MiniMax returned no video download URL.');
      const saved = await persistRemoteVideo(videoUrl, 'minimax', {}, signal);
      return completedResult({ provider: 'minimax', model, prompt, taskId, videoUrl, ...saved, ...completionMetadata(args), signal, onProgress });
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

async function generateSiliconFlowVideo(
  args: Record<string, any>,
  model: string,
  signal?: AbortSignal,
  onProgress?: VideoProgressReporter,
): Promise<string> {
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
    signal,
  }, 'SiliconFlow');
  const taskId = String(task.requestId || '');
  if (!taskId) throw new Error(`SiliconFlow video generation returned no request ID: ${task.message || 'unknown response'}`);
  reportSubmitted(onProgress, 'SiliconFlow');

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await waitForNextPoll(signal);
    const status = await fetchJson(`${baseUrl}/video/status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: taskId }),
      signal,
    }, 'SiliconFlow');
    if (status.status === 'Succeed') {
      const videoUrl = String(status.results?.videos?.[0]?.url || '');
      if (!videoUrl) throw new Error('SiliconFlow completed the task but returned no video URL.');
      reportVideoProgress(onProgress, CN_MEDIA_PROGRESS.videoDownloading);
      const saved = await persistRemoteVideo(videoUrl, 'siliconflow', {}, signal);
      return completedResult({ provider: 'siliconflow', model, prompt, taskId, videoUrl, ...saved, ...completionMetadata(args), signal, onProgress });
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

async function generateOpenAIVideo(
  args: Record<string, any>,
  model: string,
  signal?: AbortSignal,
  onProgress?: VideoProgressReporter,
): Promise<string> {
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
    signal,
  }, 'OpenAI');
  const taskId = String(task.id || '');
  if (!taskId) throw new Error('OpenAI video generation returned no video ID.');
  reportSubmitted(onProgress, 'OpenAI');

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await waitForNextPoll(signal);
    const status = await fetchJson(
      `${baseUrl}/videos/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal },
      'OpenAI',
    );
    if (status.status === 'completed') {
      reportVideoProgress(onProgress, CN_MEDIA_PROGRESS.videoDownloading);
      const response = await fetch(`${baseUrl}/videos/${encodeURIComponent(taskId)}/content`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      if (!response.ok) throw new Error(`OpenAI video download failed: HTTP ${response.status}`);
      const bytes = await readResponseBytes(response, MAX_REMOTE_VIDEO_BYTES, signal);
      throwIfAborted(signal);
      const outputPath = writeVideoAtomically(bytes, 'openai', signal);
      return completedResult({ provider: 'openai', model, prompt, taskId, outputPath, ...completionMetadata(args), signal, onProgress });
    }
    if (status.status === 'failed') {
      throw new Error(`OpenAI video generation failed: ${status.error?.message || 'unknown error'}`);
    }
  }
  throw new Error(`OpenAI video generation timed out. Video ID: ${taskId}`);
}

function officialVideoPayload(payload: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    form.set(key === 'image' ? 'input_reference' : key,
      typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return form;
}

function officialVideoTaskId(body: any): string {
  return String(body?.id || body?.task_id || body?.jobId || body?.job_id || body?.data?.id || body?.data?.task_id || body?.data?.jobId || body?.data?.job_id || body?.output?.task_id || body?.output?.jobId || body?.output?.job_id || '').trim();
}

function officialVideoUrl(body: any): string {
  return String(body?.video_url || body?.url || body?.data?.video_url || body?.data?.url
    || body?.output?.video_url || body?.output?.url || body?.result?.video_url
    || body?.result?.url || body?.result_url || body?.data?.result_url || '').trim();
}

function saveBase64Video(
  value: unknown,
  signal?: AbortSignal,
  onBeforeWrite?: () => void,
): string | undefined {
  throwIfAborted(signal);
  const raw = String(value || '').trim();
  const match = raw.match(/^data:[^;,]+;base64,(.+)$/i);
  const encoded = match?.[1] || (/^[A-Za-z0-9+/=\r\n]+$/.test(raw) && raw.length > 100 ? raw : '');
  if (!encoded) return undefined;
  if (Math.ceil(encoded.replace(/\s+/g, '').length * 3 / 4) > MAX_REMOTE_VIDEO_BYTES) {
    throw new Error(`Generated video exceeds the ${MAX_REMOTE_VIDEO_BYTES} byte limit.`);
  }
  throwIfAborted(signal);
  return writeVideoAtomically(
    Buffer.from(encoded.replace(/\s+/g, ''), 'base64'),
    'official',
    signal,
    onBeforeWrite,
  );
}

function officialVideoGatewayDigest(): string {
  const url = new URL(getOfficialApiConfig().baseUrl);
  return crypto.createHash('sha256').update(JSON.stringify([url.origin, url.pathname,
    officialApiPath('RELAY_VIDEO_STATUS_PATH', '/videos/generations/{id}'),
    officialApiPath('RELAY_VIDEO_CONTENT_PATH', '/videos/generations/{id}/content')])).digest('hex');
}
function videoTaskReceipt(task: OfficialVideoGenerationTask, reason: string, status = 'unknown', queryRetryable = false): string {
  return JSON.stringify({ ok: false, success: false, status, verified: false, verificationStatus: 'unverified',
    provider: task.provider, model: task.model, taskId: task.providerTaskId, recoveryId: task.recoveryId,
    recoveryTool: 'get_video_generation_status', automaticResubmissionBlocked: true, reason,
    ...(queryRetryable ? { queryRetryable: true } : {}),
    ...(task.compositionSegment ? { compositionSegment: true, wholeTaskCompleted: false } : {}) });
}
async function completeOfficialVideoTask(task: OfficialVideoGenerationTask, body: any, context?: ToolContext, prompt = ''): Promise<string> {
  const signal = context?.executionSignal;
  assertMediaTaskOwner(task, context);
  const url = officialVideoUrl(body) || task.videoUrl;
  if (url) { task.videoUrl = url; task.updatedAt = new Date().toISOString(); saveMediaGenerationTask(task); }
  let outputPath = task.outputPath && fs.existsSync(task.outputPath) ? task.outputPath : '';
  if (!outputPath) outputPath = saveBase64Video(body?.b64_json || body?.base64 || body?.video_base64, signal, () => assertMediaTaskOwner(task, context)) || '';
  if (!outputPath && url) outputPath = (await persistRemoteVideo(url, 'official', {}, signal, () => assertMediaTaskOwner(task, context))).outputPath;
  if (!outputPath && task.providerTaskId) {
    const content = await officialApiBinary(officialApiPath('RELAY_VIDEO_CONTENT_PATH', '/videos/generations/{id}/content')
      .replace(/\{id\}/gi, encodeURIComponent(task.providerTaskId)), { signal });
    const bytes = await readResponseBytes(content, MAX_REMOTE_VIDEO_BYTES, signal);
    assertMediaTaskOwner(task, context);
    outputPath = writeVideoAtomically(bytes, 'official', signal);
  }
  if (!outputPath) return videoTaskReceipt(task, 'The original provider supplied no retrievable video artifact.');
  assertMediaTaskOwner(task, context);
  task.outputPath = outputPath; task.updatedAt = new Date().toISOString(); saveMediaGenerationTask(task);
  const result = JSON.parse(await completedResult({ provider: 'relay', model: task.model, prompt,
    taskId: task.providerTaskId || 'completed', videoUrl: url, outputPath, ...task.settings, signal, onProgress: context?.onProgress }));
  assertMediaTaskOwner(task, context);
  const receipt = JSON.stringify({ ...result, recoveryId: task.recoveryId,
    ...(task.compositionSegment ? { compositionSegment: true, wholeTaskCompleted: false } : { reconciliationStatus: 'committed' }) });
  task.artifactSha256 = crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex');
  task.state = 'completed'; task.result = receipt; task.updatedAt = new Date().toISOString(); saveMediaGenerationTask(task);
  return receipt;
}
const activeVideoQueries = new Map<string, Promise<string>>();
async function queryOfficialVideoTask(task: OfficialVideoGenerationTask, context?: ToolContext, prompt = ''): Promise<string> {
  assertMediaTaskOwner(task, context);
  const active = activeVideoQueries.get(task.recoveryId);
  if (active) { const result = await active; assertMediaTaskOwner(task, context); return result; }
  const query = queryOfficialVideoTaskOnce(task, context, prompt);
  activeVideoQueries.set(task.recoveryId, query);
  try { const result = await query; assertMediaTaskOwner(task, context); return result; }
  finally { if (activeVideoQueries.get(task.recoveryId) === query) activeVideoQueries.delete(task.recoveryId); }
}
async function queryOfficialVideoTaskOnce(task: OfficialVideoGenerationTask, context?: ToolContext, prompt = ''): Promise<string> {
  task = readVideoGenerationTask(task.recoveryId, context) || task;
  assertMediaTaskOwner(task, context);
  if (task.state === 'completed' && task.result && task.outputPath && fs.existsSync(task.outputPath)) {
    try {
      const bytes = fs.readFileSync(task.outputPath); validateVideoContainer(bytes);
      if (crypto.createHash('sha256').update(bytes).digest('hex') === task.artifactSha256) return task.result;
    } catch { /* Retrieve the original again. */ }
    task.outputPath = undefined; task.result = undefined; task.state = 'accepted'; saveMediaGenerationTask(task);
  }
  if (['failed', 'cancelled', 'rejected'].includes(task.state)) return videoTaskReceipt(task, 'The original task reached an unsuccessful terminal state.', task.state);
  if (!task.providerTaskId && !task.videoUrl && !task.outputPath) return videoTaskReceipt(task, 'No provider task identity was received. No submission will be sent.');
  let statusReceived = false;
  try {
    if (task.gatewayDigest !== officialVideoGatewayDigest()) return videoTaskReceipt(task, 'Restore the original official gateway paths to query this task.');
    const body = task.providerTaskId ? (await officialApiRequest<any>(officialApiPath('RELAY_VIDEO_STATUS_PATH', '/videos/generations/{id}')
      .replace(/\{id\}/gi, encodeURIComponent(task.providerTaskId)), { timeoutMs: 15_000, signal: context?.executionSignal })).body : {};
    statusReceived = true;
    assertMediaTaskOwner(task, context);
    const state = String(body?.status || body?.state || body?.output?.status || '').toLowerCase();
    if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(state)) {
      task.state = ['cancelled', 'canceled'].includes(state) ? 'cancelled' : 'failed';
      task.updatedAt = new Date().toISOString(); saveMediaGenerationTask(task);
      return videoTaskReceipt(task, 'The provider reported an unsuccessful terminal state.', task.state);
    }
    if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(state) || officialVideoUrl(body)
      || body?.b64_json || body?.base64 || body?.video_base64 || task.videoUrl || task.outputPath) {
      return await completeOfficialVideoTask(task, body, context, prompt);
    }
    return videoTaskReceipt(task, 'The original accepted task has not completed.', 'pending');
  } catch (error) {
    assertMediaTaskOwner(task, context);
    const failure = classifyCloudError(error instanceof Error ? error : new Error(String(error)));
    return videoTaskReceipt(task, 'The original task was retained; status or artifact retrieval did not complete.', 'unknown',
      !statusReceived && task.state === 'accepted' && Boolean(task.providerTaskId) && failure.isRetryable && ['network', 'timeout', 'server_error'].includes(failure.category));
  }
}
/** The existing journal is the barrier before POST and before reporting acceptance. */
async function generateOfficialVideo(args: Record<string, any>, selectedModel: string, signal?: AbortSignal,
  onProgress?: VideoProgressReporter, allowDefiniteRejection = true, context?: ToolContext, journalArgs = args): Promise<string> {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');
  const ownerContext = { ...context, executionSignal: signal, onProgress };
  const { task, created } = prepareVideoGenerationTask(journalArgs, selectedModel, completionMetadata(args), officialVideoGatewayDigest(), ownerContext);
  if (!created) return queryOfficialVideoTask(task, ownerContext, prompt);
  const useJson = process.env.RELAY_VIDEO_REQUEST_FORMAT?.toLowerCase() !== 'multipart';
  const options = videoGenerationOptions({ provider: 'relay', model: selectedModel });
  const duration = Math.max(1, Math.round(Number(args.duration) || 4)), size = normalizeSize(args.size, 'x');
  const [width, height] = size.split('x').map(Number);
  const payload = { model: selectedModel, prompt, duration, size,
    ...(args.first_frame_image ? { image: String(args.first_frame_image) } : {}),
    ...(args.last_frame_image ? { last_frame_image: String(args.last_frame_image) } : {}),
    ...(options && !options.fixedDuration ? { extra_body: { parameters: { duration,
      resolution: size.includes('1080') ? '1080P' : size.includes('720') ? '720P' : '480P', prompt_extend: args.prompt_extend === true,
      ratio: args.first_frame_image ? 'adaptive' : width === height ? '1:1' : width > height ? '16:9' : '9:16', ...(typeof args.audio === 'boolean' ? { audio: args.audio } : {}), ...(Number.isInteger(args.seed) ? { seed: args.seed } : {}) } } } : {}),
  };
  let body: any;
  try {
    assertMediaTaskOwner(task, ownerContext);
    body = (await officialApiRequest<any>(officialApiPath('RELAY_VIDEO_PATH', '/videos/generations'), {
      method: 'POST', headers: useJson ? { 'Content-Type': 'application/json' } : {},
      body: useJson ? JSON.stringify(payload) : officialVideoPayload(payload), timeoutMs: 90_000, signal })).body;
  } catch (error) {
    if (error instanceof OfficialApiHttpError) {
      task.providerTaskId = officialVideoTaskId(error.responseBody);
      task.videoUrl = officialVideoUrl(error.responseBody) || undefined;
      if (allowDefiniteRejection && !task.providerTaskId && !task.videoUrl
        && !(error.responseBody as any)?.video_base64 && !(error.responseBody as any)?.b64_json && !(error.responseBody as any)?.base64) error.videoSubmissionRejected = true;
    }
    task.state = task.providerTaskId || task.videoUrl ? 'accepted' : isDefiniteOfficialVideoRejection(error) ? 'rejected' : 'unknown';
    task.updatedAt = new Date().toISOString(); saveMediaGenerationTask(task);
    assertMediaTaskOwner(task, ownerContext);
    if (task.state === 'rejected') throw error;
    return videoTaskReceipt(task, 'The original submission outcome is retained; no automatic resubmission is permitted.');
  }
  // Persist the upstream identity before polling, downloading or measuring.
  task.providerTaskId = officialVideoTaskId(body); task.videoUrl = officialVideoUrl(body) || undefined;
  task.state = task.providerTaskId || task.videoUrl || body?.b64_json || body?.base64 || body?.video_base64 ? 'accepted' : 'unknown';
  task.updatedAt = new Date().toISOString(); saveMediaGenerationTask(task);
  assertMediaTaskOwner(task, ownerContext);
  if (!task.providerTaskId) {
    try { return await completeOfficialVideoTask(task, body, ownerContext, prompt); }
    catch { assertMediaTaskOwner(task, ownerContext); return videoTaskReceipt(task, 'The original immediate artifact has not been safely retrieved.'); }
  }
  reportSubmitted(onProgress, CN_MEDIA_PROGRESS.officialProvider);
  while (true) {
    await waitForNextPoll(signal);
    const result = await queryOfficialVideoTask(task, ownerContext, prompt);
    const receipt = JSON.parse(result);
    if (receipt.status !== 'pending' && receipt.queryRetryable !== true) return result;
  }
}

function assertVideoRoleModel(model: string, generationMode: 'image_to_video' | 'text_to_video'): void {
  if (generationMode === 'image_to_video' && isT2VModel(model)) throw new Error(`The selected model ${model} is text-to-video only. Configure an image-to-video model.`);
  if (generationMode === 'text_to_video' && isI2VModel(model)) throw new Error(`The selected model ${model} requires a reference image.`);
}

function resolveVideoRequest(args: Record<string, any>, context?: ToolContext) {
  requireNotStrict('Cloud video generation');
  const signal = context?.executionSignal;
  throwIfAborted(signal);
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');
  const sourceVideoRequired = context?.acceptedActionContract?.contract.mediaGeneration?.sourceVideoRequired
    ?? (mediaGenerationIntent(context?.actionIntent || '')?.operation === 'mutate');
  if (sourceVideoRequired || args.reference_video) throw new Error(CN_MEDIA_PROGRESS.videoEditUnavailable);

  const hasFirstFrame = Boolean(String(args.first_frame_image || '').trim());
  const hasLastFrame = Boolean(String(args.last_frame_image || '').trim());
  if (hasLastFrame && !hasFirstFrame) throw new Error('last_frame_image requires first_frame_image.');
  const generationMode = hasFirstFrame ? 'image_to_video' : 'text_to_video';
  const preferences = getUserPreferredGenerationModels(context?.userId || 'anonymous');
  const preference = generationMode === 'image_to_video' ? preferences.imageToVideo : preferences.video;
  if (args.officialOnly === true && preference.provider !== 'relay') throw new Error('This project requires Lumi Official API. Select it for video generation in model settings.');
  const provider = preference.provider;
  const explicitModel = typeof args.model === 'string' ? args.model.trim() : '';
  if (args.model !== undefined && (!explicitModel || explicitModel.length > 200)) throw new Error('model must be a nonempty model id of at most 200 characters.');
  let model = String(
    explicitModel || preference.model
    || preference.models[provider]
    || (generationMode === 'image_to_video'
      ? DEFAULT_IMAGE_TO_VIDEO_MODELS[provider]
      : DEFAULT_VIDEO_GENERATION_MODELS[provider])
    || '',
  ).trim();
  if (!model) throw new Error(`No video generation model is configured for ${provider}.`);
  if (generationMode === 'image_to_video' && provider !== 'relay' && provider !== 'minimax') {
    throw new Error(`${provider} does not have a verified image-to-video input adapter in this build.`);
  }

  assertVideoRoleModel(model, generationMode);
  if (provider === 'relay' && !explicitModel) {
    const effectiveModel = officialApiModel(generationMode === 'image_to_video' ? 'RELAY_IMAGE_TO_VIDEO_MODEL' : 'RELAY_VIDEO_MODEL', model);
    if (effectiveModel !== model) assertVideoRoleModel(effectiveModel, generationMode);
    model = effectiveModel;
  }
  const options = videoGenerationOptions({ provider, model });
  const duration = args.duration === undefined ? options?.fixedDuration || (options ? 5 : 6) : Number(args.duration);
  const segmentPrompts: string[] | undefined = args.segment_prompts;
  if (segmentPrompts !== undefined && (!Array.isArray(segmentPrompts) || segmentPrompts.length < 2 || segmentPrompts.length > 24
    || segmentPrompts.some(text => typeof text !== 'string' || !text.trim() || text.length > 4000))) throw new Error('segment_prompts must contain 2 to 24 nonempty strings of at most 4000 characters each.');
  const clipDuration = segmentPrompts ? duration / segmentPrompts.length : options?.fixedDuration;
  if (segmentPrompts && (provider !== 'relay' || !options || options.fixedDuration)) throw new Error('Explicit segment prompts require an official native variable-duration video model.');
  if (segmentPrompts && (!Number.isInteger(duration) || duration < 1 || duration > 120 || !Number.isInteger(clipDuration)
    || !options!.durations.includes(clipDuration!))) throw new Error('Segment duration must be an admitted native integer duration, with equal segments totaling at most 120 seconds.');
  if (options?.fixedDuration && (!Number.isInteger(duration) || duration < 1 || duration > 120)) throw new Error(CN_MEDIA_PROGRESS.videoSequenceDurationInvalid);
  if (options && args.size && !options.sizes.includes(normalizeSize(args.size, 'x'))) throw new Error('The configured video model requires a supported size: ' + options.sizes.join(', '));
  if (options && !options.fixedDuration && !segmentPrompts && !options.durations.includes(duration)) throw new Error('The configured video model supports integer durations from ' + options.durations[0] + ' to ' + options.durations.at(-1) + ' seconds. No generation was submitted.');
  const compose = Boolean(segmentPrompts || options?.fixedDuration && duration !== options.fixedDuration);
  let continuationModel = model;
  if (compose && !segmentPrompts && duration > options!.fixedDuration! && generationMode === 'text_to_video') {
    const continuation = preferences.imageToVideo;
    continuationModel = officialApiModel('RELAY_IMAGE_TO_VIDEO_MODEL', continuation.model || continuation.models.relay || DEFAULT_IMAGE_TO_VIDEO_MODELS.relay);
    if (continuation.provider !== 'relay' || videoGenerationOptions({ provider: 'relay', model: continuationModel })?.fixedDuration !== options!.fixedDuration || !isI2VModel(continuationModel)) throw new Error(CN_MEDIA_PROGRESS.videoSequenceModelInvalid);
  }

  return { signal, prompt, provider, model, generationMode, options, duration, compose, clipDuration, segmentPrompts, continuationModel, explicitModel };
}

async function preflightVideoGeneration(args: Record<string, any>, context?: ToolContext): Promise<void> {
  const selection = resolveVideoRequest(args, context);
  if (selection.provider !== 'relay') return;
  const role = selection.generationMode === 'image_to_video' ? 'image_to_video' : 'video_generation';
  let catalog: Awaited<ReturnType<typeof listOfficialApiModels>>;
  try {
    catalog = await listOfficialApiModels({ signal: selection.signal });
  } catch {
    throwIfAborted(selection.signal);
    throw new Error(CN_MEDIA_PROGRESS.videoCatalogUnavailable);
  }
  for (const [selectedRole, model] of [[role, selection.model], ...(selection.compose ? [['image_to_video', selection.continuationModel]] : [])] as const) {
    try {
      assertOfficialGenerationModel(catalog, selectedRole as 'video_generation' | 'image_to_video', model);
    } catch {
      throw new Error(CN_MEDIA_PROGRESS.videoModelUnavailable(model, catalog.byRole[selectedRole as 'video_generation' | 'image_to_video'] || []));
    }
  }
}

async function generateVideo(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const { signal, prompt, provider, model, generationMode, options, duration, compose, clipDuration, segmentPrompts, continuationModel, explicitModel } = resolveVideoRequest(args, context);

  // Resolve role/model admission before reading or downloading a reference.
  // A misconfigured T2V/I2V route must fail without touching the source image.
  const referenceSize = options && !options.fixedDuration ? args.size || options.sizes[0] : undefined;
  const firstFrame = await normalizeVideoReference(args.first_frame_image, 'first_frame_image', signal, referenceSize);
  const lastFrame = await normalizeVideoReference(args.last_frame_image, 'last_frame_image', signal, referenceSize);
  throwIfAborted(signal);

  const normalizedArgs = {
    ...args,
    ...(options ? { size: args.size || options.sizes[0], duration } : {}),
    ...(firstFrame ? { first_frame_image: firstFrame } : {}),
    ...(lastFrame ? { last_frame_image: lastFrame } : {}),
    __selectionReason: explicitModel ? 'explicit_model' : generationMode === 'image_to_video'
        ? 'configured_image_to_video_role'
        : 'configured_text_to_video_role',
  };

  const onProgress = context?.onProgress;

  if (compose && options) {
    let segmentFailure: any;
    try {
    const size = args.size ? normalizeSize(args.size, 'x') : options.sizes[0];
    const sequence = await generateVideoSequence({ duration, size, clipDuration: clipDuration!, outputDirectory: ensureOutputDir(),
      owner: { userId: context?.userId, domain: context?.domain, orgId: context?.orgId, taskId: context?.taskId }, signal, onProgress,
      generateClip: async (index, count, previousEndFrame) => {
        throwIfAborted(signal);
        if (context?.isCancelled?.()) throw new DOMException('Video generation cancelled', 'AbortError');
        const frame = previousEndFrame ? await normalizeVideoReference(previousEndFrame, 'continuation_frame', signal) : firstFrame;
        const segmentPrompt = [prompt, ...(segmentPrompts ? [segmentPrompts[index]] : []), 'This is segment ' + (index + 1) + ' of ' + count + ' in a continuous ' + duration + '-second video.',
          'Generate only this ' + clipDuration + '-second segment. Preserve the subject, visual identity and lighting.',
          index === 0 ? 'Establish the scene and begin the requested motion.' : index === count - 1 ? 'Continue smoothly from the supplied frame and bring the motion to a natural ending.' : 'Continue smoothly from the supplied frame; advance the action without restarting it.'].join('\n');
        const clip = JSON.parse(await generateOfficialVideo({ ...normalizedArgs, prompt: segmentPrompt, size, duration: clipDuration, prompt_extend: segmentPrompts ? false : args.prompt_extend,
          __selectionReason: index === 0 ? normalizedArgs.__selectionReason : 'configured_image_to_video_role',
          first_frame_image: frame, last_frame_image: index === count - 1 ? lastFrame : undefined }, index === 0 ? model : continuationModel, signal,
          message => reportVideoProgress(onProgress, CN_MEDIA_PROGRESS.videoSequenceProvider(index + 1, count, message)), index === 0,
          { ...context, idempotencyKey: executionIdempotencyKey('generate_video', args, context) + ':segment:' + index }, { ...args, __videoSegment: index }));
        if (clip.verified !== true || !clip.outputPath) { segmentFailure = clip; throw new Error('Original video segment remains incomplete.'); }
        return { path: clip.outputPath, taskId: clip.taskId, model: clip.model };
      },
    });
    const result = JSON.parse(await completedResult({ provider: 'relay', model, prompt, taskId: 'composed_' + crypto.randomUUID(), outputPath: sequence.outputPath,
      ...completionMetadata({ ...normalizedArgs, size, duration }), signal, onProgress }));
    return JSON.stringify({ ...result, composition: { strategy: 'sequential_clips_with_end_frame_continuation', clipDuration, clipCount: sequence.clips.length,
      sourceTaskIds: sequence.clips.map(clip => clip.taskId), models: [...new Set(sequence.clips.map(clip => clip.model))] } });
    } catch (error) {
      if (segmentFailure) return JSON.stringify({ ...segmentFailure, compositionSegment: true, wholeTaskCompleted: false });
      throw error;
    }
  }

  if (provider === 'qwen') return generateQwenVideo(normalizedArgs, model, signal, onProgress);
  if (provider === 'minimax') return generateMiniMaxVideo(normalizedArgs, model, signal, onProgress);
  if (provider === 'siliconflow') return generateSiliconFlowVideo(normalizedArgs, model, signal, onProgress);
  if (provider === 'relay') return generateOfficialVideo(normalizedArgs, model, signal, onProgress, true, context, args);
  return generateOpenAIVideo(normalizedArgs, model, signal, onProgress);
}

export function registerVideoTools(registry: ToolRegistry): void {
  registry.register({
    name: 'get_video_generation_status',
    description: 'Recover only the original persisted official video recoveryId. Query once and retrieve its verified artifact; never POST a new generation. Ownership and current organization membership are required. A composition segment does not complete the whole video.',
    parameters: { type: 'object', properties: { recoveryId: { type: 'string', description: 'Exact recoveryId returned by the original video request.' } }, required: ['recoveryId'] },
    handler: async (args, context) => {
      requireNotStrict('Cloud video task query');
      const task = readVideoGenerationTask(String(args.recoveryId || ''), context);
      if (!task) throw new Error('Video generation recovery task was not found.');
      return queryOfficialVideoTask(task, context);
    },
    localIdempotencyReplay: 'durable_handler', permission: 'user', securityLevel: 'safe',
    capability: capabilityContract({ id: 'media.video.status', family: 'media-generation', lane: 'media', operation: 'observe', risk: 'low',
      sideEffects: [{ type: 'network_read', scope: 'original persisted official video task', reversible: true },
        { type: 'local_write', scope: 'verified recovered video artifact', reversible: true }],
      verification: { strategy: 'artifact', required: true, requiredFields: ['status', 'verified', 'verificationStatus'],
        requiredValues: { verified: true, verificationStatus: 'verified' }, successStatuses: ['generated'],
        failureStatuses: ['unknown', 'pending', 'failed', 'rejected', 'cancelled'], requiredArtifactCollections: ['artifacts'],
        successSignals: ['original task completed and its video container was validated and saved'],
        limitations: ['Recovery never submits generation; a segment does not prove the complete composition.'] },
      reconciliation: { reconcilesCapabilityIds: ['media.video.generate'], outcomeField: 'reconciliationStatus', committedValues: ['committed'], notCommittedValues: [] },
    }),
    evidence: capabilityEvidence({ id: 'media.video.status', operation: 'observe', subjectArgument: 'recoveryId',
      limitations: ['Container validation does not certify content, prompt fidelity, or subjective video quality.'] }),
  });
  registry.register({
    name: 'generate_video',
    description: 'Generate text-to-video or image-to-video output with the separately configured model for that mode. A local reference image is safely converted to a bounded data URL before a verified I2V adapter is called; unsupported providers fail instead of silently falling back to text-to-video. Existing-video editing is unavailable on the current gateway; do not substitute a new text-to-video or image-to-video generation for an edit request.',
    parameters: {
      type: 'object',
      properties: {
        officialOnly: { type: 'boolean', description: 'Require the selected provider to be Lumi Official API; reject other providers.' },
        prompt: { type: 'string', description: 'Describe the scene, motion, lighting, camera angle, and style. With segment_prompts, put only shared creative context here and each ordered part in its own segment prompt.' },
        model: { type: 'string', description: 'Optional model id for this request only. It must belong to the configured provider and the current official catalog role; does not change saved model preferences.' },
        size: { type: 'string', description: 'Requested output size, such as 1920x1080 or 1080x1920 (1080P), 1280x720 or 720x1280 (720P).' },
        duration: { type: 'number', minimum: 1, maximum: 120, description: 'Final output duration in seconds. Lumi Official Wan3.0 supports native integer durations from 2 to 30 seconds, or an explicit segment_prompts plan totaling up to 120 seconds with an admitted equal integer duration per segment. Wan2.2 supports up to 120 seconds and automatically generates continuous five-second clips and combines them to the requested length.' },
        segment_prompts: { type: 'array', minItems: 2, maxItems: 24, items: { type: 'string', minLength: 1, maxLength: 4000 }, description: 'Explicit ordered native segment prompts. Each receives only this segment plus shared prompt context. Duration divided by count must be an admitted native integer duration. Requires the same official model in both video and image-to-video roles; no expansion, automatic extra segments, or retry.' },
        resolution: { type: 'string', description: 'MiniMax resolution, such as 1080P or 768P.' },
        first_frame_image: { type: 'string', description: 'Optional first-frame image: absolute local path, HTTPS URL, or image data URL. Its presence selects the image-to-video role.' },
        last_frame_image: { type: 'string', description: 'Optional last-frame image in the same formats; requires first_frame_image and provider support.' },
        negative_prompt: { type: 'string', description: 'Optional SiliconFlow negative prompt.' },
        audio: { type: 'boolean', description: 'Request native audio on an admitted official Wan3 model. An actual saved audio track still requires verification; this never synthesizes TTS or certifies lyric fidelity.' },
        prompt_extend: { type: 'boolean', description: 'Prompt expansion. Defaults to false for Lumi Official Wan3.0 and true for Qwen.' },
        seed: { type: 'number', description: 'Random seed when supported by the selected provider.' },
      },
      required: ['prompt'],
    },
    preflight: preflightVideoGeneration,
    handler: (args, context) => generateVideo(args, context),
    reconcileExternalCommit: async (args, context, idempotencyKey) => {
      requireNotStrict('Cloud video task reconciliation');
      const task = readVideoGenerationTask(videoGenerationRecoveryId(args, { ...context, idempotencyKey }), context);
      if (!task || task.compositionSegment) return null;
      const result = await queryOfficialVideoTask(task, context);
      return JSON.parse(result).verified === true ? result : null;
    },
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
        strategy: 'artifact',
        required: true,
        requiredFields: ['ok', 'verified', 'verificationStatus', 'status', 'provider', 'model', 'taskId', 'generationMode', 'inputReferenceAccepted', 'selectionReason', 'artifactDurability', 'artifacts'],
        requiredValues: { ok: true, verified: true, verificationStatus: 'verified' },
        successStatuses: ['generated'],
        failureStatuses: ['failed', 'timed_out'],
        requiredArtifactCollections: ['artifacts'],
        successSignals: ['provider completed video generation and Lumi validated container structure, video tracks, bounded sample references, and atomically saved the artifact'],
        limitations: ['Container and sample validation does not decode frames or prove subjective video quality or prompt fidelity.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'media.video.generate',
      operation: 'create',
      limitations: ['The receipt proves container/video-sample structure and persistence, not codec decoding or subjective video quality.'],
    }),
  });
}
