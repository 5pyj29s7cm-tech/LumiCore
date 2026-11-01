import { actualDocumentReadContent } from './action_desktop_evidence';

import { documentReadMatchesRequestedTarget, isSuccessfulExactDocumentRead, extractPrimaryTaskText } from './action_contract';
import { CN_EXECUTION_EVIDENCE_MESSAGES } from "../regions/messages/execution_evidence_messages";
import { hasRequestedArtifactMutation } from './tool_intent';
import { formatVerifiedTaskResultForReadability } from './reply_style';
import { CN_RESULT_GROUNDING_MESSAGES } from "../regions/messages/voice_fast_path_messages";
import { containsCompactToolEvidenceMarker } from '../conversation/summary_grounding';
import { guardCompletionClaims } from '../work_product/completion_guard';

import { type LumiResultFinalizerInput, type LumiResultFinalizerResult } from "./result_finalizer_types";
import { resultTaskText, isVerifiedCurrentTurnRecord, taskActionContract, hasResultCoreActionEvidence, isChineseText, isInternalRuntimeWorkNarration } from "./result_finalizer_support";

export const VERIFIED_DOCUMENT_OBSERVATION_TOOL_RE = /^(?:read_file|read_files_batch|read_pdf|read_docx|read_xlsx|pdf_to_text|extract_document_text|ocr_image_file)$/iu;

function matchingVerifiedDocumentReads(input: LumiResultFinalizerInput) {
  return (input.toolRecords || []).filter(candidate => (
    isVerifiedCurrentTurnRecord(input, candidate)
    && isSuccessfulExactDocumentRead(candidate)
    && documentReadMatchesRequestedTarget(candidate, resultTaskText(input), input.flow?.acceptedTaskTarget, input.flow?.currentAttachmentPaths)
  ));
}

export function groundedVerifiedDocumentObservation(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const task = resultTaskText(input);
  // i18n-allow: Chinese read-only document intent recognition; not user-visible copy.
  if (!/(?:读取|阅读|查看|看看|分析|审查|审阅|总结|概括|附件|文件|文档|PDF|\b(?:read|review|inspect|analy[sz]e|summari[sz]e|attachment|document|file)\b)/iu.test(task)) {
    return null;
  }
  // i18n-allow: Chinese document-mutation intent recognition; not user-visible copy.
  if (hasRequestedArtifactMutation(task)) {
    return null;
  }
  const record = matchingVerifiedDocumentReads(input).at(-1);
  if (!record) return null;
  // A successful read cannot erase a downstream delivery/claim failure.
  // In particular, preserve a blocked shared-loop verdict instead of saving
  // its "not complete" text under a completed assistant receipt.
  if (input.completionGuard?.blocked) return { ...input.completionGuard };
  const contract = taskActionContract(input);
  if (contract.applies && !hasResultCoreActionEvidence(input, contract, input.toolRecords || [], task)) return null;
  const response = String(input.responseText || '').trim();
  const rawReadOnly = response.replace(/\s+/gu, '') === actualDocumentReadContent(record).replace(/\s+/gu, '');
  // Source text is data, including any execution claims it quotes. The model's
  // own surrounding prose still needs the shared current-turn claim checks;
  // a finished read cannot prove that another action was sent, saved or started.
  if (!rawReadOnly) {
    const claimGuard = guardCompletionClaims({ task, response, toolCalls: input.toolRecords,
      source: input.source, requestId: input.requestId, taskId: input.taskId,
      acceptedTaskTarget: input.flow?.acceptedTaskTarget, acceptedActionContract: input.flow?.acceptedActionContract,
      claimsOnly: true });
    if (claimGuard.blocked) return claimGuard;
  }
  const unusableNarration = !response
    || !rawReadOnly && (isInternalRuntimeWorkNarration(response)
    // i18n-allow: Chinese stale/internal blocked-result recognition; not user-visible copy.
    || /(?:^|\n)\s*(?:状态\s*[：:]\s*(?:受阻|失败)|这(?:次|项操作)还没完成|没有取得可用的分析结果)|(?:尚未|还没|没有|未能|无法).{0,16}(?:完成|算出|计算|给出结果)|\b(?:blocked|execution_recovery_incomplete|not (?:yet )?complete|no (?:usable )?result)\b/iu.test(response));
  // A verified read is terminal for a plain read/view request. It is only an
  // intermediate step when the user asked Lumi to interpret or synthesize the
  // document and no usable analysis prose was produced.
  // i18n-allow: Chinese document-analysis intent recognition; not user-visible copy.
  const instruction = [extractPrimaryTaskText(task), input.flow?.rootTaskText || ''].join('\n');
  const calculationRequested = /(?:计算|重算|算出|金额|总额|合计|\b(?:calculat\w*|recalculat\w*|total|multiply)\b)/iu.test(instruction); // i18n-allow: document calculation intent.
  const analysisRequested = calculationRequested || /(?:分析|审查|审阅|总结|概括|提炼|解读|\b(?:review|analy[sz]e|summari[sz]e|interpret|synthesize|explain)\b)/iu.test(instruction);
  const calculationOutput = /(?:金额|总额|合计|总计|结果|[=×]|\b(?:amount|total|result)\b)[^\r\n]{0,100}(?:\d|[零一二三四五六七八九十百千万])|^\s*[-+]?\d+(?:\.\d+)?\s*(?:元|美元|USD|CNY)?[。.!！]?\s*$/iu.test(response); // i18n-allow: returned calculation data, not tool-count or path digits.
  const onlyReadAcknowledgment = /^(?:(?:已|已经|成功|完成|文件|内容|数据|读取|阅读|查看|检查|核验|验证|完毕|任务|操作|read|file|content|verified|completed|successfully|done)|[\s。.!！,，:：;；-])+$/iu.test(response);
  const analysisMissing = analysisRequested && (unusableNarration || onlyReadAcknowledgment || rawReadOnly || (calculationRequested && !calculationOutput));
  return {
    text: unusableNarration || analysisMissing || (onlyReadAcknowledgment && !analysisRequested)
      ? analysisMissing
        ? (isChineseText(task)
            ? CN_EXECUTION_EVIDENCE_MESSAGES.verifiedDocumentReadWithoutAnalysis
            : 'The file content was read successfully, but no analysis result was generated. Only the read step is verified; the overall analysis is not complete.')
        : actualDocumentReadContent(record)
      : formatVerifiedTaskResultForReadability(response),
    blocked: analysisMissing,
    reason: analysisMissing
      ? 'Verified document read completed, but no usable analysis was generated.'
      : 'Grounded read-only document observation from a verified current-turn receipt.',
  };
}

export function leakedLegacyToolProtocol(input: LumiResultFinalizerInput): LumiResultFinalizerResult | null {
  const raw = String(input.responseText || '').trim();
  // Exact, target-bound source contents are a literal read result, not a new
  // model tool request. Do not grant this exception to generated output or to
  // surrounding model prose merely because some read receipt exists.
  if (!hasRequestedArtifactMutation(resultTaskText(input))
    && matchingVerifiedDocumentReads(input).some(record => raw === actualDocumentReadContent(record).trim())) return null;
  // A marker in model prose is not an execution receipt. With actual records,
  // their existing current-turn/target validators own the result instead.
  if (!(input.toolRecords || []).length && containsCompactToolEvidenceMarker(raw)) {
    return {
      text: isChineseText(resultTaskText(input)) || isChineseText(raw)
        ? CN_RESULT_GROUNDING_MESSAGES.actionNotStarted
        : 'No verified execution result supports this response.',
      blocked: true,
      reason: 'Model output contained a reserved server receipt marker without any tool records.',
    };
  }
  const hasXmlProtocol = /<(?:[|｜]{1,2}DSML[|｜]{1,2})?(?:function_calls|tool_calls|invoke)\b/iu.test(raw);
  const hasFencedToolProtocol = /```\s*(?:tool|tools|tool_call|tool_calls|function_call|function_calls)\b/i.test(raw);
  // i18n-allow: Chinese internal tool-protocol recognition; not user-visible copy.
  const hasBracketProtocol = /\[(?:[^\]\r\n]{1,48})\]\s*[A-Za-z][A-Za-z0-9_.:-]{1,127}\s*\([^\r\n)]*\)|\[(?:调用|call(?:ing)?|tool)\s+[A-Za-z][A-Za-z0-9_.:-]{1,127}\s*\](?:\s*\{)?/iu.test(raw);
  if (!hasXmlProtocol && !hasFencedToolProtocol && !hasBracketProtocol) return null;
  const names = Array.from(raw.matchAll(/<(?:[|｜]{1,2}DSML[|｜]{1,2})?invoke\s+name=["']([^"']+)["']/giu), match => match[1]);
  const clientStateRequested = names.includes('client_get_state');
  const chinese = isChineseText(resultTaskText(input));
  const text = chinese
    ? clientStateRequested
      ? CN_RESULT_GROUNDING_MESSAGES.clientStateProtocolBlocked
      : CN_RESULT_GROUNDING_MESSAGES.toolProtocolBlocked
    : clientStateRequested
      ? 'I could not read the current client state, so I will not expose an internal tool request as the answer.'
      : 'The tool request was not executed; its internal protocol text was blocked.';
  return {
    text,
    blocked: true,
    reason: 'Legacy tool-call protocol leaked into assistant text.',
    notification: {
      type: 'work_product_guard',
      level: 'warning',
      message: 'Legacy tool-call protocol leaked into assistant text.',
    },
  };
}
