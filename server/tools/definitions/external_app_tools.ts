import fs from 'fs';
import os from 'os';
import path from 'path';
import { ToolRegistry } from '../registry';
import { ToolContext } from '../types';
import { getDataPath } from '../../config/data_path';
import { getExternalAppAdapters } from '../../external_apps/adapters';
import { getAdapterRegistry } from '../../adapters/registry';
import { getClientState } from '../../client/self_model';
import { isExternalAppAutomationAllowed, isMessagingSendConfirmationRequired } from '../../autonomy/safety_gate';
import { analyzeWechatIntake } from '../../work_takeover/wechat_intake';

function requireDesktopRelay(context?: ToolContext) {
  if (!context?.desktopRelay) {
    throw new Error('External app actions require the Lumi desktop client relay.');
  }
  return context.desktopRelay;
}

function requireExternalAutomation() {
  if (!isExternalAppAutomationAllowed()) {
    throw new Error('External app automation is disabled. Enable it in Settings > Autonomy before opening or controlling external apps.');
  }
}

function normalizeUrl(args: Record<string, any>): string {
  const rawUrl = String(args.url || '').trim();
  const query = String(args.query || '').trim();
  if (rawUrl) {
    if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
    return `https://${rawUrl}`;
  }
  if (!query) throw new Error('Provide either url or query.');
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
}

function buildMessageDraft(args: Record<string, any>): string {
  const explicitDraft = String(args.draft || '').trim();
  if (explicitDraft) return explicitDraft;

  const contact = String(args.contact || '').trim();
  const context = String(args.context || '').trim();
  const intent = String(args.intent || 'reply clearly and helpfully').trim();
  const tone = String(args.tone || 'warm and concise').trim();

  const lines = [
    contact ? `${contact}，` : '',
    `我看到了，我这边会按“${intent}”来处理。`,
  ];
  if (context) {
    lines.push(`关于你提到的“${context.slice(0, 160)}”，我会先确认关键点，再推进下一步。`);
  }
  lines.push(tone.includes('formal') ? '如有变动我会及时同步。' : '有变化我马上同步你。');
  return lines.filter(Boolean).join('\n');
}

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

function dxfRect(x: number, y: number, width: number, height: number, layer = 'CUT'): string[] {
  return dxfPolyline([
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ], layer, true);
}

function dxfWallSegment(x1: number, y1: number, x2: number, y2: number, thickness: number, layer = 'WALL'): string[] {
  if (!Number.isFinite(thickness) || thickness <= 0) return dxfLine(x1, y1, x2, y2, layer);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len <= 0) return [];
  const nx = (-dy / len) * (thickness / 2);
  const ny = (dx / len) * (thickness / 2);
  return dxfPolyline([
    { x: x1 + nx, y: y1 + ny },
    { x: x2 + nx, y: y2 + ny },
    { x: x2 - nx, y: y2 - ny },
    { x: x1 - nx, y: y1 - ny },
  ], layer, true);
}

function dxfDoor(door: Record<string, any>, fallbackWidth = 900): string[] {
  const hingeX = maybeNumber(door?.hingeX ?? door?.x ?? door?.x1);
  const hingeY = maybeNumber(door?.hingeY ?? door?.y ?? door?.y1);
  if (hingeX === null || hingeY === null) return [];
  const width = Math.max(1, asFiniteNumber(door?.width ?? door?.w, fallbackWidth));
  const angle = orientationToDegrees(door?.angle ?? door?.orientation, 0);
  const swingRaw = String(door?.swing || door?.hand || '').toLowerCase();
  const sign = /left|ccw|out|\u5de6|\u5916/.test(swingRaw) ? 1 : -1;
  const endX = maybeNumber(door?.leafX);
  const endY = maybeNumber(door?.leafY);
  const leafX = endX ?? hingeX + Math.cos(angle * Math.PI / 180) * width;
  const leafY = endY ?? hingeY + Math.sin(angle * Math.PI / 180) * width;
  const openAngle = Math.max(20, Math.min(135, asFiniteNumber(door?.openAngle, 90)));
  const start = normalizeDegrees(angle);
  const end = normalizeDegrees(angle + sign * openAngle);
  const entities = [
    ...dxfLine(hingeX, hingeY, leafX, leafY, safeLayer(door?.layer, 'DOOR')),
  ];
  if (sign >= 0) {
    entities.push(...dxfArc(hingeX, hingeY, width, start, end, safeLayer(door?.swingLayer, 'DOOR_SWING')));
  } else {
    entities.push(...dxfArc(hingeX, hingeY, width, end, start, safeLayer(door?.swingLayer, 'DOOR_SWING')));
  }
  if (door?.label || door?.name) {
    entities.push(...dxfText(hingeX + 80, hingeY + 80, String(door.label || door.name), asFiniteNumber(door?.textHeight, 180), 'TEXT'));
  }
  return entities;
}

function dxfWindow(windowItem: Record<string, any>, fallbackWidth = 120): string[] {
  let x1 = maybeNumber(windowItem?.x1 ?? windowItem?.from?.x);
  let y1 = maybeNumber(windowItem?.y1 ?? windowItem?.from?.y);
  let x2 = maybeNumber(windowItem?.x2 ?? windowItem?.to?.x);
  let y2 = maybeNumber(windowItem?.y2 ?? windowItem?.to?.y);
  const width = Math.max(1, asFiniteNumber(windowItem?.width ?? windowItem?.w, fallbackWidth));
  if (x1 === null || y1 === null || x2 === null || y2 === null) {
    const x = maybeNumber(windowItem?.x);
    const y = maybeNumber(windowItem?.y);
    const length = maybeNumber(windowItem?.length ?? windowItem?.l);
    if (x === null || y === null || length === null) return [];
    const angle = orientationToDegrees(windowItem?.angle ?? windowItem?.orientation, 0) * Math.PI / 180;
    x1 = x;
    y1 = y;
    x2 = x + Math.cos(angle) * length;
    y2 = y + Math.sin(angle) * length;
  }
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len <= 0) return [];
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);
  const layer = safeLayer(windowItem?.layer, 'WINDOW');
  const entities = [
    ...dxfLine(x1 + nx, y1 + ny, x2 + nx, y2 + ny, layer),
    ...dxfLine(x1, y1, x2, y2, layer),
    ...dxfLine(x1 - nx, y1 - ny, x2 - nx, y2 - ny, layer),
  ];
  if (windowItem?.label || windowItem?.name) {
    entities.push(...dxfText((x1 + x2) / 2, (y1 + y2) / 2 + width, String(windowItem.label || windowItem.name), asFiniteNumber(windowItem?.textHeight, 180), 'TEXT'));
  }
  return entities;
}

function dxfDimension(dimension: Record<string, any>): string[] {
  const x1 = maybeNumber(dimension?.x1 ?? dimension?.from?.x);
  const y1 = maybeNumber(dimension?.y1 ?? dimension?.from?.y);
  const x2 = maybeNumber(dimension?.x2 ?? dimension?.to?.x);
  const y2 = maybeNumber(dimension?.y2 ?? dimension?.to?.y);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return [];
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len <= 0) return [];
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
  const text = String(dimension?.text || dimension?.label || `${Math.round(len)}`).trim();
  return [
    ...dxfLine(x1, y1, ax, ay, 'DIM'),
    ...dxfLine(x2, y2, bx, by, 'DIM'),
    ...dxfLine(ax, ay, bx, by, 'DIM'),
    ...dxfLine(ax - tx, ay - ty, ax + tx, ay + ty, 'DIM'),
    ...dxfLine(bx - tx, by - ty, bx + tx, by + ty, 'DIM'),
    ...dxfText((ax + bx) / 2, (ay + by) / 2, text, asFiniteNumber(dimension?.textHeight, 180), 'DIM_TEXT'),
  ];
}

function dxfFurniture(item: Record<string, any>): string[] {
  const x = maybeNumber(item?.x);
  const y = maybeNumber(item?.y);
  if (x === null || y === null) return [];
  const layer = safeLayer(item?.layer, 'FURNITURE');
  const entities: string[] = [];
  const radius = maybeNumber(item?.r ?? item?.radius);
  if (radius !== null && radius > 0) {
    entities.push(...dxfCircle(x, y, radius, layer));
  } else {
    const w = Math.max(1, asFiniteNumber(item?.width ?? item?.w, 800));
    const h = Math.max(1, asFiniteNumber(item?.height ?? item?.h, 600));
    entities.push(...dxfRect(x, y, w, h, layer));
  }
  if (item?.label || item?.name || item?.type) {
    entities.push(...dxfText(x + 60, y + 220, String(item.label || item.name || item.type), asFiniteNumber(item?.textHeight, 180), 'TEXT'));
  }
  return entities;
}

function dxfColumn(item: Record<string, any>): string[] {
  const x = maybeNumber(item?.x);
  const y = maybeNumber(item?.y);
  if (x === null || y === null) return [];
  const radius = maybeNumber(item?.r ?? item?.radius);
  if (radius !== null && radius > 0) return dxfCircle(x, y, radius, safeLayer(item?.layer, 'COLUMN'));
  const w = Math.max(1, asFiniteNumber(item?.width ?? item?.w, 300));
  const h = Math.max(1, asFiniteNumber(item?.height ?? item?.h, w));
  return dxfRect(x - w / 2, y - h / 2, w, h, safeLayer(item?.layer, 'COLUMN'));
}

function svgEscape(value: any): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildRoundedRectEntities(width: number, height: number, radius: number): string[] {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  if (r <= 0) {
    return [
      ...dxfLine(0, 0, w, 0),
      ...dxfLine(w, 0, w, h),
      ...dxfLine(w, h, 0, h),
      ...dxfLine(0, h, 0, 0),
    ];
  }
  return [
    ...dxfLine(r, 0, w - r, 0),
    ...dxfLine(w, r, w, h - r),
    ...dxfLine(w - r, h, r, h),
    ...dxfLine(0, h - r, 0, r),
    ...dxfArc(w - r, r, r, 270, 360),
    ...dxfArc(w - r, h - r, r, 0, 90),
    ...dxfArc(r, h - r, r, 90, 180),
    ...dxfArc(r, r, r, 180, 270),
  ];
}

function buildDxf(args: Record<string, any>): string {
  const width = Math.max(1, Number(args.width) || 100);
  const height = Math.max(1, Number(args.height) || 60);
  const radius = Math.max(0, Number(args.cornerRadius) || 0);
  const holes = Array.isArray(args.holes) ? args.holes : [];
  const walls = Array.isArray(args.walls) ? args.walls : Array.isArray(args.lines) ? args.lines : [];
  const rooms = Array.isArray(args.rooms) ? args.rooms : [];
  const labels = Array.isArray(args.labels) ? args.labels : [];
  const doors = Array.isArray(args.doors) ? args.doors : [];
  const windows = Array.isArray(args.windows) ? args.windows : [];
  const dimensions = Array.isArray(args.dimensions) ? args.dimensions : [];
  const furniture = Array.isArray(args.furniture) ? args.furniture : [];
  const columns = Array.isArray(args.columns) ? args.columns : [];
  const polylines = Array.isArray(args.polylines) ? args.polylines : [];
  const wallThickness = asFiniteNumber(args.wallThickness, 0);
  const entities: string[] = [
    '0', 'SECTION', '2', 'ENTITIES',
    ...buildRoundedRectEntities(width, height, radius),
  ];

  for (const polyline of polylines.slice(0, 240)) {
    const points = pointList(polyline?.points || polyline);
    if (points.length >= 2) {
      entities.push(...dxfPolyline(points, safeLayer(polyline?.layer, 'POLYLINE'), Boolean(polyline?.closed)));
    }
  }

  for (const wall of walls.slice(0, 500)) {
    const x1 = Number(wall?.x1 ?? wall?.from?.x);
    const y1 = Number(wall?.y1 ?? wall?.from?.y);
    const x2 = Number(wall?.x2 ?? wall?.to?.x);
    const y2 = Number(wall?.y2 ?? wall?.to?.y);
    if ([x1, y1, x2, y2].every(Number.isFinite)) {
      entities.push(...dxfWallSegment(x1, y1, x2, y2, asFiniteNumber(wall?.thickness, wallThickness), safeLayer(wall?.layer, 'WALL')));
    }
  }

  for (const room of rooms.slice(0, 120)) {
    const points = pointList(room?.points || room?.polygon);
    if (points.length >= 3) {
      entities.push(...dxfPolyline(points, safeLayer(room?.layer, 'ROOM'), true));
      const first = points[0];
      if (room?.name && first) {
        entities.push(...dxfText(asFiniteNumber(room?.labelX, first.x + 120), asFiniteNumber(room?.labelY, first.y + 240), String(room.name), Number(room?.textHeight) || 220, 'TEXT'));
      }
      continue;
    }
    const x = Number(room?.x);
    const y = Number(room?.y);
    const w = Number(room?.width ?? room?.w);
    const h = Number(room?.height ?? room?.h);
    if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
      const layer = safeLayer(room?.layer, 'ROOM');
      entities.push(...dxfRect(x, y, w, h, layer));
      if (room?.name) {
        entities.push(...dxfText(x + 120, y + Math.min(h / 2, 600), String(room.name), Number(room?.textHeight) || 220, 'TEXT'));
      }
    }
  }

  for (const hole of holes.slice(0, 40)) {
    const x = Number(hole?.x);
    const y = Number(hole?.y);
    const r = Number(hole?.r ?? hole?.radius);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(r) && r > 0) {
      entities.push(...dxfCircle(x, y, r));
    }
  }

  for (const column of columns.slice(0, 120)) {
    entities.push(...dxfColumn(column));
  }

  for (const windowItem of windows.slice(0, 160)) {
    entities.push(...dxfWindow(windowItem));
  }

  for (const door of doors.slice(0, 160)) {
    entities.push(...dxfDoor(door));
  }

  for (const item of furniture.slice(0, 240)) {
    entities.push(...dxfFurniture(item));
  }

  for (const dimension of dimensions.slice(0, 240)) {
    entities.push(...dxfDimension(dimension));
  }

  for (const label of labels.slice(0, 160)) {
    const x = Number(label?.x);
    const y = Number(label?.y);
    const text = String(label?.text || label?.name || '').trim();
    if (Number.isFinite(x) && Number.isFinite(y) && text) {
      entities.push(...dxfText(x, y, text, Number(label?.height) || 220, safeLayer(label?.layer, 'TEXT')));
    }
  }

  if (args.titleBlock !== false) {
    const title = String(args.title || 'Lumi CAD Draft');
    const unit = String(args.unit || 'unit');
    const note = String(args.precisionNote || args.note || 'Draft generated by Lumi. Verify site dimensions before production.').slice(0, 120);
    const blockW = Math.max(1800, width * 0.28);
    const blockH = Math.max(900, height * 0.12);
    const x = Math.max(0, width - blockW);
    const y = Math.max(0, height + Math.max(400, blockH * 0.2));
    entities.push(...dxfRect(x, y, blockW, blockH, 'TITLE'));
    entities.push(...dxfText(x + 120, y + blockH - 220, title, 220, 'TITLE_TEXT'));
    entities.push(...dxfText(x + 120, y + blockH - 500, `Unit: ${unit}`, 160, 'TITLE_TEXT'));
    entities.push(...dxfText(x + 120, y + blockH - 760, note, 140, 'TITLE_TEXT'));
  }

  if (args.northArrow) {
    const x = asFiniteNumber(args.northArrow?.x, width - 700);
    const y = asFiniteNumber(args.northArrow?.y, 700);
    entities.push(...dxfLine(x, y, x, y + 500, 'ANNOTATION'));
    entities.push(...dxfLine(x, y + 500, x - 120, y + 330, 'ANNOTATION'));
    entities.push(...dxfLine(x, y + 500, x + 120, y + 330, 'ANNOTATION'));
    entities.push(...dxfText(x + 80, y + 520, 'N', 180, 'ANNOTATION'));
  }

  entities.push('0', 'ENDSEC', '0', 'EOF');
  return `${entities.join('\n')}\n`;
}

function buildCadPreviewSvg(args: Record<string, any>, title: string): string {
  const width = Math.max(1, Number(args.width) || 100);
  const height = Math.max(1, Number(args.height) || 60);
  const radius = Math.max(0, Number(args.cornerRadius) || 0);
  const holes = Array.isArray(args.holes) ? args.holes : [];
  const walls = Array.isArray(args.walls) ? args.walls : Array.isArray(args.lines) ? args.lines : [];
  const rooms = Array.isArray(args.rooms) ? args.rooms : [];
  const labels = Array.isArray(args.labels) ? args.labels : [];
  const doors = Array.isArray(args.doors) ? args.doors : [];
  const windows = Array.isArray(args.windows) ? args.windows : [];
  const dimensions = Array.isArray(args.dimensions) ? args.dimensions : [];
  const furniture = Array.isArray(args.furniture) ? args.furniture : [];
  const columns = Array.isArray(args.columns) ? args.columns : [];
  const polylines = Array.isArray(args.polylines) ? args.polylines : [];
  const wallThickness = asFiniteNumber(args.wallThickness, 0);
  const margin = Math.max(width, height) * 0.05;
  const titleBlockMargin = args.titleBlock === false ? 0 : Math.max(900, height * 0.12);
  const viewBox = `${-margin} ${-margin} ${width + margin * 2} ${height + margin * 2 + titleBlockMargin}`;
  const strokeWidth = Math.max(1, Math.min(width, height) / 260);
  const textSize = Math.max(180, Math.min(width, height) / 32);
  const pointAttr = (points: Array<{ x: number; y: number }>) => points.map(point => `${point.x},${point.y}`).join(' ');
  const svgLine = (x1: number, y1: number, x2: number, y2: number, color: string, sw = strokeWidth, dash = '') =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  const svgText = (x: number, y: number, text: any, size = textSize, color = '#e5e7eb') =>
    `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-family="Arial, sans-serif">${svgEscape(text)}</text>`;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="960" height="640">`,
    '<rect x="-100000" y="-100000" width="200000" height="200000" fill="#08111f"/>',
    svgText(0, -margin * 0.35, title, textSize, '#9fb7d8'),
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="none" stroke="#38bdf8" stroke-width="${strokeWidth * 1.4}"/>`,
  ];

  for (const polyline of polylines.slice(0, 240)) {
    const points = pointList(polyline?.points || polyline);
    if (points.length >= 2) {
      parts.push(`<polyline points="${pointAttr(points)}" fill="none" stroke="#94a3b8" stroke-width="${strokeWidth}"${polyline?.closed ? ' data-closed="true"' : ''}/>`);
    }
  }

  for (const room of rooms.slice(0, 120)) {
    const points = pointList(room?.points || room?.polygon);
    if (points.length >= 3) {
      parts.push(`<polygon points="${pointAttr(points)}" fill="rgba(45,212,191,0.08)" stroke="#2dd4bf" stroke-width="${strokeWidth}"/>`);
      const first = points[0];
      if (room?.name && first) {
        parts.push(svgText(asFiniteNumber(room?.labelX, first.x + 120), asFiniteNumber(room?.labelY, first.y + 240), room.name, Number(room?.textHeight) || textSize, '#d8f3ff'));
      }
      continue;
    }
    const x = Number(room?.x);
    const y = Number(room?.y);
    const w = Number(room?.width ?? room?.w);
    const h = Number(room?.height ?? room?.h);
    if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(45,212,191,0.08)" stroke="#2dd4bf" stroke-width="${strokeWidth}"/>`);
      if (room?.name) {
        parts.push(svgText(x + 120, y + Math.min(h / 2, 600), room.name, Number(room?.textHeight) || textSize, '#d8f3ff'));
      }
    }
  }

  for (const wall of walls.slice(0, 500)) {
    const x1 = Number(wall?.x1 ?? wall?.from?.x);
    const y1 = Number(wall?.y1 ?? wall?.from?.y);
    const x2 = Number(wall?.x2 ?? wall?.to?.x);
    const y2 = Number(wall?.y2 ?? wall?.to?.y);
    if ([x1, y1, x2, y2].every(Number.isFinite)) {
      const thickness = asFiniteNumber(wall?.thickness, wallThickness);
      parts.push(svgLine(x1, y1, x2, y2, '#fbbf24', thickness > 0 ? Math.max(strokeWidth * 2, thickness) : strokeWidth * 1.8));
    }
  }

  for (const hole of holes.slice(0, 40)) {
    const x = Number(hole?.x);
    const y = Number(hole?.y);
    const r = Number(hole?.r ?? hole?.radius);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(r) && r > 0) {
      parts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#f472b6" stroke-width="${strokeWidth}"/>`);
    }
  }

  for (const column of columns.slice(0, 120)) {
    const x = maybeNumber(column?.x);
    const y = maybeNumber(column?.y);
    if (x === null || y === null) continue;
    const r = maybeNumber(column?.r ?? column?.radius);
    if (r !== null && r > 0) {
      parts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="rgba(148,163,184,0.18)" stroke="#cbd5e1" stroke-width="${strokeWidth}"/>`);
    } else {
      const w = Math.max(1, asFiniteNumber(column?.width ?? column?.w, 300));
      const h = Math.max(1, asFiniteNumber(column?.height ?? column?.h, w));
      parts.push(`<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" fill="rgba(148,163,184,0.18)" stroke="#cbd5e1" stroke-width="${strokeWidth}"/>`);
    }
  }

  for (const windowItem of windows.slice(0, 160)) {
    let x1 = maybeNumber(windowItem?.x1 ?? windowItem?.from?.x);
    let y1 = maybeNumber(windowItem?.y1 ?? windowItem?.from?.y);
    let x2 = maybeNumber(windowItem?.x2 ?? windowItem?.to?.x);
    let y2 = maybeNumber(windowItem?.y2 ?? windowItem?.to?.y);
    const winWidth = Math.max(1, asFiniteNumber(windowItem?.width ?? windowItem?.w, Math.max(strokeWidth * 8, 120)));
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
    parts.push(svgLine(x1 + nx, y1 + ny, x2 + nx, y2 + ny, '#60a5fa', strokeWidth));
    parts.push(svgLine(x1, y1, x2, y2, '#93c5fd', strokeWidth));
    parts.push(svgLine(x1 - nx, y1 - ny, x2 - nx, y2 - ny, '#60a5fa', strokeWidth));
  }

  for (const door of doors.slice(0, 160)) {
    const hingeX = maybeNumber(door?.hingeX ?? door?.x ?? door?.x1);
    const hingeY = maybeNumber(door?.hingeY ?? door?.y ?? door?.y1);
    if (hingeX === null || hingeY === null) continue;
    const doorWidth = Math.max(1, asFiniteNumber(door?.width ?? door?.w, 900));
    const angle = orientationToDegrees(door?.angle ?? door?.orientation, 0);
    const swingRaw = String(door?.swing || door?.hand || '').toLowerCase();
    const sign = /left|ccw|out|\u5de6|\u5916/.test(swingRaw) ? 1 : -1;
    const leafX = maybeNumber(door?.leafX) ?? hingeX + Math.cos(angle * Math.PI / 180) * doorWidth;
    const leafY = maybeNumber(door?.leafY) ?? hingeY + Math.sin(angle * Math.PI / 180) * doorWidth;
    parts.push(svgLine(hingeX, hingeY, leafX, leafY, '#34d399', strokeWidth * 1.2));
    const sweep = sign > 0 ? 0 : 1;
    const endAngle = (angle + sign * Math.max(20, Math.min(135, asFiniteNumber(door?.openAngle, 90)))) * Math.PI / 180;
    const arcX = hingeX + Math.cos(endAngle) * doorWidth;
    const arcY = hingeY + Math.sin(endAngle) * doorWidth;
    parts.push(`<path d="M ${leafX} ${leafY} A ${doorWidth} ${doorWidth} 0 0 ${sweep} ${arcX} ${arcY}" fill="none" stroke="#86efac" stroke-width="${strokeWidth}" stroke-dasharray="${strokeWidth * 4},${strokeWidth * 3}"/>`);
  }

  for (const item of furniture.slice(0, 240)) {
    const x = maybeNumber(item?.x);
    const y = maybeNumber(item?.y);
    if (x === null || y === null) continue;
    const r = maybeNumber(item?.r ?? item?.radius);
    if (r !== null && r > 0) {
      parts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="rgba(251,191,36,0.08)" stroke="#fde68a" stroke-width="${strokeWidth}"/>`);
    } else {
      const w = Math.max(1, asFiniteNumber(item?.width ?? item?.w, 800));
      const h = Math.max(1, asFiniteNumber(item?.height ?? item?.h, 600));
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(251,191,36,0.08)" stroke="#fde68a" stroke-width="${strokeWidth}"/>`);
    }
    if (item?.label || item?.name || item?.type) {
      parts.push(svgText(x + 60, y + 220, item.label || item.name || item.type, Math.max(140, textSize * 0.65), '#fef3c7'));
    }
  }

  for (const dimension of dimensions.slice(0, 240)) {
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
    const nx = (-dy / len) * offset;
    const ny = (dx / len) * offset;
    const ax = x1 + nx;
    const ay = y1 + ny;
    const bx = x2 + nx;
    const by = y2 + ny;
    parts.push(svgLine(x1, y1, ax, ay, '#a78bfa', strokeWidth * 0.8));
    parts.push(svgLine(x2, y2, bx, by, '#a78bfa', strokeWidth * 0.8));
    parts.push(svgLine(ax, ay, bx, by, '#a78bfa', strokeWidth, `${strokeWidth * 4},${strokeWidth * 3}`));
    parts.push(svgText((ax + bx) / 2, (ay + by) / 2, dimension?.text || dimension?.label || Math.round(len), asFiniteNumber(dimension?.textHeight, 180), '#ddd6fe'));
  }

  for (const label of labels.slice(0, 160)) {
    const x = Number(label?.x);
    const y = Number(label?.y);
    const text = String(label?.text || label?.name || '').trim();
    if (Number.isFinite(x) && Number.isFinite(y) && text) {
      parts.push(svgText(x, y, text, Number(label?.height) || textSize, '#e5e7eb'));
    }
  }

  if (args.titleBlock !== false) {
    const unit = String(args.unit || 'unit');
    const note = String(args.precisionNote || args.note || 'Draft generated by Lumi. Verify site dimensions before production.').slice(0, 120);
    const blockW = Math.max(1800, width * 0.28);
    const blockH = Math.max(900, height * 0.12);
    const x = Math.max(0, width - blockW);
    const y = Math.max(0, height + Math.max(400, blockH * 0.2));
    parts.push(`<rect x="${x}" y="${y}" width="${blockW}" height="${blockH}" fill="rgba(15,23,42,0.78)" stroke="#64748b" stroke-width="${strokeWidth}"/>`);
    parts.push(svgText(x + 120, y + blockH - 220, title, 220, '#dbeafe'));
    parts.push(svgText(x + 120, y + blockH - 500, `Unit: ${unit}`, 160, '#cbd5e1'));
    parts.push(svgText(x + 120, y + blockH - 760, note, 140, '#94a3b8'));
  }

  if (args.northArrow) {
    const x = asFiniteNumber(args.northArrow?.x, width - 700);
    const y = asFiniteNumber(args.northArrow?.y, 700);
    parts.push(svgLine(x, y, x, y + 500, '#f8fafc', strokeWidth));
    parts.push(svgLine(x, y + 500, x - 120, y + 330, '#f8fafc', strokeWidth));
    parts.push(svgLine(x, y + 500, x + 120, y + 330, '#f8fafc', strokeWidth));
    parts.push(svgText(x + 80, y + 520, 'N', 180, '#f8fafc'));
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

export function registerExternalAppTools(registry: ToolRegistry): void {
  registry.register({
    name: 'external_app_list_adapters',
    description: 'List Lumi external app adapters and their safety policies for browser, messaging, CAD, and other AI apps.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async (_args, context) => {
      const userId = context?.userId || 'anonymous';
      const adapterRegistry = getAdapterRegistry({ userId, clientState: getClientState(userId) as Record<string, any> | null });
      return JSON.stringify({
        externalAppAutomationEnabled: isExternalAppAutomationAllowed(),
        messagingSendRequiresConfirmation: isMessagingSendConfirmationRequired(),
        adapters: getExternalAppAdapters(),
        adapterRegistrySummary: adapterRegistry.summary,
        adapterRegistry: adapterRegistry.adapters.filter(adapter => ['web', 'messaging', 'cad_bim', 'ai', 'automation'].includes(adapter.category)),
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'browser_open_task',
    description: 'Prepare or open a browser task. By default returns the target URL without opening it; set open=true only when the user wants the browser opened.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open. If omitted, query is converted to a Bing search URL.' },
        query: { type: 'string', description: 'Search query when no URL is provided.' },
        open: { type: 'boolean', description: 'Open the URL in the desktop browser. Requires external app automation.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const target = normalizeUrl(args);
      if (!args.open) {
        return JSON.stringify({ target, opened: false, note: 'Set open=true after user confirmation to open the browser.' }, null, 2);
      }
      requireExternalAutomation();
      const desktopRelay = requireDesktopRelay(context);
      const result = await desktopRelay('desktop_open', { target });
      return JSON.stringify({ target, opened: true, result }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'wechat_prepare_reply',
    description: 'Prepare a WeChat or messaging reply draft. This tool never sends messages.',
    parameters: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Recipient name or group name.' },
        context: { type: 'string', description: 'Relevant message context from the user.' },
        intent: { type: 'string', description: 'What the reply should accomplish.' },
        tone: { type: 'string', description: 'Tone, e.g. concise, warm, formal, apologetic.' },
        draft: { type: 'string', description: 'Use this exact draft if already written.' },
      },
      required: [],
    },
    handler: async (args) => JSON.stringify({
      draft: buildMessageDraft(args),
      sendAllowed: false,
      note: 'Lumi prepared a draft only. Sending stays user-confirmed.',
    }, null, 2),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'wechat_intake_analyze',
    description: 'Analyze a WeChat/message intake for current-stage work takeover: classify customer/store/account/case/video/design work, extract amounts/deadlines/people, propose next actions, and draft a reply. This never sends messages.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The WeChat/message content to analyze.' },
        contact: { type: 'string', description: 'Optional sender/contact/group name.' },
        source: { type: 'string', description: 'Source label such as manual, clipboard, selected_text, or wechat.' },
        takeoverMode: { type: 'string', description: 'Optional forced category: customer, store, account, legal_case, video_publish, design_delivery, general_work, personal, auto.' },
        userRules: { type: 'string', description: 'Optional user work rules or boundaries to apply.' },
      },
      required: ['message'],
    },
    handler: async (args) => JSON.stringify(analyzeWechatIntake({
      message: String(args.message || ''),
      contact: args.contact ? String(args.contact) : undefined,
      source: args.source ? String(args.source) : 'manual',
      takeoverMode: args.takeoverMode ? String(args.takeoverMode) as any : 'auto',
      userRules: args.userRules ? String(args.userRules) : undefined,
    }), null, 2),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'wechat_intake_from_clipboard',
    description: 'Read the current clipboard as a WeChat/message intake and analyze it for work takeover. This never sends messages or writes clipboard.',
    parameters: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Optional sender/contact/group name.' },
        takeoverMode: { type: 'string', description: 'Optional forced category: customer, store, account, legal_case, video_publish, design_delivery, general_work, personal, auto.' },
        userRules: { type: 'string', description: 'Optional user work rules or boundaries to apply.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const desktopRelay = requireDesktopRelay(context);
      const clipboardText = String(await desktopRelay('desktop_clipboard_read', {}) || '').trim();
      if (!clipboardText) {
        throw new Error('Clipboard is empty. Copy the WeChat message text first, or pass message to wechat_intake_analyze.');
      }
      return JSON.stringify(analyzeWechatIntake({
        message: clipboardText,
        contact: args.contact ? String(args.contact) : undefined,
        source: 'clipboard',
        takeoverMode: args.takeoverMode ? String(args.takeoverMode) as any : 'auto',
        userRules: args.userRules ? String(args.userRules) : undefined,
      }), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'wechat_copy_reply_draft',
    description: 'Copy a prepared WeChat/messaging reply draft to clipboard and optionally open WeChat. This never presses Send.',
    parameters: {
      type: 'object',
      properties: {
        draft: { type: 'string', description: 'Reply draft to copy.' },
        openWechat: { type: 'boolean', description: 'Open WeChat after copying the draft.' },
        applicationTarget: { type: 'string', description: 'Optional app target, default wechat.exe.' },
      },
      required: ['draft'],
    },
    handler: async (args, context) => {
      requireExternalAutomation();
      const draft = String(args.draft || '').trim();
      if (!draft) throw new Error('Draft is required.');
      const desktopRelay = requireDesktopRelay(context);
      const copied = await desktopRelay('desktop_clipboard_write', { text: draft });
      let opened: string | undefined;
      if (args.openWechat) {
        opened = await desktopRelay('desktop_open', { target: args.applicationTarget || 'wechat.exe' });
      }
      return JSON.stringify({
        copied: true,
        clipboardResult: copied,
        opened: Boolean(args.openWechat),
        openResult: opened,
        sendAllowed: !isMessagingSendConfirmationRequired(),
        note: 'The draft is ready on the clipboard. Lumi did not send the message.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'cad_generate_dxf',
    description: 'Generate a structured CAD DXF drafting handoff with outline, wall thickness, rooms, polylines, doors, windows, columns, furniture, dimension lines, labels, holes, preview SVG, and optional explicit output path. For image-based floor plans, call floorplan_extract_geometry or ocr_image_file first, then pass the extracted geometry here. Use this as a calibrated drafting base, not final engineering verification. If exact dimensions are missing, say so instead of claiming production accuracy.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Drawing title / output filename.' },
        width: { type: 'number', description: 'Outer width in chosen units.' },
        height: { type: 'number', description: 'Outer height in chosen units.' },
        unit: { type: 'string', description: 'Unit label, e.g. mm, cm, inch.' },
        cornerRadius: { type: 'number', description: 'Optional rounded corner radius.' },
        wallThickness: { type: 'number', description: 'Default wall thickness for wall segments when individual wall.thickness is omitted.' },
        precisionNote: { type: 'string', description: 'Short note about source accuracy, scale assumptions, or missing dimensions.' },
        northArrow: { type: 'object', description: 'Optional north arrow position, e.g. {x,y}. Set true/object when orientation is known.' },
        titleBlock: { type: 'boolean', description: 'Whether to include a title block. Defaults to true.' },
        outputDirectory: { type: 'string', description: 'Optional directory to save the DXF, e.g. C:\\Users\\name\\Desktop. Use when the user asks to put the file somewhere visible.' },
        outputPath: { type: 'string', description: 'Optional exact DXF output path. Relative paths are resolved under outputDirectory or Lumi CAD data directory.' },
        sourcePath: { type: 'string', description: 'Optional source drawing/image path used for traceability.' },
        walls: {
          type: 'array',
          description: 'Optional CAD wall/line segments: {x1,y1,x2,y2,thickness,layer}. Use floor plan units such as mm.',
          items: { type: 'object' },
        },
        polylines: {
          type: 'array',
          description: 'Optional open/closed polylines: {points:[{x,y}],closed,layer}. Useful for irregular boundaries.',
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
        openPreview: { type: 'boolean', description: 'Open the generated DXF with the system default app. Requires external app automation.' },
      },
      required: ['width', 'height'],
    },
    handler: async (args, context) => {
      const title = safeFileName(String(args.title || 'lumi_cad_draft'));
      const outPath = resolveCadOutputPath(args, title);
      fs.writeFileSync(outPath, buildDxf(args), 'utf-8');
      const previewSvg = buildCadPreviewSvg(args, title);
      const previewPath = getCadPreviewPath(outPath);
      fs.writeFileSync(previewPath, previewSvg, 'utf-8');
      const stat = fs.statSync(outPath);
      const previewStat = fs.statSync(previewPath);

      let openResult: string | undefined;
      if (args.openPreview) {
        requireExternalAutomation();
        const desktopRelay = requireDesktopRelay(context);
        openResult = await desktopRelay('desktop_open', { target: outPath });
      }

      return JSON.stringify({
        path: outPath,
        previewPath,
        previewSvg,
        title,
        unit: args.unit || 'unit',
        width: Number(args.width) || 100,
        height: Number(args.height) || 60,
        sourcePath: args.sourcePath || undefined,
        outputDirectory: path.dirname(outPath),
        exists: fs.existsSync(outPath),
        size: stat.size,
        previewExists: fs.existsSync(previewPath),
        previewSize: previewStat.size,
        artifacts: [
          { type: 'dxf', path: outPath },
          { type: 'svg_preview', path: previewPath },
        ],
        walls: Array.isArray(args.walls) ? args.walls.length : Array.isArray(args.lines) ? args.lines.length : 0,
        rooms: Array.isArray(args.rooms) ? args.rooms.length : 0,
        doors: Array.isArray(args.doors) ? args.doors.length : 0,
        windows: Array.isArray(args.windows) ? args.windows.length : 0,
        dimensions: Array.isArray(args.dimensions) ? args.dimensions.length : 0,
        furniture: Array.isArray(args.furniture) ? args.furniture.length : 0,
        columns: Array.isArray(args.columns) ? args.columns.length : 0,
        polylines: Array.isArray(args.polylines) ? args.polylines.length : 0,
        labels: Array.isArray(args.labels) ? args.labels.length : 0,
        holes: Array.isArray(args.holes) ? args.holes.length : 0,
        opened: Boolean(args.openPreview),
        openResult,
        note: 'Generated and verified a structured DXF drafting file. If source dimensions were inferred from an image, review scale, wall thickness, and tolerances before production use.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });
}
