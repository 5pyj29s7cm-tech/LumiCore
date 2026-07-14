import { ToolRegistry } from '../registry';
import { analyzeScreen } from '../../llm/adapter';
import { getUserPreferredVision, type VisionProvider } from '../../llm/vision_preferences';
import { getDataPath } from '../../config/data_path';
import {
  arbitrateCadVisualVerification,
  buildCadGeometryVerificationSvg,
  type CadVisualVerification,
  validateCadGeometry,
  writeCadGeometryReceipt,
} from '../../cad/geometry_verification';
import { vectorizeFloorplanLinework } from '../../cad/floorplan_vectorizer';
import crypto from 'crypto';
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

type PixelBounds = { left: number; top: number; width: number; height: number };
type BinaryComponent = PixelBounds & { area: number; label: number };

function boxCountMask(
  input: Uint8Array,
  width: number,
  height: number,
  radius: number,
  minimumCount: number,
): Uint8Array {
  const stride = width + 1;
  const integral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += input[y * width + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const output = new Uint8Array(input.length);
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width, x + radius + 1);
      const count = integral[bottom * stride + right]
        - integral[top * stride + right]
        - integral[bottom * stride + left]
        + integral[top * stride + left];
      if (count >= minimumCount) output[y * width + x] = 1;
    }
  }
  return output;
}

function labelBinaryComponents(mask: Uint8Array, width: number, height: number): {
  labels: Int32Array;
  components: BinaryComponent[];
} {
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components: BinaryComponent[] = [];
  let nextLabel = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] !== 0) continue;
    nextLabel += 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = nextLabel;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    let area = 0;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      area += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) {
        const nextY = y + dy;
        if (nextY < 0 || nextY >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          if (nextX < 0 || nextX >= width) continue;
          const next = nextY * width + nextX;
          if (!mask[next] || labels[next] !== 0) continue;
          labels[next] = nextLabel;
          queue[tail++] = next;
        }
      }
    }
    components.push({
      label: nextLabel,
      left: minX,
      top: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      area,
    });
  }
  return { labels, components };
}

export function detectFloorplanCropBounds(gray: Uint8Array, width: number, height: number): PixelBounds | null {
  if (width < 80 || height < 80 || gray.length !== width * height) return null;
  const dark = Uint8Array.from(gray, value => value < 170 ? 1 : 0);
  const eroded = boxCountMask(dark, width, height, 2, 21);
  const dense = boxCountMask(eroded, width, height, 4, 1);
  const denseResult = labelBinaryComponents(dense, width, height);
  const largestArea = denseResult.components.reduce((maximum, component) => Math.max(maximum, component.area), 0);
  if (largestArea === 0) return null;
  const minimumStructuralArea = Math.max(width * height * 0.0006, largestArea * 0.24);
  const structuralLabels = new Set(denseResult.components
    .filter(component => component.area >= minimumStructuralArea && component.width >= 10 && component.height >= 10)
    .map(component => component.label));
  if (structuralLabels.size === 0) return null;

  const connectedInk = boxCountMask(dark, width, height, 1, 1);
  const inkResult = labelBinaryComponents(connectedInk, width, height);
  const connectedLabels = new Set<number>();
  for (let index = 0; index < denseResult.labels.length; index++) {
    if (!structuralLabels.has(denseResult.labels[index])) continue;
    const inkLabel = inkResult.labels[index];
    if (inkLabel > 0) connectedLabels.add(inkLabel);
  }
  const selected = inkResult.components.filter(component => connectedLabels.has(component.label));
  if (selected.length === 0) return null;
  const left = Math.max(0, Math.min(...selected.map(component => component.left)) - 2);
  const top = Math.max(0, Math.min(...selected.map(component => component.top)) - 2);
  const right = Math.min(width, Math.max(...selected.map(component => component.left + component.width)) + 2);
  const bottom = Math.min(height, Math.max(...selected.map(component => component.top + component.height)) + 2);
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  if (cropWidth < width * 0.2 || cropHeight < height * 0.2) return null;
  return { left, top, width: cropWidth, height: cropHeight };
}

async function prepareFloorplanSourceImage(imagePath: string): Promise<{
  buffer: Buffer;
  cropPath: string;
  bounds: PixelBounds;
  detected: boolean;
  originalWidth: number;
  originalHeight: number;
}> {
  const sharp = await getSharp();
  const raw = await sharp(imagePath).rotate().grayscale().raw().toBuffer({ resolveWithObject: true });
  const originalWidth = Number(raw.info.width);
  const originalHeight = Number(raw.info.height);
  const detectedBounds = detectFloorplanCropBounds(raw.data, originalWidth, originalHeight);
  const bounds = detectedBounds || { left: 0, top: 0, width: originalWidth, height: originalHeight };
  const buffer = await sharp(imagePath)
    .rotate()
    .extract(bounds)
    .resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  const cropPath = getDataPath(path.join('cad', 'source_crops', `crop_${Date.now()}.jpg`));
  fs.writeFileSync(cropPath, buffer);
  return { buffer, cropPath, bounds, detected: Boolean(detectedBounds), originalWidth, originalHeight };
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
    return JSON.stringify({ format: 'screenshot_base64', data: base64, note: 'No configured visual-perception model is available. Configure one in Settings > World Model > Visual Perception.' });
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
    return JSON.stringify({ format: 'screenshot_base64', data: base64, note: 'No configured visual-perception model is available. Configure one in Settings > World Model > Visual Perception.' });
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
      note: 'No configured visual-perception model is available. Configure one in Settings > World Model > Visual Perception.',
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
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();

  const parseCandidate = (candidate: string): any | null => {
    try {
      return JSON.parse(candidate);
    } catch {}
    const withoutTrailingCommas = candidate.replace(/,\s*([}\]])/g, '$1');
    if (withoutTrailingCommas !== candidate) {
      try {
        return JSON.parse(withoutTrailingCommas);
      } catch {}
    }
    return null;
  };

  const direct = parseCandidate(cleaned);
  if (direct) return direct;

  let searchFrom = 0;
  while (searchFrom < cleaned.length) {
    const start = cleaned.indexOf('{', searchFrom);
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
          const parsed = parseCandidate(cleaned.slice(start, i + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
    searchFrom = start + 1;
  }
  return null;
}

function jsonParseDiagnostics(text: string): Record<string, any> {
  const value = String(text || '').trim();
  const firstBrace = value.indexOf('{');
  const lastBrace = value.lastIndexOf('}');
  return {
    characters: value.length,
    hasObjectStart: firstBrace >= 0,
    hasObjectEnd: lastBrace >= 0,
    endsWithObject: /}\s*(?:```)?\s*$/.test(value),
    likelyTruncated: firstBrace >= 0 && (lastBrace < firstBrace || !/}\s*(?:```)?\s*$/.test(value)),
  };
}

function findStructuredPayload(
  value: any,
  requiredKeys: string[],
  validate: (candidate: Record<string, any>) => boolean,
): Record<string, any> | null {
  const queue: Array<{ value: any; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<any>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    const candidate = current.value;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    if (requiredKeys.every(key => Object.prototype.hasOwnProperty.call(candidate, key)) && validate(candidate)) {
      return candidate;
    }
    if (current.depth >= 3) continue;
    for (const nested of Object.values(candidate)) {
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        queue.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function topLevelKeys(value: any): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).slice(0, 40);
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
  const outerBoundary = Array.isArray(cadArgs.outerBoundary)
    ? cadArgs.outerBoundary
    : Array.isArray(cadArgs.outerBoundary?.points)
      ? cadArgs.outerBoundary.points
      : [];
  outerBoundary.forEach((point: any) => add(point?.x, point?.y));
  for (const polyline of Array.isArray(cadArgs.polylines) ? cadArgs.polylines : []) {
    const polylinePoints = Array.isArray(polyline?.points) ? polyline.points : [];
    polylinePoints.forEach((point: any) => add(point?.x, point?.y));
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
  const rawWalls = Array.isArray(cadArgs.walls) ? cadArgs.walls : Array.isArray(geometry.walls) ? geometry.walls : [];
  const wallKeys = new Set<string>();
  const walls = rawWalls.filter((wall: any) => {
    const values = [wall?.x1 ?? wall?.from?.x, wall?.y1 ?? wall?.from?.y, wall?.x2 ?? wall?.to?.x, wall?.y2 ?? wall?.to?.y]
      .map(Number);
    if (!values.every(Number.isFinite)) return true;
    const first = `${values[0].toFixed(3)},${values[1].toFixed(3)}`;
    const second = `${values[2].toFixed(3)},${values[3].toFixed(3)}`;
    const key = first < second ? `${first}|${second}` : `${second}|${first}`;
    if (wallKeys.has(key)) return false;
    wallKeys.add(key);
    return true;
  });

  return {
    title: cadArgs.title || geometry.projectName || args.projectName || 'floorplan_draft',
    width,
    height,
    unit: cadArgs.unit || geometry.unit || args.unit || 'mm',
    wallThickness: cadArgs.wallThickness || geometry.wallThickness || null,
    coordinateSystem: cadArgs.coordinateSystem || geometry.coordinateSystem || 'bottom_left_y_up',
    outerBoundary: Array.isArray(cadArgs.outerBoundary)
      ? cadArgs.outerBoundary
      : Array.isArray(geometry.outerBoundary)
        ? geometry.outerBoundary
        : [],
    sourceTopology: cadArgs.sourceTopology && typeof cadArgs.sourceTopology === 'object'
      ? cadArgs.sourceTopology
      : geometry.sourceTopology && typeof geometry.sourceTopology === 'object'
        ? geometry.sourceTopology
        : {},
    rooms: Array.isArray(cadArgs.rooms) ? cadArgs.rooms : Array.isArray(geometry.rooms) ? geometry.rooms : [],
    walls,
    doors: Array.isArray(cadArgs.doors) ? cadArgs.doors : Array.isArray(geometry.doors) ? geometry.doors : [],
    windows: Array.isArray(cadArgs.windows) ? cadArgs.windows : Array.isArray(geometry.windows) ? geometry.windows : [],
    dimensions: Array.isArray(cadArgs.dimensions) ? cadArgs.dimensions : Array.isArray(geometry.dimensions) ? geometry.dimensions : [],
    furniture: Array.isArray(cadArgs.furniture) ? cadArgs.furniture : Array.isArray(geometry.furniture) ? geometry.furniture : [],
    columns: Array.isArray(cadArgs.columns) ? cadArgs.columns : Array.isArray(geometry.columns) ? geometry.columns : [],
    labels: Array.isArray(cadArgs.labels) ? cadArgs.labels : Array.isArray(geometry.labels) ? geometry.labels : [],
    polylines: Array.isArray(cadArgs.polylines) ? cadArgs.polylines : Array.isArray(geometry.polylines) ? geometry.polylines : [],
    holes: Array.isArray(cadArgs.holes) ? cadArgs.holes : Array.isArray(geometry.holes) ? geometry.holes : [],
    sourcePath: imagePath,
    precisionNote: geometry.precisionNote || 'Generated from vision extraction. Verify scale and dimensions before production use.',
    inferredScale,
    confidence,
    assumptions,
    missingForPrecision,
    precisionStatus: inferredScale || missingForPrecision.length > 0 ? 'inferred_requires_review' : 'source_calibrated_requires_review',
    sourceCrop: cadArgs.sourceCrop || geometry.sourceCrop || null,
    sourceLinework: cadArgs.sourceLinework || geometry.sourceLinework || null,
    normalizationDiagnostics: { duplicateWallsRemoved: rawWalls.length - walls.length },
  };
}

async function createFloorplanComparisonPreview(
  imagePath: string,
  geometry: Record<string, any>,
): Promise<{ buffer: Buffer; path: string }> {
  const sharp = await getSharp();
  const panelWidth = 1100;
  const panelHeight = 1100;
  const headerHeight = 64;
  let sourcePipeline = sharp(imagePath).rotate();
  const cropBounds = geometry?.sourceCrop?.bounds;
  if (geometry?.sourceCrop?.detected === true && cropBounds) {
    sourcePipeline = sourcePipeline.extract({
      left: Number(cropBounds.left),
      top: Number(cropBounds.top),
      width: Number(cropBounds.width),
      height: Number(cropBounds.height),
    });
  }
  const sourcePanel = await sourcePipeline
    .flatten({ background: '#ffffff' })
    .resize({ width: panelWidth, height: panelHeight, fit: 'contain', background: '#ffffff' })
    .png()
    .toBuffer();
  const geometrySvg = buildCadGeometryVerificationSvg(geometry);
  const geometryPanel = await sharp(Buffer.from(geometrySvg), { density: 144 })
    .flatten({ background: '#ffffff' })
    .resize({ width: panelWidth, height: panelHeight, fit: 'contain', background: '#ffffff' })
    .png()
    .toBuffer();
  const labels = Buffer.from([
    `<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth * 2}" height="${headerHeight}">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    '<text x="24" y="43" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#111827">SOURCE IMAGE</text>',
    `<text x="${panelWidth + 24}" y="43" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#111827">EXTRACTED CAD GEOMETRY</text>`,
    '</svg>',
  ].join(''));
  const buffer = await sharp({
    create: {
      width: panelWidth * 2,
      height: panelHeight + headerHeight,
      channels: 4,
      background: '#ffffff',
    },
  }).composite([
    { input: labels, left: 0, top: 0 },
    { input: sourcePanel, left: 0, top: headerHeight },
    { input: geometryPanel, left: panelWidth, top: headerHeight },
  ]).png().toBuffer();
  const previewPath = getDataPath(path.join('cad', 'geometry_previews', `comparison_${Date.now()}.png`));
  fs.writeFileSync(previewPath, buffer);
  return { buffer, path: previewPath };
}

function normalizeVisualVerification(parsed: any): CadVisualVerification {
  const score = Math.max(0, Math.min(1, Number(parsed?.score) || 0));
  const criticalMismatches = Array.isArray(parsed?.criticalMismatches)
    ? parsed.criticalMismatches.map(String).filter(Boolean)
    : ['Visual verifier did not return a critical-mismatch list.'];
  const outerBoundaryMatches = parsed?.outerBoundaryMatches === true;
  const wallTopologyMatches = parsed?.wallTopologyMatches === true;
  const openingsMatch = parsed?.openingsMatch === true;
  const dimensionAnchorsMatch = parsed?.dimensionAnchorsMatch === true;
  const approved = parsed?.approved === true
    && score >= 0.9
    && outerBoundaryMatches
    && wallTopologyMatches
    && openingsMatch
    && dimensionAnchorsMatch
    && criticalMismatches.length === 0;
  return {
    approved,
    score,
    outerBoundaryMatches,
    wallTopologyMatches,
    openingsMatch,
    dimensionAnchorsMatch,
    criticalMismatches,
    notes: Array.isArray(parsed?.notes) ? parsed.notes.map(String).filter(Boolean) : [],
  };
}

async function verifyFloorplanGeometryVisually(input: {
  comparisonBuffer: Buffer;
  geometry: Record<string, any>;
  provider: VisionProvider;
  model: string;
  userId: string;
  getters: any;
}): Promise<CadVisualVerification> {
  const summary = {
    width: input.geometry.width,
    height: input.geometry.height,
    outerBoundaryPoints: Array.isArray(input.geometry.outerBoundary) ? input.geometry.outerBoundary.length : 0,
    walls: Array.isArray(input.geometry.walls) ? input.geometry.walls.length : 0,
    sourceLinework: Array.isArray(input.geometry.polylines) ? input.geometry.polylines.length : 0,
    doors: Array.isArray(input.geometry.doors) ? input.geometry.doors.length : 0,
    windows: Array.isArray(input.geometry.windows) ? input.geometry.windows.length : 0,
    dimensions: Array.isArray(input.geometry.dimensions) ? input.geometry.dimensions.length : 0,
    sourceTopology: input.geometry.sourceTopology || {},
    sourcePixelComparison: input.geometry?.sourceLinework?.metrics || {},
  };
  const prompt = [
    'You are a strict floor-plan trace verifier, not a designer.',
    'The left panel is the source image. The right panel is CAD geometry extracted from it.',
    'Both panels use the same crop, aspect ratio, and physical extents. Compare corresponding locations directly.',
    'Compare actual shape and topology. Ignore line thickness, styling, colors, all annotation text, elevation markers, compass art, and dimension graphics.',
    'Reject if the extracted result turns an irregular outline into a rectangle, invents a grid, loses a notch/projection, changes wall connectivity, or materially moves doors/windows.',
    'When sourceLinework is present, closed polylines trace visible wall/window contours and open polylines fill source-supported axis segments. Parallel contour faces are intentional wall edges, not an invented grid.',
    'Judge doors and windows by the visible linework at their source locations; do not require separate semantic door/window objects.',
    'Pixel comparison metrics are deterministic measurements against the source structural mask. Use them as evidence, but still reject any clearly visible topological mismatch.',
    'Do not approve merely because overall width and height match.',
    `Geometry summary: ${JSON.stringify(summary)}`,
    'Return only valid JSON with this exact shape:',
    '{"approved":false,"score":0.0,"outerBoundaryMatches":false,"wallTopologyMatches":false,"openingsMatch":false,"dimensionAnchorsMatch":false,"criticalMismatches":["string"],"notes":["string"]}',
  ].join('\n');
  try {
    const imagePayload = JSON.stringify({ image_base64: input.comparisonBuffer.toString('base64'), format: 'png' });
    const pass = await runFloorplanVisionPass({
      imagePayload,
      prompt,
      provider: input.provider,
      model: input.model,
      userId: input.userId,
      maxTokens: 2200,
      maxCharacters: 4000,
      stage: 'visual_verification',
      requiredKeys: ['approved', 'score', 'outerBoundaryMatches', 'wallTopologyMatches', 'openingsMatch', 'dimensionAnchorsMatch', 'criticalMismatches'],
      validateParsed: candidate => (
        typeof candidate.approved === 'boolean'
        && Number.isFinite(Number(candidate.score))
        && typeof candidate.outerBoundaryMatches === 'boolean'
        && typeof candidate.wallTopologyMatches === 'boolean'
        && typeof candidate.openingsMatch === 'boolean'
        && typeof candidate.dimensionAnchorsMatch === 'boolean'
        && Array.isArray(candidate.criticalMismatches)
      ),
      getters: input.getters,
    });
    if (!pass.parsed) {
      return normalizeVisualVerification({
        criticalMismatches: ['Visual source comparison did not return complete JSON.'],
        notes: [`Verifier attempts: ${pass.attempts}; response length: ${pass.analysis.length}`],
      });
    }
    return normalizeVisualVerification(pass.parsed);
  } catch (error: any) {
    return normalizeVisualVerification({
      criticalMismatches: [`Visual source comparison failed: ${error?.message || String(error)}`],
    });
  }
}

async function runFloorplanVisionPass(input: {
  imagePayload: string;
  prompt: string;
  provider: VisionProvider;
  model: string;
  userId: string;
  maxTokens: number;
  maxCharacters: number;
  stage: string;
  requiredKeys: string[];
  validateParsed: (candidate: Record<string, any>) => boolean;
  getters: any;
}): Promise<{ analysis: string; parsed: any | null; attempts: number; diagnostics: Record<string, any> }> {
  let analysis = '';
  let diagnostics: Record<string, any> = {};
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryInstruction = attempt === 1
      ? ''
      : [
          '',
          'RETRY: The previous response was not complete parseable JSON.',
          `Return one minified JSON object under ${input.maxCharacters} characters.`,
          `The top-level object must contain these exact keys with real values: ${input.requiredKeys.join(', ')}.`,
          'Keep only source-grounded geometry required by the schema. Do not explain, repeat the schema, or wrap the object in markdown.',
        ].join('\n');
    const prompt = `${input.prompt}${retryInstruction}`;
    const call = (responseFormat?: 'json_object') => analyzeScreen(
      input.imagePayload,
      prompt,
      {
        provider: input.provider,
        model: input.model,
        userId: input.userId,
        maxTokens: input.maxTokens,
        responseFormat,
      },
      input.getters.getDeepSeek,
      input.getters.getGemini,
      input.getters.getOpenAI,
      input.getters.getAnthropic,
      input.getters.getQwen,
      input.getters.getOllama,
      input.getters.getLmStudio,
      input.getters.getArk,
      input.getters.getXiaomi,
      input.getters.getKimi,
      input.getters.getGlm,
      input.getters.getRelay,
    );
    try {
      analysis = await call('json_object');
    } catch (error: any) {
      if (!/response.?format|json.?object|response.?mime|unsupported/i.test(String(error?.message || error))) throw error;
      analysis = await call();
    }
    const parsedJson = extractJsonObject(analysis);
    const parsed = findStructuredPayload(parsedJson, input.requiredKeys, input.validateParsed);
    diagnostics = {
      ...jsonParseDiagnostics(analysis),
      stage: input.stage,
      jsonParsed: Boolean(parsedJson),
      schemaMatched: Boolean(parsed),
      topLevelKeys: topLevelKeys(parsedJson),
    };
    if (parsed) {
      return { analysis, parsed, attempts: attempt, diagnostics };
    }
  }
  return { analysis, parsed: null, attempts: 2, diagnostics };
}

async function floorplanExtractGeometry(args: Record<string, any>, context?: any): Promise<string> {
  const imagePath = resolveReadableImagePath(args.imagePath || args.path || args.filePath);
  const g = context?.llmGetters || {};
  const provider = resolveVisionProvider(args, context);
  if (!provider) {
    return JSON.stringify({
      path: imagePath,
      note: 'No configured visual-perception model is available. Configure one in Settings > World Model > Visual Perception.',
    }, null, 2);
  }

  const sharp = await getSharp();
  const meta = await sharp(imagePath).metadata();
  const preparedSource = await prepareFloorplanSourceImage(imagePath);
  const buffer = preparedSource.buffer;
  const base64 = buffer.toString('base64');
  const model = getUserPreferredVision(context?.userId || 'anonymous').model || visionModelFor(provider);
  const projectName = String(args.projectName || args.title || '').trim();
  const knownScale = String(args.knownScale || args.scale || '').trim();
  const knownDimensions = String(args.knownDimensions || args.dimensions || '').trim();
  const sourceCrop = {
    detected: preparedSource.detected,
    bounds: preparedSource.bounds,
    originalWidth: preparedSource.originalWidth,
    originalHeight: preparedSource.originalHeight,
    cropPath: preparedSource.cropPath,
  };
  const cacheVersion = 'normalized-crop-compact-v1';
  const cacheKey = crypto.createHash('sha256')
    .update(fs.readFileSync(imagePath))
    .update(JSON.stringify({ cacheVersion, provider, model, knownScale, knownDimensions, bounds: sourceCrop.bounds }))
    .digest('hex');
  const cachePath = getDataPath(path.join('cad', 'extraction_cache', `${cacheKey}.json`));
  let stageCache: Record<string, any> = { version: cacheVersion, stages: {} };
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (cached?.version === cacheVersion && cached?.cacheKey === cacheKey && cached?.stages) stageCache = cached;
  } catch {}
  const persistStage = (stage: string, value: Record<string, any>) => {
    stageCache = {
      ...stageCache,
      version: cacheVersion,
      cacheKey,
      updatedAt: new Date().toISOString(),
      stages: { ...(stageCache.stages || {}), [stage]: value },
    };
    fs.writeFileSync(cachePath, JSON.stringify(stageCache), 'utf-8');
  };
  const cachedPass = (stage: string, requiredKeys: string[], validateParsed: (candidate: Record<string, any>) => boolean) => {
    const parsed = findStructuredPayload(stageCache?.stages?.[stage], requiredKeys, validateParsed);
    return parsed ? {
      analysis: '',
      parsed,
      attempts: 0,
      diagnostics: { stage, cached: true, schemaMatched: true },
    } : null;
  };
  const sharedTraceRules = [
    'You are tracing a source floor plan into CAD geometry. You are not designing a new layout.',
    'Return only valid JSON. No markdown, no commentary.',
    'Keep JSON compact. Do not repeat the schema, source description, or reasoning in the response.',
    'The supplied image is cropped to the connected building body so perimeter dimension chains and page notes are excluded.',
    'Geometry coordinates must use normalized_top_left_y_down: top-left origin, x and y each range from 0 to 1000 across this cropped image.',
    'Do not write millimeter values into geometry coordinates. Return physicalWidth and physicalHeight separately from visible or user-provided calibration dimensions.',
    'Preserve every visible notch, offset, projection, balcony, wall connection, and opening.',
    'width and height are bounding extents only. Never turn those two values into a rectangular outline unless the visible source is actually rectangular.',
    'Do not infer room names that are not printed in the source. Do not use typical-apartment layouts, default doors, default windows, or invented grids.',
    'Do not treat dimension-chain numbers as wall coordinates unless the corresponding wall alignment is visible.',
    'If scale is unavailable, set inferredScale=true and return null physical dimensions instead of inventing millimeter coordinates.',
    'Every inferred structural item must have inferred=true. Exact values require visible dimensions or user-provided known dimensions.',
    projectName ? `Project name: ${projectName}` : '',
    knownScale ? `Known scale: ${knownScale}` : '',
    knownDimensions ? `Known dimensions: ${knownDimensions}` : '',
    `Source crop audit: ${JSON.stringify(sourceCrop)}`,
  ].filter(Boolean);
  const topologyPrompt = [
    ...sharedTraceRules,
    'Stage 1 of 3: extract only calibration, dimension anchors, and the exact exterior topology.',
    'Walk around the visible building exterior in order. outerBoundary must contain one normalized image point for every direction change and must not repeat the first point at the end.',
    'Return at most 64 outerBoundary points and 32 dimensions. Keep only dimensions that calibrate the exterior boundary; do not transcribe every dimension-chain label.',
    'Set sourceTopology.outerVertexCount to the exact outerBoundary length.',
    'Do not return rooms, walls, doors, or windows in this stage.',
    'Required JSON shape:',
    '{',
    '  "projectName": "string",',
    '  "confidence": 0.0,',
    '  "inferredScale": true,',
    '  "unit": "mm",',
    '  "physicalWidth": number_or_null,',
    '  "physicalHeight": number_or_null,',
    '  "wallThicknessMm": number_or_null,',
    '  "coordinateSystem": "normalized_top_left_y_down",',
    '  "sourceTopology": {"isRectangular":boolean,"outerVertexCount":number,"visibleNotches":number,"visibleProjections":number},',
    '  "outerBoundary": [{"x":number,"y":number}],',
    '  "dimensions": [{"x1":number,"y1":number,"x2":number,"y2":number,"text":"string","offsetMm":number,"inferred":boolean}],',
    '  "assumptions": ["string"],',
    '  "missingForPrecision": ["string"],',
    '  "precisionNote": "string"',
    '}',
  ].filter(Boolean).join('\n');

  try {
    const imagePayload = JSON.stringify({
      image_base64: base64,
      format: 'jpeg',
      width: preparedSource.bounds.width,
      height: preparedSource.bounds.height,
    });
    const userId = context?.userId || 'anonymous';
    const topologyRequiredKeys = ['physicalWidth', 'physicalHeight', 'coordinateSystem', 'sourceTopology', 'outerBoundary', 'dimensions'];
    const validateTopology = (candidate: Record<string, any>) => (
        positiveNumber(candidate.physicalWidth) !== null
        && positiveNumber(candidate.physicalHeight) !== null
        && candidate.coordinateSystem === 'normalized_top_left_y_down'
        && candidate.sourceTopology
        && typeof candidate.sourceTopology === 'object'
        && !Array.isArray(candidate.sourceTopology)
        && Array.isArray(candidate.outerBoundary)
        && candidate.outerBoundary.length >= 3
        && Array.isArray(candidate.dimensions)
      );
    const confirmedWidth = positiveNumber(args.physicalWidth ?? args.overallWidth);
    const confirmedHeight = positiveNumber(args.physicalHeight ?? args.overallHeight);
    const suppliedCalibration = confirmedWidth && confirmedHeight ? {
      projectName: projectName || 'floorplan_draft',
      confidence: 1,
      inferredScale: false,
      unit: String(args.unit || 'mm'),
      physicalWidth: confirmedWidth,
      physicalHeight: confirmedHeight,
      wallThicknessMm: null,
      coordinateSystem: 'normalized_top_left_y_down',
      sourceTopology: { isRectangular: false, outerVertexCount: 4, visibleNotches: 0, visibleProjections: 0 },
      outerBoundary: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }],
      dimensions: [
        { x1: 0, y1: 0, x2: 1000, y2: 0, text: String(confirmedWidth), offsetMm: 0, inferred: false },
        { x1: 0, y1: 0, x2: 0, y2: 1000, text: String(confirmedHeight), offsetMm: 0, inferred: false },
      ],
      assumptions: [],
      missingForPrecision: [],
      precisionNote: 'Physical extents were explicitly confirmed by the caller.',
    } : null;
    const topologyPass = suppliedCalibration
      ? {
          analysis: '',
          parsed: suppliedCalibration,
          attempts: 0,
          diagnostics: { stage: 'topology', suppliedCalibration: true, schemaMatched: true },
        }
      : cachedPass('topology', topologyRequiredKeys, validateTopology)
        || await runFloorplanVisionPass({
        imagePayload,
        prompt: topologyPrompt,
        provider,
        model,
        userId,
        maxTokens: 4200,
        maxCharacters: 9000,
        stage: 'topology',
        requiredKeys: topologyRequiredKeys,
        validateParsed: validateTopology,
        getters: g,
      });
    if (!topologyPass.parsed) {
      return JSON.stringify({
        path: imagePath,
        image: { width: meta.width || null, height: meta.height || null, sourceCrop },
        provider,
        model,
        parsed: false,
        failedStage: 'topology',
        geometryReady: false,
        geometryVerified: false,
        executableGeometryAvailable: false,
        analysisCharacters: topologyPass.analysis.length,
        extractionAttempts: topologyPass.attempts,
        parseDiagnostics: topologyPass.diagnostics,
        parseError: 'The exterior-topology pass did not return complete JSON. No partial geometry is exposed for execution.',
        cadGenerateDxfArgs: null,
        cadPrepareAutocadOperationsArgs: null,
        next: 'Retry extraction with the same source or a clearer crop. Do not reconstruct coordinates from partial model output.',
      }, null, 2);
    }
    if (topologyPass.attempts > 0) persistStage('topology', topologyPass.parsed);

    const physicalWidth = positiveNumber(topologyPass.parsed.physicalWidth);
    const physicalHeight = positiveNumber(topologyPass.parsed.physicalHeight);
    if (!physicalWidth || !physicalHeight || topologyPass.parsed.inferredScale === true) {
      return JSON.stringify({
        path: imagePath,
        image: { width: meta.width || null, height: meta.height || null, sourceCrop },
        provider,
        model,
        parsed: false,
        failedStage: 'calibration',
        geometryReady: false,
        geometryVerified: false,
        executableGeometryAvailable: false,
        parseError: 'A confirmed physical width and height are required before deterministic source tracing.',
        cadGenerateDxfArgs: null,
        cadPrepareAutocadOperationsArgs: null,
        next: 'Provide or confirm one overall horizontal dimension and one overall vertical dimension, then retry.',
      }, null, 2);
    }

    let vectorized: Record<string, any>;
    try {
      vectorized = await vectorizeFloorplanLinework({
        imagePath,
        crop: sourceCrop.bounds,
        physicalWidth,
        physicalHeight,
      });
    } catch (error: any) {
      return JSON.stringify({
        path: imagePath,
        image: { width: meta.width || null, height: meta.height || null, sourceCrop },
        provider,
        model,
        parsed: false,
        failedStage: 'deterministic_vectorization',
        geometryReady: false,
        geometryVerified: false,
        executableGeometryAvailable: false,
        parseError: String(error?.message || error),
        cadGenerateDxfArgs: null,
        cadPrepareAutocadOperationsArgs: null,
        next: 'Repair the local deterministic tracing runtime or use a clearer orthogonal floor-plan source. Do not substitute model-invented geometry.',
      }, null, 2);
    }

    const parsed = {
      title: projectName || topologyPass.parsed.projectName || 'floorplan_draft',
      ...vectorized,
      sourceCrop,
      inferredScale: false,
      confidence: Number.isFinite(Number(topologyPass.parsed.confidence)) ? Number(topologyPass.parsed.confidence) : null,
      assumptions: [],
      missingForPrecision: [],
      precisionNote: 'Physical calibration comes from confirmed dimensions; geometry is deterministically traced from source pixels and independently compared with the source before execution.',
      dimensions: [
        { x1: 0, y1: 0, x2: physicalWidth, y2: 0, text: String(physicalWidth), offset: -500, inferred: false, source: 'confirmed_calibration' },
        { x1: 0, y1: 0, x2: 0, y2: physicalHeight, text: String(physicalHeight), offset: -500, inferred: false, source: 'confirmed_calibration' },
      ],
      sourceLinework: {
        engine: 'opencv',
        deterministic: true,
        metrics: vectorized.metrics || {},
      },
    };
    const cadArgs = normalizeFloorplanGeometry(parsed, args, imagePath);
    const validation = validateCadGeometry(cadArgs, { sourceGrounded: true });
    const comparison = await createFloorplanComparisonPreview(imagePath, cadArgs);
    const modelVisualVerification = validation.passed
      ? await verifyFloorplanGeometryVisually({
          comparisonBuffer: comparison.buffer,
          geometry: cadArgs,
          provider,
          model,
          userId,
          getters: g,
        })
      : normalizeVisualVerification({
          criticalMismatches: validation.errors,
          notes: ['Visual verification was skipped because deterministic geometry validation failed.'],
        });
    const visualVerification = validation.passed
      ? arbitrateCadVisualVerification(modelVisualVerification, cadArgs)
      : modelVisualVerification;
    const { receipt, receiptPath } = writeCadGeometryReceipt({
      sourcePath: imagePath,
      geometry: cadArgs,
      validation,
      visualVerification,
      comparisonPreviewPath: comparison.path,
    });
    const geometryReady = receipt.draftReady;
    const executableArgs = geometryReady ? { geometryReceiptPath: receiptPath } : null;
    return JSON.stringify({
      path: imagePath,
      image: { width: meta.width || null, height: meta.height || null, sourceCrop },
      provider,
      model,
      parsed: true,
      extractionStages: {
        topology: { parsed: true, characters: topologyPass.analysis.length, attempts: topologyPass.attempts, cached: topologyPass.attempts === 0 },
        deterministicVectorization: {
          parsed: true,
          engine: 'opencv',
          lineSegments: vectorized?.metrics?.lineSegmentCount || 0,
          outerVertices: vectorized?.metrics?.outerVertexCount || 0,
        },
      },
      geometryReview: {
        width: cadArgs.width,
        height: cadArgs.height,
        unit: cadArgs.unit,
        precisionStatus: cadArgs.precisionStatus,
        counts: {
          outerBoundary: Array.isArray(cadArgs.outerBoundary) ? cadArgs.outerBoundary.length : 0,
          walls: Array.isArray(cadArgs.walls) ? cadArgs.walls.length : 0,
          polylines: Array.isArray(cadArgs.polylines) ? cadArgs.polylines.length : 0,
          rooms: Array.isArray(cadArgs.rooms) ? cadArgs.rooms.length : 0,
          doors: Array.isArray(cadArgs.doors) ? cadArgs.doors.length : 0,
          windows: Array.isArray(cadArgs.windows) ? cadArgs.windows.length : 0,
          dimensions: Array.isArray(cadArgs.dimensions) ? cadArgs.dimensions.length : 0,
        },
        validation,
        visualVerification,
      },
      geometryReady,
      geometryVerified: geometryReady,
      executableGeometryAvailable: geometryReady,
      geometryReceiptPath: receiptPath,
      geometryHash: receipt.geometryHash,
      comparisonPreviewPath: comparison.path,
      cadGenerateDxfArgs: null,
      cadPrepareAutocadOperationsArgs: executableArgs,
      next: geometryReady
        ? 'Pass cadPrepareAutocadOperationsArgs directly to cad_prepare_autocad_operations, then pass the prepared operation file to mcp_cad-drafting_autocad_playback_file.'
        : 'Source comparison rejected this deterministic trace. Do not call CAD preparation or substitute model-generated geometry.',
    }, null, 2);
  } catch (err: any) {
    return JSON.stringify({
      path: imagePath,
      image: { width: meta.width || null, height: meta.height || null, sourceCrop },
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
      'Analyze a local image file descriptively with the configured vision model. This output is not executable CAD geometry. Use floorplan_extract_geometry when a source image must drive CAD operations.',
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
      'Trace a source floor plan with deterministic local vectorization, pixel-level source comparison, and an independent visual verification pass. Executable output is a compact server-owned geometry receipt handoff. Supply confirmed physicalWidth and physicalHeight when available. Continue only when geometryReady=true; never reconstruct coordinates from partial output.',
    parameters: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: 'Absolute or home-relative local floor plan image path.' },
        path: { type: 'string', description: 'Alias for imagePath.' },
        projectName: { type: 'string', description: 'Optional project name for the CAD draft.' },
        knownScale: { type: 'string', description: 'Optional known drawing scale, e.g. 1:100, one grid = 1000mm, or user-provided calibration.' },
        knownDimensions: { type: 'string', description: 'Optional confirmed dimensions from the user or source text.' },
        physicalWidth: { type: 'number', description: 'Confirmed overall physical width. Providing this with physicalHeight bypasses vision-based dimension calibration.' },
        physicalHeight: { type: 'number', description: 'Confirmed overall physical height. Providing this with physicalWidth bypasses vision-based dimension calibration.' },
        unit: { type: 'string', description: 'Preferred unit, default mm.' },
      },
      required: [],
    },
    handler: floorplanExtractGeometry,
    permission: 'user',
    securityLevel: 'safe',
  });
}
