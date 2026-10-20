import { CN_ACTION_CONTRACT_COPY } from '../../regions/messages/action_contract_copy';
import { LEGAL_ENTRY_PREFERRED_TOOLS } from "../legal_entry";
import type { LumiActionContract } from './contracts';
import { withDefaults } from './contracts';
import { hasRequestedArtifactMutation } from '../tool_intent';

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
    coreAction: 'Read complete source text without mutation: local files use the exact user-named absolute path; knowledge sources use the original current-turn fileIds in the current authorized scope. Answer only from the complete verified source text. For each question retain the original source qualifier and state only what it establishes: unproven P leaves P unknown, not proven not-P. Preserve the speaker, scope of negation and plans; an exact quote cannot justify a contrary conclusion.',
    preparationIsNotCompletion: [
      'listing a directory or searching for a possible file',
      'reading a model-selected path that the user did not name',
      'returning only file metadata, knowledge inventory, or truncated excerpts without complete source text',
      'reading a source file before an unfinished create, write, or edit action',
    ],
    requiredEvidence: [
      'verified read_file receipt for the user-named absolute local path, or verified knowledge_file_stats mode=source_text receipt for the original fileIds in the current authorized scope',
      'non-empty complete source text from that receipt, matching the current source revisions',
    ],
    preferredTools: ['read_file', 'knowledge_file_stats'],
    verificationTools: ['read_file', 'knowledge_file_stats'],
    nextStep: 'Use read_file for an exact user-named local absolute path, or knowledge_file_stats with the original current-turn fileIds for knowledge sources. A verified read proves retrieval only.',
    caution: 'A knowledge fileId is not a local path. Never guess its directory. A local basename, directory search, guessed path, knowledge inventory, truncated source, or preparatory read cannot complete this contract.',
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

/** A single explicit existing-file handoff; excluded actions remain excluded, not a new production goal. */
export function buildArtifactRetrievalContract(input: string): LumiActionContract | null {
  // i18n-allow: bounded multilingual prohibition clauses, preserving later affirmative work.
  const text = String(input || '').replace(/(^|[，,。；;\n])\s*(?:请\s*)?(?:不要|别|无需|不用|不需要|禁止|请勿|\bdo\s+not\b|\bdon't\b|\bwithout\b)[^，,。；;\n]*?(?=[，,。；;\n]|但是|但|然后|随后|之后|接着|\bbut\b|\bthen\b|$)/giu, '$1 ');
  // i18n-allow: shared past-state input grammar.
  const existingState = /已(?:经)?(?:[^，,。；;\n、的]{1,12}的|生成|制作|完成)|\b(?:already|previously)(?:\s+\w+(?:ed|en))?\b/giu;
  // i18n-allow: explicit return-as-attachment goal and bounded single-object scope.
  if (!/^(?:\s*(?:请|麻烦)?(?:帮我)?(?:把|将|返回|取回|提供|交付)|\s*(?:please\s+)?(?:return|retrieve|provide)\b)/iu.test(text)
    || (!/(?:已有|现有|已经有|\bexisting\b)/iu.test(text) && !existingState.test(text))
    // i18n-allow: input grammar requiring an explicit attachment return.
    || !/(?:附件[^。；;\n]{0,12}(?:返回|取回|提供|交付|发(?:回|到|在)?(?:这里|当前聊天|本次聊天))|(?:返回|取回|提供|交付)[^。；;\n]{0,24}附件|\b(?:return|retrieve|provide)\b[^.;\n]{0,120}\battachment\b|\battachment\b[^.;\n]{0,40}\b(?:return|retrieve|provide)\b)/iu.test(text)
    // i18n-allow: reject multi-object retrieval requests.
    || /(?:所有|全部|多个|多份|两(?:个|份)|三个|三份|另一|另外|第二|\b(?:all|both|two|three|multiple|another|other|additional)\b)/iu.test(text)) return null;
  // i18n-allow: past object state is not a new action.
  const remaining = text.replace(/可(?:播放|下载)(?:或(?:播放|下载))?(?=的[^。；;\n]{0,12}附件)/giu, ' ').replace(existingState, ' ');
  if (hasRequestedArtifactMutation(remaining) || /(?:调整|渲染|打开|发送|发给|发布|上传|提交|签署|签名|签字|签章|签付|盖章|付款|支付|缴费|转账|分析|总结|翻译|计算|审查|播放|运行|执行|安装|下载)|\b(?:make|change|render|open|send|publish|upload|submit|sign|pay|analyze|analyse|summarize|translate|calculate|review|play|download)(?:s|d|ed|ing)?\b|\b(?:generate|create|modify|send|publish|sign|pay|open|export)[_-][a-z]/iu.test(remaining)) return null;
  const ids = [...new Set(text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/giu)?.map(id => id.toLowerCase()) || [])];
  // i18n-allow: explicit requested project revision number.
  const revisions = [...new Set([...text.matchAll(/(?:第\s*(\d+)\s*版|\brevision\s*[:=#]?\s*(\d+))/giu)].map(match => Number(match[1] || match[2])))];
  if (ids.length !== 1 || revisions.length > 1 || revisions.some(value => !Number.isSafeInteger(value) || value < 1)) return null;
  return { ...buildArtifactWorkContract(), artifactMode: 'retrieve', artifactTarget: { id: ids[0], ...(revisions.length ? { revision: revisions[0] } : {}) },
    label: 'Existing artifact retrieval', coreAction: 'Return only the explicitly requested existing selected artifact, verified against its owner, current source binding, exact identity and file hash.',
    preparationIsNotCompletion: ['capability discovery', 'a file listing', 'file metadata alone', 'an ordinary status read without explicit artifact delivery'],
    requiredEvidence: ['one current-turn verified retrieved receipt from a declared read-only artifact-delivery capability, matching the exact requested identity and revision'],
    preferredTools: [], verificationTools: [], nextStep: 'Retrieve the existing selected output once and attach that verified file. Do not render, generate, modify, send externally or replay successful retrieval.',
    caution: 'Retrieving an existing file proves only this handoff; it never proves new generation, content analysis, opening, signing, payment or external delivery.' };
}
