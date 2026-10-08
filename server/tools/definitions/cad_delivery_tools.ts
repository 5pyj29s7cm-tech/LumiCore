import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { type ToolContext } from '../types';
import { getDataPath } from '../../config/data_path';
import { cadGeometryHash, hydrateCadGeometryFromReceipt, isImageCadSource, normalizeCadBoundary, validateCadGeometry, verifyCadGeometryReceipt, type CadGeometryReceipt, type CadGeometryValidation } from '../../cad/geometry_verification';
import type { ToolRegistry } from '../registry';
import { requireDesktopRelay } from './external_app_shared';

function safeFileName(value: string): string {
  const cleaned = (value || 'cad_drawing')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .replace(/^_+|_+$/g, '')
    .trim();
  return Array.from(cleaned || 'cad_drawing').slice(0, 64).join('') || 'cad_drawing';
}

function safeLayer(value: any, fallback: string): string {
  return String(value || fallback)
    .replace(/[^a-zA-Z0-9_$-]+/g, '_')
    .slice(0, 31) || fallback;
}

function dxfLine(x1: number, y1: number, x2: number, y2: number, layer = 'CUT'): string[] {
  return ['0', 'LINE', '8', layer, '10', String(x1), '20', String(y1), '30', '0', '11', String(x2), '21', String(y2), '31', '0'];
}

function dxfCircle(x: number, y: number, r: number, layer = 'HOLE'): string[] {
  return ['0', 'CIRCLE', '8', layer, '10', String(x), '20', String(y), '30', '0', '40', String(r)];
}

function dxfArc(cx: number, cy: number, r: number, start: number, end: number, layer = 'CUT'): string[] {
  return ['0', 'ARC', '8', layer, '10', String(cx), '20', String(cy), '30', '0', '40', String(r), '50', String(start), '51', String(end)];
}

function dxfText(x: number, y: number, text: string, height = 240, layer = 'TEXT'): string[] {
  return ['0', 'TEXT', '8', layer, '10', String(x), '20', String(y), '30', '0', '40', String(height), '1', text.slice(0, 80)];
}

function asFiniteNumber(value: any, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function maybeNumber(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function orientationToDegrees(value: any, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (/^(e|east|right|\u4e1c|\u53f3)$/.test(raw)) return 0;
  if (/^(n|north|up|\u5317|\u4e0a)$/.test(raw)) return 90;
  if (/^(w|west|left|\u897f|\u5de6)$/.test(raw)) return 180;
  if (/^(s|south|down|\u5357|\u4e0b)$/.test(raw)) return 270;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function pointList(value: any): Array<{ x: number; y: number }> {
  if (!Array.isArray(value)) return [];
  const points: Array<{ x: number; y: number }> = [];
  for (const point of value) {
    const x = maybeNumber(point?.x ?? point?.[0]);
    const y = maybeNumber(point?.y ?? point?.[1]);
    if (x !== null && y !== null) points.push({ x, y });
  }
  return points;
}

function dxfPolyline(points: Array<{ x: number; y: number }>, layer = 'CUT', closed = false): string[] {
  if (points.length < 2) return [];
  const out = ['0', 'LWPOLYLINE', '8', layer, '90', String(points.length), '70', closed ? '1' : '0'];
  for (const point of points) {
    out.push('10', String(point.x), '20', String(point.y));
  }
  return out;
}

function svgEscape(value: any): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildDxf(geometry: CadEntity[]): string {
  const entities: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  for (const entity of geometry) {
    switch (entity.kind) {
      case 'line': entities.push(...dxfLine(entity.x1, entity.y1, entity.x2, entity.y2, entity.layer)); break;
      case 'circle': entities.push(...dxfCircle(entity.x, entity.y, entity.r, entity.layer)); break;
      case 'arc': entities.push(...dxfArc(entity.cx, entity.cy, entity.r, entity.start, entity.end, entity.layer)); break;
      case 'text': entities.push(...dxfText(entity.x, entity.y, entity.text, entity.height, entity.layer)); break;
      case 'polyline': entities.push(...dxfPolyline(entity.points, entity.layer, entity.closed)); break;
    }
  }
  entities.push('0', 'ENDSEC', '0', 'EOF');
  return entities.join('\n') + '\n';
}

function buildCadPreviewSvg(args: Record<string, any>, title: string, geometry: CadEntity[]): string {
  const width = Math.max(1, Number(args.width) || 100);
  const height = Math.max(1, Number(args.height) || 60);
  const margin = Math.max(width, height) * 0.05;
  const titleBlockHeight = Math.max(900, height * 0.12);
  const titleBlockMargin = args.titleBlock === false ? 0 : titleBlockHeight + Math.max(400, titleBlockHeight * 0.2);
  const previewWidth = args.titleBlock === false ? width : Math.max(width, 1800);
  const strokeWidth = Math.max(1, Math.min(width, height) / 260);
  const textSize = Math.max(180, Math.min(width, height) / 32);
  const colors: Record<string, string> = { OUTLINE: '#38bdf8', ROOM: '#2dd4bf', WALL: '#fbbf24', HOLE: '#f472b6',
    COLUMN: '#cbd5e1', WINDOW: '#60a5fa', DOOR: '#34d399', DOOR_SWING: '#86efac', FURNITURE: '#fde68a',
    DIM: '#a78bfa', DIM_TEXT: '#ddd6fe', TITLE: '#64748b', TITLE_TEXT: '#dbeafe', ANNOTATION: '#f8fafc', TEXT: '#e5e7eb' };
  const fills: Record<string, string> = { ROOM: 'rgba(45,212,191,0.08)', COLUMN: 'rgba(148,163,184,0.18)',
    FURNITURE: 'rgba(251,191,36,0.08)', TITLE: 'rgba(15,23,42,0.78)' };
  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + [-margin, -margin, previewWidth + margin * 2, height + margin * 2 + titleBlockMargin].join(' ') + '" width="960" height="640">',
    '<rect x="-100000" y="-100000" width="200000" height="200000" fill="#08111f"/>',
    '<text x="0" y="' + (-margin * 0.35) + '" fill="#9fb7d8" font-size="' + textSize + '" font-family="Arial, sans-serif">' + svgEscape(title) + '</text>',
  ];
  for (const entity of geometry) {
    const color = colors[entity.layer] || '#94a3b8';
    const fill = fills[entity.layer] || 'none';
    const stroke = ' stroke="' + color + '" stroke-width="' + strokeWidth + '"';
    switch (entity.kind) {
      case 'line':
        parts.push('<line x1="' + entity.x1 + '" y1="' + entity.y1 + '" x2="' + entity.x2 + '" y2="' + entity.y2 + '"' + stroke + ' stroke-linecap="round"/>');
        break;
      case 'circle':
        parts.push('<circle cx="' + entity.x + '" cy="' + entity.y + '" r="' + entity.r + '" fill="' + fill + '"' + stroke + '/>');
        break;
      case 'arc': {
        const radians = Math.PI / 180;
        const startX = entity.cx + Math.cos(entity.start * radians) * entity.r;
        const startY = entity.cy + Math.sin(entity.start * radians) * entity.r;
        const endX = entity.cx + Math.cos(entity.end * radians) * entity.r;
        const endY = entity.cy + Math.sin(entity.end * radians) * entity.r;
        const largeArc = ((entity.end - entity.start + 360) % 360) > 180 ? 1 : 0;
        parts.push('<path d="M ' + startX + ' ' + startY + ' A ' + entity.r + ' ' + entity.r + ' 0 ' + largeArc + ' 1 ' + endX + ' ' + endY + '" fill="none"' + stroke + '/>');
        break;
      }
      case 'text':
        parts.push('<text x="' + entity.x + '" y="' + entity.y + '" fill="' + color + '" font-size="' + entity.height + '" font-family="Arial, sans-serif">' + svgEscape(entity.text) + '</text>');
        break;
      case 'polyline': {
        const tag = entity.closed ? 'polygon' : 'polyline';
        parts.push('<' + tag + ' points="' + entity.points.map(point => point.x + ',' + point.y).join(' ') + '" fill="' + fill + '"' + stroke + '/>');
        break;
      }
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

function getCadPreviewPath(dxfPath: string): string {
  return dxfPath.replace(/\.dxf$/i, '.svg');
}

function ensureDxfExtension(filePath: string): string {
  return /\.dxf$/i.test(filePath) ? filePath : `${filePath}.dxf`;
}

function expandHomePath(filePath: string): string {
  return filePath.replace(/^~(?=$|[\\/])/, os.homedir());
}

function assertWritableCadPath(filePath: string) {
  const normalized = path.normalize(filePath);
  const lower = normalized.toLowerCase();
  const blocked = [
    path.normalize('C:\\Windows').toLowerCase(),
    path.normalize('C:\\Program Files').toLowerCase(),
    path.normalize('C:\\Program Files (x86)').toLowerCase(),
  ];
  if (blocked.some(root => lower === root || lower.startsWith(root + path.sep.toLowerCase()))) {
    throw new Error(`Refusing to write CAD output inside a system directory: ${normalized}`);
  }
}

function resolveCadOutputPath(args: Record<string, any>, title: string): string {
  const outputPath = String(args.outputPath || '').trim();
  const outputDirectory = String(args.outputDirectory || '').trim();
  if (outputPath) {
    const baseDir = outputDirectory ? expandHomePath(outputDirectory) : getDataPath('cad');
    const resolved = path.isAbsolute(outputPath)
      ? expandHomePath(outputPath)
      : path.resolve(baseDir, outputPath);
    const finalPath = ensureDxfExtension(resolved);
    assertWritableCadPath(finalPath);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    return finalPath;
  }

  const directory = outputDirectory
    ? path.resolve(expandHomePath(outputDirectory))
    : getDataPath('cad');
  const finalPath = path.join(directory, `${title}_${Date.now()}.dxf`);
  assertWritableCadPath(finalPath);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  return finalPath;
}

type AutocadDrawOperation =
  | { kind: 'line'; layer: string; x1: number; y1: number; x2: number; y2: number; label?: string }
  | { kind: 'circle'; layer: string; x: number; y: number; r: number; label?: string }
  | { kind: 'arc'; layer: string; cx: number; cy: number; r: number; start: number; end: number; label?: string }
  | { kind: 'text'; layer: string; x: number; y: number; text: string; height: number; label?: string };

type CadEntity = AutocadDrawOperation
  | { kind: 'polyline'; layer: string; points: Array<{ x: number; y: number }>; closed: boolean; label?: string };

function validateCadDraftArgs(args: Record<string, any>): Record<string, any> {
  const width = Number(args.width);
  const height = Number(args.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('CAD width and height must be positive finite values. Extract geometry or confirm one calibration dimension before generating a drawing.');
  }
  const missingForPrecision = Array.isArray(args.missingForPrecision)
    ? args.missingForPrecision.map(String).filter(Boolean)
    : [];
  const assumptions = Array.isArray(args.assumptions) ? args.assumptions.map(String).filter(Boolean) : [];
  const inferredScale = args.inferredScale === true;
  const precisionStatus = String(args.precisionStatus || '').trim()
    || (inferredScale || missingForPrecision.length > 0 ? 'inferred_requires_review' : 'unspecified_requires_review');
  return {
    ...args,
    width,
    height,
    inferredScale,
    assumptions,
    missingForPrecision,
    precisionStatus,
  };
}

function intentRequiresImageGrounding(context?: ToolContext): boolean {
  return /(?:\battachment\b|\battached\b|\bsource\s+(?:image|drawing|floor\s*plan)\b|\u8fd9\u5e45\u56fe|\u8fd9\u5f20\u56fe|\u9644\u4ef6|\u539f\u56fe|\u6237\u578b\u56fe|\u56fe\u7247|\u7167\u7247)/iu.test(String(context?.actionIntent || ''));
}

function enforceCadGeometryGrounding(
  draftArgs: Record<string, any>,
  context?: ToolContext,
): { validation: CadGeometryValidation; receipt: CadGeometryReceipt | null; geometryVerified: true } {
  const sourcePath = String(draftArgs.sourcePath || '').trim();
  if (intentRequiresImageGrounding(context) && !sourcePath) {
    throw new Error('This task is grounded in an attached/source image. Pass sourcePath and the verified geometry receipt returned by floorplan_extract_geometry.');
  }
  const sourceGrounded = isImageCadSource(sourcePath);
  const validation = validateCadGeometry(draftArgs, { sourceGrounded });
  if (!validation.passed) {
    throw new Error(`CAD geometry validation failed: ${validation.errors.join(' ')}`);
  }
  const receipt = sourceGrounded ? verifyCadGeometryReceipt(draftArgs) : null;
  return { validation, receipt, geometryVerified: true };
}

function pushLineOp(ops: CadEntity[], layer: string, x1: any, y1: any, x2: any, y2: any, label?: string) {
  const a = maybeNumber(x1);
  const b = maybeNumber(y1);
  const c = maybeNumber(x2);
  const d = maybeNumber(y2);
  if (a === null || b === null || c === null || d === null || (a === c && b === d)) return;
  ops.push({ kind: 'line', layer: safeLayer(layer, 'CUT'), x1: a, y1: b, x2: c, y2: d, label });
}

function pushRectOps(ops: CadEntity[], x: number, y: number, width: number, height: number, layer = 'CUT', label?: string) {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
  pushPolylineOps(ops, [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], layer, true, label);
}

function pushPolylineOps(ops: CadEntity[], points: Array<{ x: number; y: number }>, layer = 'POLYLINE', closed = false, label?: string) {
  if (points.length >= 2) ops.push({ kind: 'polyline', layer: safeLayer(layer, 'POLYLINE'), points, closed, label });
}

function pushWallOps(ops: CadEntity[], wall: Record<string, any>, fallbackThickness = 0) {
  const x1 = maybeNumber(wall?.x1 ?? wall?.from?.x);
  const y1 = maybeNumber(wall?.y1 ?? wall?.from?.y);
  const x2 = maybeNumber(wall?.x2 ?? wall?.to?.x);
  const y2 = maybeNumber(wall?.y2 ?? wall?.to?.y);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return;
  const layer = safeLayer(wall?.layer, 'WALL');
  const thickness = asFiniteNumber(wall?.thickness, fallbackThickness);
  if (!Number.isFinite(thickness) || thickness <= 0) {
    pushLineOp(ops, layer, x1, y1, x2, y2, wall?.label || 'wall');
    return;
  }
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len <= 0) return;
  const nx = (-dy / len) * (thickness / 2);
  const ny = (dx / len) * (thickness / 2);
  pushPolylineOps(ops, [
    { x: x1 + nx, y: y1 + ny },
    { x: x2 + nx, y: y2 + ny },
    { x: x2 - nx, y: y2 - ny },
    { x: x1 - nx, y: y1 - ny },
  ], layer, true, wall?.label || 'wall');
}

function pushTextOp(ops: CadEntity[], x: any, y: any, text: any, height = 220, layer = 'TEXT', label?: string) {
  const px = maybeNumber(x);
  const py = maybeNumber(y);
  const value = String(text || '').trim();
  if (px === null || py === null || !value) return;
  ops.push({ kind: 'text', layer: safeLayer(layer, 'TEXT'), x: px, y: py, text: value, height: Math.max(1, asFiniteNumber(height, 220)), label });
}

const CAD_COLLECTION_LIMITS = {
  walls: 500, rooms: 120, labels: 160, doors: 160, windows: 160,
  dimensions: 240, furniture: 240, columns: 120, polylines: 240, holes: 40,
} as const;

function cadCollections(args: Record<string, any>) {
  return Object.fromEntries(Object.entries(CAD_COLLECTION_LIMITS).map(([key, limit]) => {
    const value = key === 'walls' && !Array.isArray(args.walls) ? args.lines : args[key];
    const items = Array.isArray(value) ? value : [];
    if (items.length > limit) throw new Error(
      `CAD ${key} limit exceeded (${limit}). Simplify or split the geometry; no partial drawing was emitted.`,
    );
    return [key, items];
  })) as Record<keyof typeof CAD_COLLECTION_LIMITS, any[]>;
}

/** Normalize geometry once for DXF, preview and native playback. */
function collectCadEntities(args: Record<string, any>): CadEntity[] {
  const width = Math.max(1, Number(args.width) || 100);
  const height = Math.max(1, Number(args.height) || 60);
  const { walls, rooms, labels, doors, windows, dimensions, furniture, columns, polylines, holes } = cadCollections(args);
  const wallThickness = asFiniteNumber(args.wallThickness, 0);
  const ops: CadEntity[] = [];
  const outerBoundary = normalizeCadBoundary(args);
  const sourceLineworkOwnsOutline = args?.sourceTopology?.traceMode === 'opencv_source_linework';

  if (outerBoundary.length >= 3 && !sourceLineworkOwnsOutline) {
    pushPolylineOps(ops, outerBoundary, 'OUTLINE', true, 'source outer boundary');
  } else if (!isImageCadSource(args.sourcePath) && args.rectangularOutline !== false) {
    const radius = Math.max(0, Math.min(Number(args.cornerRadius) || 0, Math.min(width, height) / 2));
    if (!radius) pushRectOps(ops, 0, 0, width, height, 'OUTLINE', 'explicit rectangular outline');
    else {
      pushLineOp(ops, 'OUTLINE', radius, 0, width - radius, 0);
      pushLineOp(ops, 'OUTLINE', width, radius, width, height - radius);
      pushLineOp(ops, 'OUTLINE', width - radius, height, radius, height);
      pushLineOp(ops, 'OUTLINE', 0, height - radius, 0, radius);
      for (const [cx, cy, start, end] of [[width - radius, radius, 270, 360], [width - radius, height - radius, 0, 90], [radius, height - radius, 90, 180], [radius, radius, 180, 270]]) {
        ops.push({ kind: 'arc', layer: 'OUTLINE', cx, cy, r: radius, start, end, label: 'rounded outline' });
      }
    }
  }

  for (const polyline of polylines) {
    const points = pointList(polyline?.points || polyline);
    pushPolylineOps(ops, points, safeLayer(polyline?.layer, 'POLYLINE'), Boolean(polyline?.closed), polyline?.label || 'polyline');
  }

  for (const wall of walls) pushWallOps(ops, wall, wallThickness);

  for (const room of rooms) {
    const points = pointList(room?.points || room?.polygon);
    if (points.length >= 3) {
      pushPolylineOps(ops, points, safeLayer(room?.layer, 'ROOM'), true, room?.name || 'room');
      const first = points[0];
      pushTextOp(ops, room?.labelX ?? first.x + 120, room?.labelY ?? first.y + 240, room?.name, room?.textHeight || 220, 'TEXT', 'room label');
      continue;
    }
    const x = maybeNumber(room?.x);
    const y = maybeNumber(room?.y);
    const w = maybeNumber(room?.width ?? room?.w);
    const h = maybeNumber(room?.height ?? room?.h);
    if (x !== null && y !== null && w !== null && h !== null && w > 0 && h > 0) {
      pushRectOps(ops, x, y, w, h, safeLayer(room?.layer, 'ROOM'), room?.name || 'room');
      pushTextOp(ops, x + 120, y + Math.min(h / 2, 600), room?.name, room?.textHeight || 220, 'TEXT', 'room label');
    }
  }

  for (const hole of holes) {
    const x = maybeNumber(hole?.x);
    const y = maybeNumber(hole?.y);
    const r = maybeNumber(hole?.r ?? hole?.radius);
    if (x !== null && y !== null && r !== null && r > 0) ops.push({ kind: 'circle', layer: safeLayer(hole?.layer, 'HOLE'), x, y, r, label: hole?.label || 'hole' });
  }

  for (const column of columns) {
    const x = maybeNumber(column?.x);
    const y = maybeNumber(column?.y);
    if (x === null || y === null) continue;
    const r = maybeNumber(column?.r ?? column?.radius);
    if (r !== null && r > 0) ops.push({ kind: 'circle', layer: safeLayer(column?.layer, 'COLUMN'), x, y, r, label: column?.label || 'column' });
    else {
      const w = Math.max(1, asFiniteNumber(column?.width ?? column?.w, 300));
      const h = Math.max(1, asFiniteNumber(column?.height ?? column?.h, w));
      pushRectOps(ops, x - w / 2, y - h / 2, w, h, safeLayer(column?.layer, 'COLUMN'), column?.label || 'column');
    }
  }

  for (const windowItem of windows) {
    let x1 = maybeNumber(windowItem?.x1 ?? windowItem?.from?.x);
    let y1 = maybeNumber(windowItem?.y1 ?? windowItem?.from?.y);
    let x2 = maybeNumber(windowItem?.x2 ?? windowItem?.to?.x);
    let y2 = maybeNumber(windowItem?.y2 ?? windowItem?.to?.y);
    const winWidth = Math.max(1, asFiniteNumber(windowItem?.width ?? windowItem?.w, 120));
    if (x1 === null || y1 === null || x2 === null || y2 === null) {
      const x = maybeNumber(windowItem?.x);
      const y = maybeNumber(windowItem?.y);
      const length = maybeNumber(windowItem?.length ?? windowItem?.l);
      if (x === null || y === null || length === null) continue;
      const angle = orientationToDegrees(windowItem?.angle ?? windowItem?.orientation, 0) * Math.PI / 180;
      x1 = x;
      y1 = y;
      x2 = x + Math.cos(angle) * length;
      y2 = y + Math.sin(angle) * length;
    }
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len <= 0) continue;
    const nx = (-dy / len) * (winWidth / 2);
    const ny = (dx / len) * (winWidth / 2);
    const layer = safeLayer(windowItem?.layer, 'WINDOW');
    pushLineOp(ops, layer, x1 + nx, y1 + ny, x2 + nx, y2 + ny, windowItem?.label || 'window');
    pushLineOp(ops, layer, x1, y1, x2, y2, windowItem?.label || 'window');
    pushLineOp(ops, layer, x1 - nx, y1 - ny, x2 - nx, y2 - ny, windowItem?.label || 'window');
  }

  for (const door of doors) {
    const hingeX = maybeNumber(door?.hingeX ?? door?.x ?? door?.x1);
    const hingeY = maybeNumber(door?.hingeY ?? door?.y ?? door?.y1);
    if (hingeX === null || hingeY === null) continue;
    const doorWidth = Math.max(1, asFiniteNumber(door?.width ?? door?.w, 900));
    const angle = orientationToDegrees(door?.angle ?? door?.orientation, 0);
    const swingRaw = String(door?.swing || door?.hand || '').toLowerCase();
    const sign = /left|ccw|out|\u5de6|\u5916/.test(swingRaw) ? 1 : -1;
    const leafX = maybeNumber(door?.leafX) ?? hingeX + Math.cos(angle * Math.PI / 180) * doorWidth;
    const leafY = maybeNumber(door?.leafY) ?? hingeY + Math.sin(angle * Math.PI / 180) * doorWidth;
    const openAngle = Math.max(20, Math.min(135, asFiniteNumber(door?.openAngle, 90)));
    pushLineOp(ops, safeLayer(door?.layer, 'DOOR'), hingeX, hingeY, leafX, leafY, door?.label || 'door leaf');
    ops.push({
      kind: 'arc',
      layer: safeLayer(door?.swingLayer, 'DOOR_SWING'),
      cx: hingeX,
      cy: hingeY,
      r: doorWidth,
      start: normalizeDegrees(sign >= 0 ? angle : angle + sign * openAngle),
      end: normalizeDegrees(sign >= 0 ? angle + sign * openAngle : angle),
      label: door?.label || 'door swing',
    });
    pushTextOp(ops, hingeX + 80, hingeY + 80, door?.label || door?.name, door?.textHeight || 180, 'TEXT', 'door label');
  }

  for (const item of furniture) {
    const x = maybeNumber(item?.x);
    const y = maybeNumber(item?.y);
    if (x === null || y === null) continue;
    const r = maybeNumber(item?.r ?? item?.radius);
    const layer = safeLayer(item?.layer, 'FURNITURE');
    if (r !== null && r > 0) ops.push({ kind: 'circle', layer, x, y, r, label: item?.label || item?.type || 'furniture' });
    else pushRectOps(ops, x, y, Math.max(1, asFiniteNumber(item?.width ?? item?.w, 800)), Math.max(1, asFiniteNumber(item?.height ?? item?.h, 600)), layer, item?.label || item?.type || 'furniture');
    pushTextOp(ops, x + 60, y + 220, item?.label || item?.name || item?.type, item?.textHeight || 180, 'TEXT', 'furniture label');
  }

  for (const dimension of dimensions) {
    const x1 = maybeNumber(dimension?.x1 ?? dimension?.from?.x);
    const y1 = maybeNumber(dimension?.y1 ?? dimension?.from?.y);
    const x2 = maybeNumber(dimension?.x2 ?? dimension?.to?.x);
    const y2 = maybeNumber(dimension?.y2 ?? dimension?.to?.y);
    if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len <= 0) continue;
    const offset = asFiniteNumber(dimension?.offset, 450);
    const tick = asFiniteNumber(dimension?.tick, 120);
    const nx = (-dy / len) * offset;
    const ny = (dx / len) * offset;
    const tx = (-dy / len) * tick;
    const ty = (dx / len) * tick;
    const ax = x1 + nx;
    const ay = y1 + ny;
    const bx = x2 + nx;
    const by = y2 + ny;
    pushLineOp(ops, 'DIM', x1, y1, ax, ay, 'dimension extension');
    pushLineOp(ops, 'DIM', x2, y2, bx, by, 'dimension extension');
    pushLineOp(ops, 'DIM', ax, ay, bx, by, 'dimension line');
    pushLineOp(ops, 'DIM', ax - tx, ay - ty, ax + tx, ay + ty, 'dimension tick');
    pushLineOp(ops, 'DIM', bx - tx, by - ty, bx + tx, by + ty, 'dimension tick');
    pushTextOp(ops, (ax + bx) / 2, (ay + by) / 2, dimension?.text || dimension?.label || `${Math.round(len)}`, dimension?.textHeight || 180, 'DIM_TEXT', 'dimension text');
  }

  for (const label of labels) {
    pushTextOp(ops, label?.x, label?.y, label?.text || label?.name, label?.height || 220, safeLayer(label?.layer, 'TEXT'), 'label');
  }

  if (args.titleBlock !== false) {
    const blockW = Math.max(1800, width * 0.28);
    const blockH = Math.max(900, height * 0.12);
    const x = Math.max(0, width - blockW);
    const y = Math.max(0, height + Math.max(400, blockH * 0.2));
    pushRectOps(ops, x, y, blockW, blockH, 'TITLE', 'title block');
    pushTextOp(ops, x + 120, y + blockH - 220, args.title || 'Lumi CAD Draft', 220, 'TITLE_TEXT', 'title');
    pushTextOp(ops, x + 120, y + blockH - 500, `Unit: ${args.unit || 'unit'}`, 160, 'TITLE_TEXT', 'unit');
    pushTextOp(ops, x + 120, y + blockH - 760, args.precisionNote || args.note || 'Draft generated by Lumi. Verify site dimensions before production.', 140, 'TITLE_TEXT', 'precision note');
  }

  if (args.northArrow) {
    const x = asFiniteNumber(args.northArrow?.x, width - 700);
    const y = asFiniteNumber(args.northArrow?.y, 700);
    pushLineOp(ops, 'ANNOTATION', x, y, x, y + 500, 'north arrow');
    pushLineOp(ops, 'ANNOTATION', x, y + 500, x - 120, y + 330, 'north arrow');
    pushLineOp(ops, 'ANNOTATION', x, y + 500, x + 120, y + 330, 'north arrow');
    pushTextOp(ops, x + 80, y + 520, 'N', 180, 'ANNOTATION', 'north label');
  }

  return ops;
}

function collectAutocadDrawOperations(args: Record<string, any>): AutocadDrawOperation[] {
  const ops: AutocadDrawOperation[] = [];
  for (const entity of collectCadEntities(args)) {
    if (entity.kind !== 'polyline') { ops.push(entity); continue; }
    const { points, closed, layer, label } = entity;
    const segments = closed ? points.length : points.length - 1;
    for (let i = 0; i < segments; i++) {
      const from = points[i];
      const to = points[(i + 1) % points.length];
      pushLineOp(ops, layer, from.x, from.y, to.x, to.y, label);
    }
  }
  if (ops.length > 2500) throw new Error('AutoCAD operation limit exceeded (2500). Simplify or split the geometry; no partial operation set was emitted.');
  return ops;
}

function resolveAutocadOperationPaths(args: Record<string, any>, title: string): {
  basePath: string;
  markerPath: string;
  manifestPath: string;
  operationsPath: string;
} {
  const outputPath = String(args.outputPath || '').trim();
  const outputDirectory = String(args.outputDirectory || '').trim();
  const directory = outputDirectory
    ? path.resolve(expandHomePath(outputDirectory))
    : getDataPath('cad');
  const rawBase = outputPath
    ? (path.isAbsolute(outputPath) ? expandHomePath(outputPath) : path.resolve(directory, outputPath))
    : path.join(directory, `${title}_autocad_operations_${Date.now()}`);
  const basePath = rawBase
    .replace(/_(?:operations|manifest)\.json$/i, '')
    .replace(/\.(?:json|lsp|scr|ps1|dxf|dwg)$/i, '');
  for (const filePath of [`${basePath}_completed.txt`, `${basePath}_manifest.json`, `${basePath}_operations.json`]) {
    assertWritableCadPath(filePath);
  }
  fs.mkdirSync(path.dirname(basePath), { recursive: true });
  return {
    basePath,
    markerPath: `${basePath}_completed.txt`,
    manifestPath: `${basePath}_manifest.json`,
    operationsPath: `${basePath}_operations.json`,
  };
}

function cadGeometryParameters() {
  const properties: Record<string, any> = {
    cornerRadius: { type: 'number', description: 'Optional rounded corner radius; all output formats use the same explicit geometry.' },
    sourcePath: { type: 'string', description: 'Optional source image/drawing path used for traceability.' },
    geometryReceiptPath: { type: 'string', description: 'Required for image-grounded CAD. Use the verified receipt returned by floorplan_extract_geometry; the server loads exact geometry from it.' },
    geometryHash: { type: 'string', description: 'Verified geometry hash; checked against the source receipt.' },
    sourceTopology: { type: 'object', description: 'Verified source topology, including whether the exterior is rectangular.' },
    outerBoundary: {
      type: 'array',
      description: 'Ordered source exterior polygon [{x,y}, ...]. Image-grounded geometry must preserve every notch and projection.',
      items: { type: 'object' },
    },
    rectangularOutline: { type: 'boolean', description: 'For manual geometry only. Set false to avoid an automatic rectangular outline when no outerBoundary is supplied.' },
    polylines: {
      type: 'array',
      description: 'Open/closed polylines: {points:[{x,y}],closed,layer}; native playback draws each segment.',
      items: { type: 'object' },
    },
    title: { type: 'string', description: 'Drawing title / output filename.' },
    width: { type: 'number', description: 'Outer width in chosen units.' },
    height: { type: 'number', description: 'Outer height in chosen units.' },
    unit: { type: 'string', description: 'Unit label, e.g. mm, cm, inch.' },
    wallThickness: { type: 'number', description: 'Default wall thickness for wall segments when individual wall.thickness is omitted.' },
    precisionNote: { type: 'string', description: 'Short note about source accuracy, scale assumptions, or missing dimensions.' },
    inferredScale: { type: 'boolean', description: 'True when scale or coordinates were inferred rather than confirmed from source dimensions.' },
    confidence: { type: 'number', description: 'Optional geometry extraction confidence from 0 to 1.' },
    assumptions: { type: 'array', description: 'Assumptions inherited from image/folder geometry extraction.', items: { type: 'string' } },
    missingForPrecision: { type: 'array', description: 'Inputs still needed before the drawing can be treated as dimensionally precise.', items: { type: 'string' } },
    precisionStatus: { type: 'string', description: 'Traceable precision state from geometry extraction.' },
    northArrow: { type: 'object', description: 'Optional north arrow position, e.g. {x,y}. Set true/object when orientation is known.' },
    titleBlock: { type: 'boolean', description: 'Whether to include a title block. Defaults to true.' },
    walls: {
      type: 'array',
      description: 'Optional CAD wall/line segments: {x1,y1,x2,y2,thickness,layer}. Use floor plan units such as mm.',
      items: { type: 'object' },
    },
    rooms: {
      type: 'array',
      description: 'Optional rooms: rectangles {name,x,y,width,height} or polygons {name,points:[{x,y}],labelX,labelY}.',
      items: { type: 'object' },
    },
    doors: {
      type: 'array',
      description: 'Optional doors: {x,y,width,angle,swing,label} or {hingeX,hingeY,width,angle,openAngle}. Draws leaf and swing arc.',
      items: { type: 'object' },
    },
    windows: {
      type: 'array',
      description: 'Optional windows: {x1,y1,x2,y2,width,label} or {x,y,length,angle,width}.',
      items: { type: 'object' },
    },
    dimensions: {
      type: 'array',
      description: 'Optional dimension lines: {x1,y1,x2,y2,text,offset}.',
      items: { type: 'object' },
    },
    furniture: {
      type: 'array',
      description: 'Optional furniture symbols: {type,label,x,y,width,height} or circular {x,y,r,label}.',
      items: { type: 'object' },
    },
    columns: {
      type: 'array',
      description: 'Optional structural columns: {x,y,width,height} or {x,y,r}.',
      items: { type: 'object' },
    },
    labels: {
      type: 'array',
      description: 'Optional text labels: {text,x,y,height,layer}.',
      items: { type: 'object' },
    },
    holes: {
      type: 'array',
      description: 'Optional holes as objects with x, y, and r/radius.',
      items: { type: 'object' },
    },
  };
  for (const [key, limit] of Object.entries(CAD_COLLECTION_LIMITS)) properties[key].maxItems = limit;
  return properties;
}

export function registerCadDeliveryTools(registry: ToolRegistry): void {
registry.register({
    name: 'cad_prepare_autocad_operations',
    description: 'Prepare a validated, auditable AutoCAD operations JSON for the AutoCAD MCP/COM playback tool. Image-grounded drawings require the exact geometryReceiptPath and geometry returned by floorplan_extract_geometry; partial or manually reconstructed vision output is rejected. This tool does not launch AutoCAD, create LISP/SCRIPT/PowerShell files, or generate a finished drawing as a fallback.',
    parameters: {
      type: 'object',
      properties: {
        ...cadGeometryParameters(),
        outputDirectory: { type: 'string', description: 'Optional directory for the operations JSON, manifest, and completion marker.' },
        outputPath: { type: 'string', description: 'Optional output base path. The tool writes _operations.json and _manifest.json beside it.' },
        strokeDelayMs: { type: 'number', description: 'Requested delay in milliseconds between visible MCP operations. Defaults to 450, minimum 100, maximum 5000.' },
      },
    },
    handler: async (args, context) => {
      const draftArgs = validateCadDraftArgs(hydrateCadGeometryFromReceipt(args));
      const grounding = enforceCadGeometryGrounding(draftArgs, context);
      const title = safeFileName(String(draftArgs.title || 'lumi_autocad_operations'));
      const requestedDelay = Number(draftArgs.strokeDelayMs);
      const delay = Number.isFinite(requestedDelay)
        ? Math.max(100, Math.min(requestedDelay, 5000))
        : 450;
      const paths = resolveAutocadOperationPaths(draftArgs, title);
      const operations = collectAutocadDrawOperations(draftArgs);
      if (!operations.length) throw new Error('No drawable AutoCAD operations were generated. Provide width/height plus walls, rooms, doors, windows, or labels.');
      const geometryHash = grounding.receipt?.geometryHash || cadGeometryHash(draftArgs);
      const operationSetId = crypto
        .createHash('sha256')
        .update(JSON.stringify({ geometryHash, operations }))
        .digest('hex');
      const geometryVerificationRequired = isImageCadSource(draftArgs.sourcePath);

      const geometryReceipt = {
        title,
        unit: draftArgs.unit || 'unit',
        geometryReceiptPath: draftArgs.geometryReceiptPath || '',
        geometryHash,
        geometryVerified: grounding.geometryVerified,
        geometryVerificationRequired,
        geometryValidation: grounding.validation,
        operationSetId,
      };
      const draftMetadata = {
        width: draftArgs.width,
        height: draftArgs.height,
        inferredScale: draftArgs.inferredScale,
        confidence: Number.isFinite(Number(draftArgs.confidence)) ? Number(draftArgs.confidence) : null,
        assumptions: draftArgs.assumptions,
        missingForPrecision: draftArgs.missingForPrecision,
        precisionStatus: draftArgs.precisionStatus,
        outerBoundaryPointCount: normalizeCadBoundary(draftArgs).length,
      };
      const playbackMetadata = {
        strokeDelayMs: delay,
        operationCount: operations.length,
        operationsPath: paths.operationsPath,
        completionMarkerPath: paths.markerPath,
        requiredPlaybackTool: 'mcp_cad-drafting_autocad_playback_file',
        fallbackAllowed: false,
      };
      const artifactIdentity = {
        version: 2,
        generatedAt: new Date().toISOString(),
        sourcePath: draftArgs.sourcePath || '',
      };
      fs.writeFileSync(paths.operationsPath, JSON.stringify({
        ...artifactIdentity, ...geometryReceipt, expectedEntityCount: operations.length, operations,
      }, null, 2), 'utf-8');
      const manifest = { ...artifactIdentity, ...geometryReceipt, ...draftMetadata, ...playbackMetadata };
      fs.writeFileSync(paths.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      try { fs.rmSync(paths.markerPath, { force: true }); } catch {}

      const layerCounts = operations.reduce((acc: Record<string, number>, op) => {
        acc[op.layer] = (acc[op.layer] || 0) + 1;
        return acc;
      }, {});
      const typeCounts = operations.reduce((acc: Record<string, number>, op) => {
        acc[op.kind] = (acc[op.kind] || 0) + 1;
        return acc;
      }, {});

      return JSON.stringify({
        ...geometryReceipt, ...draftMetadata, ...playbackMetadata, typeCounts, layerCounts,
        manifestPath: paths.manifestPath,
        preview: operations.slice(0, 20).map((op, index) => ({ index: index + 1, ...op })),
        note: 'Prepared source-validated AutoCAD operations only. Visible drawing is incomplete until MCP/COM playback verifies both the completion marker and the exact entity-count delta. No script or finished-file fallback is allowed.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'cad.autocad.operations.prepare',
      family: 'cad_drafting',
      lane: 'cad',
      operation: 'create',
      risk: 'medium',
      sideEffects: [{ type: 'local_write', scope: 'audited AutoCAD operation and manifest files', reversible: true }],
      verification: {
        strategy: 'artifact',
        required: true,
        requiredFields: ['operationsPath', 'manifestPath', 'operationSetId', 'operationCount'],
        requiredArtifacts: ['operationsPath', 'manifestPath'],
        successSignals: ['operation and manifest artifacts both exist and are non-empty'],
        limitations: ['Prepared operations are not evidence that AutoCAD drew the entities.'],
      },
    },
    evidence: {
      capability: 'cad.autocad.operations.prepare',
      operation: 'create',
      assurance: 'verified',
      subjectArgument: 'geometryReceiptPath',
      limitations: ['Visible drawing requires subsequent verified AutoCAD playback.'],
    },
  });

registry.register({
    name: 'cad_generate_dxf',
    description: 'Generate an explicitly requested DXF deliverable. For image-grounded work, pass only the compact verified geometryReceiptPath handoff returned by floorplan_extract_geometry; the server loads exact geometry from the receipt. OCR text, partial coordinates, or manually reconstructed vision output are rejected.',
    parameters: {
      type: 'object',
      properties: {
        ...cadGeometryParameters(),
        outputDirectory: { type: 'string', description: 'Optional directory to save the DXF, e.g. C:\\Users\\name\\Desktop. Use when the user asks to put the file somewhere visible.' },
        outputPath: { type: 'string', description: 'Optional exact DXF output path. Relative paths are resolved under outputDirectory or Lumi CAD data directory.' },
        openPreview: { type: 'boolean', description: 'Open the generated DXF with the system default app. Requires foreground confirmation, or an approved autonomous workflow when used in the background.' },
      },
    },
    handler: async (args, context) => {
      const draftArgs = validateCadDraftArgs(hydrateCadGeometryFromReceipt(args));
      const grounding = enforceCadGeometryGrounding(draftArgs, context);
      const title = safeFileName(String(draftArgs.title || 'lumi_cad_draft'));
      const outPath = resolveCadOutputPath(draftArgs, title);
      const geometry = collectCadEntities(draftArgs);
      fs.writeFileSync(outPath, buildDxf(geometry), 'utf-8');
      const previewSvg = buildCadPreviewSvg(draftArgs, title, geometry);
      const previewPath = getCadPreviewPath(outPath);
      fs.writeFileSync(previewPath, previewSvg, 'utf-8');
      const stat = fs.statSync(outPath);
      const previewStat = fs.statSync(previewPath);

      let openResult: string | undefined;
      if (draftArgs.openPreview) {
        const desktopRelay = requireDesktopRelay(context);
        openResult = await desktopRelay('desktop_open', { target: outPath });
      }

      return JSON.stringify({
        path: outPath,
        previewPath,
        previewSvg,
        title,
        unit: draftArgs.unit || 'unit',
        width: draftArgs.width,
        height: draftArgs.height,
        sourcePath: draftArgs.sourcePath || undefined,
        inferredScale: draftArgs.inferredScale,
        confidence: Number.isFinite(Number(draftArgs.confidence)) ? Number(draftArgs.confidence) : null,
        assumptions: draftArgs.assumptions,
        missingForPrecision: draftArgs.missingForPrecision,
        precisionStatus: draftArgs.precisionStatus,
        geometryReceiptPath: draftArgs.geometryReceiptPath || undefined,
        geometryHash: grounding.receipt?.geometryHash || cadGeometryHash(draftArgs),
        geometryVerified: grounding.geometryVerified,
        geometryVerificationRequired: isImageCadSource(draftArgs.sourcePath),
        geometryValidation: grounding.validation,
        outerBoundaryPointCount: normalizeCadBoundary(draftArgs).length,
        outputDirectory: path.dirname(outPath),
        exists: fs.existsSync(outPath),
        size: stat.size,
        previewExists: fs.existsSync(previewPath),
        previewSize: previewStat.size,
        artifacts: [
          { type: 'dxf', path: outPath },
          { type: 'svg_preview', path: previewPath },
        ],
        walls: Array.isArray(draftArgs.walls) ? draftArgs.walls.length : Array.isArray(draftArgs.lines) ? draftArgs.lines.length : 0,
        rooms: Array.isArray(draftArgs.rooms) ? draftArgs.rooms.length : 0,
        doors: Array.isArray(draftArgs.doors) ? draftArgs.doors.length : 0,
        windows: Array.isArray(draftArgs.windows) ? draftArgs.windows.length : 0,
        dimensions: Array.isArray(draftArgs.dimensions) ? draftArgs.dimensions.length : 0,
        furniture: Array.isArray(draftArgs.furniture) ? draftArgs.furniture.length : 0,
        columns: Array.isArray(draftArgs.columns) ? draftArgs.columns.length : 0,
        polylines: Array.isArray(draftArgs.polylines) ? draftArgs.polylines.length : 0,
        labels: Array.isArray(draftArgs.labels) ? draftArgs.labels.length : 0,
        holes: Array.isArray(draftArgs.holes) ? draftArgs.holes.length : 0,
        opened: Boolean(draftArgs.openPreview),
        openResult,
        note: 'Generated and verified a structured DXF drafting file. If source dimensions were inferred from an image, review scale, wall thickness, and tolerances before production use.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'cad.dxf.generate',
      family: 'cad_drafting',
      lane: 'cad',
      operation: 'create',
      risk: 'medium',
      sideEffects: [{ type: 'local_write', scope: 'DXF drawing and SVG preview files', reversible: true }],
      verification: {
        strategy: 'artifact',
        required: true,
        requiredFields: ['path', 'previewPath', 'exists', 'size', 'previewExists', 'previewSize'],
        requiredValues: { exists: true, previewExists: true },
        requiredArtifacts: ['path', 'previewPath'],
        successSignals: ['DXF and SVG preview artifacts both exist and are non-empty'],
        limitations: ['Artifact existence does not establish dimensional correctness when source calibration was inferred.'],
      },
    },
    evidence: {
      capability: 'cad.dxf.generate',
      operation: 'create',
      assurance: 'verified',
      subjectArgument: 'outputPath',
      limitations: ['The receipt proves local artifacts, not an opened or saved AutoCAD document.'],
    },
  });
}
