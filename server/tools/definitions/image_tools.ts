import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { ToolRegistry } from '../registry';
import { loadKeys } from '../../config/keys';

const OUTPUT_DIR = path.join(process.cwd(), 'lumi_output');
const require = createRequire(import.meta.url);

function ensureOutputDir(): string {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}

// ── DALL-E 3 ──

async function generateImageDalle(args: Record<string, any>): Promise<string> {
  const prompt = args.prompt || '';
  if (!prompt) throw new Error('prompt is required');

  const keys = loadKeys();
  const apiKey = keys.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured. Set it in Settings > API Matrix.');

  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey });

  const size = args.size || '1024x1024';
  const quality = args.quality || 'standard';
  const style = args.style || 'vivid';
  const n = Math.min(args.n || 1, 4);

  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt,
    n,
    size: size as '1024x1024' | '1792x1024' | '1024x1792',
    quality: quality as 'standard' | 'hd',
    style: style as 'vivid' | 'natural',
  });

  const urls = response.data.map((img: any) => img.url).filter(Boolean);
  if (urls.length === 0) throw new Error('DALL-E returned no image URLs');

  return JSON.stringify({
    success: true,
    prompt,
    images: urls,
    revised_prompt: response.data[0]?.revised_prompt || prompt,
    model: 'dall-e-3',
    tip: `Generated ${urls.length} image(s) with DALL-E 3.`,
  });
}

// ── Auto-router: try DALL-E first, fallback DashScope ──

async function generateImage(args: Record<string, any>): Promise<string> {
  const prompt = args.prompt || '';
  if (!prompt) throw new Error('prompt is required');

  const keys = loadKeys();

  // Try DALL-E first if key configured
  if (keys.OPENAI_API_KEY) {
    try {
      return await generateImageDalle(args);
    } catch (err: any) {
      console.warn('[generateImage] DALL-E failed, falling back to DashScope:', err.message);
    }
  }

  // Fallback to DashScope
  const apiKey = keys.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('No image generation provider available. Configure OPENAI_API_KEY or DASHSCOPE_API_KEY.');

  const size = args.size?.replace('*', 'x') || '1024*1024';
  const n = Math.min(args.n || 1, 4);

  const response = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: 'wan2.2-t2i-plus',
      input: { prompt },
      parameters: { size, n },
    }),
  });

  const data = await response.json() as any;
  if (data.code) throw new Error(`DashScope image error (${data.code}): ${data.message}`);

  const taskId = data.output?.task_id;
  if (!taskId) throw new Error('No task_id returned from DashScope');

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(
      `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } },
    );
    const pollData = await pollRes.json() as any;
    if (pollData.output?.task_status === 'SUCCEEDED') {
      const results = pollData.output.results || [];
      const urls = results.map((r: any) => r.url).filter(Boolean);
      if (urls.length === 0) throw new Error('Image generation completed but no URLs returned');
      return JSON.stringify({
        success: true, prompt, images: urls, taskId, model: 'wan2.2-t2i-plus',
        tip: `Generated ${urls.length} image(s).`,
      });
    }
    if (pollData.output?.task_status === 'FAILED') {
      throw new Error(`Image generation failed: ${pollData.output.message || 'unknown error'}`);
    }
  }
  throw new Error('Image generation timed out (60s). Task: ' + taskId);
}

// ── Image Editing (sharp) ──

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
    success: true,
    action,
    outputPath: outPath,
    originalPath: filePath,
  });
}

// ── Registration ──

export function registerImageTools(registry: ToolRegistry): void {
  registry.register({
    name: 'generate_image',
    description: 'Generate AI images from text prompts. Auto-selects the best available provider: DALL-E 3 (if OPENAI_API_KEY is configured) or DashScope Wan2.2. Supports styles like "oil painting", "anime", "photorealistic", "architectural rendering", etc.',
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
    handler: generateImage,
    permission: 'user',
    securityLevel: 'safe',
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
  });
}
