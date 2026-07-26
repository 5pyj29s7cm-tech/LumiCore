import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { loadKeys } from '../../config/keys';
import { getUserPreferredGenerationModels } from '../../llm/generation_preferences';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

const OUTPUT_DIR = path.join(process.cwd(), 'lumi_output');
const require = createRequire(import.meta.url);

function ensureOutputDir(): string {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}

// OpenAI image generation

async function generateImageOpenAI(args: Record<string, any>, selectedModel: string): Promise<string> {
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
  const response = await openai.images.generate(request);

  const images: string[] = [];
  const artifacts: Array<{ type: string; path?: string; url?: string }> = [];
  for (const [index, image] of response.data.entries()) {
    if ((image as any).url) {
      images.push((image as any).url);
      artifacts.push({ type: 'image_url', url: (image as any).url });
      continue;
    }
    if ((image as any).b64_json) {
      const outputPath = path.join(ensureOutputDir(), 'generated_image_' + Date.now() + '_' + (index + 1) + '.png');
      fs.writeFileSync(outputPath, Buffer.from((image as any).b64_json, 'base64'));
      images.push(outputPath);
      artifacts.push({ type: 'image', path: outputPath });
    }
  }
  if (images.length === 0) throw new Error('OpenAI image generation returned no image data');

  return JSON.stringify({
    ok: true,
    status: 'generated',
    success: true,
    prompt,
    images,
    artifacts,
    revised_prompt: response.data[0]?.revised_prompt || prompt,
    provider: 'openai',
    model,
    tip: 'Generated ' + images.length + ' image(s) with ' + model + '.',
  });
}

async function generateImageDalle(args: Record<string, any>): Promise<string> {
  return generateImageOpenAI(args, String(args.model || 'dall-e-3'));
}

async function generateImageDashScope(args: Record<string, any>, selectedModel: string): Promise<string> {
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
  });

  const data = await response.json() as any;
  if (data.code) throw new Error('DashScope image error (' + data.code + '): ' + data.message);

  const taskId = data.output?.task_id;
  if (!taskId) throw new Error('No task_id returned from DashScope');

  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const pollRes = await fetch(
      'https://dashscope.aliyuncs.com/api/v1/tasks/' + taskId,
      { headers: { 'Authorization': 'Bearer ' + apiKey } },
    );
    const pollData = await pollRes.json() as any;
    if (pollData.output?.task_status === 'SUCCEEDED') {
      const results = pollData.output.results || [];
      const urls = results.map((result: any) => result.url).filter(Boolean);
      if (urls.length === 0) throw new Error('Image generation completed but no URLs returned');
      return JSON.stringify({
        ok: true,
        status: 'generated',
        success: true,
        prompt,
        images: urls,
        artifacts: urls.map((url: string) => ({ type: 'image_url', url })),
        taskId,
        provider: 'qwen',
        model,
        tip: 'Generated ' + urls.length + ' image(s).',
      });
    }
    if (pollData.output?.task_status === 'FAILED') {
      throw new Error('Image generation failed: ' + (pollData.output.message || 'unknown error'));
    }
  }
  throw new Error('Image generation timed out (60s). Task: ' + taskId);
}

async function generateImageSiliconFlow(args: Record<string, any>, selectedModel: string): Promise<string> {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');

  const keys = loadKeys();
  const apiKey = process.env.SILICONFLOW_API_KEY || keys.SILICONFLOW_API_KEY;
  if (!apiKey) throw new Error('SILICONFLOW_API_KEY not configured. Set it in Settings > Generative Models.');

  const model = selectedModel || 'Kwai-Kolors/Kolors';
  const response = await fetch('https://api.siliconflow.cn/v1/images/generations', {
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
  });

  const data = await response.json() as any;
  if (!response.ok) {
    throw new Error(`SiliconFlow image error (${response.status}): ${data.message || data.error || 'unknown error'}`);
  }
  const urls = (data.data || []).map((image: any) => image.url).filter(Boolean);
  if (urls.length === 0) throw new Error('SiliconFlow image generation returned no image URLs');

  return JSON.stringify({
    ok: true,
    status: 'generated',
    success: true,
    prompt,
    images: urls,
    artifacts: urls.map((url: string) => ({ type: 'image_url', url })),
    provider: 'siliconflow',
    model,
    remainingCredits: data.credits,
    tip: 'Generated ' + urls.length + ' image(s) with ' + model + '.',
  });
}

async function generateImage(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const prefs = getUserPreferredGenerationModels(context?.userId || 'anonymous').image;
  if (prefs.provider === 'openai') {
    return generateImageOpenAI(args, prefs.model || prefs.models.openai);
  }
  if (prefs.provider === 'qwen') {
    return generateImageDashScope(args, prefs.model || prefs.models.qwen);
  }
  if (prefs.provider === 'siliconflow') {
    return generateImageSiliconFlow(args, prefs.model || prefs.models.siliconflow);
  }

  const keys = loadKeys();
  const failures: string[] = [];
  if (process.env.OPENAI_API_KEY || keys.OPENAI_API_KEY) {
    try {
      return await generateImageOpenAI(args, prefs.models.openai);
    } catch (error: any) {
      failures.push('openai: ' + (error?.message || error));
    }
  }
  if (process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || keys.DASHSCOPE_API_KEY || keys.QWEN_API_KEY) {
    try {
      return await generateImageDashScope(args, prefs.models.qwen);
    } catch (error: any) {
      failures.push('qwen: ' + (error?.message || error));
    }
  }
  if (process.env.SILICONFLOW_API_KEY || keys.SILICONFLOW_API_KEY) {
    try {
      return await generateImageSiliconFlow(args, prefs.models.siliconflow);
    } catch (error: any) {
      failures.push('siliconflow: ' + (error?.message || error));
    }
  }
  const detail = failures.length > 0 ? ' Attempts: ' + failures.join('; ') : '';
  throw new Error('No working image generation provider is available. Configure OpenAI, DashScope, or SiliconFlow in Settings, or select a configured provider in Settings > Generative Models.' + detail);
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
    description: 'Generate AI images from text prompts using the image provider and model selected in Settings > Generative Models. Automatic mode may try configured OpenAI, DashScope, and SiliconFlow providers; an explicitly selected provider never silently switches to another provider.',
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
        { type: 'local_write', scope: 'generated image when the provider returns image bytes', reversible: true },
      ],
      verification: {
        strategy: 'provider_ack',
        required: true,
        requiredFields: ['ok', 'status', 'provider', 'model', 'images'],
        requiredValues: { ok: true },
        successStatuses: ['generated'],
        failureStatuses: ['failed', 'timed_out'],
        successSignals: ['provider completed the image generation task and returned at least one image reference'],
        limitations: ['Remote image URLs are provider acknowledgements, not proof of a durable local file.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'media.image.generate',
      operation: 'create',
      limitations: ['A remote image URL may expire and must not be reported as a saved local artifact.'],
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
        { type: 'local_write', scope: 'generated image when the provider returns image bytes', reversible: true },
      ],
      verification: {
        strategy: 'provider_ack',
        required: true,
        requiredFields: ['ok', 'status', 'provider', 'model', 'images'],
        requiredValues: { ok: true, provider: 'openai' },
        successStatuses: ['generated'],
        failureStatuses: ['failed', 'timed_out'],
        successSignals: ['OpenAI returned at least one generated image reference'],
        limitations: ['Provider completion does not prove a remote image URL was saved locally.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'media.image.generate.openai',
      operation: 'create',
      limitations: ['A remote image URL may expire and must not be reported as a saved local artifact.'],
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
