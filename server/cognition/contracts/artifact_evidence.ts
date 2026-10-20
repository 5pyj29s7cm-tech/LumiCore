import type { ToolExecutionRecord } from "../../tools/types";
import type { ActionIntentAnalysis } from "../normalized_action_intent";
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { LumiActionContract } from './contracts';
import { buildArtifactRetrievalContract } from './artifact_contracts';
import { artifactRecordMatchesTurn, isArtifactDeliveryRecord, artifactPathFromRecord, sameArtifactPath } from "../../tools/artifact_evidence";
import { projectArtifactProgress } from "../artifact_progress";
import { matchesRequestedArtifactOutput } from "../artifact_write_scope";
import { parseRecordJson, expandSuccessfulRecords } from "../action_contract_support";
import { requiresArtifactPostWriteReadback, requiresArtifactOpen } from "../action_request";
import { hasRequestedDesktopOpenEvidence } from "../action_desktop_evidence";
import { isPreparationOnlyTool } from './receipt_evidence';

export function getArtifactTaskProgress(task: string, records: ToolExecutionRecord[], turn: { requestId?: string; taskId?: string } = {}, analysis?: ActionIntentAnalysis) {
  const current = expandSuccessfulRecords(records).filter(record => artifactRecordMatchesTurn(record, turn));
  return projectArtifactProgress(task, current, {
    readbackRequired: requiresArtifactPostWriteReadback(task),
    openRequired: requiresArtifactOpen(task),
    openVerified: file => hasRequestedDesktopOpenEvidence(current, task, file, analysis),
    acceptsOutput: file => matchesRequestedArtifactOutput(task, file, analysis),
  });
}

export function hasArtifactVerification(records: ToolExecutionRecord[]): boolean {
  return records.some(record => {
    if (record.name === 'work_product_verify') {
      const payload = parseRecordJson(record);
      return payload?.status === 'pass' || /"status"\s*:\s*"pass"/i.test(record.result);
    }
    if (record.name === 'desktop_path_info') {
      const payload = parseRecordJson(record);
      return (payload?.exists === true && Number(payload?.size ?? payload?.sizeBytes ?? 1) > 0)
        || /"exists"\s*:\s*true/i.test(record.result) && !/"(?:size|sizeBytes)"\s*:\s*0\b/i.test(record.result);
    }
    return false;
  });
}

export function hasCreatedArtifact(records: ToolExecutionRecord[], namePattern: RegExp): boolean {
  return records.some(record => {
    if (!namePattern.test(record.name) || isPreparationOnlyTool(record.name)) return false;
    const result = String(record.result || '');
    return /(?:[A-Za-z]:\\|\/[^\s"']+|\bpath\b|\bfile\b|\bsaved\b|\bcreated\b|\boutput\b|\burl\b)/i.test(result)
      && !/(?:prompt\s*only|draft\s*only|not\s+(?:created|generated)|missing|failed|blocked)/i.test(result);
  });
}

export function hasSourceInspectionEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => /^(?:read_file|read_files_batch|read_pdf|read_docx|extract_document_text|ocr_image_file|floorplan_extract_geometry|cad_draw_floorplan_in_autocad)$/i.test(record.name));
}

/** Existing-output handoff evidence never substitutes for a new artifact producer. */
export function resolveVerifiedArtifactRetrieval(task: string, contract: LumiActionContract, records: ToolExecutionRecord[], turn: { requestId?: string; taskId?: string } = {}): { record: ToolExecutionRecord; outputPath: string } | null {
  if (contract.kind !== 'artifact_work' || contract.artifactMode !== 'retrieve' || !contract.artifactTarget || (!turn.requestId && !turn.taskId)) return null;
  const requested = buildArtifactRetrievalContract(task)?.artifactTarget;
  if (!requested || requested.id !== contract.artifactTarget.id || requested.revision !== contract.artifactTarget.revision) return null;
  for (const record of [...records].reverse()) {
    if (!artifactRecordMatchesTurn(record, turn) || record.capability?.operation !== 'observe' || record.arguments?.includeOutput !== true || !isArtifactDeliveryRecord(record)) continue;
    const payload = parseRecordJson(record), outputPath = artifactPathFromRecord(record);
    if (!payload || !outputPath || String(record.arguments.projectId || '').toLowerCase() !== requested.id || String(payload.projectId || '').toLowerCase() !== requested.id
      || !Number.isSafeInteger(payload.revision) || payload.revision < 1 || (record.arguments.revision !== undefined && record.arguments.revision !== payload.revision)
      || (requested.revision !== undefined && (record.arguments.revision !== requested.revision || payload.revision !== requested.revision))
      || !Array.isArray(payload.artifacts) || payload.artifacts.length !== 1) continue;
    const artifact = payload.artifacts[0];
    if (!sameArtifactPath(String(artifact?.path || ''), outputPath)) continue;
    try {
      const stat = fs.statSync(outputPath);
      if (!stat.isFile() || stat.size !== artifact.size || createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex') !== artifact.sha256) continue;
    } catch { continue; }
    return { record, outputPath };
  }
  return null;
}
