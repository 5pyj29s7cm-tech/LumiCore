import { describe, expect, it } from 'vitest';
import { mergeToolPolicyWithRoute, routeToolsForTurn } from '../server/cognition/tool_router';
import { isDiagnosticOrRepairRequest } from '../server/cognition/tool_intent';

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
  'mcp_filesystem_read_media_file',
  'mcp_filesystem_read_file',
  'list_directory',
  'search_files',
  'grep_files',
  'extract_document_text',
  'transcribe_audio_to_text_file',
  'read_docx',
  'read_pdf',
  'ocr_image_file',
  'create_docx',
  'create_pdf',
  'create_ppt',
  'write_file',
  'web_search',
  'url_fetch',
  'browser_open_task',
  'knowledge_file_stats',
  'knowledge_coverage_report',
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
  'desktop_system_info',
  'desktop_open',
  'desktop_active_window',
  'desktop_running_processes',
  'desktop_ui_snapshot',
  'desktop_ui_focus',
  'desktop_ui_click',
  'desktop_ui_invoke',
  'desktop_ui_type',
  'desktop_capture_screen',
  'desktop_ai_list_targets',
  'desktop_ai_discovery_plan',
  'desktop_ai_register_target',
  'desktop_ai_roundtable',
  'desktop_ai_ask',
  'desktop_ai_collect_answer',
  'external_ai_route_plan',
  'external_ai_collaborate',
  'external_ai_collect_answers',
  'external_ai_session_status',
  'external_ai_history_source_register',
  'external_ai_history_source_list',
  'external_ai_history_source_revoke',
  'external_ai_history_sync',
  'external_ai_history_status',
  'external_ai_history_query',
  'ocr_screen',
  'desktop_mouse_click_at',
  'desktop_cursor_glow_show',
  'desktop_cursor_glow_update',
  'desktop_cursor_glow_click',
  'desktop_cursor_glow_hide',
  'desktop_keyboard_press',
  'computer_use',
  'run_command',
  'desktop_run_command',
  'code_execution',
  'python_exec',
  'powershell',
  'shell_exec',
  'terminal_exec',
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
  'legal_external_source_status',
  'legal_search_external_authorities',
  'legal_company_database_lookup',
  'legal_external_research_plan',
  'legal_generate_citation_verification_report',
  'legal_finalize_delivery_package',
  'legal_prepare_external_browser_workspace',
  'legal_authority_source_status',
  'legal_refresh_authoritative_sources',
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
  'cad_prepare_autocad_operations',
  'mcp_cad-drafting_autocad_playback_file',
  'cad_draw_floorplan_in_autocad',
  'generate_image',
  'generate_video',
  'mcp_sales-customer-ops_lead_score',
  'mcp_sales-customer-ops_sales_followup_draft',
  'mcp_ecommerce-ops_product_listing_optimizer',
  'mcp_ecommerce-ops_campaign_roi_analyzer',
  'mcp_content-ops_short_video_script',
  'git_status',
  'git_commit',
  'list_skills',
  'generate_skill',
  'self_extension_plan',
  'adapter_registry_list',
  'capability_gap_autofix',
  'capability_learning_list',
  'client_get_state',
  'lumi_sleep_status',
  'lumi_sleep_cycle',
  'work_takeover_capability_reuse_probe',
  'work_takeover_task_verify_result',
  'work_takeover_task_export_packet',
].map(name => declaration(name));

describe('tool router', () => {
  it('does not treat a repair keyword inside a file path as a self-repair request', () => {
    expect(isDiagnosticOrRepairRequest(
      '请在 C:\\Users\\test-user\\Documents\\Lumi现场验收_修复复测.txt 创建一个 TXT 文件并读取验证。',
    )).toBe(false);
  });

  it('routes the field TXT creation request to write and verification tools', () => {
    const route = routeToolsForTurn(
      '在 C:\\Users\\test-user\\Documents 创建 Lumi现场验收_晨星716.txt，写三行，重读核验，不外发，不开其他软件',
      DECLARATIONS,
      { enableMcpHealthGate: false },
    );

    expect(route.categories).toContain('documents');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'write_file',
      'read_file',
      'work_product_verify',
    ]));
    expect(route.categories).not.toContain('messaging');
    expect(route.categories).not.toContain('desktop_launch');
  });

  it('keeps literal chat and status fields inside a TXT deliverable on the document route', () => {
    const route = routeToolsForTurn(
      '请在 C:\\Users\\test-user\\Documents\\Lumi主程序实机验收_20260816.txt 创建文件，内容为“渠道：指挥中心文字聊天”和“状态：待回读验证”，写入后必须重读。',
      DECLARATIONS,
      { enableMcpHealthGate: false },
    );

    expect(route.categories).toContain('documents');
    expect(route.toolNames).toEqual(expect.arrayContaining(['write_file', 'read_file', 'work_product_verify']));
    expect(route.categories).not.toContain('messaging');
  });

  it('routes an app launch plus exact-window verification as desktop launch, not document review', () => {
    const route = routeToolsForTurn(
      '请打开 Windows 计算器。必须打开精确目标，不能用浏览器、同名文件或其他应用替代；打开后读取当前活动窗口，只有窗口标题和进程能证明是计算器时才报告完成。',
      DECLARATIONS,
      { enableMcpHealthGate: false },
    );
    expect(route.categories).toEqual(['desktop_launch']);
    expect(route.toolNames).toEqual(expect.arrayContaining(['desktop_open', 'desktop_active_window']));
    expect(route.toolNames).not.toContain('read_file');
    expect(route.hardAllowlist).toBe(true);
  });

  it('aligns exact voice fast-path tools with routed permissions', () => {
    const browser = routeToolsForTurn('打开浏览器。', DECLARATIONS);
    expect(browser.toolNames).toContain('browser_open_task');

    const judgments = routeToolsForTurn('打开中国裁判文书网。', DECLARATIONS);
    expect(judgments.toolNames).toContain('browser_open_task');

    const knowledge = routeToolsForTurn('看一下现在知识库里有多少的文件内容。', DECLARATIONS);
    expect(knowledge.categories).toContain('knowledge');
    expect(knowledge.toolNames).toContain('knowledge_file_stats');
    expect(knowledge.toolNames).toContain('knowledge_coverage_report');
    expect(knowledge.toolNames).not.toContain('client_get_state');

    const fieldInspection = routeToolsForTurn('请检查当前个人知识库是否可用，报告文档数量、已索引数量和最近错误。只读取真实状态，不导入、不修改任何内容。', DECLARATIONS);
    expect(fieldInspection.categories).toContain('knowledge');
    expect(fieldInspection.toolNames).toEqual(expect.arrayContaining(['knowledge_file_stats', 'knowledge_coverage_report']));
    expect(fieldInspection.toolNames).not.toContain('client_get_state');
  });

  it('hard-isolates confirmation-only messaging from unrelated database or discovery tools', () => {
    const route = routeToolsForTurn(
      '请准备给测试联系人“验收占位联系人”发送消息“Lumi外发确认测试”，但在真正发送前必须向我确认；现在只到等待确认，不要发送。',
      DECLARATIONS,
      { enableMcpHealthGate: false },
    );
    expect(route.categories).toEqual(['messaging']);
    expect(route.toolNames).toEqual(['wechat_send_message']);
    expect(route.toolNames).not.toContain('database_query');
    expect(route.hardAllowlist).toBe(true);
    expect(route.maxIterations).toBe(1);
  });

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

  it('routes legal meeting minutes into the case workspace chain', () => {
    const route = routeToolsForTurn(
      '把这次办案会议转写整理成案件会议纪要，提炼证据线索、争议焦点和下一步待办',
      DECLARATIONS,
    );

    expect(route.categories).toContain('legal');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'legal_case_workspace',
      'legal_case_workflow_status',
      'legal_meeting_minutes_to_case',
      'legal_extract_dispute_focus',
      'legal_generate_litigation_packet',
    ]));
    expect(route.toolNames.indexOf('legal_meeting_minutes_to_case')).toBeGreaterThan(-1);
    expect(route.toolNames.indexOf('legal_meeting_minutes_to_case')).toBeLessThan(route.toolNames.indexOf('legal_generate_litigation_packet'));
  });

  it('routes explicit legal syllogism analysis to the reasoning matrix tool', () => {
    const route = routeToolsForTurn(
      '按三段论分析这个买卖合同案件，大前提检索法律和类案，小前提整理证据，最后给出涵摄结论',
      DECLARATIONS,
    );

    expect(route.categories).toContain('legal');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'legal_case_workspace',
      'legal_case_reasoning_matrix',
      'legal_extract_dispute_focus',
      'legal_generate_argument_or_opinion',
    ]));
    expect(route.toolNames.indexOf('legal_case_reasoning_matrix')).toBeGreaterThan(-1);
    expect(route.toolNames.indexOf('legal_case_reasoning_matrix')).toBeLessThan(route.toolNames.indexOf('legal_generate_argument_or_opinion'));
  });

  it('routes legal next-step and gap questions to the workflow status tool first', () => {
    const route = routeToolsForTurn(
      '看一下这个买卖合同案件现在闭环状态怎么样，还缺什么，下一步应该先做什么，能不能进入正式交付',
      DECLARATIONS,
    );

    expect(route.categories).toContain('legal');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'legal_case_workflow_status',
      'legal_case_workspace',
      'legal_case_reasoning_matrix',
      'legal_finalize_delivery_package',
    ]));
    expect(route.toolNames.indexOf('legal_case_workflow_status')).toBeGreaterThan(-1);
    expect(route.toolNames.indexOf('legal_case_workflow_status')).toBeLessThan(route.toolNames.indexOf('legal_case_workspace'));
  });

  it('routes remote legal bot intake to the message intake tool first', () => {
    const route = routeToolsForTurn(
      '飞书发给 Lumi bot 的法院短信链接和案件材料，自动入案并看看下一步',
      DECLARATIONS,
      { maxTools: 12 },
    );

    expect(route.categories).toEqual(expect.arrayContaining(['legal', 'messaging']));
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'legal_message_intake_to_case',
      'legal_process_notice_link',
      'legal_case_workflow_status',
    ]));
    expect(route.toolNames.indexOf('legal_message_intake_to_case')).toBeGreaterThan(-1);
    expect(route.toolNames.indexOf('legal_message_intake_to_case')).toBeLessThan(route.toolNames.indexOf('legal_process_notice_link'));
    expect(route.toolNames.indexOf('legal_message_intake_to_case')).toBeLessThan(route.toolNames.indexOf('legal_case_workflow_status'));
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

  it('routes Feishu, WeCom, and Lumi bot legal intake into the shared case workspace', () => {
    const feishuRoute = routeToolsForTurn(
      '飞书发给 Lumi bot 的法院短信链接和案件材料，自动入案，处理通知链接，然后告诉我这个案子下一步缺什么',
      DECLARATIONS,
    );
    const wecomRoute = routeToolsForTurn(
      '企微里客户转发了一组合同纠纷证据，发给 Lumi bot 后归档到公司案件工作台并更新闭环状态',
      DECLARATIONS,
    );

    for (const route of [feishuRoute, wecomRoute]) {
      expect(route.categories).toContain('legal');
      expect(route.toolNames).toEqual(expect.arrayContaining([
        'legal_message_intake_to_case',
        'legal_case_workspace',
        'legal_case_workflow_status',
        'legal_import_materials_to_kb',
      ]));
    }
    expect(feishuRoute.toolNames).toContain('legal_process_notice_link');
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

  it('routes current-law questions through authority status and refresh tools', () => {
    const route = routeToolsForTurn(
      '正式交付前检查所有引用是不是现行有效，刷新权威法源和司法解释版本',
      DECLARATIONS,
    );

    expect(route.categories).toContain('legal');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'legal_authority_source_status',
      'legal_refresh_authoritative_sources',
      'legal_verify_citation',
      'legal_finalize_delivery_package',
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

  it('routes external AI collaboration through the persistent unified pipeline', () => {
    const route = routeToolsForTurn(
      '把这个问题发给 WorkBuddy、Codex、ChatGPT 和 Claude，再把其它 AI 的回答拿回来总结',
      DECLARATIONS,
    );

    expect(route.categories).toContain('external_control');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'external_ai_collaborate',
      'external_ai_collect_answers',
      'external_ai_session_status',
      'external_ai_route_plan',
      'desktop_ai_list_targets',
      'desktop_ai_discovery_plan',
      'desktop_open',
      'desktop_capture_screen',
      'computer_use',
    ]));
    expect(route.toolNames.indexOf('external_ai_collaborate')).toBeLessThan(route.toolNames.indexOf('computer_use'));
    expect(route.toolNames).not.toEqual(expect.arrayContaining([
      'desktop_ai_ask',
      'desktop_ai_roundtable',
      'desktop_ai_collect_answer',
    ]));
    expect(route.forbiddenToolNames).toEqual(expect.arrayContaining([
      'desktop_ai_ask',
      'desktop_ai_roundtable',
      'desktop_ai_collect_answer',
    ]));
  });

  it('routes external AI history reads through authorization tools and hard-forbids prompt submission', () => {
    const route = routeToolsForTurn(
      '读取 ChatGPT 里的聊天历史，并同步新增消息',
      DECLARATIONS,
    );

    expect(route.categories).toContain('external_control');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'external_ai_history_query',
      'external_ai_history_status',
      'external_ai_history_sync',
      'external_ai_history_source_list',
    ]));
    expect(route.toolNames).not.toContain('external_ai_collaborate');
    expect(route.toolNames).not.toContain('desktop_ai_ask');
    expect(route.forbiddenToolNames).toEqual(expect.arrayContaining([
      'external_ai_collaborate',
      'desktop_ai_ask',
      'desktop_ai_roundtable',
    ]));
  });

  it('routes spoken bid and asset-tracing requests through legal tools', () => {
    const bidRoute = routeToolsForTurn('根据招标要求 PDF 自动生成标书框架', DECLARATIONS);
    const assetRoute = routeToolsForTurn('语音记录一下，查被执行人公司情况和股权穿透', DECLARATIONS);

    expect(bidRoute.categories).toContain('legal');
    expect(bidRoute.toolNames).toContain('legal_generate_bid');
    expect(bidRoute.toolNames).toContain('read_pdf');
    expect(bidRoute.toolNames.indexOf('legal_generate_bid')).toBeLessThan(bidRoute.toolNames.indexOf('legal_generate_litigation_packet'));

    expect(assetRoute.categories).toContain('legal');
    expect(assetRoute.toolNames).toEqual(expect.arrayContaining([
      'legal_trace_assets',
      'legal_equity_penetration',
      'legal_company_database_lookup',
    ]));
    expect(assetRoute.toolNames.indexOf('legal_trace_assets')).toBeLessThan(assetRoute.toolNames.indexOf('legal_generate_argument_or_opinion'));
    expect(assetRoute.toolNames.indexOf('legal_equity_penetration')).toBeLessThan(assetRoute.toolNames.indexOf('legal_generate_argument_or_opinion'));
  });

  it('routes music requests away from legal tools', () => {
    const route = routeToolsForTurn('帮我放一首网易云的歌', DECLARATIONS);

    expect(route.categories).toContain('music');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'desktop_list_apps',
      'desktop_open',
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_keyboard_press',
    ]));
    expect(route.toolNames).not.toContain('mcp_neteasemusic_search_song');
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

  it('prioritizes the dedicated send tool for a foreground WeChat inquiry', () => {
    const route = routeToolsForTurn(
      '你打开微信问一下阿露在干嘛。',
      DECLARATIONS,
      { maxTools: 8 },
    );

    expect(route.categories).toContain('messaging');
    expect(route.toolNames[0]).toBe('wechat_send_message');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'desktop_open',
      'desktop_active_window',
    ]));
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

  it('keeps negated messaging language in a desktop AI inspection out of messaging and legal routes', () => {
    const route = routeToolsForTurn(
      'Read-only live acceptance test. Inspect running desktop AI applications and report detected evidence only. Do not open apps, click, type, or send messages.',
      DECLARATIONS,
    );

    expect(route.categories).not.toContain('messaging');
    expect(route.categories).not.toContain('legal');
    expect(route.categories).not.toContain('code_git');
    expect(route.categories).not.toContain('documents');
    expect(route.toolNames.slice(0, 6)).toContain('desktop_ai_list_targets');
    expect(route.toolNames.slice(0, 6)).not.toContain('wechat_send_message');
    expect(route.toolNames).not.toContain('code_execution');
    expect(route.toolNames).not.toContain('create_docx');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'desktop_running_processes',
      'desktop_list_apps',
    ]));
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
      'read_file',
      'extract_document_text',
      'ocr_image_file',
    ]));
    expect(route.toolNames).not.toContain('mcp_neteasemusic_search_song');
  });

  it('does not expose document extraction for direct AutoCAD operations playback', () => {
    const route = routeToolsForTurn(
      'Run and verify C:\\cad\\plan_operations.json through AutoCAD MCP playback.',
      DECLARATIONS,
    );

    expect(route.categories).toContain('cad_design');
    expect(route.toolNames).toContain('mcp_cad-drafting_autocad_playback_file');
    expect(route.toolNames).not.toContain('extract_document_text');
    expect(route.toolNames).not.toContain('read_pdf');
  });

  it('exposes only the operations-to-MCP path for visible AutoCAD playback', () => {
    const route = routeToolsForTurn(
      'Draw visibly in AutoCAD stroke by stroke. Use AutoCAD MCP only and do not use LISP, scripts, generated files, or fallback.',
      DECLARATIONS,
    );

    expect(route.categories).toContain('cad_design');
    expect(route.toolNames).toContain('cad_prepare_autocad_operations');
    expect(route.toolNames).toContain('mcp_cad-drafting_autocad_playback_file');
    expect(route.toolNames).not.toContain('cad_generate_dxf');
    expect(route.toolNames).not.toContain('mcp_cad-drafting_cad_renovation_folder_workflow');
    expect(route.reasons).toContain('visible AutoCAD execution requires MCP/COM playback and excludes generated-file or script fallback');
  });

  it('keeps attachment metadata out of messaging routes for a current CAD task', () => {
    const route = routeToolsForTurn([
      '把这幅图画成cad图',
      '## Current Turn Attachments',
      'The user attached these files to the current message. Treat them as part of the user request.',
      'Local path: C:\\Users\\me\\LumiCore\\data\\knowledge\\plan.jpg',
    ].join('\n\n'), DECLARATIONS);

    expect(route.categories).toContain('cad_design');
    expect(route.categories).not.toContain('messaging');
    expect(route.toolNames).toContain('cad_draw_floorplan_in_autocad');
    expect(route.toolNames).not.toContain('cad_prepare_autocad_operations');
    expect(route.toolNames).not.toContain('mcp_cad-drafting_autocad_playback_file');
    expect(route.toolNames).not.toContain('cad_generate_dxf');
    expect(route.toolNames).not.toContain('wechat_send_message');
  });

  it('routes local desktop CAD folders through source discovery before drafting', () => {
    const route = routeToolsForTurn(
      '\u684c\u9762\u4e0a\u6709\u4e2a\u300c\u963f\u9646\u300d\u6587\u4ef6\u5939\uff0c\u8bf7\u5148\u8bfb\u53d6\u5e76\u6574\u7406\u91cc\u9762\u7684\u6587\u4ef6\u5185\u5bb9\uff0c\u7136\u540e\u6839\u636e\u91cc\u9762\u7684\u4fe1\u606f\u751f\u6210 CAD \u56fe\u7eb8\u65b9\u6848\uff0c\u5e76\u5728 AutoCAD \u91cc\u5b9e\u9645\u753b\u51fa\u6765',
      DECLARATIONS,
    );

    expect(route.categories).toContain('cad_design');
    expect(route.toolNames.slice(0, 10)).toEqual(expect.arrayContaining([
      'desktop_path_info',
      'desktop_list_files',
      'desktop_list_apps',
      'floorplan_extract_geometry',
      'cad_prepare_autocad_operations',
      'mcp_cad-drafting_autocad_playback_file',
    ]));
    expect(route.toolNames).not.toContain('cad_generate_dxf');
    expect(route.toolNames).not.toContain('mcp_cad-drafting_cad_renovation_folder_workflow');
    expect(route.toolNames.indexOf('desktop_list_files')).toBeLessThan(route.toolNames.indexOf('cad_prepare_autocad_operations'));
    expect(route.toolNames.indexOf('desktop_list_apps')).toBeLessThan(route.toolNames.indexOf('cad_prepare_autocad_operations'));
    expect(route.toolNames.indexOf('floorplan_extract_geometry')).toBeLessThan(route.toolNames.indexOf('cad_prepare_autocad_operations'));
    expect(route.toolNames.indexOf('cad_prepare_autocad_operations')).toBeLessThan(route.toolNames.indexOf('mcp_cad-drafting_autocad_playback_file'));
  });

  it('routes a desktop image-to-AutoCAD request through one verified CAD skill without exposing its low-level stages', () => {
    const route = routeToolsForTurn(
      '桌面上有一张叫设计草稿.jpg的图片，把它画到 AutoCAD 里。',
      DECLARATIONS,
    );

    expect(route.categories).toContain('cad_design');
    expect(route.toolNames).toEqual(['cad_draw_floorplan_in_autocad']);
    expect(route.hardAllowlist).toBe(true);
    expect(route.maxIterations).toBe(2);
    for (const forbidden of [
      'desktop_list_files',
      'desktop_path_info',
      'floorplan_extract_geometry',
      'ocr_image_file',
      'cad_prepare_autocad_operations',
      'mcp_cad-drafting_autocad_playback_file',
      'mcp_filesystem_read_media_file',
      'read_file',
      'run_command',
      'desktop_run_command',
      'code_execution',
      'python_exec',
    ]) {
      expect(route.toolNames).not.toContain(forbidden);
    }
    expect(route.reasons.join(' ')).toContain('one composite CAD skill owns');
  });

  it('hard-limits extraction-only desktop images to geometry read and observation tools', () => {
    const route = routeToolsForTurn(
      '读取桌面上的设计草稿.jpg，提取几何信息，先不要绘制，只告诉我提取是否成功。',
      DECLARATIONS,
      { enableMcpHealthGate: false },
    );
    const expectedAllowed = [
      'desktop_list_files',
      'desktop_path_info',
      'desktop_system_info',
      'floorplan_extract_geometry',
      'ocr_image_file',
      'desktop_capture_screen',
      'ocr_screen',
    ];
    const forbidden = [
      'cad_generate_dxf',
      'cad_prepare_autocad_operations',
      'mcp_cad-drafting_autocad_playback_file',
      'mcp_cad-drafting_cad_renovation_folder_workflow',
      'write_file',
      'create_docx',
      'create_pdf',
      'create_ppt',
      'mcp_filesystem_read_media_file',
      'mcp_filesystem_read_file',
      'run_command',
      'desktop_run_command',
      'code_execution',
      'python_exec',
      'powershell',
      'shell_exec',
      'terminal_exec',
    ];

    expect(route.hardAllowlist).toBe(true);
    expect(new Set(route.toolNames)).toEqual(new Set(expectedAllowed));
    expect(route.reasons.join(' ')).toContain('hard read/observe allowlist');
    expect(route.forbiddenToolNames).toEqual(expect.arrayContaining(forbidden));

    const policy = mergeToolPolicyWithRoute({
      allowedTools: ['*'],
      requireConfirmation: [],
      forbiddenTools: [],
      maxIterations: 80,
    }, route);
    expect(new Set(policy.allowedTools)).toEqual(new Set(expectedAllowed));
    expect(policy.forbiddenTools).toEqual(expect.arrayContaining(forbidden));
    for (const name of forbidden) {
      expect(policy.allowedTools).not.toContain(name);
    }
  });

  it('continues inside the recovered WPS app with UI controls and does not enter task center', () => {
    const route = routeToolsForTurn([
      '在这里面写“我好想你”。',
      '',
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- followupIntent: execute',
      '- originalGoal: 打开 WPS。',
      '- appTarget: WPS',
      '- unfinished: no',
      'Recent tool evidence:',
      '- desktop_open | status=opened',
    ].join('\n'), DECLARATIONS);

    expect(route.categories).toContain('external_control');
    expect(route.categories).not.toContain('work_takeover');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_ui_focus',
      'desktop_ui_type',
    ]));
    expect(route.toolNames).not.toContain('work_takeover_task_continue');
  });

  it('treats regression-test wording as WPS text payload instead of code or capability work', () => {
    const route = routeToolsForTurn([
      '在这里面新建一个空白文档并写入：Lumi端到端回归测试。',
      '',
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- followupIntent: execute',
      '- originalGoal: 打开WPS。',
      '- appTarget: WPS',
      '- unfinished: no',
      'Recent tool evidence:',
      '- desktop_open | status=opened',
    ].join('\n'), DECLARATIONS);

    expect(route.categories).toEqual(['external_control']);
    expect(route.toolNames.slice(0, 6)).toEqual([
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_ui_focus',
      'desktop_ui_invoke',
      'desktop_ui_click',
      'desktop_ui_type',
    ]);
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'desktop_capture_screen',
      'desktop_open',
    ]));
    for (const forbidden of [
      'work_product_plan',
      'work_product_verify',
      'write_file',
      'create_docx',
      'git_status',
      'git_commit',
      'list_skills',
      'capability_learning_list',
      'self_extension_plan',
      'capability_gap_autofix',
      'work_takeover_task_continue',
      'computer_use',
      'mouse_move',
      'mouse_click',
      'mouse_drag',
      'keyboard_type',
    ]) {
      expect(route.toolNames).not.toContain(forbidden);
    }
  });

  it('routes court website login searches through saved web login profiles before browser clicks', () => {
    const route = routeToolsForTurn(
      '\u6253\u5f00\u4e2d\u56fd\u88c1\u5224\u6587\u4e66\u7f51\uff0c\u81ea\u52a8\u767b\u5f55\u8d26\u53f7\u627e\u4e00\u4e0b\u6d59\u6c5f\u7701\u7684\u6848\u4ef6',
      DECLARATIONS,
    );

    expect(route.categories).toEqual(expect.arrayContaining(['legal', 'authenticated_web']));
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'web_login_profile_list',
      'web_login_profile_save_from_preset',
      'web_login_run',
      'mcp_playwright_browser_navigate',
    ]));
    expect(route.toolNames.indexOf('web_login_profile_list')).toBeLessThan(route.toolNames.indexOf('web_login_run'));
    expect(route.toolNames.indexOf('web_login_profile_save_from_preset')).toBeLessThan(route.toolNames.indexOf('web_login_run'));
    expect(route.toolNames.indexOf('web_login_run')).toBeLessThan(route.toolNames.indexOf('mcp_playwright_browser_navigate'));
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
      'self_extension_plan',
      'capability_learning_list',
    ]));
  });

  it('routes customer operations to real sales tools instead of a fixed takeover script', () => {
    const route = routeToolsForTurn('Analyze this customer lead and prepare the next sales follow-up.', DECLARATIONS);

    expect(route.categories).toContain('customer_operations');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'mcp_sales-customer-ops_lead_score',
      'mcp_sales-customer-ops_sales_followup_draft',
    ]));
    expect(route.toolNames).not.toContain('work_takeover_real_smoke_run');
  });

  it('routes ecommerce work to data, content, media, and authenticated platform tools', () => {
    const route = routeToolsForTurn('Analyze this ecommerce campaign and create a short video for the store.', DECLARATIONS);

    expect(route.categories).toContain('ecommerce_operations');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'mcp_ecommerce-ops_campaign_roi_analyzer',
      'mcp_content-ops_short_video_script',
      'generate_video',
    ]));
  });

  it('routes sleep and dream requests to Lumi memory consolidation tools', () => {
    const route = routeToolsForTurn(
      '让 Lumi 现在做梦休息一下，整理最近的记忆，降低混乱，但不要改核心人格',
      DECLARATIONS,
    );

    expect(route.categories).toContain('sleep_dream');
    expect(route.toolNames.slice(0, 4)).toEqual(expect.arrayContaining([
      'lumi_sleep_status',
      'lumi_sleep_cycle',
    ]));
    expect(route.toolNames).not.toContain('legal_search_case');
    expect(route.toolNames).not.toContain('wechat_send_message');
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
