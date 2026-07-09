import type { ToolExecutionRecord } from '../tools/types';

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

export function buildActionContract(input: string): LumiActionContract {
  const text = compact(input);
  if (!text) return NONE_CONTRACT;
  const directedMessageSend = matches(text, /(?:\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}\s*(?:\u53d1\u9001|\u53d1|\u56de\u590d|\u8bf4|\u544a\u8bc9))|(?:\u53d1\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})|(?:(?:\u53d1\u9001|\u53d1)\s*[\s\S]{1,200}?\s*\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})/u);

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
      requiredEvidence: ['logged-in page/session evidence', '\u76ee\u6807\u9875\u9762\u72b6\u6001\u6216\u8d26\u53f7\u72b6\u6001\u9a8c\u8bc1'],
      preferredTools: ['mcp_playwright_browser_snapshot', 'browser_open_task', 'web_login_run', 'desktop_active_window', 'desktop_capture_screen'],
      verificationTools: ['mcp_playwright_browser_snapshot', 'desktop_capture_screen'],
      nextStep: '\u5148\u68c0\u67e5\u5f53\u524d\u4f1a\u8bdd\u548c\u767b\u5f55\u72b6\u6001\uff1b\u9047\u5230\u5bc6\u7801\u3001\u9a8c\u8bc1\u7801\u6216 2FA \u5c31\u505c\u4e0b\u8bf4\u660e\u3002',
      caution: '\u4e0d\u80fd\u628a\u6253\u5f00\u7f51\u9875\u8bf4\u6210\u5df2\u767b\u5f55\u6216\u5df2\u5b8c\u6210\u8d26\u53f7\u64cd\u4f5c\u3002',
    });
  }

  if (matches(text, /\bCAD\b|\bDXF\b|\bDWG\b|AutoCAD|\u753b\u56fe|\u753b\u56fe\u7eb8|\u56fe\u7eb8|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe|\u88c5\u4fee|cad/i)) {
    return withDefaults({
      kind: 'cad_drafting',
      label: 'CAD/\u56fe\u7eb8\u4f5c\u6218',
      coreAction: '\u751f\u6210\u6216\u64cd\u4f5c CAD \u56fe\u7eb8\uff0c\u786e\u8ba4\u6587\u4ef6\u4ea7\u7269\u6216\u53ef\u89c1\u8f6f\u4ef6\u7ed8\u5236\u7ed3\u679c',
      preparationIsNotCompletion: ['\u8ba1\u7b97\u65b9\u6848', '\u5199\u51fa\u811a\u672c', '\u6253\u5f00 CAD \u8f6f\u4ef6', '\u67e5\u770b\u6587\u4ef6\u5939'],
      requiredEvidence: ['created CAD/DXF/script file path with nonzero size', '\u6216 CAD \u8f6f\u4ef6\u4e2d\u53ef\u89c1\u56fe\u5f62\u7684\u684c\u9762\u8bc1\u636e'],
      preferredTools: ['cad_generate_dxf', 'cad_generate_autocad_draw_script', 'cad_run_autocad_draw_script', 'desktop_path_info', 'desktop_capture_screen'],
      verificationTools: ['desktop_path_info', 'work_product_verify', 'desktop_capture_screen'],
      nextStep: '\u7528\u7ed3\u6784\u5316 CAD \u5de5\u5177\u751f\u6210\u4ea7\u7269\uff0c\u518d\u9a8c\u8bc1\u6587\u4ef6\u6216\u53ef\u89c1\u7ed8\u5236\u7ed3\u679c\u3002',
      caution: '\u4e0d\u80fd\u628a\u8bbe\u8ba1\u601d\u8def\u3001\u811a\u672c\u8349\u7a3f\u6216\u6253\u5f00\u8f6f\u4ef6\u8bf4\u6210\u56fe\u7eb8\u5df2\u5b8c\u6210\u3002',
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

  if (matches(text, /\u5f8b\u5e08|\u4ee3\u7406\u8bcd|\u8d77\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u5408\u540c|\u534f\u8bae|legal|lawyer|pleading|contract|agreement/i)) {
    return withDefaults({
      kind: 'legal_document',
      label: '\u6cd5\u5f8b\u6587\u4e66/\u4ee3\u7406\u8bcd',
      coreAction: '\u57fa\u4e8e\u7528\u6237\u63d0\u4f9b\u7684\u4e8b\u5b9e\u548c\u6587\u4ef6\u8d77\u8349\u6216\u5ba1\u9605\u6cd5\u5f8b\u6587\u4e66',
      preparationIsNotCompletion: ['\u6cd5\u5f8b\u5e38\u8bc6\u8bf4\u660e', '\u5217\u5927\u7eb2', '\u6ca1\u6709\u8bfb\u5230\u6848\u60c5\u6750\u6599'],
      requiredEvidence: ['draft/review text grounded in supplied facts', '\u6587\u4e66\u6587\u4ef6\u8def\u5f84\u6216\u660e\u786e\u7684\u5ba1\u9605\u610f\u89c1'],
      preferredTools: ['legal_case_brief', 'legal_pleading_draft', 'read_docx', 'read_pdf', 'create_docx', 'write_file'],
      verificationTools: ['read_docx', 'read_pdf', 'desktop_path_info', 'work_product_verify'],
      nextStep: '\u5148\u62ff\u5230\u4e8b\u5b9e\u3001\u8bc1\u636e\u3001\u8bc9\u8bbc\u76ee\u6807\u548c\u7ba1\u8f96\u7b49\u4fe1\u606f\uff0c\u518d\u8d77\u8349\u6216\u5ba1\u9605\u3002',
      caution: '\u4e0d\u80fd\u628a\u4e00\u822c\u6cd5\u5f8b\u8bf4\u660e\u8bf4\u6210\u5b8c\u6574\u4ee3\u7406\u8bcd\uff1b\u91cd\u5927\u6cd5\u5f8b\u51b3\u7b56\u9700\u8981\u4e13\u4e1a\u5f8b\u5e08\u590d\u6838\u3002',
    });
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
