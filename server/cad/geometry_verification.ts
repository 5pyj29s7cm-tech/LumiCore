import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';

export type CadPoint = { x: number; y: number };

export interface CadGeometryValidation {
  passed: boolean;
  errors: string[];
  warnings: string[];
  metrics: {
    boundaryPointCount: number;
    wallCount: number;
    doorCount: number;
    windowCount: number;
    dimensionCount: number;
    inferredStructuralCount: number;
    duplicateSegmentCount: number;
    boundaryAreaRatio: number | null;
    sourcePixelPrecision: number | null;
    sourcePixelRecall: number | null;
    sourcePixelF1: number | null;
  };
}

export interface CadVisualVerification {
  approved: boolean;
  score: number;
  outerBoundaryMatches: boolean;
  wallTopologyMatches: boolean;
  openingsMatch: boolean;
  dimensionAnchorsMatch: boolean;
  criticalMismatches: string[];
  notes: string[];
  verificationMethod?: 'model' | 'model_and_pixel' | 'deterministic_pixel_arbitration';
  modelReview?: Omit<CadVisualVerification, 'modelReview'>;
}

export interface CadGeometryReceipt {
  version: 1;
  kind: 'lumi_floorplan_geometry_receipt';
  createdAt: string;
  sourcePath: string;
  sourceHash: string;
  sourceSize: number;
  sourceModifiedMs: number;
  geometryHash: string;
  geometry: Record<string, any>;
  validation: CadGeometryValidation;
  visualVerification: CadVisualVerification;
  comparisonPreviewPath?: string;
  draftReady: boolean;
}

function visualVerificationPassed(input: CadVisualVerification): boolean {
  return input?.approved === true
    && Number(input.score) >= 0.9
    && input.outerBoundaryMatches === true
    && input.wallTopologyMatches === true
    && input.openingsMatch === true
    && input.dimensionAnchorsMatch === true
    && Array.isArray(input.criticalMismatches)
    && input.criticalMismatches.length === 0;
}

const GEOMETRY_KEYS = [
  'width',
  'height',
  'unit',
  'wallThickness',
  'coordinateSystem',
  'precisionNote',
  'inferredScale',
  'confidence',
  'assumptions',
  'missingForPrecision',
  'precisionStatus',
  'sourceCrop',
  'sourceLinework',
  'normalizationDiagnostics',
  'outerBoundary',
  'sourceTopology',
  'walls',
  'rooms',
  'doors',
  'windows',
  'dimensions',
  'furniture',
  'columns',
  'labels',
  'polylines',
  'holes',
] as const;

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function arbitrateCadVisualVerification(
  modelReview: CadVisualVerification,
  geometry: Record<string, any>,
): CadVisualVerification {
  const metrics = geometry?.sourceLinework?.metrics && typeof geometry.sourceLinework.metrics === 'object'
    ? geometry.sourceLinework.metrics
    : {};
  const precision = finiteNumber(metrics.sourcePixelPrecision);
  const recall = finiteNumber(metrics.sourcePixelRecall);
  const f1 = finiteNumber(metrics.sourcePixelF1);
  const deterministicTrace = geometry?.sourceTopology?.traceMode === 'opencv_source_linework';
  const dimensionsConfirmed = geometry?.inferredScale !== true
    && Array.isArray(geometry?.dimensions)
    && geometry.dimensions.length >= 2;
  const strongPixelEvidence = deterministicTrace
    && dimensionsConfirmed
    && precision !== null && precision >= 0.98
    && recall !== null && recall >= 0.96
    && f1 !== null && f1 >= 0.97;

  if (modelReview.approved) {
    return {
      ...modelReview,
      verificationMethod: strongPixelEvidence ? 'model_and_pixel' : 'model',
    };
  }
  if (!strongPixelEvidence) return { ...modelReview, verificationMethod: 'model' };

  return {
    approved: true,
    score: f1!,
    outerBoundaryMatches: true,
    wallTopologyMatches: true,
    openingsMatch: true,
    dimensionAnchorsMatch: true,
    criticalMismatches: [],
    notes: [
      `Deterministic source comparison passed (precision=${precision!.toFixed(3)}, recall=${recall!.toFixed(3)}, F1=${f1!.toFixed(3)}).`,
      'The model review disagreed with direct pixel evidence and is retained below as an advisory audit record.',
    ],
    verificationMethod: 'deterministic_pixel_arbitration',
    modelReview: { ...modelReview, verificationMethod: 'model' },
  };
}

function stableValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result: Record<string, any>, key) => {
      if (value[key] !== undefined) result[key] = stableValue(value[key]);
      return result;
    }, {});
}

function geometryProjection(input: Record<string, any>): Record<string, any> {
  return GEOMETRY_KEYS.reduce((result: Record<string, any>, key) => {
    if (input[key] !== undefined) result[key] = input[key];
    return result;
  }, {});
}

export function normalizeCadBoundary(input: Record<string, any>): CadPoint[] {
  const raw = Array.isArray(input.outerBoundary)
    ? input.outerBoundary
    : Array.isArray(input.outerBoundary?.points)
      ? input.outerBoundary.points
      : Array.isArray(input.outline?.points)
        ? input.outline.points
        : [];
  const points = raw
    .map((point: any) => ({ x: finiteNumber(point?.x), y: finiteNumber(point?.y) }))
    .filter((point: any): point is CadPoint => point.x !== null && point.y !== null);
  if (points.length > 2) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first.x === last.x && first.y === last.y) points.pop();
  }
  return points;
}

export function isImageCadSource(sourcePath: unknown): boolean {
  return /\.(?:png|jpe?g|webp|bmp|gif|tiff?)$/i.test(String(sourcePath || '').trim());
}

export function cadGeometryHash(input: Record<string, any>): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(geometryProjection(input))))
    .digest('hex');
}

function polygonArea(points: CadPoint[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

function orientation(a: CadPoint, b: CadPoint, c: CadPoint): number {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 1e-8) return 0;
  return value > 0 ? 1 : 2;
}

function segmentsIntersect(a: CadPoint, b: CadPoint, c: CadPoint, d: CadPoint): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

function boundarySelfIntersects(points: CadPoint[]): boolean {
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (first === 0 && secondNext === 0) continue;
      if (segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext])) return true;
    }
  }
  return false;
}

function segmentKey(item: any): string | null {
  const x1 = finiteNumber(item?.x1 ?? item?.from?.x);
  const y1 = finiteNumber(item?.y1 ?? item?.from?.y);
  const x2 = finiteNumber(item?.x2 ?? item?.to?.x);
  const y2 = finiteNumber(item?.y2 ?? item?.to?.y);
  if ([x1, y1, x2, y2].some(value => value === null)) return null;
  const first = `${x1!.toFixed(3)},${y1!.toFixed(3)}`;
  const second = `${x2!.toFixed(3)},${y2!.toFixed(3)}`;
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function inferredCount(items: any[]): number {
  return items.filter(item => item?.inferred === true).length;
}

function isAxisAlignedRectangle(points: CadPoint[]): boolean {
  if (points.length !== 4) return false;
  return points.every((point, index) => {
    const next = points[(index + 1) % points.length];
    return point.x === next.x || point.y === next.y;
  });
}

export function validateCadGeometry(input: Record<string, any>, options: { sourceGrounded?: boolean } = {}): CadGeometryValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const width = finiteNumber(input.width);
  const height = finiteNumber(input.height);
  const boundary = normalizeCadBoundary(input);
  const walls = Array.isArray(input.walls) ? input.walls : [];
  const doors = Array.isArray(input.doors) ? input.doors : [];
  const windows = Array.isArray(input.windows) ? input.windows : [];
  const dimensions = Array.isArray(input.dimensions) ? input.dimensions : [];
  const structuralItems = [...walls, ...doors, ...windows];
  const inferredStructuralCount = inferredCount(structuralItems);
  const segmentKeys = walls.map(segmentKey).filter(Boolean) as string[];
  const duplicateSegmentCount = segmentKeys.length - new Set(segmentKeys).size;

  if (width === null || width <= 0 || height === null || height <= 0) {
    errors.push('CAD width and height must be positive finite values.');
  }
  if (options.sourceGrounded && boundary.length < 4) {
    errors.push('Image-grounded CAD requires an explicit outerBoundary with every visible notch and projection.');
  }
  if (boundary.length > 0 && boundary.length < 3) errors.push('outerBoundary must contain at least three distinct points.');
  if (boundary.length >= 3 && boundarySelfIntersects(boundary)) errors.push('outerBoundary self-intersects.');
  if (walls.length === 0 && boundary.length < 3 && (options.sourceGrounded || input.rectangularOutline === false)) {
    errors.push('No source wall topology or usable outer boundary was supplied.');
  }
  if (duplicateSegmentCount > 0) errors.push(`Geometry contains ${duplicateSegmentCount} duplicate wall segment(s).`);
  const duplicateWallsRemoved = Math.max(0, Number(input?.normalizationDiagnostics?.duplicateWallsRemoved) || 0);
  if (duplicateWallsRemoved > 0) warnings.push(`${duplicateWallsRemoved} exact duplicate wall segment(s) were removed during normalization.`);

  let boundaryAreaRatio: number | null = null;
  if (boundary.length >= 3 && width && height) {
    const xs = boundary.map(point => point.x);
    const ys = boundary.map(point => point.y);
    const boundaryWidth = Math.max(...xs) - Math.min(...xs);
    const boundaryHeight = Math.max(...ys) - Math.min(...ys);
    const tolerance = 0.05;
    if (Math.abs(boundaryWidth - width) / width > tolerance || Math.abs(boundaryHeight - height) / height > tolerance) {
      errors.push('outerBoundary extents do not agree with the declared width and height.');
    }
    boundaryAreaRatio = polygonArea(boundary) / (width * height);
    if (boundaryAreaRatio < 0.08 || boundaryAreaRatio > 1.02) errors.push('outerBoundary area is inconsistent with the declared drawing extent.');
  }

  const sourceTopology = input.sourceTopology && typeof input.sourceTopology === 'object' ? input.sourceTopology : {};
  if (options.sourceGrounded && typeof sourceTopology.isRectangular !== 'boolean') {
    errors.push('Image-grounded CAD requires explicit sourceTopology.isRectangular evidence.');
  }
  const declaredVertexCount = finiteNumber(sourceTopology.outerVertexCount);
  if (declaredVertexCount !== null && declaredVertexCount !== boundary.length) {
    errors.push('sourceTopology.outerVertexCount does not match outerBoundary.');
  }
  const visibleShapeChanges = Math.max(0, Number(sourceTopology.visibleNotches) || 0)
    + Math.max(0, Number(sourceTopology.visibleProjections) || 0);
  if (visibleShapeChanges > 0 && boundary.length <= 4) {
    errors.push('The source reports visible notches or projections, but outerBoundary does not preserve them.');
  }
  if (sourceTopology.isRectangular === false && isAxisAlignedRectangle(boundary)) {
    errors.push('The source is marked irregular, but outerBoundary was reduced to a rectangle.');
  }
  if (sourceTopology.isRectangular === true && boundary.length >= 4 && !isAxisAlignedRectangle(boundary)) {
    errors.push('The source is marked rectangular, but outerBoundary contains contradictory topology.');
  }
  const sourceLineworkMetrics = input?.sourceLinework?.metrics && typeof input.sourceLinework.metrics === 'object'
    ? input.sourceLinework.metrics
    : {};
  const sourcePixelPrecision = finiteNumber(sourceLineworkMetrics.sourcePixelPrecision);
  const sourcePixelRecall = finiteNumber(sourceLineworkMetrics.sourcePixelRecall);
  const sourcePixelF1 = finiteNumber(sourceLineworkMetrics.sourcePixelF1);
  if (options.sourceGrounded && sourceTopology.traceMode === 'opencv_source_linework') {
    const polylines = Array.isArray(input.polylines) ? input.polylines : [];
    if (polylines.length < 8) errors.push('Deterministic source tracing produced too little executable linework.');
    if (sourcePixelPrecision === null || sourcePixelRecall === null || sourcePixelF1 === null) {
      errors.push('Deterministic source tracing is missing pixel-level source comparison metrics.');
    } else {
      if (sourcePixelPrecision < 0.94) errors.push(`Source linework precision is too low (${sourcePixelPrecision.toFixed(3)}).`);
      if (sourcePixelRecall < 0.94) errors.push(`Source linework coverage is too low (${sourcePixelRecall.toFixed(3)}).`);
      if (sourcePixelF1 < 0.94) errors.push(`Source linework similarity is too low (${sourcePixelF1.toFixed(3)}).`);
    }
  }
  if (options.sourceGrounded && input.inferredScale === true) {
    errors.push('Image-grounded CAD needs a confirmed calibration dimension before executable geometry can be prepared.');
  }
  if (options.sourceGrounded && dimensions.length === 0) {
    errors.push('Image-grounded CAD has no extracted dimension anchors.');
  }
  if (structuralItems.length > 0 && inferredStructuralCount / structuralItems.length > 0.15) {
    errors.push('Too much structural geometry was inferred instead of traced from the source.');
  } else if (inferredStructuralCount > 0) {
    warnings.push(`${inferredStructuralCount} structural item(s) remain explicitly marked as inferred.`);
  }

  const assumptionText = (Array.isArray(input.assumptions) ? input.assumptions : []).join(' ');
  if (options.sourceGrounded && /(?:default|typical|guess|assum|invent|\u9ed8\u8ba4|\u5e38\u89c1\u6237\u578b|\u731c\u6d4b|\u63a8\u65ad\u623f\u95f4)/i.test(assumptionText)) {
    errors.push('Default or invented room, door, or window geometry is not allowed for source tracing.');
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    metrics: {
      boundaryPointCount: boundary.length,
      wallCount: walls.length,
      doorCount: doors.length,
      windowCount: windows.length,
      dimensionCount: dimensions.length,
      inferredStructuralCount,
      duplicateSegmentCount,
      boundaryAreaRatio,
      sourcePixelPrecision,
      sourcePixelRecall,
      sourcePixelF1,
    },
  };
}

function fileHash(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function writeCadGeometryReceipt(input: {
  sourcePath: string;
  geometry: Record<string, any>;
  validation: CadGeometryValidation;
  visualVerification: CadVisualVerification;
  comparisonPreviewPath?: string;
  outputDirectory?: string;
}): { receipt: CadGeometryReceipt; receiptPath: string } {
  const sourcePath = path.resolve(input.sourcePath);
  const stat = fs.statSync(sourcePath);
  const geometryHash = cadGeometryHash(input.geometry);
  const receipt: CadGeometryReceipt = {
    version: 1,
    kind: 'lumi_floorplan_geometry_receipt',
    createdAt: new Date().toISOString(),
    sourcePath,
    sourceHash: fileHash(sourcePath),
    sourceSize: stat.size,
    sourceModifiedMs: stat.mtimeMs,
    geometryHash,
    geometry: geometryProjection(input.geometry),
    validation: input.validation,
    visualVerification: input.visualVerification,
    comparisonPreviewPath: input.comparisonPreviewPath,
    draftReady: input.validation.passed && visualVerificationPassed(input.visualVerification),
  };
  const fileName = `geometry_${Date.now()}_${geometryHash.slice(0, 12)}.json`;
  const receiptPath = input.outputDirectory
    ? path.join(path.resolve(input.outputDirectory), fileName)
    : getDataPath(path.join('cad', 'geometry_receipts', fileName));
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf-8');
  return { receipt, receiptPath };
}

export function verifyCadGeometryReceipt(input: Record<string, any>): CadGeometryReceipt {
  const receiptPath = String(input.geometryReceiptPath || '').trim();
  if (!receiptPath) throw new Error('Image-grounded CAD requires geometryReceiptPath from a successful floorplan_extract_geometry result.');
  const resolvedReceiptPath = path.resolve(receiptPath);
  if (!fs.existsSync(resolvedReceiptPath) || !fs.statSync(resolvedReceiptPath).isFile()) {
    throw new Error(`CAD geometry receipt not found: ${resolvedReceiptPath}`);
  }
  if (fs.statSync(resolvedReceiptPath).size > 8 * 1024 * 1024) throw new Error('CAD geometry receipt is unexpectedly large.');
  const receipt = JSON.parse(fs.readFileSync(resolvedReceiptPath, 'utf-8')) as CadGeometryReceipt;
  if (receipt?.kind !== 'lumi_floorplan_geometry_receipt' || receipt?.version !== 1) {
    throw new Error('CAD geometry receipt is invalid or unsupported.');
  }
  if (!receipt.draftReady || !receipt.validation?.passed || !visualVerificationPassed(receipt.visualVerification)) {
    throw new Error('CAD geometry receipt did not pass source comparison and cannot be executed.');
  }
  const sourceValue = String(input.sourcePath || receipt.sourcePath || '').trim();
  if (!sourceValue) throw new Error('Image-grounded CAD is missing sourcePath.');
  const sourcePath = path.resolve(sourceValue);
  if (sourcePath.toLowerCase() !== path.resolve(receipt.sourcePath).toLowerCase()) {
    throw new Error('CAD sourcePath does not match the verified geometry receipt.');
  }
  if (!fs.existsSync(sourcePath) || fileHash(sourcePath) !== receipt.sourceHash) {
    throw new Error('The source image changed after geometry verification. Run floorplan_extract_geometry again.');
  }
  const geometryHash = cadGeometryHash(input);
  if (geometryHash !== receipt.geometryHash) {
    throw new Error('CAD geometry changed after source verification. Use the exact cadPrepareAutocadOperationsArgs returned by floorplan_extract_geometry.');
  }
  return receipt;
}

function receiptGeometryInput(receiptPath: string): Record<string, any> {
  const resolvedReceiptPath = path.resolve(receiptPath);
  if (!fs.existsSync(resolvedReceiptPath) || !fs.statSync(resolvedReceiptPath).isFile()) {
    throw new Error(`CAD geometry receipt not found: ${resolvedReceiptPath}`);
  }
  if (fs.statSync(resolvedReceiptPath).size > 8 * 1024 * 1024) throw new Error('CAD geometry receipt is unexpectedly large.');
  const receipt = JSON.parse(fs.readFileSync(resolvedReceiptPath, 'utf-8')) as CadGeometryReceipt;
  if (receipt?.kind !== 'lumi_floorplan_geometry_receipt' || receipt?.version !== 1 || !receipt.geometry) {
    throw new Error('CAD geometry receipt is invalid or unsupported.');
  }
  return receipt.geometry;
}

export function hydrateCadGeometryFromReceipt(input: Record<string, any>): Record<string, any> {
  const receiptPath = String(input.geometryReceiptPath || '').trim();
  if (!receiptPath) return { ...input };
  const receipt = verifyCadGeometryReceipt({
    ...receiptGeometryInput(receiptPath),
    geometryReceiptPath: receiptPath,
    sourcePath: input.sourcePath,
  });
  const hydrated = { ...input };
  for (const key of GEOMETRY_KEYS) delete hydrated[key];
  return {
    ...hydrated,
    ...receipt.geometry,
    sourcePath: receipt.sourcePath,
    geometryReceiptPath: path.resolve(receiptPath),
    geometryHash: receipt.geometryHash,
  };
}

export function buildCadGeometryVerificationSvg(input: Record<string, any>): string {
  const width = Math.max(1, Number(input.width) || 1);
  const height = Math.max(1, Number(input.height) || 1);
  const boundary = normalizeCadBoundary(input);
  const walls = Array.isArray(input.walls) ? input.walls : [];
  const rooms = Array.isArray(input.rooms) ? input.rooms : [];
  const polylines = Array.isArray(input.polylines) ? input.polylines : [];
  const doors = Array.isArray(input.doors) ? input.doors : [];
  const windows = Array.isArray(input.windows) ? input.windows : [];
  const baseStroke = Math.max(8, Math.min(width, height) / 300);
  const sourceLineworkOwnsOutline = input?.sourceTopology?.traceMode === 'opencv_source_linework';
  const lineworkStroke = sourceLineworkOwnsOutline
    ? Math.max(4, Math.min(width, height) / 700)
    : baseStroke;
  const points = (items: CadPoint[]) => items.map(point => `${point.x},${point.y}`).join(' ');
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">`,
    `<rect width="${width}" height="${height}" fill="white"/>`,
    `<g transform="translate(0 ${height}) scale(1 -1)">`,
  ];
  if (boundary.length >= 3 && !sourceLineworkOwnsOutline) {
    parts.push(`<polygon points="${points(boundary)}" fill="none" stroke="#111827" stroke-width="${baseStroke * 2.2}"/>`);
  }
  for (const polyline of polylines.slice(0, 1200)) {
    const linePoints = Array.isArray(polyline?.points)
      ? polyline.points
        .map((point: any) => ({ x: Number(point?.x), y: Number(point?.y) }))
        .filter((point: CadPoint) => Number.isFinite(point.x) && Number.isFinite(point.y))
      : [];
    if (linePoints.length < 2) continue;
    const tag = polyline?.closed === true ? 'polygon' : 'polyline';
    parts.push(`<${tag} points="${points(linePoints)}" fill="none" stroke="#111827" stroke-width="${lineworkStroke}" stroke-linecap="square" stroke-linejoin="miter"/>`);
  }
  for (const room of rooms.slice(0, 160)) {
    const roomPoints = Array.isArray(room?.points)
      ? room.points.map((point: any) => ({ x: Number(point?.x), y: Number(point?.y) })).filter((point: CadPoint) => Number.isFinite(point.x) && Number.isFinite(point.y))
      : [];
    if (roomPoints.length >= 3) parts.push(`<polygon points="${points(roomPoints)}" fill="none" stroke="#d1d5db" stroke-width="${baseStroke}"/>`);
  }
  for (const wall of walls.slice(0, 800)) {
    const x1 = finiteNumber(wall?.x1 ?? wall?.from?.x);
    const y1 = finiteNumber(wall?.y1 ?? wall?.from?.y);
    const x2 = finiteNumber(wall?.x2 ?? wall?.to?.x);
    const y2 = finiteNumber(wall?.y2 ?? wall?.to?.y);
    if ([x1, y1, x2, y2].some(value => value === null)) continue;
    const stroke = Math.max(baseStroke * 1.4, Math.min(Number(wall?.thickness) || baseStroke, baseStroke * 8));
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#111827" stroke-width="${stroke}" stroke-linecap="square"/>`);
  }
  for (const item of windows.slice(0, 240)) {
    const x1 = finiteNumber(item?.x1 ?? item?.from?.x);
    const y1 = finiteNumber(item?.y1 ?? item?.from?.y);
    const x2 = finiteNumber(item?.x2 ?? item?.to?.x);
    const y2 = finiteNumber(item?.y2 ?? item?.to?.y);
    if ([x1, y1, x2, y2].some(value => value === null)) continue;
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#2563eb" stroke-width="${baseStroke * 2}"/>`);
  }
  for (const door of doors.slice(0, 240)) {
    const x = finiteNumber(door?.hingeX ?? door?.x ?? door?.x1);
    const y = finiteNumber(door?.hingeY ?? door?.y ?? door?.y1);
    const doorWidth = finiteNumber(door?.width ?? door?.w);
    const angle = finiteNumber(door?.angle ?? door?.orientation);
    if ([x, y, doorWidth, angle].some(value => value === null) || doorWidth! <= 0) continue;
    const radians = angle! * Math.PI / 180;
    const leafX = x! + Math.cos(radians) * doorWidth!;
    const leafY = y! + Math.sin(radians) * doorWidth!;
    parts.push(`<line x1="${x}" y1="${y}" x2="${leafX}" y2="${leafY}" stroke="#059669" stroke-width="${baseStroke * 1.5}"/>`);
  }
  parts.push('</g>');
  parts.push('</svg>');
  return parts.join('');
}
