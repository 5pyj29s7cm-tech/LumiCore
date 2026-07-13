import type { ToolExecutionRecord } from '../tools/types';
import { LEGAL_ENTRY_PREFERRED_TOOLS, isLegalEntryTurn, isRemoteLegalMessageTurn } from './legal_entry';

export type LumiActionContractKind =
  | 'none'
  | 'messaging_read'
  | 'messaging_send'
  | 'browser_account'
  | 'public_post'
  | 'cad_drafting'
  | 'customer_operations'
  | 'ecommerce_operations'
  | 'design_delivery'
  | 'stock_monitor'
  | 'legal_document'
  | 'desktop_operation'
  | 'artifact_work';

export interface LumiActionContract {
  applies: boolean;
  kind: LumiActionContractKind;
  label: string;
  coreAction: string;
  preparationIsNotCompletion: string[];
  requiredEvidence: string[];
  preferredTools: string[];
  verificationTools: string[];
  nextStep: string;
  caution: string;
}

const NONE_CONTRACT: LumiActionContract = {
  applies: false,
  kind: 'none',
  label: 'No external action contract',
  coreAction: '',
  preparationIsNotCompletion: [],
  requiredEvidence: [],
  preferredTools: [],
  verificationTools: [],
  nextStep: '',
  caution: '',
};

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function matches(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

const INJECTED_TASK_CONTEXT_RE = /(?:^|\r?\n)\s*##\s+(?:Current Turn Attachments|Recent action continuation context|Internal client-surface continuation context)\b/i;

function extractPrimaryTaskText(input: string): string {
  const raw = String(input || '');
  const marker = INJECTED_TASK_CONTEXT_RE.exec(raw);
  if (!marker || marker.index <= 0) return raw;
  return raw.slice(0, marker.index).trim();
}

function isCustomerOperationsTurn(text: string): boolean {
  const customerSurface = /(?:\u5ba2\u6237|\u9500\u552e|\u7ebf\u7d22|\u552e\u540e|\u5ba2\u670d|\u5de5\u5355|\u5546\u673a|\u5ba2\u6237\u5173\u7cfb|\bCRM\b|customer|sales|lead|after[-\s]?sales|support\s+ticket)/iu.test(text);
  const operationalIntent = /(?:\u63a5\u7ba1|\u8ddf\u8fdb|\u63a8\u8fdb|\u5904\u7406|\u5206\u6790|\u8bc4\u5206|\u62a5\u4ef7|\u56de\u8bbf|\u6210\u4ea4|\u5f02\u8bae|\u5206\u7c7b|\u6d3e\u5355|\u7ef4\u62a4|\u8fd0\u8425|take\s*over|follow\s*up|advance|triage|qualif|score|quote|handle|operate|manage)/iu.test(text);
  const legalOnly = /(?:\u5408\u540c\u5ba1\u67e5|\u6cd5\u5f8b\u610f\u89c1|\u8d77\u8bc9|\u7b54\u8fa9|\u4ee3\u7406\u8bcd|contract\s+review|legal\s+opinion|pleading)/iu.test(text);
  return customerSurface && operationalIntent && !legalOnly;
}

function isEcommerceOperationsTurn(text: string): boolean {
  const commerceSurface = /(?:\u7535\u5546|\u5e97\u94fa|\u5546\u54c1|\u5546\u5bb6\u540e\u53f0|\u8ba2\u5355|\u5e93\u5b58|\u8865\u8d27|\u6295\u653e|\u5e7f\u544a|\u8d26\u6237\u8fd0\u8425|\u5546\u54c1\u8be6\u60c5|\u6296\u5e97|\u6dd8\u5b9d|\u5929\u732b|\u4eac\u4e1c|\u62fc\u591a\u591a|\u5c0f\u7ea2\u4e66|\u6296\u97f3|\u5feb\u624b|\bSKU\b|e-?commerce|marketplace|seller|shopify|\bstore\b|inventory|campaign|listing)/iu.test(text);
  const operationalIntent = /(?:\u63a5\u7ba1|\u8fd0\u8425|\u4f18\u5316|\u5206\u6790|\u4f53\u68c0|\u6838\u7b97|\u5bf9\u8d26|\u8865\u8d27|\u589e\u957f|\u5185\u5bb9|\u77ed\u89c6\u9891|\u4e0a\u67b6|\u53d1\u5e03|\u7ba1\u7406|take\s*over|operate|optim|analy|audit|reconcile|restock|growth|content|publish|manage)/iu.test(text);
  return commerceSurface && operationalIntent;
}

function isCompositeDesignDeliveryTurn(text: string): boolean {
  if (/(?:\u5168\u5957\u8bbe\u8ba1|\u5168\u6848\u8bbe\u8ba1|\u5b8c\u6574\u4ea4\u4ed8\u5305|\u8bbe\u8ba1\u4ea4\u4ed8|\u88c5\u4fee\u4ea4\u4ed8|full\s+(?:design|renovation|interior)|design\s+(?:delivery|package|handoff))/iu.test(text)) return true;
  const groups = [
    /(?:\bCAD\b|\bDXF\b|\bDWG\b|AutoCAD|\u65bd\u5de5\u56fe|\u5e73\u9762\u56fe)/iu,
    /(?:Revit|\bBIM\b|\bIFC\b|Dynamo)/iu,
    /(?:PPT|\u6c47\u62a5|\u65b9\u6848\u4e66|proposal|presentation)/iu,
    /(?:\u6548\u679c\u56fe|\u6e32\u67d3|\u6d77\u62a5|logo|\u54c1\u724c\u89c6\u89c9|render|visual)/iu,
    /(?:\u9884\u7b97|\u6e05\u5355|\u6750\u6599\u8868|BOQ|bill\s+of\s+quantit)/iu,
  ].filter(pattern => pattern.test(text)).length;
  return groups >= 2;
}

function isDesignDeliveryTurn(text: string): boolean {
  const designSurface = /(?:\u88c5\u4fee|\u5bb6\u88c5|\u5de5\u88c5|\u5ba4\u5185\u8bbe\u8ba1|\u7a7a\u95f4\u8bbe\u8ba1|\u5efa\u7b51\u8bbe\u8ba1|\u54c1\u724c\u8bbe\u8ba1|\u89c6\u89c9\u8bbe\u8ba1|\u54c1\u724c\u521b\u610f|\u6548\u679c\u56fe|\u6e32\u67d3|\u6d77\u62a5|logo|Revit|\bBIM\b|\bIFC\b|interior\s+design|spatial\s+design|architectural\s+design|brand\s+design|visual\s+design|render)/iu.test(text);
  const deliveryIntent = /(?:\u8bbe\u8ba1|\u751f\u6210|\u5236\u4f5c|\u7ed8\u5236|\u51fa\u56fe|\u4ea4\u4ed8|\u63a5\u7ba1|\u65b9\u6848|\u6a21\u578b|\u6539\u56fe|design|create|generate|produce|deliver|take\s*over|model|revise)/iu.test(text);
  return isCompositeDesignDeliveryTurn(text) || (designSurface && deliveryIntent);
}

function hasNegatedMessagingSendIntent(text: string): boolean {
  return /(?:不要|别|无需|禁止).{0,32}(?:发送|发消息|回复|发出)|\b(?:do\s+not|don't|dont|never)\b.{0,64}\b(?:send|message|reply)\b|\bwithout\b.{0,40}\b(?:sending|messaging|replying)\b/iu.test(text);
}

export function requiresVisibleAutoCadExecution(input: string): boolean {
  const text = compact(input);
  if (!text) return false;
  const explicitDxfArtifactOnly = /\bDXF\b/i.test(text)
    && !/\bAutoCAD\b|\bacad(?:\.exe)?\b/i.test(text)
    && /(?:\u6587\u4ef6|\u5bfc\u51fa|\u751f\u6210|\u521b\u5efa|\u53ef\u7f16\u8f91|file|export|generate|create|editable)/iu.test(text);
  if (explicitDxfArtifactOnly) return false;
  const mentionsCadSurface =
    /(?:\bAutoCAD\b|\bacad(?:\.exe)?\b|\bCAD\b|(?:CAD|cad)\s*(?:\u56fe|\u56fe\u7eb8|\u8f6f\u4ef6|\u7a97\u53e3|\u754c\u9762|\u91cc|\u4e2d|app)|(?:\u5728|\u7528).{0,16}(?:AutoCAD|CAD|cad))/iu.test(text);
  const wantsVisibleDrawing =
    /(?:\u5b9e\u9645|\u771f\u6b63|\u53ef\u89c1|\u5b9e\u64cd|\u64cd\u4f5c|\u6253\u5f00|\u542f\u52a8|\u8fdb\u5165).{0,32}(?:\u753b|\u7ed8\u5236|\u6267\u884c|\u8dd1)|(?:\u753b\u51fa\u6765|\u7ed8\u5236\u51fa\u6765|\u4e00\u7b14\u4e00\u7b14|\u53ef\u89c1\u7ed8\u56fe|\u5b9e\u64cd\u753b\u56fe)/u.test(text)
    || /(?:\u753b|\u7ed8\u5236|\u51fa\u56fe|\u751f\u6210|\u521b\u5efa|\u8f6c\u6210|\u8fd8\u539f).{0,32}(?:AutoCAD|CAD|cad|\u56fe\u7eb8)|(?:AutoCAD|CAD|cad).{0,32}(?:\u753b|\u7ed8\u5236|\u51fa\u56fe|\u81ea\u52a8\u753b\u56fe)/iu.test(text)
    || /\b(?:actually|visible|visibly|real|run|execute|open|launch|stroke[-\s]?by[-\s]?stroke|step[-\s]?by[-\s]?step).{0,32}(?:draw|drawing|script|AutoCAD|CAD)\b/i.test(text)
    || /\b(?:draw|draft|render|create|generate|convert)\b.{0,32}\b(?:in|inside|through|with|to|as)?\s*(?:AutoCAD|CAD)\b/i.test(text)
    || /\b(?:AutoCAD|CAD)\b.{0,32}\b(?:draw|drawing|draft|render)\b/i.test(text);
  return mentionsCadSurface && wantsVisibleDrawing;
}

export function requiresAutoCadMcpPlayback(input: string): boolean {
  const text = compact(input);
  if (!text) return false;
  const mentionsMcp = /mcp_cad-drafting_autocad_playback_file|(?:AutoCAD|CAD)\s*MCP|MCP.{0,24}(?:AutoCAD|CAD)/i.test(text);
  const requiresExclusivePath =
    /(?:\u4ec5|\u53ea|\u53ea\u80fd|\u5fc5\u987b|\u52a1\u5fc5|\u4e0d\u8981|\u522b|\u7981\u6b62|\u4e0d\u5f97|\u4e0d\u80fd|\u4e0d\u51c6).{0,48}(?:AutoCAD\s*MCP|CAD\s*MCP|mcp_cad-drafting_autocad_playback_file|LISP|\u811a\u672c|\u56de\u9000|\u964d\u7ea7)/iu.test(text)
    || /\b(?:only|must|required|exclusively)\b.{0,64}\b(?:AutoCAD|CAD|MCP)\b|\b(?:do\s+not|don't|dont|without|no)\b.{0,64}\b(?:LISP|script|fallback)\b/i.test(text);
  return mentionsMcp && requiresExclusivePath;
}

function parseRecordJson(record: ToolExecutionRecord): Record<string, any> | null {
  try {
    const parsed = JSON.parse(String(record.result || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : null;
  } catch {
    return null;
  }
}

export function hasVisibleAutoCadExecutionEvidence(
  records: ToolExecutionRecord[] = [],
  _taskText = '',
): boolean {
  const successful = records.filter(record => !record.error && String(record.result || '').trim());
  if (successful.length === 0) return false;
  return successful.some(record => {
    if (!/^mcp_cad-drafting_autocad_playback_file$/i.test(record.name)) return false;
    const payload = parseRecordJson(record);
    return payload?.status === 'completed'
      && payload?.transport === 'mcp_autocad_com'
      && payload?.visiblePlayback === true
      && payload?.completionMarkerExists === true
      && payload?.geometryVerified === true
      && payload?.entityCountMatches === true
      && Number(payload?.operationCount) > 0
      && Number(payload?.operationCount) === Number(payload?.expectedEntityCount)
      && Number(payload?.entitiesAdded) === Number(payload?.expectedEntityCount)
      && Boolean(String(payload?.operationSetId || '').trim());
  });
}

export function requiresAuthenticatedWebResult(input: string): boolean {
  const text = compact(input);
  if (!text) return false;
  const hasAccountSurface = /\u767b\u5f55|\u81ea\u52a8\u767b\u5f55|\u8d26\u53f7|\u8d26\u6237|\u4f1a\u8bdd|login|log\s*in|sign\s*in|account|session/i.test(text);
  const hasTargetWork = /\u67e5|\u627e|\u641c|\u68c0\u7d22|\u8bfb|\u4e0b\u8f7d|\u6253\u5f00|find|search|query|look\s*up|fetch|download/i.test(text);
  return hasAccountSurface && hasTargetWork;
}

export function hasAuthenticatedWebResultEvidence(records: ToolExecutionRecord[] = [], text = ''): boolean {
  const successful = records.filter(record => !record.error && String(record.result || '').trim());
  if (successful.length === 0) return false;
  const task = compact(text);
  const searchIntent = /\u67e5|\u627e|\u641c|\u68c0\u7d22|find|search|query|look\s*up/i.test(task);
  const targetTerms = Array.from(new Set((task.match(/[\u4e00-\u9fff]{2,8}(?:省|市|自治区|案件|案号|法院|裁判|文书)?/g) || [])
    .filter(term => !/打开|登录|账号|自动登录|浏览器|网站|一下|这个|那个|案件$|裁判$|文书$/.test(term))
    .slice(0, 6)));

  const loggedIn = successful.some(record => {
    if (!/^web_login_run$/i.test(record.name)) return false;
    const result = String(record.result || '');
    const payload = parseRecordJson(record);
    return payload?.status === 'logged_in' || /"status"\s*:\s*"logged_in"|Login\/session is available/i.test(result);
  });

  if (!searchIntent) return loggedIn;

  return successful.some(record => {
    if (!/^(url_fetch_logged_in|mcp_playwright_browser_snapshot|mcp_playwright_browser_navigate|mcp_playwright_browser_evaluate|browser_open_task)$/i.test(record.name)) return false;
    const result = String(record.result || '');
    if (/open=login|登录\/注册|登录链接|please\s+login|requires authentication|captcha|验证码|2FA|manual_required/i.test(result)) return false;
    const hasTargetTerm = targetTerms.length === 0 || targetTerms.some(term => result.includes(term));
    return hasTargetTerm && /结果|列表|案件|裁判|文书|法院|Page URL|title|content|result|case|search/i.test(result);
  });
}

function withDefaults(contract: Omit<LumiActionContract, 'applies'>): LumiActionContract {
  return {
    ...contract,
    applies: true,
    preparationIsNotCompletion: unique(contract.preparationIsNotCompletion),
    requiredEvidence: unique(contract.requiredEvidence),
    preferredTools: unique(contract.preferredTools),
    verificationTools: unique(contract.verificationTools),
  };
}

function buildLegalDocumentContract(): LumiActionContract {
  return withDefaults({
    kind: 'legal_document',
    label: '\u6cd5\u5f8b\u6587\u4e66/\u4ee3\u7406\u8bcd',
    coreAction: '\u4ee5\u4e09\u6bb5\u8bba\u4e3a\u6838\u5fc3\u57fa\u7840\uff0c\u57fa\u4e8e\u7528\u6237\u63d0\u4f9b\u7684\u4e8b\u5b9e\u548c\u6587\u4ef6\u8d77\u8349\u6216\u5ba1\u9605\u6cd5\u5f8b\u6587\u4e66',
    preparationIsNotCompletion: ['\u6cd5\u5f8b\u5e38\u8bc6\u8bf4\u660e', '\u5217\u5927\u7eb2', '\u6ca1\u6709\u8bfb\u5230\u6848\u60c5\u6750\u6599', '\u5916\u90e8\u5e73\u53f0\u68c0\u7d22\u884c\u52a8\u5355\u4e0d\u7b49\u4e8e\u5df2\u5b8c\u6210\u67e5\u8be2\u6216\u7acb\u6848'],
    requiredEvidence: ['draft/review text grounded in supplied facts', '\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u6838\u9a8c gate \u901a\u8fc7', '\u4e09\u6bb5\u8bba\u63a8\u7406\u94fe/\u6cd5\u5f8b\u4f9d\u636e-\u4e8b\u5b9e\u8bc1\u636e-\u6db5\u6444\u7ed3\u8bba\u8bc1\u636e', '\u6587\u4e66\u6587\u4ef6\u8def\u5f84\u6216\u660e\u786e\u7684\u5ba1\u9605\u610f\u89c1', '\u5916\u90e8\u5e73\u53f0\u7ed3\u679c\u9700\u8981\u6388\u6743\u4f1a\u8bdd/API \u8bc1\u636e\u3001\u6765\u6e90\u767b\u8bb0\u6216\u5165\u6848\u5f52\u6863'],
    preferredTools: LEGAL_ENTRY_PREFERRED_TOOLS,
    verificationTools: ['legal_case_reasoning_matrix', 'legal_authority_source_status', 'legal_refresh_authoritative_sources', 'legal_generate_citation_verification_report', 'legal_finalize_delivery_package', 'legal_search_statute', 'read_docx', 'read_pdf', 'desktop_path_info', 'work_product_verify'],
    nextStep: '\u5148\u62ff\u5230\u4e8b\u5b9e\u3001\u8bc1\u636e\u3001\u8bc9\u8bbc\u76ee\u6807\u548c\u7ba1\u8f96\u7b49\u4fe1\u606f\uff0c\u518d\u8d77\u8349\u6216\u5ba1\u9605\u3002',
    caution: 'Do not present general legal guidance as a complete formal argument. External court, case-law, and company-research platforms support authorized collaboration, result archiving, and pre-delivery verification only. Material legal decisions require review by a qualified lawyer.',
  });
}

function buildCustomerOperationsContract(): LumiActionContract {
  return withDefaults({
    kind: 'customer_operations',
    label: 'Customer operations',
    coreAction: 'Inspect the supplied customer context, perform the requested sales/service work, and record a verifiable customer-facing or operational result.',
    preparationIsNotCompletion: [
      'a canned quotation or contract template',
      'a local customer takeover packet',
      'opening WeChat, CRM, or a customer page',
      'a reply draft that was not sent',
      'a task record with no customer or business outcome',
    ],
    requiredEvidence: [
      'grounded customer analysis based on supplied records when analysis is requested',
      'sent=true or an equivalent channel receipt when contact/reply is requested',
      'a verified document artifact when a quotation, proposal, or agreement is requested',
      'a concrete task/result record that distinguishes completed work from drafts and blockers',
    ],
    preferredTools: [
      'mcp_sales-customer-ops_lead_score',
      'mcp_sales-customer-ops_sales_followup_draft',
      'mcp_sales-customer-ops_objection_response_builder',
      'mcp_sales-customer-ops_customer_health_review',
      'mcp_sales-customer-ops_support_ticket_triage',
      'work_takeover_task_create',
      'work_takeover_task_orchestrate',
      'work_takeover_task_run_suggested_tool',
      'wechat_send_message',
      'create_docx',
      'create_pdf',
      'work_product_verify',
    ],
    verificationTools: ['wechat_send_message', 'work_takeover_task_get', 'work_product_verify', 'desktop_path_info'],
    nextStep: 'Read the actual customer context, choose the relevant customer-operations tool, execute the requested outcome, then verify the channel receipt, artifact, or recorded business result.',
    caution: 'Do not report customer takeover as complete from a local packet, generic template, opened window, or unsent draft.',
  });
}

function buildEcommerceOperationsContract(): LumiActionContract {
  return withDefaults({
    kind: 'ecommerce_operations',
    label: 'Ecommerce operations',
    coreAction: 'Use real supplied store, order, SKU, campaign, inventory, or platform state to perform the requested analysis, content production, or store operation.',
    preparationIsNotCompletion: [
      'a generic store audit checklist',
      'a local ecommerce growth packet',
      'image or video prompts without generated media',
      'opening a seller or creator platform',
      'a publish draft without a platform submission receipt',
    ],
    requiredEvidence: [
      'source-backed ecommerce analysis for analysis requests',
      'an actual image/video/file result for requested content production',
      'authenticated post-action platform state for store changes',
      'post-submit receipt or visible platform feedback for publishing',
    ],
    preferredTools: [
      'mcp_ecommerce-ops_product_listing_optimizer',
      'mcp_ecommerce-ops_ecommerce_order_profit',
      'mcp_ecommerce-ops_inventory_restock_plan',
      'mcp_ecommerce-ops_platform_settlement_reconcile',
      'mcp_ecommerce-ops_campaign_roi_analyzer',
      'mcp_ecommerce-ops_after_sales_risk_report',
      'mcp_content-ops_short_video_script',
      'generate_image',
      'generate_video',
      'web_login_run',
      'mcp_playwright_browser_snapshot',
      'work_product_verify',
    ],
    verificationTools: ['work_product_verify', 'desktop_path_info', 'mcp_playwright_browser_snapshot', 'desktop_capture_screen'],
    nextStep: 'Obtain the real source data or authenticated platform session, run the matching ecommerce operation, and verify the produced asset or post-action platform state.',
    caution: 'A local preparation packet or generated copy is not evidence that a store was operated, media was generated, or content was published.',
  });
}

function buildDesignDeliveryContract(): LumiActionContract {
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

export function buildActionContract(input: string): LumiActionContract {
  const rawInput = String(input || '');
  const primaryTaskText = extractPrimaryTaskText(rawInput);
  if (primaryTaskText && primaryTaskText.trim() !== rawInput.trim()) {
    const primaryContract = buildActionContract(primaryTaskText);
    if (primaryContract.applies && primaryContract.kind !== 'none') return primaryContract;
  }

  const text = compact(rawInput);
  if (!text) return NONE_CONTRACT;
  const negatedMessagingSend = hasNegatedMessagingSendIntent(text);
  const appInventoryInspection = /\b(?:inspect|check|list|show|find|detect|inventory)\b.{0,64}\b(?:installed|launchable|available|local|app|application|software|program|launch\s+target)\b|(?:\u68c0\u67e5|\u67e5\u770b|\u5217\u51fa|\u8bc6\u522b|\u68c0\u6d4b|\u76d8\u70b9|\u67e5\u627e).{0,32}(?:\u5df2\u5b89\u88c5|\u53ef\u542f\u52a8|\u5e94\u7528|\u8f6f\u4ef6|\u7a0b\u5e8f|\u542f\u52a8\u5165\u53e3|\u5b89\u88c5\u72b6\u6001)/iu.test(text);
  const directedMessageSend = matches(text, /(?:\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}\s*(?:\u53d1\u9001|\u53d1|\u56de\u590d|\u8bf4|\u544a\u8bc9))|(?:\u53d1\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})|(?:(?:\u53d1\u9001|\u53d1)\s*[\s\S]{1,200}?\s*\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})/u)
    || matches(text, /\b(?:send\s+(?:a\s+)?(?:message|note|reply)\s+to|send\s+(?:him|her|them|the\s+(?:client|customer|contact|group))|message\s+(?:him|her|them|the\s+(?:client|customer|contact|group)|@?(?!(?:has|have|had|is|was|were|contains?|includes?|body|content|attachment|file|text)\b)[\p{L}\p{N}_.'-]{1,40})|reply\s+to)\b/iu);

  if (isRemoteLegalMessageTurn(text)) {
    return buildLegalDocumentContract();
  }

  if (
    matches(text, /wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f|message|chat/i) &&
    matches(text, /\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u804a\u5929\u5185\u5bb9|\u804a\u5929\u8bb0\u5f55|\u603b\u7ed3|read|view|inspect|recent|history/i) &&
    !directedMessageSend &&
    !matches(text, /\u53d1\u9001|\u53d1\u7ed9|\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\bsend\b/i)
  ) {
    return withDefaults({
      kind: 'messaging_read',
      label: '\u524d\u53f0\u6d88\u606f\u8bfb\u53d6/\u804a\u5929\u67e5\u770b',
      coreAction: '\u5728\u771f\u5b9e\u6d88\u606f\u5e94\u7528\u91cc\u5b9a\u4f4d\u76ee\u6807\u4f1a\u8bdd\uff0c\u8bfb\u53d6\u5f53\u524d\u53ef\u89c1\u804a\u5929\u5185\u5bb9\u5e76\u8fd4\u56de\u53ef\u9a8c\u8bc1\u7684\u7ed3\u679c',
      preparationIsNotCompletion: [
        '\u6253\u5f00\u6216\u805a\u7126\u5fae\u4fe1',
        '\u641c\u7d22\u8054\u7cfb\u4eba',
        '\u53ea\u8bfb\u5230\u8fdb\u7a0b\u6216\u7a97\u53e3\u6807\u9898',
        '\u6ca1\u6709\u622a\u56fe/OCR/\u63a7\u4ef6\u5feb\u7167\u7684\u7a97\u53e3\u89c2\u5bdf',
      ],
      requiredEvidence: [
        'wechat_read_recent_chat result with read=true',
        '\u6216\u76ee\u6807\u804a\u5929\u7a97\u53e3\u7684\u622a\u56fe/OCR/\u63a7\u4ef6\u5feb\u7167\u8bc1\u636e',
      ],
      preferredTools: ['wechat_read_recent_chat', 'desktop_open', 'desktop_active_window', 'desktop_ui_snapshot', 'desktop_capture_screen', 'ocr_screen'],
      verificationTools: ['wechat_read_recent_chat', 'desktop_active_window', 'desktop_ui_snapshot', 'desktop_capture_screen', 'ocr_screen'],
      nextStep: '\u5148\u590d\u7528\u5df2\u8fd0\u884c\u7684\u6d88\u606f\u5e94\u7528\u7a97\u53e3\uff0c\u5b9a\u4f4d\u76ee\u6807\u4f1a\u8bdd\uff0c\u518d\u7528\u622a\u56fe/OCR/\u63a7\u4ef6\u5feb\u7167\u8bfb\u53d6\u53ef\u89c1\u804a\u5929\u5185\u5bb9\u3002',
      caution: '\u4e0d\u80fd\u628a\u6253\u5f00\u5fae\u4fe1\u6216\u641c\u7d22\u8054\u7cfb\u4eba\u8bf4\u6210\u5df2\u8bfb\u5230\u804a\u5929\u5185\u5bb9\u3002',
    });
  }

  if (
    (
      directedMessageSend ||
      (
        matches(text, /wechat|weixin|\u5fae\u4fe1|\u6d88\u606f|\u8054\u7cfb\u4eba|\u7fa4|message|messaging\s+app|chat\s+app/i) &&
        matches(text, /\u53d1\u9001|\u53d1\u7ed9|\u53d1\u4e00\u6761|\u53d1\u4e00\u4e0b|\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u53d1\u665a\u5b89|\bsend\b|\breply\b/i)
      )
    ) &&
    !negatedMessagingSend &&
    !matches(text, /\u8349\u7a3f|\u5148\u5199|\u4e0d\u8981\u53d1|\bdraft\b/i)
  ) {
    return withDefaults({
      kind: 'messaging_send',
      label: '\u524d\u53f0\u6d88\u606f\u53d1\u9001',
      coreAction: '\u5728\u771f\u5b9e\u804a\u5929\u7a97\u53e3\u5b9a\u4f4d\u6536\u4ef6\u4eba\uff0c\u805a\u7126\u8f93\u5165\u6846\uff0c\u7c98\u8d34\u6d88\u606f\u5e76\u6267\u884c\u53d1\u9001',
      preparationIsNotCompletion: [
        '\u6253\u5f00\u6216\u805a\u7126\u5fae\u4fe1',
        '\u641c\u7d22\u8054\u7cfb\u4eba',
        '\u622a\u56fe/OCR',
        '\u628a\u6587\u672c\u653e\u5230\u526a\u8d34\u677f',
      ],
      requiredEvidence: [
        'wechat_send_message result with sent=true',
        '\u6216\u8005\u6709\u7c98\u8d34\u6d88\u606f\u3001\u6309\u53d1\u9001\u3001\u53d1\u9001\u540e\u7a97\u53e3\u4ecd\u4e3a\u5fae\u4fe1\u7684\u5de5\u5177\u8bc1\u636e',
      ],
      preferredTools: ['wechat_send_message', 'desktop_open', 'desktop_active_window', 'desktop_mouse_click_at', 'desktop_cursor_glow_show', 'desktop_keyboard_press'],
      verificationTools: ['wechat_send_message', 'desktop_active_window', 'desktop_capture_screen'],
      nextStep: '\u76f4\u63a5\u8d70\u524d\u53f0\u53d1\u9001\u94fe\u8def\uff0c\u4ee5 sent=true \u6216\u53ef\u89c1\u53d1\u9001\u8bc1\u636e\u4f5c\u4e3a\u5b8c\u6210\u6761\u4ef6\u3002',
      caution: '\u4e0d\u80fd\u628a\u6253\u5f00\u5e94\u7528\u3001\u641c\u7d22\u8054\u7cfb\u4eba\u6216\u526a\u8d34\u677f\u8349\u7a3f\u8bf4\u6210\u5df2\u53d1\u9001\u3002',
    });
  }

  const hasPublicPlatformSurface = matches(text, /(?:\u89c6\u9891\u7f51\u7ad9|\u521b\u4f5c\u8005\u5e73\u53f0|\u793e\u4ea4\u5e73\u53f0|\u5546\u5bb6\u540e\u53f0|\u5e97\u94fa\u540e\u53f0|\u7f51\u7ad9|\u7f51\u9875|\u6296\u97f3|\u5feb\u624b|\u5c0f\u7ea2\u4e66|\u6296\u5e97|\u6dd8\u5b9d|\u5929\u732b|\u4eac\u4e1c|\u62fc\u591a\u591a|video\s*site|creator\s*platform|social\s*(?:site|platform)|seller\s*(?:center|platform)|marketplace|website|web\s*page)/iu);
  const hasPublicCommitIntent = matches(text, /(?:\u8bc4\u8bba|\u53d1\u5e03|\u70b9\u8d5e|\u6295\u7a3f|\u4e0a\u67b6|\u516c\u5f00\u56de\u590d|comment|post|publish|like|submit|list(?:ing)?)/iu);
  const asksForDraftOnly = matches(text, /(?:\u8349\u7a3f|\u6587\u6848|\u63d0\u793a\u8bcd|\u4e0d\u8981\u53d1\u5e03|\u6682\u4e0d\u53d1\u5e03|draft|copy\s*only|do\s+not\s+(?:post|publish|submit))/iu);
  if (hasPublicPlatformSurface && hasPublicCommitIntent && !asksForDraftOnly) {
    return withDefaults({
      kind: 'public_post',
      label: '\u516c\u5f00\u7f51\u7ad9\u53d1\u5e03/\u8bc4\u8bba',
      coreAction: '\u6253\u5f00\u76ee\u6807\u9875\uff0c\u786e\u8ba4\u8d26\u53f7\u548c\u8f93\u5165\u6846\uff0c\u8f93\u5165\u5185\u5bb9\uff0c\u5728\u53d7\u63a7\u8fb9\u754c\u5185\u53d1\u5e03',
      preparationIsNotCompletion: ['\u6253\u5f00\u7f51\u9875', '\u627e\u5230\u8bc4\u8bba\u6846', '\u5199\u597d\u8349\u7a3f', '\u68c0\u67e5\u767b\u5f55\u72b6\u6001'],
      requiredEvidence: ['browser or desktop evidence that the comment/post was submitted', '\u53d1\u5e03\u540e\u7684\u9875\u9762\u53cd\u9988\u6216\u65b0\u8bc4\u8bba\u53ef\u89c1'],
      preferredTools: ['mcp_playwright_browser_snapshot', 'browser_open_task', 'desktop_active_window', 'desktop_ui_snapshot', 'computer_use'],
      verificationTools: ['mcp_playwright_browser_snapshot', 'desktop_capture_screen'],
      nextStep: '\u5148\u786e\u8ba4\u7f51\u7ad9\u3001\u8d26\u53f7\u3001\u8bc4\u8bba\u5185\u5bb9\u548c\u53d1\u5e03\u8fb9\u754c\uff0c\u518d\u6267\u884c\u5e76\u9a8c\u8bc1\u9875\u9762\u53cd\u9988\u3002',
      caution: '\u767b\u5f55\u3001\u9a8c\u8bc1\u7801\u30012FA\u3001\u4ed8\u8d39\u3001\u8fdd\u89c4\u6216\u9ad8\u98ce\u9669\u516c\u5f00\u53d1\u5e03\u5fc5\u987b\u505c\u4e0b\u786e\u8ba4\u3002',
    });
  }

  if (
    matches(text, /\u767b\u5f55|\u6d4f\u89c8\u5668|\u6253\u5f00\u7f51\u7ad9|\u81ea\u52a8\u767b\u5f55|browser|login|log\s*in|website|site/i) &&
    !matches(text, /\bCAD\b|\bDXF\b|\bDWG\b|AutoCAD|\u753b\u56fe|\u753b\u56fe\u7eb8|\u56fe\u7eb8|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe|\u88c5\u4fee|cad/i)
  ) {
    return withDefaults({
      kind: 'browser_account',
      label: '\u6d4f\u89c8\u5668/\u8d26\u53f7\u64cd\u4f5c',
      coreAction: '\u6253\u5f00\u76ee\u6807\u7ad9\u70b9\uff0c\u68c0\u67e5\u5f53\u524d\u4f1a\u8bdd\uff0c\u4f7f\u7528\u53ef\u63a7\u6d4f\u89c8\u5668\u6216\u684c\u9762\u8fdb\u884c\u767b\u5f55\u540e\u64cd\u4f5c',
      preparationIsNotCompletion: ['\u6253\u5f00\u6d4f\u89c8\u5668', '\u6253\u5f00\u767b\u5f55\u9875', '\u770b\u5230\u7f51\u7ad9\u9996\u9875'],
      requiredEvidence: ['logged-in page/session evidence', '\u76ee\u6807\u9875\u9762\u72b6\u6001\u6216\u8d26\u53f7\u72b6\u6001\u9a8c\u8bc1', '\u82e5\u8bf7\u6c42\u5305\u542b\u68c0\u7d22/\u67e5\u627e\uff1b\u8fd8\u9700\u8981\u76ee\u6807\u68c0\u7d22\u7ed3\u679c\u6216\u660e\u786e\u7684\u672a\u767b\u5f55/\u9a8c\u8bc1\u963b\u585e\u8bc1\u636e'],
      preferredTools: ['web_login_profile_list', 'web_login_profile_save_from_preset', 'web_login_run', 'url_fetch_logged_in', 'mcp_playwright_browser_snapshot', 'mcp_playwright_browser_navigate', 'mcp_playwright_browser_click', 'browser_open_task', 'desktop_active_window', 'desktop_capture_screen'],
      verificationTools: ['web_login_profile_list', 'web_login_run', 'url_fetch_logged_in', 'mcp_playwright_browser_snapshot', 'desktop_capture_screen'],
      nextStep: '\u5148\u68c0\u67e5\u5df2\u4fdd\u5b58\u7684\u767b\u5f55 profile/\u4f1a\u8bdd\uff1b\u5df2\u77e5\u7ad9\u70b9\u53ef\u5148\u521b\u5efa\u5bf9\u5e94 preset profile \u5e76\u8fd0\u884c web_login_run\uff1b\u9047\u5230\u5bc6\u7801\u3001\u626b\u7801\u3001\u9a8c\u8bc1\u7801\u30012FA \u6216\u672a\u4fdd\u5b58\u51ed\u636e\u5c31\u505c\u4e0b\u8bf4\u660e\u3002',
      caution: '\u4e0d\u80fd\u628a\u6253\u5f00\u7f51\u9875\u8bf4\u6210\u5df2\u767b\u5f55\u6216\u5df2\u5b8c\u6210\u8d26\u53f7\u64cd\u4f5c\u3002',
    });
  }

  if (isDesignDeliveryTurn(text)) {
    return buildDesignDeliveryContract();
  }

  if (isEcommerceOperationsTurn(text)) {
    return buildEcommerceOperationsContract();
  }

  if (isCustomerOperationsTurn(text)) {
    return buildCustomerOperationsContract();
  }

  if (
    !appInventoryInspection &&
    matches(text, /\bCAD\b|\bDXF\b|\bDWG\b|AutoCAD|\u753b\u56fe|\u753b\u56fe\u7eb8|\u56fe\u7eb8|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe|\u88c5\u4fee|cad/i)
  ) {
    const visibleAutoCad = requiresVisibleAutoCadExecution(text) || requiresAutoCadMcpPlayback(text);
    return withDefaults({
      kind: 'cad_drafting',
      label: 'CAD/\u56fe\u7eb8\u4f5c\u6218',
      coreAction: '\u751f\u6210\u6216\u64cd\u4f5c CAD \u56fe\u7eb8\uff0c\u786e\u8ba4\u6587\u4ef6\u4ea7\u7269\u6216\u53ef\u89c1\u8f6f\u4ef6\u7ed8\u5236\u7ed3\u679c',
      preparationIsNotCompletion: ['\u8ba1\u7b97\u65b9\u6848', '\u5199\u51fa\u811a\u672c', '\u6253\u5f00 CAD \u8f6f\u4ef6', '\u67e5\u770b\u6587\u4ef6\u5939', '\u53ea\u751f\u6210 DXF/\u65b9\u6848\u5305'],
      requiredEvidence: visibleAutoCad
        ? ['source geometry receipt with geometryVerified=true', 'created operations JSON with a verified operationSetId', 'mcp_cad-drafting_autocad_playback_file completion marker with exact operationCount, expectedEntityCount, and entitiesAdded equality']
        : ['created CAD/DXF file path with nonzero size and successful file verification'],
      preferredTools: visibleAutoCad
        ? ['desktop_list_apps', 'floorplan_extract_geometry', 'cad_prepare_autocad_operations', 'mcp_cad-drafting_autocad_playback_file', 'desktop_path_info', 'desktop_capture_screen']
        : ['floorplan_extract_geometry', 'cad_generate_dxf', 'desktop_path_info', 'work_product_verify'],
      verificationTools: ['desktop_path_info', 'work_product_verify', 'desktop_capture_screen', 'desktop_active_window'],
      nextStep: visibleAutoCad
        ? 'Run staged source extraction, require geometryReady=true, and pass only its server-owned receipt to CAD preparation. Then run AutoCAD MCP/COM playback and require both marker and entity-delta verification. If any stage fails, stop and report the exact blocker.'
        : 'Extract structured geometry, create the requested CAD file, and verify the file exists and is non-empty.',
      caution: 'A DXF/DWG file, operations JSON, opened AutoCAD window, desktop screenshot, or any script is not evidence that visible AutoCAD drawing completed.',
    });
  }

  if (matches(text, /\u80a1\u7968|\u76ef\u76d8|\u884c\u60c5|\u62a5\u4ef7|\u5927\u76d8|\u6da8\u8dcc|\bk\u7ebf\b|stock|quote|market|ticker/i)) {
    return withDefaults({
      kind: 'stock_monitor',
      label: '\u80a1\u7968/\u76ef\u76d8',
      coreAction: '\u83b7\u53d6\u5b9e\u65f6\u6216\u8fd1\u671f\u884c\u60c5\uff0c\u8bbe\u5b9a\u76ef\u76d8\u76ee\u6807\u548c\u63d0\u9192\u8fb9\u754c',
      preparationIsNotCompletion: ['\u8bc6\u522b\u80a1\u7968\u540d\u79f0', '\u751f\u6210\u89c2\u5bdf\u6e05\u5355', '\u53ea\u56de\u7b54\u5e38\u8bc6'],
      requiredEvidence: ['fresh quote/kline/market data timestamp', '\u6216\u5df2\u521b\u5efa\u7684\u76ef\u76d8\u4efb\u52a1/\u63d0\u9192\u8bb0\u5f55'],
      preferredTools: [
        'mcp_stockbot_stock_quote',
        'mcp_stockbot_stock_kline',
        'mcp_stockbot_market_index',
        'mcp_stockbot_stock_news',
        'mcp_stockbot_paper_portfolio',
        'autonomy_register_workflow',
      ],
      verificationTools: [
        'mcp_stockbot_stock_quote',
        'mcp_stockbot_stock_kline',
        'mcp_stockbot_market_index',
        'mcp_stockbot_paper_portfolio',
        'autonomy_list_workflows',
      ],
      nextStep: '\u5148\u786e\u8ba4\u6807\u7684\u3001\u5468\u671f\u548c\u89e6\u53d1\u6761\u4ef6\uff0c\u518d\u8bfb\u53d6\u5e26\u65f6\u95f4\u6233\u7684\u884c\u60c5\u6216\u521b\u5efa\u76ef\u76d8\u4efb\u52a1\u3002',
      caution: '\u4e0d\u80fd\u628a\u4e00\u6b21\u6027\u884c\u60c5\u56de\u7b54\u8bf4\u6210\u6b63\u5728\u6301\u7eed\u76ef\u76d8\u3002',
    });
  }

  if (isLegalEntryTurn(text) || matches(text, /\u5f8b\u5e08|\u4ee3\u7406\u8bcd|\u8d77\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u5408\u540c|\u534f\u8bae|\u8d22\u4ea7\u7ebf\u7d22|\u88ab\u6267\u884c\u4eba|\u80a1\u6743\u7a7f\u900f|\u8d22\u4ea7\u4fdd\u5168|\u5b9e\u9645\u63a7\u5236\u4eba|\u5931\u4fe1|\u9650\u5236\u6d88\u8d39|\u6cd5\u5f8b\u4f1a\u8bae|\u5f8b\u5e08\u4f1a\u8bae|\u529e\u6848\u4f1a\u8bae|\u6848\u4ef6\u4f1a\u8bae|\u4f1a\u8bae\u7eaa\u8981.*\u6848\u4ef6|\u6c9f\u901a\u8bb0\u5f55.*\u6848\u4ef6|\u4e09\u6bb5\u8bba|\u5927\u524d\u63d0|\u5c0f\u524d\u63d0|\u6db5\u6444|legal|lawyer|pleading|contract|agreement|asset|enforcement|equity|shareholder/i)) {
    return buildLegalDocumentContract();
  }

  if (matches(text, /\u6587\u4ef6|\u6587\u6863|PPT|PDF|docx|xlsx|pptx|\u751f\u6210|\u5bfc\u51fa|\u4fdd\u5b58|create|generate|export|save/i)) {
    return withDefaults({
      kind: 'artifact_work',
      label: '\u6587\u4ef6/\u4ea7\u7269\u4ea4\u4ed8',
      coreAction: '\u751f\u6210\u3001\u8bfb\u53d6\u6216\u4fee\u6539\u5b9e\u9645\u6587\u4ef6\u4ea7\u7269',
      preparationIsNotCompletion: ['\u5199\u51fa\u5927\u7eb2', '\u53ea\u6709\u6587\u672c\u8bf4\u660e', '\u53ea\u5217\u51fa\u6587\u4ef6\u5939'],
      requiredEvidence: ['file path exists with expected content/nonzero size', '\u6216\u5de5\u4f5c\u4ea7\u7269\u9a8c\u6536\u901a\u8fc7'],
      preferredTools: ['write_file', 'create_docx', 'create_ppt', 'create_pdf', 'desktop_path_info', 'work_product_verify'],
      verificationTools: ['desktop_path_info', 'work_product_verify'],
      nextStep: '\u6267\u884c\u6587\u4ef6\u751f\u6210/\u8bfb\u53d6\u5de5\u5177\u5e76\u9a8c\u8bc1\u4ea7\u7269\u3002',
      caution: '\u4e0d\u80fd\u628a\u804a\u5929\u6587\u672c\u6216\u8ba1\u5212\u8bf4\u6210\u5df2\u5199\u5165\u6587\u4ef6\u3002',
    });
  }

  if (appInventoryInspection || matches(text, /\u684c\u9762|\u6253\u5f00|\u805a\u7126|\u70b9\u51fb|\u8f93\u5165|\u5e94\u7528|\u8f6f\u4ef6|desktop|open|click|type|app|application/i)) {
    return withDefaults({
      kind: 'desktop_operation',
      label: '\u684c\u9762/\u672c\u673a\u8f6f\u4ef6\u64cd\u4f5c',
      coreAction: '\u5728\u771f\u5b9e\u684c\u9762\u6216\u672c\u673a\u8f6f\u4ef6\u4e0a\u5b8c\u6210\u53ef\u89c1\u64cd\u4f5c',
      preparationIsNotCompletion: ['\u67e5\u8fdb\u7a0b', '\u5217\u5e94\u7528', '\u6253\u5f00\u5feb\u6377\u65b9\u5f0f', '\u53ea\u6267\u884c\u547d\u4ee4\u884c'],
      requiredEvidence: ['active window/process/screen state proves the requested result', '\u6216\u5de5\u5177\u8fd4\u56de\u7684\u64cd\u4f5c\u9a8c\u8bc1'],
      preferredTools: ['desktop_list_apps', 'desktop_open', 'desktop_active_window', 'desktop_ui_snapshot', 'desktop_capture_screen', 'computer_use'],
      verificationTools: ['desktop_active_window', 'desktop_ui_snapshot', 'desktop_capture_screen', 'desktop_running_processes'],
      nextStep: '\u5148\u805a\u7126\u5df2\u8fd0\u884c\u7684\u7a97\u53e3\uff0c\u6267\u884c\u6838\u5fc3\u64cd\u4f5c\uff0c\u518d\u7528\u7a97\u53e3/\u5c4f\u5e55\u8bc1\u636e\u9a8c\u8bc1\u3002',
      caution: '\u4e0d\u80fd\u628a\u8fdb\u7a0b\u5b58\u5728\u6216\u5e94\u7528\u6253\u5f00\u8bf4\u6210\u4e1a\u52a1\u52a8\u4f5c\u5df2\u5b8c\u6210\u3002',
    });
  }

  return NONE_CONTRACT;
}

function expandSuccessfulRecords(records: ToolExecutionRecord[]): ToolExecutionRecord[] {
  const expanded: ToolExecutionRecord[] = [];
  for (const record of records) {
    if (record.error || !String(record.result || '').trim()) continue;
    expanded.push(record);
    if (record.name !== 'work_takeover_task_run_suggested_tool') continue;
    const payload = parseRecordJson(record);
    const run = payload?.run;
    if (!run || run.status !== 'completed' || !run.toolName || !String(run.result || '').trim()) continue;
    expanded.push({
      id: run.id,
      name: String(run.toolName),
      arguments: run.toolArgs && typeof run.toolArgs === 'object' ? run.toolArgs : {},
      result: String(run.result),
    });
  }
  return expanded;
}

function recordText(record: ToolExecutionRecord): string {
  return `${record.name}\n${JSON.stringify(record.arguments || {})}\n${String(record.result || '')}`;
}

function hasMeaningfulArguments(record: ToolExecutionRecord): boolean {
  return Object.values(record.arguments || {}).some(value => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return String(value ?? '').trim().length > 0;
  });
}

function isPreparationOnlyTool(name: string): boolean {
  return /^(?:work_product_plan|work_takeover_task_(?:create|from_wechat|from_clipboard|list|get|update|continue|orchestrate|execute_step|advance|autorun|export_packet)|work_takeover_capability_reuse_probe|mcp_cad-drafting_cad_renovation_folder_workflow|desktop_(?:open|list_apps|list_files|active_window|capture_screen|ui_snapshot)|browser_open_task|write_clipboard)$/i.test(name);
}

function hasArtifactVerification(records: ToolExecutionRecord[]): boolean {
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

function hasCreatedArtifact(records: ToolExecutionRecord[], namePattern: RegExp): boolean {
  return records.some(record => {
    if (!namePattern.test(record.name) || isPreparationOnlyTool(record.name)) return false;
    const result = String(record.result || '');
    return /(?:[A-Za-z]:\\|\/[^\s"']+|\bpath\b|\bfile\b|\bsaved\b|\bcreated\b|\boutput\b|\burl\b)/i.test(result)
      && !/(?:prompt\s*only|draft\s*only|not\s+(?:created|generated)|missing|failed|blocked)/i.test(result);
  });
}

function hasActualMediaEvidence(records: ToolExecutionRecord[], kind: 'image' | 'video' | 'either'): boolean {
  const namePattern = kind === 'image'
    ? /^(?:generate_image(?:_dalle)?|edit_image|mcp_.+_(?:generate|edit)_image)$/i
    : kind === 'video'
      ? /^(?:generate_video|mcp_.+_(?:generate|create)_video)$/i
      : /^(?:generate_image(?:_dalle)?|edit_image|generate_video|mcp_.+_(?:generate|edit|create)_(?:image|video))$/i;
  return records.some(record => {
    if (!namePattern.test(record.name)) return false;
    const result = String(record.result || '');
    return /(?:image_url|video_url|output_url|download_url|savedPath|outputPath|"path"\s*:|https?:\/\/)/i.test(result)
      && !/(?:prompt\s*only|not\s+generated|failed|blocked)/i.test(result);
  });
}

function hasPublicPostEvidence(records: ToolExecutionRecord[]): boolean {
  const explicitReceipt = records.some(record =>
    /(?:publish|post|comment|submit|listing)/i.test(record.name)
      && /"(?:published|posted|submitted|commented|success)"\s*:\s*true|"status"\s*:\s*"(?:published|posted|submitted|success|completed)"/i.test(record.result)
  );
  if (explicitReceipt) return true;

  const commitIndex = records.findIndex(record => {
    if (!/(?:playwright_browser_click|desktop_ui_(?:click|invoke)|computer_use|mouse_click)/i.test(record.name)) return false;
    return /(?:\u53d1\u5e03|\u8bc4\u8bba|\u6295\u7a3f|\u4e0a\u67b6|\u63d0\u4ea4|publish|post|comment|submit|list(?:ing)?)/iu.test(recordText(record));
  });
  if (commitIndex < 0) return false;
  return records.slice(commitIndex + 1).some(record =>
    /(?:snapshot|evaluate|ui_snapshot|ocr|capture_screen)/i.test(record.name)
      && /(?:\u53d1\u5e03\u6210\u529f|\u8bc4\u8bba\u6210\u529f|\u63d0\u4ea4\u6210\u529f|\u5df2\u53d1\u5e03|\u5df2\u4e0a\u67b6|published|posted|submitted|comment\s+(?:is\s+)?visible|success(?:fully)?)/iu.test(record.result)
  );
}

function hasCustomerOperationsEvidence(records: ToolExecutionRecord[], taskText: string): boolean {
  const wantsSend = /(?:\u53d1\u7ed9|\u53d1\u9001|\u76f4\u63a5\u56de\u590d|\u56de\u590d\u5ba2\u6237|\u8054\u7cfb\u5ba2\u6237|\u8ddf\u8fdb\u5ba2\u6237|\u56de\u8bbf\u5ba2\u6237|\u63a8\u8fdb\u8ddf\u8fdb|send|message|reply\s+to|contact\s+the\s+customer|follow\s+up\s+with|advance.{0,24}follow[-\s]?up)/iu.test(taskText)
    && !/(?:\u8349\u7a3f|\u8bdd\u672f|\u51c6\u5907|\u62df\u4e00\u4efd|draft|prepare|copy\s*only)/iu.test(taskText);
  const wantsDocument = /(?:\u62a5\u4ef7\u5355|\u62a5\u4ef7\u4e66|\u65b9\u6848\u4e66|\u5408\u540c|\u534f\u8bae|\u63d0\u6848|PPT|PDF|DOCX|quotation|proposal|agreement|contract)/iu.test(taskText);
  const wantsAnalysis = /(?:\u5206\u6790|\u8bc4\u5206|\u5206\u7c7b|\u5f02\u8bae|\u5065\u5eb7\u5ea6|\u5de5\u5355|analy|score|triage|objection|health\s+review)/iu.test(taskText);
  const takeoverOnly = /(?:\u63a5\u7ba1|\u5168\u6743\u5904\u7406|\u76f4\u63a5\u63a8\u8fdb|take\s*over|handle\s+everything)/iu.test(taskText)
    && !wantsSend && !wantsDocument && !wantsAnalysis;

  const sent = records.some(record => record.name === 'wechat_send_message' && /"sent"\s*:\s*true|sent:\s*true/i.test(record.result));
  const analyzed = records.some(record => /^mcp_sales-customer-ops_/i.test(record.name) && hasMeaningfulArguments(record) && String(record.result).trim().length > 20);
  const documentProduced = hasCreatedArtifact(records, /^(?:create_docx|create_pdf|create_ppt|write_file)$/i) && hasArtifactVerification(records);

  if (wantsSend && !sent) return false;
  if (wantsDocument && !documentProduced) return false;
  if (wantsAnalysis && !analyzed) return false;
  if (takeoverOnly) return sent || documentProduced;
  return sent || analyzed || documentProduced;
}

function hasAuthenticatedPlatformOutcome(records: ToolExecutionRecord[]): boolean {
  return records.some(record =>
    /(?:playwright_browser_snapshot|playwright_browser_evaluate|url_fetch_logged_in|computer_use)/i.test(record.name)
      && /(?:\u64cd\u4f5c\u6210\u529f|\u4fee\u6539\u6210\u529f|\u5df2\u66f4\u65b0|\u5df2\u4fdd\u5b58|\u751f\u6548|operation\s+(?:succeeded|completed)|updated|saved|applied)/iu.test(record.result)
      && !/(?:login|required|captcha|manual_required|blocked|failed)/i.test(record.result)
  );
}

function hasEcommerceOperationsEvidence(records: ToolExecutionRecord[], taskText: string): boolean {
  const wantsAnalysis = /(?:\u5206\u6790|\u4f53\u68c0|\u5229\u6da6|\u6838\u7b97|\u5bf9\u8d26|\u8865\u8d27|\u5e93\u5b58|ROI|ROAS|\u98ce\u9669|\u6807\u9898\u4f18\u5316|analy|audit|profit|reconcile|restock|inventory|risk|listing\s+optim)/iu.test(taskText);
  const wantsImage = /(?:\u751f\u6210|\u5236\u4f5c|\u51fa).{0,16}(?:\u56fe\u7247|\u4e3b\u56fe|\u6d77\u62a5|\u56fe\u6587)|(?:generate|create).{0,16}(?:image|poster|creative)/iu.test(taskText);
  const wantsVideo = /(?:\u751f\u6210|\u5236\u4f5c|\u51fa).{0,16}(?:\u89c6\u9891|\u6210\u7247)|(?:generate|create|produce).{0,16}(?:video|clip)/iu.test(taskText);
  const wantsCopyOrScript = /(?:\u6587\u6848|\u811a\u672c|\u8be6\u60c5\u9875|\u6807\u9898|\u5356\u70b9|\u53d1\u5e03\u8349\u7a3f|copy|script|listing|caption|draft)/iu.test(taskText);
  const wantsPlatformChange = /(?:\u6539\u4ef7|\u6539\u5e93\u5b58|\u4e0a\u67b6|\u4e0b\u67b6|\u5f00\u59cb\u6295\u653e|\u8c03\u6574\u6295\u653e|\u4fee\u6539\u5e97\u94fa|change\s+price|update\s+inventory|list\s+the\s+product|start\s+campaign|change\s+the\s+store)/iu.test(taskText);
  const takeoverOnly = /(?:\u63a5\u7ba1|\u5168\u6258|take\s*over|fully\s+manage)/iu.test(taskText)
    && !wantsAnalysis && !wantsImage && !wantsVideo && !wantsCopyOrScript && !wantsPlatformChange;

  const analyzed = records.some(record => /^mcp_ecommerce-ops_/i.test(record.name) && hasMeaningfulArguments(record) && String(record.result).trim().length > 20);
  const copyProduced = records.some(record => /^(?:mcp_content-ops_|mcp_ecommerce-ops_product_listing_optimizer)/i.test(record.name) && hasMeaningfulArguments(record) && String(record.result).trim().length > 20)
    || hasCreatedArtifact(records, /^(?:create_docx|create_pdf|create_xlsx|write_file)$/i) && hasArtifactVerification(records);
  const platformChanged = hasAuthenticatedPlatformOutcome(records);

  if (wantsAnalysis && !analyzed) return false;
  if (wantsImage && !hasActualMediaEvidence(records, 'image')) return false;
  if (wantsVideo && !hasActualMediaEvidence(records, 'video')) return false;
  if (wantsCopyOrScript && !copyProduced) return false;
  if (wantsPlatformChange && !platformChanged) return false;
  if (takeoverOnly) return platformChanged;
  return analyzed || copyProduced || hasActualMediaEvidence(records, 'either') || platformChanged;
}

function hasSourceInspectionEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => /^(?:read_file|read_files_batch|read_pdf|read_docx|extract_document_text|ocr_image_file|floorplan_extract_geometry)$/i.test(record.name));
}

function requiresSourceGrounding(taskText: string): boolean {
  return /(?:\u6839\u636e|\u6309\u7167|\u91cc\u9762|\u6587\u4ef6\u5939|\u9644\u4ef6|\u56fe\u7247|\u539f\u56fe|\u73b0\u573a\u5c3a\u5bf8|provided|attached|source\s+(?:file|folder|drawing)|based\s+on)/iu.test(taskText);
}

function hasGroundedCadGeometryEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => {
    if (record.name === 'floorplan_extract_geometry') {
      const payload = parseRecordJson(record);
      const geometry = payload?.cadGenerateDxfArgs && typeof payload.cadGenerateDxfArgs === 'object'
        ? payload.cadGenerateDxfArgs
        : payload;
      const width = Number(geometry?.width ?? payload?.geometryReview?.width);
      const height = Number(geometry?.height ?? payload?.geometryReview?.height);
      const geometryCount = [geometry?.walls, geometry?.rooms, geometry?.doors, geometry?.windows]
        .reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0)
        + Number(payload?.geometryReview?.counts?.outerBoundary || 0)
        + Number(payload?.geometryReview?.counts?.walls || 0)
        + Number(payload?.geometryReview?.counts?.rooms || 0)
        + Number(payload?.geometryReview?.counts?.doors || 0)
        + Number(payload?.geometryReview?.counts?.windows || 0);
      return payload?.geometryReady === true
        && payload?.geometryVerified === true
        && Boolean(String(payload?.geometryReceiptPath || '').trim())
        && width > 0 && height > 0 && geometryCount > 0
        && !/No configured vision model|not available|failed|blocked/i.test(String(record.result || ''));
    }
    if (!/^(?:cad_generate_dxf|cad_prepare_autocad_operations)$/i.test(record.name)) return false;
    const args = record.arguments || {};
    const payload = parseRecordJson(record);
    const geometryCount = [args.walls, args.polylines, args.rooms, args.doors, args.windows]
      .reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0)
      + (Array.isArray(args.outerBoundary) ? args.outerBoundary.length : 0)
      + Number(payload?.outerBoundaryPointCount || 0)
      + Number(payload?.operationCount || 0);
    return Boolean(String(args.sourcePath || payload?.sourcePath || payload?.geometryReceiptPath || '').trim())
      && geometryCount > 0
      && payload?.geometryVerified === true
      && payload?.geometryValidation?.passed === true
      && Boolean(String(payload?.geometryReceiptPath || '').trim());
  });
}

function hasDesignDeliveryEvidence(records: ToolExecutionRecord[], taskText: string): boolean {
  const sourceRequired = requiresSourceGrounding(taskText);
  const wantsCompositePackage = /(?:\u5168\u5957\u8bbe\u8ba1|\u5168\u6848\u8bbe\u8ba1|\u5b8c\u6574\u4ea4\u4ed8\u5305|\u8bbe\u8ba1\u4ea4\u4ed8|\u88c5\u4fee\u4ea4\u4ed8|full\s+(?:design|renovation|interior)|design\s+(?:delivery|package|handoff))/iu.test(taskText);
  const wantsCad = /(?:\bCAD\b|\bDXF\b|\bDWG\b|AutoCAD|\u65bd\u5de5\u56fe|\u5e73\u9762\u56fe)/iu.test(taskText);
  const wantsBim = /(?:Revit|\bBIM\b|\bIFC\b|Dynamo)/iu.test(taskText);
  const wantsPresentation = /(?:PPT|\u6c47\u62a5|\u65b9\u6848\u4e66|presentation|proposal)/iu.test(taskText);
  const wantsVisual = /(?:\u6548\u679c\u56fe|\u6e32\u67d3|\u6d77\u62a5|logo|\u54c1\u724c\u89c6\u89c9|render|visual)/iu.test(taskText);
  const wantsSchedule = /(?:\u9884\u7b97|\u6e05\u5355|\u6750\u6599\u8868|BOQ|bill\s+of\s+quantit)/iu.test(taskText);

  if (sourceRequired && !hasSourceInspectionEvidence(records)) return false;
  if (sourceRequired && wantsCad && !hasGroundedCadGeometryEvidence(records)) return false;

  if (wantsCad) {
    if (requiresVisibleAutoCadExecution(taskText) || requiresAutoCadMcpPlayback(taskText)) {
      if (!hasVisibleAutoCadExecutionEvidence(records, taskText)) return false;
    } else {
      const cadCreated = hasCreatedArtifact(records, /^(?:cad_generate_dxf|mcp_cad-drafting_.+)$/i);
      if (!cadCreated || !hasArtifactVerification(records)) return false;
    }
  }

  if (wantsBim) {
    const realBim = records.some(record => {
      if (!/(?:revit|bim|ifc)/i.test(record.name) || /(?:prepare|package|handoff|dynamo)/i.test(record.name)) return false;
      return /"status"\s*:\s*"(?:completed|success)"|"(?:modelPath|ifcPath|outputPath|path)"\s*:/i.test(record.result);
    });
    if (!realBim) return false;
  }

  if (wantsPresentation) {
    if (!hasCreatedArtifact(records, /^(?:create_ppt|create_docx|create_pdf)$/i) || !hasArtifactVerification(records)) return false;
  }
  if (wantsVisual && !hasActualMediaEvidence(records, 'image')) return false;
  if (wantsSchedule) {
    if (!hasCreatedArtifact(records, /^(?:create_xlsx|create_docx|create_pdf|write_file)$/i) || !hasArtifactVerification(records)) return false;
  }

  const requestedSpecificOutput = wantsCad || wantsBim || wantsPresentation || wantsVisual || wantsSchedule;
  if (wantsCompositePackage && !requestedSpecificOutput) return false;
  if (!requestedSpecificOutput) return hasActualMediaEvidence(records, 'image') || hasCreatedArtifact(records, /^(?:create_ppt|create_pdf|create_docx)$/i) && hasArtifactVerification(records);
  return true;
}

export function hasCoreActionEvidence(
  contract: LumiActionContract,
  records: ToolExecutionRecord[] = [],
  taskText = '',
): boolean {
  if (!contract.applies) return true;
  const successful = expandSuccessfulRecords(records);
  if (successful.length === 0) return false;
  const toolNames = successful.map(record => record.name);
  if (contract.kind === 'messaging_read') {
    return successful.some(record =>
      record.name === 'wechat_read_recent_chat' && /"read"\s*:\s*true|read:\s*true/i.test(String(record.result || ''))
    ) || successful.some(record => /^(ocr_screen|desktop_capture_screen|desktop_ui_snapshot)$/i.test(record.name));
  }
  if (contract.kind === 'messaging_send') {
    return successful.some(record =>
      record.name === 'wechat_send_message' && /"sent"\s*:\s*true|sent:\s*true/i.test(String(record.result || ''))
    );
  }
  if (contract.kind === 'public_post') {
    return hasPublicPostEvidence(successful);
  }
  if (contract.kind === 'browser_account') {
    return hasAuthenticatedWebResultEvidence(successful, taskText);
  }
  if (contract.kind === 'cad_drafting') {
    if (requiresVisibleAutoCadExecution(taskText) || requiresAutoCadMcpPlayback(taskText)) {
      return hasVisibleAutoCadExecutionEvidence(successful, taskText);
    }
    if (requiresSourceGrounding(taskText) && (
      !hasSourceInspectionEvidence(successful)
      || !hasGroundedCadGeometryEvidence(successful)
    )) return false;
    return hasCreatedArtifact(successful, /^(?:cad_generate_dxf|mcp_cad-drafting_.+)$/i)
      && hasArtifactVerification(successful);
  }
  if (contract.kind === 'customer_operations') {
    return hasCustomerOperationsEvidence(successful, taskText);
  }
  if (contract.kind === 'ecommerce_operations') {
    return hasEcommerceOperationsEvidence(successful, taskText);
  }
  if (contract.kind === 'design_delivery') {
    return hasDesignDeliveryEvidence(successful, taskText);
  }
  if (contract.kind === 'stock_monitor') {
    return successful.some(record =>
      /stock_|market_index|reminder_|alert|watchlist|autonomy_(?:register|list|set)_workflow|work_takeover_task/i.test(record.name) ||
      /(?:alert|watchlist|reminder|scheduled|monitoring|workflow|price\s*alert|market\s*alert|\u9884\u8b66|\u63d0\u9192|\u76ef\u76d8\u4efb\u52a1|\u76d1\u63a7\u4efb\u52a1)/iu.test(String(record.result || ''))
    );
  }
  if (contract.kind === 'legal_document') {
    return successful.some(record => /legal_|read_|create_docx|write_file|desktop_path_info|work_product_verify/i.test(record.name));
  }
  if (contract.kind === 'artifact_work') {
    return successful.some(record => /write_file|create_|desktop_path_info|work_product_verify/i.test(record.name));
  }
  if (contract.kind === 'desktop_operation') {
    return toolNames.some(name => /desktop_|computer_use|client_action/i.test(name));
  }
  return successful.length > 0;
}

export function formatActionContractPrompt(contract: LumiActionContract): string {
  if (!contract.applies) return '';
  return [
    '## Lumi Action Contract',
    `Action type: ${contract.label}.`,
    `Core action: ${contract.coreAction}.`,
    contract.preparationIsNotCompletion.length
      ? `Preparation is not completion: ${contract.preparationIsNotCompletion.join('; ')}.`
      : '',
    contract.requiredEvidence.length
      ? `Required completion evidence: ${contract.requiredEvidence.join('; ')}.`
      : '',
    contract.preferredTools.length ? `Preferred tools: ${contract.preferredTools.join(', ')}.` : '',
    contract.verificationTools.length ? `Verification tools: ${contract.verificationTools.join(', ')}.` : '',
    contract.caution ? `Caution: ${contract.caution}` : '',
    contract.nextStep ? `If blocked: ${contract.nextStep}` : '',
  ].filter(Boolean).join('\n');
}

export function summarizeActionContractBlocker(contract: LumiActionContract, failure = ''): string {
  if (!contract.applies) return failure || '';
  return [
    `\u4efb\u52a1\u7c7b\u578b\uff1a${contract.label}\u3002`,
    failure ? `\u5361\u4f4f\u7684\u4f4d\u7f6e\uff1a${failure}\u3002` : '\u539f\u56e0\uff1a\u8fd8\u6ca1\u6709\u62ff\u5230\u6838\u5fc3\u52a8\u4f5c\u7684\u9a8c\u8bc1\u8bc1\u636e\u3002',
    contract.requiredEvidence.length ? `\u8fd8\u7f3a\u7684\u8bc1\u636e\uff1a${contract.requiredEvidence.join('\uff1b')}\u3002` : '',
    contract.nextStep ? `\u4e0b\u4e00\u6b65\uff1a${contract.nextStep}` : '',
  ].filter(Boolean).join('\n');
}
