import './helpers';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildActionContract, type LumiActionContractKind } from '../server/cognition/action_contract';
import { buildLumiCapabilitySelection } from '../server/cognition/capability_selection';
import { buildLumiExecutionDecision } from '../server/cognition/execution_decision';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { buildLumiTurnDispatch } from '../server/cognition/turn_dispatch';

function declaration(name: string, description = name) {
  return {
    type: 'function' as const,
    function: {
      name,
      description,
      parameters: { type: 'object', properties: {} },
    },
  };
}

const declarations = [
  'work_product_plan',
  'work_product_verify',
  'client_get_state',
  'client_action',
  'browser_open_task',
  'web_search',
  'url_fetch',
  'url_fetch_logged_in',
  'web_login_profile_list',
  'web_login_run',
  'mcp_playwright_browser_snapshot',
  'mcp_playwright_browser_navigate',
  'mcp_playwright_browser_click',
  'mcp_playwright_browser_fill_form',
  'mcp_playwright_browser_type',
  'mcp_playwright_browser_take_screenshot',
  'desktop_list_apps',
  'desktop_open',
  'desktop_active_window',
  'desktop_ui_snapshot',
  'desktop_ui_focus',
  'desktop_ui_click',
  'desktop_ui_type',
  'desktop_ui_invoke',
  'desktop_capture_screen',
  'desktop_mouse_click_at',
  'desktop_cursor_glow_show',
  'desktop_cursor_glow_update',
  'desktop_cursor_glow_click',
  'desktop_cursor_glow_hide',
  'desktop_keyboard_press',
  'ocr_screen',
  'write_clipboard',
  'computer_use',
  'wechat_read_recent_chat',
  'wechat_send_message',
  'wechat_prepare_reply',
  'wechat_copy_reply_draft',
  'cad_generate_dxf',
  'cad_prepare_autocad_operations',
  'mcp_cad-drafting_autocad_playback_file',
  'mcp_cad-drafting_cad_space_program',
  'mcp_cad-drafting_cad_renovation_folder_workflow',
  'mcp_stockbot_stock_quote',
  'mcp_stockbot_stock_kline',
  'mcp_stockbot_market_index',
  'mcp_stockbot_hot_sectors',
  'mcp_stockbot_stock_news',
  'mcp_stockbot_stock_trade_plan',
  'mcp_stockbot_paper_portfolio',
  'legal_search_case',
  'legal_search_statute',
  'legal_trace_assets',
  'legal_equity_penetration',
  'legal_company_database_lookup',
  'legal_case_strategy',
  'legal_case_workspace',
  'legal_case_workflow_status',
  'legal_message_intake_to_case',
  'legal_meeting_minutes_to_case',
  'legal_case_reasoning_matrix',
  'legal_generate_litigation_packet',
  'legal_prepare_filing_handoff',
  'legal_extract_dispute_focus',
  'legal_generate_argument_or_opinion',
  'legal_analyze_folder_and_draft_argument',
  'legal_import_materials_to_kb',
  'legal_process_notice_link',
  'legal_download_and_extract_document',
  'legal_external_research_plan',
  'legal_search_external_authorities',
  'legal_generate_citation_verification_report',
  'legal_finalize_delivery_package',
  'legal_prepare_external_browser_workspace',
  'read_docx',
  'read_pdf',
  'create_docx',
  'write_file',
].map(name => declaration(name));

function evaluate(text: string, userId: string) {
  const dispatch = buildLumiTurnDispatch({
    userId,
    text,
    channel: 'chat',
    source: 'chat',
    operationMode: 'assistant',
    targetIsLumi: true,
  });
  const execution = buildLumiExecutionDecision({
    flow: dispatch.flow,
    text,
    toolDeclarations: declarations,
  });
  const selection = buildLumiCapabilitySelection({
    dispatch,
    execution,
    text,
  });
  return {
    contract: buildActionContract(text),
    dispatch,
    execution,
    selection,
    route: execution.toolRoute,
  };
}

describe('Lumi runtime action pressure coverage', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('keeps real-world action classes aligned from contract to routed tools', () => {
    const cases: Array<{
      id: string;
      text: string;
      kind: LumiActionContractKind;
      categories: string[];
      tools: string[];
      earlyTools?: string[];
    }> = [
      {
        id: 'wechat-read',
        text: '\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9',
        kind: 'messaging_read',
        categories: ['messaging'],
        tools: ['wechat_read_recent_chat', 'desktop_open', 'desktop_active_window', 'ocr_screen'],
        earlyTools: ['wechat_read_recent_chat'],
      },
      {
        id: 'wechat-directed-send',
        text: '\u5fae\u4fe1\u7ed9\u5f20\u4e09\u53d1\u4e0b\u5348\u4e09\u70b9\u5f00\u4f1a',
        kind: 'messaging_send',
        categories: ['messaging'],
        tools: ['wechat_send_message', 'desktop_mouse_click_at', 'desktop_cursor_glow_show'],
        earlyTools: ['wechat_send_message'],
      },
      {
        id: 'browser-login',
        text: '\u6253\u5f00\u6d4f\u89c8\u5668\u81ea\u52a8\u767b\u5f55\u6dd8\u5b9d\u540e\u53f0',
        kind: 'browser_account',
        categories: ['authenticated_web'],
        tools: ['web_login_run', 'web_login_profile_list', 'browser_open_task', 'mcp_playwright_browser_snapshot'],
        earlyTools: ['web_login_run', 'browser_open_task'],
      },
      {
        id: 'public-video-comment',
        text: '\u89c6\u9891\u7f51\u7ad9\u81ea\u52a8\u8bc4\u8bba\u8fd9\u4e2a\u89c6\u9891',
        kind: 'public_post',
        categories: ['public_post'],
        tools: ['browser_open_task', 'mcp_playwright_browser_snapshot', 'desktop_ui_snapshot', 'write_clipboard'],
        earlyTools: ['browser_open_task', 'mcp_playwright_browser_snapshot'],
      },
      {
        id: 'cad-drafting',
        text: '\u5728 AutoCAD \u4e2d\u4e00\u7b14\u4e00\u7b14\u5b9e\u9645\u753b\u56fe',
        kind: 'cad_drafting',
        categories: ['cad_design'],
        tools: ['cad_prepare_autocad_operations', 'mcp_cad-drafting_autocad_playback_file'],
        earlyTools: ['cad_prepare_autocad_operations'],
      },
      {
        id: 'stock-watch',
        text: '\u5e2e\u6211\u76ef\u76d8\u80a1\u7968',
        kind: 'stock_monitor',
        categories: ['market_finance'],
        tools: ['mcp_stockbot_stock_quote', 'mcp_stockbot_stock_kline', 'mcp_stockbot_market_index'],
        earlyTools: ['mcp_stockbot_stock_quote'],
      },
      {
        id: 'legal-argument',
        text: '\u5f8b\u5e08\u7684\u4ee3\u7406\u8bcd',
        kind: 'legal_document',
        categories: ['legal'],
        tools: ['legal_generate_argument_or_opinion', 'legal_analyze_folder_and_draft_argument', 'read_docx', 'create_docx'],
        earlyTools: ['legal_analyze_folder_and_draft_argument', 'legal_generate_argument_or_opinion'],
      },
      {
        id: 'legal-asset-trace',
        text: '\u67e5\u88ab\u6267\u884c\u4eba\u8d22\u4ea7\u7ebf\u7d22\u548c\u80a1\u6743\u7a7f\u900f',
        kind: 'legal_document',
        categories: ['legal'],
        tools: ['legal_trace_assets', 'legal_equity_penetration', 'legal_company_database_lookup'],
        earlyTools: ['legal_trace_assets', 'legal_equity_penetration'],
      },
    ];

    for (const item of cases) {
      const result = evaluate(item.text, `pressure_${item.id}`);

      expect(result.contract.kind, item.id).toBe(item.kind);
      expect(result.dispatch.boundary, item.id).toBe('tool_action');
      expect(result.execution.allowToolUse, item.id).toBe(true);
      expect(result.route, item.id).not.toBeNull();
      expect(result.selection.preferredTools.length, item.id).toBeGreaterThan(0);
      expect(result.route?.categories, item.id).toEqual(expect.arrayContaining(item.categories));
      expect(result.route?.toolNames, item.id).toEqual(expect.arrayContaining(item.tools));
      if (item.earlyTools) {
        expect(result.route?.toolNames.slice(0, 6), item.id).toEqual(expect.arrayContaining(item.earlyTools));
      }
    }
  });

  it('keeps direct external actions out of capability-learning detours', () => {
    const login = evaluate(
      '\u6253\u5f00\u6d4f\u89c8\u5668\u81ea\u52a8\u767b\u5f55\u6dd8\u5b9d\u540e\u53f0',
      'pressure_direct_login_lane',
    );
    const cad = evaluate('\u5728 AutoCAD \u4e2d\u4e00\u7b14\u4e00\u7b14\u5b9e\u9645\u753b\u56fe', 'pressure_direct_cad_order');

    expect(login.contract.kind).toBe('browser_account');
    expect(login.dispatch.flow.executionGovernance.capabilityLearningIntent).toBe('none');
    expect(login.selection.lane).toBe('web_or_account');
    expect(login.route?.categories).not.toContain('capability_learning');
    expect(login.route?.toolNames.slice(0, 4)).toEqual(expect.arrayContaining([
      'web_login_run',
      'browser_open_task',
    ]));

    expect(cad.contract.kind).toBe('cad_drafting');
    expect(cad.route?.toolNames.slice(0, 3)).toEqual([
      'desktop_list_apps',
      'cad_prepare_autocad_operations',
      'mcp_cad-drafting_autocad_playback_file',
    ]);
    expect(cad.route?.toolNames).not.toContain('cad_generate_dxf');
  });

  it('does not treat reading a chat as sending a chat', () => {
    const result = evaluate(
      '\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9',
      'pressure_read_not_send',
    );

    expect(result.contract.kind).toBe('messaging_read');
    expect(result.route?.toolNames.slice(0, 4)).toContain('wechat_read_recent_chat');
    expect(result.route?.toolNames.slice(0, 4)).not.toContain('wechat_send_message');
  });

  it('blocks completion claims for action classes without core evidence', () => {
    const send = finalizeLumiResponse({
      taskText: '\u5fae\u4fe1\u7ed9\u5f20\u4e09\u53d1\u4e0b\u5348\u4e09\u70b9\u5f00\u4f1a',
      responseText: '\u5df2\u7ecf\u53d1\u9001\u4e86\u3002',
      source: 'chat',
      toolRecords: [],
    });
    const post = finalizeLumiResponse({
      taskText: '\u89c6\u9891\u7f51\u7ad9\u81ea\u52a8\u8bc4\u8bba\u8fd9\u4e2a\u89c6\u9891',
      responseText: '\u5df2\u5b8c\u6210\u8bc4\u8bba\u53d1\u5e03\u3002',
      source: 'chat',
      toolRecords: [],
    });

    expect(send.blocked).toBe(true);
    expect(send.reason).toContain('messaging_send');
    expect(post.blocked).toBe(true);
    expect(post.reason).toContain('public_post');
  });

  it('keeps a provider-acknowledged matching WeChat file delivery completed', () => {
    const delivered = finalizeLumiResponse({
      taskText: '\u628a\u9886\u822a\u5458\u8ba1\u52122026\u53d1\u7ed9\u6211',
      responseText: '\u9886\u822a\u5458\u8ba1\u52122026.docx \u5df2\u53d1\u9001\u3002',
      source: 'wechat_bot',
      toolRecords: [{
        id: 'wechat-file-delivery',
        name: 'wechat_send_file',
        arguments: { filePath: 'C:\\Users\\owner\\Desktop\\\u9886\u822a\u5458\u8ba1\u52122026.docx' },
        result: JSON.stringify({
          sent: true,
          verificationStatus: 'provider_accepted',
          verificationMethod: 'wechat_ilink_provider_ack',
          fileName: '\u9886\u822a\u5458\u8ba1\u52122026.docx',
          messageId: 'wx-file-delivery',
        }),
      }],
    });

    expect(delivered.blocked).toBe(false);
    expect(delivered.text).toContain('\u5df2\u53d1\u9001');
  });
});
