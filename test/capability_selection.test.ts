import './helpers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const declarations = [
  'client_get_state',
  'client_action',
  'client_health_check',
  'client_self_repair',
  'desktop_ui_snapshot',
  'desktop_ui_focus',
  'desktop_ui_click',
  'desktop_ui_type',
  'desktop_ui_invoke',
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
  'web_login_run',
  'browser_open_task',
  'mcp_playwright_browser_snapshot',
  'floorplan_extract_geometry',
  'cad_generate_dxf',
  'cad_generate_autocad_draw_script',
  'cad_run_autocad_draw_script',
  'wechat_prepare_reply',
  'wechat_copy_reply_draft',
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
    text: input.text,
    toolDeclarations: declarations,
  });
  const selection = buildLumiCapabilitySelection({
    dispatch,
    execution,
    text: input.text,
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
    expect(selection.promptOverlay).toContain('Selected lane: conversation');
  });

  it('selects capability learning before treating Lumi improvement as generic tools', async () => {
    const { selection, dispatch } = await selectCapability({
      userId: 'capability_selection_learning_user',
      text: 'Lumi, stabilize the existing desktop capability, check duplicate hard-coded scripts, and make it reusable.',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(dispatch.flow.executionGovernance.capabilityLearningIntent).toBe('inspect_reuse');
    expect(selection.lane).toBe('capability_learning');
    expect(selection.preferredTools).toContain('capability_learning_list');
    expect(selection.promptOverlay).toContain('Do not hard-code an industry demo into Lumi core');
  });

  it('keeps learned self-introduction as a skill workflow instead of a fixed script', async () => {
    const { dispatch, selection } = await selectCapability({
      userId: 'capability_selection_skill_user',
      text: 'Lumi, introduce yourself',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(dispatch.boundary).toBe('skill_workflow');
    expect(selection.lane).toBe('skill_workflow');
    expect(selection.primary).toContain('self_intro_demo');
    expect(selection.promptOverlay).toContain('not a fixed script');
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
    expect(selection.preferredTools).toContain('work_takeover_task_advance');
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

  it('selects artifact work for reports and local files', async () => {
    const { selection } = await selectCapability({
      userId: 'capability_selection_artifact_user',
      text: 'create a PPT report and export a PDF',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('artifact_work');
    expect(selection.preferredTools).toContain('create_ppt');
  });

  it('selects desktop control for visible external software operation', async () => {
    const { selection } = await selectCapability({
      userId: 'capability_selection_desktop_user',
      text: 'open AutoCAD and operate the desktop with mouse to draw a floor plan',
      operationMode: 'assistant',
    });

    expect(selection.lane).toBe('desktop_control');
    expect(selection.preferredTools).toContain('desktop_ui_snapshot');
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

  it('keeps chat, voice, and task sockets on the shared capability selection path', () => {
    const root = process.cwd();
    const sources = [
      readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8'),
      readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8'),
      readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8'),
    ];

    for (const source of sources) {
      expect(source).toContain('buildLumiCapabilitySelection');
      expect(source).toContain('agent:capability_selection');
    }
  });
});
