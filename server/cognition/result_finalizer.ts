import fs from 'node:fs';
import { guardCompletionClaims } from '../work_product/completion_guard';
import type { ToolExecutionRecord } from '../tools/types';
import type { LumiTurnFlow } from './turn_flow';
import { formatDesktopObservationResult } from './desktop_observation';
import {
  formatClientDiagnosticResult,
  hasSuccessfulSubstantiveClientDiagnosticReceipt,
} from './client_diagnostic_result';
import {
  hasExplicitNoMutationInstruction,
  isCurrentClientDiagnosticRequest,
  isDiagnosticOrRepairRequest,
} from './tool_intent';
import { CN_CAD_MESSAGES } from '../regions/packs/cn/cad_messages';
import {
  CN_VOICE_FAST_PATH_MESSAGES,
  formatCnClientActionTargetLabel,
  formatCnToolFailureDetail,
} from '../regions/packs/cn/voice_fast_path_messages';
import {
  formatArtifactCreatedAndOpened,
  formatArtifactCreatedOpenFailed,
  formatInternalDispatchUnavailable,
} from '../i18n/naturalness_messages';
import {
  CN_MESSAGING_MESSAGES,
  formatCnMessagingContractBlocker,
  formatCnUnsupportedToolExecutionClaim,
} from '../regions/packs/cn/messaging_messages';
import {
  buildActionContract,
  claimsCurrentAppSaveCompletion,
  extractExplicitArtifactTextRequirements,
  extractSimpleDesktopOpenTarget,
  extractCurrentAppTarget,
  extractRequestedCurrentAppText,
  hasAuthenticatedWebResultEvidence,
  hasBlankAutoCadDocumentEvidence,
  hasCoreActionEvidence,
  hasCurrentAppSaveEvidence,
  hasCurrentAppUiMutationEvidence,
  hasVerifiedCadGeometryExtractionEvidence,
  hasVisibleAutoCadExecutionEvidence,
  requiresCadGeometryExtractionOnly,
  requiresCurrentAppUiMutation,
  requiresAuthenticatedWebResult,
  requiresVisibleAutoCadExecution,
  summarizeActionContractBlocker,
} from './action_contract';
import { CN_RESULT_GROUNDING_MESSAGES } from '../regions/packs/cn/voice_fast_path_messages';
import { CN_EXECUTION_EVIDENCE_MESSAGES } from '../regions/packs/cn/execution_evidence_messages';
import { CN_EXTERNAL_AI_MESSAGES } from '../regions/packs/cn/external_ai_messages';
import { coalesceToolExecutionRecords, toolRecordSucceeded } from './task_execution_ledger';
import {
  hasContinuousStockWatchIntent,
  hasContinuousStockWatchEvidence,
  requiresLegalCurrentLawGate,
  claimsLegalDocumentCompletion,
  hasLegalDocumentProductionEvidence,
  hasLegalCurrentLawGateEvidence,
  hasLegalReasoningChainEvidence,
  hasLegalExternalPlatformSignal,
  describesAuthorizedLegalExternalHandoff,
  claimsExternalLegalPlatformFinalAction,
  claimsExternalLegalPlatformResult,
  hasLegalExternalPlatformResultEvidence,
} from './result_policy_evidence';

export interface LumiResultFinalizerInput {
  taskText: string;
  responseText: string;
  toolRecords?: ToolExecutionRecord[];
  source: 'chat' | 'voice' | 'task' | 'workflow' | 'background_delegation' | string;
  flow?: LumiTurnFlow;
}

export interface LumiResultFinalizerResult {
  text: string;
  blocked: boolean;
  reason?: string;
  notification?: {
    type: 'work_product_guard';
    level: 'warning';
    message: string;
  };
}

const TOOL_ITERATION_LIMIT_RESPONSE_RE =
  /The tool loop reached its limit|Maximum tool call iterations reached|before Lumi could write the final answer|\u8fd9\u8f6e\u5de5\u5177(?:\u5904\u7406|\u8c03\u7528)\u6b21\u6570(?:\u5df2)?(?:\u5230\u8fbe|\u8fbe\u5230|\u5230)\u4e0a\u9650/iu;

function resultTaskText(input: LumiResultFinalizerInput): string {
  const routed = String(input.flow?.routeText || '').trim();
  return routed || String(input.taskText || '').trim();
}

function leakedLegacyToolProtocol(input: LumiResultFinalizerInput): LumiResultFinalizerResult | null {
  const raw = String(input.responseText || '').trim();
  const hasXmlProtocol = /<(?:function_calls|tool_calls|invoke)\b/i.test(raw);
  const hasFencedToolProtocol = /```\s*(?:tool|tools|tool_call|tool_calls|function_call|function_calls)\b/i.test(raw);
  // i18n-allow: Chinese internal tool-protocol recognition; not user-visible copy.
  const hasBracketProtocol = /\[(?:[^\]\r\n]{1,48})\]\s*[A-Za-z][A-Za-z0-9_.:-]{1,127}\s*\([^\r\n)]*\)|\[(?:调用|call(?:ing)?|tool)\s+[A-Za-z][A-Za-z0-9_.:-]{1,127}\s*\](?:\s*\{)?/iu.test(raw);
  if (!hasXmlProtocol && !hasFencedToolProtocol && !hasBracketProtocol) return null;
  const names = Array.from(raw.matchAll(/<invoke\s+name=["']([^"']+)["']/gi), match => match[1]);
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

function claimedExecutedToolNames(text: string): { asserted: boolean; toolNames: string[] } {
  const raw = String(text || '');
  const clauses: string[] = [];
  const patterns = [
    /(?:\u8fd0\u884c|\u8c03\u7528|\u6267\u884c|\u4f7f\u7528)\u4e86[^\u3002\uff01\uff1f\n\r)]{0,180}/gu,
    /\b(?:I|we|Lumi)\s+(?:have\s+)?(?:ran|called|executed|used)\b[^.!?\n\r)]{0,180}/gi,
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      const prefix = raw.slice(Math.max(0, (match.index || 0) - 28), match.index || 0);
      if (/(?:\u6ca1\u6709|\u5e76\u672a|\u672a\u66fe|\u4e0d\u80fd|\u4e0d\u5e94|\u4e0d\u8981|\u5e76\u975e|did\s+not|didn't|cannot|can't|must\s+not|never)\s*$/i.test(prefix)) continue;
      clauses.push(match[0]);
    }
  }
  const toolNames = Array.from(new Set(clauses.flatMap(clause =>
    Array.from(clause.matchAll(/`([A-Za-z][A-Za-z0-9_.:-]{1,127})`/g), match => match[1])
  )));
  return { asserted: clauses.length > 0, toolNames };
}

function unsupportedToolExecutionClaim(input: LumiResultFinalizerInput): string | null {
  const claim = claimedExecutedToolNames(input.responseText);
  if (!claim.asserted) return null;
  const actualNames = new Set((input.toolRecords || []).map(record => String(record.name || '')));
  const missing = claim.toolNames.length > 0
    ? claim.toolNames.filter(name => !actualNames.has(name))
    : (actualNames.size === 0 ? ['tool execution evidence'] : []);
  if (missing.length === 0) return null;
  if (isChineseText(resultTaskText(input)) || isChineseText(input.responseText)) {
    return formatCnUnsupportedToolExecutionClaim(missing[0] === 'tool execution evidence' ? [] : missing);
  }
  return [
    missing[0] === 'tool execution evidence'
      ? 'No actual tool execution was recorded for this turn.'
      : `No actual tool call was recorded for: ${missing.join(', ')}.`,
    'I cannot present an unrecorded action as executed; the real tools must run before I report their results.',
  ].join('\n');
}

function unsupportedToolModeClaim(input: LumiResultFinalizerInput): string | null {
  const response = String(input.responseText || '');
  // i18n-allow: Chinese unsupported-mode claim recognition; not user-visible copy.
  const claimsInventedMode = /(?:已(?:经)?|现在|已经成功).{0,18}(?:切换|切到|进入|开启).{0,32}(?:Fetcher|System\s*Diagnostics|工具可用(?:模式|状态)|诊断工具模式)/iu.test(response);
  if (!claimsInventedMode) return null;
  const hasModeReceipt = (input.toolRecords || []).some(record => (
    !record.error
    && (
      /^(?:set_client_mode|operation_mode)$/i.test(String(record.name || ''))
      || (
        /^client_action$/i.test(String(record.name || ''))
        && /^set_client_mode$/i.test(String(record.arguments?.action || ''))
      )
    )
    && String(record.result || '').trim()
  ));
  if (hasModeReceipt) return null;
  return isChineseText(resultTaskText(input)) || isChineseText(response)
    ? CN_EXECUTION_EVIDENCE_MESSAGES.inventedToolMode
    : 'No such mode switch occurred. Fetcher/System Diagnostics is not a user-selectable runtime mode; the tools actually declared for this turn are authoritative.';
}

function unsupportedOngoingExecutionClaim(
  input: LumiResultFinalizerInput,
  includeActionPlans = true,
): string | null {
  if ((input.toolRecords || []).length > 0) return null;
  const response = String(input.responseText || '').trim();
  if (!response) return null;
  const task = resultTaskText(input);
  const actionRequested = taskActionContract(input).applies
    || isDiagnosticOrRepairRequest(task);
  // i18n-allow: Chinese execution-plan recognition; not user-visible copy.
  const claimsPendingAction = /(?:^|[\n\u3002\uff01\uff1f.!?])\s*(?:(?:\u597d|\u597d\u7684|\u53ef\u4ee5|\u884c)[\uff0c,\s]*)?(?:(?:\u6211|\u8ba9\u6211|\u8fd9\u8fb9)?\s*(?:\u5148|\u73b0\u5728|\u9a6c\u4e0a|\u7acb\u5373|\u63a5\u4e0b\u6765|\u7ee7\u7eed)\s*(?:\u770b\u770b|\u67e5\u770b|\u68c0\u67e5|\u8bfb\u53d6|\u6253\u5f00|\u6267\u884c|\u5904\u7406|\u91cd\u542f|\u4fee\u590d|\u6062\u590d|\u8c03\u7528|\u5f00\u59cb)|(?:\u6211|\u8fd9\u8fb9)\s*\u6b63\u5728\s*(?:\u770b|\u67e5|\u8bfb|\u6253\u5f00|\u6267\u884c|\u5904\u7406|\u91cd\u542f|\u4fee\u590d|\u6062\u590d))|\b(?:let\s+me|i(?:'ll|\s+will|\s+am\s+going\s+to)|first\s+i(?:'ll|\s+will))\b[^.!?\n]{0,100}\b(?:check|inspect|read|open|execute|handle|restart|repair|recover|start)\b/iu.test(response);
  // General first-person execution promises are handled by the shared
  // completion guard below, which already excludes quoted explanations and
  // reflective self-assessment. This narrow check covers the distinct false
  // claim seen in production: inventing that an internal "tool chain" was
  // restored even though this turn has no tool receipt.
  // i18n-allow: Chinese execution-claim recognition; not user-visible copy.
  const claimsInventedToolChain = /工具(?:链|链路)[^。！？!?\n]{0,20}(?:已经)?(?:恢复|可用)|\btool(?:ing)?\s+(?:chain|pipeline)[^.!?\n]{0,30}\b(?:restored|available|working)\b/iu.test(response);
  if (!claimsInventedToolChain && !(includeActionPlans && actionRequested && claimsPendingAction)) return null;
  return isChineseText(resultTaskText(input)) || isChineseText(response)
    ? claimsInventedToolChain
      ? CN_RESULT_GROUNDING_MESSAGES.unverifiedExecutionActivity
      : CN_RESULT_GROUNDING_MESSAGES.actionNotStarted
    : claimsInventedToolChain
      ? 'No new execution started in this turn; the draft response mixed in an older task.'
      : 'No tool execution started in this turn. The response described a plan, not an action or result.';
}

function unsupportedToolAvailabilityExcuse(input: LumiResultFinalizerInput): string | null {
  const response = String(input.responseText || '');
  // A correct explanation may explicitly deny the fictional state (for
  // example, "the routed subset does not mean tools are unmounted"). Remove
  // those denial clauses before looking for an unsupported availability claim.
  const availabilityClaimText = response.replace(
    /(?:\u4e0d\u4ee3\u8868|\u5e76\u4e0d\u4ee3\u8868|\u4e0d\u7b49\u4e8e|\u4e0d\u80fd\u8bf4\u660e|\u4e0d\u662f\u8bf4|does\s+not\s+mean|doesn'?t\s+mean)[^\u3002\uff01\uff1f.!?\n]{0,100}[\u3002\uff01\uff1f.!?]?/giu,
    '',
  );
  // i18n-allow: Unsupported user-switchable tool-state excuse recognition; not user-visible copy.
  const claimsToolsAreOff = /(?:当前|现在|这轮|我这边|当前会话|这个会话)?[^。！？!?\n]{0,32}(?:工具|tool)[^。！？!?\n]{0,36}(?:没(?:有)?打开|未打开|没开启|未开启|不可用|没有开放|没(?:有)?挂载|未挂载|没带|只有|只(?:挂载|有)|not (?:open|enabled|available|mounted|loaded)|disabled)|(?:当前|现在|这轮|我这边|当前会话|这个会话)?[^。！？!?\n]{0,28}(?:只有|只(?:挂载|有)|没(?:有)?挂载|未挂载|没带)[^。！？!?\n]{0,20}(?:工具|tool)|(?:需要|要不要|可以)(?:我)?[^。！？!?\n]{0,28}(?:切换|切到|进入|开启)[^。！？!?\n]{0,24}(?:工具可用|工具模式|tool mode|tools? enabled)/iu.test(availabilityClaimText);
  if (!claimsToolsAreOff) return null;
  const actualUnavailableReceipt = (input.toolRecords || []).some(record => (
    String(record.error || '').trim()
    // i18n-allow: Chinese tool-error recognition pattern; not user-visible copy.
    && /(?:tool[^\n]{0,40}(?:unavailable|not found|not declared|disabled)|工具[^\n]{0,32}(?:不可用|未声明|不存在|已禁用))/iu.test(String(record.error || ''))
  ));
  if (actualUnavailableReceipt) return null;
  return isChineseText(resultTaskText(input)) || isChineseText(response)
    ? CN_EXECUTION_EVIDENCE_MESSAGES.inventedToolAvailability
    : 'No receipt shows that tools were disabled, and there is no user-switchable “tool available mode.” Lumi must resume the real tool route instead of shifting an internal routing failure to the user.';
}

function unsupportedPriorDiagnosticClaim(input: LumiResultFinalizerInput): string | null {
  const task = resultTaskText(input);
  const response = String(input.responseText || '');
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const deniesDiagnostic = /(?:没有|没|并未|不是|不在|未曾|无法确认|不能确认)[^。！？!?\n]{0,32}(?:自检|健康检查|扫描|检查)|\b(?:did\s+not|didn't|wasn'?t|cannot\s+confirm)\b[^.!?\n]{0,80}\b(?:self[- ]?check|scan|diagnostic)/iu.test(response);
  if (deniesDiagnostic) return null;
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const claimsDiagnostic = /(?:刚才|刚刚|之前|上一轮|上一次)?[^。！？!?\n]{0,20}(?:在|已经|刚刚|跑了|执行了|进行了|做了)[^。！？!?\n]{0,48}(?:自检|健康检查|扫描\s*MCP|扫描.*技能|检查.*运行时)|\b(?:I|Lumi|we)\s+(?:was|were|have\s+been|had\s+been)?\s*(?:running|performing|doing)[^.!?\n]{0,80}\b(?:self[- ]?check|diagnostic|MCP\s+scan)/iu.test(response);
  if (!claimsDiagnostic) return null;

  // Only apply the prior-run guard when the task or answer actually points
  // backward in time. A current request such as "please run a self-check"
  // must still be allowed to summarize receipts produced in this turn.
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const priorTaskContext = /(?:刚才|刚刚|之前|上一轮|上一次|上轮)|(?:为什么|怎么|为何)[^。！？!?\n]{0,48}(?:这么久|那么久|半天|延迟|才[^。！？!?\n]{0,12}(?:回|答|回复|回应))|\b(?:earlier|previously|last\s+(?:turn|time)|prior\s+turn|why[^.!?]{0,60}(?:delay|took?\s+so\s+long))\b/iu.test(task);
  const currentDiagnosticRequest = !priorTaskContext
    && isCurrentClientDiagnosticRequest(task);
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const priorResponseContext = /(?:刚才|刚刚|之前|上一轮|上一次|上轮)|\b(?:earlier|previously|last\s+(?:turn|time)|was|were|had\s+been)\b/iu.test(response);
  if (!priorTaskContext && (!priorResponseContext || currentDiagnosticRequest)) return null;

  // Current-turn tool records cannot prove a claim about "just now" or a
  // previous turn: ToolExecutionRecord has no prior-turn identity/timestamp.
  // Explicit current self-check requests are grounded earlier by
  // formatClientDiagnosticResult; any remaining prior-run narrative is blocked.
  return isChineseText(resultTaskText(input)) || isChineseText(response)
    ? CN_RESULT_GROUNDING_MESSAGES.priorDiagnosticUnsupported
    : 'There is no verifiable client-diagnostic receipt for the prior turn. I cannot explain the delay as a self-check when no such check was recorded.';
}

function taskActionContract(input: LumiResultFinalizerInput) {
  return buildActionContract(resultTaskText(input));
}

function isChineseText(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value || '');
}

function sanitizeInternalExecutionText(value: string, chinese: boolean): string {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  const internalLine = /(?:No worker agent accepted|Worker (?:agent )?(?:failed|blocked|succeeded)|Coordinating worker agents|\bsubTask(?:Id)?\b|\bworkerAgentId\b|\baggregatedOutput\b|\bprerequisite\s+sub[_-]|\bsub[_-]\d+\b|\ballowedTools\b|\bappTarget\b|\bUI\s*evidence\b|work product guard|action contract|Required completion evidence|Preferred tools|Verification tools|tool route|tool protocol|Maximum tool call iterations|<\/?function_calls?>|<invoke\b|\[historical\s+source=[^\]]+\]|\[[^\]\r\n]{1,48}\]\s*[A-Za-z][A-Za-z0-9_.:-]{1,127}\s*\()/i;
  const withoutHistoryMarkers = raw.replace(/\[historical\s+source=[^\]]+\]\s*/gi, '');
  if (!internalLine.test(withoutHistoryMarkers) && withoutHistoryMarkers === raw) return raw;
  const cleaned = withoutHistoryMarkers
    .split(/\r?\n/)
    .filter(line => !internalLine.test(line))
    .join('\n')
    .trim();
  return cleaned || formatInternalDispatchUnavailable(chinese);
}

function summarizeToolFailure(records: ToolExecutionRecord[]): string {
  const webAccountBlocker = summarizeWebAccountBlocker(records);
  if (webAccountBlocker) return webAccountBlocker;
  const failed = [...records].reverse().find(record => record.error);
  if (!failed) return '';
  const name = String(failed.name || '');
  const error = String(failed.error || '').trim();
  const action = (() => {
    if (/^(desktop_open|open_item)$/i.test(name)) return '\u6253\u5f00\u6216\u805a\u7126\u76ee\u6807\u7a97\u53e3';
    if (/^(desktop_active_window|get_active_window_info)$/i.test(name)) return '\u8bfb\u53d6\u5f53\u524d\u524d\u53f0\u7a97\u53e3';
    if (/^(wechat_read_recent_chat)$/i.test(name)) return '\u5fae\u4fe1\u524d\u53f0\u804a\u5929\u8bfb\u53d6';
    if (/^(wechat_send_message)$/i.test(name)) return CN_MESSAGING_MESSAGES.textSendAction;
    if (/^(wechat_send_file)$/i.test(name)) return CN_MESSAGING_MESSAGES.fileSendAction;
    if (/^(computer_use)$/i.test(name)) return '\u89c6\u89c9\u684c\u9762\u6267\u884c';
    if (/keyboard/i.test(name)) return '\u952e\u76d8\u8f93\u5165';
    if (/mouse|cursor/i.test(name)) return '\u5149\u6807\u70b9\u51fb';
    return CN_VOICE_FAST_PATH_MESSAGES.genericToolAction;
  })();
  return error ? `${action}\uff1a${formatCnToolFailureDetail(error)}` : action;
}

function summarizeWebAccountBlocker(records: ToolExecutionRecord[]): string {
  for (const record of [...records].reverse()) {
    const name = String(record.name || '');
    const result = String(record.result || '');
    const error = String(record.error || '');
    if (/^web_login_profile_list$/i.test(name) && /"profiles"\s*:\s*\[\s*\]/i.test(result)) {
      return '\u6ca1\u6709\u627e\u5230\u5df2\u4fdd\u5b58\u7684\u7f51\u9875\u767b\u5f55 profile/\u4f1a\u8bdd';
    }
    if (/^web_login_run$/i.test(name) && /manual_required|captcha|2FA|QR|passkey|\u9a8c\u8bc1\u7801|\u626b\u7801|\u4e8c\u6b21\u9a8c\u8bc1/i.test(`${result}\n${error}`)) {
      return '\u767b\u5f55\u9700\u8981\u624b\u52a8\u5b8c\u6210\u626b\u7801\u3001\u9a8c\u8bc1\u7801\u30012FA \u6216\u8d26\u53f7\u786e\u8ba4';
    }
    if (/mcp_playwright_browser_(?:evaluate|run_code_unsafe)/i.test(name) && /cross-origin|Blocked a frame|iframe|contentFrame/i.test(`${result}\n${error}`)) {
      return '\u767b\u5f55\u6846\u5728\u8de8\u57df iframe \u91cc\uff0c\u666e\u901a\u9875\u9762 JS \u4e0d\u80fd\u76f4\u63a5\u63a5\u7ba1\uff1b\u9700\u8981\u8d70\u53ef\u89c1 web_login_run \u4f1a\u8bdd\u6216\u7528\u6237\u5b8c\u6210\u9a8c\u8bc1';
    }
  }
  return '';
}

function shouldUseCompactActionBlockedResponse(input: LumiResultFinalizerInput): boolean {
  const records = input.toolRecords || [];
  if (String(input.source || '').toLowerCase() === 'background_delegation') return true;
  const actionText = resultTaskText(input);
  const contract = taskActionContract(input);
  if (shouldEnforceCoreActionContract(contract, actionText)) return true;
  const hasDesktopOrMessagingTool = records.some(record =>
    /^(desktop_|wechat_(?:send_message|send_file|read_recent_chat)|computer_use|keyboard_|mouse_|cursor_|get_active_window_info|capture_screen|ocr_screen)/i.test(String(record.name || ''))
  );
  if (!hasDesktopOrMessagingTool) return false;
  const text = `${actionText}\n${input.responseText}`;
  return /wechat|weixin|\u5fae\u4fe1|\u53d1\u9001|\u53d1\u7ed9|\u665a\u5b89|\u684c\u9762|\u6253\u5f00|\u805a\u7126|\u6700\u540e\u4e00\u6b65/i.test(text);
}

function shouldEnforceCoreActionContract(contract: ReturnType<typeof buildActionContract>, text: string): boolean {
  if (!contract.applies) return false;
  if (['messaging_read', 'messaging_send', 'browser_account', 'public_post', 'cad_drafting', 'customer_operations', 'ecommerce_operations', 'design_delivery', 'stock_monitor', 'task_control', 'desktop_operation'].includes(contract.kind)) {
    return true;
  }
  if (contract.kind === 'legal_document') {
    return /\u4ee3\u7406\u8bcd|\u8d77\u8bc9\u72b6|\u7b54\u8fa9\u72b6|pleading/i.test(text);
  }
  return false;
}

function formatCompactBlockedResponse(input: LumiResultFinalizerInput, reason?: string): string {
  const zh = isChineseText(resultTaskText(input)) || isChineseText(input.responseText);
  const failure = summarizeToolFailure(input.toolRecords || []);
  const contract = taskActionContract(input);
  const contractBlocker = zh && contract.kind === 'messaging_send'
    ? formatCnMessagingContractBlocker(failure)
    : summarizeActionContractBlocker(contract, failure);
  const source = String(input.source || '').toLowerCase();
  if (/External legal platform final action/i.test(reason || '')) {
    return zh
      ? [
          '\u5916\u90e8\u6cd5\u5f8b\u5e73\u53f0\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5168\u81ea\u52a8\u5b8c\u6210\u3002',
          '\u6cd5\u9662\u7acb\u6848\u7f51\u3001\u6cd5\u8749\u3001Alpha\u3001\u88c1\u5224\u6587\u4e66\u7f51\u3001\u4f01\u67e5\u67e5\u7b49\u53d7\u8d26\u53f7\u3001\u9a8c\u8bc1\u7801\u3001\u4ed8\u8d39\u548c\u98ce\u63a7\u5f71\u54cd\uff1bLumi \u53ea\u80fd\u505a\u6388\u6743\u534f\u4f5c\u3001\u7ed3\u679c\u5f52\u6863\u548c\u4ea4\u4ed8\u524d\u6838\u9a8c\u3002',
          '\u63d0\u4ea4\u3001\u7b7e\u540d\u3001\u7f34\u8d39\u3001\u786e\u8ba4\u9001\u8fbe\u3001\u64a4\u56de\u6216\u548c\u89e3\u627f\u8bfa\u5fc5\u987b\u7531\u5f8b\u5e08\u6216\u5f53\u4e8b\u4eba\u786e\u8ba4\u3002',
        ].join('\n')
      : [
          'External legal platforms cannot be marked as fully automated completion.',
          'Court filing portals, Fachan, Alpha, China Judgments Online, Qichacha, and similar systems depend on accounts, captcha/2FA, payment, and platform risk controls. Lumi can do authorized collaboration, result archiving, and pre-delivery verification.',
          'Submission, signature, payment, service confirmation, withdrawal, or settlement commitment requires lawyer or party confirmation.',
        ].join('\n');
  }
  if (/Missing external legal platform result evidence/i.test(reason || '')) {
    return zh
      ? [
          '\u8fd8\u4e0d\u80fd\u8bf4\u5df2\u7ecf\u5b8c\u6210\u5916\u90e8\u6cd5\u5f8b\u5e73\u53f0\u67e5\u8be2\u6216\u68c0\u7d22\u7ed3\u679c\u3002',
          '\u9700\u8981\u6709\u6388\u6743\u767b\u5f55\u4f1a\u8bdd\u3001\u5b98\u65b9 API \u8fd4\u56de\u3001\u7f51\u9875\u53ef\u89c1\u7ed3\u679c\u3001\u6765\u6e90\u767b\u8bb0\u6216\u5165\u6848\u5f52\u6863\u8bb0\u5f55\u3002',
          '\u76ee\u524d\u53ea\u80fd\u8bf4\u662f\u6388\u6743\u534f\u4f5c\u6216\u68c0\u7d22\u4ea4\u63a5\uff0c\u4e0d\u80fd\u5047\u88c5\u5df2\u7ecf\u67e5\u5230\u771f\u5b9e\u5e73\u53f0\u7ed3\u679c\u3002',
        ].join('\n')
      : [
          'I cannot say the external legal-platform search is complete yet.',
          'I need authorized session/API output, visible webpage results, source registration, or case-archive evidence.',
          'Until then, this is an authorized handoff, not a verified platform result.',
        ].join('\n');
  }
  if (contract.kind === 'legal_document' && /reasoning chain|triad|\u4e09\u6bb5\u8bba/i.test(reason || '')) {
    return zh
      ? [
          '\u8fd9\u4efd\u6cd5\u5f8b\u6210\u679c\u8fd8\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5b8c\u6210\u6216\u6b63\u5f0f\u53ef\u7528\u3002',
          '\u7f3a\u5c11\u4e09\u6bb5\u8bba\u63a8\u7406\u94fe\uff1a\u9700\u8981 legal_case_reasoning_matrix\uff0c\u6216\u6587\u4e66/\u4ea4\u4ed8\u5305\u4e2d\u80fd\u770b\u5230\u6cd5\u5f8b\u4f9d\u636e\u3001\u4e8b\u5b9e\u8bc1\u636e\u3001\u6db5\u6444/\u9002\u7528\u7ed3\u8bba\u7684\u53ef\u9a8c\u6536\u8bb0\u5f55\u3002',
          '\u6b63\u5f0f\u6587\u4e66\u5fc5\u987b\u80fd\u4ece\u5927\u524d\u63d0\u3001\u5c0f\u524d\u63d0\u5230\u7ed3\u8bba\u9010\u6b65\u590d\u6838\u3002',
        ].join('\n')
      : [
          'This legal work product cannot be marked complete or formally usable yet.',
          'Missing legal reasoning chain: run legal_case_reasoning_matrix, or provide product evidence showing legal authority, facts/evidence, and application/conclusion.',
          'Formal legal documents must be reviewable from rule, to facts, to conclusion.',
        ].join('\n');
  }
  if (contract.kind === 'legal_document' && /current-law|current law|\u73b0\u884c\u6709\u6548/i.test(reason || '')) {
    return zh
      ? [
          '\u8fd9\u4efd\u6cd5\u5f8b\u6587\u4e66\u8fd8\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5b8c\u6210\u6216\u6b63\u5f0f\u53ef\u7528\u3002',
          '\u7f3a\u5c11\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u6838\u9a8c\uff1a\u9700\u8981\u8fd0\u884c legal_generate_citation_verification_report \u6216 legal_finalize_delivery_package\uff0c\u5e76\u786e\u8ba4\u6ca1\u6709\u5df2\u5e9f\u6b62\u3001\u5931\u6548\u6216\u672a\u786e\u8ba4\u7684\u6cd5\u6761\u5f15\u7528\u3002',
          '\u6211\u4e0d\u4f1a\u628a\u672a\u6838\u9a8c\u7684\u6cd5\u5f8b\u6587\u4e66\u8bf4\u6210\u6b63\u5f0f\u6210\u679c\u3002',
        ].join('\n')
      : [
          'This legal document cannot be marked complete or formally usable yet.',
          'Missing current-law verification: run legal_generate_citation_verification_report or legal_finalize_delivery_package and confirm there are no repealed, invalid, or unverified statute citations.',
          'I will not present an unverified legal document as a formal result.',
        ].join('\n');
  }
  if (contract.kind === 'legal_document' && /production evidence|document production/i.test(reason || '')) {
    return zh
      ? [
          '\u8fd9\u4efd\u6cd5\u5f8b\u6587\u4e66\u8fd8\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5b8c\u6210\u3002',
          '\u7f3a\u5c11\u5b9e\u9645\u6587\u4e66\u4ea7\u7269\u8bc1\u636e\uff1a\u9700\u8981\u5148\u751f\u6210\u6216\u5199\u5165\u8d77\u8bc9\u72b6\u3001\u7b54\u8fa9\u72b6\u3001\u4ee3\u7406\u8bcd\u3001\u6cd5\u5f8b\u610f\u89c1\u4e66\u3001\u5408\u540c\u6216\u6807\u4e66\u7b49\u5b9e\u9645\u8349\u7a3f\uff0c\u518d\u8fdb\u884c\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u6838\u9a8c\u3002',
        ].join('\n')
      : [
          'This legal document cannot be marked complete yet.',
          'Missing legal document production evidence: generate or write the actual draft first, then run the current-law verification gate.',
        ].join('\n');
  }
  if (source === 'background_delegation' || shouldUseCompactActionBlockedResponse(input)) {
    if (zh) {
      return [
        '\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210\u3002',
        contractBlocker || (failure
          ? `\u5361\u4f4f\u7684\u4f4d\u7f6e\uff1a${failure}\u3002`
          : '\u539f\u56e0\uff1a\u8fd8\u6ca1\u6709\u62ff\u5230\u53ef\u9a8c\u8bc1\u7684\u5b8c\u6210\u8bc1\u636e\u3002'),
        contract.kind === 'messaging_send'
          ? CN_MESSAGING_MESSAGES.unverifiedDelivery
          : contract.kind === 'messaging_read'
            ? '\u6211\u4e0d\u4f1a\u628a\u53ea\u6253\u5f00\u6216\u805a\u7126\u5fae\u4fe1\u8bf4\u6210\u5df2\u8bfb\u5230\u804a\u5929\u5185\u5bb9\uff1b\u9700\u8981\u7ee7\u7eed\u8bfb\u53d6\u5e76\u9a8c\u8bc1\u53ef\u89c1\u5185\u5bb9\u3002'
            : '\u6211\u4e0d\u4f1a\u628a\u8fd9\u79cd\u672a\u786e\u8ba4\u7684\u7ed3\u679c\u8bf4\u6210\u5df2\u5b8c\u6210\uff1b\u9700\u8981\u7ee7\u7eed\u524d\u53f0\u6267\u884c\u5e76\u9a8c\u8bc1\u7ed3\u679c\u3002',
      ].join('\n');
    }
    return [
      'This is not complete yet.',
      failure ? `Blocked at: ${failure}.` : 'Reason: I do not have verifiable completion evidence yet.',
      'I will not mark that as done until the real action is verified.',
    ].join('\n');
  }

  if (reason && reason.length < 180) {
    return zh
      ? `\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210\uff1a${reason}\u3002`
      : `This is not complete yet: ${reason}.`;
  }
  return zh
    ? '\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210\uff1a\u8fd8\u6ca1\u6709\u62ff\u5230\u53ef\u9a8c\u8bc1\u7684\u5b8c\u6210\u8bc1\u636e\u3002'
    : 'This is not complete yet: I do not have verifiable completion evidence.';
}

function formatGroundedDesktopEvidence(input: LumiResultFinalizerInput): string | null {
  return formatDesktopObservationResult(input.toolRecords || [], resultTaskText(input));
}

function formatGroundedSimpleDesktopOpenResult(
  input: LumiResultFinalizerInput,
): string | null {
  const actionText = resultTaskText(input);
  const successfulOpen = [...(input.toolRecords || [])].reverse().find(record => (
    /^(?:desktop_open|browser_open_task)$/i.test(String(record.name || ''))
    && !record.error
    && String(record.result || '').trim()
  ));
  if (!successfulOpen) return null;
  const primaryTask = actionText.split(/\n## Recent action continuation context\b/i, 1)[0].trim();
  const receiptTarget = String(
    successfulOpen.arguments?.target
    || successfulOpen.arguments?.url
    || successfulOpen.arguments?.path
    || '',
  ).trim();
  const requestedTarget = extractSimpleDesktopOpenTarget(actionText)
    || (/^(?:你)?(?:直接)?(?:把)?(?:它|这个|那个|文件|文档)?(?:给我)?打开(?:一下)?[。！？.!?]*$/iu.test(primaryTask) // i18n-allow: Chinese referential-open recognition; not user-visible copy.
      ? receiptTarget
      : '');
  if (!requestedTarget) return null;
  const contract = buildActionContract(actionText);
  if (
    contract.kind !== 'desktop_operation'
    || !hasCoreActionEvidence(contract, input.toolRecords || [], actionText)
  ) {
    return null;
  }
  return isChineseText(actionText)
    ? CN_VOICE_FAST_PATH_MESSAGES.opened(requestedTarget)
    : `Opened ${requestedTarget}.`;
}

function recordHasTerminalSuccess(record: ToolExecutionRecord): boolean {
  if (record.error || !String(record.result || '').trim()) return false;
  const raw = String(record.result || '');
  try {
    const parsed = JSON.parse(raw);
    const status = String(parsed?.status || parsed?.verification?.status || '').trim().toLowerCase();
    if (parsed?.ok === false || parsed?.success === false || parsed?.opened === false) return false;
    if (/^(?:failed|error|blocked|denied|forbidden|timeout|timed_out|cancelled|canceled|not_found)$/.test(status)) return false;
  } catch {}
  return !/(?:^|\b)(?:failed|error|blocked|not found|timed out|permission denied)(?:\b|:)/i.test(raw);
}

function parseVerifiedClientActionReceipt(record: ToolExecutionRecord): {
  action: string;
  mode: string;
  enabled: boolean;
  target: string;
  say: string;
} | null {
  if (record.error || record.name !== 'client_action') return null;
  try {
    const payload = JSON.parse(String(record.result || '{}'));
    const status = String(payload?.verification?.status || payload?.status || '').trim().toLowerCase();
    if (payload?.ok !== true || !['verified', 'not_applicable'].includes(status)) return null;
    return {
      action: String(payload?.action || record.arguments?.action || '').trim(),
      mode: String(payload?.mode || record.arguments?.mode || '').trim(),
      enabled: Boolean(payload?.enabled ?? record.arguments?.enabled),
      target: String(
        payload?.target
        || payload?.expectation?.target
        || payload?.relayResult?.target
        || record.arguments?.target
        || '',
      ).trim(),
      say: String(payload?.say || payload?.verification?.message || '').trim(),
    };
  } catch {
    return null;
  }
}

function formatGroundedClientActionResult(input: LumiResultFinalizerInput): string | null {
  // The client-action-only route already performed exact target selection and
  // state-diff verification. A verified native navigation receipt is stronger
  // evidence than a model sentence that happens to claim the action failed.
  if (!input.flow?.clientActionOnlyTurn) return null;
  const receipts = (input.toolRecords || [])
    .map(parseVerifiedClientActionReceipt)
    .filter((receipt): receipt is NonNullable<typeof receipt> => Boolean(receipt));
  const actionable = receipts.filter(receipt => receipt.action !== 'refresh_client_state');
  const receipt = [...actionable].reverse().find(item => item.action !== 'set_client_mode')
    || actionable.at(-1)
    || receipts.at(-1);
  if (!receipt) return null;

  if (!isChineseText(resultTaskText(input))) {
    return receipt.say || 'The requested Lumi client action is complete.';
  }
  if (receipt.action === 'set_client_mode') {
    return CN_VOICE_FAST_PATH_MESSAGES.operationModeChanged(receipt.mode || 'assistant');
  }
  if (receipt.action === 'set_wallpaper_mode') {
    return receipt.enabled ? '壁纸模式已开启。' : '壁纸模式已关闭。';
  }
  if (receipt.action === 'refresh_client_state') return '客户端状态已刷新。';
  const label = formatCnClientActionTargetLabel(receipt.action, receipt.target || 'Lumi 界面');
  if (/^(?:close_|exit_)/.test(receipt.action)) return `${label}已关闭。`;
  if (/^(?:open_|show_|focus_|enter_)/.test(receipt.action)) {
    return CN_VOICE_FAST_PATH_MESSAGES.opened(label);
  }
  return `已完成${label}操作。`;
}

function formatGroundedPartialActionResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const actionText = resultTaskText(input);
  const contract = taskActionContract(input);
  if (!contract.applies || hasCoreActionEvidence(contract, input.toolRecords || [], actionText)) return null;
  if (requiresCurrentAppUiMutation(actionText) || requiresVisibleAutoCadExecution(actionText)) return null;

  const openRecord = [...(input.toolRecords || [])].reverse().find(record => (
    /^(?:desktop_open|browser_open_task)$/i.test(String(record.name || ''))
    && recordHasTerminalSuccess(record)
  ));
  if (openRecord && contract.kind === 'desktop_operation') {
    const target = String(
      openRecord.arguments?.target
      || openRecord.arguments?.url
      || openRecord.arguments?.path
      || extractSimpleDesktopOpenTarget(actionText)
      || '',
    ).trim();
    const normalizedTarget = target.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const normalizedTask = actionText.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const targetMatchesTask = normalizedTarget.length >= 2
      && (
        normalizedTask.includes(normalizedTarget)
        || normalizedTarget.includes(normalizedTask.replace(/^(?:\u8bf7|\u5e2e\u6211)?(?:\u6253\u5f00|open)/iu, ''))
      );
    if (target && targetMatchesTask) {
      const zh = isChineseText(actionText);
      const text = zh
        ? CN_VOICE_FAST_PATH_MESSAGES.partialOpen(target)
        : `Opened ${target}, but the remaining requested action has not been verified.`;
      return {
        text,
        blocked: true,
        reason: 'The open step succeeded, but the remaining requested action lacks verification.',
        notification: {
          type: 'work_product_guard',
          level: 'warning',
          message: 'The open step succeeded, but the remaining requested action lacks verification.',
        },
      };
    }
  }

  return null;
}

function formatCreatedArtifactWithoutInAppCompletion(input: LumiResultFinalizerInput): string | null {
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    /^(?:create_docx|create_xlsx|create_ppt|create_pdf|write_file|cad_generate_dxf)$/i.test(String(item.name || ''))
    && recordHasTerminalSuccess(item)
    && artifactPathFromRecord(item)
  ));
  if (!record) return null;
  const path = artifactPathFromRecord(record);
  return isChineseText(resultTaskText(input))
    ? CN_VOICE_FAST_PATH_MESSAGES.partialArtifact(path)
    : `The file was created at ${path}, but the corresponding action was not completed in the target application.`;
}

function operationModeFromLabel(label: string): 'chat' | 'assistant' | 'autonomous' | 'meeting' | null {
  const normalized = String(label || '').trim().toLowerCase();
  if (/^(?:\u804a\u5929|\u5bf9\u8bdd|chat|conversation)$/.test(normalized)) return 'chat';
  if (/^(?:\u52a9\u624b|\u52a9\u7406|assistant)$/.test(normalized)) return 'assistant';
  if (/^(?:\u81ea\u4e3b|autonomous)$/.test(normalized)) return 'autonomous';
  if (/^(?:\u4f1a\u8bae|meeting)$/.test(normalized)) return 'meeting';
  return null;
}

function sanitizeContradictoryOperationModeText(input: LumiResultFinalizerInput): string {
  // When this turn requests a mode change, the client_action receipt remains
  // authoritative. Otherwise effectiveOperationMode is the actual persisted
  // mode supplied by the client and can safely reject a contradictory claim.
  const knownMode = input.flow?.requestedMode ? null : input.flow?.effectiveOperationMode;
  const raw = String(input.responseText || '').trim();
  if (!knownMode || !raw) return raw;
  const currentModeClaim = /(?:\u6211|Lumi)?(?:\u5f53\u524d|\u73b0\u5728|\u76ee\u524d|\u6b63\u5904\u4e8e|\u5904\u4e8e|\u662f)\s*(\u804a\u5929|\u5bf9\u8bdd|\u52a9\u624b|\u52a9\u7406|\u81ea\u4e3b|\u4f1a\u8bae|chat|conversation|assistant|autonomous|meeting)(?:\u6a21\u5f0f)?/iu;
  const switchPrerequisite = /(?:\u9700\u8981|\u5fc5\u987b|\u5f97|need\s+to|must)\s*(?:\u5148)?(?:\u5207\u6362|\u5207\u5230|\u8fdb\u5165|switch)\s*(?:\u5230|to)?\s*(\u804a\u5929|\u5bf9\u8bdd|\u52a9\u624b|\u52a9\u7406|\u81ea\u4e3b|\u4f1a\u8bae|chat|conversation|assistant|autonomous|meeting)(?:\u6a21\u5f0f)?/iu;
  const segments = raw.match(/[^\u3002\uff01\uff1f.!?\r\n]+[\u3002\uff01\uff1f.!?]?/gu) || [raw];
  const kept = segments.filter(segment => {
    const current = segment.match(currentModeClaim);
    if (current && operationModeFromLabel(current[1]) !== knownMode) return false;
    const prerequisite = segment.match(switchPrerequisite);
    if (prerequisite && operationModeFromLabel(prerequisite[1]) === knownMode) return false;
    return true;
  });
  const cleaned = kept.join('').trim();
  if (cleaned) return cleaned;
  return isChineseText(raw)
    ? CN_VOICE_FAST_PATH_MESSAGES.operationModeStatus(knownMode)
    : `The current mode is ${knownMode}.`;
}

function artifactPathFromRecord(record: ToolExecutionRecord): string {
  const text = `${String(record.result || '')}\n${JSON.stringify(record.arguments || {})}`;
  const extension = '(?:docx|xlsx|pptx|pdf|md|txt|csv|dxf|dwg)';
  const windows = text.match(new RegExp(`([A-Za-z]:[\\\\/][^\\r\\n"<>|*?]+?\\.${extension})`, 'i'));
  if (windows?.[1]) return windows[1].trim();
  const unix = text.match(new RegExp(`((?:/[^\\s"']+)+\\.${extension})`, 'i'));
  return unix?.[1]?.trim() || '';
}

function formatGroundedArtifactResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  if (taskActionContract(input).kind !== 'artifact_work') return null;
  const records = input.toolRecords || [];
  const created = [...records].reverse().find(record => (
    !record.error
    && /^(?:create_docx|create_xlsx|create_ppt|create_pdf|write_file|cad_generate_dxf)$/i.test(String(record.name || ''))
    && String(record.result || '').trim()
    && artifactPathFromRecord(record)
  ));
  if (!created) return null;
  const path = artifactPathFromRecord(created);
  const actionText = resultTaskText(input);
  const asksToOpen = /(?:\u6253\u5f00|\u6253\u5f00\u770b\u770b|\u76f4\u63a5\u6253\u5f00)|\bopen\b/iu.test(actionText);
  const openRecord = [...records].reverse().find(record => /^(?:desktop_open|browser_open_task)$/i.test(String(record.name || '')));
  const verified = records.some(record => (
    !record.error
    && /^(?:desktop_path_info|work_product_verify)$/i.test(String(record.name || ''))
    && String(record.result || '').trim()
  ));
  const zh = isChineseText(actionText);
  if (asksToOpen && openRecord?.error) {
    const failure = formatCnToolFailureDetail(String(openRecord.error || ''));
    const text = formatArtifactCreatedOpenFailed(
      actionText,
      path,
      verified,
      zh ? failure : String(openRecord.error || ''),
    );
    return {
      text,
      blocked: true,
      reason: 'Artifact creation succeeded, but the requested open step failed.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Artifact creation succeeded, but the requested open step failed.',
      },
    };
  }
  if (asksToOpen && openRecord && !openRecord.error && String(openRecord.result || '').trim()) {
    return {
      text: formatArtifactCreatedAndOpened(actionText, path, verified),
      blocked: false,
      reason: 'Grounded artifact creation and open result from current-turn receipts.',
    };
  }
  const artifactVerified = (
    toolRecordSucceeded(created)
    && created.terminalVerification?.status === 'verified'
  );
  if (artifactVerified) {
    try {
      const stats = fs.statSync(path);
      if (stats.isFile() && stats.size > 0) {
        const exactText = extractExplicitArtifactTextRequirements(actionText);
        if (exactText.length && /\.(?:txt|md|csv|json|xml|html?|css|svg|dxf|ya?ml|toml|tsx?|jsx?|py|rs)$/iu.test(path)) {
          const artifactText = fs.readFileSync(path, 'utf8');
          const missing = exactText.filter(value => !artifactText.includes(value));
          if (missing.length) {
            return {
              text: zh
                ? `文件已写入，但尚未满足当前要求：缺少精确文本“${missing[0]}”。我不会把它汇报为已完成。产物路径：${path}`
                : `The file was written, but it is missing the exact required text "${missing[0]}". I will not mark it complete. Artifact path: ${path}`,
              blocked: true,
              reason: `Verified artifact is missing exact required text: ${missing[0]}`,
              notification: {
                type: 'work_product_guard',
                level: 'warning',
                message: `Verified artifact is missing exact required text: ${missing[0]}`,
              },
            };
          }
        }
        return {
          text: zh
            ? `已完成并验证本地文件：${path}（${stats.size} 字节）。`
            : `Completed and verified the local file: ${path} (${stats.size} bytes).`,
          blocked: false,
          reason: 'Grounded artifact completion from a verified producer receipt and the current local file.',
        };
      }
    } catch {}
  }
  // A declaration without a verified non-empty file remains subject to the
  // generic completion guard below.
  return null;
}

const CAD_GEOMETRY_ZH = {
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  failed: '\u51e0\u4f55\u63d0\u53d6\u672a\u6210\u529f\uff0c\u672a\u6267\u884c\u7ed8\u5236\u3002',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  succeeded: '\u51e0\u4f55\u63d0\u53d6\u6210\u529f\uff0c\u672a\u6267\u884c\u7ed8\u5236\u3002',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  reason: '\u539f\u56e0\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  source: '\u6765\u6e90\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  verificationState: '\u9a8c\u8bc1\u72b6\u6001\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  receipt: '\u51e0\u4f55\u56de\u6267\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  dimensions: '\u51e0\u4f55\u5c3a\u5bf8\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  counts: '\u51e0\u4f55\u8ba1\u6570\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  failedStage: '\u5931\u8d25\u9636\u6bb5\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  receiptState: '\u56de\u6267\u72b6\u6001\uff1a',
  // i18n-allow: Reviewed Chinese CAD geometry receipt result copy.
  next: '\u4e0b\u4e00\u6b65\uff1a',
} as const;

function formatGroundedCadGeometryExtractionResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const actionText = resultTaskText(input);
  if (!requiresCadGeometryExtractionOnly(actionText)) return null;
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    /^floorplan_extract_geometry$/i.test(String(item.name || ''))
  ));
  if (!record) return null;

  const zh = isChineseText(actionText);
  if (record.error) {
    const blocker = String(record.error || '').trim() || 'floorplan_extract_geometry failed.';
    return {
      text: zh
        ? [
            CAD_GEOMETRY_ZH.failed,
            `${CAD_GEOMETRY_ZH.reason}${blocker}`,
          ].join('\n')
        : [
            'Geometry extraction did not succeed; no drawing was executed.',
            `Reason: ${blocker}`,
          ].join('\n'),
      blocked: true,
      reason: `Geometry extraction tool failed: ${blocker}`,
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: blocker,
      },
    };
  }

  let parsed: Record<string, any>;
  try {
    const value = JSON.parse(String(record.result || ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('non-object receipt');
    parsed = value as Record<string, any>;
  } catch {
    const blocker = 'floorplan_extract_geometry returned malformed structured JSON.';
    return {
      text: zh
        ? [
            CAD_GEOMETRY_ZH.failed,
            `${CAD_GEOMETRY_ZH.reason}${blocker}`,
          ].join('\n')
        : [
            'Geometry extraction did not succeed; no drawing was executed.',
            `Reason: ${blocker}`,
          ].join('\n'),
      blocked: true,
      reason: blocker,
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: blocker,
      },
    };
  }

  const sourcePath = String(parsed.path || record.arguments?.imagePath || '').trim();
  const receiptPath = String(parsed.geometryReceiptPath || '').trim();
  const flag = (value: unknown) => value === true ? 'true' : value === false ? 'false' : 'unknown';
  const state = `parsed=${flag(parsed.parsed)}, geometryReady=${flag(parsed.geometryReady)}, geometryVerified=${flag(parsed.geometryVerified)}`;
  const verified = hasVerifiedCadGeometryExtractionEvidence([record]);
  if (verified) {
    const width = Number(parsed?.geometryReview?.width || 0);
    const height = Number(parsed?.geometryReview?.height || 0);
    const countEntries = Object.entries(parsed?.geometryReview?.counts || {})
      .filter(([, value]) => Number(value) > 0)
      .map(([key, value]) => `${key}=${Number(value)}`);
    const lines = zh
      ? [
          CAD_GEOMETRY_ZH.succeeded,
          sourcePath ? `${CAD_GEOMETRY_ZH.source}${sourcePath}` : '',
          `${CAD_GEOMETRY_ZH.verificationState}${state}\u3002`,
          receiptPath ? `${CAD_GEOMETRY_ZH.receipt}${receiptPath}` : '',
          width > 0 && height > 0 ? `${CAD_GEOMETRY_ZH.dimensions}${width} x ${height}\u3002` : '',
          countEntries.length > 0 ? `${CAD_GEOMETRY_ZH.counts}${countEntries.join(', ')}\u3002` : '',
        ]
      : [
          'Geometry extraction succeeded; no drawing was executed.',
          sourcePath ? `Source: ${sourcePath}` : '',
          `Verification state: ${state}.`,
          receiptPath ? `Geometry receipt: ${receiptPath}` : '',
          width > 0 && height > 0 ? `Geometry dimensions: ${width} x ${height}.` : '',
          countEntries.length > 0 ? `Geometry counts: ${countEntries.join(', ')}.` : '',
        ];
    return {
      text: lines.filter(Boolean).join('\n'),
      blocked: false,
      reason: 'Grounded geometry-extraction success from a verified floorplan_extract_geometry receipt.',
    };
  }

  const failedStage = String(parsed.failedStage || 'verification').trim();
  const parseError = String(
    parsed.parseError
    || parsed?.geometryReview?.validation?.errors?.[0]
    || parsed?.geometryReview?.visualVerification?.criticalMismatches?.[0]
    || 'The geometry receipt did not pass readiness and verification.',
  ).trim();
  const next = String(parsed.next || '').trim();
  const lines = zh
    ? [
        CAD_GEOMETRY_ZH.failed,
        `${CAD_GEOMETRY_ZH.failedStage}${failedStage}\u3002`,
        `${CAD_GEOMETRY_ZH.receiptState}${state}\u3002`,
        `${CAD_GEOMETRY_ZH.reason}${parseError}`,
        next ? `${CAD_GEOMETRY_ZH.next}${next}` : '',
      ]
    : [
        'Geometry extraction did not succeed; no drawing was executed.',
        `Failed stage: ${failedStage}.`,
        `Receipt state: ${state}.`,
        `Reason: ${parseError}`,
        next ? `Next: ${next}` : '',
      ];
  const blocker = `Geometry extraction receipt reported ${failedStage}: ${parseError}`;
  return {
    text: lines.filter(Boolean).join('\n'),
    blocked: true,
    reason: blocker,
    notification: {
      type: 'work_product_guard',
      level: 'warning',
      message: blocker,
    },
  };
}

function formatGroundedWpsMutationResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const actionText = resultTaskText(input);
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    item.name === 'wps_create_document_with_text'
    && !item.error
    && String(item.result || '').trim()
  ));
  if (!record) return null;

  const primaryText = String(actionText || '').split(/\n## Recent action continuation context\b/i, 1)[0].trim();
  const target = extractCurrentAppTarget(actionText);
  const targetsWps = /(?:^|\b)wps(?:\s+office|\s+writer)?(?:\b|$)|\u91d1\u5c71/iu.test(target);
  // A direct "create a Word/document" request may not carry recovered
  // appTarget context even though the current-turn native WPS receipt proves
  // exactly which application performed the mutation. Accept that receipt as
  // the surface identity instead of discarding a verified in-app result.
  const directDocumentMutation = (
    /(?:\u65b0\u5efa|\u521b\u5efa|\u5199\u5165|\u8f93\u5165|\u7f16\u8f91|\u4fee\u6539)|\b(?:new|create|write|type|edit|modify)\b/iu.test(primaryText)
    && /(?:\bWPS\b|\bWord\b|\u6587\u6863)|\bdocument\b/iu.test(primaryText)
  );
  if (!targetsWps && !directDocumentMutation) return null;
  if (!requiresCurrentAppUiMutation(actionText) && !directDocumentMutation) return null;

  let receipt: Record<string, any>;
  try {
    const parsed = JSON.parse(String(record.result || ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    receipt = parsed as Record<string, any>;
  } catch {
    return null;
  }

  const requestedText = extractRequestedCurrentAppText(primaryText);
  const suppliedText = String(record.arguments?.text || '');
  const readBack = String(receipt.bodyTextWithoutTerminalParagraph || '');
  const attachmentMode = String(receipt.attachmentMode || '');
  const attachmentFlagsMatch = attachmentMode === 'attachedExisting'
    ? receipt.attachedExisting === true && receipt.newVisibleInstance === false
    : attachmentMode === 'newVisibleInstance'
      ? receipt.attachedExisting === false && receipt.newVisibleInstance === true
      : false;
  const verified = (
    receipt.ok === true
    && receipt.status === 'verified'
    && receipt.automation === 'KWPS.Application'
    && receipt.visible === true
    && receipt.documentCreated === true
    && receipt.exactTextMatch === true
    && receipt.processName === 'wps.exe'
    && Number(receipt.processId) > 0
    && attachmentFlagsMatch
    && Boolean(String(receipt.documentName || '').trim())
    && Boolean(String(receipt.windowTitle || '').trim())
    && receipt.saved === false
    && !String(receipt.savePath || '').trim()
    && suppliedText === requestedText
    && readBack === requestedText
  );
  if (!verified) return null;

  const zh = isChineseText(actionText);
  const userRequestedSave = /(?:\u4fdd\u5b58)|\b(?:save)\b/iu.test(primaryText);
  const documentName = String(receipt.documentName).trim();
  const windowTitle = String(receipt.windowTitle).trim();
  const processId = Number(receipt.processId);
  const lines = zh
    ? [
        requestedText
          ? CN_RESULT_GROUNDING_MESSAGES.wpsExactTextWritten(documentName, requestedText)
          : CN_RESULT_GROUNDING_MESSAGES.wpsBlankDocumentCreated(documentName),
        CN_RESULT_GROUNDING_MESSAGES.wpsWindow(windowTitle),
        CN_RESULT_GROUNDING_MESSAGES.wpsProcess(processId),
        CN_RESULT_GROUNDING_MESSAGES.wpsUnsaved,
      ]
    : [
        requestedText
          ? `Created visible WPS document "${documentName}" and wrote the exact requested text: ${requestedText}`
          : `Created visible blank WPS document "${documentName}".`,
        `Window: ${windowTitle}`,
        `Process: wps.exe (PID ${processId})`,
        'The document is currently unsaved.',
      ];
  return {
    text: lines.join('\n'),
    blocked: userRequestedSave,
    reason: userRequestedSave
      ? 'WPS document creation and exact text entry were verified, but the requested save action was not completed.'
      : requestedText
        ? 'Grounded WPS document creation and exact text entry from a verified KWPS.Application receipt.'
        : 'Grounded blank WPS document creation from a verified KWPS.Application receipt.',
    notification: userRequestedSave
      ? {
          type: 'work_product_guard',
          level: 'warning',
          message: 'The WPS document was created and populated, but it is not saved.',
        }
      : undefined,
  };
}

function formatGroundedCadRunResult(input: LumiResultFinalizerInput): LumiResultFinalizerResult | null {
  if (taskActionContract(input).kind !== 'cad_drafting') return null;
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    !item.error
    && /^(?:mcp_cad-drafting_autocad_playback_file|cad_draw_floorplan_in_autocad)$/i.test(String(item.name || ''))
    && String(item.result || '').trim()
  ));
  if (!record) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(String(record.result || ''));
  } catch {
    return null;
  }

  const actionText = resultTaskText(input);
  const zh = isChineseText(actionText);
  const markerPath = String(parsed?.completionMarkerPath || '').trim();
  const operationsPath = String(parsed?.operationsPath || parsed?.manifest?.operationsPath || '').trim();
  const executable = String(parsed?.autocadExecutable || parsed?.manifest?.autocadExecutable || '').trim();
  const executableSource = String(parsed?.autocadExecutableSource || parsed?.manifest?.autocadExecutableSource || '').trim();
  const operationCount = Number(parsed?.operationCount || parsed?.manifest?.operationCount || 0);
  const strokeDelayMs = Number(parsed?.strokeDelayMs || parsed?.manifest?.strokeDelayMs || 0);
  const expectedEntityCount = Number(parsed?.expectedEntityCount || 0);
  const entitiesAdded = Number(parsed?.entitiesAdded || 0);
  const completed = parsed?.status === 'completed'
    && parsed?.completionMarkerExists === true
    && parsed?.transport === 'mcp_autocad_com'
    && parsed?.visiblePlayback === true
    && parsed?.geometryVerified === true
    && parsed?.entityCountMatches === true
    && operationCount > 0
    && operationCount === expectedEntityCount
    && entitiesAdded === expectedEntityCount
    && Boolean(String(parsed?.operationSetId || '').trim());

  if (completed) {
    const lines = zh
      ? [
          CN_CAD_MESSAGES.playbackCompleted,
          markerPath ? `完成标记：${markerPath}` : '',
          operationsPath ? `${CN_CAD_MESSAGES.drawingOperations}${operationsPath}` : '',
          executable ? `AutoCAD：${executable}${executableSource ? `（来源：${executableSource}）` : ''}` : '',
          operationCount > 0 ? `已执行 ${operationCount} 个绘图操作。` : '',
          parsed?.geometryVerified === true && parsed?.geometryVerificationRequired === true && Boolean(String(parsed?.geometryReceiptPath || '').trim())
            ? CN_CAD_MESSAGES.sourceGeometryVerified
            : '',
          parsed?.entityCountMatches === true ? `${CN_CAD_MESSAGES.entityDeltaVerification}${entitiesAdded}/${expectedEntityCount}\u3002` : '',
        ]
      : [
          'The visible stroke-by-stroke playback completed in the real AutoCAD application through Lumi CAD MCP/COM and passed marker verification.',
          markerPath ? `Completion marker: ${markerPath}` : '',
          operationsPath ? `Drawing operations: ${operationsPath}` : '',
          executable ? `AutoCAD: ${executable}${executableSource ? ` (source: ${executableSource})` : ''}` : '',
          operationCount > 0 ? `${operationCount} drawing operations completed.` : '',
          strokeDelayMs > 0 ? `Visible stroke interval: ${strokeDelayMs} ms.` : '',
          parsed?.geometryVerified === true && parsed?.geometryVerificationRequired === true && Boolean(String(parsed?.geometryReceiptPath || '').trim())
            ? 'Source geometry verification: passed.'
            : '',
          parsed?.entityCountMatches === true ? `Entity delta verification: ${entitiesAdded}/${expectedEntityCount}.` : '',
        ];
    return {
      text: lines.filter(Boolean).join('\n'),
      blocked: false,
      reason: 'Grounded AutoCAD MCP/COM visible-playback summary from the CAD completion marker.',
    };
  }

  if (!requiresVisibleAutoCadExecution(actionText)) return null;
  const blocker = String(parsed?.blocker || parsed?.note || (
    parsed?.geometryVerified !== true
      ? 'AutoCAD geometry did not pass source verification.'
      : parsed?.entityCountMatches !== true
        ? 'AutoCAD entity-count verification did not pass.'
        : 'AutoCAD completion marker was not observed.'
  )).trim();
  const text = zh
    ? [
        '这次 AutoCAD 实际绘图还没有完成。',
        `阻塞点：${blocker}`,
        markerPath ? `待验收标记：${markerPath}` : '',
      ].filter(Boolean).join('\n')
    : [
        'The real AutoCAD drawing run is not complete yet.',
        `Blocker: ${blocker}`,
        markerPath ? `Expected completion marker: ${markerPath}` : '',
      ].filter(Boolean).join('\n');
  return {
    text,
    blocked: true,
    reason: blocker,
    notification: {
      type: 'work_product_guard',
      level: 'warning',
      message: blocker,
    },
  };
}

function formatGroundedBlankAutoCadDocumentResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  if (taskActionContract(input).kind !== 'cad_document') return null;
  if (!hasBlankAutoCadDocumentEvidence(input.toolRecords || [])) return null;
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    !item.error
    && /^mcp_cad-drafting_autocad_new_document$/i.test(String(item.name || ''))
    && String(item.result || '').trim()
  ));
  if (!record) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(String(record.result || ''));
  } catch {
    return null;
  }
  const document = String(parsed?.document || '').trim();
  const entityCount = Number(parsed?.entityCount);
  const zh = isChineseText(resultTaskText(input));
  return {
    text: zh
      ? CN_CAD_MESSAGES.blankDocumentCreated(document, entityCount)
      : `Created and focused the blank drawing ${document} in the real AutoCAD application; it currently contains ${entityCount} entities.`,
    blocked: false,
    reason: 'Grounded blank AutoCAD document result from a verified MCP/COM receipt.',
  };
}

function formatExternalAiCollaborationResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    !item.error
    && /^(?:external_ai_collaborate|external_ai_collect_answers|external_ai_session_status)$/i.test(String(item.name || ''))
    && String(item.result || '').trim()
  ));
  if (!record) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(String(record.result || ''));
  } catch {
    return null;
  }
  const sessionId = String(parsed?.sessionId || parsed?.session?.id || '').trim();
  if (!sessionId) return null;
  const dispatches = Array.isArray(parsed?.results)
    ? parsed.results
    : Array.isArray(parsed?.dispatches)
      ? parsed.dispatches
      : [];
  const answers = Array.isArray(parsed?.answers) ? parsed.answers : [];
  const answerByDispatch = new Map(answers.map((answer: any) => [String(answer?.dispatchId || ''), answer]));
  const answerByTarget = new Map(answers.map((answer: any) => [String(answer?.targetId || ''), answer]));
  const answeredCount = Number(parsed?.counts?.answered || dispatches.filter((item: any) => item?.status === 'answered').length);
  const pendingCount = Number(parsed?.counts?.pending || dispatches.filter((item: any) => ['submitted', 'pending', 'unknown', 'submitting'].includes(String(item?.status || ''))).length);
  const blockedCount = Number(parsed?.counts?.blocked || dispatches.filter((item: any) => item?.status === 'blocked').length);
  const failedCount = Number(parsed?.counts?.failed || dispatches.filter((item: any) => item?.status === 'failed').length);
  const lateCount = Number(parsed?.counts?.lateAnswers || answers.filter((answer: any) => answer?.late === true).length);
  const status = String(parsed?.status || parsed?.session?.status || 'waiting');
  const zh = isChineseText(resultTaskText(input));
  const lines = [
    zh
      ? CN_EXTERNAL_AI_MESSAGES.sessionStatus(status, sessionId)
      : `External AI collaboration: ${status} (session ${sessionId})`,
  ];

  for (const dispatch of dispatches) {
    const targetId = String(dispatch?.targetId || 'unknown');
    const targetLabel = String(dispatch?.targetLabel || targetId);
    const answer = answerByDispatch.get(String(dispatch?.id || '')) as any
      || answerByTarget.get(targetId) as any
      || null;
    const answerText = String(answer?.answerText || dispatch?.answerText || '').trim();
    const evidence = answer?.sourceEvidence || dispatch?.sourceEvidence || {};
    const route = String(evidence?.routeKind || dispatch?.routeKind || 'unknown');
    const source = [evidence?.provider, evidence?.model, evidence?.toolName]
      .map((value: unknown) => String(value || '').trim())
      .filter(Boolean)
      .join('/');
    const sourceLabel = source ? `${route}:${source}` : route;
    const dispatchStatus = String(dispatch?.status || (answerText ? 'answered' : 'unknown'));
    const late = answer?.late === true ? (zh ? CN_EXTERNAL_AI_MESSAGES.lateArchiveSuffix : ', late receipt archived') : '';
    if (dispatchStatus === 'answered' && answerText) {
      lines.push(zh
        ? CN_EXTERNAL_AI_MESSAGES.answeredTarget(targetLabel, sourceLabel, late, answerText.slice(0, 1600))
        : `- ${targetLabel}: answered; source ${sourceLabel}${late}\n  ${answerText.slice(0, 1600)}`);
      continue;
    }
    const detail = String(dispatch?.blocker || dispatch?.error || '').trim();
    lines.push(zh
      ? CN_EXTERNAL_AI_MESSAGES.targetState(targetLabel, dispatchStatus, sourceLabel, detail)
      : `- ${targetLabel}: ${dispatchStatus}; source ${sourceLabel}${detail ? `; ${detail}` : ''}`);
  }

  lines.push(zh
    ? CN_EXTERNAL_AI_MESSAGES.summary({
        answered: answeredCount,
        pending: pendingCount,
        blocked: blockedCount,
        failed: failedCount,
        late: lateCount,
      })
    : `Summary: ${answeredCount} answered, ${pendingCount} pending/unknown, ${blockedCount} blocked, ${failedCount} failed${lateCount ? `, ${lateCount} late archived` : ''}. Unanswered targets are not represented as complete and are not automatically resent through another route.`);

  return {
    text: lines.join('\n'),
    blocked: answeredCount === 0,
    reason: `Grounded external AI collaboration receipt: status=${status}; session=${sessionId}.`,
  };
}

function formatExternalAiHistoryResult(
  input: LumiResultFinalizerInput,
): LumiResultFinalizerResult | null {
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    !item.error
    && /^external_ai_history_(?:source_register|source_list|source_revoke|sync|status|query)$/i.test(String(item.name || ''))
    && String(item.result || '').trim()
  ));
  if (!record) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(String(record.result || ''));
  } catch {
    return null;
  }
  const zh = isChineseText(resultTaskText(input));
  const sourceId = String(parsed?.sourceId || parsed?.source?.id || '').trim();
  const targetId = String(parsed?.targetId || parsed?.source?.targetId || 'unknown').trim();
  const status = String(parsed?.status || 'unknown').trim();

  if (record.name === 'external_ai_history_sync') {
    const jobId = String(parsed?.jobId || '').trim();
    if (!sourceId || !jobId || parsed?.verified !== true) return null;
    const counts = parsed?.counts || {};
    const completeness = String(parsed?.completeness || 'unknown');
    const nextCursor = String(parsed?.nextCursor || '');
    const limitations = Array.isArray(parsed?.limitations)
      ? parsed.limitations.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : [];
    const detail = String(parsed?.error || parsed?.blocker || '').trim();
    const lines = zh
      ? [
          CN_EXTERNAL_AI_MESSAGES.historySyncStatus(targetId, status, String(parsed?.sourceKind || 'unknown'), jobId),
          CN_EXTERNAL_AI_MESSAGES.historyCounts(
            Number(counts.inserted || 0), Number(counts.updated || 0), Number(counts.skipped || 0),
            Number(counts.conflicted || 0), Number(counts.attachments || 0), Number(parsed?.pageCount || 0),
          ),
          CN_EXTERNAL_AI_MESSAGES.historyCompleteness(completeness, nextCursor),
          detail ? CN_EXTERNAL_AI_MESSAGES.historyBlocker(detail) : '',
          limitations.length ? CN_EXTERNAL_AI_MESSAGES.historyLimitations(limitations.join('；')) : '',
        ]
      : [
          `External AI history sync: ${status}; target ${targetId}; source ${String(parsed?.sourceKind || 'unknown')}; job ${jobId}.`,
          `Receipt: ${Number(counts.inserted || 0)} inserted, ${Number(counts.updated || 0)} updated, ${Number(counts.skipped || 0)} deduplicated, ${Number(counts.conflicted || 0)} conflicts, ${Number(counts.attachments || 0)} attachments, ${Number(parsed?.pageCount || 0)} pages.`,
          `Completeness: ${completeness}${nextCursor ? `; resume cursor ${nextCursor}` : ''}.`,
          detail ? `Not completed: ${detail}` : '',
          limitations.length ? `Limitations: ${limitations.join('; ')}` : '',
        ];
    return {
      text: lines.filter(Boolean).join('\n'),
      blocked: ['blocked', 'failed'].includes(status),
      reason: `Grounded external AI history sync receipt: status=${status}; source=${sourceId}; job=${jobId}.`,
    };
  }

  if (record.name === 'external_ai_history_query') {
    if (parsed?.ok !== true || status !== 'queried' || !sourceId || !Array.isArray(parsed?.messages)) return null;
    const messages = parsed.messages.slice(-50);
    const completeness = String(parsed?.completeness || 'source_bounded');
    const lines = [
      zh
        ? CN_EXTERNAL_AI_MESSAGES.historyQueryHeader(targetId, messages.length, completeness)
        : `Read ${messages.length} locally synchronized message(s) from ${targetId}; completeness: ${completeness}.`,
      ...messages.map((message: any) => {
        const role = String(message?.role || 'unknown');
        const messageId = String(message?.sourceExternalMessageId || message?.externalMessageId || 'derived');
        const content = String(message?.content || '').trim().slice(0, 1_600);
        return zh
          ? CN_EXTERNAL_AI_MESSAGES.historyMessage(role, content, messageId)
          : `- ${role} (${messageId}): ${content}`;
      }),
    ];
    const limitations = Array.isArray(parsed?.limitations)
      ? parsed.limitations.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : [];
    if (limitations.length) lines.push(zh
      ? CN_EXTERNAL_AI_MESSAGES.historyLimitations(limitations.join('；'))
      : `Limitations: ${limitations.join('; ')}`);
    return {
      text: lines.join('\n'),
      blocked: false,
      reason: `Grounded external AI history query receipt: source=${sourceId}; messages=${messages.length}.`,
    };
  }

  if (record.name === 'external_ai_history_source_list') {
    if (parsed?.ok !== true || !Array.isArray(parsed?.sources)) return null;
    const lines = parsed.sources.map((source: any) => {
      const itemStatus = String(source?.status || 'unknown');
      const itemId = String(source?.id || 'unknown');
      const itemTarget = String(source?.targetId || 'unknown');
      return zh
        ? CN_EXTERNAL_AI_MESSAGES.historySourceState(itemStatus, itemId, itemTarget)
        : `External AI history source: ${itemStatus}; target ${itemTarget}; source id ${itemId}.`;
    });
    return {
      text: lines.length ? lines.join('\n') : (zh ? CN_EXTERNAL_AI_MESSAGES.historyNoSources : 'No external AI history source is authorized in this scope.'),
      blocked: false,
      reason: 'Grounded external AI history source list receipt.',
    };
  }

  if (record.name === 'external_ai_history_status') {
    if (parsed?.ok !== true || !parsed?.source) return null;
    const counts = parsed?.counts || {};
    const base = zh
      ? CN_EXTERNAL_AI_MESSAGES.historySourceState(status, sourceId, targetId)
      : `External AI history source: ${status}; target ${targetId}; source id ${sourceId}.`;
    const countLine = zh
      ? CN_EXTERNAL_AI_MESSAGES.historyLedgerCounts(
          Number(counts.conversations || 0), Number(counts.messages || 0),
          Number(counts.attachments || 0), Number(counts.jobs || 0),
        )
      : `Local ledger: ${Number(counts.conversations || 0)} conversations, ${Number(counts.messages || 0)} messages, ${Number(counts.attachments || 0)} attachments, ${Number(counts.jobs || 0)} sync jobs.`;
    return { text: `${base}\n${countLine}`, blocked: false, reason: `Grounded external AI history status receipt: source=${sourceId}.` };
  }

  if (record.name === 'external_ai_history_source_register' || record.name === 'external_ai_history_source_revoke') {
    if (parsed?.ok !== true || !sourceId) return null;
    const state = record.name.endsWith('revoke') ? 'revoked' : status;
    return {
      text: zh
        ? CN_EXTERNAL_AI_MESSAGES.historySourceState(state, sourceId, targetId)
        : `External AI history source: ${state}; target ${targetId}; source id ${sourceId}.`,
      blocked: false,
      reason: `Grounded external AI history authorization receipt: status=${state}; source=${sourceId}.`,
    };
  }
  return null;
}

function formatDesktopAiRoundtableResult(input: LumiResultFinalizerInput): string | null {
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    !item.error && /^desktop_ai_roundtable$/i.test(String(item.name || '')) && String(item.result || '').trim()
  ));
  if (!record) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(String(record.result || ''));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.targets) || !parsed?.ask || !Array.isArray(parsed?.answers)) return null;

  const zh = isChineseText(resultTaskText(input));
  const askByTarget = new Map((parsed.ask.results || []).map((item: any) => [String(item?.target || ''), item]));
  const answerByTarget = new Map((parsed.answers || []).map((item: any) => [String(item?.target || ''), item]));
  const lines: string[] = [zh ? '桌面 AI 协同实执行结果：' : 'Desktop AI collaboration result:'];
  const collectedAnswers: string[] = [];
  let pendingSubmittedCount = 0;
  let blockedCount = 0;

  for (const target of parsed.targets) {
    const id = String(target?.id || target?.target || 'unknown');
    const label = String(target?.label || id);
    const ask = askByTarget.get(id) as any;
    const answer = answerByTarget.get(id) as any;
    const askStatus = String(ask?.status || '');
    const answerStatus = String(answer?.status || '');
    const answerText = String(answer?.answerText || '').trim();

    if (answerStatus === 'collected' && answerText) {
      collectedAnswers.push(answerText);
      lines.push(zh
        ? `- ${label}：已收集并验证可见回答：${answerText.slice(0, 1600)}`
        : `- ${label}: visible answer collected and verified: ${answerText.slice(0, 1600)}`);
      continue;
    }

    if (answerStatus === 'pending' && askStatus === 'submitted_unverified') {
      pendingSubmittedCount += 1;
      lines.push(zh
        ? `- ${label}：问题已粘贴并提交，但尚未读到完整的可见回答。`
        : `- ${label}: question pasted and submitted; a completed visible answer is still pending.`);
      continue;
    }

    if (answerStatus === 'needs_vision_setup') {
      lines.push(zh
        ? `- ${label}：问题已提交，但缺少可用的视觉读取模型，无法验收回答。`
        : `- ${label}: question submitted, but no vision reader was available to verify the answer.`);
      continue;
    }

    blockedCount += 1;
    const reason = String(answer?.note || answer?.blocker || ask?.note || ask?.inputEvidence?.reason || 'target execution was blocked').trim();
    lines.push(zh ? `- ${label}：未提交，阻塞点：${reason}` : `- ${label}: not submitted; blocker: ${reason}`);
  }

  if (collectedAnswers.length === parsed.targets.length && parsed.targets.length > 0) {
    const uniqueAnswers = new Set(collectedAnswers.map(answer => answer.trim().toLowerCase()));
    lines.push(zh
      ? `结论：已完成 ${collectedAnswers.length} 个目标的可见回答验收；${uniqueAnswers.size === 1 ? '各方回答一致。' : '各方回答存在差异，已在上方分别列出。'}`
      : `Conclusion: verified visible answers were collected from all ${collectedAnswers.length} targets; ${uniqueAnswers.size === 1 ? 'the answers agree.' : 'the answers differ and are listed separately above.'}`);
  } else if (collectedAnswers.length > 0) {
    lines.push(zh
      ? `结论：部分完成，已收集 ${collectedAnswers.length} 个回答，其余目标仍在等待或受阻。`
      : `Conclusion: partial completion; ${collectedAnswers.length} answer(s) were collected and the remaining targets are pending or blocked.`);
  } else if (pendingSubmittedCount > 0) {
    lines.push(zh
      ? `结论：${pendingSubmittedCount} 个目标已提交并待回答，${blockedCount} 个目标受账号或页面状态阻塞；这不是“应用未安装”。`
      : `Conclusion: ${pendingSubmittedCount} target(s) are submitted and pending; ${blockedCount} target(s) are blocked by account or page state. This is not app unavailable.`);
  } else {
    lines.push(zh
      ? `结论：未完成提交，${blockedCount} 个目标受阻。`
      : `Conclusion: no submission completed; ${blockedCount} target(s) were blocked.`);
  }
  return lines.join('\n');
}

function correctCurrentTurnContractDrift(
  input: LumiResultFinalizerInput,
  taskContract: ReturnType<typeof buildActionContract>,
): string | null {
  const actionText = resultTaskText(input);
  if (!taskContract.applies || taskContract.kind !== 'desktop_operation') return null;
  const responseContract = buildActionContract(input.responseText);
  if (!responseContract.applies || responseContract.kind === taskContract.kind) return null;
  if (hasCoreActionEvidence(responseContract, input.toolRecords || [], input.responseText)) return null;
  if (!hasCoreActionEvidence(taskContract, input.toolRecords || [], actionText)) return null;

  const requestedTarget = extractSimpleDesktopOpenTarget(actionText);
  const successfulOpen = [...(input.toolRecords || [])].reverse().find(record => (
    /^(?:desktop_open|browser_open_task)$/i.test(String(record.name || ''))
    && !record.error
    && String(record.result || '').trim()
  ));
  if (requestedTarget && successfulOpen) {
    return isChineseText(actionText)
      ? CN_VOICE_FAST_PATH_MESSAGES.opened(requestedTarget)
      : `Opened ${requestedTarget}.`;
  }

  const grounded = formatGroundedDesktopEvidence(input);
  if (grounded) {
    console.warn(`[ResultFinalizer] Corrected current-turn contract drift: task=${taskContract.kind}, response=${responseContract.kind}`);
  }
  return grounded;
}

function sanitizeUnsupportedRestatementAdditions(taskText: string, responseText: string, toolRecords: ToolExecutionRecord[]): string {
  if (toolRecords.length > 0) return responseText;
  if (!/(?:只|仅)?(?:复述|重复|完整说出|原样说出)|其他不变|只(?:说|保留|复述)事实/u.test(taskText)) return responseText;
  const unsupportedClaim = /(?:写|放|记)(?:进|到|在).{0,8}(?:日程|计划|任务)|(?:已经|已|我)?\s*(?:记下|记录|保存)(?:了|好)?|(?:到时|到时候|出发前|之后).{0,16}(?:提醒|通知)|(?:创建|新建|安排).{0,8}(?:任务|提醒|日程)/u;
  const explicitInTask = unsupportedClaim.test(taskText);
  if (explicitInTask) return responseText;
  const clauses = String(responseText || '').match(/[^。！？!?\n]+[。！？!?]?/gu) || [];
  const retained = clauses.filter(clause => !unsupportedClaim.test(clause)).join('').trim();
  return retained || responseText;
}

export function finalizeLumiResponse(input: LumiResultFinalizerInput): LumiResultFinalizerResult {
  input = {
    ...input,
    toolRecords: coalesceToolExecutionRecords(input.toolRecords || []),
  };
  const actionText = resultTaskText(input);
  const protocolLeak = leakedLegacyToolProtocol(input);
  if (protocolLeak) return protocolLeak;
  const safeResponseText = sanitizeInternalExecutionText(
    input.responseText,
    isChineseText(actionText) || isChineseText(input.responseText),
  );
  if (safeResponseText !== input.responseText) {
    input = { ...input, responseText: safeResponseText };
  }
  const factualResponseText = sanitizeUnsupportedRestatementAdditions(actionText, input.responseText, input.toolRecords || []);
  if (factualResponseText !== input.responseText) {
    input = { ...input, responseText: factualResponseText };
  }
  // A CAD workflow receipt owns both its execution truth and its user-facing
  // terminal state. Do not let model narration or a later generic guard hide
  // a verified completion or a concrete workflow blocker.
  const earlyGroundedCadRun = formatGroundedCadRunResult(input);
  if (earlyGroundedCadRun) return earlyGroundedCadRun;
  const modeSafeResponseText = sanitizeContradictoryOperationModeText(input);
  if (modeSafeResponseText !== input.responseText) {
    input = { ...input, responseText: modeSafeResponseText };
  }
  const unsupportedMode = unsupportedToolModeClaim(input);
  if (unsupportedMode) {
    return {
      text: unsupportedMode,
      blocked: true,
      reason: 'Response claimed a fictional tool-mode switch without a matching receipt.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Response claimed a fictional tool-mode switch without a matching receipt.',
      },
    };
  }
  const unsupportedAvailability = unsupportedToolAvailabilityExcuse(input);
  if (unsupportedAvailability) {
    return {
      text: unsupportedAvailability,
      blocked: true,
      reason: 'Response blamed a fictional user-switchable tool availability state without evidence.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Response blamed a fictional user-switchable tool availability state without evidence.',
      },
    };
  }
  const groundedClientAction = formatGroundedClientActionResult(input);
  if (groundedClientAction) {
    return {
      text: groundedClientAction,
      blocked: false,
      reason: 'Grounded Lumi client action from a verified state-diff receipt.',
    };
  }
  const actionContract = taskActionContract(input);
  const ordinaryConversation = (
    !actionContract.applies
    && (input.toolRecords || []).length === 0
    && hasExplicitNoMutationInstruction(actionText)
  );
  const guard = ordinaryConversation
    ? { text: input.responseText, blocked: false as const }
    : guardCompletionClaims({
        task: actionText,
        response: input.responseText,
        toolCalls: input.toolRecords || [],
        source: input.source,
      });
  const unsupportedDiagnostic = unsupportedPriorDiagnosticClaim(input);
  if (unsupportedDiagnostic) {
    return {
      text: unsupportedDiagnostic,
      blocked: true,
      reason: 'Response claimed a prior diagnostic run without matching diagnostic receipts.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Response claimed a prior diagnostic run without matching diagnostic receipts.',
      },
    };
  }
  const diagnosticResult = formatClientDiagnosticResult(input.toolRecords || [], actionText, input.responseText);
  if (diagnosticResult) {
    const diagnosticCompleted = hasSuccessfulSubstantiveClientDiagnosticReceipt(input.toolRecords || []);
    return {
      text: diagnosticResult,
      blocked: !diagnosticCompleted,
      reason: diagnosticCompleted
        ? 'Grounded client diagnostic summary from current-turn tool receipts.'
        : 'Client diagnostic did not produce a successful substantive receipt.',
      ...(!diagnosticCompleted ? {
        notification: {
          type: 'work_product_guard' as const,
          level: 'warning' as const,
          message: 'Client diagnostic did not produce a successful substantive receipt.',
        },
      } : {}),
    };
  }
  const unsupportedExecution = unsupportedToolExecutionClaim(input);
  if (unsupportedExecution) {
    return {
      text: unsupportedExecution,
      blocked: true,
      reason: 'Response claimed tool execution without matching tool records.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Response claimed tool execution without matching tool records.',
      },
    };
  }
  const unsupportedOngoingExecution = unsupportedOngoingExecutionClaim(input, !guard.blocked);
  if (unsupportedOngoingExecution) {
    return {
      text: unsupportedOngoingExecution,
      blocked: true,
      reason: 'Response claimed ongoing execution without a current-turn tool receipt.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Response claimed ongoing execution without a current-turn tool receipt.',
      },
    };
  }
  // Ordinary conversation has no execution contract. Keep it natural after
  // the protocol/evidence sanity checks above instead of forcing it through a
  // work-product completion guard.
  if (
    ordinaryConversation
    || (
      !actionContract.applies
      && (input.toolRecords || []).length === 0
      && input.flow?.completionEvidenceNeeded !== true
      && !guard.blocked
    )
  ) {
    return { text: input.responseText, blocked: false };
  }
  const groundedBlankCadDocument = formatGroundedBlankAutoCadDocumentResult(input);
  if (groundedBlankCadDocument) return groundedBlankCadDocument;
  const groundedWpsMutation = formatGroundedWpsMutationResult(input);
  if (groundedWpsMutation) return groundedWpsMutation;
  const groundedArtifact = formatGroundedArtifactResult(input);
  if (groundedArtifact) return groundedArtifact;
  const groundedCadGeometry = formatGroundedCadGeometryExtractionResult(input);
  if (groundedCadGeometry) return groundedCadGeometry;
  const groundedExternalAiHistory = formatExternalAiHistoryResult(input);
  if (groundedExternalAiHistory) return groundedExternalAiHistory;
  const groundedExternalAi = formatExternalAiCollaborationResult(input);
  if (groundedExternalAi) return groundedExternalAi;
  const groundedDesktopAi = formatDesktopAiRoundtableResult(input);
  if (groundedDesktopAi) {
    return {
      text: groundedDesktopAi,
      blocked: false,
      reason: 'Grounded desktop AI collaboration summary from structured tool evidence.',
    };
  }
  const groundedSimpleOpen = formatGroundedSimpleDesktopOpenResult(input);
  if (groundedSimpleOpen) {
    return {
      text: groundedSimpleOpen,
      blocked: false,
      reason: 'Grounded exact desktop-open success from the requested target receipt.',
    };
  }
  const groundedPartialAction = formatGroundedPartialActionResult(input);
  if (groundedPartialAction) return groundedPartialAction;
  const groundedDriftCorrection = correctCurrentTurnContractDrift(input, actionContract);
  if (groundedDriftCorrection) {
    return {
      text: groundedDriftCorrection,
      blocked: false,
      reason: 'Corrected current-turn action-contract drift using fresh desktop evidence.',
    };
  }
  // A successful read-only desktop receipt is the result for an observation
  // task. Do not let an unrelated auxiliary failure (for example a worker
  // attempting write_file after the process list was already returned)
  // overwrite that evidence with a generic incomplete-work guard.
  const groundedDesktopObservation = formatGroundedDesktopEvidence(input);
  if (groundedDesktopObservation) {
    return {
      text: groundedDesktopObservation,
      blocked: false,
      reason: 'Grounded desktop observation from current-turn tool receipts.',
    };
  }
  const responseClaimsIncomplete = /(?:\u8fd8|\u5c1a|\u4ecd)?(?:\u6ca1\u6709|\u6ca1|\u672a|\u5e76\u672a|\u4e0d\u7b97|\u4e0d\u80fd\u8bf4)[^\u3002\uFF01\uFF1F.!?\n]{0,18}(?:\u5b8c\u6210|\u53d1\u9001|\u53d1\u51fa|\u6253\u5f00|\u8bfb\u53d6|\u751f\u6210)|\b(?:not|isn'?t|wasn'?t|didn'?t|incomplete|unfinished)\b[^.!?\n]{0,40}\b(?:complete|completed|sent|opened|read|created|generated)\b/iu
    .test(input.responseText || '');
  const reportsToolIterationLimit = TOOL_ITERATION_LIMIT_RESPONSE_RE.test(input.responseText || '');
  const failedToolRecord = [...(input.toolRecords || [])].reverse().find(record => Boolean(record.error));
  const reportsFailedExecutionIncomplete = Boolean(
    responseClaimsIncomplete
    && failedToolRecord
    && (actionContract.applies || input.flow?.completionEvidenceNeeded),
  );
  if (reportsToolIterationLimit || reportsFailedExecutionIncomplete) {
    const reason = reportsToolIterationLimit
      ? 'Tool iteration limit reached before a verified final response.'
      : `Execution remained incomplete after ${String(failedToolRecord?.name || 'a tool')} failed.`;
    return {
      text: input.responseText,
      blocked: true,
      reason,
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: reason,
      },
    };
  }
  const claimsActionDone = !responseClaimsIncomplete && /(?:\u5df2\u7ecf|\u5df2|\u5b8c\u6210|\u53d1\u9001|\u53d1\u51fa|\u6253\u5f00\u4e86|\u770b\u5230|\u8bfb\u5230|\u8bfb\u53d6|\u603b\u7ed3|\u751f\u6210|done|complete|completed|success|sent|opened|read|viewed|created|generated)/iu
    .test(input.responseText || '');
  const claimsStockWatchStarted = /(?:\u5df2\u7ecf|\u5df2|\u5f00\u59cb|\u6b63\u5728|\u6301\u7eed|\u76ef\u76d8|\u76d1\u63a7|started|watching|monitoring|tracking)/iu
    .test(input.responseText || '');
  const currentAppMutationTask = requiresCurrentAppUiMutation(actionText);
  const legalExternalHandoffOnly =
    hasLegalExternalPlatformSignal(actionText) &&
    describesAuthorizedLegalExternalHandoff(input.responseText || '') &&
    !claimsExternalLegalPlatformFinalAction(input.responseText || '') &&
    !claimsExternalLegalPlatformResult(input.responseText || '');
  if (
    hasLegalExternalPlatformSignal(actionText) &&
    claimsExternalLegalPlatformFinalAction(input.responseText || '')
  ) {
    return {
      text: formatCompactBlockedResponse(input, 'External legal platform final action requires authorized collaboration.'),
      blocked: true,
      reason: 'External legal platform final action requires authorized collaboration.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'External legal platform final action requires authorized collaboration.',
      },
    };
  }
  if (
    hasLegalExternalPlatformSignal(actionText) &&
    claimsExternalLegalPlatformResult(input.responseText || '') &&
    !hasLegalExternalPlatformResultEvidence(input.toolRecords || [])
  ) {
    return {
      text: formatCompactBlockedResponse(input, 'Missing external legal platform result evidence.'),
      blocked: true,
      reason: 'Missing external legal platform result evidence.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Missing external legal platform result evidence.',
      },
    };
  }
  if (
    actionContract.kind === 'desktop_operation'
    && currentAppMutationTask
    && claimsActionDone
    && !hasCurrentAppUiMutationEvidence(input.toolRecords || [], actionText)
  ) {
    return {
      text: formatCreatedArtifactWithoutInAppCompletion(input)
        || formatCompactBlockedResponse(input, 'Missing verified in-app UI mutation evidence.'),
      blocked: true,
      reason: 'Missing verified in-app UI mutation evidence.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Missing verified in-app UI mutation evidence.',
      },
    };
  }
  if (
    actionContract.kind === 'desktop_operation'
    && currentAppMutationTask
    && claimsCurrentAppSaveCompletion(input.responseText || '')
    && !hasCurrentAppSaveEvidence(input.toolRecords || [], actionText)
  ) {
    return {
      text: formatCompactBlockedResponse(input, 'Missing verified in-app save evidence.'),
      blocked: true,
      reason: 'Missing verified in-app save evidence.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Missing verified in-app save evidence.',
      },
    };
  }
  if (
    actionContract.kind === 'stock_monitor' &&
    (claimsActionDone || claimsStockWatchStarted) &&
    hasContinuousStockWatchIntent(actionText) &&
    !hasContinuousStockWatchEvidence(input.toolRecords || [])
  ) {
    return {
      text: formatCompactBlockedResponse(input, 'Missing continuous stock watch evidence.'),
      blocked: true,
      reason: 'Missing continuous stock watch evidence.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Missing continuous stock watch evidence.',
      },
    };
  }
  if (
    actionContract.kind === 'cad_drafting' &&
    claimsActionDone &&
    requiresVisibleAutoCadExecution(actionText) &&
    !hasVisibleAutoCadExecutionEvidence(input.toolRecords || [], actionText)
  ) {
    return {
      text: formatCompactBlockedResponse(input, 'Missing visible AutoCAD execution evidence.'),
      blocked: true,
      reason: 'Missing visible AutoCAD execution evidence.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Missing visible AutoCAD execution evidence.',
      },
    };
  }
  if (
    actionContract.kind === 'browser_account' &&
    claimsActionDone &&
    requiresAuthenticatedWebResult(actionText) &&
    !legalExternalHandoffOnly &&
    !hasAuthenticatedWebResultEvidence(input.toolRecords || [], actionText)
  ) {
    return {
      text: formatCompactBlockedResponse(input, 'Missing authenticated browser result evidence.'),
      blocked: true,
      reason: 'Missing authenticated browser result evidence.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Missing authenticated browser result evidence.',
      },
    };
  }
  if (
    actionContract.kind === 'legal_document' &&
    claimsLegalDocumentCompletion(input.responseText || '') &&
    requiresLegalCurrentLawGate(actionText) &&
    !hasLegalDocumentProductionEvidence(input.toolRecords || [])
  ) {
    return {
      text: formatCompactBlockedResponse(input, 'Missing legal document production evidence.'),
      blocked: true,
      reason: 'Missing legal document production evidence.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Missing legal document production evidence.',
      },
    };
  }
  if (
    actionContract.kind === 'legal_document' &&
    claimsLegalDocumentCompletion(input.responseText || '') &&
    requiresLegalCurrentLawGate(actionText) &&
    !hasLegalCurrentLawGateEvidence(input.toolRecords || [])
  ) {
    return {
      text: formatCompactBlockedResponse(input, 'Missing current-law verification gate for legal document.'),
      blocked: true,
      reason: 'Missing current-law verification gate for legal document.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Missing current-law verification gate for legal document.',
      },
    };
  }
  if (
    actionContract.kind === 'legal_document' &&
    claimsLegalDocumentCompletion(input.responseText || '') &&
    requiresLegalCurrentLawGate(actionText) &&
    !hasLegalReasoningChainEvidence(input.toolRecords || [])
  ) {
    return {
      text: formatCompactBlockedResponse(input, 'Missing legal reasoning chain evidence.'),
      blocked: true,
      reason: 'Missing legal reasoning chain evidence.',
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: 'Missing legal reasoning chain evidence.',
      },
    };
  }
  if (shouldEnforceCoreActionContract(actionContract, actionText) && claimsActionDone && !legalExternalHandoffOnly && !hasCoreActionEvidence(actionContract, input.toolRecords || [], actionText)) {
    if (guard.blocked && guard.reasonCode === 'successful_irrelevant_evidence') {
      return {
        text: guard.text,
        blocked: true,
        reason: guard.reason,
        notification: {
          type: 'work_product_guard',
          level: 'warning',
          message: guard.reason || 'Current-turn tool evidence does not prove the requested action.',
        },
      };
    }
    return {
      text: formatCompactBlockedResponse(input, `Missing core evidence for ${actionContract.kind}.`),
      blocked: true,
      reason: `Missing core evidence for ${actionContract.kind}.`,
      notification: {
        type: 'work_product_guard',
        level: 'warning',
        message: `Missing core evidence for ${actionContract.kind}.`,
      },
    };
  }

  if (!guard.blocked) {
    return { text: input.responseText, blocked: false };
  }

  return {
    text: shouldUseCompactActionBlockedResponse(input)
      ? formatCompactBlockedResponse(input, guard.reason)
      : guard.text,
    blocked: true,
    reason: guard.reason,
    notification: {
      type: 'work_product_guard',
      level: 'warning',
      message: guard.reason || 'Completion claim needs verification.',
    },
  };
}
