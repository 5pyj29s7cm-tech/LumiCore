import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/llm/adapter', () => ({
  analyzeScreen: vi.fn(),
}));

vi.mock('../server/llm/vision_preferences', () => ({
  getUserPreferredVision: () => ({ provider: 'qwen', model: 'test-vision' }),
}));

vi.mock('../server/cad/floorplan_vectorizer', () => ({
  vectorizeFloorplanLinework: vi.fn(),
}));

import { analyzeScreen } from '../server/llm/adapter';
import { vectorizeFloorplanLinework } from '../server/cad/floorplan_vectorizer';
import { registerOCRTools } from '../server/tools/definitions/ocr_tools';
import { ToolRegistry } from '../server/tools/registry';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('floor-plan extraction pipeline', () => {
  const originalDataDirectory = process.env.LUMI_DATA_DIR;

  afterEach(() => {
    vi.mocked(analyzeScreen).mockReset();
    vi.mocked(vectorizeFloorplanLinework).mockReset();
    if (originalDataDirectory === undefined) delete process.env.LUMI_DATA_DIR;
    else process.env.LUMI_DATA_DIR = originalDataDirectory;
  });

  it('uses calibrated deterministic tracing and hands CAD tools only a verified receipt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_floorplan_pipeline_'));
    process.env.LUMI_DATA_DIR = dir;
    try {
      const sourcePath = path.join(dir, 'source.png');
      fs.writeFileSync(sourcePath, PNG_1X1);
      vi.mocked(analyzeScreen)
        .mockResolvedValueOnce(JSON.stringify({
          projectName: 'Source trace',
          confidence: 0.98,
          inferredScale: false,
          unit: 'mm',
          physicalWidth: 10000,
          physicalHeight: 8000,
          coordinateSystem: 'normalized_top_left_y_down',
          sourceTopology: { isRectangular: false, outerVertexCount: 6, visibleNotches: 1, visibleProjections: 0 },
          outerBoundary: [
            { x: 0, y: 0 },
            { x: 1000, y: 0 },
            { x: 1000, y: 1000 },
            { x: 700, y: 1000 },
            { x: 700, y: 875 },
            { x: 0, y: 875 },
          ],
          dimensions: [{ x1: 0, y1: 0, x2: 1000, y2: 0, text: '10000', offsetMm: -500, inferred: false }],
          assumptions: [],
          missingForPrecision: [],
        }))
        .mockResolvedValueOnce(JSON.stringify({
          approved: true,
          score: 0.98,
          outerBoundaryMatches: true,
          wallTopologyMatches: true,
          openingsMatch: true,
          dimensionAnchorsMatch: true,
          criticalMismatches: [],
          notes: [],
        }));
      vi.mocked(vectorizeFloorplanLinework).mockResolvedValue({
        kind: 'lumi_floorplan_opencv_vectorization',
        version: 1,
        width: 10000,
        height: 8000,
        unit: 'mm',
        coordinateSystem: 'bottom_left_y_up',
        sourceTopology: { isRectangular: false, outerVertexCount: 6, visibleNotches: 1, visibleProjections: 0, traceMode: 'opencv_source_linework' },
        outerBoundary: [
          { x: 0, y: 0 },
          { x: 10000, y: 0 },
          { x: 10000, y: 8000 },
          { x: 7000, y: 8000 },
          { x: 7000, y: 7000 },
          { x: 0, y: 7000 },
        ],
        walls: [],
        rooms: [],
        doors: [],
        windows: [],
        columns: [],
        holes: [],
        labels: [],
        furniture: [],
        polylines: Array.from({ length: 8 }, (_, index) => ({
          points: [{ x: 1000 + index * 500, y: 0 }, { x: 1000 + index * 500, y: 7000 }],
          closed: false,
          layer: 'SOURCE_LINEWORK',
          inferred: false,
        })),
        metrics: {
          lineSegmentCount: 8,
          outerVertexCount: 6,
          footprintAreaRatio: 0.9,
          sourcePixelPrecision: 0.99,
          sourcePixelRecall: 0.98,
          sourcePixelF1: 0.985,
        },
      });

      const registry = new ToolRegistry();
      registerOCRTools(registry);
      const raw = await registry.execute('floorplan_extract_geometry', {
        imagePath: sourcePath,
        knownDimensions: '10000 x 8000 mm',
      }, {
        userId: 'pipeline-test',
        llmGetters: { getQwen: () => ({}) },
      } as any);
      const result = JSON.parse(raw);

      expect(analyzeScreen).toHaveBeenCalledTimes(2);
      expect(vectorizeFloorplanLinework).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        parsed: true,
        geometryReady: true,
        geometryVerified: true,
        executableGeometryAvailable: true,
      });
      expect(result.geometry).toBeUndefined();
      expect(result.cadPrepareAutocadOperationsArgs).toEqual({ geometryReceiptPath: result.geometryReceiptPath });
      expect(result.cadGenerateDxfArgs).toBeNull();
      expect(result.geometryReview.counts).toMatchObject({ outerBoundary: 6, walls: 0, polylines: 8, doors: 0, windows: 0 });
      expect(fs.existsSync(result.geometryReceiptPath)).toBe(true);
      expect(fs.existsSync(result.comparisonPreviewPath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
