import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { loadKeys } from '../../config/keys';
import { getUserPreferredGenerationModels } from '../../llm/generation_preferences';

async function generateVideo(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const prompt = args.prompt || '';
  if (!prompt) throw new Error('prompt is required');

  const keys = loadKeys();
  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || keys.DASHSCOPE_API_KEY || keys.QWEN_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY not configured. Set it in Settings > LLM Providers.');

  const preference = getUserPreferredGenerationModels(context?.userId || 'anonymous').video;
  if (preference.provider !== 'qwen') {
    throw new Error(`Unsupported video generation provider: ${preference.provider}`);
  }
  const model = args.model || preference.model || preference.models.qwen;
  const size = args.size || '1280*720';
  const seed = args.seed || Math.floor(Math.random() * 2147483647);

  const response = await fetch(
    'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify({
        model,
        input: { prompt },
        parameters: {
          size,
          prompt_extend: args.prompt_extend !== false,
          watermark: false,
          seed,
        },
      }),
    },
  );

  const data = await response.json() as any;
  if (data.code) {
    throw new Error(`DashScope video error (${data.code}): ${data.message}`);
  }

  const taskId = data.output?.task_id;
  if (!taskId) throw new Error('No task_id returned for video generation');

  // Poll up to 5 minutes (video takes longer than images)
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(
      `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } },
    );
    const pollData = await pollRes.json() as any;
    if (pollData.output?.task_status === 'SUCCEEDED') {
      const videoUrl = pollData.output.video_url;
      if (!videoUrl) throw new Error('Video generation completed but no URL returned');

      return JSON.stringify({
        success: true,
        prompt,
        video_url: videoUrl,
        taskId,
        model,
        tip: 'Video generated. Tell the user the video is ready and offer to save it or play it. The download URL expires in 24 hours.',
      });
    }
    if (pollData.output?.task_status === 'FAILED') {
      throw new Error(`Video generation failed: ${pollData.output.message || 'unknown error'}`);
    }
    // Still running — continue polling
  }
  throw new Error('Video generation timed out (5 min). Task: ' + taskId);
}

export function registerVideoTools(registry: ToolRegistry): void {
  registry.register({
    name: 'generate_video',
    description: 'Generate AI videos from text descriptions using the provider and default model selected in Settings > Generative Models. The model argument may override that default only when the task explicitly requests a model.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Video description in English or Chinese. Describe the scene, motion, lighting, camera angle, and style. Be specific — up to 800 characters.' },
        model: { type: 'string', description: 'Optional explicit model override. Otherwise the configured video generation model is used.' },
        size: { type: 'string', description: 'Video resolution: 1280*720 (16:9, default), 720*1280 (9:16 vertical), 960*960 (1:1 square)' },
        prompt_extend: { type: 'boolean', description: 'Whether to intelligently expand the prompt for better quality (default true)' },
        seed: { type: 'number', description: 'Random seed for reproducibility' },
      },
      required: ['prompt'],
    },
    handler: (args, context) => generateVideo(args, context),
    permission: 'user',
    securityLevel: 'safe',
  });
}
