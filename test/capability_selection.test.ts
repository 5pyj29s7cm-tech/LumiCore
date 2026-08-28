import './helpers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const declarations = [
  'client_get_state',
  'client_action',
  'client_health_check',
  'client_self_repair',
  'desktop_active_window',
  'desktop_running_processes',
  'desktop_idle_time',
  'desktop_poll_activity',
  'desktop_list_files',
  'desktop_list_apps',
  'desktop_open',
  'desktop_path_info',
  'desktop_ui_snapshot',
  'desktop_ui_focus',
  'desktop_ui_click',
  'desktop_ui_type',
  'desktop_ui_invoke',
  'desktop_capture_screen',
  'desktop_ai_list_targets',
  'desktop_ai_discovery_plan',
  'desktop_ai_register_target',
  'desktop_ai_ask',
  'desktop_ai_collect_answer',
  'external_ai_history_source_register',
  'external_ai_history_source_list',
  'external_ai_history_source_revoke',
  'external_ai_history_sync',
  'external_ai_history_status',
  'external_ai_history_query',
  'desktop_mouse_click_at',
  'desktop_cursor_glow_show',
  'desktop_cursor_glow_update',
  'desktop_cursor_glow_click',
  'desktop_cursor_glow_hide',
  'desktop_keyboard_press',
  'desktop_show_lumi_window',
  'desktop_run_command',
  'read_clipboard',
  'write_clipboard',
  'mouse_move',
  'mouse_click',
  'mouse_drag',
  'keyboard_type',
  'keyboard_press',
  'computer_use',
  'work_product_plan',
  'work_product_verify',
  'work_takeover_task_get',
  'work_takeover_task_continue',
  'work_takeover_task_advance',
  'work_takeover_task_autorun',
  'work_takeover_task_verify_result',
  'work_takeover_task_export_packet',
  'capability_learning_list',
  'self_extension_plan',
  'capability_gap_autofix',
  'list_skills',
  'adapter_registry_list',
  'external_app_list_adapters',
  'create_docx',
  'create_ppt',
  'create_pdf',
  'write_file',
  'web_search',
  'url_fetch_logged_in',
  'web_login_profile_list',
  'web_login_profile_save_from_preset',
  'web_login_run',
  'browser_open_task',
  'mcp_playwright_browser_snapshot',
  'floorplan_extract_geometry',
  'cad_generate_dxf',
  'cad_prepare_autocad_operations',
  'mcp_cad-drafting_autocad_playback_file',
  'mcp_cad-drafting_cad_renovation_folder_workflow',
  'ocr_screen',
  'wechat_read_recent_chat',
  'wechat_send_message',
  'wechat_prepare_reply',
  'wechat_copy_reply_draft',
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
  'legal_external_research_plan',
  'legal_search_external_authorities',
  'legal_company_database_lookup',
  'legal_generate_citation_verification_report',
  'legal_finalize_delivery_package',
  'legal_prepare_external_browser_workspace',
  'read_docx',
  'read_pdf',
].map(name => ({
  type: 'function' as const,
  function: {
    name,
    description: name.replace(/_/g, ' '),
    parameters: { type: 'object', properties: {} },
  },
}));

async function selectCapability(input: {
  userId: string;
  text: string;
  channel?: 'chat' | 'voice' | 'task';
  source?: string;
  category?: string;
  domain?: string;
  orgId?: string;
  operationMode?: string;
  targetIsLumi?: boolean;
  continuationContext?: string;
}) {
  const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
  const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
  const { buildLumiCapabilitySelection } = await import('../server/cognition/capability_selection');

  const dispatch = buildLumiTurnDispatch({
    channel: input.channel || 'chat',
    source: input.source || input.channel || 'chat',
    operationMode: input.operationMode || 'chat',
    targetIsLumi: input.targetIsLumi ?? true,
    ...input,
  });
  const execution = buildLumiExecutionDecision({
    flow: dispatch.flow,
    text: input.continuationContext ? dispatch.flow.routeText : input.text,
    toolDeclarations: declarations,
  });
  const selection = buildLumiCapabilitySelection({
    dispatch,
    execution,
    text: input.continuationContext ? dispatch.flow.routeText : input.text,
  });

  return { dispatch, execution, selection };
}

describe('Lumi capability selection', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('keeps ordinary chat on the conversation lane', async () => {
    const { selection } = await selectCapability({
      userId: 'capability_selection_chat_user',
      text: 'just talk with me for a minute',
      operationMode: 'chat',
    });

    expect(selection.lane).toBe('conversation');
    expect(selection.preferredTools).toEqual([]);
    expect(selection.promptOverlay).toContain('Suggested lane: conversation');
  });

  it('selects capability learning before treating Lumi improvement as generic tools', async () => {
    const { selection, dispatch } = await selectCapability({
      userId: 'capability_selection_learning_user',
      text: 'Lumi, stabilize the existing desktop capability, check duplicate hard-coded scripts, and make it reusable.',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(dispatch.flow.executionGovernance.capabilityLearningIntent).toBe('inspect_reuse');
    expect(dispatch.flow.selfRepairTurn).toBe(false);
    expect(selection.lane).toBe('capability_learning');
    expect(selection.preferredTools).toContain('capability_learning_list');
    expect(selection.promptOverlay).toContain('Do not hard-code an industry demo into Lumi core');
  });

  it('keeps chat workflow matches advisory, including explicit demos', async () => {
    const { dispatch, selection } = await selectCapability({
      userId: 'capability_selection_skill_user',
      text: 'Lumi, introduce yourself',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(dispatch.boundary).toBe('conversation');
    expect(selection.lane).toBe('conversation');

    const demo = await selectCapability({
      userId: 'capability_selection_skill_user',
      text: 'Lumi, show me a visible demo of yourself',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    expect(demo.dispatch.boundary).not.toBe('skill_workflow');
    expect(demo.dispatch.flow.specialWorkflow).toBeNull();
    expect(demo.dispatch.flow.workflowHint?.id).toBe('self_intro_demo');
    expect(demo.dispatch.flow.workflowRouting).toBe('model_hint');
    expect(demo.selection.lane).toBe('skill_workflow');
    expect(demo.selection.primary).toContain('self_intro_demo');
    expect(demo.selection.promptOverlay).toContain('model owns the final respond-versus-act decision');
  });

  it('treats task center turns as persistent task work', async () => {
    const { dispatch, selection } = await selectCapability({
      userId: 'capability_selection_task_user',
      text: 'create a customer delivery package and verify the result',
      channel: 'task',
      source: 'task',
      operationMode: 'chat',
    });

    expect(dispatch.boundary).toBe('task_center');
    expect(selection.lane).toBe('task_center');
    expect(selection.promptOverlay).toContain('persistent work');
  });

  it('continues active work takeover state instead of starting from scratch', async () => {
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    createWorkTakeoverTask({
      userId: 'capability_selection_takeover_user',
      category: 'customer',
      title: 'Follow up customer WeChat task',
      nextActions: ['Prepare reply draft'],
      source: 'wechat',
      status: 'in_progress',
    });

    const { dispatch, selection } = await selectCapability({
      userId: 'capability_selection_takeover_user',
      text: 'continue the customer task',
      domain: 'work',
      orgId: 'org-capability',
      operationMode: 'chat',
    });

    expect(dispatch.boundary).toBe('work_takeover');
    expect(selection.lane).toBe('work_takeover');
    expect(selection.primary).toBe(dispatch.flow.workTakeover.latestTask?.id);
  });

  it('separates CAD/design from generic document artifacts', async () => {
    const { selection } = await selectCapability({
      userId: 'capability_selection_cad_user',
      text: 'generate a CAD DXF floor plan from this sketch',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('design_cad');
    expect(selection.preferredTools).toContain('cad_generate_dxf');
  });

  it('keeps local AutoCAD folder work on reusable CAD routing instead of the delivery demo', async () => {
    const { dispatch, selection, execution } = await selectCapability({
      userId: 'capability_selection_cad_folder_user',
      text: '\u684c\u9762\u4e0a\u6709\u4e2a\u300c\u963f\u9646\u300d\u6587\u4ef6\u5939\uff0c\u8bf7\u5148\u8bfb\u53d6\u5e76\u6574\u7406\u91cc\u9762\u7684\u6587\u4ef6\u5185\u5bb9\uff0c\u7136\u540e\u6839\u636e\u91cc\u9762\u7684\u4fe1\u606f\u751f\u6210 CAD \u56fe\u7eb8\u65b9\u6848\uff0c\u5e76\u5728 AutoCAD \u91cc\u5b9e\u9645\u753b\u51fa\u6765',
      operationMode: 'assistant',
    });

    expect(dispatch.boundary).toBe('tool_action');
    expect(dispatch.flow.specialWorkflow).toBeNull();
    expect(dispatch.flow.workSurfaceRoute.artifactFirst).toBe(true);
    expect(dispatch.flow.workSurfaceRoute.directDesktop).toBe(true);
    expect(selection.lane).toBe('design_cad');
    expect(selection.promptOverlay).toContain('Use cad_draw_floorplan_in_autocad as the single resumable owner');
    expect(selection.preferredTools).toEqual(expect.arrayContaining([
      'cad_draw_floorplan_in_autocad',
      'desktop_path_info',
      'desktop_list_files',
      'desktop_list_apps',
      'floorplan_extract_geometry',
      'cad_prepare_autocad_operations',
      'mcp_cad-drafting_autocad_playback_file',
    ]));
    expect(selection.preferredTools).not.toContain('cad_generate_dxf');
    expect(execution.toolRoute?.toolNames.indexOf('desktop_list_files')).toBeLessThan(
      execution.toolRoute?.toolNames.indexOf('cad_prepare_autocad_operations') ?? Number.MAX_SAFE_INTEGER,
    );
    expect(execution.toolRoute?.toolNames.indexOf('desktop_list_apps')).toBeLessThan(
      execution.toolRoute?.toolNames.indexOf('cad_prepare_autocad_operations') ?? Number.MAX_SAFE_INTEGER,
    );
    expect(execution.toolRoute?.toolNames.indexOf('cad_prepare_autocad_operations')).toBeLessThan(
      execution.toolRoute?.toolNames.indexOf('mcp_cad-drafting_autocad_playback_file') ?? Number.MAX_SAFE_INTEGER,
    );
    expect(execution.toolRoute?.toolNames).not.toContain('cad_generate_dxf');
  });

  it('keeps explicit AutoCAD playback acceptance work out of the design delivery demo', async () => {
    const { dispatch, selection } = await selectCapability({
      userId: 'capability_selection_autocad_acceptance_user',
      text: 'Live AutoCAD acceptance test. Prepare operations for a 4000 by 3000 room, then draw visibly through AutoCAD MCP/COM and require the completion marker.',
      operationMode: 'assistant',
    });

    expect(dispatch.flow.specialWorkflow).toBeNull();
    expect(dispatch.flow.workSurfaceRoute.directDesktop).toBe(true);
    expect(selection.lane).toBe('design_cad');
    expect(selection.preferredTools).toEqual(expect.arrayContaining([
      'cad_prepare_autocad_operations',
      'mcp_cad-drafting_autocad_playback_file',
    ]));
    expect(selection.preferredTools).not.toContain('cad_generate_dxf');
  });

  it('keeps explicit AutoCAD MCP-only playback out of the script fallback lane', async () => {
    const { selection, execution } = await selectCapability({
      userId: 'capability_selection_autocad_mcp_only_user',
      text: 'Draw visibly in AutoCAD stroke by stroke. Use AutoCAD MCP only; do not use LISP, scripts, generated files, or fallback.',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('design_cad');
    expect(selection.preferredTools).toContain('cad_prepare_autocad_operations');
    expect(selection.preferredTools).toContain('mcp_cad-drafting_autocad_playback_file');
    expect(selection.preferredTools).not.toContain('cad_generate_dxf');
    expect(selection.promptOverlay).toContain('Never substitute DXF/DWG generation');
    expect(execution.toolRoute?.toolNames).not.toContain('cad_generate_dxf');
  });

  it('selects artifact work for reports and local files', async () => {
    const { selection } = await selectCapability({
      userId: 'capability_selection_artifact_user',
      text: 'create a PPT report and export a PDF',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('artifact_work');
    expect(selection.preferredTools).toContain('create_ppt');
  });

  it('keeps court website login/search work on the browser account lane', async () => {
    const { selection, execution } = await selectCapability({
      userId: 'capability_selection_court_login_user',
      text: '\u6253\u5f00\u4e2d\u56fd\u88c1\u5224\u6587\u4e66\u7f51\uff0c\u81ea\u52a8\u767b\u5f55\u8d26\u53f7\u627e\u4e00\u4e0b\u6d59\u6c5f\u7701\u7684\u6848\u4ef6',
      operationMode: 'autonomous',
    });

    expect(selection.lane).toBe('web_or_account');
    expect(selection.primary).toContain('browser/account');
    expect(selection.preferredTools.slice(0, 8)).toEqual(expect.arrayContaining([
      'web_login_profile_list',
      'web_login_profile_save_from_preset',
      'web_login_run',
      'mcp_playwright_browser_snapshot',
    ]));
    expect(selection.promptOverlay).toContain('First inspect saved login profiles');
    expect(execution.toolRoute?.categories).toEqual(expect.arrayContaining(['legal', 'authenticated_web']));
  });

  it('selects desktop control for visible external software operation', async () => {
    const { selection } = await selectCapability({
      userId: 'capability_selection_desktop_user',
      text: 'open AutoCAD and operate the desktop with mouse to draw a floor plan',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('desktop_control');
    expect(selection.preferredTools).toContain('desktop_ui_snapshot');
    expect(selection.preferredTools).toContain('mouse_drag');
    expect(selection.preferredTools).toContain('keyboard_press');
    expect(selection.preferredTools).toContain('computer_use');
  });

  it('forces a recovered WPS editing continuation onto the desktop-control lane', async () => {
    const text = '在这里面新建一个空白文档并写入：Lumi端到端回归测试。';
    const continuationContext = [
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- followupIntent: execute',
      '- originalGoal: 打开WPS。',
      '- appTarget: WPS',
      '- unfinished: no',
      'Recent tool evidence:',
      '- desktop_open | status=opened',
    ].join('\n');
    const { dispatch, execution, selection } = await selectCapability({
      userId: 'capability_selection_wps_exact_replay_user',
      text,
      continuationContext,
      operationMode: 'assistant',
    });

    expect(dispatch.flow.workSurfaceRoute.directDesktop).toBe(true);
    expect(dispatch.flow.workSurfaceRoute.artifactFirst).toBe(false);
    expect(dispatch.flow.executionGovernance.capabilityLearningIntent).toBe('none');
    expect(selection.lane).toBe('desktop_control');
    expect(selection.primary).toContain('WPS');
    expect(selection.preferredTools.slice(0, 6)).toEqual(expect.arrayContaining([
      'wps_create_document_with_text',
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_ui_focus',
    ]));
    expect(selection.preferredTools).toContain('desktop_ui_type');
    for (const forbiddenCategory of [
      'code_git',
      'capability_learning',
      'artifact_work',
      'documents',
    ]) {
      expect(execution.toolRoute?.categories).not.toContain(forbiddenCategory);
    }
    expect(selection.preferredTools).not.toEqual(expect.arrayContaining([
      'write_file',
      'create_docx',
      'capability_learning_list',
      'self_extension_plan',
      'work_takeover_task_continue',
    ]));
    expect(selection.preferredTools).not.toContain('computer_use');
    expect(selection.preferredTools).not.toContain('mouse_click');
    expect(selection.preferredTools).not.toContain('keyboard_type');
    expect(selection.promptOverlay).toContain('Use wps_create_document_with_text as the single resumable owner');
    expect(selection.promptOverlay).toContain('do not start a parallel manual New/Blank/type sequence');
  });

  it('selects one bounded desktop AI target as a LumiCore tool', async () => {
    const { selection, execution } = await selectCapability({
      userId: 'capability_selection_desktop_ai_user',
      text: '把这个问题发给 ChatGPT，再把它的回答拿回来',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('external_tool');
    expect(selection.preferredTools.slice(0, 6)).toEqual(expect.arrayContaining([
      'desktop_ai_ask',
      'desktop_ai_collect_answer',
      'desktop_ai_list_targets',
    ]));
    expect(execution.toolRoute?.toolNames.indexOf('desktop_ai_ask')).toBeLessThan(
      execution.toolRoute?.toolNames.indexOf('computer_use') ?? Number.POSITIVE_INFINITY,
    );
  });

  it('keeps chat, voice, and task on the same single-target external-AI tools', async () => {
    const text = 'Ask ChatGPT for an answer, then collect the visible result.';
    const routes = await Promise.all((['chat', 'voice', 'task'] as const).map(async channel => {
      const { execution } = await selectCapability({
        userId: `capability_selection_external_ai_${channel}`,
        text,
        channel,
        operationMode: 'assistant',
      });
      return (execution.toolRoute?.toolNames || []).filter(name => /^desktop_ai_(?:ask|collect_answer)$/.test(name));
    }));

    for (const route of routes) {
      expect(route).toEqual(expect.arrayContaining([
        'desktop_ai_ask',
        'desktop_ai_collect_answer',
      ]));
    }
  });

  it('keeps external AI history on read-only authorization tools instead of collaboration submission', async () => {
    const { selection, execution } = await selectCapability({
      userId: 'capability_selection_external_ai_history',
      text: '查看 ChatGPT 的聊天历史并同步最新内容',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('external_tool');
    expect(selection.primary).toMatch(/authorized external AI history/i);
    expect(selection.preferredTools).toEqual(expect.arrayContaining([
      'external_ai_history_query',
      'external_ai_history_sync',
      'external_ai_history_status',
    ]));
    expect(selection.preferredTools).not.toContain('desktop_ai_ask');
    expect(execution.toolRoute?.forbiddenToolNames).toContain('desktop_ai_ask');
    expect(selection.promptOverlay).toContain('Never submit a new prompt');
  });

  it('keeps chat, voice, and task external-AI history routes identical and read-only', async () => {
    const text = '读取 ChatGPT 的聊天历史并同步新增消息';
    const routes = await Promise.all((['chat', 'voice', 'task'] as const).map(async channel => {
      const { execution } = await selectCapability({
        userId: `capability_selection_external_ai_history_${channel}`,
        text,
        channel,
        operationMode: 'assistant',
      });
      return {
        tools: (execution.toolRoute?.toolNames || []).filter(name => name.startsWith('external_ai_')),
        forbidden: (execution.toolRoute?.forbiddenToolNames || []).filter(name => (
          name.startsWith('external_ai_') || /^desktop_ai_(?:ask|collect_answer)$/.test(name)
        )),
      };
    }));

    expect(routes[1]).toEqual(routes[0]);
    expect(routes[2]).toEqual(routes[0]);
    expect(routes[0].tools).toEqual(expect.arrayContaining([
      'external_ai_history_query',
      'external_ai_history_sync',
      'external_ai_history_status',
      'external_ai_history_source_list',
    ]));
    expect(routes[0].tools).not.toContain('desktop_ai_ask');
    expect(routes[0].forbidden).toContain('desktop_ai_ask');
  });

  it('selects browser/account work for saved-login dashboards', async () => {
    const { selection } = await selectCapability({
      userId: 'capability_selection_web_user',
      text: 'log in to the seller center dashboard with the saved account',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('web_or_account');
    expect(selection.preferredTools).toContain('web_login_run');
  });

  it('selects messaging for WeChat replies', async () => {
    const { selection } = await selectCapability({
      userId: 'capability_selection_wechat_user',
      text: 'prepare a WeChat reply draft for this customer',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('messaging');
    expect(selection.preferredTools).toContain('wechat_prepare_reply');
  });

  it('routes remote legal bot materials to unified legal casework before generic messaging', async () => {
    const { selection, execution } = await selectCapability({
      userId: 'capability_selection_remote_legal_user',
      text: '\u5fae\u4fe1/\u98de\u4e66\u53d1\u7ed9 Lumi bot \u7684\u6cd5\u9662\u77ed\u4fe1\u94fe\u63a5\u548c\u6848\u4ef6\u6750\u6599\uff0c\u81ea\u52a8\u5165\u6848\u5e76\u6574\u7406\u4e0b\u4e00\u6b65',
      source: 'feishu-bot',
      domain: 'work',
      orgId: 'org-legal-capability',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('legal_casework');
    expect(selection.preferredTools).toContain('legal_message_intake_to_case');
    expect(selection.preferredTools).toContain('legal_case_reasoning_matrix');
    expect(selection.promptOverlay).toContain('unified legal casework path');
    expect(execution.promptOverlay).toContain('Unified Legal Casework Entry');
    expect(execution.promptOverlay).toContain('organization case workspace');
    expect(execution.toolRoute?.categories).toEqual(expect.arrayContaining(['legal', 'messaging']));
  });

  it('keeps personal legal chat on legal casework without claiming organization persistence', async () => {
    const { selection, execution } = await selectCapability({
      userId: 'capability_selection_personal_legal_user',
      text: '\u5e2e\u6211\u6309\u4e09\u6bb5\u8bba\u5206\u6790\u8fd9\u4e2a\u5408\u540c\u7ea0\u7eb7\uff0c\u987a\u4fbf\u8d77\u8349\u4ee3\u7406\u8bcd',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('legal_casework');
    expect(selection.preferredTools).toContain('legal_case_workspace');
    expect(selection.preferredTools).toContain('legal_generate_citation_verification_report');
    expect(execution.promptOverlay).toContain('legal work in the personal workspace');
    expect(execution.promptOverlay).toContain('Current-law gate');
  });

  it('routes voice legal work through the same legal casework lane', async () => {
    const { selection, execution } = await selectCapability({
      userId: 'capability_selection_voice_legal_user',
      text: '\u8bed\u97f3\u4f1a\u8bae\u8bb0\u5f55\uff1a\u6839\u636e\u8fd9\u4e2a\u6848\u5b50\u751f\u6210\u7b54\u8fa9\u72b6\u548c\u8d28\u8bc1\u610f\u89c1',
      channel: 'voice',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('legal_casework');
    expect(selection.preferredTools).toContain('legal_meeting_minutes_to_case');
    expect(selection.preferredTools).toContain('legal_generate_litigation_packet');
    expect(execution.promptOverlay).toContain('major premise');
  });

  it('selects foreground WeChat sending with the virtual cursor path', async () => {
    const { selection, execution } = await selectCapability({
      userId: 'capability_selection_wechat_send_user',
      text: '\u5fae\u4fe1\u76f4\u63a5\u53d1\u665a\u5b89\u7ed9\u963f\u9646',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('messaging');
    expect(execution.toolRoute?.toolNames).toContain('wechat_send_message');
    expect(selection.preferredTools).toEqual(expect.arrayContaining([
      'wechat_send_message',
      'desktop_mouse_click_at',
      'desktop_cursor_glow_show',
    ]));
  });

  it('selects foreground WeChat chat reading as a separate messaging action', async () => {
    const { selection, execution } = await selectCapability({
      userId: 'capability_selection_wechat_read_user',
      text: '\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('messaging');
    expect(execution.toolRoute?.toolNames).toContain('wechat_read_recent_chat');
    expect(execution.toolRoute?.toolNames.slice(0, 4)).not.toContain('wechat_send_message');
    expect(selection.preferredTools).toContain('wechat_read_recent_chat');
  });

  it('keeps chat, voice, and task sockets on the shared capability selection path', () => {
    const root = process.cwd();
    const sources = [
      readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8'),
      readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8'),
      readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8'),
    ];

    for (const source of sources) {
      expect(source).toContain('buildLumiExecutionPipeline');
      expect(source).toContain('agent:capability_selection');
    }
  });
});
