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
  'desktop_ui_snapshot',
  'desktop_ui_focus',
  'desktop_ui_click',
  'desktop_ui_invoke',
  'desktop_ui_type',
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
  'legal_external_research_plan',
  'legal_verify_citation',
  'legal_import_judgment',
  'authority_research',
  'authority_research_save',
  'mcp_legal-casework_legal_case_folder_workflow',
  'mcp_legal-casework_legal_document_outline',
  'mcp_neteasemusic_search_song',
  'mcp_cad-drafting_cad_space_program',
  'mcp_cad-drafting_cad_renovation_folder_workflow',
  'cad_generate_dxf',
  'generate_image',
  'git_status',
  'git_commit',
  'list_skills',
  'generate_skill',
  'adapter_registry_list',
  'client_get_state',
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

  it('routes skill questions to skill management tools', () => {
    const route = routeToolsForTurn('这些技能 Lumi 会调用吗，帮我看看技能大厅和 MCP', DECLARATIONS);

    expect(route.categories).toContain('skills_agents');
    expect(route.toolNames).toEqual(expect.arrayContaining([
      'list_skills',
      'generate_skill',
      'client_get_state',
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
