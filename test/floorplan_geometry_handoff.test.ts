import { describe, expect, it } from 'vitest';
import { normalizeFloorplanGeometry } from '../server/tools/definitions/ocr_tools';

describe('floor-plan geometry handoff', () => {
  it('preserves extraction confidence and derives extents without pretending they are confirmed', () => {
    const result = normalizeFloorplanGeometry({
      projectName: 'Image plan',
      confidence: 0.64,
      inferredScale: true,
      rooms: [
        { name: 'Room A', x: 0, y: 0, width: 4200, height: 3600 },
        { name: 'Room B', x: 4200, y: 0, width: 2800, height: 3600 },
      ],
      assumptions: ['Room boundary inferred from a faint line.'],
      missingForPrecision: ['Confirm one overall dimension.'],
    }, {}, 'C:\\plan.png');

    expect(result).toMatchObject({
      width: 7000,
      height: 3600,
      inferredScale: true,
      confidence: 0.64,
      precisionStatus: 'inferred_requires_review',
      sourcePath: 'C:\\plan.png',
    });
    expect(result.assumptions).toHaveLength(1);
    expect(result.missingForPrecision).toHaveLength(1);
  });
});
