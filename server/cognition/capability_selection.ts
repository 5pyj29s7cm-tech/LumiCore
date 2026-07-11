import type { LumiExecutionDecision } from './execution_decision';
import type { LumiTurnDispatch } from './turn_dispatch';
import { buildActionContract, formatActionContractPrompt, requiresVisibleAutoCadExecution } from './action_contract';
import { LEGAL_ENTRY_PREFERRED_TOOLS, isLegalEntryTurn } from './legal_entry';

export type LumiCapabilityLane =
  | 'conversation'
  | 'client_surface'
  | 'self_repair'
  | 'capability_learning'
  | 'skill_workflow'
  | 'task_center'
  | 'work_takeover'
  | 'legal_casework'
  | 'messaging'
  | 'artifact_work'
  | 'design_cad'
  | 'desktop_control'
  | 'web_or_account'
  | 'external_tool'
  | 'blocked_no_tools';

export interface LumiCapabilitySelectionInput {
  dispatch: LumiTurnDispatch;
  execution: LumiExecutionDecision;
  text: string;
}

export interface LumiCapabilitySelection {
  lane: LumiCapabilityLane;
  primary: string;
  reasons: string[];
  preferredTools: string[];
  promptOverlay: string;
}

const TOOL_HINTS: Record<LumiCapabilityLane, string[]> = {
  conversation: [],
  client_surface: ['client_get_state', 'client_action'],
  self_repair: ['client_get_state', 'client_health_check', 'client_self_repair', 'desktop_ui_snapshot'],
  capability_learning: [
    'capability_learning_list',
    'self_extension_plan',
    'capability_gap_autofix',
    'list_skills',
    'adapter_registry_list',
    'external_app_list_adapters',
  ],
  skill_workflow: [],
  task_center: [
    'work_takeover_task_get',
    'work_takeover_task_advance',
    'work_takeover_task_autorun',
    'work_takeover_task_verify_result',
    'work_takeover_task_export_packet',
  ],
  work_takeover: [
    'work_takeover_task_continue',
    'work_takeover_task_advance',
    'work_takeover_task_verify_result',
    'work_takeover_task_export_packet',
  ],
  legal_casework: LEGAL_ENTRY_PREFERRED_TOOLS,
  messaging: [
    'desktop_list_apps',
    'desktop_open',
    'desktop_active_window',
    'desktop_ui_focus',
    'desktop_ui_snapshot',
    'desktop_capture_screen',
    'ocr_screen',
    'wechat_read_recent_chat',
    'wechat_send_message',
    'wechat_prepare_reply',
    'wechat_copy_reply_draft',
    'desktop_mouse_click_at',
    'desktop_cursor_glow_show',
    'desktop_cursor_glow_update',
    'desktop_cursor_glow_click',
    'desktop_cursor_glow_hide',
    'desktop_keyboard_press',
    'browser_open_task',
    'external_app_list_adapters',
  ],
  artifact_work: ['work_product_plan', 'create_docx', 'create_ppt', 'create_pdf', 'write_file', 'work_product_verify'],
  design_cad: [
    'desktop_path_info',
    'desktop_list_files',
    'floorplan_extract_geometry',
    'ocr_image_file',
    'mcp_cad-drafting_cad_renovation_folder_workflow',
    'cad_generate_dxf',
    'cad_generate_autocad_draw_script',
    'cad_run_autocad_draw_script',
  ],
  desktop_control: [
    'desktop_active_window',
    'desktop_list_apps',
    'desktop_open',
    'desktop_ui_snapshot',
    'desktop_ui_focus',
    'desktop_ui_click',
    'desktop_ui_type',
    'desktop_ui_invoke',
    'desktop_capture_screen',
    'mouse_move',
    'mouse_click',
    'mouse_drag',
    'keyboard_type',
    'keyboard_press',
    'read_clipboard',
    'write_clipboard',
    'computer_use',
    'desktop_show_lumi_window',
    'desktop_path_info',
    'desktop_running_processes',
    'desktop_idle_time',
    'desktop_poll_activity',
    'desktop_run_command',
  ],
  web_or_account: [
    'web_login_profile_list',
    'web_login_profile_save_from_preset',
    'web_login_run',
    'url_fetch_logged_in',
    'web_search',
    'browser_open_task',
    'mcp_playwright_browser_snapshot',
    'mcp_playwright_browser_navigate',
    'mcp_playwright_browser_click',
    'mcp_playwright_browser_fill_form',
    'desktop_active_window',
  ],
  external_tool: [],
  blocked_no_tools: [],
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function compact(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function routeHas(input: LumiCapabilitySelectionInput, ...categories: string[]): boolean {
  const present = new Set(input.execution.toolRoute?.categories || []);
  return categories.some(category => present.has(category));
}

function routeHasTool(input: LumiCapabilitySelectionInput, pattern: RegExp): boolean {
  return (input.execution.toolRoute?.toolNames || []).some(name => pattern.test(name));
}

function availablePreferredTools(input: LumiCapabilitySelectionInput, lane: LumiCapabilityLane): string[] {
  const routeTools = input.execution.toolRoute?.toolNames || [];
  const allowedTools = (input.execution.toolPolicy.allowedTools || []).filter(name => name && name !== '*');
  const available = new Set([...routeTools, ...allowedTools]);
  const hints = TOOL_HINTS[lane].filter(name => available.size === 0 || available.has(name));
  const directRoute = routeTools.filter(name => TOOL_HINTS[lane].some(hint => name === hint || name.startsWith(`${hint}_`)));
  return unique([...hints, ...directRoute, ...routeTools.slice(0, 8)]).slice(0, 18);
}

function fallbackPrimary(input: LumiCapabilitySelectionInput): string {
  const route = input.execution.toolRoute;
  if (route?.categories.length) return route.categories.join(', ');
  if (input.dispatch.flow.workSurfaceRoute.directDesktop) return 'desktop/software control';
  if (input.dispatch.flow.workSurfaceRoute.artifactFirst) return 'artifact production';
  return input.dispatch.boundary;
}

function asksForRawDesktopOperation(text: string): boolean {
  return /\b(?:mouse|keyboard|cursor|click|drag|type|uia|computer_use|coordinate|screen\s+control|desktop\s+control)\b/i.test(text)
    || /(?:\u9f20\u6807|\u952e\u76d8|\u5149\u6807|\u70b9\u51fb|\u62d6\u62fd|\u8f93\u5165|\u5750\u6807|\u63a5\u7ba1\u684c\u9762|\u684c\u9762\u63a7\u5236|\u5c4f\u5e55\u63a7\u5236|\u539f\u751f\u63a7\u4ef6)/u.test(text);
}

function selectLane(input: LumiCapabilitySelectionInput): Pick<LumiCapabilitySelection, 'lane' | 'primary' | 'reasons'> {
  const flow = input.dispatch.flow;
  const text = compact(input.text || flow.routeText);
  const reasons: string[] = [
    `turn boundary=${input.dispatch.boundary}`,
    `channel=${input.dispatch.channel}`,
  ];

  if (input.dispatch.boundary === 'client_action') {
    return {
      lane: 'client_surface',
      primary: 'Lumi client state/action',
      reasons: [...reasons, 'the user is controlling Lumi client UI or mode'],
    };
  }

  if (input.dispatch.boundary === 'self_repair') {
    return {
      lane: 'self_repair',
      primary: 'Lumi self inspection and recovery',
      reasons: [...reasons, 'the turn is diagnostic or repair-oriented'],
    };
  }

  if (flow.executionGovernance.capabilityLearningIntent !== 'none') {
    return {
      lane: 'capability_learning',
      primary: flow.executionGovernance.capabilityLearningIntent,
      reasons: [...reasons, flow.executionGovernance.capabilityLearningReason],
    };
  }

  if (input.dispatch.boundary === 'skill_workflow' || flow.specialWorkflow) {
    const workflow = flow.specialWorkflow;
    return {
      lane: 'skill_workflow',
      primary: workflow ? `${workflow.skillId}/${workflow.id}` : 'matched skill workflow',
      reasons: [...reasons, 'a learned repeatable workflow matched this turn'],
    };
  }

  if (input.dispatch.boundary === 'task_center') {
    return {
      lane: 'task_center',
      primary: 'persistent task center',
      reasons: [...reasons, 'the user entered through task center'],
    };
  }

  if (input.dispatch.boundary === 'work_takeover') {
    return {
      lane: 'work_takeover',
      primary: flow.workTakeover.latestTask?.id || 'active work takeover task',
      reasons: [...reasons, `active task continuation intent=${flow.workTakeover.intent || 'unknown'} strength=${flow.workTakeover.strength}`],
    };
  }

  if (!input.execution.allowToolUse) {
    return input.dispatch.boundary === 'conversation'
      ? {
          lane: 'conversation',
          primary: 'natural conversation',
          reasons: [...reasons, 'tools are intentionally off for this turn'],
        }
      : {
          lane: 'blocked_no_tools',
          primary: fallbackPrimary(input),
          reasons: [...reasons, 'the turn wants action but tool access is off'],
        };
  }

  const actionContract = buildActionContract(text);
  if (
    actionContract.kind === 'browser_account' ||
    (!routeHas(input, 'legal') && routeHas(input, 'authenticated_web', 'web_research'))
  ) {
    return {
      lane: 'web_or_account',
      primary: actionContract.kind === 'browser_account' ? 'browser/account session work' : 'browser web work',
      reasons: [...reasons, 'browser, login, saved-session, or authenticated web tools matched before artifact handling'],
    };
  }

  if (routeHas(input, 'legal') || routeHasTool(input, /^(legal_|mcp_legal-casework_)/) || isLegalEntryTurn(text)) {
    return {
      lane: 'legal_casework',
      primary: 'legal casework and legal documents',
      reasons: [...reasons, 'legal casework, legal source, or remote legal intake tools matched'],
    };
  }

  if (routeHas(input, 'messaging') || routeHasTool(input, /^(wechat_|feishu_|recent_emails|send_email)/)) {
    return {
      lane: 'messaging',
      primary: 'message handoff and reply drafting',
      reasons: [...reasons, 'message or account communication tools matched'],
    };
  }

  if (routeHas(input, 'cad_design') && flow.workSurfaceRoute.directDesktop && !asksForRawDesktopOperation(text)) {
    return {
      lane: 'design_cad',
      primary: 'design/CAD production with visible CAD-app execution',
      reasons: [...reasons, 'CAD/design tools matched and the visible app is an execution target, not the whole plan'],
    };
  }

  if (flow.workSurfaceRoute.directDesktop || routeHas(input, 'external_control')) {
    return {
      lane: 'desktop_control',
      primary: 'visible desktop/software control',
      reasons: [...reasons, 'the task needs screen, cursor, native UI, or external app control'],
    };
  }

  if (routeHas(input, 'cad_design') || routeHasTool(input, /^(cad_|floorplan_|generate_image|edit_image)/)) {
    return {
      lane: 'design_cad',
      primary: 'design/CAD production',
      reasons: [...reasons, 'design, floor plan, CAD, or visual production tools matched'],
    };
  }

  if (flow.workSurfaceRoute.artifactFirst || routeHas(input, 'documents') || routeHasTool(input, /^(create_|pdf_|ocr_|extract_)/)) {
    return {
      lane: 'artifact_work',
      primary: 'local artifact production',
      reasons: [...reasons, 'the task should produce or inspect files before claiming results'],
    };
  }

  if (routeHasTool(input, /^(desktop_|computer_use$)/)) {
    return {
      lane: 'desktop_control',
      primary: 'visible desktop/software control',
      reasons: [...reasons, 'desktop/system tools matched and no browser or artifact lane was stronger'],
    };
  }

  if (input.execution.toolRoute?.toolNames.length) {
    return {
      lane: 'external_tool',
      primary: fallbackPrimary(input),
      reasons: [...reasons, 'a narrowed external tool route is available'],
    };
  }

  return {
    lane: text ? 'conversation' : 'blocked_no_tools',
    primary: text ? 'natural conversation' : 'empty turn',
    reasons: [...reasons, text ? 'no stronger capability lane matched' : 'empty user text'],
  };
}

function laneRule(selection: Pick<LumiCapabilitySelection, 'lane'>, text = ''): string {
  switch (selection.lane) {
    case 'conversation':
      return 'Answer as Lumi. Do not invent work, tool calls, or hidden task progress.';
    case 'client_surface':
      return 'Stay on Lumi client state/action. Do not drift into desktop, browser, files, or task execution.';
    case 'self_repair':
      return 'Inspect state first, try one safe recovery when possible, verify, then report plainly.';
    case 'capability_learning':
      return 'Inspect existing skills/adapters/tools first; reuse or stabilize before adding anything new. Do not hard-code an industry demo into Lumi core.';
    case 'skill_workflow':
      return 'Use the learned workflow as a reusable capability. Parameterize every step from this user turn and active task state.';
    case 'task_center':
      return 'Treat this as persistent work with task state, artifacts, blockers, confirmation boundaries, and a concise result.';
    case 'work_takeover':
      return 'Continue the active task instead of starting over. Preserve context, advance the next safe step, verify evidence, and update the task.';
    case 'legal_casework':
      return 'Use the unified legal casework path across personal chat, company chat, voice, task center, and remote bot intake. Start from the case workspace/source intake, apply the major-premise/minor-premise/conclusion chain, verify current effective law before final documents, and stop for confirmation before filing, signing, paying, submitting, or committing a final legal position.';
    case 'messaging':
      return 'Use messaging tools as a bridge to customer or account communication. For explicit ordinary foreground sends, use the dedicated send tool and visible cursor path; draft before sending when the boundary is ambiguous.';
    case 'artifact_work':
      return 'Produce or inspect local files first, verify content and existence, then explain what is ready and what still needs confirmation.';
    case 'design_cad':
      if (requiresVisibleAutoCadExecution(text)) {
        return 'Use the source files/images to derive structured geometry, then generate CAD/DXF and continue to AutoCAD visible drawing execution. A DXF, folder workflow, or design package alone is not completion evidence for this wording; call cad_generate_autocad_draw_script and cad_run_autocad_draw_script, then verify the AutoCAD run or state the exact blocker.';
      }
      return 'Prefer structured design/CAD tools over raw cursor work; use desktop CAD only when the user asks to operate visible software or a tool needs it.';
    case 'desktop_control':
      return 'Use screen/window state as evidence. Move through visible UI deliberately and verify the app/result before claiming completion.';
    case 'web_or_account':
      return 'Treat this as browser/account execution. First inspect saved login profiles or existing sessions; for known legal/account sites, create or reuse the matching authorized profile only when allowed, then run web_login_run visibly and verify the logged-in or target result page. Do not rely on raw iframe JavaScript hacks as the main plan. Stop with the exact blocker at missing credentials, QR/captcha/2FA/passkey/account switching, access limits, payment, irreversible publish, or missing target-result evidence.';
    case 'external_tool':
      return 'Use the selected external tools as Lumi hands, keep ownership of the result, and verify before final claims.';
    case 'blocked_no_tools':
    default:
      return 'Do not pretend to execute. Explain the boundary or ask one short clarification.';
  }
}

export function buildLumiCapabilitySelection(input: LumiCapabilitySelectionInput): LumiCapabilitySelection {
  const selected = selectLane(input);
  const actionContract = buildActionContract(input.text || input.dispatch.flow.routeText || '');
  const preferredTools = unique([
    ...availablePreferredTools(input, selected.lane),
    ...(actionContract.applies ? actionContract.preferredTools : []),
  ]).slice(0, 22);
  const routeCategories = input.execution.toolRoute?.categories || [];
  const promptOverlay = [
    '## Lumi Capability Selection',
    `Selected lane: ${selected.lane}.`,
    `Primary capability: ${selected.primary}.`,
    `Why: ${unique(selected.reasons).join('; ')}.`,
    routeCategories.length ? `Tool route categories: ${routeCategories.join(', ')}.` : 'Tool route categories: none.',
    preferredTools.length ? `Preferred tools for this lane: ${preferredTools.join(', ')}.` : 'Preferred tools for this lane: none.',
    laneRule(selected, input.text || input.dispatch.flow.routeText || ''),
    formatActionContractPrompt(actionContract),
    'This lane is an execution bias, not a fixed script. If the newest user wording contradicts it, follow the newest wording and update task state when work is persistent.',
  ].filter(Boolean).join('\n');

  return {
    ...selected,
    preferredTools,
    promptOverlay,
  };
}
