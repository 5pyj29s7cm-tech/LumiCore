import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'module';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { loadKeys } from '../../config/keys';
import {
  DEFAULT_IMAGE_EDIT_MODELS,
  DEFAULT_IMAGE_GENERATION_MODELS,
  getUserPreferredGenerationModels,
} from '../../llm/generation_preferences';
import {
  isOfficialApiConfigured,
  listOfficialApiModels,
  officialApiModel,
  officialApiPath,
  officialApiRequest,
} from '../../llm/official_api';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { getGeneratedOutputDir } from '../../config/data_path';
import { downloadPublicMedia } from '../media_artifact';
import { cancelDashScopeTaskBestEffort } from '../dashscope_async_task';
import { CN_MEDIA_PROGRESS } from '../../regions/packs/cn/media_progress';

const OUTPUT_DIR = getGeneratedOutputDir();
const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_EDIT_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_DECODED_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_RESULTS = 4;
const require = createRequire(import.meta.url);

interface VerifiedImageBytes {
  extension: 'png' | 'jpg' | 'webp' | 'bmp' | 'tiff';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/bmp' | 'image/tiff';
}

type ImageProgress = ToolContext['onProgress'];

function reportImageProgress(onProgress: ImageProgress, message: string): void {
  try { onProgress?.(message); } catch { /* progress delivery must not invalidate provider work */ }
}

async function reportDashScopeRemoteImageCancellation(
  taskId: string,
  apiKey: string,
  onProgress?: ImageProgress,
): Promise<void> {
  const { outcome } = await cancelDashScopeTaskBestEffort(taskId, apiKey);
  if (outcome === 'remote_cancelled') {
    reportImageProgress(onProgress, CN_MEDIA_PROGRESS.qwenRemoteCancelled);
    return;
  }
  if (outcome === 'remote_cancel_rejected_state') {
    reportImageProgress(onProgress, CN_MEDIA_PROGRESS.qwenRemoteCancelUnavailable);
    return;
  }
  reportImageProgress(onProgress, CN_MEDIA_PROGRESS.qwenRemoteCancelFailed);
}

function ensureOutputDir(): string {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}

function removeGeneratedFiles(filePaths: string[]): void {
  for (const filePath of filePaths) {
    try { fs.rmSync(filePath, { force: true }); } catch { /* best-effort rollback */ }
  }
}

function providerCompletedError(error: unknown): Error & { imageProviderCompleted?: true } {
  const normalized = error instanceof Error ? error : new Error(String(error || 'Image provider result failed'));
  (normalized as Error & { imageProviderCompleted?: true }).imageProviderCompleted = true;
  return normalized as Error & { imageProviderCompleted?: true };
}

function throwIfProviderCompleted(error: unknown): void {
  if ((error as { imageProviderCompleted?: boolean } | null)?.imageProviderCompleted === true) throw error;
}

function writeVerifiedImageBytes(
  bytes: Buffer,
  prefix: string,
  index: number,
  extension: VerifiedImageBytes['extension'],
  signal?: AbortSignal,
): string {
  throwIfAborted(signal);
  const outputDir = ensureOutputDir();
  const outputPath = path.join(outputDir, `${prefix}_${randomUUID()}_${index + 1}.${extension}`);
  const temporaryPath = path.join(outputDir, `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    fs.writeFileSync(temporaryPath, bytes, { flag: 'wx' });
    throwIfAborted(signal);
    fs.renameSync(temporaryPath, outputPath);
    renamed = true;
    throwIfAborted(signal);
    return outputPath;
  } catch (error) {
    removeGeneratedFiles(renamed ? [temporaryPath, outputPath] : [temporaryPath]);
    throw error;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason || new DOMException('Image generation cancelled', 'AbortError');
}

function waitForPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal?.reason || new DOMException('Image generation cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
  });
}

function verifyUncompressedBmp(bytes: Buffer): VerifiedImageBytes {
  if (bytes.length < 26 || bytes.toString('ascii', 0, 2) !== 'BM') throw new Error('invalid BMP header');
  const declaredSize = bytes.readUInt32LE(2);
  const pixelOffset = bytes.readUInt32LE(10);
  const dibSize = bytes.readUInt32LE(14);
  let width: number;
  let height: number;
  let planes: number;
  let bitsPerPixel: number;
  let compression = 0;
  if (dibSize === 12) {
    if (bytes.length < 26) throw new Error('truncated BMP core header');
    width = bytes.readUInt16LE(18);
    height = bytes.readUInt16LE(20);
    planes = bytes.readUInt16LE(22);
    bitsPerPixel = bytes.readUInt16LE(24);
  } else {
    if (dibSize < 40 || bytes.length < 54) throw new Error('unsupported BMP DIB header');
    width = bytes.readInt32LE(18);
    height = Math.abs(bytes.readInt32LE(22));
    planes = bytes.readUInt16LE(26);
    bitsPerPixel = bytes.readUInt16LE(28);
    compression = bytes.readUInt32LE(30);
  }
  if (width <= 0 || height <= 0 || planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(bitsPerPixel)) {
    throw new Error('invalid BMP dimensions or pixel layout');
  }
  if (![0, 3].includes(compression)) throw new Error('compressed BMP is unsupported');
  if (width * height > MAX_DECODED_IMAGE_PIXELS) throw new Error('BMP pixel limit exceeded');
  const rowBytes = Math.ceil((width * bitsPerPixel) / 32) * 4;
  const requiredSize = pixelOffset + rowBytes * height;
  if (pixelOffset < 14 + dibSize || requiredSize > bytes.length || (declaredSize > 0 && declaredSize < requiredSize)) {
    throw new Error('truncated BMP pixel data');
  }
  return { extension: 'bmp', mimeType: 'image/bmp' };
}

async function verifyImageBytes(
  bytes: Buffer,
  label: string,
  signal?: AbortSignal,
): Promise<VerifiedImageBytes> {
  throwIfAborted(signal);
  if (bytes.length === 0) throw new Error(`${label} is empty.`);
  if (bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_GENERATED_IMAGE_BYTES} byte limit.`);
  }
  try {
    if (bytes.toString('ascii', 0, 2) === 'BM') {
      const verifiedBmp = verifyUncompressedBmp(bytes);
      throwIfAborted(signal);
      return verifiedBmp;
    }
    const sharp = require('sharp');
    const inputOptions = { failOn: 'error' as const, limitInputPixels: MAX_DECODED_IMAGE_PIXELS };
    const metadata = await sharp(bytes, inputOptions).metadata();
    const format = String(metadata?.format || '').toLowerCase();
    const verified = format === 'png' ? { extension: 'png', mimeType: 'image/png' }
      : format === 'jpeg' || format === 'jpg' ? { extension: 'jpg', mimeType: 'image/jpeg' }
        : format === 'webp' ? { extension: 'webp', mimeType: 'image/webp' }
          : format === 'tiff' || format === 'tif' ? { extension: 'tiff', mimeType: 'image/tiff' }
            : format === 'bmp' ? { extension: 'bmp', mimeType: 'image/bmp' }
              : null;
    if (!verified || !metadata?.width || !metadata?.height) {
      throw new Error('unsupported image format');
    }
    // metadata() only inspects the container. stats() forces libvips to decode
    // pixel data so a forged header or truncated provider payload cannot be
    // promoted to a verified artifact.
    await sharp(bytes, inputOptions).stats();
    throwIfAborted(signal);
    return verified as VerifiedImageBytes;
  } catch (error) {
    throwIfAborted(signal);
    throw new Error(`${label} is not a decodable PNG, JPEG, WebP, BMP, or TIFF image.`, { cause: error });
  }
}

async function persistRemoteImage(
  url: string,
  prefix: string,
  index: number,
  signal?: AbortSignal,
): Promise<string> {
  const downloaded = await downloadPublicMedia(url, {
    maxBytes: MAX_GENERATED_IMAGE_BYTES,
    timeoutMs: 90_000,
    signal,
  });
  const verifiedImage = await verifyImageBytes(downloaded.bytes, 'Remote image generation result', signal);
  return writeVerifiedImageBytes(downloaded.bytes, prefix, index, verifiedImage.extension, signal);
}

// OpenAI image generation

async function generateImageOpenAI(
  args: Record<string, any>,
  selectedModel: string,
  signal?: AbortSignal,
  onProgress?: ImageProgress,
): Promise<string> {
  const prompt = args.prompt || '';
  if (!prompt) throw new Error('prompt is required');

  const keys = loadKeys();
  const apiKey = process.env.OPENAI_API_KEY || keys.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured. Set it in Settings > LLM Providers.');

  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey });
  const model = selectedModel || 'gpt-image-1';
  const n = Math.min(args.n || 1, 4);
  const isDalle = /^dall-e-/i.test(model);
  const request: any = {
    model,
    prompt,
    n,
    size: args.size || '1024x1024',
    quality: args.quality || (isDalle ? 'standard' : 'auto'),
    ...(isDalle ? { style: args.style || 'vivid' } : {}),
  };
  throwIfAborted(signal);
  const responsePromise = openai.images.generate(request, { signal });
  reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageRequestSubmitted);
  reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageGenerating);
  const response = await responsePromise;
  throwIfAborted(signal);
  reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageSaving);

  const images: string[] = [];
  const artifacts: Array<{ type: string; path?: string; url?: string }> = [];
  const generatedPaths: string[] = [];
  try {
    for (const [index, image] of response.data.slice(0, MAX_IMAGE_RESULTS).entries()) {
      throwIfAborted(signal);
      if ((image as any).url) {
        const outputPath = await persistRemoteImage(String((image as any).url), 'generated_image', index, signal);
        generatedPaths.push(outputPath);
        images.push(outputPath);
        artifacts.push({ type: 'image', path: outputPath });
        continue;
      }
      if ((image as any).b64_json) {
        const bytes = Buffer.from((image as any).b64_json, 'base64');
        const verifiedImage = await verifyImageBytes(bytes, 'OpenAI image generation result', signal);
        const outputPath = writeVerifiedImageBytes(bytes, 'generated_image', index, verifiedImage.extension, signal);
        generatedPaths.push(outputPath);
        images.push(outputPath);
        artifacts.push({ type: 'image', path: outputPath });
      }
    }
    if (images.length === 0) throw new Error('OpenAI image generation returned no image data');
    throwIfAborted(signal);
    reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageComplete);

    return JSON.stringify({
      ok: true,
      status: 'generated',
      success: true,
      verified: true,
      verificationStatus: 'verified',
      prompt,
      images,
      artifacts,
      revised_prompt: response.data[0]?.revised_prompt || prompt,
      provider: 'openai',
      model,
      tip: 'Generated ' + images.length + ' image(s) with ' + model + '.',
    });
  } catch (error) {
    removeGeneratedFiles(generatedPaths);
    throw providerCompletedError(error);
  }
}

async function generateImageDalle(args: Record<string, any>, context?: ToolContext): Promise<string> {
  return generateImageOpenAI(args, String(args.model || 'dall-e-3'), context?.executionSignal, context?.onProgress);
}

async function generateImageDashScope(
  args: Record<string, any>,
  selectedModel: string,
  signal?: AbortSignal,
  onProgress?: ImageProgress,
): Promise<string> {
  const prompt = args.prompt || '';
  if (!prompt) throw new Error('prompt is required');

  const keys = loadKeys();
  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || keys.DASHSCOPE_API_KEY || keys.QWEN_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY not configured. Set it in Settings > LLM Providers.');

  const model = selectedModel || 'wan2.2-t2i-plus';
  const size = args.size?.replace('*', 'x') || '1024*1024';
  const n = Math.min(args.n || 1, 4);

  const response = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model,
      input: { prompt },
      parameters: { size, n },
    }),
    signal,
  });

  const data = await response.json() as any;
  if (data.code) throw new Error('DashScope image error (' + data.code + '): ' + data.message);

  const taskId = data.output?.task_id;
  if (!taskId) throw new Error('No task_id returned from DashScope');
  reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageTaskSubmitted);
  reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageGenerating);

  try {
    throwIfAborted(signal);
    for (let i = 0; i < 30; i++) {
      await waitForPoll(2000, signal);
      const pollRes = await fetch(
        `https://dashscope.aliyuncs.com/api/v1/tasks/${encodeURIComponent(String(taskId))}`,
        { headers: { 'Authorization': 'Bearer ' + apiKey }, signal },
      );
      const pollData = await pollRes.json() as any;
      throwIfAborted(signal);
      if (pollData.output?.task_status === 'SUCCEEDED') {
        const results = pollData.output.results || [];
        const urls = results.map((result: any) => result.url).filter(Boolean).slice(0, MAX_IMAGE_RESULTS);
        if (urls.length === 0) throw providerCompletedError(new Error('Image generation completed but no URLs returned'));
        throwIfAborted(signal);
        reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageSaving);
        const outputPaths: string[] = [];
        try {
          for (const [index, url] of urls.entries()) {
            outputPaths.push(await persistRemoteImage(String(url), 'dashscope_image', index, signal));
          }
        } catch (error) {
          removeGeneratedFiles(outputPaths);
          throw providerCompletedError(error);
        }
        throwIfAborted(signal);
        reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageComplete);
        return JSON.stringify({
          ok: true,
          status: 'generated',
          success: true,
          verified: true,
          verificationStatus: 'verified',
          prompt,
          images: outputPaths,
          artifacts: outputPaths.map(outputPath => ({ type: 'image', path: outputPath })),
          taskId,
          provider: 'qwen',
          model,
          tip: 'Generated and saved ' + outputPaths.length + ' image(s).',
        });
      }
      if (pollData.output?.task_status === 'FAILED') {
        throw new Error('Image generation failed: ' + (pollData.output.message || 'unknown error'));
      }
    }
  } catch (error: any) {
    if (signal?.aborted) {
      await reportDashScopeRemoteImageCancellation(String(taskId), apiKey, onProgress);
      throw signal.reason || error;
    }
    throw error;
  }
  throw new Error('Image generation timed out (60s). Task: ' + taskId);
}

async function generateImageSiliconFlow(
  args: Record<string, any>,
  selectedModel: string,
  signal?: AbortSignal,
  onProgress?: ImageProgress,
): Promise<string> {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');

  const keys = loadKeys();
  const apiKey = process.env.SILICONFLOW_API_KEY || keys.SILICONFLOW_API_KEY;
  if (!apiKey) throw new Error('SILICONFLOW_API_KEY not configured. Set it in Settings > Generative Models.');

  const model = selectedModel || 'Kwai-Kolors/Kolors';
  const responsePromise = fetch('https://api.siliconflow.cn/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      n: Math.min(args.n || 1, 4),
      size: args.size?.replace('*', 'x') || '1024x1024',
    }),
    signal,
  });
  reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageRequestSubmitted);
  reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageGenerating);
  const response = await responsePromise;

  const data = await response.json() as any;
  throwIfAborted(signal);
  if (!response.ok) {
    throw new Error(`SiliconFlow image error (${response.status}): ${data.message || data.error || 'unknown error'}`);
  }
  const urls = (data.data || []).map((image: any) => image.url).filter(Boolean).slice(0, MAX_IMAGE_RESULTS);
  if (urls.length === 0) throw providerCompletedError(new Error('SiliconFlow image generation returned no image URLs'));
  throwIfAborted(signal);
  reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageSaving);
  const outputPaths: string[] = [];
  try {
    for (const [index, url] of urls.entries()) {
      outputPaths.push(await persistRemoteImage(String(url), 'siliconflow_image', index, signal));
    }
  } catch (error) {
    removeGeneratedFiles(outputPaths);
    throw providerCompletedError(error);
  }
  throwIfAborted(signal);
  reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageComplete);

  return JSON.stringify({
    ok: true,
    status: 'generated',
    success: true,
    verified: true,
    verificationStatus: 'verified',
    prompt,
    images: outputPaths,
    artifacts: outputPaths.map(outputPath => ({ type: 'image', path: outputPath })),
    provider: 'siliconflow',
    model,
    remainingCredits: data.credits,
    tip: 'Generated and saved ' + outputPaths.length + ' image(s) with ' + model + '.',
  });
}

async function persistOfficialImage(
  value: unknown,
  index: number,
  signal?: AbortSignal,
  prefix = 'official_image',
): Promise<{ value: string; artifact: { type: string; path?: string; url?: string } } | null> {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const dataUrl = raw.match(/^data:([^;,]+);base64,(.+)$/i);
  const base64 = dataUrl ? dataUrl[2] : (/^[A-Za-z0-9+/=\r\n]+$/.test(raw) && raw.length > 80 ? raw : '');
  if (base64) {
    const normalized = base64.replace(/\s+/g, '');
    if (Math.ceil(normalized.length * 3 / 4) > MAX_GENERATED_IMAGE_BYTES) {
      throw new Error(`Generated image exceeds the ${MAX_GENERATED_IMAGE_BYTES} byte limit.`);
    }
    const bytes = Buffer.from(normalized, 'base64');
    const verifiedImage = await verifyImageBytes(bytes, 'Lumi Official API image result', signal);
    const outputPath = writeVerifiedImageBytes(bytes, prefix, index, verifiedImage.extension, signal);
    return { value: outputPath, artifact: { type: 'image', path: outputPath } };
  }
  if (/^https?:\/\//i.test(raw)) {
    const outputPath = await persistRemoteImage(raw, prefix, index, signal);
    return { value: outputPath, artifact: { type: 'image', path: outputPath } };
  }
  return null;
}

function officialImageCandidates(body: any): any[] {
  const candidates = Array.isArray(body?.data) ? body.data
    : Array.isArray(body?.images) ? body.images
      : Array.isArray(body?.output?.images) ? body.output.images
        : (body?.output && typeof body.output === 'object' ? [body.output]
          : (body?.url || body?.image_url || body?.b64_json || body?.base64 ? [body] : []));
  return candidates.slice(0, MAX_IMAGE_RESULTS);
}

function officialImageCandidateValue(item: any): unknown {
  const imageUrl = typeof item?.image_url === 'object' ? item.image_url?.url : item?.image_url;
  return item?.url || imageUrl || item?.b64_json || item?.base64 || item;
}

async function persistOfficialEditedImage(value: unknown, index: number, signal?: AbortSignal): Promise<string> {
  const resolved = await persistOfficialImage(value, index, signal, 'official_image_edit');
  if (!resolved) throw new Error('Lumi Official API image edit returned an unreadable image result.');
  if (resolved.artifact.path) return resolved.artifact.path;
  throw new Error('Lumi Official API image edit returned no verifiable image artifact.');
}

/** OpenAI-compatible image generation through the Lumi official gateway. */
async function generateImageOfficial(
  args: Record<string, any>,
  selectedModel: string,
  signal?: AbortSignal,
  onProgress?: ImageProgress,
): Promise<string> {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');
  const model = officialApiModel('RELAY_IMAGE_MODEL', selectedModel || DEFAULT_IMAGE_GENERATION_MODELS.relay);
  const payload: Record<string, unknown> = {
    model,
    prompt,
    n: Math.min(Math.max(Number(args.n) || 1, 1), 4),
    size: String(args.size || '1024x1024').replace('*', 'x'),
  };
  if (args.quality) payload.quality = String(args.quality);
  if (args.style) payload.style = String(args.style);
  const requestPromise = officialApiRequest<any>(officialApiPath('RELAY_IMAGE_PATH', '/images/generations'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageRequestSubmitted);
  reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageGenerating);
  const { body } = await requestPromise;
  throwIfAborted(signal);
  reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageSaving);
  const candidates = officialImageCandidates(body);
  const images: string[] = [];
  const artifacts: Array<{ type: string; path?: string; url?: string }> = [];
  const generatedPaths: string[] = [];
  try {
    for (const [index, item] of candidates.entries()) {
      const resolved = await persistOfficialImage(officialImageCandidateValue(item), index, signal);
      if (resolved) {
        images.push(resolved.value);
        artifacts.push(resolved.artifact);
        if (resolved.artifact.path) generatedPaths.push(resolved.artifact.path);
      }
    }
    if (images.length === 0) throw new Error('Lumi Official API image generation returned no image data.');
    throwIfAborted(signal);
    reportImageProgress(onProgress, CN_MEDIA_PROGRESS.imageComplete);
    return JSON.stringify({
      ok: true,
      status: 'generated',
      success: true,
      verified: true,
      verificationStatus: 'verified',
      prompt,
      images,
      artifacts,
      revised_prompt: body?.data?.[0]?.revised_prompt || prompt,
      provider: 'relay',
      model,
      tip: `Generated ${images.length} image(s) with Lumi Official API.`,
    });
  } catch (error) {
    removeGeneratedFiles(generatedPaths);
    throw providerCompletedError(error);
  }
}

async function generateImage(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const signal = context?.executionSignal;
  const onProgress = context?.onProgress;
  const prefs = getUserPreferredGenerationModels(context?.userId || 'anonymous').image;
  if (prefs.provider === 'openai') {
    return generateImageOpenAI(args, prefs.model || prefs.models.openai, signal, onProgress);
  }
  if (prefs.provider === 'qwen') {
    return generateImageDashScope(args, prefs.model || prefs.models.qwen, signal, onProgress);
  }
  if (prefs.provider === 'siliconflow') {
    return generateImageSiliconFlow(args, prefs.model || prefs.models.siliconflow, signal, onProgress);
  }
  if (prefs.provider === 'relay') {
    return generateImageOfficial(args, prefs.model || prefs.models.relay, signal, onProgress);
  }

  const keys = loadKeys();
  const failures: string[] = [];
  if (process.env.OPENAI_API_KEY || keys.OPENAI_API_KEY) {
    try {
      return await generateImageOpenAI(args, prefs.models.openai, signal, onProgress);
    } catch (error: any) {
      throwIfProviderCompleted(error);
      throwIfAborted(signal);
      failures.push('openai: ' + (error?.message || error));
    }
  }
  if (process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || keys.DASHSCOPE_API_KEY || keys.QWEN_API_KEY) {
    try {
      return await generateImageDashScope(args, prefs.models.qwen, signal, onProgress);
    } catch (error: any) {
      throwIfProviderCompleted(error);
      throwIfAborted(signal);
      failures.push('qwen: ' + (error?.message || error));
    }
  }
  if (process.env.SILICONFLOW_API_KEY || keys.SILICONFLOW_API_KEY) {
    try {
      return await generateImageSiliconFlow(args, prefs.models.siliconflow, signal, onProgress);
    } catch (error: any) {
      throwIfProviderCompleted(error);
      throwIfAborted(signal);
      failures.push('siliconflow: ' + (error?.message || error));
    }
  }
  if (isOfficialApiConfigured()) {
    try { return await generateImageOfficial(args, prefs.models.relay, signal, onProgress); }
    catch (error: any) {
      throwIfProviderCompleted(error);
      throwIfAborted(signal);
      failures.push('relay: ' + (error?.message || error));
    }
  }
  const detail = failures.length > 0 ? ' Attempts: ' + failures.join('; ') : '';
  throw new Error('No working image generation provider is available. Configure Lumi Official API, OpenAI, DashScope, or SiliconFlow in Settings, or select a configured provider in Settings > Generative Models.' + detail);
}

async function imageUploadPart(
  filePath: string,
  label: string,
  signal?: AbortSignal,
  maxBytes = MAX_GENERATED_IMAGE_BYTES,
): Promise<{ dataUrl: string; byteLength: number }> {
  if (/^https:/i.test(filePath)) {
    const downloaded = await downloadPublicMedia(filePath, {
      maxBytes,
      timeoutMs: 90_000,
      signal,
    });
    const verifiedImage = await verifyImageBytes(downloaded.bytes, `${label} remote resource`, signal);
    return {
      dataUrl: `data:${verifiedImage.mimeType};base64,${downloaded.bytes.toString('base64')}`,
      byteLength: downloaded.bytes.length,
    };
  }
  if (/^https?:/i.test(filePath)) throw new Error(`${label} remote URL must use HTTPS.`);
  if (!path.isAbsolute(filePath) || !fs.existsSync(filePath)) {
    throw new Error(`${label} must be an existing absolute image path or an HTTPS image URL.`);
  }
  const fileStats = fs.statSync(filePath);
  if (!fileStats.isFile()) throw new Error(`${label} must be an existing image file.`);
  const extension = path.extname(filePath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'].includes(extension)) {
    throw new Error(`${label} must be a PNG, JPEG, WebP, BMP, or TIFF image.`);
  }
  if (fileStats.size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes} byte limit.`);
  }
  const buffer = fs.readFileSync(filePath);
  if (buffer.length > maxBytes) throw new Error(`${label} exceeds the ${maxBytes} byte limit.`);
  const verifiedImage = await verifyImageBytes(buffer, label, signal);
  return { dataUrl: `data:${verifiedImage.mimeType};base64,${buffer.toString('base64')}`, byteLength: buffer.length };
}

function imageInputReceiptValue(value: string): string {
  if (!/^https:/i.test(value)) return value;
  const parsed = new URL(value);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

async function aiEditImageOfficial(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const signal = context?.executionSignal;
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');
  if (!isOfficialApiConfigured()) {
    throw new Error('Lumi Official API is not configured. Configure it in Settings > AI Providers > Official.');
  }
  const preference = getUserPreferredGenerationModels(context?.userId || 'anonymous').imageEdit;
  if (preference.provider !== 'relay') throw new Error(`Unsupported AI image edit provider: ${preference.provider}`);
  const model = officialApiModel(
    'RELAY_IMAGE_EDIT_MODEL',
    String(preference.model || preference.models.relay || DEFAULT_IMAGE_EDIT_MODELS.relay),
  );
  const referencePaths = Array.isArray(args.referencePaths)
    ? args.referencePaths.map((value: unknown) => String(value || '').trim()).filter(Boolean)
    : [];
  if (referencePaths.length > 1) {
    throw new Error('Qwen image edit accepts at most one reference image in addition to filePath.');
  }
  const inputPaths = [String(args.filePath || '').trim(), ...referencePaths].filter(Boolean);
  if (inputPaths.length === 0) throw new Error('filePath is required');
  const catalog = await listOfficialApiModels({ signal });
  if (!(catalog.byRole.image_edit || []).includes(model)) {
    throw new Error(`Lumi Official API catalog does not currently expose ${model} as an image editing model.`);
  }

  const parts: Array<{ dataUrl: string; byteLength: number }> = [];
  let remainingInputBytes = MAX_IMAGE_EDIT_INPUT_BYTES;
  for (const [index, inputPath] of inputPaths.entries()) {
    const part = await imageUploadPart(
      inputPath,
      index === 0 ? 'filePath' : `referencePaths[${index - 1}]`,
      signal,
      remainingInputBytes,
    );
    parts.push(part);
    remainingInputBytes -= part.byteLength;
  }
  const payload: Record<string, unknown> = {
    model,
    prompt,
    image: parts.map(part => part.dataUrl).join(','),
    ...(args.size ? { size: String(args.size).replace('*', 'x') } : {}),
    ...(Number.isFinite(Number(args.seed)) ? { seed: Math.max(0, Math.min(2_147_483_648, Math.trunc(Number(args.seed)))) } : {}),
    watermark: args.watermark === true,
  };
  const requestBody = JSON.stringify(payload);
  if (Buffer.byteLength(requestBody, 'utf8') > 30 * 1024 * 1024) {
    throw new Error('Qwen image edit request body must not exceed 30 MB.');
  }

  const requestPromise = officialApiRequest<any>(
    officialApiPath(['RELAY_IMAGE_EDIT_PATH', 'RELAY_IMAGE_PATH'], '/images/generations'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
      timeoutMs: 120_000,
      signal,
    },
  );
  reportImageProgress(context?.onProgress, CN_MEDIA_PROGRESS.imageEditSubmitted);
  reportImageProgress(context?.onProgress, CN_MEDIA_PROGRESS.imageEditing);
  const { body } = await requestPromise;
  throwIfAborted(signal);
  reportImageProgress(context?.onProgress, CN_MEDIA_PROGRESS.imageEditSaving);
  const candidates = officialImageCandidates(body);
  if (candidates.length === 0) throw new Error('Lumi Official API image edit returned no image data.');
  const outputPaths: string[] = [];
  try {
    for (const [index, item] of candidates.entries()) {
      outputPaths.push(await persistOfficialEditedImage(officialImageCandidateValue(item), index, signal));
    }
    throwIfAborted(signal);
    reportImageProgress(context?.onProgress, CN_MEDIA_PROGRESS.imageEditComplete);
    return JSON.stringify({
      ok: true,
      status: 'edited',
      success: true,
      verified: true,
      verificationStatus: 'verified',
      provider: 'relay',
      model,
      prompt,
      inputPaths: inputPaths.map(imageInputReceiptValue),
      outputPath: outputPaths[0],
      outputPaths,
      artifacts: outputPaths.map(outputPath => ({ type: 'image', path: outputPath })),
      verification: 'live_provider_result_saved_locally',
    });
  } catch (error) {
    removeGeneratedFiles(outputPaths);
    throw error;
  }
}

async function editImage(args: Record<string, any>): Promise<string> {
  const { filePath, action, params } = args;
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`Image not found: ${filePath}`);
  if (!action) throw new Error('action is required (crop, resize, rotate, flip, blur, sharpen, grayscale, composite, convert)');

  const sharp = require('sharp');
  let image = sharp(filePath);

  switch (action) {
    case 'crop':
      image = image.extract({
        left: params?.left || 0,
        top: params?.top || 0,
        width: params?.width,
        height: params?.height,
      });
      break;
    case 'resize':
      image = image.resize({
        width: params?.width,
        height: params?.height,
        fit: params?.fit || 'cover',
      });
      break;
    case 'rotate':
      image = image.rotate(params?.angle || 90);
      break;
    case 'flip':
      image = image.flip();
      break;
    case 'flop':
      image = image.flop();
      break;
    case 'blur':
      image = image.blur(params?.sigma || 5);
      break;
    case 'sharpen':
      image = image.sharpen();
      break;
    case 'grayscale':
      image = image.grayscale();
      break;
    case 'negate':
      image = image.negate();
      break;
    case 'composite':
      if (!params?.overlayPath || !fs.existsSync(params.overlayPath))
        throw new Error('overlayPath is required for composite action');
      image = image.composite([{
        input: params.overlayPath,
        top: params.top || 0,
        left: params.left || 0,
      }]);
      break;
    case 'convert':
      break;
    default:
      throw new Error(`Unknown action: ${action}. Supported: crop, resize, rotate, flip, flop, blur, sharpen, grayscale, negate, composite, convert`);
  }

  const ext = params?.format || path.extname(filePath).replace('.', '') || 'png';
  const outDir = ensureOutputDir();
  const baseName = path.basename(filePath, path.extname(filePath));
  const outPath = path.join(outDir, `${baseName}_${action}_${Date.now()}.${ext}`);

  await image.toFormat(ext).toFile(outPath);

  return JSON.stringify({
    ok: true,
    status: 'created',
    success: true,
    action,
    outputPath: outPath,
    originalPath: filePath,
    artifacts: [{ type: 'image', path: outPath }],
  });
}

// ── Registration ──

export function registerImageTools(registry: ToolRegistry): void {
  registry.register({
    name: 'generate_image',
    description: 'Generate AI images from text prompts using the image provider and model selected in Settings > Generative Models. Lumi Official API, OpenAI, DashScope, and SiliconFlow are supported; an explicitly selected provider never silently switches to another provider.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed image description. Be specific about subject, style, lighting, colors, composition.' },
        size: { type: 'string', description: 'DALL-E: "1024x1024", "1792x1024", "1024x1792". DashScope: "1024*1024", "720*1280", "1280*720"' },
        quality: { type: 'string', description: 'DALL-E only: "standard" or "hd"' },
        style: { type: 'string', description: 'DALL-E only: "vivid" (hyper-real) or "natural" (more realistic)' },
        n: { type: 'number', description: 'Number of images (1-4, default 1)' },
      },
      required: ['prompt'],
    },
    handler: (args, context) => generateImage(args, context),
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'media.image.generate',
      family: 'media-generation',
      lane: 'media',
      operation: 'create',
      risk: 'medium',
      sideEffects: [
        { type: 'external_state_change', scope: 'configured image generation provider task', reversible: false },
        { type: 'local_write', scope: 'decoded generated image artifacts in Lumi output directory', reversible: true },
      ],
      verification: {
        strategy: 'artifact',
        required: true,
        requiredFields: ['ok', 'status', 'provider', 'model', 'images', 'verified', 'verificationStatus'],
        requiredValues: { ok: true, verified: true, verificationStatus: 'verified' },
        successStatuses: ['generated'],
        failureStatuses: ['failed', 'timed_out'],
        requiredArtifactCollections: ['artifacts'],
        successSignals: ['provider completed image generation and Lumi decoded and saved every returned image artifact'],
        limitations: ['Artifact verification does not by itself prove subjective image quality or prompt fidelity.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'media.image.generate',
      operation: 'create',
      limitations: ['The receipt proves local decodability and persistence, not subjective image quality.'],
    }),
  });

  registry.register({
    name: 'generate_image_dalle',
    description: 'Generate images using DALL-E 3. Higher quality and better prompt following. Supports 1024x1024, 1792x1024, 1024x1792. Requires OPENAI_API_KEY.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed image description in English' },
        size: { type: 'string', description: '"1024x1024", "1792x1024", or "1024x1792"' },
        quality: { type: 'string', description: '"standard" or "hd"' },
        style: { type: 'string', description: '"vivid" (hyper-real, dramatic) or "natural" (more realistic)' },
        n: { type: 'number', description: 'Number of images (1-4, default 1)' },
      },
      required: ['prompt'],
    },
    handler: generateImageDalle,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'media.image.generate.openai',
      family: 'media-generation',
      lane: 'media',
      operation: 'create',
      risk: 'medium',
      sideEffects: [
        { type: 'external_state_change', scope: 'OpenAI image generation request', reversible: false },
        { type: 'local_write', scope: 'decoded generated image artifacts in Lumi output directory', reversible: true },
      ],
      verification: {
        strategy: 'artifact',
        required: true,
        requiredFields: ['ok', 'status', 'provider', 'model', 'images', 'verified', 'verificationStatus'],
        requiredValues: { ok: true, provider: 'openai', verified: true, verificationStatus: 'verified' },
        successStatuses: ['generated'],
        failureStatuses: ['failed', 'timed_out'],
        requiredArtifactCollections: ['artifacts'],
        successSignals: ['OpenAI returned image data and Lumi decoded and saved every image artifact'],
        limitations: ['Artifact verification does not by itself prove subjective image quality or prompt fidelity.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'media.image.generate.openai',
      operation: 'create',
      limitations: ['The receipt proves local decodability and persistence, not subjective image quality.'],
    }),
  });

  registry.register({
    name: 'ai_edit_image',
    description: 'Generatively edit an existing local or HTTPS image with the separately configured Lumi Official API image-edit model. Use this for semantic changes such as replacing objects, changing backgrounds, preserving a product/person across compositions, or editing text; use edit_image for deterministic crop/resize/rotate operations.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute local path or public HTTPS URL of the primary PNG, JPEG, or WebP image.' },
        referencePaths: { type: 'array', items: { type: 'string' }, maxItems: 1, description: 'Optional second local or public HTTPS reference image. Qwen Image Edit accepts one or two images.' },
        prompt: { type: 'string', description: 'Describe the required visual edit and what must remain consistent.' },
        size: { type: 'string', description: 'Optional output size such as 1024x1024.' },
        seed: { type: 'number', description: 'Optional deterministic seed from 0 to 2147483648.' },
        watermark: { type: 'boolean', description: 'Whether the provider should add its watermark. Defaults to false.' },
      },
      required: ['filePath', 'prompt'],
    },
    handler: (args, context) => aiEditImageOfficial(args, context),
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'media.image.ai-edit',
      family: 'media-editing',
      lane: 'media',
      operation: 'create',
      risk: 'medium',
      sideEffects: [
        { type: 'external_state_change', scope: 'configured image editing provider request', reversible: false },
        { type: 'local_write', scope: 'verified edited image outputs in Lumi output directory', reversible: true },
      ],
      verification: {
        strategy: 'artifact',
        required: true,
        requiredFields: ['ok', 'status', 'provider', 'model', 'inputPaths', 'outputPath', 'artifacts', 'verification', 'verified', 'verificationStatus'],
        requiredValues: { ok: true, provider: 'relay', verified: true, verificationStatus: 'verified' },
        successStatuses: ['edited'],
        failureStatuses: ['failed', 'timed_out'],
        requiredArtifacts: ['outputPath'],
        successSignals: ['provider returned edited image data and Lumi saved a non-empty local image artifact'],
        limitations: ['Artifact verification does not by itself prove subjective edit quality or identity consistency.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'media.image.ai-edit',
      operation: 'create',
      subjectArgument: 'filePath',
      limitations: ['The receipt proves the provider result was saved locally, not that the edit is aesthetically acceptable.'],
    }),
  });

  registry.register({
    name: 'edit_image',
    description: 'Edit an image: crop, resize, rotate, flip/flop, blur, sharpen, grayscale, negate, composite (overlay watermark/logo), or convert format. Saves result to lumi_output directory.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the source image file' },
        action: { type: 'string', description: 'crop | resize | rotate | flip | flop | blur | sharpen | grayscale | negate | composite | convert' },
        params: {
          type: 'object',
          description: 'Action-specific params: { left, top, width, height, angle, sigma, overlayPath, format, fit }',
        },
      },
      required: ['filePath', 'action'],
    },
    handler: editImage,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'media.image.edit',
      family: 'media-editing',
      lane: 'media',
      operation: 'create',
      risk: 'medium',
      sideEffects: [{ type: 'local_write', scope: 'edited image output in Lumi output directory', reversible: true }],
      verification: {
        strategy: 'artifact',
        required: true,
        requiredFields: ['ok', 'status', 'action', 'outputPath'],
        requiredValues: { ok: true },
        successStatuses: ['created'],
        failureStatuses: ['failed'],
        requiredArtifacts: ['outputPath'],
        successSignals: ['edited image exists and is non-empty'],
        limitations: ['File existence does not by itself prove subjective visual quality.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'media.image.edit',
      operation: 'create',
      subjectArgument: 'filePath',
      limitations: ['The receipt verifies the output file, not subjective visual quality.'],
    }),
  });
}
