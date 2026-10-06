import { CN_ACTION_CONTRACT_COPY } from '../../regions/messages/action_contract_copy';
import { LEGAL_ENTRY_PREFERRED_TOOLS } from "../legal_entry";
import type { LumiActionContract } from './contracts';
import { withDefaults } from './contracts';

export function buildCadGeometryExtractionContract(): LumiActionContract {
  return withDefaults({
    kind: 'cad_drafting',
    label: 'CAD source-geometry extraction',
    coreAction: 'Extract verified structured geometry from the requested source image without drawing or generating a CAD deliverable',
    preparationIsNotCompletion: [
      'only locating or listing the source image',
      'OCR or visual description without executable geometry',
      'partial, truncated, or schema-incomplete model output',
    ],
    requiredEvidence: [
      'floorplan_extract_geometry result with geometryReady=true and geometryVerified=true',
      'a nonempty server-owned geometryReceiptPath from that same result',
    ],
    preferredTools: ['desktop_list_files', 'desktop_system_info', 'floorplan_extract_geometry'],
    verificationTools: ['floorplan_extract_geometry'],
    nextStep: 'If extraction is not verified, report failedStage, parseError, and next from the geometry receipt; retry the same source or a clearer crop without inventing partial geometry.',
    caution: 'Do not require an active application window and do not claim drawing or CAD generation. A listed file, OCR text, or partial geometry is not successful extraction.',
  });
}

export function buildLegalDocumentContract(): LumiActionContract {
  return withDefaults({
    kind: 'legal_document',
    label: CN_ACTION_CONTRACT_COPY.legalDocument.label,
    coreAction: CN_ACTION_CONTRACT_COPY.legalDocument.coreAction,
    preparationIsNotCompletion: [...CN_ACTION_CONTRACT_COPY.legalDocument.preparationIsNotCompletion],
    requiredEvidence: [...CN_ACTION_CONTRACT_COPY.legalDocument.requiredEvidence],
    preferredTools: LEGAL_ENTRY_PREFERRED_TOOLS,
    verificationTools: ['legal_case_reasoning_matrix', 'legal_authority_source_status', 'legal_refresh_authoritative_sources', 'legal_generate_citation_verification_report', 'legal_finalize_delivery_package', 'legal_search_statute', 'read_docx', 'read_pdf', 'desktop_path_info', 'work_product_verify'],
    nextStep: CN_ACTION_CONTRACT_COPY.legalDocument.nextStep,
    caution: 'Do not present general legal guidance as a complete formal argument. External court, case-law, and company-research platforms support authorized collaboration, result archiving, and pre-delivery verification only. Material legal decisions require review by a qualified lawyer.',
  });
}

export function buildArtifactWorkContract(): LumiActionContract {
  return withDefaults({
    kind: 'artifact_work',
    label: CN_ACTION_CONTRACT_COPY.artifactWork.label,
    coreAction: CN_ACTION_CONTRACT_COPY.artifactWork.coreAction,
    preparationIsNotCompletion: [...CN_ACTION_CONTRACT_COPY.artifactWork.preparationIsNotCompletion],
    requiredEvidence: [...CN_ACTION_CONTRACT_COPY.artifactWork.requiredEvidence],
    preferredTools: ['write_file', 'desktop_write_text_file', 'create_docx', 'create_ppt', 'create_pdf', 'desktop_path_info', 'work_product_verify'],
    verificationTools: ['desktop_path_info', 'work_product_verify'],
    nextStep: CN_ACTION_CONTRACT_COPY.artifactWork.nextStep,
    caution: CN_ACTION_CONTRACT_COPY.artifactWork.caution,
  });
}

export function buildReadOnlyArtifactInspectionContract(): LumiActionContract {
  return withDefaults({
    kind: 'artifact_work',
    label: 'Exact read-only file inspection',
    coreAction: 'Read semantic content from the one exact absolute file path named by the user without mutating it.',
    preparationIsNotCompletion: [
      'listing a directory or searching for a possible file',
      'reading a model-selected path that the user did not name',
      'returning file metadata without semantic content',
      'reading a source file before an unfinished create, write, or edit action',
    ],
    requiredEvidence: [
      'verified read_file receipt for the same absolute path present in the accepted user task',
      'non-empty semantic file content from that receipt',
    ],
    preferredTools: ['read_file'],
    verificationTools: ['read_file'],
    nextStep: 'Read only the exact user-anchored file and answer from its verified semantic content.',
    caution: 'A basename, directory search, guessed path, metadata-only result, or preparatory read cannot complete this contract.',
  });
}

export function buildDesignDeliveryContract(): LumiActionContract {
  return withDefaults({
    kind: 'design_delivery',
    label: 'Design delivery',
    coreAction: 'Inspect the real brief and source materials, create every requested design/CAD/BIM/document output through the corresponding production tools, and verify each deliverable.',
    preparationIsNotCompletion: [
      'a generic design package built from defaults',
      'a concept DXF presented as a construction drawing',
      'a Dynamo handoff script presented as a Revit model',
      'prompts presented as finished visuals',
      'one file presented as a complete multi-output delivery',
    ],
    requiredEvidence: [
      'source brief/files were inspected when the task depends on supplied materials',
      'each requested output group has a real artifact or application result',
      'visible AutoCAD requests have MCP/COM completion-marker evidence',
      'Revit/BIM requests have a real model/export/application result, not a handoff script',
      'artifacts pass path/content verification and assumptions are disclosed',
    ],
    preferredTools: [
      'desktop_list_files',
      'read_file',
      'read_pdf',
      'ocr_image_file',
      'floorplan_extract_geometry',
      'generate_image',
      'cad_generate_dxf',
      'cad_prepare_autocad_operations',
      'mcp_cad-drafting_autocad_playback_file',
      'create_ppt',
      'create_pdf',
      'create_docx',
      'adapter_execute',
      'work_product_verify',
    ],
    verificationTools: ['work_product_verify', 'desktop_path_info', 'desktop_capture_screen', 'adapter_health_check'],
    nextStep: 'Inspect the supplied brief and files, enumerate the requested deliverable groups, produce each through its real tool path, and verify the complete set before reporting completion.',
    caution: 'Concept files, scripts, previews, and local package integrity checks do not prove a professional design, AutoCAD, or Revit delivery was completed.',
  });
}
