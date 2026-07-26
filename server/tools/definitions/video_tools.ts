import fs from 'fs';
import path from 'path';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { loadKeys } from '../../config/keys';
import {
  getUserPreferredGenerationModels,
  type VideoGenerationProvider,
} from '../../llm/generation_preferences';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

const OUTPUT_DIR = path.join(process.cwd(), 'lumi_output');
const POLL_DELAY_MS = process.env.NODE_ENV === 'test' ? 0 : 5_000;
const MAX_POLLS = 120;

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
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const outputPath = path.join(ensureOutputDir(), `${provider}_video_${Date.now()}.mp4`);
    fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
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
    video_url: input.videoUrl,
    outputPath: input.outputPath,
    artifacts,
    downloadError: input.downloadError,
    tip: input.outputPath
      ? 'Video generation completed and the MP4 was saved locally.'
      : 'Video generation completed. The remote URL may expire; save it locally before expiry.',
  });
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
      return completedResult({ provider: 'qwen', model, prompt, taskId, videoUrl, ...saved });
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
      return completedResult({ provider: 'minimax', model, prompt, taskId, videoUrl, ...saved });
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
      return completedResult({ provider: 'siliconflow', model, prompt, taskId, videoUrl, ...saved });
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
      return completedResult({ provider: 'openai', model, prompt, taskId, outputPath });
    }
    if (status.status === 'failed') {
      throw new Error(`OpenAI video generation failed: ${status.error?.message || 'unknown error'}`);
    }
  }
  throw new Error(`OpenAI video generation timed out. Video ID: ${taskId}`);
}

async function generateVideo(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');

  const preference = getUserPreferredGenerationModels(context?.userId || 'anonymous').video;
  const provider = preference.provider;
  const model = String(args.model || preference.model || preference.models[provider] || '').trim();
  if (!model) throw new Error(`No video generation model is configured for ${provider}.`);

  if (provider === 'qwen') return generateQwenVideo(args, model);
  if (provider === 'minimax') return generateMiniMaxVideo(args, model);
  if (provider === 'siliconflow') return generateSiliconFlowVideo(args, model);
  return generateOpenAIVideo(args, model);
}

export function registerVideoTools(registry: ToolRegistry): void {
  registry.register({
    name: 'generate_video',
    description: 'Generate an AI video with the provider and model selected in Settings > Generative Models. Supported runtime adapters are Qwen/DashScope, MiniMax, SiliconFlow, and OpenAI. An explicitly selected provider never silently switches to another provider.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Describe the scene, motion, lighting, camera angle, and style.' },
        model: { type: 'string', description: 'Optional explicit model override. Otherwise the configured video model is used.' },
        size: { type: 'string', description: 'Requested output size, such as 1280x720, 720x1280, or 960x960.' },
        duration: { type: 'number', description: 'Requested duration in seconds. The selected provider may normalize it to a supported duration.' },
        resolution: { type: 'string', description: 'MiniMax resolution, such as 1080P or 768P.' },
        first_frame_image: { type: 'string', description: 'Optional MiniMax first-frame image URL.' },
        last_frame_image: { type: 'string', description: 'Optional MiniMax last-frame image URL.' },
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
        requiredFields: ['ok', 'status', 'provider', 'model', 'taskId', 'artifacts'],
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
