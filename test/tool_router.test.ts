import { describe, expect, it } from 'vitest';
import { mergeToolPolicyWithRoute, routeToolsForTurn } from '../server/cognition/tool_router';

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

const DECLARATIONS = [
  'work_product_plan',
  'work_product_verify',
  'read_file',
  'read_files_batch',
  'list_directory',
  'search_files',
  'grep_files',
  'extract_document_text',
  'transcribe_audio_to_text_file',
  'read_docx',
  'read_pdf',
  'ocr_image_file',
  'create_docx',
  'write_file',
  'web_search',
  'url_fetch',
  'url_fetch_logged_in',
  'web_login_site_presets',
  'web_login_profile_save_from_preset',
  'web_login_profile_save',
  'web_login_learn_site',
  'web_login_profile_list',
  'web_login_run',
  'external_control_candidates',
  'external_control_configure_candidate',
  'desktop_list_files',
  'desktop_path_info',
  'desktop_list_apps',
  'desktop_open',
  'desktop_active_window',
  'desktop_ui_snapshot',
  'desktop_ui_focus',
  'desktop_ui_click',
  'desktop_ui_invoke',
  'desktop_ui_type',
  'desktop_capture_screen',
  'ocr_screen',
  'desktop_mouse_click_at',
  'desktop_cursor_glow_show',
  'desktop_cursor_glow_update',
  'desktop_cursor_glow_click',
  'desktop_cursor_glow_hide',
  'desktop_keyboard_press',
  'wechat_read_recent_chat',
  'wechat_send_message',
  'wechat_prepare_reply',
  'wechat_copy_reply_draft',
  'mcp_playwright_browser_snapshot',
  'mcp_playwright_browser_navigate',
  'mcp_playwright_browser_click',
  'mcp_playwright_browser_fill_form',
  'legal_search_case',
  'legal_search_statute',
  'legal_generate_bid',
  'legal_review_contract',
  'legal_draft_contract',
  'legal_trace_assets',
  'legal_equity_penetration',
  'legal_case_strategy',
  'legal_generate_litigation_packet',
  'legal_extract_dispute_focus',
  'legal_generate_argument_or_opinion',
  'legal_import_materials_to_kb',
  'legal_external_source_status',
  'legal_search_external_authorities',
  'legal_company_database_lookup',
  'legal_external_research_plan',
  'legal_generate_citation_verification_report',
  'legal_finalize_delivery_package',
  'legal_prepare_external_browser_workspace',
  'legal_verify_citation',
  'legal_import_judgment',
  'authority_research',
  'authority_research_save',
  'mcp_legal-casework_legal_case_folder_workflow',
  'mcp_legal-casework_legal_document_outline',
  'mcp_neteasemusic_search_song',
  'mcp_stockbot_stock_search',
  'mcp_stockbot_stock_quote',
  'mcp_stockbot_stock_kline',
  'mcp_stockbot_market_index',
  'mcp_stockbot_hot_sectors',
  'mcp_stockbot_stock_news',
  'mcp_stockbot_stock_trade_plan',
  'mcp_stockbot_paper_trade',
  'mcp_stockbot_paper_portfolio',
  'mcp_cad-drafting_cad_space_program',
  'mcp_cad-drafting_cad_renovation_folder_workflow',
  'floorplan_extract_geometry',
  'cad_generate_dxf',
  'cad_generate_autocad_draw_script',
  'cad_run_autocad_draw_script',
  'generate_image',
  'git_status',
  'git_commit',
  'list_skills',
  'generate_skill',
  'self_extension_plan',
  'adapter_registry_list',
  'capability_gap_autofix',
  'capability_learning_list',
  'client_get_state',
  'work_takeover_capability_reuse_probe',
  'work_takeover_real_smoke_run',
  'work_takeover_task_prepare_industry_package',
  'work_takeover_task_verify_result',
  'work_takeover_task_export_packet',
].map(name => declaration(name));

describe('tool router', () => {
  it('routes legal case-folder work to legal, auth-web, and file tools', () => {
    const route = routeToolsForTurn(
      '读取桌面案件文件夹，去法信和中国裁判文书网整理委托书、代理词和证据目录',
      DECLARATIONS,
    );

    expect(route.categories).toContain('legal');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'mcp_legal-casework_legal_case_folder_workflow',
      'legal_search_case',
      'web_login_run',
      'url_fetch_logged_in',
      'read_file',
      'extract_document_text',
    ]));
    expect(route.toolNames).not.toContain('mcp_neteasemusic_search_song');
    expect(route.toolNames).not.toContain('mcp_cad-drafting_cad_space_program');
  });

  it('routes chat-style legal drafting requests without opening the workbench first', () => {
    const route = routeToolsForTurn(
      '根据原告起诉状和证据材料，帮我生成答辩状、质证意见和证据反驳表',
      DECLARATIONS,
    );

    expect(route.categories).toContain('legal');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'legal_generate_litigation_packet',
      'legal_extract_dispute_focus',
      'legal_generate_argument_or_opinion',
      'legal_case_strategy',
      'legal_search_statute',
      'legal_search_case',
    ]));
  });

  it('routes dispute-focus extraction from trial materials through chat and voice', () => {
    const focusRoute = routeToolsForTurn(
      '根据起诉状、证据和庭审笔录总结争议焦点，整理待证事实和质证意见',
      DECLARATIONS,
    );
    const opinionRoute = routeToolsForTurn(
      '语音记录一下，按刚才材料生成代理词、庭审提纲和法律意见书',
      DECLARATIONS,
    );

    expect(focusRoute.categories).toContain('legal');
    expect(focusRoute.toolNames).toEqual(expect.arrayContaining([
      'legal_extract_dispute_focus',
      'legal_generate_argument_or_opinion',
      'legal_generate_litigation_packet',
      'legal_import_materials_to_kb',
    ]));

    expect(opinionRoute.categories).toContain('legal');
    expect(opinionRoute.toolNames).toEqual(expect.arrayContaining([
      'legal_extract_dispute_focus',
      'legal_generate_argument_or_opinion',
      'legal_case_strategy',
    ]));
  });

  it('routes material import and source-status requests to legal knowledge tools', () => {
    const importRoute = routeToolsForTurn(
      '把这个案件文件夹里的起诉状、证据和庭审笔录导入知识库，后面生成代理词要用',
      DECLARATIONS,
    );
    const sourceRoute = routeToolsForTurn(
      '外部数据源接入状态说清楚，哪些是企查查 API，哪些只是授权网页登录',
      DECLARATIONS,
    );

    expect(importRoute.categories).toContain('legal');
    expect(importRoute.toolNames).toEqual(expect.arrayContaining([
      'legal_import_materials_to_kb',
      'legal_extract_dispute_focus',
      'read_file',
      'extract_document_text',
    ]));

    expect(sourceRoute.categories).toContain('legal');
    expect(sourceRoute.toolNames).toEqual(expect.arrayContaining([
      'legal_external_source_status',
      'web_login_run',
    ]));
  });

  it('routes voice-style legal commands to external research and browser login tools', () => {
    const route = routeToolsForTurn(
      'Lumi 帮我查这个买卖合同纠纷的类案，先去人民法院案例库、裁判文书网、法蝉和企查查，整理外部检索行动单',
      DECLARATIONS,
    );

    expect(route.categories).toContain('legal');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'legal_external_research_plan',
      'web_login_run',
      'url_fetch_logged_in',
      'legal_search_case',
    ]));
  });

  it('routes formal legal delivery, citation reports, and browser workspaces', () => {
    const route = routeToolsForTurn(
      '把这份代理词做成正式DOCX交付包，生成引用核验报告和法蝉/Alpha网页登录工作区',
      DECLARATIONS,
    );

    expect(route.categories).toContain('legal');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'legal_finalize_delivery_package',
      'legal_generate_citation_verification_report',
      'legal_prepare_external_browser_workspace',
      'web_login_run',
      'create_docx',
    ]));
  });

  it('routes legal database API and company lookup requests', () => {
    const route = routeToolsForTurn(
      'Use pkulaw and farui to search legal database cases, then use tianyancha and qichacha for company litigation risk.',
      DECLARATIONS,
    );

    expect(route.categories).toContain('legal');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'legal_search_external_authorities',
      'legal_company_database_lookup',
      'legal_external_source_status',
      'legal_trace_assets',
    ]));
  });

  it('routes generic website login learning to authenticated browser tools', () => {
    const route = routeToolsForTurn(
      '帮我学习这个店铺后台网页登录，记住账号密码，下次可以自动登录继续操作',
      DECLARATIONS,
    );

    expect(route.categories).toContain('authenticated_web');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'web_login_profile_save',
      'web_login_learn_site',
      'web_login_profile_list',
      'web_login_run',
      'url_fetch_logged_in',
      'mcp_playwright_browser_snapshot',
      'mcp_playwright_browser_fill_form',
    ]));
  });

  it('routes external software control upgrades to UIA and MCP setup tools', () => {
    const route = routeToolsForTurn(
      '提升 Lumi 控制外部软件的通用能力，接入 Playwright MCP 和 Windows UIA 控件树',
      DECLARATIONS,
    );

    expect(route.categories).toEqual(expect.arrayContaining(['skills_agents', 'system']));
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'external_control_candidates',
      'external_control_configure_candidate',
      'desktop_ui_snapshot',
      'desktop_ui_click',
      'desktop_ui_type',
      'adapter_registry_list',
      'mcp_playwright_browser_snapshot',
    ]));
  });

  it('routes spoken bid and asset-tracing requests through legal tools', () => {
    const bidRoute = routeToolsForTurn('根据招标要求 PDF 自动生成标书框架', DECLARATIONS);
    const assetRoute = routeToolsForTurn('语音记录一下，查被执行人公司情况和股权穿透', DECLARATIONS);

    expect(bidRoute.categories).toContain('legal');
    expect(bidRoute.toolNames).toContain('legal_generate_bid');
    expect(bidRoute.toolNames).toContain('read_pdf');

    expect(assetRoute.categories).toContain('legal');
    expect(assetRoute.toolNames).toEqual(expect.arrayContaining([
      'legal_trace_assets',
      'legal_equity_penetration',
    ]));
  });

  it('routes music requests away from legal tools', () => {
    const route = routeToolsForTurn('帮我放一首网易云的歌', DECLARATIONS);

    expect(route.categories).toContain('music');
    expect(route.toolNames).toContain('mcp_neteasemusic_search_song');
    expect(route.toolNames).not.toContain('mcp_legal-casework_legal_case_folder_workflow');
    expect(route.toolNames).not.toContain('legal_search_case');
  });

  it('routes stock trading and paper portfolio requests to stockbot tools', () => {
    const route = routeToolsForTurn(
      'Lumi 帮我给 600519 做一个交易计划，算仓位和止损，再记录到模拟盘',
      DECLARATIONS,
    );

    expect(route.categories).toContain('market_finance');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'mcp_stockbot_stock_quote',
      'mcp_stockbot_stock_trade_plan',
      'mcp_stockbot_paper_trade',
      'mcp_stockbot_paper_portfolio',
    ]));
    expect(route.toolNames).not.toContain('mcp_neteasemusic_search_song');
    expect(route.toolNames).not.toContain('legal_search_case');
  });

  it('routes stock watchlists and price alerts to stockbot tools', () => {
    const route = routeToolsForTurn(
      'Track my A-share watchlist, check market alerts, and watch 600519 intraday.',
      DECLARATIONS,
    );

    expect(route.categories).toContain('market_finance');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'mcp_stockbot_stock_quote',
      'mcp_stockbot_stock_kline',
      'mcp_stockbot_stock_news',
      'mcp_stockbot_paper_portfolio',
    ]));
  });

  it('keeps foreground WeChat sends on the dedicated virtual cursor path', () => {
    const route = routeToolsForTurn(
      '\u5fae\u4fe1\u76f4\u63a5\u53d1\u665a\u5b89\u7ed9\u963f\u9646',
      DECLARATIONS,
      { maxTools: 8 },
    );

    expect(route.categories).toContain('messaging');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'wechat_send_message',
      'desktop_open',
      'desktop_active_window',
      'desktop_mouse_click_at',
      'desktop_cursor_glow_show',
    ]));
    expect(route.toolNames.indexOf('wechat_send_message')).toBeLessThan(3);
  });

  it('routes foreground WeChat chat reading away from send/draft tools', () => {
    const route = routeToolsForTurn(
      '\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9',
      DECLARATIONS,
      { maxTools: 8 },
    );

    expect(route.categories).toContain('messaging');
    expect(route.toolNames.slice(0, 4)).toEqual(expect.arrayContaining([
      'wechat_read_recent_chat',
      'desktop_open',
      'desktop_active_window',
    ]));
    expect(route.toolNames.slice(0, 4)).not.toContain('wechat_send_message');
  });

  it('filters unavailable MCP tools when a health gate is provided', () => {
    const route = routeToolsForTurn(
      'Lumi 帮我给 600519 做一个交易计划，算仓位和止损，再记录到模拟盘',
      DECLARATIONS,
      { connectedMcpServers: [] },
    );

    expect(route.categories).toContain('market_finance');
    expect(route.toolNames).not.toContain('mcp_stockbot_stock_quote');
    expect(route.toolNames).not.toContain('mcp_stockbot_stock_trade_plan');
    expect(route.toolNames).not.toContain('mcp_stockbot_paper_trade');
    expect(route.unavailableMcpServers).toContain('stockbot');
    expect(route.reasons.join('\n')).toContain('MCP health gate skipped unavailable servers');
  });

  it('keeps connected MCP tools when the health gate marks their server connected', () => {
    const route = routeToolsForTurn(
      'Lumi 帮我给 600519 做一个交易计划，算仓位和止损，再记录到模拟盘',
      DECLARATIONS,
      { connectedMcpServers: ['stockbot'] },
    );

    expect(route.toolNames).toEqual(expect.arrayContaining([
      'mcp_stockbot_stock_quote',
      'mcp_stockbot_stock_trade_plan',
      'mcp_stockbot_paper_trade',
    ]));
    expect(route.unavailableMcpServers).not.toContain('stockbot');
  });

  it('routes audio transcription requests to transcript file tooling', () => {
    const route = routeToolsForTurn(
      'I attached a voice memo. Please transcribe the audio and save it as a text file.',
      DECLARATIONS,
    );

    expect(route.categories).toContain('audio_transcription');
    expect(route.toolNames).toContain('transcribe_audio_to_text_file');
    expect(route.toolNames).toContain('extract_document_text');
    expect(route.toolNames).not.toContain('mcp_neteasemusic_search_song');
    expect(route.toolNames).not.toContain('legal_search_case');
  });

  it('routes renovation drafting folders to CAD and document tools', () => {
    const route = routeToolsForTurn(
      '读取桌面装修草稿图文件夹，生成 DXF 底图、平面布置方案、水电点位和装修方案',
      DECLARATIONS,
    );

    expect(route.categories).toContain('cad_design');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'mcp_cad-drafting_cad_renovation_folder_workflow',
      'mcp_cad-drafting_cad_space_program',
      'cad_generate_dxf',
      'cad_generate_autocad_draw_script',
      'cad_run_autocad_draw_script',
      'read_file',
      'extract_document_text',
      'ocr_image_file',
    ]));
    expect(route.toolNames).not.toContain('mcp_neteasemusic_search_song');
  });

  it('routes local desktop CAD folders through source discovery before drafting', () => {
    const route = routeToolsForTurn(
      '\u684c\u9762\u4e0a\u6709\u4e2a\u300c\u963f\u9646\u300d\u6587\u4ef6\u5939\uff0c\u8bf7\u5148\u8bfb\u53d6\u5e76\u6574\u7406\u91cc\u9762\u7684\u6587\u4ef6\u5185\u5bb9\uff0c\u7136\u540e\u6839\u636e\u91cc\u9762\u7684\u4fe1\u606f\u751f\u6210 CAD \u56fe\u7eb8\u65b9\u6848\uff0c\u5e76\u5728 AutoCAD \u91cc\u5b9e\u9645\u753b\u51fa\u6765',
      DECLARATIONS,
    );

    expect(route.categories).toContain('cad_design');
    expect(route.toolNames.slice(0, 9)).toEqual(expect.arrayContaining([
      'desktop_path_info',
      'desktop_list_files',
      'floorplan_extract_geometry',
      'mcp_cad-drafting_cad_renovation_folder_workflow',
      'cad_generate_dxf',
      'cad_generate_autocad_draw_script',
      'cad_run_autocad_draw_script',
    ]));
    expect(route.toolNames.indexOf('desktop_list_files')).toBeLessThan(route.toolNames.indexOf('cad_generate_dxf'));
    expect(route.toolNames.indexOf('floorplan_extract_geometry')).toBeLessThan(route.toolNames.indexOf('cad_generate_dxf'));
    expect(route.toolNames.indexOf('cad_run_autocad_draw_script')).toBeLessThan(route.toolNames.indexOf('mcp_cad-drafting_cad_renovation_folder_workflow'));
  });

  it('routes skill questions to skill management tools', () => {
    const route = routeToolsForTurn('这些技能 Lumi 会调用吗，帮我看看技能大厅和 MCP', DECLARATIONS);

    expect(route.categories).toContain('skills_agents');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'list_skills',
      'generate_skill',
      'capability_gap_autofix',
      'client_get_state',
    ]));
  });

  it('routes capability reuse pressure tests to work takeover and self-extension tools', () => {
    const route = routeToolsForTurn(
      '拿这条客户微信做真实任务压测，看看 Lumi 会不会重复长能力，能不能复用已有能力稳定跑一遍',
      DECLARATIONS,
    );

    expect(route.categories).toEqual(expect.arrayContaining(['work_takeover', 'skills_agents']));
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'work_takeover_capability_reuse_probe',
      'work_takeover_real_smoke_run',
      'self_extension_plan',
      'capability_learning_list',
    ]));
  });

  it('merges routes with existing restrictive policies', () => {
    const route = routeToolsForTurn('读取案件文件夹整理代理词', DECLARATIONS);
    const policy = mergeToolPolicyWithRoute({
      allowedTools: ['read_file', 'client_action'],
      requireConfirmation: [],
      forbiddenTools: [],
      maxIterations: 4,
    }, route);

    expect(policy.allowedTools).toEqual(['read_file']);
  });
});
