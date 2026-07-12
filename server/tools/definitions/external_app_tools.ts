import fs from 'fs';
import os from 'os';
import path from 'path';
import { ToolRegistry } from '../registry';
import { ToolContext } from '../types';
import { getDataPath } from '../../config/data_path';
import { getExternalAppAdapters } from '../../external_apps/adapters';
import { getAdapterRegistry } from '../../adapters/registry';
import { getClientStateForScope } from '../../client/self_model';
import { isMessagingSendConfirmationRequired } from '../../autonomy/safety_gate';
import { analyzeWechatIntake } from '../../work_takeover/wechat_intake';
import { analyzeScreen } from '../../llm/adapter';
import { getUserPreferredVisionConfig, type VisionProvider } from '../../llm/vision_preferences';
import { captureWindowsUiSnapshot } from '../../external_control/windows_uia';
import { getMember, logAudit } from '../../org/db';
import {
  sendLocalFileToPersonalWeChat,
  WeChatFileApiUnavailableError,
} from '../../messaging/file_transfer';

function requireDesktopRelay(context?: ToolContext) {
  if (!context?.desktopRelay) {
    throw new Error('External app actions require the Lumi desktop client relay.');
  }
  return context.desktopRelay;
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

  const context = String(args.context || '').trim();
  const intent = String(args.intent || '').trim();
  const tone = String(args.tone || 'warm and concise').trim();
  const source = `${intent}\n${context}`;
  const formal = /formal|\u6b63\u5f0f|\u5ba2\u6c14|\u793c\u8c8c/i.test(tone);
  const concise = /concise|\u7b80\u77ed|\u7b80\u6d01/i.test(tone);

  if (/(?:\u665a\u5b89|\u65e9\u70b9\u4f11\u606f|\bgood\s*night\b)/i.test(source)) {
    return formal
      ? '\u665a\u5b89\uff0c\u795d\u60a8\u4eca\u665a\u597d\u597d\u4f11\u606f\u3002'
      : '\u665a\u5b89\uff0c\u65e9\u70b9\u4f11\u606f\u3002';
  }

  if (/(?:\u8c22\u8c22|\u611f\u8c22|\bthanks?\b)/i.test(source)) {
    return formal
      ? '\u6536\u5230\uff0c\u8c22\u8c22\u60a8\uff0c\u6211\u4f1a\u5c3d\u5feb\u5904\u7406\u5e76\u540c\u6b65\u8fdb\u5c55\u3002'
      : '\u6536\u5230\uff0c\u8c22\u8c22\uff0c\u6211\u5148\u5904\u7406\uff0c\u6709\u8fdb\u5c55\u9a6c\u4e0a\u540c\u6b65\u3002';
  }

  const topic = (context || intent)
    .replace(/\s+/g, ' ')
    .replace(/(?:\u5f53\u524d\u662f\u538b\u6d4b|\u4e0d\u8981\u5b9e\u9645\u53d1\u9001)[^。.!?\n]*/gu, '')
    .trim()
    .slice(0, concise ? 80 : 140);

  if (topic) {
    return formal
      ? `\u60a8\u597d\uff0c\u5173\u4e8e\u201c${topic}\u201d\uff0c\u6211\u5df2\u6536\u5230\uff0c\u4f1a\u5c3d\u5feb\u5904\u7406\u5e76\u540c\u6b65\u8fdb\u5c55\u3002`
      : `\u6536\u5230\uff0c\u5173\u4e8e\u201c${topic}\u201d\uff0c\u6211\u5148\u5904\u7406\uff0c\u6709\u8fdb\u5c55\u9a6c\u4e0a\u540c\u6b65\u3002`;
  }

  return formal
    ? '\u60a8\u597d\uff0c\u6211\u5df2\u6536\u5230\uff0c\u4f1a\u5c3d\u5feb\u5904\u7406\u5e76\u540c\u6b65\u8fdb\u5c55\u3002'
    : '\u6536\u5230\uff0c\u6211\u5148\u5904\u7406\uff0c\u6709\u8fdb\u5c55\u9a6c\u4e0a\u540c\u6b65\u3002';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDesktopJson(raw: string): Record<string, any> {
  try {
    return JSON.parse(String(raw || '{}'));
  } catch {
    return {};
  }
}

function isWeChatActiveWindow(info: Record<string, any>): boolean {
  const processName = String(info.process_name || info.processName || '').toLowerCase();
  const title = String(info.title || '').toLowerCase();
  return processName === 'weixin.exe' ||
    processName === 'wechat.exe' ||
    title.includes('wechat') ||
    title.includes('\u5fae\u4fe1');
}

function hasVisionProvider(context?: ToolContext): { provider: VisionProvider; model: string; userId: string; maxTokens?: number } | null {
  const userId = context?.userId || 'anonymous';
  const config = getUserPreferredVisionConfig(userId, { maxTokens: 1200 });
  const getters = context?.llmGetters;
  if (!getters) return null;
  const available = (
    (config.provider === 'openai' && getters.getOpenAI?.()) ||
    (config.provider === 'gemini' && getters.getGemini?.()) ||
    (config.provider === 'ark' && getters.getArk?.()) ||
    (config.provider === 'qwen' && getters.getQwen?.()) ||
    (config.provider === 'ollama' && getters.getOllama?.()) ||
    (config.provider === 'lmstudio' && getters.getLmStudio?.()) ||
    (config.provider === 'relay' && getters.getRelay?.())
  );
  return available ? config : null;
}

function compactEvidenceText(value: string, limit = 2400): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.floor(limit * 0.7))}\n...\n${text.slice(-Math.floor(limit * 0.25))}`;
}

function hasReadableUiEvidence(snapshotText: string): boolean {
  if (!snapshotText || /^UI snapshot unavailable/i.test(snapshotText)) return false;
  const withoutUiBoilerplate = snapshotText.replace(
    /\b(?:window|text|edit|button|pane|group|document|control|name|role|automationid|classname|bounds)\b/gi,
    ' ',
  );
  const readableChars = withoutUiBoilerplate.match(/[\u4e00-\u9fffA-Za-z0-9]/gu) || [];
  return readableChars.length >= 12;
}

function normalizeEvidenceText(value: unknown): string {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function snapshotContainsNewMessage(before: string, after: string, message: string): boolean {
  const target = normalizeEvidenceText(message);
  if (target.length < 1) return false;
  const beforeText = normalizeEvidenceText(before);
  const afterText = normalizeEvidenceText(after);
  return !beforeText.includes(target) && afterText.includes(target);
}

async function captureDesktopUiEvidence(
  desktopRelay: NonNullable<ToolContext['desktopRelay']>,
  maxNodes: number,
): Promise<string> {
  try {
    const relayed = await desktopRelay('desktop_ui_snapshot', { maxDepth: 5, maxNodes });
    if (String(relayed || '').trim()) return String(relayed);
  } catch {
    // Older desktop clients do not expose UIA through the relay. The local
    // backend remains a compatible fallback for the on-device deployment.
  }
  return JSON.stringify(await captureWindowsUiSnapshot({ maxDepth: 5, maxNodes }), null, 2);
}

export function parseWeChatSendVisionVerification(value: unknown): {
  sent: boolean;
  confidence: number;
  reason: string;
} {
  const raw = String(value || '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { sent: false, confidence: 0, reason: raw.slice(0, 240) || 'No verification result.' };
  try {
    const parsed = JSON.parse(match[0]);
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0)));
    return {
      sent: parsed.sent === true && confidence >= 0.65,
      confidence,
      reason: String(parsed.reason || '').trim().slice(0, 400),
    };
  } catch {
    return { sent: false, confidence: 0, reason: raw.slice(0, 240) || 'Invalid verification result.' };
  }
}

function firstFiniteNumber(...values: any[]): number | null {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function virtualInputPoint(activeWindow: Record<string, any>): { x: number; y: number } {
  const bounds = activeWindow.bounds || activeWindow.rect || activeWindow.windowBounds || {};
  const x = firstFiniteNumber(activeWindow.x, activeWindow.left, bounds.x, bounds.left, 0) ?? 0;
  const y = firstFiniteNumber(activeWindow.y, activeWindow.top, bounds.y, bounds.top, 0) ?? 0;
  const right = firstFiniteNumber(activeWindow.right, bounds.right);
  const bottom = firstFiniteNumber(activeWindow.bottom, bounds.bottom);
  const width = Math.max(320, firstFiniteNumber(activeWindow.width, bounds.width, right !== null ? right - x : null, 0) ?? 0);
  const height = Math.max(320, firstFiniteNumber(activeWindow.height, bounds.height, bottom !== null ? bottom - y : null, 0) ?? 0);
  if (x < -10000 || y < -10000) {
    throw new Error('WeChat window is still minimized or offscreen after opening; cannot safely click the input area.');
  }
  return {
    x: Math.round(x + width * 0.58),
    y: Math.round(y + height - Math.min(96, Math.max(72, height * 0.14))),
  };
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

type AutocadDrawOperation =
  | { kind: 'line'; layer: string; x1: number; y1: number; x2: number; y2: number; label?: string }
  | { kind: 'circle'; layer: string; x: number; y: number; r: number; label?: string }
  | { kind: 'arc'; layer: string; cx: number; cy: number; r: number; start: number; end: number; label?: string }
  | { kind: 'text'; layer: string; x: number; y: number; text: string; height: number; label?: string };

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

function cadNumber(value: number): string {
  const fixed = Number(value).toFixed(3).replace(/\.?0+$/g, '');
  return fixed === '-0' ? '0' : fixed;
}

function lispString(value: any): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ')
    .slice(0, 180);
}

function lispPoint(x: number, y: number): string {
  return `(list ${cadNumber(x)} ${cadNumber(y)} 0.0)`;
}

function pushLineOp(ops: AutocadDrawOperation[], layer: string, x1: any, y1: any, x2: any, y2: any, label?: string) {
  const a = maybeNumber(x1);
  const b = maybeNumber(y1);
  const c = maybeNumber(x2);
  const d = maybeNumber(y2);
  if (a === null || b === null || c === null || d === null || (a === c && b === d)) return;
  ops.push({ kind: 'line', layer: safeLayer(layer, 'CUT'), x1: a, y1: b, x2: c, y2: d, label });
}

function pushRectOps(ops: AutocadDrawOperation[], x: number, y: number, width: number, height: number, layer = 'CUT', label?: string) {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
  pushLineOp(ops, layer, x, y, x + width, y, label);
  pushLineOp(ops, layer, x + width, y, x + width, y + height, label);
  pushLineOp(ops, layer, x + width, y + height, x, y + height, label);
  pushLineOp(ops, layer, x, y + height, x, y, label);
}

function pushPolylineOps(ops: AutocadDrawOperation[], points: Array<{ x: number; y: number }>, layer = 'POLYLINE', closed = false, label?: string) {
  if (points.length < 2) return;
  for (let i = 0; i < points.length - 1; i++) {
    pushLineOp(ops, layer, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, label);
  }
  if (closed) {
    const first = points[0];
    const last = points[points.length - 1];
    pushLineOp(ops, layer, last.x, last.y, first.x, first.y, label);
  }
}

function pushWallOps(ops: AutocadDrawOperation[], wall: Record<string, any>, fallbackThickness = 0) {
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

function pushTextOp(ops: AutocadDrawOperation[], x: any, y: any, text: any, height = 220, layer = 'TEXT', label?: string) {
  const px = maybeNumber(x);
  const py = maybeNumber(y);
  const value = String(text || '').trim();
  if (px === null || py === null || !value) return;
  ops.push({ kind: 'text', layer: safeLayer(layer, 'TEXT'), x: px, y: py, text: value, height: Math.max(1, asFiniteNumber(height, 220)), label });
}

function collectAutocadDrawOperations(args: Record<string, any>): AutocadDrawOperation[] {
  const width = Math.max(1, Number(args.width) || 100);
  const height = Math.max(1, Number(args.height) || 60);
  const walls = Array.isArray(args.walls) ? args.walls : Array.isArray(args.lines) ? args.lines : [];
  const rooms = Array.isArray(args.rooms) ? args.rooms : [];
  const labels = Array.isArray(args.labels) ? args.labels : [];
  const doors = Array.isArray(args.doors) ? args.doors : [];
  const windows = Array.isArray(args.windows) ? args.windows : [];
  const dimensions = Array.isArray(args.dimensions) ? args.dimensions : [];
  const furniture = Array.isArray(args.furniture) ? args.furniture : [];
  const columns = Array.isArray(args.columns) ? args.columns : [];
  const polylines = Array.isArray(args.polylines) ? args.polylines : [];
  const holes = Array.isArray(args.holes) ? args.holes : [];
  const wallThickness = asFiniteNumber(args.wallThickness, 0);
  const ops: AutocadDrawOperation[] = [];

  pushRectOps(ops, 0, 0, width, height, 'OUTLINE', 'outline');

  for (const polyline of polylines.slice(0, 240)) {
    const points = pointList(polyline?.points || polyline);
    pushPolylineOps(ops, points, safeLayer(polyline?.layer, 'POLYLINE'), Boolean(polyline?.closed), polyline?.label || 'polyline');
  }

  for (const wall of walls.slice(0, 500)) pushWallOps(ops, wall, wallThickness);

  for (const room of rooms.slice(0, 120)) {
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

  for (const hole of holes.slice(0, 40)) {
    const x = maybeNumber(hole?.x);
    const y = maybeNumber(hole?.y);
    const r = maybeNumber(hole?.r ?? hole?.radius);
    if (x !== null && y !== null && r !== null && r > 0) ops.push({ kind: 'circle', layer: safeLayer(hole?.layer, 'HOLE'), x, y, r, label: hole?.label || 'hole' });
  }

  for (const column of columns.slice(0, 120)) {
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

  for (const windowItem of windows.slice(0, 160)) {
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
    const openAngle = Math.max(20, Math.min(135, asFiniteNumber(door?.openAngle, 90)));
    pushLineOp(ops, safeLayer(door?.layer, 'DOOR'), hingeX, hingeY, leafX, leafY, door?.label || 'door leaf');
    ops.push({
      kind: 'arc',
      layer: safeLayer(door?.swingLayer, 'DOOR_SWING'),
      cx: hingeX,
      cy: hingeY,
      r: doorWidth,
      start: normalizeDegrees(angle),
      end: normalizeDegrees(angle + sign * openAngle),
      label: door?.label || 'door swing',
    });
    pushTextOp(ops, hingeX + 80, hingeY + 80, door?.label || door?.name, door?.textHeight || 180, 'TEXT', 'door label');
  }

  for (const item of furniture.slice(0, 240)) {
    const x = maybeNumber(item?.x);
    const y = maybeNumber(item?.y);
    if (x === null || y === null) continue;
    const r = maybeNumber(item?.r ?? item?.radius);
    const layer = safeLayer(item?.layer, 'FURNITURE');
    if (r !== null && r > 0) ops.push({ kind: 'circle', layer, x, y, r, label: item?.label || item?.type || 'furniture' });
    else pushRectOps(ops, x, y, Math.max(1, asFiniteNumber(item?.width ?? item?.w, 800)), Math.max(1, asFiniteNumber(item?.height ?? item?.h, 600)), layer, item?.label || item?.type || 'furniture');
    pushTextOp(ops, x + 60, y + 220, item?.label || item?.name || item?.type, item?.textHeight || 180, 'TEXT', 'furniture label');
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

  for (const label of labels.slice(0, 160)) {
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

  return ops.slice(0, 2500);
}

function resolveAutocadScriptPaths(args: Record<string, any>, title: string): {
  basePath: string;
  lispPath: string;
  scriptPath: string;
  powershellPath: string;
  markerPath: string;
  manifestPath: string;
} {
  const outputPath = String(args.outputPath || '').trim();
  const outputDirectory = String(args.outputDirectory || '').trim();
  const directory = outputDirectory
    ? path.resolve(expandHomePath(outputDirectory))
    : getDataPath('cad');
  const rawBase = outputPath
    ? (path.isAbsolute(outputPath) ? expandHomePath(outputPath) : path.resolve(directory, outputPath))
    : path.join(directory, `${title}_autocad_draw_${Date.now()}`);
  const basePath = rawBase.replace(/\.(lsp|scr|ps1|dxf)$/i, '');
  for (const filePath of [`${basePath}.lsp`, `${basePath}.scr`, `${basePath}.ps1`, `${basePath}_completed.txt`, `${basePath}_manifest.json`]) {
    assertWritableCadPath(filePath);
  }
  fs.mkdirSync(path.dirname(basePath), { recursive: true });
  return {
    basePath,
    lispPath: `${basePath}.lsp`,
    scriptPath: `${basePath}.scr`,
    powershellPath: `${basePath}_run_autocad.ps1`,
    markerPath: `${basePath}_completed.txt`,
    manifestPath: `${basePath}_manifest.json`,
  };
}

function buildAutocadLisp(args: Record<string, any>, operations: AutocadDrawOperation[], title: string, delayMs: number, markerPath?: string): string {
  const layers = Array.from(new Set(operations.map(op => op.layer))).sort();
  const delay = Math.max(0, Math.min(Number(delayMs) || 0, 5000));
  const layerColor = (layer: string): number => {
    if (/WALL|OUTLINE/i.test(layer)) return 7;
    if (/ROOM/i.test(layer)) return 4;
    if (/DOOR/i.test(layer)) return 3;
    if (/WINDOW/i.test(layer)) return 5;
    if (/DIM/i.test(layer)) return 6;
    if (/TEXT|TITLE|ANNOTATION/i.test(layer)) return 2;
    return 8;
  };
  const lines: string[] = [
    '; Generated by Lumi. Run SCRIPT on the .scr file, or load this LISP and run LUMIDRAW.',
    '; This is a visible drafting playback, not a production drawing certification.',
    '(vl-load-com)',
    '(defun lumi-layer (name color /)',
    '  (if (not (tblsearch "LAYER" name))',
    '    (command "_.-LAYER" "_M" name "_C" (itoa color) name "")',
    '  )',
    '  (setvar "CLAYER" name)',
    ')',
    `(defun lumi-delay () (if (> ${delay} 0) (command "_.DELAY" "${delay}")))`,
    '(defun c:LUMIDRAW (/ oldcmd)',
    '  (setq oldcmd (getvar "CMDECHO"))',
    '  (setvar "CMDECHO" 1)',
    `  (princ "\\nLumi is drawing ${lispString(title)} stroke by stroke...")`,
    ...layers.map(layer => `  (lumi-layer "${lispString(layer)}" ${layerColor(layer)})`),
  ];

  operations.forEach((op, index) => {
    lines.push(`  ; ${index + 1}. ${op.label ? lispString(op.label) : op.kind}`);
    lines.push(`  (lumi-layer "${lispString(op.layer)}" ${layerColor(op.layer)})`);
    if (op.kind === 'line') {
      lines.push(`  (command "_.LINE" ${lispPoint(op.x1, op.y1)} ${lispPoint(op.x2, op.y2)} "")`);
    } else if (op.kind === 'circle') {
      lines.push(`  (command "_.CIRCLE" ${lispPoint(op.x, op.y)} "${cadNumber(op.r)}")`);
    } else if (op.kind === 'arc') {
      const startX = op.cx + Math.cos(op.start * Math.PI / 180) * op.r;
      const startY = op.cy + Math.sin(op.start * Math.PI / 180) * op.r;
      const endX = op.cx + Math.cos(op.end * Math.PI / 180) * op.r;
      const endY = op.cy + Math.sin(op.end * Math.PI / 180) * op.r;
      lines.push(`  (command "_.ARC" "_C" ${lispPoint(op.cx, op.cy)} ${lispPoint(startX, startY)} ${lispPoint(endX, endY)})`);
    } else if (op.kind === 'text') {
      lines.push(`  (command "_.TEXT" ${lispPoint(op.x, op.y)} "${cadNumber(op.height)}" "0" "${lispString(op.text)}")`);
    }
    lines.push('  (lumi-delay)');
  });

  lines.push(
    markerPath
      ? `  (setq lumi-marker (open "${lispString(markerPath.replace(/\\/g, '/'))}" "w"))`
      : '',
    markerPath
      ? `  (if lumi-marker (progn (write-line "completed=${operations.length}" lumi-marker) (write-line "title=${lispString(title)}" lumi-marker) (close lumi-marker)))`
      : '',
    '  (command "_.ZOOM" "_E")',
    '  (setvar "CMDECHO" oldcmd)',
    `  (princ "\\nLumi finished ${operations.length} visible CAD operation(s). Review dimensions before production use.")`,
    '  (princ)',
    ')',
    '(princ "\\nType LUMIDRAW to draw the generated plan stroke by stroke.")',
    '(princ)',
    '',
  );
  return lines.join('\n');
}

function buildAutocadScript(lispPath: string): string {
  const normalized = lispPath.replace(/\\/g, '/');
  return [
    `(load "${normalized}")`,
    'LUMIDRAW',
    '',
  ].join('\n');
}

function buildAutocadRunPowerShell(scriptPath: string, preferredExecutable?: string): string {
  const exe = String(preferredExecutable || 'acad.exe').trim() || 'acad.exe';
  return [
    '$ErrorActionPreference = "Stop"',
    `$scriptPath = ${JSON.stringify(scriptPath)}`,
    `$preferredAcad = ${JSON.stringify(exe)}`,
    '$candidates = @()',
    'if ($preferredAcad) { $candidates += $preferredAcad }',
    '$cmd = Get-Command acad.exe -ErrorAction SilentlyContinue',
    'if ($cmd) { $candidates += $cmd.Source }',
    '$candidates += @(',
    '  "$env:ProgramFiles\\Autodesk\\AutoCAD*\\acad.exe",',
    '  "${env:ProgramFiles(x86)}\\Autodesk\\AutoCAD*\\acad.exe"',
    ')',
    '$acad = $null',
    'foreach ($candidate in $candidates) {',
    '  foreach ($path in (Resolve-Path $candidate -ErrorAction SilentlyContinue)) {',
    '    if (Test-Path $path.Path) { $acad = $path.Path; break }',
    '  }',
    '  if ($acad) { break }',
    '}',
    'if (-not $acad) { throw "AutoCAD acad.exe was not found. Pass autocadExecutable or install AutoCAD." }',
    'Start-Process -FilePath $acad -ArgumentList @("/b", $scriptPath)',
    'Write-Output "started=$acad script=$scriptPath"',
    '',
  ].join('\n');
}

function autocadRunnerPathForScript(scriptPath: string): string {
  return scriptPath.replace(/\.(scr|lsp)$/i, '') + '_run_autocad.ps1';
}

function autocadMarkerPathForScript(scriptPath: string): string {
  return scriptPath.replace(/\.(scr|lsp)$/i, '') + '_completed.txt';
}

function autocadManifestPathForScript(scriptPath: string): string {
  return scriptPath.replace(/\.(scr|lsp)$/i, '') + '_manifest.json';
}

function readAutocadManifest(scriptPath: string): Record<string, any> | null {
  try {
    const manifestPath = autocadManifestPathForScript(scriptPath);
    if (!fs.existsSync(manifestPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function waitForFile(filePath: string, waitSeconds: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, Math.min(waitSeconds, 300)) * 1000;
  while (Date.now() <= deadline) {
    if (fs.existsSync(filePath)) return true;
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  return fs.existsSync(filePath);
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
      const adapterRegistry = getAdapterRegistry({
        userId,
        clientState: getClientStateForScope(userId, { domain: context?.domain, orgId: context?.orgId }) as Record<string, any> | null,
      });
      return JSON.stringify({
        externalAppAutomationGate: 'removed',
        messagingSendRequiresConfirmation: isMessagingSendConfirmationRequired(userId),
        adapters: getExternalAppAdapters(),
        adapterRegistrySummary: adapterRegistry.summary,
        adapterRegistry: adapterRegistry.adapters.filter(adapter => ['web', 'finance', 'messaging', 'cad_bim', 'ai', 'automation'].includes(adapter.category)),
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
        open: { type: 'boolean', description: 'Open the URL in the desktop browser. High-risk submits, payments, publishing, and account transitions still require confirmation.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const target = normalizeUrl(args);
      if (!args.open) {
        return JSON.stringify({ target, opened: false, note: 'Set open=true to open the browser when the user wants visible browser work.' }, null, 2);
      }
      const desktopRelay = requireDesktopRelay(context);
      const result = await desktopRelay('desktop_open', { target });
      return JSON.stringify({ target, opened: true, result }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
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
        openWechat: { type: 'boolean', description: 'Open WeChat after copying the draft. This does not send; sending remains confirmation-gated.' },
        applicationTarget: { type: 'string', description: 'Optional app target, default wechat.exe.' },
      },
      required: ['draft'],
    },
    handler: async (args, context) => {
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
        sendAllowed: !isMessagingSendConfirmationRequired(context?.userId),
        note: 'The draft is ready on the clipboard. Lumi did not send the message.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'wechat_read_recent_chat',
    description: 'Read the currently visible recent messages from the real foreground WeChat client. It reuses an already-running WeChat window when possible, optionally selects a contact through WeChat search, captures UI/screen evidence, and uses the configured vision model when available. It never sends messages.',
    parameters: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Contact or group name to select in WeChat. Omit to inspect the current chat.' },
        applicationTarget: { type: 'string', description: 'Desktop app target. Defaults to wechat.' },
        useSearch: { type: 'boolean', description: 'Use WeChat search to select contact before reading. Defaults true when contact is provided.' },
        maxMessages: { type: 'number', description: 'Approximate number of recent visible messages to summarize. Defaults 8.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const desktopRelay = requireDesktopRelay(context);
      const progress = (step: string) => context?.onProgress?.(step);
      const contact = String(args.contact || '').trim();
      const appTarget = String(args.applicationTarget || 'wechat').trim() || 'wechat';
      const useSearch = args.useSearch !== false && Boolean(contact);
      const maxMessages = Math.max(3, Math.min(Number(args.maxMessages || 8), 20));

      progress('\u6b63\u5728\u590d\u7528\u5df2\u8fd0\u884c\u7684\u5fae\u4fe1\u7a97\u53e3\u3002');
      const openResult = await desktopRelay('desktop_open', { target: appTarget });
      await sleep(450);

      let activeWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
      if (!isWeChatActiveWindow(activeWindow)) {
        await sleep(600);
        activeWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
      }
      if (!isWeChatActiveWindow(activeWindow)) {
        throw new Error(`WeChat is not the foreground window after opening. Active window: ${JSON.stringify(activeWindow).slice(0, 300)}`);
      }

      if (useSearch) {
        progress(`\u6b63\u5728\u5fae\u4fe1\u91cc\u5b9a\u4f4d\u804a\u5929: ${contact}`);
        await desktopRelay('desktop_clipboard_write', { text: contact });
        await desktopRelay('desktop_keyboard_press', { key: 'ctrl+f' });
        await sleep(250);
        await desktopRelay('desktop_keyboard_press', { key: 'ctrl+v' });
        await sleep(450);
        await desktopRelay('desktop_keyboard_press', { key: 'enter' });
        await sleep(750);
        activeWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
        if (!isWeChatActiveWindow(activeWindow)) {
          throw new Error(`Contact search did not leave WeChat in the foreground. Active window: ${JSON.stringify(activeWindow).slice(0, 300)}`);
        }
      }

      progress('\u6b63\u5728\u8bfb\u53d6\u5fae\u4fe1\u804a\u5929\u53ef\u89c1\u5185\u5bb9\u3002');
      let uiSnapshot = '';
      try {
        uiSnapshot = await captureDesktopUiEvidence(desktopRelay, 180);
      } catch (err: any) {
        uiSnapshot = `UI snapshot unavailable: ${err?.message || String(err)}`;
      }

      const screenCapture = await desktopRelay('desktop_capture_screen', { quality: 65 });
      let contentSummary = '';
      let visionError = '';
      const visionConfig = hasVisionProvider(context);
      if (visionConfig) {
        const getters = context?.llmGetters;
        const query = [
          contact
            ? `This is a WeChat conversation window. The target contact/group is "${contact}".`
            : 'This is a WeChat conversation window.',
          `Read the most recent ${maxMessages} visible chat messages. Return the visible speaker/message content and a concise Chinese summary.`,
          'Do not infer hidden messages. If the screenshot is not a chat window or text is unreadable, say that clearly.',
        ].join('\n');
        try {
          contentSummary = await analyzeScreen(
            screenCapture,
            query,
            visionConfig,
            getters?.getDeepSeek,
            getters?.getGemini,
            getters?.getOpenAI,
            getters?.getAnthropic,
            getters?.getQwen,
            getters?.getOllama,
            getters?.getLmStudio,
            getters?.getArk,
            getters?.getXiaomi,
            getters?.getKimi,
            getters?.getGlm,
            getters?.getRelay,
          );
        } catch (err: any) {
          visionError = err?.message || String(err);
        }
      } else {
        visionError = 'No configured vision provider is available for reading chat text from the screenshot.';
      }

      const snapshotText = compactEvidenceText(uiSnapshot, 1800);
      const hasUsefulSnapshot = hasReadableUiEvidence(snapshotText);
      const read = Boolean(contentSummary.trim()) || hasUsefulSnapshot;

      return JSON.stringify({
        read,
        contact: contact || null,
        usedContactSearch: useSearch,
        method: contentSummary.trim() ? 'foreground_wechat_search_screenshot_vision' : 'foreground_wechat_search_ui_snapshot',
        openResult,
        activeWindow,
        contentSummary: contentSummary.trim() || null,
        uiSnapshotPreview: snapshotText || null,
        screenCaptured: Boolean(screenCapture),
        visionProvider: visionConfig?.provider || null,
        visionError: visionError || null,
        note: read
          ? 'Visible WeChat chat evidence was captured and read from the foreground window.'
          : 'WeChat was opened/focused, but no readable chat content evidence was extracted.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'wechat_send_message',
    description: 'Send an ordinary user-requested foreground WeChat message through the real desktop client. It reuses an already-running WeChat window when possible, optionally selects a contact through WeChat search, focuses the input area with the virtual cursor click path, pastes the message, presses the configured send shortcut, and verifies the foreground WeChat window. Use only for low-risk social/content messages requested by the present user; QR/login/account switching, payments, legal/contractual commits, and ambiguous high-consequence sends still require handoff or confirmation.',
    parameters: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Recipient or group name to select in WeChat. Omit to use the current chat.' },
        message: { type: 'string', description: 'Exact message text to send.' },
        draft: { type: 'string', description: 'Alias for message when a previous draft is available.' },
        applicationTarget: { type: 'string', description: 'Desktop app target. Defaults to wechat.' },
        useSearch: { type: 'boolean', description: 'Use WeChat search to select contact before sending. Defaults true when contact is provided.' },
        sendShortcut: { type: 'string', description: 'Key shortcut to send, usually enter or ctrl+enter. Defaults enter.' },
        useVirtualCursor: { type: 'boolean', description: 'Click the message input area through the independent virtual cursor path. Defaults true.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const message = String(args.message || args.draft || '').trim();
      if (!message) throw new Error('Message text is required.');

      const desktopRelay = requireDesktopRelay(context);
      const progress = (step: string) => context?.onProgress?.(step);
      const contact = String(args.contact || '').trim();
      const appTarget = String(args.applicationTarget || 'wechat').trim() || 'wechat';
      const useSearch = args.useSearch !== false && Boolean(contact);
      const sendShortcut = String(args.sendShortcut || 'enter').trim() || 'enter';
      const useVirtualCursor = args.useVirtualCursor !== false;

      progress('\u6b63\u5728\u590d\u7528\u5df2\u8fd0\u884c\u7684\u5fae\u4fe1\u7a97\u53e3\u3002');
      const openResult = await desktopRelay('desktop_open', { target: appTarget });
      await sleep(450);

      let activeWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
      if (!isWeChatActiveWindow(activeWindow)) {
        await sleep(600);
        activeWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
      }
      if (!isWeChatActiveWindow(activeWindow)) {
        throw new Error(`WeChat is not the foreground window after opening. Active window: ${JSON.stringify(activeWindow).slice(0, 300)}`);
      }

      if (useSearch) {
        progress(`\u6b63\u5728\u5fae\u4fe1\u91cc\u5b9a\u4f4d\u8054\u7cfb\u4eba: ${contact}`);
        await desktopRelay('desktop_clipboard_write', { text: contact });
        await desktopRelay('desktop_keyboard_press', { key: 'ctrl+f' });
        await sleep(250);
        await desktopRelay('desktop_keyboard_press', { key: 'ctrl+v' });
        await sleep(450);
        await desktopRelay('desktop_keyboard_press', { key: 'enter' });
        await sleep(650);
        activeWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
        if (!isWeChatActiveWindow(activeWindow)) {
          throw new Error(`Contact search did not leave WeChat in the foreground. Active window: ${JSON.stringify(activeWindow).slice(0, 300)}`);
        }
      }

      const point = virtualInputPoint(activeWindow);
      if (useVirtualCursor) {
        progress('\u6b63\u5728\u7528\u865a\u62df\u5149\u6807\u805a\u7126\u5fae\u4fe1\u8f93\u5165\u533a\u3002');
        await desktopRelay('desktop_cursor_glow_show', { source: 'wechat_send_message', timeoutMs: 12000 }).catch(() => '');
        await desktopRelay('desktop_cursor_glow_update', { x: point.x, y: point.y }).catch(() => '');
        await desktopRelay('desktop_mouse_click_at', { x: point.x, y: point.y, button: 'left' });
        await desktopRelay('desktop_cursor_glow_click', { x: point.x, y: point.y }).catch(() => '');
        await sleep(180);
      }

      let beforeUiSnapshot = '';
      try {
        beforeUiSnapshot = await captureDesktopUiEvidence(desktopRelay, 220);
      } catch {}

      progress('\u6b63\u5728\u7c98\u8d34\u5e76\u53d1\u9001\u5fae\u4fe1\u6d88\u606f\u3002');
      await desktopRelay('desktop_clipboard_write', { text: message });
      await desktopRelay('desktop_keyboard_press', { key: 'ctrl+v' });
      await sleep(220);
      await desktopRelay('desktop_keyboard_press', { key: sendShortcut });
      await sleep(450);
      await desktopRelay('desktop_cursor_glow_hide', { source: 'wechat_send_message' }).catch(() => '');

      const finalActiveWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
      if (!isWeChatActiveWindow(finalActiveWindow)) {
        throw new Error(`Message send shortcut was pressed, but WeChat is no longer foreground. Active window: ${JSON.stringify(finalActiveWindow).slice(0, 300)}`);
      }

      progress('\u6b63\u5728\u786e\u8ba4\u6d88\u606f\u5df2\u51fa\u73b0\u5728\u5fae\u4fe1\u804a\u5929\u4e2d\u3002');
      let afterUiSnapshot = '';
      try {
        afterUiSnapshot = await captureDesktopUiEvidence(desktopRelay, 240);
      } catch {}
      const uiVerified = snapshotContainsNewMessage(beforeUiSnapshot, afterUiSnapshot, message);

      let visionVerification = { sent: false, confidence: 0, reason: '' };
      const visionConfig = hasVisionProvider(context);
      if (!uiVerified && visionConfig) {
        try {
          const screenCapture = await desktopRelay('desktop_capture_screen', { quality: 70 });
          const getters = context?.llmGetters;
          const verificationText = await analyzeScreen(
            screenCapture,
            [
              'Verify a foreground WeChat send using only visible evidence.',
              `Expected recipient/group: ${JSON.stringify(contact || '(current conversation)')}.`,
              `Expected exact message: ${JSON.stringify(message)}.`,
              'Set sent=true only if the exact message is visibly present as the newest outgoing chat bubble in the intended conversation and is no longer merely sitting in the input box.',
              'Return only JSON: {"sent":boolean,"confidence":number,"reason":"short visible evidence"}.',
            ].join('\n'),
            visionConfig,
            getters?.getDeepSeek,
            getters?.getGemini,
            getters?.getOpenAI,
            getters?.getAnthropic,
            getters?.getQwen,
            getters?.getOllama,
            getters?.getLmStudio,
            getters?.getArk,
            getters?.getXiaomi,
            getters?.getKimi,
            getters?.getGlm,
            getters?.getRelay,
          );
          visionVerification = parseWeChatSendVisionVerification(verificationText);
        } catch (err: any) {
          visionVerification.reason = err?.message || String(err);
        }
      }
      const sent = uiVerified || visionVerification.sent;

      return JSON.stringify({
        sent,
        sendAttempted: true,
        verificationStatus: sent ? 'verified' : 'uncertain',
        verificationMethod: uiVerified ? 'uia_new_message' : visionVerification.sent ? 'screen_vision' : 'none',
        verificationConfidence: uiVerified ? 0.8 : visionVerification.confidence,
        verificationReason: uiVerified
          ? 'The exact message appeared as new accessible UI text after the send action.'
          : visionVerification.reason || 'No outgoing message-bubble evidence was available.',
        contact: contact || null,
        usedContactSearch: useSearch,
        sendShortcut,
        method: useVirtualCursor ? 'virtual_cursor_clipboard_paste_send' : 'clipboard_paste_send',
        inputPoint: point,
        openResult,
        activeWindow: finalActiveWindow,
        messagePreview: message.slice(0, 80),
        note: sent
          ? 'The foreground send action completed and the result was verified from visible WeChat evidence.'
          : 'The send shortcut was pressed, but completion was not verified. Do not report the message as sent.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'wechat_send_file',
    description: 'Send one real local file to WeChat after an explicit user request. When contact is omitted, first use the current Lumi user\'s bound personal WeChat bot conversation and provider acknowledgement, including an organization audit for work-to-personal transfer. If that conversation lacks usable context, fall back to the member\'s personal desktop WeChat relay. Provide contact only when the user explicitly names another contact/group; desktop mode then copies a real file list to the OS clipboard, sends it, and never reports success without filename evidence.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Exact local path of the file to send.' },
        contact: { type: 'string', description: 'Explicit WeChat recipient or group name for desktop mode. Omit for the current Lumi user\'s bound personal WeChat bot conversation.' },
        bindingId: { type: 'string', description: 'Optional personal WeChat binding ID. Use when this Lumi user has more than one personal WeChat binding.' },
        applicationTarget: { type: 'string', description: 'Desktop app target. Defaults to wechat.' },
        useSearch: { type: 'boolean', description: 'Search for the contact before sending. Defaults true when contact is provided.' },
        sendShortcut: { type: 'string', description: 'WeChat send shortcut. Defaults enter.' },
      },
      required: ['filePath'],
    },
    handler: async (args, context) => {
      const filePath = path.resolve(String(args.filePath || '').trim());
      if (!args.filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`File does not exist: ${filePath}`);
      }
      if (context?.domain === 'work' && (!context.userId || !context.orgId)) {
        throw new Error('Organization-to-personal WeChat transfer requires a bound member and organization scope for audit.');
      }
      if (context?.domain === 'work') {
        const membership = getMember(context.orgId!, context.userId!);
        if (membership?.status !== 'active' || membership.role === 'viewer') {
          throw new Error('This Lumi member cannot transfer files from the active organization.');
        }
      }
      const progress = (step: string) => context?.onProgress?.(step);
      const contact = String(args.contact || '').trim();
      let nativeFallbackReason = '';
      if (!contact && context?.userId) {
        try {
          progress('正在通过已绑定的个人微信会话发送文件。');
          const result = await sendLocalFileToPersonalWeChat({
            userId: context.userId,
            filePath,
            bindingId: String(args.bindingId || '').trim() || undefined,
            sourceOrgId: context.domain === 'work' ? context.orgId : undefined,
          });
          return JSON.stringify({
            sent: true,
            sendAttempted: true,
            verificationStatus: 'provider_accepted',
            verificationMethod: 'wechat_ilink_provider_ack',
            verificationConfidence: 0.95,
            filePath,
            fileName: result.fileName,
            fileSize: result.fileSize,
            bindingId: result.target.bindingId,
            messageId: result.messageId,
            method: result.method,
            note: 'The bound WeChat provider accepted the file message.',
          }, null, 2);
        } catch (err: any) {
          if (!(err instanceof WeChatFileApiUnavailableError)) throw err;
          nativeFallbackReason = err?.message || String(err);
        }
      }
      const desktopRelay = context?.domain === 'work'
        ? context.personalDesktopRelay
        : context?.desktopRelay || context?.personalDesktopRelay;
      if (!desktopRelay) {
        const suffix = nativeFallbackReason ? ` Native WeChat path unavailable: ${nativeFallbackReason}` : '';
        throw new Error(`Sending a file to personal WeChat requires either a recent bound bot conversation or the member's personal Lumi desktop client online.${suffix}`);
      }

      const appTarget = String(args.applicationTarget || 'wechat').trim() || 'wechat';
      const useSearch = args.useSearch !== false && Boolean(contact);
      const sendShortcut = String(args.sendShortcut || 'enter').trim() || 'enter';
      const fileName = path.basename(filePath);

      progress('正在复用个人桌面的微信窗口。');
      const openResult = await desktopRelay('desktop_open', { target: appTarget });
      await sleep(450);
      let activeWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
      if (!isWeChatActiveWindow(activeWindow)) {
        await sleep(600);
        activeWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
      }
      if (!isWeChatActiveWindow(activeWindow)) {
        throw new Error(`WeChat is not the foreground window after opening. Active window: ${JSON.stringify(activeWindow).slice(0, 300)}`);
      }

      if (useSearch) {
        progress(`正在微信里定位联系人: ${contact}`);
        await desktopRelay('desktop_clipboard_write', { text: contact });
        await desktopRelay('desktop_keyboard_press', { key: 'ctrl+f' });
        await sleep(250);
        await desktopRelay('desktop_keyboard_press', { key: 'ctrl+v' });
        await sleep(450);
        await desktopRelay('desktop_keyboard_press', { key: 'enter' });
        await sleep(650);
        activeWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
        if (!isWeChatActiveWindow(activeWindow)) {
          throw new Error(`Contact search did not leave WeChat in the foreground. Active window: ${JSON.stringify(activeWindow).slice(0, 300)}`);
        }
      }

      const point = virtualInputPoint(activeWindow);
      await desktopRelay('desktop_cursor_glow_show', { source: 'wechat_send_file', timeoutMs: 12000 }).catch(() => '');
      await desktopRelay('desktop_cursor_glow_update', { x: point.x, y: point.y }).catch(() => '');
      await desktopRelay('desktop_mouse_click_at', { x: point.x, y: point.y, button: 'left' });
      await desktopRelay('desktop_cursor_glow_click', { x: point.x, y: point.y }).catch(() => '');
      await sleep(180);

      let beforeUiSnapshot = '';
      try { beforeUiSnapshot = await captureDesktopUiEvidence(desktopRelay, 220); } catch {}
      progress(`正在粘贴并发送文件: ${fileName}`);
      await desktopRelay('desktop_clipboard_write_files', { paths: [filePath] });
      await desktopRelay('desktop_keyboard_press', { key: 'ctrl+v' });
      await sleep(500);
      await desktopRelay('desktop_keyboard_press', { key: sendShortcut });
      await sleep(800);
      await desktopRelay('desktop_cursor_glow_hide', { source: 'wechat_send_file' }).catch(() => '');

      const finalActiveWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
      if (!isWeChatActiveWindow(finalActiveWindow)) {
        throw new Error(`File send shortcut was pressed, but WeChat is no longer foreground. Active window: ${JSON.stringify(finalActiveWindow).slice(0, 300)}`);
      }
      let afterUiSnapshot = '';
      try { afterUiSnapshot = await captureDesktopUiEvidence(desktopRelay, 260); } catch {}
      const normalizedAfter = afterUiSnapshot.toLowerCase();
      const uiVerified = normalizedAfter.includes(fileName.toLowerCase()) && afterUiSnapshot !== beforeUiSnapshot;

      let visionVerification = { sent: false, confidence: 0, reason: '' };
      const visionConfig = hasVisionProvider(context);
      if (!uiVerified && visionConfig) {
        try {
          const screenCapture = await desktopRelay('desktop_capture_screen', { quality: 70 });
          const getters = context?.llmGetters;
          const verificationText = await analyzeScreen(
            screenCapture,
            [
              'Verify a foreground WeChat file send using only visible evidence.',
              `Expected recipient/group: ${JSON.stringify(contact || '(current conversation)')}.`,
              `Expected filename: ${JSON.stringify(fileName)}.`,
              'Set sent=true only if the filename is visibly present as the newest outgoing file bubble and is no longer merely pending in the input area.',
              'Return only JSON: {"sent":boolean,"confidence":number,"reason":"short visible evidence"}.',
            ].join('\n'),
            visionConfig,
            getters?.getDeepSeek,
            getters?.getGemini,
            getters?.getOpenAI,
            getters?.getAnthropic,
            getters?.getQwen,
            getters?.getOllama,
            getters?.getLmStudio,
            getters?.getArk,
            getters?.getXiaomi,
            getters?.getKimi,
            getters?.getGlm,
            getters?.getRelay,
          );
          visionVerification = parseWeChatSendVisionVerification(verificationText);
        } catch (err: any) {
          visionVerification.reason = err?.message || String(err);
        }
      }
      const sent = uiVerified || visionVerification.sent;

      if (sent && context?.domain === 'work' && context.orgId && context.userId) {
        logAudit({
          orgId: context.orgId,
          userId: context.userId,
          action: 'messaging.file.transfer_to_personal_wechat',
          resourceType: 'messaging_file_transfer',
          resourceId: `wechat:${Date.now()}`,
          details: {
            sourceDomain: 'work',
            targetPlatform: 'wechat',
            contact: contact || '(current conversation)',
            fileName,
            fileSize: fs.statSync(filePath).size,
            localPath: filePath,
            verificationMethod: uiVerified ? 'uia_filename' : 'screen_vision',
          },
        });
      }

      return JSON.stringify({
        sent,
        sendAttempted: true,
        verificationStatus: sent ? 'verified' : 'uncertain',
        verificationMethod: uiVerified ? 'uia_filename' : visionVerification.sent ? 'screen_vision' : 'none',
        verificationConfidence: uiVerified ? 0.8 : visionVerification.confidence,
        verificationReason: uiVerified
          ? 'The exact filename appeared as new accessible WeChat UI text after the send action.'
          : visionVerification.reason || 'No outgoing file-bubble evidence was available.',
        contact: contact || null,
        filePath,
        fileName,
        openResult,
        activeWindow: finalActiveWindow,
        nativeFallbackReason: nativeFallbackReason || null,
        note: sent
          ? 'The foreground file send completed and was verified from visible WeChat evidence.'
          : 'The send shortcut was pressed, but completion was not verified. Do not report the file as sent.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'cad_generate_autocad_draw_script',
    description: 'Generate AutoCAD LISP and SCRIPT files that visibly draw a CAD plan stroke by stroke inside AutoCAD with configurable delay between lines/arcs/text. Use this when the user wants to see Lumi drawing in AutoCAD step by step instead of only opening a finished DXF. It creates precise CAD commands from structured walls, rooms, polylines, doors, windows, columns, furniture, dimensions, labels, title block, and north arrow data. The script is a drafting playback and still requires review before production drawings.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Drawing title / output filename.' },
        width: { type: 'number', description: 'Outer width in chosen units.' },
        height: { type: 'number', description: 'Outer height in chosen units.' },
        unit: { type: 'string', description: 'Unit label, e.g. mm, cm, inch.' },
        cornerRadius: { type: 'number', description: 'Reserved for compatibility with cad_generate_dxf; visible script draws rectangular outlines.' },
        wallThickness: { type: 'number', description: 'Default wall thickness for wall segments when individual wall.thickness is omitted.' },
        precisionNote: { type: 'string', description: 'Short note about source accuracy, scale assumptions, or missing dimensions.' },
        inferredScale: { type: 'boolean', description: 'True when scale or coordinates were inferred rather than confirmed from source dimensions.' },
        confidence: { type: 'number', description: 'Optional geometry extraction confidence from 0 to 1.' },
        assumptions: { type: 'array', description: 'Assumptions inherited from image/folder geometry extraction.', items: { type: 'string' } },
        missingForPrecision: { type: 'array', description: 'Inputs still needed before the drawing can be treated as dimensionally precise.', items: { type: 'string' } },
        precisionStatus: { type: 'string', description: 'Traceable precision state from geometry extraction.' },
        sourcePath: { type: 'string', description: 'Optional source image/drawing path used for traceability.' },
        northArrow: { type: 'object', description: 'Optional north arrow position, e.g. {x,y}. Set true/object when orientation is known.' },
        titleBlock: { type: 'boolean', description: 'Whether to include a title block. Defaults to true.' },
        outputDirectory: { type: 'string', description: 'Optional directory to save the .lsp, .scr, and runner .ps1 files.' },
        outputPath: { type: 'string', description: 'Optional exact output base path. Extensions .lsp/.scr/.ps1 are generated from it.' },
        strokeDelayMs: { type: 'number', description: 'Delay in milliseconds after each visible operation. Defaults to 250, max 5000.' },
        autocadExecutable: { type: 'string', description: 'Optional AutoCAD executable path/name for the generated PowerShell runner. Defaults to acad.exe.' },
        launchAutoCAD: { type: 'boolean', description: 'Optionally launch AutoCAD with the generated .scr via desktop_run_command. Runs under the active desktop mode; destructive/system boundaries still apply.' },
        walls: {
          type: 'array',
          description: 'Optional CAD wall/line segments: {x1,y1,x2,y2,thickness,layer}. Use floor plan units such as mm.',
          items: { type: 'object' },
        },
        polylines: {
          type: 'array',
          description: 'Optional open/closed polylines: {points:[{x,y}],closed,layer}. Script draws each segment one by one.',
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
      },
      required: ['width', 'height'],
    },
    handler: async (args, context) => {
      const draftArgs = validateCadDraftArgs(args);
      const title = safeFileName(String(draftArgs.title || 'lumi_autocad_draw'));
      const delay = Math.max(0, Math.min(Number(draftArgs.strokeDelayMs) || 250, 5000));
      const paths = resolveAutocadScriptPaths(draftArgs, title);
      const operations = collectAutocadDrawOperations(draftArgs);
      if (!operations.length) throw new Error('No drawable AutoCAD operations were generated. Provide width/height plus walls, rooms, doors, windows, or labels.');

      const lisp = buildAutocadLisp(draftArgs, operations, title, delay, paths.markerPath);
      const script = buildAutocadScript(paths.lispPath);
      const runner = buildAutocadRunPowerShell(paths.scriptPath, draftArgs.autocadExecutable ? String(draftArgs.autocadExecutable) : undefined);
      fs.writeFileSync(paths.lispPath, lisp, 'utf-8');
      fs.writeFileSync(paths.scriptPath, script, 'utf-8');
      fs.writeFileSync(paths.powershellPath, runner, 'utf-8');
      const manifest = {
        version: 1,
        generatedAt: new Date().toISOString(),
        title,
        sourcePath: draftArgs.sourcePath || '',
        unit: draftArgs.unit || 'unit',
        width: draftArgs.width,
        height: draftArgs.height,
        inferredScale: draftArgs.inferredScale,
        confidence: Number.isFinite(Number(draftArgs.confidence)) ? Number(draftArgs.confidence) : null,
        assumptions: draftArgs.assumptions,
        missingForPrecision: draftArgs.missingForPrecision,
        precisionStatus: draftArgs.precisionStatus,
        strokeDelayMs: delay,
        operationCount: operations.length,
        lispPath: paths.lispPath,
        scriptPath: paths.scriptPath,
        completionMarkerPath: paths.markerPath,
      };
      fs.writeFileSync(paths.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      try { fs.rmSync(paths.markerPath, { force: true }); } catch {}

      let launchResult: string | undefined;
      if (draftArgs.launchAutoCAD) {
        const desktopRelay = requireDesktopRelay(context);
        launchResult = await desktopRelay('desktop_run_command', {
          command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${paths.powershellPath}"`,
        });
      }

      const layerCounts = operations.reduce((acc: Record<string, number>, op) => {
        acc[op.layer] = (acc[op.layer] || 0) + 1;
        return acc;
      }, {});
      const typeCounts = operations.reduce((acc: Record<string, number>, op) => {
        acc[op.kind] = (acc[op.kind] || 0) + 1;
        return acc;
      }, {});

      return JSON.stringify({
        title,
        unit: draftArgs.unit || 'unit',
        width: draftArgs.width,
        height: draftArgs.height,
        inferredScale: draftArgs.inferredScale,
        confidence: manifest.confidence,
        assumptions: draftArgs.assumptions,
        missingForPrecision: draftArgs.missingForPrecision,
        precisionStatus: draftArgs.precisionStatus,
        strokeDelayMs: delay,
        operationCount: operations.length,
        typeCounts,
        layerCounts,
        lispPath: paths.lispPath,
        scriptPath: paths.scriptPath,
        powershellRunnerPath: paths.powershellPath,
        completionMarkerPath: paths.markerPath,
        manifestPath: paths.manifestPath,
        launchCommand: `powershell -NoProfile -ExecutionPolicy Bypass -File "${paths.powershellPath}"`,
        launchAutoCAD: Boolean(draftArgs.launchAutoCAD),
        launchResult,
        preview: operations.slice(0, 20).map((op, index) => ({ index: index + 1, ...op })),
        note: 'Generated AutoCAD visible drawing playback. In AutoCAD, run SCRIPT and choose the .scr file, or run the PowerShell runner if acad.exe is available. Lumi still needs confirmed dimensions and professional review before production drawings.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'cad_run_autocad_draw_script',
    description: 'Execute a generated AutoCAD .scr draw script through AutoCAD /b, then verify whether the stroke-by-stroke drawing run completed using a completion marker file plus optional desktop process/window observations. Use after cad_generate_autocad_draw_script when Lumi should actually drive AutoCAD, not merely open the app. This does not certify production drawings; it verifies script execution/handoff.',
    parameters: {
      type: 'object',
      properties: {
        scriptPath: { type: 'string', description: 'Path to the generated AutoCAD .scr file.' },
        lispPath: { type: 'string', description: 'Optional generated .lsp path for diagnostics.' },
        completionMarkerPath: { type: 'string', description: 'Optional marker path written by generated LISP when drawing completes. Defaults beside script.' },
        autocadExecutable: { type: 'string', description: 'Optional exact acad.exe path/name. Defaults to acad.exe and common Autodesk install paths.' },
        waitSeconds: { type: 'number', description: 'Seconds to wait for the completion marker after launching. Defaults to 20, max 300.' },
        launch: { type: 'boolean', description: 'Actually launch AutoCAD. Defaults to true. Set false to only prepare the runner/command.' },
        requireCompletionMarker: { type: 'boolean', description: 'If true, mark the run blocked when completion marker is not observed. Defaults to false.' },
        recordRunner: { type: 'boolean', description: 'Write or refresh the PowerShell runner beside the script. Defaults to true.' },
      },
      required: ['scriptPath'],
    },
    handler: async (args, context) => {
      const scriptPath = path.resolve(expandHomePath(String(args.scriptPath || '').trim()));
      if (!scriptPath || !/\.scr$/i.test(scriptPath)) throw new Error('scriptPath must point to a generated .scr file.');
      if (!fs.existsSync(scriptPath)) throw new Error(`AutoCAD script not found: ${scriptPath}`);
      const lispPath = args.lispPath ? path.resolve(expandHomePath(String(args.lispPath))) : '';
      if (lispPath && !fs.existsSync(lispPath)) throw new Error(`AutoCAD LISP file not found: ${lispPath}`);

      const markerPath = args.completionMarkerPath
        ? path.resolve(expandHomePath(String(args.completionMarkerPath)))
        : autocadMarkerPathForScript(scriptPath);
      const runnerPath = autocadRunnerPathForScript(scriptPath);
      const manifest = readAutocadManifest(scriptPath);
      const estimatedWaitSeconds = Math.max(20, Math.min(300, Math.ceil(
        45 + Math.max(0, Number(manifest?.operationCount) || 0) * Math.max(0, Number(manifest?.strokeDelayMs) || 0) / 1000 * 1.25,
      )));
      const explicitWaitSeconds = Number(args.waitSeconds);
      const waitSeconds = Number.isFinite(explicitWaitSeconds) && explicitWaitSeconds >= 0
        ? Math.min(explicitWaitSeconds, 300)
        : estimatedWaitSeconds;
      if (args.recordRunner !== false) {
        assertWritableCadPath(runnerPath);
        fs.writeFileSync(runnerPath, buildAutocadRunPowerShell(scriptPath, args.autocadExecutable ? String(args.autocadExecutable) : undefined), 'utf-8');
      }

      const launchCommand = `powershell -NoProfile -ExecutionPolicy Bypass -File "${runnerPath}"`;
      let launchResult: string | undefined;
      let activeWindowRaw = '';
      let runningProcessesRaw = '';
      let markerCompleted = fs.existsSync(markerPath);
      const shouldLaunch = args.launch !== false;

      if (shouldLaunch) {
        const desktopRelay = requireDesktopRelay(context);
        try { fs.rmSync(markerPath, { force: true }); } catch {}
        launchResult = await desktopRelay('desktop_run_command', { command: launchCommand });
        markerCompleted = await waitForFile(markerPath, waitSeconds);
        try {
          activeWindowRaw = await desktopRelay('desktop_active_window', {});
        } catch {}
        try {
          runningProcessesRaw = await desktopRelay('desktop_running_processes', { top: 120 });
        } catch {}
      }

      const processEvidence = `${activeWindowRaw}\n${runningProcessesRaw}`;
      const autocadObserved = /acad|autocad|AutoCAD|acad\.exe/i.test(processEvidence);
      const status =
        markerCompleted ? 'completed' :
        args.requireCompletionMarker === true ? 'blocked' :
        shouldLaunch && (launchResult || autocadObserved) ? 'launched_needs_review' :
        shouldLaunch ? 'needs_review' :
        'ready_to_launch';

      return JSON.stringify({
        status,
        scriptPath,
        lispPath: lispPath || undefined,
        completionMarkerPath: markerPath,
        completionMarkerExists: markerCompleted,
        manifestPath: autocadManifestPathForScript(scriptPath),
        manifestFound: Boolean(manifest),
        manifest,
        powershellRunnerPath: runnerPath,
        launchCommand,
        launch: shouldLaunch,
        launchResult,
        waitSeconds,
        estimatedWaitSeconds,
        autocadObserved,
        activeWindowRaw: activeWindowRaw || undefined,
        runningProcessesRaw: runningProcessesRaw || undefined,
        note: markerCompleted
          ? 'AutoCAD draw script completed and wrote the marker file.'
          : shouldLaunch
          ? 'AutoCAD script was launched or attempted. Completion marker was not observed yet; inspect AutoCAD/window state before claiming the drawing is complete.'
          : 'Runner is ready. Launch is disabled, so no AutoCAD execution was attempted.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
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
        inferredScale: { type: 'boolean', description: 'True when scale or coordinates were inferred rather than confirmed from source dimensions.' },
        confidence: { type: 'number', description: 'Optional geometry extraction confidence from 0 to 1.' },
        assumptions: { type: 'array', description: 'Assumptions inherited from image/folder geometry extraction.', items: { type: 'string' } },
        missingForPrecision: { type: 'array', description: 'Inputs still needed before the drawing can be treated as dimensionally precise.', items: { type: 'string' } },
        precisionStatus: { type: 'string', description: 'Traceable precision state from geometry extraction.' },
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
        openPreview: { type: 'boolean', description: 'Open the generated DXF with the system default app. Requires foreground confirmation, or an approved autonomous workflow when used in the background.' },
      },
      required: ['width', 'height'],
    },
    handler: async (args, context) => {
      const draftArgs = validateCadDraftArgs(args);
      const title = safeFileName(String(draftArgs.title || 'lumi_cad_draft'));
      const outPath = resolveCadOutputPath(draftArgs, title);
      fs.writeFileSync(outPath, buildDxf(draftArgs), 'utf-8');
      const previewSvg = buildCadPreviewSvg(draftArgs, title);
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
  });
}
