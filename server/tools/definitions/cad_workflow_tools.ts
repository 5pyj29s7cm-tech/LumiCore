import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext } from '../types';
import { ToolRegistry } from '../registry';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);

function parseJson(value: unknown): any {
  let current = value;
  for (let attempt = 0; attempt < 4 && typeof current === 'string'; attempt += 1) {
    const text = current.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    try {
      current = JSON.parse(text);
      continue;
    } catch {}
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        current = JSON.parse(text.slice(start, end + 1));
        continue;
      } catch {}
    }
    break;
  }
  if (current && typeof current === 'object' && Array.isArray((current as any).content)) {
    const text = (current as any).content.find((item: any) => item?.type === 'text')?.text;
    if (text) return parseJson(text);
  }
  return current;
}

function normalizedName(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\.(?:png|jpe?g|webp|bmp|tiff?)$/i, '')
    .replace(/[\s_\-—–·.,，。()（）[\]【】]/g, '');
}

function editDistance(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = previous;
    }
  }
  return row[b.length];
}

function bestNameSimilarity(query: string, candidate: string): number {
  const normalizedQuery = normalizedName(query);
  const normalizedCandidate = normalizedName(candidate);
  if (!normalizedQuery || !normalizedCandidate) return 0;
  if (normalizedQuery.includes(normalizedCandidate)) return 1;
  const width = normalizedCandidate.length;
  const windows = normalizedQuery.length > width
    ? Array.from({ length: normalizedQuery.length - width + 1 }, (_, index) => normalizedQuery.slice(index, index + width))
    : [normalizedQuery];
  return Math.max(...windows.map(window => (
    1 - editDistance(window, normalizedCandidate) / Math.max(window.length, normalizedCandidate.length, 1)
  )));
}

function desktopRoots(): string[] {
  return Array.from(new Set([
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'OneDrive', 'Desktop'),
    process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : '',
  ].filter(Boolean))).filter(candidate => fs.existsSync(candidate));
}

function collectImages(root: string, depth = 0): string[] {
  if (depth > 2) return [];
  const result: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries.slice(0, 500)) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectImages(candidate, depth + 1));
    } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      result.push(candidate);
    }
  }
  return result;
}

function resolveFloorplanSource(args: Record<string, any>, context?: ToolContext): {
  path: string;
  candidates: string[];
} {
  const explicit = String(args.imagePath || args.path || args.filePath || '').trim();
  if (explicit) {
    const resolved = path.resolve(explicit.replace(/^~(?=[\\/])/, os.homedir()));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`Floor-plan source does not exist: ${resolved}`);
    }
    if (!IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      throw new Error(`Floor-plan source is not a supported image: ${resolved}`);
    }
    return { path: resolved, candidates: [resolved] };
  }

  const query = String(
    args.sourceName
      || args.source
      || args.title
      || context?.actionIntent
      || context?.routedTaskText
      || '',
  ).trim();
  const candidates = desktopRoots().flatMap(root => collectImages(root));
  const ranked = candidates
    .map(candidate => ({
      path: candidate,
      score: bestNameSimilarity(query, path.basename(candidate)),
      modifiedAt: (() => { try { return fs.statSync(candidate).mtimeMs; } catch { return 0; } })(),
    }))
    .sort((left, right) => right.score - left.score || right.modifiedAt - left.modifiedAt);
  const best = ranked[0];
  if (!best || best.score < 0.55) {
    throw new Error(`No unambiguous desktop floor-plan image matched the request. Candidates: ${ranked.slice(0, 6).map(item => item.path).join(' | ') || 'none'}`);
  }
  const runnerUp = ranked[1];
  if (runnerUp && best.score < 0.95 && best.score - runnerUp.score < 0.04) {
    throw new Error(`Multiple desktop images match the request. Candidates: ${ranked.slice(0, 4).map(item => item.path).join(' | ')}`);
  }
  return { path: best.path, candidates: ranked.slice(0, 4).map(item => item.path) };
}

function positiveDimension(value: unknown): number | null {
  const number = Number(String(value ?? '').replace(/[,，\s]/g, ''));
  return Number.isFinite(number) && number >= 100 && number <= 10_000_000 ? number : null;
}

function calibrationFromOcr(output: string): { physicalWidth: number; physicalHeight: number; unit: string } | null {
  const wrapper = parseJson(output);
  const analysis = String(wrapper?.analysis || output || '');
  const parsed = parseJson(analysis);
  const width = positiveDimension(parsed?.physicalWidth ?? parsed?.overallWidth ?? parsed?.widthMm);
  const height = positiveDimension(parsed?.physicalHeight ?? parsed?.overallHeight ?? parsed?.heightMm);
  if (width && height) return { physicalWidth: width, physicalHeight: height, unit: String(parsed?.unit || 'mm') };

  // i18n-allow: OCR label recognition; not user-visible copy.
  const widthMatch = analysis.match(/(?:(?:physical|overall)?\s*(?:width|horizontal)|(?:总|整体|外轮廓)?宽(?:度)?)\s*[：:=]?\s*([\d,.]+)/i); // i18n-allow: OCR label recognition; not user-visible copy.
  // i18n-allow: OCR label recognition; not user-visible copy.
  const heightMatch = analysis.match(/(?:(?:physical|overall)?\s*(?:height|vertical)|(?:总|整体|外轮廓)?高(?:度)?)\s*[：:=]?\s*([\d,.]+)/i); // i18n-allow: OCR label recognition; not user-visible copy.
  const fallbackWidth = positiveDimension(widthMatch?.[1]);
  const fallbackHeight = positiveDimension(heightMatch?.[1]);
  return fallbackWidth && fallbackHeight
    ? { physicalWidth: fallbackWidth, physicalHeight: fallbackHeight, unit: 'mm' }
    : null;
}

function blocked(stage: string, sourcePath: string, blocker: unknown, details: Record<string, any> = {}): string {
  return JSON.stringify({
    status: 'blocked',
    completed: false,
    stage,
    sourcePath,
    blocker: String((blocker as any)?.message || blocker || 'Unknown CAD workflow failure').slice(0, 1200),
    ...details,
  }, null, 2);
}

async function runInternalTool(
  registry: ToolRegistry,
  name: string,
  args: Record<string, any>,
  context?: ToolContext,
): Promise<string> {
  const definition = registry.get(name);
  if (!definition) throw new Error(`Required CAD workflow capability is unavailable: ${name}`);
  // The composite tool is the authorization boundary. Its fixed, audited
  // stages are not model-selectable, but still pass through the registry so
  // constitutional checks, confirmation state, timeouts, and metrics cannot
  // be bypassed by a composite workflow.
  return registry.execute(name, args, context ? { ...context, toolPolicy: undefined } : context);
}

export function registerCadWorkflowTools(registry: ToolRegistry): void {
  registry.register({
    name: 'cad_draw_floorplan_in_autocad',
    description: 'Complete one local floor-plan-to-AutoCAD task as a single resumable skill workflow. It resolves the requested desktop image, obtains physical calibration with the configured vision model, performs deterministic source tracing and independent geometry verification, prepares an audited operation set, opens/attaches to real AutoCAD through MCP/COM, resumes safely after interruption, and returns success only after completion-marker plus exact entity-delta verification. Do not manually chain the lower-level CAD tools when this tool is available.',
    // i18n-allow: Region-specific capability-discovery vocabulary; not user-visible copy.
    routingHints: ['读取桌面平面图画进AutoCAD', '图片转CAD', 'floor plan image to AutoCAD', 'trace drawing in AutoCAD'], // i18n-allow: Region-specific capability-discovery vocabulary; not user-visible copy.
    parameters: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: 'Exact source image path when already known.' },
        sourceName: { type: 'string', description: 'Natural-language desktop image name when the exact path is not known.' },
        projectName: { type: 'string', description: 'Optional drawing title.' },
        physicalWidth: { type: 'number', description: 'Optional confirmed overall width.' },
        physicalHeight: { type: 'number', description: 'Optional confirmed overall height.' },
        unit: { type: 'string', description: 'Physical unit, default mm.' },
        strokeDelayMs: { type: 'number', description: 'Visible delay between entities, 100-5000ms.' },
        savePath: { type: 'string', description: 'Optional DWG save path. Omit to leave the verified drawing open.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      let sourcePath = '';
      try {
        context?.onProgress?.('Resolving the source floor-plan image');
        const source = resolveFloorplanSource(args, context);
        sourcePath = source.path;
        if (context?.isCancelled?.()) return blocked('cancelled', sourcePath, 'The user cancelled the CAD workflow.');

        let physicalWidth = positiveDimension(args.physicalWidth);
        let physicalHeight = positiveDimension(args.physicalHeight);
        let unit = String(args.unit || 'mm');
        let calibrationEvidence: Record<string, any> | null = null;
        if (!physicalWidth || !physicalHeight) {
          context?.onProgress?.('Reading source dimensions');
          const ocrResult = await runInternalTool(registry, 'ocr_image_file', {
            imagePath: sourcePath,
            query: 'Read only confirmed outermost physical dimensions from this floor plan. Return JSON only: {"physicalWidth":number|null,"physicalHeight":number|null,"unit":"mm","evidence":"visible dimension labels used"}. Width is the full horizontal extent and height is the full vertical extent. Never estimate or use pixel dimensions.',
          }, context);
          const calibration = calibrationFromOcr(ocrResult);
          if (calibration) {
            physicalWidth = calibration.physicalWidth;
            physicalHeight = calibration.physicalHeight;
            unit = calibration.unit;
            calibrationEvidence = calibration;
          }
        }

        context?.onProgress?.('Tracing and verifying source geometry');
        const geometryText = await runInternalTool(registry, 'floorplan_extract_geometry', {
          imagePath: sourcePath,
          projectName: args.projectName || path.parse(sourcePath).name,
          physicalWidth: physicalWidth || undefined,
          physicalHeight: physicalHeight || undefined,
          unit,
        }, context);
        const geometry = parseJson(geometryText);
        if (geometry?.geometryReady !== true || geometry?.geometryVerified !== true || !geometry?.geometryReceiptPath) {
          return blocked('geometry_verification', sourcePath, geometry?.parseError || geometry?.error || geometry?.next || 'Source geometry did not pass verification.', {
            calibrationEvidence,
            geometryReceiptPath: geometry?.geometryReceiptPath || null,
          });
        }
        if (context?.isCancelled?.()) return blocked('cancelled', sourcePath, 'The user cancelled the CAD workflow.');

        context?.onProgress?.('Preparing the verified AutoCAD operation set');
        const preparedText = await runInternalTool(
          registry,
          'cad_prepare_autocad_operations',
          { geometryReceiptPath: geometry.geometryReceiptPath, strokeDelayMs: args.strokeDelayMs },
          context,
        );
        const prepared = parseJson(preparedText);
        if (!prepared?.operationsPath || !prepared?.completionMarkerPath || !prepared?.operationSetId) {
          return blocked('operation_preparation', sourcePath, prepared?.error || prepared?.note || 'AutoCAD operation preparation returned no verified operation set.', {
            geometryReceiptPath: geometry.geometryReceiptPath,
          });
        }
        if (context?.isCancelled?.()) return blocked('cancelled', sourcePath, 'The user cancelled the CAD workflow.');

        context?.onProgress?.('Drawing and verifying entities in AutoCAD');
        let playbackText: string;
        try {
          playbackText = await runInternalTool(registry, 'mcp_cad-drafting_autocad_playback_file', {
            operationsPath: prepared.operationsPath,
            completionMarkerPath: prepared.completionMarkerPath,
            strokeDelayMs: args.strokeDelayMs,
            savePath: args.savePath || undefined,
          }, context);
        } catch (error) {
          return blocked('autocad_playback', sourcePath, error, {
            geometryReceiptPath: geometry.geometryReceiptPath,
            operationsPath: prepared.operationsPath,
            completionMarkerPath: prepared.completionMarkerPath,
            operationSetId: prepared.operationSetId,
            operationCount: prepared.operationCount,
          });
        }
        const playback = parseJson(playbackText);
        const completed = playback?.status === 'completed'
          && playback?.completionMarkerExists === true
          && playback?.entityCountMatches === true
          && Number(playback?.operationCount) === Number(playback?.expectedEntityCount)
          && Number(playback?.entitiesAdded) === Number(playback?.expectedEntityCount);
        if (!completed) {
          return blocked('autocad_playback', sourcePath, playback?.blocker || playback?.error || playback?.note || 'AutoCAD did not produce the verified completion receipt.', {
            geometryReceiptPath: geometry.geometryReceiptPath,
            operationsPath: prepared.operationsPath,
            completionMarkerPath: prepared.completionMarkerPath,
            operationSetId: prepared.operationSetId,
            operationCount: prepared.operationCount,
          });
        }

        return JSON.stringify({
          ...playback,
          status: 'completed',
          completed: true,
          sourcePath,
          geometryReceiptPath: geometry.geometryReceiptPath,
          geometryHash: geometry.geometryHash,
          operationsPath: prepared.operationsPath,
          completionMarkerPath: prepared.completionMarkerPath,
          operationSetId: prepared.operationSetId,
          operationCount: Number(playback.operationCount),
          expectedEntityCount: Number(playback.expectedEntityCount),
          entitiesAdded: Number(playback.entitiesAdded),
          entityCountMatches: true,
          calibrationEvidence,
          workflow: 'cad_draw_floorplan_in_autocad',
        }, null, 2);
      } catch (error) {
        return blocked(sourcePath ? 'workflow' : 'source_discovery', sourcePath, error);
      }
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'cad.floorplan.autocad.visible_draw',
      family: 'cad_drafting',
      lane: 'cad',
      operation: 'create',
      risk: 'medium',
      sideEffects: [
        { type: 'desktop_control', scope: 'active AutoCAD drawing', reversible: true },
        { type: 'local_write', scope: 'audited CAD operation and completion receipts', reversible: true },
      ],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['status', 'completed', 'operationCount', 'expectedEntityCount', 'entitiesAdded', 'entityCountMatches'],
        requiredValues: { status: 'completed', completed: true, entityCountMatches: true },
        successStatuses: ['completed'],
        successSignals: ['AutoCAD completion marker exists and exact entity-count delta matches the operation set'],
        limitations: ['Success is limited to the traced source geometry and supplied calibration evidence.'],
      },
    },
    evidence: {
      capability: 'cad.floorplan.autocad.visible_draw',
      operation: 'create',
      assurance: 'verified',
      subjectArgument: 'imagePath',
      limitations: ['Completion requires source-geometry verification, an AutoCAD completion marker, and exact entity-count equality.'],
    },
  });
}
