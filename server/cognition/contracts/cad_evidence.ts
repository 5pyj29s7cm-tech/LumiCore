import type { ToolExecutionRecord } from "../../tools/types";
import { parseRecordJson } from "../action_contract_support";

export function hasGroundedCadGeometryEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => {
    if (record.name === 'cad_draw_floorplan_in_autocad') {
      const payload = parseRecordJson(record);
      return !record.error
        && payload?.status === 'completed'
        && Boolean(String(payload?.geometryReceiptPath || '').trim())
        && Boolean(String(payload?.geometryHash || '').trim());
    }
    if (record.name === 'floorplan_extract_geometry') {
      const payload = parseRecordJson(record);
      const geometry = payload?.cadGenerateDxfArgs && typeof payload.cadGenerateDxfArgs === 'object'
        ? payload.cadGenerateDxfArgs
        : payload;
      const width = Number(geometry?.width ?? payload?.geometryReview?.width);
      const height = Number(geometry?.height ?? payload?.geometryReview?.height);
      const geometryCount = [geometry?.walls, geometry?.rooms, geometry?.doors, geometry?.windows]
        .reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0)
        + Number(payload?.geometryReview?.counts?.outerBoundary || 0)
        + Number(payload?.geometryReview?.counts?.walls || 0)
        + Number(payload?.geometryReview?.counts?.rooms || 0)
        + Number(payload?.geometryReview?.counts?.doors || 0)
        + Number(payload?.geometryReview?.counts?.windows || 0);
      return payload?.geometryReady === true
        && payload?.geometryVerified === true
        && Boolean(String(payload?.geometryReceiptPath || '').trim())
        && width > 0 && height > 0 && geometryCount > 0
        && !/No configured vision model|not available|failed|blocked/i.test(String(record.result || ''));
    }
    if (!/^(?:cad_generate_dxf|cad_prepare_autocad_operations)$/i.test(record.name)) return false;
    const args = record.arguments || {};
    const payload = parseRecordJson(record);
    const geometryCount = [args.walls, args.polylines, args.rooms, args.doors, args.windows]
      .reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0)
      + (Array.isArray(args.outerBoundary) ? args.outerBoundary.length : 0)
      + Number(payload?.outerBoundaryPointCount || 0)
      + Number(payload?.operationCount || 0);
    return Boolean(String(args.sourcePath || payload?.sourcePath || payload?.geometryReceiptPath || '').trim())
      && geometryCount > 0
      && payload?.geometryVerified === true
      && payload?.geometryValidation?.passed === true
      && Boolean(String(payload?.geometryReceiptPath || '').trim());
  });
}

export function hasVerifiedCadGeometryExtractionEvidence(
  records: ToolExecutionRecord[] = [],
): boolean {
  return records.some(record => {
    if (
      record.error
      || record.name !== 'floorplan_extract_geometry'
      || !String(record.result || '').trim()
    ) return false;
    const payload = parseRecordJson(record);
    return payload?.parsed !== false
      && payload?.geometryReady === true
      && payload?.geometryVerified === true
      && payload?.executableGeometryAvailable !== false
      && Boolean(String(payload?.geometryReceiptPath || '').trim());
  });
}
