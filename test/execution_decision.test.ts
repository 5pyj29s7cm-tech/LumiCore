import './helpers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const declarations = [
  'client_get_state',
  'client_action',
  'work_product_plan',
  'work_product_verify',
  'web_search',
  'url_fetch',
  'create_ppt',
  'create_pdf',
  'write_file',
  'desktop_list_files',
  'desktop_path_info',
  'desktop_list_apps',
  'desktop_system_info',
  'desktop_open',
  'desktop_active_window',
  'desktop_ui_snapshot',
  'desktop_ui_focus',
  'desktop_ui_type',
  'desktop_mouse_click_at',
  'desktop_cursor_glow_show',
  'desktop_cursor_glow_update',
  'desktop_cursor_glow_click',
  'desktop_cursor_glow_hide',
  'desktop_keyboard_press',
  'desktop_capture_screen',
  'ocr_image_file',
  'ocr_screen',
  'floorplan_extract_geometry',
  'cad_generate_dxf',
  'cad_prepare_autocad_operations',
  'mcp_cad-drafting_autocad_playback_file',
  'mcp_cad-drafting_cad_renovation_folder_workflow',
  'mcp_filesystem_read_media_file',
  'mcp_filesystem_read_file',
  'run_command',
  'desktop_run_command',
  'code_execution',
  'python_exec',
  'powershell',
  'shell_exec',
  'terminal_exec',
  'client_health_check',
  'client_self_repair',
  'client_repair_skill',
  'list_skills',
  'install_skill',
  'adapter_registry_list',
  'adapter_health_check',
  'model_configuration_get',
  'model_configuration_test',
  'desktop_running_processes',
  'web_login_run',
  'url_fetch_logged_in',
  'wechat_read_recent_chat',
  'wechat_send_message',
  'wechat_prepare_reply',
  'wechat_copy_reply_draft',
  'work_takeover_task_continue',
  'work_takeover_task_orchestrate',
  'mcp_stockbot_stock_quote',
  'mcp_stockbot_stock_trade_plan',
  'mcp_stockbot_paper_portfolio',
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
  'create_docx',
].map(name => ({
  type: 'function' as const,
  function: {
    name,
    description: name.replace(/_/g, ' '),
    parameters: { type: 'object', properties: {} },
  },
}));

describe('Lumi execution decision', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('keeps ordinary conversation tool-free', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');

    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_chat_user',
      text: 'just talk with me for a minute',
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text: 'just talk with me for a minute',
      toolDeclarations: declarations,
    });

    expect(dispatch.boundary).toBe('conversation');
    expect(decision.allowToolUse).toBe(false);
    expect(decision.toolPolicy.forbiddenTools).toContain('*');
    expect(decision.toolRoute).toBeNull();
  });

  it('promotes an explicit external action from Chat to Assistant execution', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');

    const text = '\u6253\u5f00\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u665a\u5b89';
    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_pure_chat_action_user',
      text,
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text,
      toolDeclarations: declarations,
    });

    expect(dispatch.boundary).toBe('tool_action');
    expect(dispatch.flow.autoPromoteToAssistant).toBe(true);
    expect(dispatch.flow.effectiveOperationMode).toBe('assistant');
    expect(decision.allowToolUse).toBe(true);
    expect(decision.toolRoute?.categories).toContain('messaging');
    expect(decision.toolRoute?.toolNames).toContain('wechat_send_message');
  });

  it('restricts client action turns to client state/action tools', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');

    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_client_user',
      text: 'open settings',
      channel: 'voice',
      source: 'voice',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text: 'open settings',
      toolDeclarations: declarations,
    });

    expect(dispatch.boundary).toBe('client_action');
    expect(decision.toolPolicy.allowedTools).toEqual(['client_get_state', 'client_action']);
    expect(decision.maxIterations).toBe(4);
  });

  it('keeps generic self-checks on the minimal read-only diagnostic set', async () => {
    const { buildSelfRepairToolPolicy } = await import('../server/cognition/execution_decision');
    const policy = buildSelfRepairToolPolicy('给客户端做个自检');

    expect(policy.allowedTools).toEqual([
      'client_get_state',
      'client_health_check',
    ]);
    expect(policy.requireConfirmation).toEqual([]);
    expect(policy.maxIterations).toBe(3);
  });

  it('adds only the explicitly diagnosed self-repair sub-domain tools', async () => {
    const { buildSelfRepairToolPolicy } = await import('../server/cognition/execution_decision');

    const desktop = buildSelfRepairToolPolicy('AutoCAD 白屏了，帮我检查原因');
    expect(desktop.allowedTools).toEqual([
      'client_get_state',
      'client_health_check',
      'adapter_registry_list',
      'adapter_health_check',
      'desktop_capability_status',
      'desktop_active_window',
      'desktop_running_processes',
      'desktop_ui_snapshot',
      'desktop_capture_screen',
    ]);
    expect(desktop.allowedTools).not.toContain('model_configuration_test');

    const skillRepair = buildSelfRepairToolPolicy('修复并重启这个 MCP 技能');
    expect(skillRepair.allowedTools).toEqual([
      'client_get_state',
      'client_health_check',
      'adapter_registry_list',
      'adapter_health_check',
      'client_self_repair',
      'client_repair_skill',
    ]);
    expect(skillRepair.requireConfirmation).toEqual(['client_repair_skill']);
    expect(skillRepair.maxIterations).toBe(5);
  });

  it('keeps every diagnostic-lane tool registered with the intended security level', async () => {
    const { buildSelfRepairToolPolicy } = await import('../server/cognition/execution_decision');
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerAllTools } = await import('../server/tools/definitions');
    const registry = new ToolRegistry();
    registerAllTools(registry);

    const names = new Set([
      ...buildSelfRepairToolPolicy('给客户端做个自检').allowedTools,
      ...buildSelfRepairToolPolicy('AutoCAD 白屏了，帮我检查原因').allowedTools,
      ...buildSelfRepairToolPolicy('检查 DeepSeek 推理模型为什么失败').allowedTools,
      ...buildSelfRepairToolPolicy('修复并重启这个 MCP 技能').allowedTools,
    ]);
    for (const name of names) {
      const tool = registry.get(name);
      expect(tool, name).toBeDefined();
      expect(tool?.securityLevel, name).toBe(name === 'client_repair_skill' ? 'confirm' : 'safe');
    }
  });

  it('treats task center as executable persistent work', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');

    const text = 'create a customer delivery report and export the package';
    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_task_user',
      text,
      channel: 'task',
      source: 'task',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text,
      toolDeclarations: declarations,
    });

    expect(dispatch.boundary).toBe('task_center');
    expect(decision.allowToolUse).toBe(true);
    expect(decision.toolRoute?.toolNames).toContain('work_product_plan');
    expect(decision.toolPolicy.allowedTools.length).toBeGreaterThan(0);
  });

  it('routes voice tool work through the same narrowed tool selection', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');

    const text = 'search the web and create a ppt report';
    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_voice_user',
      text,
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text,
      toolDeclarations: declarations,
    });

    expect(decision.allowToolUse).toBe(true);
    expect(decision.toolRoute?.categories.length).toBeGreaterThan(0);
    expect(decision.toolPolicy.allowedTools).toContain('web_search');
    expect(decision.promptOverlay).toContain('Lumi Execution Decision');
  });

  it.each(['chat', 'voice'] as const)(
    'keeps extraction-only desktop geometry on the same hard policy in %s',
    async (channel) => {
      const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
      const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
      const text = '读取桌面上的设计草稿.jpg，提取几何信息，先不要绘制，只告诉我提取是否成功。';
      const dispatch = buildLumiTurnDispatch({
        userId: `execution_decision_geometry_only_${channel}`,
        text,
        channel,
        source: channel,
        operationMode: 'assistant',
        targetIsLumi: true,
      });
      const decision = buildLumiExecutionDecision({
        flow: dispatch.flow,
        text: dispatch.flow.routeText,
        toolDeclarations: declarations,
      });
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

      expect(decision.allowToolUse).toBe(true);
      expect(decision.toolRoute?.hardAllowlist).toBe(true);
      expect(new Set(decision.toolRoute?.toolNames)).toEqual(new Set(expectedAllowed));
      expect(new Set(decision.toolPolicy.allowedTools)).toEqual(new Set(expectedAllowed));
      expect(decision.toolPolicy.forbiddenTools).toEqual(expect.arrayContaining(forbidden));
      expect(decision.promptOverlay).toContain('hard allowlist');
      for (const name of forbidden) {
        expect(decision.toolPolicy.allowedTools).not.toContain(name);
      }
    },
  );

  it('adds the unified legal entry overlay for company legal chat', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');

    const text = '\u6839\u636e\u6848\u4ef6\u6750\u6599\u6574\u7406\u4e89\u8bae\u7126\u70b9\uff0c\u68c0\u7d22\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u5e76\u751f\u6210\u4ee3\u7406\u8bcd';
    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_company_legal_user',
      text,
      channel: 'chat',
      source: 'org-chat',
      domain: 'work',
      orgId: 'org-legal-entry',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text,
      toolDeclarations: declarations,
    });

    expect(decision.allowToolUse).toBe(true);
    expect(decision.toolRoute?.categories).toContain('legal');
    expect(decision.promptOverlay).toContain('Unified Legal Casework Entry');
    expect(decision.promptOverlay).toContain('organization case workspace');
    expect(decision.promptOverlay).toContain('Current-law gate');
  });

  it('adds the unified legal entry overlay for voice legal work', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');

    const text = '\u8bed\u97f3\u8bb0\u5f55\u5f53\u4e8b\u4eba\u6c9f\u901a\uff0c\u5b9e\u65f6\u5f62\u6210\u6cd5\u5f8b\u4f1a\u8bae\u7eaa\u8981';
    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_voice_legal_user',
      text,
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text,
      toolDeclarations: declarations,
    });

    expect(decision.allowToolUse).toBe(true);
    expect(decision.toolRoute?.categories).toContain('legal');
    expect(decision.promptOverlay).toContain('legal work in the personal workspace');
    expect(decision.promptOverlay).toContain('major premise');
  });

  it('keeps chat, voice, and task sockets on the shared execution decision path', () => {
    const root = process.cwd();
    const sources = [
      readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8'),
      readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8'),
      readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8'),
    ];

    for (const source of sources) {
      expect(source).toContain('buildLumiExecutionDecision');
      expect(source).toContain('buildLumiIntentTrace');
      expect(source).toContain('agent:intent_trace');
      expect(source).not.toContain('routeToolsForTurn');
      expect(source).not.toContain('mergeToolPolicyWithRoute');
    }
  });

  it('restores status follow-ups without restarting the unfinished task or entering task center', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
    const continuationContext = [
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- followupIntent: status',
      '- originalGoal: 把桌面的设计草稿.jpg画到 AutoCAD 里。',
      '- appTarget: AutoCAD',
      '- latestBlocker: mcp_filesystem_read_media_file: Path is outside allowed directories',
      '- unfinished: yes',
    ].join('\n');
    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_status_followup_user',
      text: '\u6211\u95ee\u4f60\u4e3a\u4ec0\u4e48\u6ca1\u6709\u5b8c\u6210\uff1f\u4f60\u4e3a\u4ec0\u4e48\u4e0d\u53bb\u6267\u884c\uff1f',
      continuationContext,
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text: '\u6211\u95ee\u4f60\u4e3a\u4ec0\u4e48\u6ca1\u6709\u5b8c\u6210\uff1f\u4f60\u4e3a\u4ec0\u4e48\u4e0d\u53bb\u6267\u884c\uff1f',
      toolDeclarations: declarations,
    });

    expect(dispatch.flow.routeText).toContain('AutoCAD');
    expect(dispatch.flow.routeText).toContain('Path is outside allowed directories');
    expect(decision.allowToolUse).toBe(false);
    expect(decision.toolRoute).toBeNull();
    expect(decision.toolPolicy.forbiddenTools).toContain('*');
    expect(decision.promptOverlay).toContain('Do not restart execution');
    expect(decision.promptOverlay).toContain('Do not restart execution, create a task-center item');
  });

  it('answers a desktop result demand from saved evidence without rerunning tools', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
    const text = '\u6211\u8ba9\u4f60\u5e2e\u6211\u770b\u4e0b\u684c\u9762\u4e0a\u591a\u5c11\u8f6f\u4ef6\u4f60\u5012\u662f\u8ddf\u6211\u8bf4\u5440';
    const continuationContext = [
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- followupIntent: status',
      '- originalGoal: \u5e2e\u6211\u770b\u4e0b\u684c\u9762\u4e0a\u6709\u591a\u5c11\u8f6f\u4ef6',
      '- unfinished: no',
      'Recent tool evidence:',
      '- desktop_list_apps | items=2 | sample=AutoCAD | WPS Office',
    ].join('\n');
    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_desktop_result_demand_user',
      text,
      continuationContext,
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text,
      toolDeclarations: declarations,
    });

    expect(dispatch.flow.routeText).toContain('desktop_list_apps | items=2');
    expect(decision.allowToolUse).toBe(false);
    expect(decision.toolRoute).toBeNull();
    expect(decision.toolPolicy.forbiddenTools).toContain('*');
    expect(decision.promptOverlay).toContain('actual tool evidence');
  });

  it('routes direct pressure back to the unfinished action instead of task center', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
    const text = '\u522b\u5149\u8bf4\uff0c\u5feb\u505a';
    const continuationContext = [
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- followupIntent: execute',
      '- originalGoal: \u628a\u684c\u9762\u7684\u8bbe\u8ba1\u8349\u7a3f.jpg\u753b\u5230 AutoCAD \u91cc',
      '- latestBlocker: image decoder failed',
      '- unfinished: yes',
    ].join('\n');
    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_pressure_user',
      text,
      continuationContext,
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text,
      toolDeclarations: declarations,
    });

    expect(dispatch.flow.routeText).toContain('\u8bbe\u8ba1\u8349\u7a3f.jpg');
    expect(decision.allowToolUse).toBe(true);
    expect(decision.toolRoute?.categories).not.toContain('task_center');
    expect(decision.toolRoute?.categories).not.toContain('work_takeover');
  });

  it('continues an in-app WPS command with the recovered app route', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
    const continuationContext = [
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- followupIntent: execute',
      '- originalGoal: 打开 WPS。',
      '- appTarget: WPS',
      '- unfinished: no',
      'Recent tool evidence:',
      '- desktop_open | status=opened',
    ].join('\n');
    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_wps_followup_user',
      text: '在这里面写“我好想你”。',
      continuationContext,
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text: '在这里面写“我好想你”。',
      toolDeclarations: declarations,
    });

    expect(decision.allowToolUse).toBe(true);
    expect(decision.toolRoute?.categories).toContain('external_control');
    expect(decision.toolRoute?.categories).not.toContain('work_takeover');
    expect(decision.toolPolicy.allowedTools).toEqual(expect.arrayContaining([
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_ui_type',
    ]));
  });

  it('keeps an exact WPS new-document replay on foreground UI controls', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
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
    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_wps_exact_replay_user',
      text,
      continuationContext,
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text: dispatch.flow.routeText,
      toolDeclarations: declarations,
    });

    expect(dispatch.flow.workSurfaceRoute.directDesktop).toBe(true);
    expect(dispatch.flow.workSurfaceRoute.artifactFirst).toBe(false);
    expect(dispatch.flow.executionGovernance.capabilityLearningIntent).toBe('none');
    expect(dispatch.flow.executionGovernance.delegationIntent).toBe('foreground_owned');
    expect(dispatch.flow.specialWorkflow).toBeNull();
    expect(decision.toolRoute?.categories).toEqual(expect.arrayContaining([
      'external_control',
      'desktop_control',
    ]));
    for (const forbiddenCategory of [
      'code_git',
      'capability_learning',
      'artifact_work',
      'documents',
    ]) {
      expect(decision.toolRoute?.categories).not.toContain(forbiddenCategory);
    }
    expect(decision.toolPolicy.allowedTools).toEqual(expect.arrayContaining([
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_ui_focus',
      'desktop_ui_type',
      'desktop_capture_screen',
      'desktop_open',
    ]));
    expect(decision.maxIterations).toBeLessThanOrEqual(10);
    expect(decision.toolPolicy.forbiddenTools).toContain('computer_use');
    expect(decision.promptOverlay).toContain('Editor-ready gate');
    expect(decision.promptOverlay).toContain('Never repeat the same New/Blank selector');
    for (const forbidden of [
      'work_product_plan',
      'work_product_verify',
      'write_file',
      'create_docx',
      'list_skills',
      'work_takeover_task_continue',
      'work_takeover_task_orchestrate',
      'computer_use',
      'mouse_click',
      'keyboard_type',
    ]) {
      expect(decision.toolPolicy.allowedTools).not.toContain(forbidden);
    }
  });

  it('routes release-regression user wording without falling back to empty chat', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');

    const openSkillHall = '\u6253\u5f00\u6280\u80fd\u5927\u5385';
    const stockAssistant = '\u8fdb\u5165\u770b\u76d8\u8f85\u52a9\u6a21\u5f0f';
    const checkMcp = '\u5e2e\u6211\u68c0\u67e5 MCP \u72b6\u6001';
    const installThisSkill = '\u628a\u8fd9\u4e2a\u6280\u80fd\u88c5\u4e0a';

    const skillHallDispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_regression_user',
      text: openSkillHall,
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const skillHallDecision = buildLumiExecutionDecision({
      flow: skillHallDispatch.flow,
      text: openSkillHall,
      toolDeclarations: declarations,
    });
    expect(skillHallDispatch.boundary).toBe('client_action');
    expect(skillHallDecision.toolPolicy.allowedTools).toEqual(['client_get_state', 'client_action']);
    expect(skillHallDecision.promptOverlay).toContain('verification.status');

    const stockDispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_regression_user',
      text: stockAssistant,
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const stockDecision = buildLumiExecutionDecision({
      flow: stockDispatch.flow,
      text: stockAssistant,
      toolDeclarations: declarations,
    });
    expect(stockDecision.allowToolUse).toBe(true);
    expect(stockDecision.toolRoute?.categories).toContain('market_finance');
    expect(stockDecision.toolRoute?.toolNames).toEqual(expect.arrayContaining([
      'mcp_stockbot_stock_quote',
      'mcp_stockbot_stock_trade_plan',
    ]));

    const mcpDispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_regression_user',
      text: checkMcp,
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const mcpDecision = buildLumiExecutionDecision({
      flow: mcpDispatch.flow,
      text: checkMcp,
      toolDeclarations: declarations,
    });
    expect(mcpDispatch.boundary).toBe('self_repair');
    expect(mcpDecision.allowToolUse).toBe(true);

    const installDispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_regression_user',
      text: installThisSkill,
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const installDecision = buildLumiExecutionDecision({
      flow: installDispatch.flow,
      text: installThisSkill,
      toolDeclarations: declarations,
    });
    expect(installDecision.allowToolUse).toBe(true);
    expect(installDecision.toolRoute?.categories).toContain('skills_agents');
    expect(installDecision.toolRoute?.toolNames).toEqual(expect.arrayContaining([
      'list_skills',
      'install_skill',
    ]));

    const browseSkillHall = '\u53bb\u6280\u80fd\u5927\u5385\u770b\u770b';
    const browseDispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_regression_user',
      text: browseSkillHall,
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const browseDecision = buildLumiExecutionDecision({
      flow: browseDispatch.flow,
      text: browseSkillHall,
      toolDeclarations: declarations,
    });
    expect(browseDispatch.boundary).toBe('client_action');
    expect(browseDecision.toolPolicy.allowedTools).toEqual(['client_get_state', 'client_action']);
  });

  it('routes natural follow-up wording to action paths instead of empty chat', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
    const decide = (text: string, operationMode = 'assistant') => {
      const dispatch = buildLumiTurnDispatch({
        userId: 'execution_decision_natural_probe_user',
        text,
        channel: 'chat',
        source: 'chat',
        operationMode,
        targetIsLumi: true,
      });
      const decision = buildLumiExecutionDecision({
        flow: dispatch.flow,
        text,
        toolDeclarations: declarations,
      });
      return { dispatch, decision };
    };

    const autonomousMode = decide('\u5f00\u59cb\u81ea\u4e3b\u6267\u884c\u6a21\u5f0f', 'chat');
    expect(autonomousMode.dispatch.boundary).toBe('client_action');
    expect(autonomousMode.decision.toolPolicy.allowedTools).toEqual(['client_get_state', 'client_action']);
    expect(autonomousMode.decision.promptOverlay).toContain('verification.status');

    const deliveryReport = decide('\u7ed9\u6211\u505a\u4e00\u4e2a\u5ba2\u6237\u4ea4\u4ed8\u62a5\u544a\u5e76\u5bfc\u51fa');
    expect(deliveryReport.decision.allowToolUse).toBe(true);
    expect(deliveryReport.decision.toolRoute?.categories).toContain('documents');

    const readFile = decide('\u628a\u8fd9\u4e2a\u6587\u4ef6\u8bfb\u4e00\u4e0b');
    expect(readFile.decision.allowToolUse).toBe(true);
    expect(readFile.decision.toolRoute?.categories).toContain('documents');

    const stockNews = decide('\u67e5\u4e00\u4e0b\u4eca\u5929\u7f8e\u80a1\u65b0\u95fb');
    expect(stockNews.decision.allowToolUse).toBe(true);
    expect(stockNews.decision.toolRoute?.categories).toEqual(expect.arrayContaining(['market_finance', 'web_research']));

    const taobaoBackend = decide('\u5e2e\u6211\u7528\u6d4f\u89c8\u5668\u6253\u5f00\u6dd8\u5b9d\u540e\u53f0');
    expect(taobaoBackend.decision.allowToolUse).toBe(true);
    expect(taobaoBackend.decision.toolRoute?.categories).toContain('authenticated_web');
    expect(taobaoBackend.decision.toolRoute?.toolNames).toEqual(expect.arrayContaining([
      'web_login_run',
      'url_fetch_logged_in',
    ]));

    const legalFolder = decide('\u6839\u636e\u6848\u4ef6\u6587\u4ef6\u5939\u6574\u7406\u4ee3\u7406\u8bcd');
    expect(legalFolder.decision.allowToolUse).toBe(true);
    expect(legalFolder.decision.toolRoute?.categories).toContain('legal');

    const installLoose = decide('\u8fd9\u4e2a\u6280\u80fd\u88c5\u4e00\u4e0b');
    expect(installLoose.decision.allowToolUse).toBe(true);
    expect(installLoose.decision.toolRoute?.categories).toContain('skills_agents');

    const newsSearch = decide('\u641c\u4e00\u4e0b\u4eca\u5929 OpenAI \u65b0\u95fb');
    expect(newsSearch.decision.allowToolUse).toBe(true);
    expect(newsSearch.decision.toolRoute?.categories).toContain('web_research');

    const pptReport = decide('\u505a\u4e2a PPT \u6c47\u62a5\u5e76\u5bfc\u51fa');
    expect(pptReport.decision.allowToolUse).toBe(true);
    expect(pptReport.decision.toolRoute?.categories).toContain('documents');
    expect(pptReport.decision.toolRoute?.toolNames).toContain('create_ppt');

    const summarizeDoc = decide('\u628a\u8fd9\u4efd\u6587\u6863\u603b\u7ed3\u4e00\u4e0b');
    expect(summarizeDoc.decision.allowToolUse).toBe(true);
    expect(summarizeDoc.decision.toolRoute?.categories).toContain('documents');

    const readLoose = decide('\u8bfb\u53d6\u8fd9\u4e2a\u6587\u4ef6');
    expect(readLoose.decision.allowToolUse).toBe(true);
    expect(readLoose.decision.toolRoute?.categories).toContain('documents');

    const summarizePdf = decide('\u603b\u7ed3\u8fd9\u4efd PDF');
    expect(summarizePdf.decision.allowToolUse).toBe(true);
    expect(summarizePdf.decision.toolRoute?.categories).toContain('documents');

    const poster = decide('\u753b\u4e00\u5f20\u6d77\u62a5');
    expect(poster.decision.allowToolUse).toBe(true);
    expect(poster.decision.toolRoute?.categories).toContain('cad_design');

    const importKb = decide('\u628a\u8fd9\u4efd\u8d44\u6599\u5bfc\u5165\u77e5\u8bc6\u5e93');
    expect(importKb.decision.allowToolUse).toBe(true);
    expect(importKb.decision.toolRoute?.categories).toContain('documents');

    const wechatReply = decide('\u5e2e\u6211\u56de\u4e00\u4e0b\u5fae\u4fe1\u5ba2\u6237');
    expect(wechatReply.decision.allowToolUse).toBe(true);
    expect(wechatReply.decision.toolRoute?.categories).toContain('messaging');
    expect(wechatReply.decision.toolRoute?.toolNames).toEqual(expect.arrayContaining([
      'wechat_prepare_reply',
      'wechat_copy_reply_draft',
    ]));

    const wechatSend = decide('\u5fae\u4fe1\u76f4\u63a5\u53d1\u665a\u5b89\u7ed9\u963f\u9646');
    expect(wechatSend.decision.allowToolUse).toBe(true);
    expect(wechatSend.decision.toolRoute?.categories).toContain('messaging');
    expect(wechatSend.decision.toolRoute?.toolNames).toContain('wechat_send_message');

    const wechatRead = decide('\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9');
    expect(wechatRead.decision.allowToolUse).toBe(true);
    expect(wechatRead.decision.toolRoute?.categories).toContain('messaging');
    expect(wechatRead.decision.toolRoute?.toolNames).toContain('wechat_read_recent_chat');
    expect(wechatRead.decision.toolRoute?.toolNames.slice(0, 4)).not.toContain('wechat_send_message');

    const continueCustomerTask = decide('\u7ee7\u7eed\u90a3\u4e2a\u5ba2\u6237\u4ea4\u4ed8\u4efb\u52a1');
    expect(continueCustomerTask.decision.allowToolUse).toBe(true);
    expect(continueCustomerTask.decision.toolRoute?.categories).toContain('work_takeover');
    expect(continueCustomerTask.decision.toolRoute?.toolNames).toEqual(expect.arrayContaining([
      'work_takeover_task_continue',
      'work_takeover_task_orchestrate',
    ]));

    const whyPush = decide('\u4e3a\u4ec0\u4e48\u8981\u63a8\u9001');
    expect(whyPush.dispatch.boundary).toBe('conversation');
    expect(whyPush.decision.allowToolUse).toBe(false);
    expect(whyPush.decision.toolRoute).toBeNull();

    const naturalnessQuestion = decide('lumi \u80fd\u4e0d\u80fd\u66f4\u81ea\u7136\u4e00\u70b9');
    expect(naturalnessQuestion.dispatch.boundary).toBe('conversation');
    expect(naturalnessQuestion.decision.allowToolUse).toBe(false);
    expect(naturalnessQuestion.decision.toolRoute).toBeNull();

    const stockModeQuestion = decide('\u770b\u76d8\u8f85\u52a9\u6a21\u5f0f\u662f\u4ec0\u4e48');
    expect(stockModeQuestion.dispatch.boundary).toBe('conversation');
    expect(stockModeQuestion.decision.allowToolUse).toBe(false);
    expect(stockModeQuestion.decision.toolRoute).toBeNull();

    const skillInstallQuestion = decide('\u6280\u80fd\u5927\u5385\u7684\u5b89\u88c5\u53ef\u4ee5\u7528\u5417');
    expect(skillInstallQuestion.dispatch.boundary).toBe('conversation');
    expect(skillInstallQuestion.decision.allowToolUse).toBe(false);
    expect(skillInstallQuestion.decision.toolRoute).toBeNull();

    const knowledgeFileCapabilityQuestion = decide('\u77e5\u8bc6\u5e93\u91cc\u7684\u6587\u4ef6\u53ef\u4ee5\u53d1\u7ed9\u6211\u5417');
    expect(knowledgeFileCapabilityQuestion.dispatch.boundary).toBe('conversation');
    expect(knowledgeFileCapabilityQuestion.dispatch.flow.autoPromoteToAssistant).toBe(false);
    expect(knowledgeFileCapabilityQuestion.decision.allowToolUse).toBe(false);
    expect(knowledgeFileCapabilityQuestion.decision.toolRoute).toBeNull();

    const knowledgeFileSendCommand = decide('\u628a\u77e5\u8bc6\u5e93\u91cc\u7684\u9886\u822a\u5458\u624b\u518c\u53d1\u7ed9\u6211');
    expect(knowledgeFileSendCommand.dispatch.boundary).toBe('tool_action');
    expect(knowledgeFileSendCommand.decision.allowToolUse).toBe(true);
    expect(knowledgeFileSendCommand.decision.toolRoute?.categories).toContain('messaging');

    const installerQuestion = decide('\u7f16\u8bd1\u6210\u5b89\u88c5\u5305\u4e5f\u80fd\u7528\u5417');
    expect(installerQuestion.dispatch.boundary).toBe('conversation');
    expect(installerQuestion.decision.allowToolUse).toBe(false);
    expect(installerQuestion.decision.toolRoute).toBeNull();

    const mcpWhyQuestion = decide('lumi \u4e3a\u4ec0\u4e48\u8981\u63a5\u5165\u5916\u90e8 MCP');
    expect(mcpWhyQuestion.dispatch.boundary).toBe('conversation');
    expect(mcpWhyQuestion.decision.allowToolUse).toBe(false);
    expect(mcpWhyQuestion.decision.toolRoute).toBeNull();

    const marketHowQuestion = decide('\u770b\u76d8\u8f85\u52a9\u6a21\u5f0f\u600e\u4e48\u7528');
    expect(marketHowQuestion.dispatch.boundary).toBe('conversation');
    expect(marketHowQuestion.decision.allowToolUse).toBe(false);
    expect(marketHowQuestion.decision.toolRoute).toBeNull();

    const installerCanQuestion = decide('\u5b89\u88c5\u5305\u80fd\u4e0d\u80fd\u7528');
    expect(installerCanQuestion.dispatch.boundary).toBe('conversation');
    expect(installerCanQuestion.decision.allowToolUse).toBe(false);
    expect(installerCanQuestion.decision.toolRoute).toBeNull();

    const marketRiskQuestion = decide('\u770b\u76d8\u8f85\u52a9\u4f1a\u4e0d\u4f1a\u6709\u98ce\u9669');
    expect(marketRiskQuestion.dispatch.boundary).toBe('conversation');
    expect(marketRiskQuestion.decision.allowToolUse).toBe(false);
    expect(marketRiskQuestion.decision.toolRoute).toBeNull();

    const whyFailed = decide('\u4e3a\u4ec0\u4e48\u6ca1\u505a\u5b8c');
    expect(whyFailed.dispatch.boundary).toBe('self_repair');
    expect(whyFailed.decision.allowToolUse).toBe(true);
  });

  it('builds intent traces for action versus consultation boundaries', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
    const { buildLumiIntentTrace } = await import('../server/cognition/intent_trace');
    const decide = (text: string, operationMode = 'assistant') => {
      const dispatch = buildLumiTurnDispatch({
        userId: 'execution_decision_trace_user',
        text,
        channel: 'chat',
        source: 'chat',
        operationMode,
        targetIsLumi: true,
      });
      const decision = buildLumiExecutionDecision({
        flow: dispatch.flow,
        text,
        toolDeclarations: declarations,
      });
      const trace = buildLumiIntentTrace({
        dispatch,
        execution: decision,
        text,
        source: 'test',
      });
      return { dispatch, decision, trace };
    };

    const openSkillHall = decide('\u6253\u5f00\u6280\u80fd\u5927\u5385', 'chat');
    expect(openSkillHall.trace.boundary).toBe('client_action');
    expect(openSkillHall.trace.allowed).toBe(true);
    expect(openSkillHall.trace.matched.clientActionOnlyTurn).toBe(true);
    expect(openSkillHall.trace.toolPolicy.allowedTools).toEqual(['client_get_state', 'client_action']);
    expect(openSkillHall.trace.matchedRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: 'structured_client', name: 'client-navigation' }),
      expect.objectContaining({ layer: 'turn_flow', name: 'client-action-only-turn' }),
    ]));

    const skillInstallQuestion = decide('\u6280\u80fd\u5927\u5385\u7684\u5b89\u88c5\u53ef\u4ee5\u7528\u5417', 'chat');
    expect(skillInstallQuestion.trace.boundary).toBe('conversation');
    expect(skillInstallQuestion.trace.allowed).toBe(false);
    expect(skillInstallQuestion.trace.matched.informationOnlyQuestion).toBe(true);
    expect(skillInstallQuestion.trace.blockedBy).toContain('information-only-question');
    expect(skillInstallQuestion.trace.toolRoute).toBeNull();

    const checkMcp = decide('\u5e2e\u6211\u68c0\u67e5 MCP \u72b6\u6001');
    expect(checkMcp.trace.boundary).toBe('self_repair');
    expect(checkMcp.trace.allowed).toBe(true);
    expect(checkMcp.trace.matched.diagnosticOrRepair).toBe(true);
    expect(checkMcp.trace.matchedRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: 'turn_flow', name: 'self-repair-turn' }),
    ]));

    const installThisSkill = decide('\u628a\u8fd9\u4e2a\u6280\u80fd\u88c5\u4e0a');
    expect(installThisSkill.trace.boundary).toBe('tool_action');
    expect(installThisSkill.trace.allowed).toBe(true);
    expect(installThisSkill.trace.matched.explicitToolIntent).toBe(true);
    expect(installThisSkill.trace.matchedRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: 'structured_tool', name: 'skill-install' }),
    ]));
    expect(installThisSkill.trace.toolRoute?.categories).toContain('skills_agents');

    const mcpBrokenQuestion = decide('MCP \u4e3a\u4ec0\u4e48\u6253\u4e0d\u5f00');
    expect(mcpBrokenQuestion.trace.boundary).toBe('self_repair');
    expect(mcpBrokenQuestion.trace.allowed).toBe(true);
    expect(mcpBrokenQuestion.trace.matched.diagnosticOrRepair).toBe(true);

    const mcpConceptQuestion = decide('lumi \u4e3a\u4ec0\u4e48\u8981\u63a5\u5165\u5916\u90e8 MCP', 'chat');
    expect(mcpConceptQuestion.trace.boundary).toBe('conversation');
    expect(mcpConceptQuestion.trace.allowed).toBe(false);
    expect(mcpConceptQuestion.trace.matched.informationOnlyQuestion).toBe(true);
    expect(mcpConceptQuestion.trace.blockedBy).toContain('information-only-question');
  });
});
