import type { ToolExecutionRecord } from '../tools/types';
import { isCanonicalToolExecutionRecord } from '../tools/canonical_execution_record';
import { artifactRecordMatchesTurn } from '../tools/artifact_evidence';
import { parseReceiptObject, toolRecordSucceeded } from '../tools/receipt_payload';
import { affirmativeActionInstructionClauses } from './action_instruction_clauses';
import { genericExternalCommit } from './normalized_action_intent';

/** A plan receipt supports only its own plan-generation claim, never platform work. */
export function hasCurrentLegalResearchPlanEvidence(
  records: ToolExecutionRecord[],
  current: { taskText: string; requestId?: string; taskId?: string },
  claim: string,
): boolean {
  if (!current.requestId || !current.taskId || genericExternalCommit(current.taskText)) return false;
  // i18n-allow: Explicit plan request grammar, not a source-query or permission rule.
  const planRequest = /^(?:(?:请|现在|帮我|为我)\s*)*(?:生成|制定|准备|创建)[^。！？!?;\n]{0,120}(?:检索计划|检索行动单)[，,。.!！\s]*$|^(?:please\s+)?(?:create|generate|prepare)\s+[^.!?;\n]{0,120}\bresearch\s+plan[.!\s]*$/iu;
  const requests = affirmativeActionInstructionClauses(current.taskText).filter(part => part.probe.trim());
  if (!requests.length || !requests.every(part => planRequest.test(part.probe.trim()))) return false;
  // A named file, other case, platform result, or independent side effect is
  // deliberately outside this narrow declaration. Existing guards own those.
  // i18n-allow: Plan-only terminal declaration grammar, not user-visible copy.
  const planClaim = /^(?:(?:我|我们|本轮)\s*)?已(?:经)?(?:生成|制定|准备好|创建)(?:并归档)?(?:了)?(?:授权协作|半自动|外部|法律|法务|\s)*(?:检索计划|检索行动单)[，,。.!！\s]*$|^(?:(?:I|we)\s+have\s+)?(?:created|generated|prepared)\s+(?:the\s+)?(?:(?:authorized|external|legal)\s+)*research\s+plan[.!\s]*$/iu;
  if (!planClaim.test(claim.trim())) return false;
  // i18n-allow: An archive assertion needs the separate material-write receipt.
  const archiveClaim = /归档/iu.test(claim);
  return records.some(record => {
    if (record.name !== 'legal_external_research_plan' || !isCanonicalToolExecutionRecord(record)
      || !artifactRecordMatchesTurn(record, current) || !toolRecordSucceeded(record)
      || record.terminalVerification?.status !== 'verified'
      || record.capability?.capabilityId !== 'legal.external-research-plan.create'
      || record.capability.operation !== 'create') return false;
    const receipt = parseReceiptObject(record.receipt);
    if (receipt?.ok !== true || receipt.status !== 'planned' || !String(receipt.content || '').trim()
      || receipt.content !== record.result || !Array.isArray(receipt.changedCaseIds)
      || !Array.isArray(receipt.materialSources) || !Array.isArray(receipt.artifacts)) return false;
    const requestedCase = String(record.arguments.caseId || '').trim();
    if (requestedCase && record.arguments.persistCase !== false && !receipt.changedCaseIds.includes(requestedCase)) return false;
    return !archiveClaim || receipt.persisted === true && receipt.changedCaseIds.length > 0
      && receipt.materialSources.some((source: any) => receipt.changedCaseIds.includes(source.caseId)
        && (!requestedCase || source.caseId === requestedCase) && typeof source.materialId === 'string' && source.materialId
        && /^[a-f0-9]{64}$/u.test(source.sourceDigest));
  });
}
