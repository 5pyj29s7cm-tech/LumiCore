import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  arbitrateCadVisualVerification,
  hydrateCadGeometryFromReceipt,
  validateCadGeometry,
  verifyCadGeometryReceipt,
  writeCadGeometryReceipt,
} from '../server/cad/geometry_verification';

const IRREGULAR_GEOMETRY = {
  width: 10000,
  height: 8000,
  unit: 'mm',
  coordinateSystem: 'bottom_left_y_up',
  inferredScale: false,
  assumptions: [],
  sourceTopology: {
    isRectangular: false,
    outerVertexCount: 6,
    visibleNotches: 1,
    visibleProjections: 0,
  },
  outerBoundary: [
    { x: 0, y: 0 },
    { x: 10000, y: 0 },
    { x: 10000, y: 8000 },
    { x: 7000, y: 8000 },
    { x: 7000, y: 7000 },
    { x: 0, y: 7000 },
  ],
  walls: [{ x1: 4000, y1: 0, x2: 4000, y2: 7000, inferred: false }],
  doors: [{ x: 4000, y: 2000, width: 900, angle: 0, inferred: false }],
  windows: [{ x1: 1000, y1: 7000, x2: 2500, y2: 7000, inferred: false }],
  dimensions: [{ x1: 0, y1: 0, x2: 10000, y2: 0, text: '10000', inferred: false }],
};

const APPROVED_VISUAL = {
  approved: true,
  score: 0.98,
  outerBoundaryMatches: true,
  wallTopologyMatches: true,
  openingsMatch: true,
  dimensionAnchorsMatch: true,
  criticalMismatches: [],
  notes: [],
};

describe('CAD source geometry verification', () => {
  it('uses strong deterministic pixel evidence to arbitrate a contradictory model review', () => {
    const geometry = {
      ...IRREGULAR_GEOMETRY,
      dimensions: [
        ...IRREGULAR_GEOMETRY.dimensions,
        { x1: 0, y1: 0, x2: 0, y2: 8000, text: '8000', inferred: false },
      ],
      sourceTopology: { ...IRREGULAR_GEOMETRY.sourceTopology, traceMode: 'opencv_source_linework' },
      sourceLinework: {
        metrics: { sourcePixelPrecision: 0.998, sourcePixelRecall: 0.975, sourcePixelF1: 0.986 },
      },
    };
    const rejected = {
      ...APPROVED_VISUAL,
      approved: false,
      score: 0,
      outerBoundaryMatches: false,
      wallTopologyMatches: false,
      openingsMatch: false,
      dimensionAnchorsMatch: false,
      criticalMismatches: ['Model claimed the trace was rectangular.'],
    };

    const result = arbitrateCadVisualVerification(rejected, geometry);
    expect(result).toMatchObject({ approved: true, verificationMethod: 'deterministic_pixel_arbitration' });
    expect(result.criticalMismatches).toEqual([]);
    expect(result.modelReview?.criticalMismatches).toEqual(rejected.criticalMismatches);
  });

  it('does not override a model rejection when source coverage is weak', () => {
    const result = arbitrateCadVisualVerification({
      ...APPROVED_VISUAL,
      approved: false,
      criticalMismatches: ['Missing wall segment.'],
    }, {
      ...IRREGULAR_GEOMETRY,
      sourceTopology: { ...IRREGULAR_GEOMETRY.sourceTopology, traceMode: 'opencv_source_linework' },
      sourceLinework: {
        metrics: { sourcePixelPrecision: 0.99, sourcePixelRecall: 0.8, sourcePixelF1: 0.89 },
      },
    });

    expect(result.approved).toBe(false);
    expect(result.verificationMethod).toBe('model');
  });

  it('accepts a calibrated irregular trace and rejects a rectangular replacement', () => {
    expect(validateCadGeometry(IRREGULAR_GEOMETRY, { sourceGrounded: true }).passed).toBe(true);

    const rectangularReplacement = {
      ...IRREGULAR_GEOMETRY,
      sourceTopology: { ...IRREGULAR_GEOMETRY.sourceTopology, outerVertexCount: 4 },
      outerBoundary: [
        { x: 0, y: 0 },
        { x: 10000, y: 0 },
        { x: 10000, y: 8000 },
        { x: 0, y: 8000 },
      ],
    };
    const validation = validateCadGeometry(rectangularReplacement, { sourceGrounded: true });
    expect(validation.passed).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/notches|reduced to a rectangle/i);
  });

  it('blocks inferred calibration and default structural assumptions', () => {
    const validation = validateCadGeometry({
      ...IRREGULAR_GEOMETRY,
      inferredScale: true,
      assumptions: ['Use a typical default door width.'],
    }, { sourceGrounded: true });

    expect(validation.passed).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/calibration dimension/i);
    expect(validation.errors.join(' ')).toMatch(/default or invented/i);
  });

  it('hydrates exact server-owned geometry from a receipt and detects source changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_cad_receipt_'));
    try {
      const sourcePath = path.join(dir, 'source.png');
      fs.writeFileSync(sourcePath, Buffer.from('source image v1'));
      const validation = validateCadGeometry(IRREGULAR_GEOMETRY, { sourceGrounded: true });
      const { receiptPath, receipt } = writeCadGeometryReceipt({
        sourcePath,
        geometry: IRREGULAR_GEOMETRY,
        validation,
        visualVerification: APPROVED_VISUAL,
        outputDirectory: dir,
      });

      const hydrated = hydrateCadGeometryFromReceipt({ geometryReceiptPath: receiptPath, title: 'User title' });
      expect(hydrated).toMatchObject({
        title: 'User title',
        sourcePath,
        geometryReceiptPath: receiptPath,
        geometryHash: receipt.geometryHash,
        outerBoundary: IRREGULAR_GEOMETRY.outerBoundary,
        walls: IRREGULAR_GEOMETRY.walls,
      });

      expect(() => verifyCadGeometryReceipt({
        ...IRREGULAR_GEOMETRY,
        walls: [{ x1: 0, y1: 0, x2: 1, y2: 1 }],
        sourcePath,
        geometryReceiptPath: receiptPath,
      })).toThrow(/geometry changed/i);

      fs.writeFileSync(sourcePath, Buffer.from('source image v2'));
      expect(() => hydrateCadGeometryFromReceipt({ geometryReceiptPath: receiptPath })).toThrow(/source image changed/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not make a receipt executable from an approval flag with a low comparison score', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_cad_low_score_'));
    try {
      const sourcePath = path.join(dir, 'source.png');
      fs.writeFileSync(sourcePath, Buffer.from('source image'));
      const validation = validateCadGeometry(IRREGULAR_GEOMETRY, { sourceGrounded: true });
      const { receipt, receiptPath } = writeCadGeometryReceipt({
        sourcePath,
        geometry: IRREGULAR_GEOMETRY,
        validation,
        visualVerification: { ...APPROVED_VISUAL, score: 0.5 },
        outputDirectory: dir,
      });

      expect(receipt.draftReady).toBe(false);
      expect(() => hydrateCadGeometryFromReceipt({ geometryReceiptPath: receiptPath })).toThrow(/did not pass source comparison/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
