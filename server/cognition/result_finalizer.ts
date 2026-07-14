import { guardCompletionClaims, needsCompletionEvidence } from '../work_product/completion_guard';
import type { ToolExecutionRecord } from '../tools/types';
import type { LumiTurnFlow } from './turn_flow';
import { formatDesktopObservationResult } from './desktop_observation';
import { formatClientDiagnosticResult } from './client_diagnostic_result';
import { CN_CAD_MESSAGES } from '../regions/packs/cn/cad_messages';
import {
  CN_MESSAGING_MESSAGES,
  formatCnMessagingContractBlocker,
  formatCnUnsupportedToolExecutionClaim,
} from '../regions/packs/cn/messaging_messages';
import {
  buildActionContract,
  hasAuthenticatedWebResultEvidence,
  hasCoreActionEvidence,
  hasVisibleAutoCadExecutionEvidence,
  requiresAuthenticatedWebResult,
  requiresVisibleAutoCadExecution,
  summarizeActionContractBlocker,
} from './action_contract';

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

function hasToolEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => Boolean(record.error) || Boolean(String(record.result || '').trim()));
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
  if (isChineseText(input.taskText) || isChineseText(input.responseText)) {
    return formatCnUnsupportedToolExecutionClaim(missing[0] === 'tool execution evidence' ? [] : missing);
  }
  return [
    missing[0] === 'tool execution evidence'
      ? 'No actual tool execution was recorded for this turn.'
      : `No actual tool call was recorded for: ${missing.join(', ')}.`,
    'I cannot present an unrecorded action as executed; the real tools must run before I report their results.',
  ].join('\n');
}

function taskActionContract(input: LumiResultFinalizerInput) {
  return buildActionContract(input.taskText);
}

function shouldRunCompletionGuard(input: LumiResultFinalizerInput): boolean {
  const toolRecords = input.toolRecords || [];
  if (hasToolEvidence(toolRecords)) return true;
  if (input.flow?.completionEvidenceNeeded) return true;
  if (needsCompletionEvidence(input.taskText)) return true;
  const actionContract = taskActionContract(input);
  if (actionContract.applies && actionContract.kind !== 'none') return true;

  const source = String(input.source || '').toLowerCase();
  if (['task', 'workflow', 'background_delegation', 'autonomous'].includes(source)) return true;

  return false;
}

function isChineseText(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value || '');
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
    return name || '\u5de5\u5177\u6267\u884c';
  })();
  return error ? `${action}: ${error}` : action;
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
  const contract = taskActionContract(input);
  if (shouldEnforceCoreActionContract(contract, input.taskText)) return true;
  const hasDesktopOrMessagingTool = records.some(record =>
    /^(desktop_|wechat_(?:send_message|send_file|read_recent_chat)|computer_use|keyboard_|mouse_|cursor_|get_active_window_info|capture_screen|ocr_screen)/i.test(String(record.name || ''))
  );
  if (!hasDesktopOrMessagingTool) return false;
  const text = `${input.taskText}\n${input.responseText}`;
  return /wechat|weixin|\u5fae\u4fe1|\u53d1\u9001|\u53d1\u7ed9|\u665a\u5b89|\u684c\u9762|\u6253\u5f00|\u805a\u7126|\u6700\u540e\u4e00\u6b65/i.test(text);
}

function shouldEnforceCoreActionContract(contract: ReturnType<typeof buildActionContract>, text: string): boolean {
  if (!contract.applies) return false;
  if (['messaging_read', 'messaging_send', 'browser_account', 'public_post', 'cad_drafting', 'customer_operations', 'ecommerce_operations', 'design_delivery', 'stock_monitor', 'desktop_operation'].includes(contract.kind)) {
    return true;
  }
  if (contract.kind === 'legal_document') {
    return /\u4ee3\u7406\u8bcd|\u8d77\u8bc9\u72b6|\u7b54\u8fa9\u72b6|pleading/i.test(text);
  }
  return false;
}

function hasContinuousStockWatchIntent(text: string): boolean {
  return /(?:\u6301\u7eed|\u4e00\u76f4|\u5b9e\u65f6|\u76d8\u4e2d|\u5f00\u59cb|\u6b63\u5728)?.{0,12}(?:\u76ef\u76d8|\u76d1\u63a7|\u9884\u8b66|\u63d0\u9192)|(?:watch|monitor|track|alert|watchlist|price\s*alert|market\s*alert)/iu
    .test(text || '');
}

function hasContinuousStockWatchEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => {
    if (record.error) return false;
    const name = String(record.name || '');
    const result = String(record.result || '');
    return /(?:alert|watchlist|reminder|autonomy_(?:register|set|list)_workflow|work_takeover_task_(?:create|advance|autorun|verify_result))/i.test(name)
      || /(?:alert|watchlist|reminder|scheduled|monitoring|workflow|price\s*alert|market\s*alert|\u9884\u8b66|\u63d0\u9192|\u76ef\u76d8\u4efb\u52a1|\u76d1\u63a7\u4efb\u52a1)/iu.test(result);
  });
}

function requiresLegalCurrentLawGate(text: string): boolean {
  if (
    /(?:\u68c0\u7d22\u8ba1\u5212|\u68c0\u7d22\u884c\u52a8\u5355|\u5916\u90e8\u68c0\u7d22|\u6765\u6e90\u767b\u8bb0|\u6388\u6743\u534f\u4f5c|\u88c1\u5224\u6587\u4e66\u7f51|\u4eba\u6c11\u6cd5\u9662\u6848\u4f8b\u5e93|\u6cd5\u8749|\bAlpha\b|\u4f01\u67e5\u67e5|research plan|source register|authorized collaboration)/iu.test(text || '') &&
    !/(?:\u8d77\u8bc9\u72b6|\u8981\u7d20\u5f0f\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u8d28\u8bc1\u610f\u89c1|\u4ee3\u7406\u8bcd|\u6cd5\u5f8b\u610f\u89c1\u4e66|\u59d4\u6258\u624b\u7eed|\u7acb\u6848\u6750\u6599|\u8bc1\u636e\u76ee\u5f55|\u5408\u540c|\u534f\u8bae|\u6807\u4e66|\u6295\u6807\u4e66|\u6b63\u5f0f\u6587\u4e66|\u4ea4\u4ed8\u5305|pleading|complaint|defense|legal\s+opinion|contract|agreement|bid|tender|filing\s+packet|evidence\s+catalog)/iu.test(text || '')
  ) {
    return false;
  }
  return /(?:\u8d77\u8bc9\u72b6|\u8981\u7d20\u5f0f\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u8d28\u8bc1\u610f\u89c1|\u4ee3\u7406\u8bcd|\u6cd5\u5f8b\u610f\u89c1\u4e66|\u59d4\u6258\u624b\u7eed|\u7acb\u6848\u6750\u6599|\u8bc1\u636e\u76ee\u5f55|\u5408\u540c|\u534f\u8bae|\u6807\u4e66|\u6295\u6807\u4e66|\u6587\u4e66|\u8bc9\u72b6|pleading|complaint|defense|legal\s+opinion|contract|agreement|bid|tender|filing\s+packet|evidence\s+catalog)/iu
    .test(text || '');
}

function claimsLegalDocumentCompletion(text: string): boolean {
  return /(?:\u5df2\u7ecf|\u5df2|\u5b8c\u6210|\u751f\u6210|\u51fa\u5177|\u4ea4\u4ed8|\u6b63\u5f0f|\u53ef\u76f4\u63a5\u4f7f\u7528|\u53ef\u4ee5\u76f4\u63a5\u4f7f\u7528|\u53ef\u63d0\u4ea4|\u53ef\u7acb\u6848|\u53ef\u7528|completed|created|generated|ready|formal|deliverable)/iu
    .test(text || '');
}

function hasLegalDocumentProductionEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => {
    if (record.error) return false;
    const name = String(record.name || '');
    const result = String(record.result || '');
    return /^(legal_generate_(?!citation_verification_report)|legal_analyze_folder_and_draft_argument|legal_review_contract|legal_draft_contract|legal_finalize_delivery_package|legal_prepare_filing_handoff|create_docx|write_file)$/i.test(name)
      || /\.(?:docx|pdf|md|txt)\b|formal-document|litigation-packet|pleading|argument|opinion|\u8d77\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u4ee3\u7406\u8bcd|\u6cd5\u5f8b\u610f\u89c1|\u8bc1\u636e\u76ee\u5f55|\u6807\u4e66/iu.test(result);
  });
}

function hasLegalCurrentLawGateEvidence(records: ToolExecutionRecord[]): boolean {
  const successful = records.filter(record => !record.error && String(record.result || '').trim());
  if (successful.length === 0) return false;

  const combined = successful.map(record => `${record.name}\n${record.result || ''}`).join('\n');
  if (/(?:\u73b0\u884c\u6709\u6548\u6cd5\u5f8b[^\n]{0,24}\u672a\u901a\u8fc7|\u786c\u95e8\u69db[^\n]{0,24}\u672a\u901a\u8fc7|current-law gate blocked|current law gate blocked|\u300a[^\n\u300b]{1,40}\u300b[^\n]{0,20}\u5df2\u5e9f\u6b62|\u5931\u6548\u98ce\u9669[^\d\n]{0,8}[1-9]|\u672a\u786e\u8ba4\u7684\u6cd5\u6761|\u4e0d\u5f97\u6807\u8bb0\u4e3a\u6b63\u5f0f\u6210\u679c)/iu.test(combined)) {
    return false;
  }

  return successful.some(record => {
    const name = String(record.name || '');
    const result = String(record.result || '');
    const isGateTool = /^(legal_generate_citation_verification_report|legal_finalize_delivery_package|legal_search_statute|legal_case_reasoning_matrix|legal_generate_litigation_packet|legal_generate_argument_or_opinion|legal_review_contract|legal_draft_contract|legal_generate_bid)$/i.test(name);
    if (!isGateTool) return false;
    return /(?:\u73b0\u884c\u6709\u6548\u6cd5\u5f8b(?:\u9884\u68c0|\u786c\u95e8\u69db)?[\uff1a:]\s*\u901a\u8fc7|\u5df2\u5e9f\u6b62\/\u5931\u6548\u98ce\u9669[\uff1a:]\s*0|current-?law\s+gate[^.\n]{0,40}pass|"currentLawGate"\s*:\s*"passed"|"passed"\s*:\s*true)/iu.test(result);
  });
}

function hasLegalReasoningChainEvidence(records: ToolExecutionRecord[]): boolean {
  const successful = records.filter(record => !record.error && String(record.result || '').trim());
  if (successful.length === 0) return false;

  const combined = successful.map(record => `${record.name}\n${record.result || ''}`).join('\n');
  if (/(?:\u6cd5\u5f8b\u5206\u6790\u4e09\u6bb5\u8bba\u5e95\u7a3f|\u4e09\u6bb5\u8bba|\u5927\u524d\u63d0|\u5c0f\u524d\u63d0|\u6db5\u6444|major\s+premise|minor\s+premise|subsumption|reasoning\s+matrix)/iu.test(combined)) {
    return true;
  }

  const hasReasoningCapableProduct = successful.some(record => {
    const name = String(record.name || '');
    const result = String(record.result || '');
    const isReasoningCapableTool = /^(legal_case_reasoning_matrix|legal_generate_litigation_packet|legal_generate_argument_or_opinion|legal_analyze_folder_and_draft_argument|legal_review_contract|legal_draft_contract|legal_finalize_delivery_package|legal_generate_bid)$/i.test(name);
    if (!isReasoningCapableTool) return false;
    return /(?:\u4e89\u8bae\u7126\u70b9|\u4e8b\u5b9e\u9002\u7528\u5206\u6790|\u6cd5\u5f8b\u9002\u7528|\u8bc1\u636e\u8bc4\u4ef7|\u8bc1\u636e\u76ee\u5f55|\u8bc1\u660e\u76ee\u7684|\u5f85\u8bc1\u4e8b\u5b9e|\u8d28\u8bc1|\u7ed3\u8bba|dispute\s+issue|application|conclusion|evidence\s+catalog|proof\s+purpose)/iu.test(result);
  });
  if (!hasReasoningCapableProduct) return false;

  const hasLaw = /(?:\u6cd5\u5f8b\u4f9d\u636e|\u73b0\u884c\u6709\u6548\u6cd5\u5f8b|\u6cd5\u6761|\u6cd5\u5f8b\u9002\u7528|\u88c1\u5224\u89c4\u5219|\u7c7b\u6848|current-?law|statute|legal\s+(?:basis|authority)|citation)/iu.test(combined);
  const hasFactEvidence = /(?:\u4e8b\u5b9e\u4e0e\u8bc1\u636e|\u4e8b\u5b9e|\u8bc1\u636e|\u8bc1\u636e\u8bc4\u4ef7|\u8bc1\u636e\u76ee\u5f55|\u8bc1\u660e\u76ee\u7684|\u5f85\u8bc1\u4e8b\u5b9e|\u4e3e\u8bc1|\u8d28\u8bc1|facts?|evidence|proof\s+purpose|burden\s+of\s+proof)/iu.test(combined);
  const hasApplication = /(?:\u4e8b\u5b9e\u9002\u7528\u5206\u6790|\u6cd5\u5f8b\u9002\u7528|\u4e89\u8bae\u7126\u70b9|\u7ed3\u8bba|\u8bf7\u6c42\u6743\u57fa\u7840|\u6297\u8fa9\u7406\u7531|application|analysis|conclusion|subsumption)/iu.test(combined);
  return hasLaw && hasFactEvidence && hasApplication;
}

function hasLegalExternalPlatformSignal(text: string): boolean {
  return /(?:\u6cd5\u9662\u7acb\u6848\u7f51|\u7f51\u4e0a\u7acb\u6848|\u4eba\u6c11\u6cd5\u9662\u5728\u7ebf\u670d\u52a1|\u6cd5\u9662\u5728\u7ebf\u670d\u52a1|\u4e2d\u56fd\u88c1\u5224\u6587\u4e66\u7f51|\u88c1\u5224\u6587\u4e66\u7f51|\u4eba\u6c11\u6cd5\u9662\u6848\u4f8b\u5e93|\u6cd5\u8749|\bAlpha\b|\u4f01\u67e5\u67e5|\u5929\u773c\u67e5|\u56fd\u5bb6\u4f01\u4e1a\u4fe1\u7528|\u6267\u884c\u4fe1\u606f\u516c\u5f00|wenshu|fachan|qichacha|court\s+filing|judgments?\s+online)/iu
    .test(text || '');
}

function describesAuthorizedLegalExternalHandoff(text: string): boolean {
  return /(?:\u6388\u6743\u534f\u4f5c|\u534a\u81ea\u52a8|\u884c\u52a8\u5355|\u4ea4\u63a5\u5355|\u6765\u6e90\u767b\u8bb0|\u7ed3\u679c\u5f52\u6863|\u5f85\u5f8b\u5e08|\u5f85\u4eba\u5de5|\u4eba\u5de5\u6838\u5bf9|\u4eba\u5de5\u63d0\u4ea4|\u9700\u8981\u767b\u5f55|\u9700\u8981\u9a8c\u8bc1|\u4e0d\u4f1a\u81ea\u52a8|\u4e0d\u81ea\u52a8|\u672a\u63d0\u4ea4|\u4e0d\u7b7e\u540d|\u4e0d\u7f34\u8d39|\u4e0d\u786e\u8ba4\u9001\u8fbe|authorized collaboration|handoff|source register|manual review|not submit|not sign|not pay)/iu
    .test(text || '');
}

function claimsExternalLegalPlatformFinalAction(text: string): boolean {
  const value = text || '';
  if (/(?:\u4e0d\u4f1a|\u4e0d\u80fd|\u4e0d\u5e94|\u672a|\u5f85|\u9700\u8981|\u5fc5\u987b).{0,14}(?:\u63d0\u4ea4|\u7acb\u6848|\u7b7e\u540d|\u7b7e\u7f72|\u7f34\u8d39|\u9001\u8fbe|\u64a4\u56de|\u548c\u89e3|submit|sign|pay|service|settle)/iu.test(value)) {
    return false;
  }
  return /(?:(?:\u5df2\u7ecf|\u5df2|\u5b8c\u6210|\u81ea\u52a8|\u5168\u81ea\u52a8).{0,24}(?:\u63d0\u4ea4\u7acb\u6848|\u7acb\u6848\u63d0\u4ea4|\u7f51\u4e0a\u7acb\u6848|\u7b7e\u540d|\u7b7e\u7f72|\u7f34\u8d39|\u786e\u8ba4\u9001\u8fbe|\u64a4\u56de|\u548c\u89e3\u627f\u8bfa|\u5bf9\u5916\u63d0\u4ea4))|(?:(?:auto|fully automatic|completed).{0,24}(?:filing|submitted|signature|signed|payment|paid|service|settlement))|(?:bypass(?:ed)?\s+(?:captcha|2fa|verification))/iu
    .test(value);
}

function claimsExternalLegalPlatformResult(text: string): boolean {
  const value = text || '';
  if (describesAuthorizedLegalExternalHandoff(value)) return false;
  return /(?:(?:\u5df2\u7ecf|\u5df2|\u5b8c\u6210|\u67e5\u5230|\u68c0\u7d22\u5230|\u627e\u5230|\u67e5\u8be2\u5230|\u4e0b\u8f7d\u5230|\u6293\u53d6\u5230).{0,36}(?:\u6cd5\u8749|\bAlpha\b|\u4f01\u67e5\u67e5|\u88c1\u5224\u6587\u4e66|\u6848\u4f8b\u5e93|\u516c\u53f8|\u88ab\u6267\u884c|\u6cd5\u9662|\u7ed3\u679c))|(?:(?:\u6cd5\u8749|\bAlpha\b|\u4f01\u67e5\u67e5|\u88c1\u5224\u6587\u4e66\u7f51|\u4eba\u6c11\u6cd5\u9662\u6848\u4f8b\u5e93).{0,36}(?:\u67e5\u5230|\u68c0\u7d22\u5230|\u627e\u5230|\u7ed3\u679c|result))/iu
    .test(value);
}

function hasLegalExternalPlatformResultEvidence(records: ToolExecutionRecord[]): boolean {
  const successful = records.filter(record => !record.error && String(record.result || '').trim());
  if (successful.length === 0) return false;

  return successful.some(record => {
    const name = String(record.name || '');
    const result = String(record.result || '');
    if (/manual_required|captcha|2FA|QR|\u9a8c\u8bc1\u7801|\u626b\u7801|\u4ed8\u8d39|\u9700\u8981\u767b\u5f55|\u672a\u914d\u7f6e|not configured|login required/i.test(result)) {
      return false;
    }
    const resultTool = /^(legal_search_external_authorities|legal_company_database_lookup|legal_trace_assets|legal_equity_penetration|url_fetch_logged_in|mcp_playwright_browser_snapshot|mcp_playwright_browser_evaluate|browser_open_task)$/i.test(name);
    const hasResultMarkers = /(?:\u6765\u6e90\u767b\u8bb0|\u590d\u6838\u72b6\u6001|\u6848\u53f7|\u6cd5\u9662|\u88c1\u5224|\u80a1\u4e1c|\u88ab\u6267\u884c|\u516c\u53f8|\u641c\u7d22\u7ed3\u679c|Page URL|source-register|result|title|case|company)/iu.test(result);
    return resultTool && hasResultMarkers;
  });
}

function formatCompactBlockedResponse(input: LumiResultFinalizerInput, reason?: string): string {
  const zh = isChineseText(input.taskText) || isChineseText(input.responseText);
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
  return formatDesktopObservationResult(input.toolRecords || [], input.taskText);
}

function formatGroundedCadRunResult(input: LumiResultFinalizerInput): LumiResultFinalizerResult | null {
  if (taskActionContract(input).kind !== 'cad_drafting') return null;
  const record = [...(input.toolRecords || [])].reverse().find(item => (
    !item.error
    && /^mcp_cad-drafting_autocad_playback_file$/i.test(String(item.name || ''))
    && String(item.result || '').trim()
  ));
  if (!record) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(String(record.result || ''));
  } catch {
    return null;
  }

  const zh = isChineseText(input.taskText);
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
          parsed?.geometryVerified === true ? CN_CAD_MESSAGES.sourceGeometryVerified : '',
          parsed?.entityCountMatches === true ? `${CN_CAD_MESSAGES.entityDeltaVerification}${entitiesAdded}/${expectedEntityCount}\u3002` : '',
        ]
      : [
          'The visible stroke-by-stroke playback completed in the real AutoCAD application through Lumi CAD MCP/COM and passed marker verification.',
          markerPath ? `Completion marker: ${markerPath}` : '',
          operationsPath ? `Drawing operations: ${operationsPath}` : '',
          executable ? `AutoCAD: ${executable}${executableSource ? ` (source: ${executableSource})` : ''}` : '',
          operationCount > 0 ? `${operationCount} drawing operations completed.` : '',
          strokeDelayMs > 0 ? `Visible stroke interval: ${strokeDelayMs} ms.` : '',
          parsed?.geometryVerified === true ? 'Source geometry verification: passed.' : '',
          parsed?.entityCountMatches === true ? `Entity delta verification: ${entitiesAdded}/${expectedEntityCount}.` : '',
        ];
    return {
      text: lines.filter(Boolean).join('\n'),
      blocked: false,
      reason: 'Grounded AutoCAD MCP/COM visible-playback summary from the CAD completion marker.',
    };
  }

  if (!requiresVisibleAutoCadExecution(input.taskText)) return null;
  const blocker = String(parsed?.note || (
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

  const zh = isChineseText(input.taskText);
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
  if (!taskContract.applies || taskContract.kind !== 'desktop_operation') return null;
  const responseContract = buildActionContract(input.responseText);
  if (!responseContract.applies || responseContract.kind === taskContract.kind) return null;
  if (hasCoreActionEvidence(responseContract, input.toolRecords || [], input.responseText)) return null;
  if (!hasCoreActionEvidence(taskContract, input.toolRecords || [], input.taskText)) return null;

  const grounded = formatGroundedDesktopEvidence(input);
  if (grounded) {
    console.warn(`[ResultFinalizer] Corrected current-turn contract drift: task=${taskContract.kind}, response=${responseContract.kind}`);
  }
  return grounded;
}

export function finalizeLumiResponse(input: LumiResultFinalizerInput): LumiResultFinalizerResult {
  const diagnosticResult = formatClientDiagnosticResult(input.toolRecords || [], input.taskText);
  if (diagnosticResult) {
    return {
      text: diagnosticResult,
      blocked: false,
      reason: 'Grounded client diagnostic summary from current-turn tool receipts.',
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
  if (!shouldRunCompletionGuard(input)) {
    return { text: input.responseText, blocked: false };
  }

  const actionContract = taskActionContract(input);
  const groundedCadRun = formatGroundedCadRunResult(input);
  if (groundedCadRun) return groundedCadRun;
  const groundedDesktopAi = formatDesktopAiRoundtableResult(input);
  if (groundedDesktopAi) {
    return {
      text: groundedDesktopAi,
      blocked: false,
      reason: 'Grounded desktop AI collaboration summary from structured tool evidence.',
    };
  }
  const groundedDriftCorrection = correctCurrentTurnContractDrift(input, actionContract);
  if (groundedDriftCorrection) {
    return {
      text: groundedDriftCorrection,
      blocked: false,
      reason: 'Corrected current-turn action-contract drift using fresh desktop evidence.',
    };
  }
  const claimsActionDone = /(?:\u5df2\u7ecf|\u5df2|\u5b8c\u6210|\u53d1\u9001|\u53d1\u51fa|\u6253\u5f00\u4e86|\u770b\u5230|\u8bfb\u5230|\u8bfb\u53d6|\u603b\u7ed3|\u751f\u6210|done|complete|completed|success|sent|opened|read|viewed|created|generated)/iu
    .test(input.responseText || '');
  const claimsStockWatchStarted = /(?:\u5df2\u7ecf|\u5df2|\u5f00\u59cb|\u6b63\u5728|\u6301\u7eed|\u76ef\u76d8|\u76d1\u63a7|started|watching|monitoring|tracking)/iu
    .test(input.responseText || '');
  const actionText = input.taskText;
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
    !hasAuthenticatedWebResultEvidence(input.toolRecords || [], input.taskText)
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

  const guard = guardCompletionClaims({
    task: input.taskText,
    response: input.responseText,
    toolCalls: input.toolRecords || [],
    source: input.source,
  });

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
