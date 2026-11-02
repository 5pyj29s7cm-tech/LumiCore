import { affirmativeActionInstructionClauses } from './action_instruction_clauses';
import { isCanonicalToolExecutionRecord } from '../tools/execution_engine';
import { artifactRecordMatchesTurn, sameArtifactPath } from '../tools/artifact_evidence';
import { parseReceiptObject, toolRecordSucceeded, toolRecordTerminalPayload } from '../tools/receipt_payload';
import { formatDesignerCadFiles, designerCadVerificationFailed } from '../regions/messages/design_cad_messages';
import type { LumiResultFinalizerInput, LumiResultFinalizerResult } from './result_finalizer_types';
import { resultTaskText } from './result_finalizer_support';

/** Present only the current host-verified local DXF + SVG pair and its bound workflow. */
export function formatVerifiedDesignerCadFiles(input: LumiResultFinalizerInput): LumiResultFinalizerResult | null {
  if (!input.requestId || !input.taskId || input.completionGuard?.blocked) return null;
  const task = resultTaskText(input);
  const instructions = affirmativeActionInstructionClauses(task).map(c => c.probe)
    // i18n-allow: Exact standalone customer-send prohibition in the existing CAD request; no affirmative suffix is discarded.
    .filter(clause => !/^(?:不|不要)(?:向)?客户外发[。.!！\s]*$/u.test(clause.trim()));
  // i18n-allow: Deliberately bounded affirmative grammar, not an action blacklist. Any extra clause returns to the ordinary contract guards.
  const pairRequest = /^(?:(?:请|please)\s*)?(?:(?:为|for)\s*)?(?:生成|制作|产出|generate|create)\s*(?:(?:并核验|并验证|and\s+verify)\s*)?DXF\s*(?:和|与|and|&)\s*SVG\s*(?:预览|preview)?[，。.!！\s]*$/iu;
  if (instructions.length !== 1 || !pairRequest.test(instructions[0].trim())) return null;
  const records = input.toolRecords || [];
  const cad = [...records].reverse().find(r => r.name === 'cad_generate_dxf' && artifactRecordMatchesTurn(r, input));
  const done = [...records].reverse().find(r => r.name === 'industry_workflow_complete' && artifactRecordMatchesTurn(r, input));
  if ([cad, done].some(record => record && isCanonicalToolExecutionRecord(record)
    && (!toolRecordSucceeded(record) || record.terminalVerification?.status !== 'verified'))) return {
    text: designerCadVerificationFailed(/[\u3400-\u9fff]/u.test(task) ? 'zh' : 'en'), blocked: true,
    reason: 'The latest current CAD or workflow completion record is not verified; earlier success cannot supersede it.',
  };
  if (!cad || !done || !isCanonicalToolExecutionRecord(cad) || !isCanonicalToolExecutionRecord(done)
    || records.indexOf(done) <= records.indexOf(cad)
    || !toolRecordSucceeded(cad) || !toolRecordSucceeded(done) || cad.terminalVerification?.status !== 'verified' || done.terminalVerification?.status !== 'verified'
    || cad.arguments?.openPreview === true || cad.capability?.capabilityId !== 'cad.dxf.generate'
    || cad.capability.verification.strategy !== 'artifact' || !['path', 'previewPath'].every(p => cad.capability?.verification.requiredArtifacts?.includes(p))) return null;
  const files = parseReceiptObject(toolRecordTerminalPayload(cad)); const receipt = parseReceiptObject(toolRecordTerminalPayload(done));
  const binding = receipt?.task?.metadata?.industryWorkflow;
  const projectName = task.match(/(?:为|for)\s*[“"]([^”"]+)[”"]/iu)?.[1]; // i18n-allow: explicitly named project input, never inferred from an output title.
  // The real completion handler omits archivedFilePaths on its idempotent
  // delivered-task path. Only that verified reuse can read explicit task paths.
  const archivedPaths: unknown[] = Array.isArray(receipt?.archivedFilePaths) ? receipt.archivedFilePaths
    : receipt?.reused === true && receipt.task?.status === 'delivered' && Array.isArray(receipt.task.artifacts)
      ? receipt.task.artifacts.map((artifact: any) => artifact?.path) : [];
  if (!files || files.geometryVerified !== true || files.geometryValidation?.passed !== true || files.opened !== false
    || receipt?.ok !== true || receipt.status !== 'verified' || receipt.persisted !== true || receipt.verification?.passed !== true
    || !receipt.task?.id || done.arguments?.taskId !== receipt.task.id || binding?.productLine !== 'design' || binding.entryId !== 'cad'
    || binding.requestId !== input.requestId || binding.conversationTaskId !== input.taskId
    || projectName && binding.context?.projectName !== projectName
    || !['path', 'previewPath'].every(p => typeof files[p] === 'string'
      && archivedPaths.some(v => typeof v === 'string' && sameArtifactPath(v, files[p])))) return null;
  return { text: formatDesignerCadFiles(files, receipt, /[\u3400-\u9fff]/u.test(task) ? 'zh' : 'en'), blocked: false,
    reason: 'Current host-verified DXF and SVG artifacts with the exact bound CAD workflow; no external opening or delivery.' };
}
