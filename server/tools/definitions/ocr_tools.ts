import { ToolRegistry } from '../registry';
import { analyzeScreen } from '../../llm/adapter';
import { getUserPreferredVision, type VisionProvider } from '../../llm/vision_preferences';
import fs from 'fs';
import os from 'os';
import path from 'path';

let sharpLoader: Promise<any> | null = null;

async function getSharp() {
  if (!sharpLoader) {
    sharpLoader = import('sharp').then(mod => mod.default || mod);
  }
  return sharpLoader;
}

function resolveVisionProvider(_args: Record<string, any>, context?: any): VisionProvider | null {
  const g = context?.llmGetters || {};
  const userId = context?.userId || 'anonymous';
  const provider = getUserPreferredVision(userId).provider;

  if (provider === 'openai' && g.getOpenAI?.()) return 'openai';
  if (provider === 'gemini' && g.getGemini?.()) return 'gemini';
  if (provider === 'ark' && g.getArk?.()) return 'ark';
  if (provider === 'qwen' && g.getQwen?.()) return 'qwen';
  if (provider === 'ollama' && g.getOllama?.()) return 'ollama';
  if (provider === 'lmstudio' && g.getLmStudio?.()) return 'lmstudio';
  if (provider === 'relay' && g.getRelay?.()) return 'relay';
  return null;
}

function visionModelFor(provider: VisionProvider): string {
  switch (provider) {
    case 'qwen': return 'qwen-vl-max';
    case 'ark': return 'doubao-1-5-vision-pro-32k';
    case 'ollama': return 'qwen2.5vl:7b';
    case 'lmstudio': return 'local-vision-model';
    case 'relay': return 'qwen2.5-vl-7b-instruct';
    case 'openai': return 'gpt-4o';
    case 'gemini':
    default:
      return 'gemini-2.0-flash';
  }
}

function resolveReadableImagePath(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('imagePath is required.');
  const expanded = raw.replace(/^~(?=$|[\\/])/, os.homedir());
  const resolved = path.resolve(expanded);
  const normalized = path.normalize(resolved);
  const allowedRoots = [
    os.homedir(),
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    os.tmpdir(),
  ].map(root => path.normalize(root).toLowerCase());
  const lower = normalized.toLowerCase();
  const allowed = allowedRoots.some(root => lower === root || lower.startsWith(root + path.sep.toLowerCase()));
  if (!allowed) {
    throw new Error(`Access denied: "${normalized}" is outside allowed image paths.`);
  }
  if (!fs.existsSync(normalized)) throw new Error(`Image not found: ${normalized}`);
  const stat = fs.statSync(normalized);
  if (!stat.isFile()) throw new Error(`Not a file: ${normalized}`);
  if (stat.size > 25 * 1024 * 1024) throw new Error(`Image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 25MB.`);
  if (!/\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(normalized)) {
    throw new Error('Unsupported image type. Use PNG, JPG, WEBP, BMP, GIF, or TIFF.');
  }
  return normalized;
}

async function ocrScreen(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('OCR tools require the Tauri desktop app');
  }
  const query = args.query || args.prompt || 'Describe what is visible on the screen in detail. Include all text, UI elements, error messages, and anything the user might need to know.';
  const base64 = await context.desktopRelay('desktop_capture_screen', { quality: 70 });

  // Resolve vision-capable provider
  const g = context?.llmGetters || {};
  const provider = resolveVisionProvider(args, context);
  if (!provider) {
    return JSON.stringify({ format: 'screenshot_base64', data: base64, note: 'No configured vision model is available. Choose a vision provider and add its API key in Settings → LLM Providers → Vision Model.' });
  }

  const model = getUserPreferredVision(context?.userId || 'anonymous').model || visionModelFor(provider);
  try {
    const description = await analyzeScreen(base64, query, { provider, model, userId: context?.userId || 'anonymous' }, g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay);
    return description;
  } catch (err: any) {
    return JSON.stringify({ format: 'screenshot_base64', data: base64, error: err.message });
  }
}

async function ocrRegion(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('OCR tools require the Tauri desktop app');
  }
  const { x, y, width, height } = args;
  const query = args.query || args.prompt || `Describe what is visible in the screen region at (${x}, ${y}, ${width}x${height}). Include all text and UI details.`;
  const base64 = await context.desktopRelay('desktop_capture_screen', { quality: 70 });

  const g = context?.llmGetters || {};
  const provider = resolveVisionProvider(args, context);
  if (!provider) {
    return JSON.stringify({ format: 'screenshot_base64', data: base64, note: 'No configured vision model is available. Choose a vision provider and add its API key in Settings → LLM Providers → Vision Model.' });
  }

  const model = getUserPreferredVision(context?.userId || 'anonymous').model || visionModelFor(provider);
  try {
    const description = await analyzeScreen(base64, query, { provider, model, userId: context?.userId || 'anonymous' }, g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay);
    return description;
  } catch (err: any) {
    return JSON.stringify({ format: 'screenshot_base64', data: base64, error: err.message });
  }
}

async function ocrImageFile(args: Record<string, any>, context?: any): Promise<string> {
  const imagePath = resolveReadableImagePath(args.imagePath || args.path || args.filePath);
  const query = args.query || args.prompt || 'Analyze this image in detail. If it is a drawing, extract dimensions, layout, labels, and any structure that can guide a CAD draft.';

  const g = context?.llmGetters || {};
  const provider = resolveVisionProvider(args, context);
  if (!provider) {
    return JSON.stringify({
      path: imagePath,
      note: 'No configured vision model is available. Choose a vision provider and add its API key in Settings -> LLM Providers -> Vision Model.',
    }, null, 2);
  }

  const sharp = await getSharp();
  const meta = await sharp(imagePath).metadata();
  const buffer = await sharp(imagePath)
    .rotate()
    .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  const base64 = buffer.toString('base64');
  const model = getUserPreferredVision(context?.userId || 'anonymous').model || visionModelFor(provider);
  try {
    const imagePayload = JSON.stringify({ image_base64: base64, format: 'jpeg', width: meta.width || null, height: meta.height || null });
    const description = await analyzeScreen(imagePayload, query, { provider, model, userId: context?.userId || 'anonymous' }, g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay);
    return JSON.stringify({
      path: imagePath,
      width: meta.width || null,
      height: meta.height || null,
      provider,
      model,
      analysis: description,
    }, null, 2);
  } catch (err: any) {
    return JSON.stringify({
      path: imagePath,
      width: meta.width || null,
      height: meta.height || null,
      provider,
      model,
      error: err.message,
    }, null, 2);
  }
}

function extractJsonObject(text: string): any | null {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function geometryExtent(cadArgs: Record<string, any>): { width: number; height: number } | null {
  const points: Array<{ x: number; y: number }> = [];
  const add = (x: unknown, y: unknown) => {
    const px = Number(x);
    const py = Number(y);
    if (Number.isFinite(px) && Number.isFinite(py)) points.push({ x: px, y: py });
  };
  for (const wall of Array.isArray(cadArgs.walls) ? cadArgs.walls : []) {
    add(wall?.x1 ?? wall?.from?.x, wall?.y1 ?? wall?.from?.y);
    add(wall?.x2 ?? wall?.to?.x, wall?.y2 ?? wall?.to?.y);
  }
  for (const room of Array.isArray(cadArgs.rooms) ? cadArgs.rooms : []) {
    if (Array.isArray(room?.points)) room.points.forEach((point: any) => add(point?.x, point?.y));
    const x = Number(room?.x);
    const y = Number(room?.y);
    const width = Number(room?.width ?? room?.w);
    const height = Number(room?.height ?? room?.h);
    if ([x, y, width, height].every(Number.isFinite)) {
      add(x, y);
      add(x + width, y + height);
    }
  }
  if (points.length < 2) return null;
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const minX = Math.min(0, ...xs);
  const minY = Math.min(0, ...ys);
  const width = Math.max(...xs) - minX;
  const height = Math.max(...ys) - minY;
  return width > 0 && height > 0 ? { width, height } : null;
}

export function normalizeFloorplanGeometry(parsed: any, args: Record<string, any>, imagePath: string): Record<string, any> {
  const geometry = parsed && typeof parsed === 'object' ? parsed : {};
  const cadArgs = geometry.cadArgs && typeof geometry.cadArgs === 'object'
    ? geometry.cadArgs
    : geometry;
  const extent = geometryExtent(cadArgs);
  const width = positiveNumber(cadArgs.width || geometry.width || geometry.outerWidth) || extent?.width || null;
  const height = positiveNumber(cadArgs.height || geometry.height || geometry.outerHeight) || extent?.height || null;
  const assumptions = Array.isArray(geometry.assumptions) ? geometry.assumptions.map(String).filter(Boolean) : [];
  const missingForPrecision = Array.isArray(geometry.missingForPrecision)
    ? geometry.missingForPrecision.map(String).filter(Boolean)
    : [];
  const inferredScale = geometry.inferredScale === true || (!positiveNumber(cadArgs.width || geometry.width || geometry.outerWidth) && Boolean(extent));
  const confidence = Number.isFinite(Number(geometry.confidence)) ? Number(geometry.confidence) : null;

  return {
    title: cadArgs.title || geometry.projectName || args.projectName || 'floorplan_draft',
    width,
    height,
    unit: cadArgs.unit || geometry.unit || args.unit || 'mm',
    wallThickness: cadArgs.wallThickness || geometry.wallThickness || null,
    rooms: Array.isArray(cadArgs.rooms) ? cadArgs.rooms : Array.isArray(geometry.rooms) ? geometry.rooms : [],
    walls: Array.isArray(cadArgs.walls) ? cadArgs.walls : Array.isArray(geometry.walls) ? geometry.walls : [],
    doors: Array.isArray(cadArgs.doors) ? cadArgs.doors : Array.isArray(geometry.doors) ? geometry.doors : [],
    windows: Array.isArray(cadArgs.windows) ? cadArgs.windows : Array.isArray(geometry.windows) ? geometry.windows : [],
    dimensions: Array.isArray(cadArgs.dimensions) ? cadArgs.dimensions : Array.isArray(geometry.dimensions) ? geometry.dimensions : [],
    furniture: Array.isArray(cadArgs.furniture) ? cadArgs.furniture : Array.isArray(geometry.furniture) ? geometry.furniture : [],
    columns: Array.isArray(cadArgs.columns) ? cadArgs.columns : Array.isArray(geometry.columns) ? geometry.columns : [],
    labels: Array.isArray(cadArgs.labels) ? cadArgs.labels : Array.isArray(geometry.labels) ? geometry.labels : [],
    sourcePath: imagePath,
    precisionNote: geometry.precisionNote || 'Generated from vision extraction. Verify scale and dimensions before production use.',
    inferredScale,
    confidence,
    assumptions,
    missingForPrecision,
    precisionStatus: inferredScale || missingForPrecision.length > 0 ? 'inferred_requires_review' : 'source_calibrated_requires_review',
  };
}

async function floorplanExtractGeometry(args: Record<string, any>, context?: any): Promise<string> {
  const imagePath = resolveReadableImagePath(args.imagePath || args.path || args.filePath);
  const g = context?.llmGetters || {};
  const provider = resolveVisionProvider(args, context);
  if (!provider) {
    return JSON.stringify({
      path: imagePath,
      note: 'No configured vision model is available. Choose a vision provider and add its API key in Settings -> LLM Providers -> Vision Model.',
    }, null, 2);
  }

  const sharp = await getSharp();
  const meta = await sharp(imagePath).metadata();
  const buffer = await sharp(imagePath)
    .rotate()
    .resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  const base64 = buffer.toString('base64');
  const model = getUserPreferredVision(context?.userId || 'anonymous').model || visionModelFor(provider);
  const projectName = String(args.projectName || args.title || '').trim();
  const knownScale = String(args.knownScale || args.scale || '').trim();
  const knownDimensions = String(args.knownDimensions || args.dimensions || '').trim();
  const prompt = [
    'You are extracting a residential/interior floor plan into CAD geometry.',
    'Return only valid JSON. No markdown, no commentary.',
    'Coordinate system: use millimeters when dimensions are visible. If exact scale is missing, create a proportional coordinate system and mark inferredScale=true.',
    'Do not invent precision. Exact values require visible dimensions or user-provided known dimensions.',
    projectName ? `Project name: ${projectName}` : '',
    knownScale ? `Known scale: ${knownScale}` : '',
    knownDimensions ? `Known dimensions: ${knownDimensions}` : '',
    '',
    'Required JSON shape:',
    '{',
    '  "projectName": "string",',
    '  "confidence": 0.0,',
    '  "inferredScale": true,',
    '  "unit": "mm",',
    '  "width": number_or_null,',
    '  "height": number_or_null,',
    '  "wallThickness": number_or_null,',
    '  "rooms": [{"name":"string","x":number,"y":number,"width":number,"height":number,"points":[{"x":number,"y":number}],"areaText":"string","inferred":boolean}],',
    '  "walls": [{"x1":number,"y1":number,"x2":number,"y2":number,"thickness":number,"layer":"WALL","inferred":boolean}],',
    '  "doors": [{"x":number,"y":number,"width":number,"angle":number,"swing":"left|right|in|out","label":"string","inferred":boolean}],',
    '  "windows": [{"x1":number,"y1":number,"x2":number,"y2":number,"width":number,"label":"string","inferred":boolean}],',
    '  "columns": [{"x":number,"y":number,"width":number,"height":number,"inferred":boolean}],',
    '  "dimensions": [{"x1":number,"y1":number,"x2":number,"y2":number,"text":"string","offset":number,"inferred":boolean}],',
    '  "labels": [{"text":"string","x":number,"y":number,"height":number}],',
    '  "assumptions": ["string"],',
    '  "missingForPrecision": ["string"],',
    '  "precisionNote": "string"',
    '}',
  ].filter(Boolean).join('\n');

  try {
    const imagePayload = JSON.stringify({ image_base64: base64, format: 'jpeg', width: meta.width || null, height: meta.height || null });
    const analysis = await analyzeScreen(imagePayload, prompt, { provider, model, userId: context?.userId || 'anonymous', maxTokens: 2200 }, g.getDeepSeek, g.getGemini, g.getOpenAI, g.getAnthropic, g.getQwen, g.getOllama, g.getLmStudio, g.getArk, g.getXiaomi, g.getKimi, g.getGlm, g.getRelay);
    const parsed = extractJsonObject(analysis);
    const cadArgs = parsed ? normalizeFloorplanGeometry(parsed, args, imagePath) : null;
    const geometryReady = Boolean(cadArgs && positiveNumber(cadArgs.width) && positiveNumber(cadArgs.height));
    return JSON.stringify({
      path: imagePath,
      image: { width: meta.width || null, height: meta.height || null },
      provider,
      model,
      parsed: Boolean(parsed),
      geometry: parsed,
      geometryReady,
      cadGenerateDxfArgs: geometryReady ? cadArgs : null,
      cadPrepareAutocadOperationsArgs: geometryReady ? cadArgs : null,
      rawAnalysis: parsed ? undefined : analysis,
      next: geometryReady
        ? 'For visible AutoCAD work, pass cadPrepareAutocadOperationsArgs into cad_prepare_autocad_operations, then pass its operationsPath and completionMarkerPath into mcp_cad-drafting_autocad_playback_file. Use cadGenerateDxfArgs only when an explicit DXF deliverable is requested. Never substitute DXF or scripts for failed MCP playback.'
        : parsed
        ? 'Geometry was parsed but has no usable outer dimensions or coordinate extent. Ask for one confirmed dimension or retry a clearer crop before generating CAD.'
        : 'Vision did not return valid JSON. Retry with a tighter crop or use ocr_image_file for manual extraction.',
    }, null, 2);
  } catch (err: any) {
    return JSON.stringify({
      path: imagePath,
      image: { width: meta.width || null, height: meta.height || null },
      provider,
      model,
      error: err.message,
    }, null, 2);
  }
}

export function registerOCRTools(registry: ToolRegistry): void {
  registry.register({
    name: 'ocr_screen',
    description:
      'Capture a screenshot of the user\'s screen and analyze it with a vision AI model. Returns a text description of what is visible — including text, UI elements, error messages, and code. Use this when the user asks "what\'s on my screen?", "read this error", "look at this", or when you need to see what the user is working on.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for or analyze in the screenshot. E.g., "Read all text visible on screen", "What error message is shown?", "Describe this UI".' },
      },
      required: [],
    },
    handler: ocrScreen,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'ocr_region',
    description:
      'Capture a specific region of the user\'s screen and analyze it with vision AI. Specify x, y, width, height in pixels plus what to look for. For reading dialog boxes, error messages, or specific UI elements.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Left edge in pixels' },
        y: { type: 'number', description: 'Top edge in pixels' },
        width: { type: 'number', description: 'Region width in pixels' },
        height: { type: 'number', description: 'Region height in pixels' },
        query: { type: 'string', description: 'What to analyze in this region.' },
      },
      required: ['x', 'y', 'width', 'height'],
    },
    handler: ocrRegion,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'ocr_image_file',
    description:
      'Analyze a local image file with the configured vision model. Use this for desktop screenshots, drafts, floor plans, CAD reference images, photos, and Chinese-named image files before generating derived documents or DXF files.',
    parameters: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: 'Absolute or home-relative local image path.' },
        path: { type: 'string', description: 'Alias for imagePath.' },
        query: { type: 'string', description: 'What to extract from the image.' },
      },
      required: [],
    },
    handler: ocrImageFile,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'floorplan_extract_geometry',
    description:
      'Extract structured CAD-ready geometry from a local floor plan, renovation sketch, layout photo, or requirement image. Use before cad_generate_dxf when the user asks Lumi to turn an image/folder of plans into CAD. Returns rooms, walls, doors, windows, dimensions, assumptions, missing precision inputs, and suggested cad_generate_dxf args. It does not guarantee production accuracy without confirmed scale/dimensions.',
    parameters: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: 'Absolute or home-relative local floor plan image path.' },
        path: { type: 'string', description: 'Alias for imagePath.' },
        projectName: { type: 'string', description: 'Optional project name for the CAD draft.' },
        knownScale: { type: 'string', description: 'Optional known drawing scale, e.g. 1:100, one grid = 1000mm, or user-provided calibration.' },
        knownDimensions: { type: 'string', description: 'Optional confirmed dimensions from the user or source text.' },
        unit: { type: 'string', description: 'Preferred unit, default mm.' },
      },
      required: [],
    },
    handler: floorplanExtractGeometry,
    permission: 'user',
    securityLevel: 'safe',
  });
}
