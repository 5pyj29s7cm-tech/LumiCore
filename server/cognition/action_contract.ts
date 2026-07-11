import type { ToolExecutionRecord } from '../tools/types';
import { LEGAL_ENTRY_PREFERRED_TOOLS, isLegalEntryTurn, isRemoteLegalMessageTurn } from './legal_entry';

export type LumiActionContractKind =
  | 'none'
  | 'messaging_read'
  | 'messaging_send'
  | 'browser_account'
  | 'public_post'
  | 'cad_drafting'
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

export function requiresVisibleAutoCadExecution(input: string): boolean {
  const text = compact(input);
  if (!text) return false;
  const mentionsCadSurface =
    /(?:\bAutoCAD\b|\bacad(?:\.exe)?\b|(?:CAD|cad)\s*(?:\u8f6f\u4ef6|\u7a97\u53e3|\u754c\u9762|\u91cc|\u4e2d|app)|(?:\u5728|\u7528).{0,16}(?:AutoCAD|CAD|cad))/iu.test(text);
  const wantsVisibleDrawing =
    /(?:\u5b9e\u9645|\u771f\u6b63|\u53ef\u89c1|\u5b9e\u64cd|\u64cd\u4f5c|\u6253\u5f00|\u542f\u52a8|\u8fdb\u5165).{0,32}(?:\u753b|\u7ed8\u5236|\u6267\u884c|\u8dd1)|(?:\u753b\u51fa\u6765|\u7ed8\u5236\u51fa\u6765|\u4e00\u7b14\u4e00\u7b14|\u53ef\u89c1\u7ed8\u56fe|\u5b9e\u64cd\u753b\u56fe)/u.test(text)
    || /\b(?:actually|visible|visibly|real|run|execute|open|launch|stroke[-\s]?by[-\s]?stroke|step[-\s]?by[-\s]?step).{0,32}(?:draw|drawing|script|AutoCAD|CAD)\b/i.test(text)
    || /\b(?:draw|draft|render)\b.{0,32}\b(?:in|inside|through|with)\s+(?:AutoCAD|CAD)\b/i.test(text);
  return mentionsCadSurface && wantsVisibleDrawing;
}

function parseRecordJson(record: ToolExecutionRecord): Record<string, any> | null {
  try {
    const parsed = JSON.parse(String(record.result || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : null;
  } catch {
    return null;
  }
}

export function hasVisibleAutoCadExecutionEvidence(records: ToolExecutionRecord[] = []): boolean {
  const successful = records.filter(record => !record.error && String(record.result || '').trim());
  if (successful.length === 0) return false;

  const generatedVisibleScript = successful.some(record =>
    /^cad_generate_autocad_draw_script$/i.test(record.name) &&
    /scriptPath|lispPath|completionMarkerPath|operationCount/i.test(String(record.result || ''))
  );

  const completedRun = successful.some(record => {
    if (!/^cad_run_autocad_draw_script$/i.test(record.name)) return false;
    const payload = parseRecordJson(record);
    const result = String(record.result || '');
    return payload?.status === 'completed'
      || payload?.completionMarkerExists === true
      || /"status"\s*:\s*"completed"|"completionMarkerExists"\s*:\s*true/i.test(result);
  });
  if (completedRun) return true;

  const visibleCadSurface = successful.some(record => {
    if (!/^(desktop_capture_screen|desktop_active_window|desktop_ui_snapshot|desktop_running_processes)$/i.test(record.name)) return false;
    return /AutoCAD|Autodesk|acad(?:\.exe)?|\bDWG\b|\bDXF\b|model\s*space/i.test(String(record.result || ''));
  });

  return generatedVisibleScript && visibleCadSurface;
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
    requiredEvidence: ['draft/review text grounded in supplied facts', '\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u6838\u9a8c gate \u901a\u8fc7', '\u6587\u4e66\u6587\u4ef6\u8def\u5f84\u6216\u660e\u786e\u7684\u5ba1\u9605\u610f\u89c1', '\u5916\u90e8\u5e73\u53f0\u7ed3\u679c\u9700\u8981\u6388\u6743\u4f1a\u8bdd/API \u8bc1\u636e\u3001\u6765\u6e90\u767b\u8bb0\u6216\u5165\u6848\u5f52\u6863'],
    preferredTools: LEGAL_ENTRY_PREFERRED_TOOLS,
    verificationTools: ['legal_generate_citation_verification_report', 'legal_finalize_delivery_package', 'legal_search_statute', 'read_docx', 'read_pdf', 'desktop_path_info', 'work_product_verify'],
    nextStep: '\u5148\u62ff\u5230\u4e8b\u5b9e\u3001\u8bc1\u636e\u3001\u8bc9\u8bbc\u76ee\u6807\u548c\u7ba1\u8f96\u7b49\u4fe1\u606f\uff0c\u518d\u8d77\u8349\u6216\u5ba1\u9605\u3002',
    caution: '\u4e0d\u80fd\u628a\u4e00\u822c\u6cd5\u5f8b\u8bf4\u660e\u8bf4\u6210\u5b8c\u6574\u4ee3\u7406\u8bcd\uff1b\u6cd5\u9662\u7acb\u6848\u7f51\u3001\u6cd5\u8749\u3001Alpha\u3001\u88c1\u5224\u6587\u4e66\u7f51\u3001\u4f01\u67e5\u67e5\u7b49\u53ea\u80fd\u505a\u6388\u6743\u534f\u4f5c\u3001\u7ed3\u679c\u5f52\u6863\u548c\u4ea4\u4ed8\u524d\u6838\u9a8c\uff1b\u91cd\u5927\u6cd5\u5f8b\u51b3\u7b56\u9700\u8981\u4e13\u4e1a\u5f8b\u5e08\u590d\u6838\u3002',
  });
}

export function buildActionContract(input: string): LumiActionContract {
  const text = compact(input);
  if (!text) return NONE_CONTRACT;
  const directedMessageSend = matches(text, /(?:\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}\s*(?:\u53d1\u9001|\u53d1|\u56de\u590d|\u8bf4|\u544a\u8bc9))|(?:\u53d1\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})|(?:(?:\u53d1\u9001|\u53d1)\s*[\s\S]{1,200}?\s*\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})/u);

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
        matches(text, /wechat|weixin|\u5fae\u4fe1|\u6d88\u606f|\u8054\u7cfb\u4eba|\u7fa4|message|reply/i) &&
        matches(text, /\u53d1\u9001|\u53d1\u7ed9|\u53d1\u4e00\u6761|\u53d1\u4e00\u4e0b|\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u53d1\u665a\u5b89|\bsend\b|\bmessage\b/i)
      )
    ) &&
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

  if (
    matches(text, /\u89c6\u9891\u7f51\u7ad9|\u8bc4\u8bba|\u53d1\u5e03|\u70b9\u8d5e|\u6295\u7a3f|comment|post|publish|like/i)
  ) {
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

  if (matches(text, /\u767b\u5f55|\u6d4f\u89c8\u5668|\u6253\u5f00\u7f51\u7ad9|\u81ea\u52a8\u767b\u5f55|browser|login|log\s*in|website|site/i)) {
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

  if (matches(text, /\bCAD\b|\bDXF\b|\bDWG\b|AutoCAD|\u753b\u56fe|\u753b\u56fe\u7eb8|\u56fe\u7eb8|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe|\u88c5\u4fee|cad/i)) {
    return withDefaults({
      kind: 'cad_drafting',
      label: 'CAD/\u56fe\u7eb8\u4f5c\u6218',
      coreAction: '\u751f\u6210\u6216\u64cd\u4f5c CAD \u56fe\u7eb8\uff0c\u786e\u8ba4\u6587\u4ef6\u4ea7\u7269\u6216\u53ef\u89c1\u8f6f\u4ef6\u7ed8\u5236\u7ed3\u679c',
      preparationIsNotCompletion: ['\u8ba1\u7b97\u65b9\u6848', '\u5199\u51fa\u811a\u672c', '\u6253\u5f00 CAD \u8f6f\u4ef6', '\u67e5\u770b\u6587\u4ef6\u5939', '\u53ea\u751f\u6210 DXF/\u65b9\u6848\u5305'],
      requiredEvidence: ['created CAD/DXF/script file path with nonzero size', '\u82e5\u7528\u6237\u8981\u5728 AutoCAD/CAD \u91cc\u5b9e\u9645\u753b\uff1acad_run_autocad_draw_script completed/marker evidence or visible AutoCAD drawing evidence', '\u6216 CAD \u8f6f\u4ef6\u4e2d\u53ef\u89c1\u56fe\u5f62\u7684\u684c\u9762\u8bc1\u636e'],
      preferredTools: ['floorplan_extract_geometry', 'cad_generate_dxf', 'cad_generate_autocad_draw_script', 'cad_run_autocad_draw_script', 'desktop_path_info', 'desktop_capture_screen'],
      verificationTools: ['desktop_path_info', 'work_product_verify', 'desktop_capture_screen', 'desktop_active_window'],
      nextStep: '\u5148\u8bfb\u53d6\u56fe\u7247/\u6587\u4ef6\u5f62\u6210\u7ed3\u6784\u5316\u51e0\u4f55\uff0c\u518d\u751f\u6210 CAD/DXF\uff1b\u82e5\u7528\u6237\u660e\u8bf4 AutoCAD \u5b9e\u753b\uff0c\u5fc5\u987b\u7ee7\u7eed\u5230 AutoCAD \u811a\u672c\u6267\u884c\u548c\u53ef\u89c1\u9a8c\u8bc1\u3002',
      caution: '\u4e0d\u80fd\u628a\u8bbe\u8ba1\u601d\u8def\u3001DXF/\u65b9\u6848\u5305\u3001\u811a\u672c\u8349\u7a3f\u6216\u6253\u5f00\u8f6f\u4ef6\u8bf4\u6210\u5df2\u5728 AutoCAD \u91cc\u753b\u5b8c\u3002',
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

  if (matches(text, /\u684c\u9762|\u6253\u5f00|\u805a\u7126|\u70b9\u51fb|\u8f93\u5165|\u5e94\u7528|\u8f6f\u4ef6|desktop|open|click|type|app|application/i)) {
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

export function hasCoreActionEvidence(contract: LumiActionContract, records: ToolExecutionRecord[] = []): boolean {
  if (!contract.applies) return true;
  const successful = records.filter(record => !record.error && String(record.result || '').trim());
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
  if (contract.kind === 'public_post' || contract.kind === 'browser_account') {
    return successful.some(record => /browser|playwright|desktop_capture_screen|desktop_ui_snapshot/i.test(record.name));
  }
  if (contract.kind === 'cad_drafting') {
    return successful.some(record => /cad_|desktop_path_info|work_product_verify/i.test(record.name));
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
