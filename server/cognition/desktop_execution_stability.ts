import type { LumiCapabilityLane, LumiCapabilitySelection } from './capability_selection';
import type { LumiTurnChannel, LumiTurnFlow } from './turn_flow';
import { isRecoveredCurrentAppEditingContinuation } from './action_continuation';

export interface DesktopExecutionStabilityPolicyInput {
  channel: LumiTurnChannel;
  text: string;
  flow?: LumiTurnFlow;
  capabilitySelection: Pick<LumiCapabilitySelection, 'lane' | 'primary' | 'preferredTools'>;
}

export interface DesktopExecutionStabilityPolicy {
  applies: boolean;
  reason: string;
  evidenceTools: string[];
  actuationTools: string[];
  verificationTools: string[];
  promptOverlay: string;
}

const VISIBLE_DESKTOP_LANES = new Set<LumiCapabilityLane>([
  'desktop_control',
  'design_cad',
  'web_or_account',
]);

function compact(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function hasPreferred(input: DesktopExecutionStabilityPolicyInput, name: string): boolean {
  return input.capabilitySelection.preferredTools.includes(name);
}

function inferReason(input: DesktopExecutionStabilityPolicyInput): string {
  if (input.flow?.workSurfaceRoute.directDesktop) return 'direct desktop work was requested or inferred';
  if (input.capabilitySelection.lane === 'design_cad') return 'CAD/design work may move between generated files and visible software';
  if (input.capabilitySelection.lane === 'web_or_account') return 'browser/account work needs current-window and login-state checks';
  return 'visible desktop/software control is selected';
}

function shouldApply(input: DesktopExecutionStabilityPolicyInput): boolean {
  return VISIBLE_DESKTOP_LANES.has(input.capabilitySelection.lane)
    || Boolean(input.flow?.workSurfaceRoute.directDesktop);
}

export function buildDesktopExecutionStabilityPolicy(
  input: DesktopExecutionStabilityPolicyInput,
): DesktopExecutionStabilityPolicy {
  const applies = shouldApply(input);
  if (!applies) {
    return {
      applies: false,
      reason: 'no visible desktop lane selected',
      evidenceTools: [],
      actuationTools: [],
      verificationTools: [],
      promptOverlay: '',
    };
  }

  const recoveredCurrentAppEdit = isRecoveredCurrentAppEditingContinuation(
    input.text || input.flow?.routeText || '',
  );
  const evidenceTools = unique([
    recoveredCurrentAppEdit ? '' : 'desktop_list_apps',
    'desktop_active_window',
    'desktop_ui_snapshot',
    recoveredCurrentAppEdit ? 'ocr_screen' : '',
    hasPreferred(input, 'mcp_playwright_browser_snapshot') ? 'mcp_playwright_browser_snapshot' : '',
    'desktop_capture_screen',
  ]);
  const actuationTools = unique(recoveredCurrentAppEdit
    ? [
        'desktop_ui_focus',
        'desktop_ui_click',
        'desktop_ui_invoke',
        'desktop_ui_type',
        'write_clipboard',
        'keyboard_press',
        'desktop_keyboard_press',
      ]
    : [
        'desktop_ui_focus',
        'desktop_ui_click',
        'desktop_ui_invoke',
        'desktop_ui_type',
        'write_clipboard',
        'mouse_move',
        'mouse_click',
        'mouse_drag',
        'keyboard_type',
        'keyboard_press',
        'computer_use',
      ]);
  const verificationTools = unique([
    'desktop_active_window',
    'desktop_ui_snapshot',
    'read_clipboard',
    'desktop_capture_screen',
    input.capabilitySelection.lane === 'web_or_account' ? 'mcp_playwright_browser_snapshot' : '',
    input.flow?.workTakeover.latestTask ? 'work_takeover_task_verify_result' : '',
    input.flow?.workSurfaceRoute.artifactFirst ? 'work_product_verify' : '',
  ]);
  const lane = input.capabilitySelection.lane;
  const taskId = input.flow?.workTakeover.latestTask?.id || '';

  return {
    applies: true,
    reason: inferReason(input),
    evidenceTools,
    actuationTools,
    verificationTools,
    promptOverlay: [
      '## Desktop Execution Stability',
      `Applies because ${inferReason(input)}. Lane=${lane}; primary=${input.capabilitySelection.primary}.`,
      taskId ? `Persistent task id: ${taskId}. Write blockers and verification evidence back to this task.` : '',
      'Ground rule: the screen is the source of truth. A command returning success, a cursor glow, or a planned step is not enough evidence.',
      'Before acting:',
      '- Read the active window/screen/UI tree first when a visible app, web page, or input field matters.',
      '- If the target app is already running in the taskbar/background, restore or focus it before opening a duplicate.',
      '- If the target local app path is unknown, use desktop_list_apps and then desktop_open; do not guess Program Files paths or generate a one-off launcher skill.',
      '- Prefer UIA/browser/control-tree actions when available; use raw mouse clicks only after locating the target from screen/UI evidence.',
      'While acting:',
      recoveredCurrentAppEdit
        ? '- Current-app editing is UIA-only: do not use computer_use, raw coordinate mouse actions, or untargeted keyboard typing.'
        : '- Use the appropriate actuation layer: UIA/browser controls first, clipboard for draft transfer, raw mouse/keyboard for visible targets, and vision computer_use when pixels are the only reliable route.',
      recoveredCurrentAppEdit
        ? '- After each UI invoke/click/Ctrl+N, take a fresh UIA snapshot. Do not repeat the same New/Blank selector.'
        : '',
      recoveredCurrentAppEdit
        ? '- Never type or paste until the fresh UIA tree exposes an editable Document/editor control; focus that exact control first.'
        : '',
      '- Move/show the visible cursor before click demonstrations when available, then click the resolved target, not a guessed coordinate.',
      '- For input fields, verify focus before typing; if typing does not appear, stop, refocus, and report the recovery attempt.',
      '- Close temporary windows/panels after their explanation in demos unless the user asked to leave them open.',
      'After acting:',
      '- Verify the active window, visible content, generated files, or draft text before saying it worked.',
      '- If an app did not open, an input field was missed, login was unavailable, or screen evidence is missing, say that exact blocker and the next recovery step.',
      evidenceTools.length ? `Evidence tools to prefer: ${evidenceTools.join(', ')}.` : '',
      actuationTools.length ? `Actuation tools to prefer: ${actuationTools.join(', ')}.` : '',
      verificationTools.length ? `Verification tools to prefer: ${verificationTools.join(', ')}.` : '',
      compact(input.text) ? `Newest user request: ${compact(input.text).slice(0, 220)}` : '',
    ].filter(Boolean).join('\n'),
  };
}
