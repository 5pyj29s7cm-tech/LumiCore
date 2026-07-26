import type { ToolExecutionRecord } from '../tools/types';

export function hasContinuousStockWatchIntent(text: string): boolean {
  return /(?:\u6301\u7eed|\u4e00\u76f4|\u5b9e\u65f6|\u76d8\u4e2d|\u5f00\u59cb|\u6b63\u5728)?.{0,12}(?:\u76ef\u76d8|\u76d1\u63a7|\u9884\u8b66|\u63d0\u9192)|(?:watch|monitor|track|alert|watchlist|price\s*alert|market\s*alert)/iu
    .test(text || '');
}

export function hasContinuousStockWatchEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => {
    if (record.error) return false;
    const name = String(record.name || '');
    const result = String(record.result || '');
    return /(?:alert|watchlist|reminder|autonomy_(?:register|set|list)_workflow|work_takeover_task_(?:create|advance|autorun|verify_result))/i.test(name)
      || /(?:alert|watchlist|reminder|scheduled|monitoring|workflow|price\s*alert|market\s*alert|\u9884\u8b66|\u63d0\u9192|\u76ef\u76d8\u4efb\u52a1|\u76d1\u63a7\u4efb\u52a1)/iu.test(result);
  });
}

export function requiresLegalCurrentLawGate(text: string): boolean {
  if (
    /(?:\u68c0\u7d22\u8ba1\u5212|\u68c0\u7d22\u884c\u52a8\u5355|\u5916\u90e8\u68c0\u7d22|\u6765\u6e90\u767b\u8bb0|\u6388\u6743\u534f\u4f5c|\u88c1\u5224\u6587\u4e66\u7f51|\u4eba\u6c11\u6cd5\u9662\u6848\u4f8b\u5e93|\u6cd5\u8749|\bAlpha\b|\u4f01\u67e5\u67e5|research plan|source register|authorized collaboration)/iu.test(text || '') &&
    !/(?:\u8d77\u8bc9\u72b6|\u8981\u7d20\u5f0f\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u8d28\u8bc1\u610f\u89c1|\u4ee3\u7406\u8bcd|\u6cd5\u5f8b\u610f\u89c1\u4e66|\u59d4\u6258\u624b\u7eed|\u7acb\u6848\u6750\u6599|\u8bc1\u636e\u76ee\u5f55|\u5408\u540c|\u534f\u8bae|\u6807\u4e66|\u6295\u6807\u4e66|\u6b63\u5f0f\u6587\u4e66|\u4ea4\u4ed8\u5305|pleading|complaint|defense|legal\s+opinion|contract|agreement|bid|tender|filing\s+packet|evidence\s+catalog)/iu.test(text || '')
  ) {
    return false;
  }
  return /(?:\u8d77\u8bc9\u72b6|\u8981\u7d20\u5f0f\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u8d28\u8bc1\u610f\u89c1|\u4ee3\u7406\u8bcd|\u6cd5\u5f8b\u610f\u89c1\u4e66|\u59d4\u6258\u624b\u7eed|\u7acb\u6848\u6750\u6599|\u8bc1\u636e\u76ee\u5f55|\u5408\u540c|\u534f\u8bae|\u6807\u4e66|\u6295\u6807\u4e66|\u6587\u4e66|\u8bc9\u72b6|pleading|complaint|defense|legal\s+opinion|contract|agreement|bid|tender|filing\s+packet|evidence\s+catalog)/iu
    .test(text || '');
}

export function claimsLegalDocumentCompletion(text: string): boolean {
  return /(?:\u5df2\u7ecf|\u5df2|\u5b8c\u6210|\u751f\u6210|\u51fa\u5177|\u4ea4\u4ed8|\u6b63\u5f0f|\u53ef\u76f4\u63a5\u4f7f\u7528|\u53ef\u4ee5\u76f4\u63a5\u4f7f\u7528|\u53ef\u63d0\u4ea4|\u53ef\u7acb\u6848|\u53ef\u7528|completed|created|generated|ready|formal|deliverable)/iu
    .test(text || '');
}

export function hasLegalDocumentProductionEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => {
    if (record.error) return false;
    const name = String(record.name || '');
    const result = String(record.result || '');
    return /^(legal_generate_(?!citation_verification_report)|legal_analyze_folder_and_draft_argument|legal_review_contract|legal_draft_contract|legal_finalize_delivery_package|legal_prepare_filing_handoff|create_docx|write_file)$/i.test(name)
      || /\.(?:docx|pdf|md|txt)\b|formal-document|litigation-packet|pleading|argument|opinion|\u8d77\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u4ee3\u7406\u8bcd|\u6cd5\u5f8b\u610f\u89c1|\u8bc1\u636e\u76ee\u5f55|\u6807\u4e66/iu.test(result);
  });
}

export function hasLegalCurrentLawGateEvidence(records: ToolExecutionRecord[]): boolean {
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

export function hasLegalReasoningChainEvidence(records: ToolExecutionRecord[]): boolean {
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

export function hasLegalExternalPlatformSignal(text: string): boolean {
  return /(?:\u6cd5\u9662\u7acb\u6848\u7f51|\u7f51\u4e0a\u7acb\u6848|\u4eba\u6c11\u6cd5\u9662\u5728\u7ebf\u670d\u52a1|\u6cd5\u9662\u5728\u7ebf\u670d\u52a1|\u4e2d\u56fd\u88c1\u5224\u6587\u4e66\u7f51|\u88c1\u5224\u6587\u4e66\u7f51|\u4eba\u6c11\u6cd5\u9662\u6848\u4f8b\u5e93|\u6cd5\u8749|\bAlpha\b|\u4f01\u67e5\u67e5|\u5929\u773c\u67e5|\u56fd\u5bb6\u4f01\u4e1a\u4fe1\u7528|\u6267\u884c\u4fe1\u606f\u516c\u5f00|wenshu|fachan|qichacha|court\s+filing|judgments?\s+online)/iu
    .test(text || '');
}

export function describesAuthorizedLegalExternalHandoff(text: string): boolean {
  return /(?:\u6388\u6743\u534f\u4f5c|\u534a\u81ea\u52a8|\u884c\u52a8\u5355|\u4ea4\u63a5\u5355|\u6765\u6e90\u767b\u8bb0|\u7ed3\u679c\u5f52\u6863|\u5f85\u5f8b\u5e08|\u5f85\u4eba\u5de5|\u4eba\u5de5\u6838\u5bf9|\u4eba\u5de5\u63d0\u4ea4|\u9700\u8981\u767b\u5f55|\u9700\u8981\u9a8c\u8bc1|\u4e0d\u4f1a\u81ea\u52a8|\u4e0d\u81ea\u52a8|\u672a\u63d0\u4ea4|\u4e0d\u7b7e\u540d|\u4e0d\u7f34\u8d39|\u4e0d\u786e\u8ba4\u9001\u8fbe|authorized collaboration|handoff|source register|manual review|not submit|not sign|not pay)/iu
    .test(text || '');
}

export function claimsExternalLegalPlatformFinalAction(text: string): boolean {
  const value = text || '';
  if (/(?:\u4e0d\u4f1a|\u4e0d\u80fd|\u4e0d\u5e94|\u672a|\u5f85|\u9700\u8981|\u5fc5\u987b).{0,14}(?:\u63d0\u4ea4|\u7acb\u6848|\u7b7e\u540d|\u7b7e\u7f72|\u7f34\u8d39|\u9001\u8fbe|\u64a4\u56de|\u548c\u89e3|submit|sign|pay|service|settle)/iu.test(value)) {
    return false;
  }
  return /(?:(?:\u5df2\u7ecf|\u5df2|\u5b8c\u6210|\u81ea\u52a8|\u5168\u81ea\u52a8).{0,24}(?:\u63d0\u4ea4\u7acb\u6848|\u7acb\u6848\u63d0\u4ea4|\u7f51\u4e0a\u7acb\u6848|\u7b7e\u540d|\u7b7e\u7f72|\u7f34\u8d39|\u786e\u8ba4\u9001\u8fbe|\u64a4\u56de|\u548c\u89e3\u627f\u8bfa|\u5bf9\u5916\u63d0\u4ea4))|(?:(?:auto|fully automatic|completed).{0,24}(?:filing|submitted|signature|signed|payment|paid|service|settlement))|(?:bypass(?:ed)?\s+(?:captcha|2fa|verification))/iu
    .test(value);
}

export function claimsExternalLegalPlatformResult(text: string): boolean {
  const value = text || '';
  if (describesAuthorizedLegalExternalHandoff(value)) return false;
  return /(?:(?:\u5df2\u7ecf|\u5df2|\u5b8c\u6210|\u67e5\u5230|\u68c0\u7d22\u5230|\u627e\u5230|\u67e5\u8be2\u5230|\u4e0b\u8f7d\u5230|\u6293\u53d6\u5230).{0,36}(?:\u6cd5\u8749|\bAlpha\b|\u4f01\u67e5\u67e5|\u88c1\u5224\u6587\u4e66|\u6848\u4f8b\u5e93|\u516c\u53f8|\u88ab\u6267\u884c|\u6cd5\u9662|\u7ed3\u679c))|(?:(?:\u6cd5\u8749|\bAlpha\b|\u4f01\u67e5\u67e5|\u88c1\u5224\u6587\u4e66\u7f51|\u4eba\u6c11\u6cd5\u9662\u6848\u4f8b\u5e93).{0,36}(?:\u67e5\u5230|\u68c0\u7d22\u5230|\u627e\u5230|\u7ed3\u679c|result))/iu
    .test(value);
}

export function hasLegalExternalPlatformResultEvidence(records: ToolExecutionRecord[]): boolean {
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
