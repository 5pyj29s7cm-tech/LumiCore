import { describe, expect, it } from 'vitest';
import {
  buildDrawingIngestQa,
  buildIfcSpaceAuditPlan,
  buildRevitReadOnlyPlan,
  buildSiteSurveyReport,
  normalizeFfeSchedule,
} from '../server/skills/bundled/design-studio-pack/interior_delivery';

describe('spatial and interior delivery skill', () => {
  it('does not approve drawing geometry without source dimensions and provenance', () => {
    const result = buildDrawingIngestQa({
      projectName: 'Apartment A',
      sources: ['plan-scan.pdf'],
    });

    expect(result.status).toBe('needs_review');
    expect(result.evidenceGaps).toEqual(expect.arrayContaining([
      'No independently verified dimension was supplied for scale calibration.',
      'No survey provenance, issue date, or drawing revision was supplied.',
    ]));
    expect(result.toolSequence.join(' ')).toContain('mcp_paddleocr-local_pp_structurev3');
  });

  it('does not treat negated Chinese evidence or total area as verified geometry', () => {
    const result = buildDrawingIngestQa({
      projectName: '澄境样板间',
      sources: ['无实测平面图源文件', '当前仅有三室两厅需求文字'],
      knownDimensions: '无已核验尺寸；120平方米仅为总面积',
      evidenceNotes: '无图名、出图日期、版本、比例尺或测绘来源',
    });

    expect(result.status).toBe('needs_review');
    expect(result.sources).toEqual([]);
    expect(result.knownDimensions).toEqual([]);
    expect(result.evidenceGaps).toHaveLength(3);
    expect(result.rejectedEvidenceClaims.join(' ')).toContain('120平方米');
  });

  it('accepts an actual source reference and independently verified linear dimensions', () => {
    const result = buildDrawingIngestQa({
      projectName: 'Measured apartment',
      sources: ['survey-rev-b.pdf'],
      knownDimensions: 'north wall 9000 x 7600 mm',
      evidenceNotes: 'Site survey by Li on 2026-08-15; drawing revision B.',
    });

    expect(result.status).toBe('ready_for_geometry_extraction');
    expect(result.knownDimensions).toEqual(['north wall 9000 x 7600 mm']);
    expect(result.evidenceGaps).toEqual([]);
  });

  it('keeps IFC and Revit work read-only with explicit stop conditions', () => {
    const ifc = buildIfcSpaceAuditPlan({ modelPath: 'project/model.ifc' });
    const revit = buildRevitReadOnlyPlan({ objective: 'Check room finishes' });

    expect(ifc.prohibitedOperations).toEqual(expect.arrayContaining(['ifc_save', 'ifc_edit']));
    expect(ifc.readOnlyToolSequence.join(' ')).toContain('mcp_ifc-readonly_ifc_validate');
    expect(revit.mode).toBe('read-only');
    expect(revit.blockedOperations).toContain('revit_send_code_to_revit');
    expect(revit.stopConditions.length).toBeGreaterThan(0);
  });

  it('normalizes FF&E records without losing or converting source fields', () => {
    const result = normalizeFfeSchedule({
      defaultCurrency: 'cny',
      recordsJson: JSON.stringify([{
        code: 'CH-01',
        name: 'Dining chair',
        category: 'furniture',
        size: '520 x 560 x 780 mm',
        price: '1280.00',
        customField: 'retain me',
      }]),
    });

    expect(result.status).toBe('normalized_for_review');
    expect(result.records[0]).toMatchObject({
      itemCode: 'CH-01',
      dimensions: '520 x 560 x 780 mm',
      unitPrice: '1280.00',
      currency: 'CNY',
    });
    expect(result.records[0].sourceRecord).toMatchObject({ customField: 'retain me' });
  });

  it('separates observed site facts from reported information', () => {
    const report = buildSiteSurveyReport({
      projectName: 'Office B',
      observations: ['Column measured on site'],
      reportedInfo: ['Property manager says the ceiling void is accessible'],
      photos: ['IMG_001 - column'],
    });

    expect(report.status).toBe('draft_for_review');
    expect(report.directObservations).toEqual(['Column measured on site']);
    expect(report.reportedButNotObserved).toEqual(['Property manager says the ceiling void is accessible']);
  });
});
