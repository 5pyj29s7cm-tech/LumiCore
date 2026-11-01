import { affirmativeActionInstructionClauses } from './action_instruction_clauses';
import { isCurrentClientDiagnosticRequest } from './tool_intent';
import { resultTaskText, isChineseText } from './result_finalizer_support';
import { toolRecordSucceeded } from './task_execution_ledger';
import { CN_REPORTED_EXECUTION_MESSAGES } from '../regions/messages/reported_execution_messages';
import { omitObservedSourceBlocks } from '../work_product/completion_guard';
import { actualDocumentReadContent, documentReadMatchesRequestedTarget, isSuccessfulExactDocumentRead } from './action_desktop_evidence';
import { isVerifiedCurrentTurnRecord } from './result_finalizer_support';
import type { LumiResultFinalizerInput, LumiResultFinalizerResult } from './result_finalizer_types';

/** Current receipts do not establish an earlier self-check. Quotes remain source data. */
export function guardReportedDiagnosticClaims(input: LumiResultFinalizerInput): LumiResultFinalizerResult | null {
  const task = resultTaskText(input);
  const sourceBodies = (input.toolRecords || []).filter(record => isVerifiedCurrentTurnRecord(input, record)
    && isSuccessfulExactDocumentRead(record) && documentReadMatchesRequestedTarget(record, task,
      input.flow?.acceptedTaskTarget, input.flow?.currentAttachmentPaths)).map(actualDocumentReadContent);
  const clauses = affirmativeActionInstructionClauses(omitObservedSourceBlocks(input.responseText || '', sourceBodies));
  const chinese = isChineseText(task) || isChineseText(input.responseText);
  const currentCheck = isCurrentClientDiagnosticRequest(task);
  // i18n-allow: Past diagnostic assertions, not quoted/negated explanations or new authorization.
  const prior = clauses.some(({ probe }) => /(?:刚才|之前|上次|刚刚)[^。！？!?\n]{0,20}(?:在跑|跑了|做了|完成了?|已经完成)[^。！？!?\n]{0,12}(?:自检|健康检查)|\b(?:earlier|previously)[^.!?\n]{0,40}(?:ran|running|completed)[^.!?\n]{0,20}(?:self[- ]?check|diagnostics?)\b/iu.test(probe));
  if (prior && !currentCheck) return {
    text: chinese ? CN_REPORTED_EXECUTION_MESSAGES.priorDiagnostic : 'No verified historical diagnostic record supports that earlier self-check claim.',
    blocked: true, reason: 'Claimed prior diagnostic run without matching diagnostic receipts.',
  };
  if (currentCheck) return null; // The current diagnostic presenter owns partial/failed receipts.
  const missing = new Set<string>();
  for (const { text, probe } of clauses) {
    // Tool identifiers inside backticks are operands only when the surrounding prose asserts execution.
    // i18n-allow: First-person completed diagnostic execution grammar.
    if (!/(?:我|我们)?(?:已经|已)(?:运行|执行|调用)|\b(?:I|we)\s+(?:have\s+)?(?:ran|run|executed|called)\b/iu.test(probe)) continue;
    for (const name of text.match(/\b(?:client_health_check|client_get_state|adapter_registry_list|adapter_health_check|runtime_work_status)\b/gu) || []) {
      if (!(input.toolRecords || []).some(record => record.name === name && toolRecordSucceeded(record))) missing.add(name);
    }
  }
  if (!missing.size) return null;
  return { text: chinese ? CN_REPORTED_EXECUTION_MESSAGES.missingDiagnostic([...missing])
    : `No successful records confirm these diagnostic checks: ${[...missing].join(', ')}.`,
  blocked: true, reason: 'Claimed diagnostic tool run without matching tool records.' };
}
