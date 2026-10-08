import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { ToolRegistry } from '../server/tools/registry';
import { registerCadDeliveryTools } from '../server/tools/definitions/cad_delivery_tools';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_cad_geometry_')); directories.push(dir);
  const registry = new ToolRegistry(); registerCadDeliveryTools(registry);
  return { dir, registry };
}
async function deliver(geometry: Record<string, unknown>) {
  const { dir, registry } = setup();
  const boundary = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 800 }, { x: 0, y: 800 }];
  const args = { width: 1000, height: 800, titleBlock: false, outputDirectory: dir,
    ...(geometry.rectangularOutline === false ? { outerBoundary: boundary } : {}), ...geometry };
  const prepared = JSON.parse(await registry.execute('cad_prepare_autocad_operations', args, { allowLocalFileWrites: true }));
  const generated = JSON.parse(await registry.execute('cad_generate_dxf', args, { allowLocalFileWrites: true }));
  const operations = JSON.parse(fs.readFileSync(prepared.operationsPath, 'utf8')).operations;
  const dxf = fs.readFileSync(generated.path, 'utf8').trim().split(/\r?\n/);
  const entities: Array<Record<string, string[]>> = []; let current: Record<string, string[]> | undefined;
  for (let i = 0; i < dxf.length; i += 2) {
    const code = dxf[i], value = dxf[i + 1];
    if (code === '0') { current = { kind: [value] }; entities.push(current); }
    else if (current) (current[code] ||= []).push(value);
  }
  const svg = new JSDOM(fs.readFileSync(generated.previewPath, 'utf8'), { contentType: 'image/svg+xml' }).window.document;
  return { prepared, generated, operations, entities, svg };
}
it('uses the same four rounded corners in DXF, preview and native playback', async () => {
  const r = await deliver({ cornerRadius: 100 });
  const arcs = r.operations.filter((op: any) => op.kind === 'arc');
  expect(arcs.map((op: any) => [op.cx, op.cy, op.r, op.start, op.end])).toEqual([
    [900, 100, 100, 270, 360], [900, 700, 100, 0, 90], [100, 700, 100, 90, 180], [100, 100, 100, 180, 270],
  ]);
  expect(r.entities.filter(e => e.kind[0] === 'ARC').map(e => [Number(e['10'][0]), Number(e['20'][0]), Number(e['40'][0]), Number(e['50'][0]), Number(e['51'][0])])).toEqual(arcs.map((op: any) => [op.cx, op.cy, op.r, op.start, op.end]));
  expect(r.svg.querySelectorAll('path')).toHaveLength(4);
  expect(r.operations.filter((op: any) => op.kind === 'line')).toHaveLength(4);
});
it('keeps a clockwise door swing a short quarter-circle in all outputs', async () => {
  const r = await deliver({ rectangularOutline: false, doors: [{ hingeX: 400, hingeY: 400, width: 200, angle: 0, swing: 'right' }] });
  expect(r.operations.find((op: any) => op.kind === 'arc')).toMatchObject({ cx: 400, cy: 400, r: 200, start: 270, end: 0 });
  const arc = r.entities.find(e => e.kind[0] === 'ARC')!;
  expect([Number(arc['50'][0]), Number(arc['51'][0])]).toEqual([270, 0]);
  const coordinates = r.svg.querySelector('path')!.getAttribute('d')!.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)!.map(Number);
  expect(coordinates[0]).toBeCloseTo(400); expect(coordinates[1]).toBeCloseTo(200);
  expect(coordinates.slice(4, 7)).toEqual([0, 0, 1]);
  expect(coordinates[7]).toBeCloseTo(600); expect(coordinates[8]).toBeCloseTo(400);
});
it('preserves closed polygon topology and shares the operation identity with the manifest', async () => {
  const points = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 500 }, { x: 200, y: 500 }, { x: 200, y: 300 }, { x: 0, y: 300 }];
  const r = await deliver({ rectangularOutline: false, polylines: [{ points, closed: true, layer: 'TRACE' }] });
  const trace = r.operations.filter((op: any) => op.layer === 'TRACE'); expect(trace).toHaveLength(6);
  expect(trace.at(-1)).toMatchObject({ x1: 0, y1: 300, x2: 0, y2: 0 });
  const polyline = r.entities.find(e => e.kind[0] === 'LWPOLYLINE' && e['8'][0] === 'TRACE')!;
  expect(polyline['70']).toEqual(['1']); expect(polyline['90']).toEqual(['6']);
  expect([...r.svg.querySelectorAll('polygon')].map(p => p.getAttribute('points'))).toContain('0,0 600,0 600,500 200,500 200,300 0,300');
  const manifest = JSON.parse(fs.readFileSync(r.prepared.manifestPath, 'utf8'));
  const packet = JSON.parse(fs.readFileSync(r.prepared.operationsPath, 'utf8'));
  expect(manifest.operationSetId).toBe(packet.operationSetId); expect(manifest.geometryHash).toBe(r.prepared.geometryHash);
  expect(manifest.generatedAt).toBe(packet.generatedAt); expect(packet.expectedEntityCount).toBe(r.operations.length);
  expect(r.prepared).toMatchObject({ fallbackAllowed: false, requiredPlaybackTool: 'mcp_cad-drafting_autocad_playback_file' });
});
it('refuses an oversized native plan instead of publishing a silently truncated drawing', async () => {
  const { dir, registry } = setup();
  const points = Array.from({ length: 2602 }, (_, i) => ({ x: i / 3, y: i % 2 ? 100 : 0 }));
  await expect(registry.execute('cad_prepare_autocad_operations', { width: 1000, height: 800, rectangularOutline: false, titleBlock: false, walls: [{ x1: 0, y1: 0, x2: 1000, y2: 0 }], polylines: [{ points }], outputDirectory: dir }, { allowLocalFileWrites: true })).rejects.toThrow(/operation limit exceeded.*2500/i);
  expect(fs.readdirSync(dir)).toEqual([]);
});

it.each(['cad_prepare_autocad_operations', 'cad_generate_dxf'])('%s enforces the advertised collection limit without emitting partial files', async tool => {
  const { dir, registry } = setup();
  const declaration = registry.getToolDeclarations().find(item => item.function.name === tool)!;
  const limit = declaration.function.parameters.properties.rooms.maxItems;
  expect(limit).toBe(120);
  const rooms = Array.from({ length: limit + 1 }, () => ({ x: 0, y: 0, width: 10, height: 10 }));
  await expect(registry.execute(tool, { width: 1000, height: 800, rooms, outputDirectory: dir }, { allowLocalFileWrites: true })).rejects.toThrow(/CAD rooms limit exceeded.*120/i);
  expect(fs.readdirSync(dir)).toEqual([]);
});
it('applies the same wall limit to the legacy lines alias', async () => {
  const { dir, registry } = setup();
  const lines = Array.from({ length: 501 }, () => ({ x1: 0, y1: 0, x2: 1000, y2: 0 }));
  await expect(registry.execute('cad_prepare_autocad_operations', { width: 1000, height: 800, lines, outputDirectory: dir }, { allowLocalFileWrites: true })).rejects.toThrow(/CAD walls limit exceeded.*500/i);
  expect(fs.readdirSync(dir)).toEqual([]);
});
it('keeps every accepted hole at the collection boundary in DXF, preview and native output', async () => {
  const holes = Array.from({ length: 40 }, (_, i) => ({ x: i * 20 + 50, y: 400, r: 5 }));
  const r = await deliver({ holes });
  expect(r.operations.filter((op: any) => op.kind === 'circle')).toHaveLength(40);
  expect(r.entities.filter(e => e.kind[0] === 'CIRCLE')).toHaveLength(40);
  expect(r.svg.querySelectorAll('circle')).toHaveLength(40);
});

it('keeps the shared title-block geometry inside the SVG viewport', async () => {
  const r = await deliver({ titleBlock: true });
  const [x, y, width, height] = r.svg.documentElement.getAttribute('viewBox')!.split(' ').map(Number);
  for (const polygon of r.svg.querySelectorAll('polygon')) {
    for (const point of polygon.getAttribute('points')!.split(' ')) {
      const [px, py] = point.split(',').map(Number);
      expect(px).toBeGreaterThanOrEqual(x); expect(px).toBeLessThanOrEqual(x + width);
      expect(py).toBeGreaterThanOrEqual(y); expect(py).toBeLessThanOrEqual(y + height);
    }
  }
});
