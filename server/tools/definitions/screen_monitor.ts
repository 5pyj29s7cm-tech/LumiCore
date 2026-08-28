import { ToolRegistry } from '../registry';

async function getActiveWindowInfo(_args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Screen monitoring requires the Tauri desktop app');
  }
  return context.desktopRelay('desktop_active_window', {});
}

async function getRunningProcesses(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Screen monitoring requires the Tauri desktop app');
  }
  const raw = await context.desktopRelay('desktop_running_processes', {
    top: args.top || 30,
  });
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(parsed)) return raw;
    const top = Math.max(1, Math.min(50, Number(args.top) || 30));
    return JSON.stringify(parsed.slice(0, top));
  } catch {
    return raw;
  }
}

async function captureScreen(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Screen monitoring requires the Tauri desktop app');
  }
  return context.desktopRelay('desktop_capture_screen', {
    quality: args.quality || 60,
  });
}

function parseDesktopJson(raw: string): Record<string, any> {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function windowMatchesTarget(window: Record<string, any>, target: string): boolean {
  const expected = String(target || '').normalize('NFKC').toLowerCase().replace(/\.exe$/i, '').replace(/[^\p{L}\p{N}]+/gu, '');
  if (!expected) return true;
  const actual = `${window.title || ''} ${window.process_name || window.processName || ''}`
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\.exe\b/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return Boolean(actual && (actual.includes(expected) || expected.includes(actual)));
}

async function controlActiveWindow(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) throw new Error('Window control requires the Tauri desktop app');
  const action = String(args.action || '').trim().toLowerCase();
  const expectedTarget = String(args.expectedTarget || '').trim();
  let active = parseDesktopJson(await context.desktopRelay('desktop_active_window', {}));
  if (expectedTarget && !windowMatchesTarget(active, expectedTarget)) {
    await context.desktopRelay('desktop_open', { target: expectedTarget });
    await new Promise(resolve => setTimeout(resolve, 350));
    active = parseDesktopJson(await context.desktopRelay('desktop_active_window', {}));
  }
  if (expectedTarget && !windowMatchesTarget(active, expectedTarget)) {
    return JSON.stringify({
      ok: false,
      status: 'target_mismatch',
      action,
      expectedTarget,
      targetMatched: false,
      activeWindow: active,
    }, null, 2);
  }
  const controlled = parseDesktopJson(await context.desktopRelay('desktop_window_control', { action }));
  return JSON.stringify({
    ...controlled,
    expectedTarget,
    targetMatched: expectedTarget ? windowMatchesTarget(controlled.after || active, expectedTarget) : true,
  }, null, 2);
}

export function registerScreenMonitorTools(registry: ToolRegistry): void {
  registry.register({
    name: 'get_active_window_info',
    description:
      'Get the currently focused/foreground window title and process name on the user\'s desktop. Use this to understand what the user is currently working on and provide contextual suggestions.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: getActiveWindowInfo,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_active_window',
    description:
      'Alias for get_active_window_info. Get the currently focused/foreground window title and process name on the user desktop. Use this before and after visible desktop actions to verify the real active window.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: getActiveWindowInfo,
    permission: 'user',
    securityLevel: 'safe',
    evidence: {
      capability: 'desktop.window.observe',
      operation: 'observe',
      assurance: 'observed',
    },
  });

  registry.register({
    name: 'desktop_window_control',
    description: 'Maximize, minimize, or restore the real foreground external application window. Pass expectedTarget for referential requests so Lumi verifies or focuses the intended application before acting and never controls its own window by accident.',
    // i18n-allow: Chinese input-recognition vocabulary; not user-visible copy.
    routingHints: ['\u6700\u5927\u5316\u7a97\u53e3', '\u6700\u5c0f\u5316\u7a97\u53e3', '\u8fd8\u539f\u7a97\u53e3', 'maximize app', 'minimize window', 'restore window'],
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['maximize', 'minimize', 'restore'], description: 'Requested window state change.' },
        expectedTarget: { type: 'string', description: 'Optional application target recovered from a verified desktop_open receipt or named by the user.' },
      },
      required: ['action'],
    },
    handler: controlActiveWindow,
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'desktop.window.control',
      family: 'desktop',
      lane: 'desktop',
      operation: 'mutate',
      risk: 'low',
      sideEffects: [{ type: 'desktop_control', scope: 'verified foreground window', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['verification.status'],
        successSignals: ['foreground window state matches the requested state'],
        limitations: ['The target identity must match before the native state change is accepted.'],
      },
    },
    evidence: {
      capability: 'desktop.window.control',
      operation: 'mutate',
      assurance: 'verified',
      subjectArgument: 'expectedTarget',
    },
  });

  registry.register({
    name: 'get_running_processes',
    description:
      'Get a bounded snapshot of running process entries on the user\'s desktop. Includes process name, PID, normalized whole-machine CPU share (0-100), and memory usage. Supported WPS/Microsoft Office authoring processes are prioritized and may also include window_title/window_titles for their visible top-level document windows; other application titles are intentionally omitted. Multiple entries may belong to one app, and the bounded snapshot is not a count of all open applications or windows.',
    parameters: {
      type: 'object',
      properties: {
        top: { type: 'number', description: 'Maximum number of processes to return. Default 30.' },
      },
      required: [],
    },
    handler: getRunningProcesses,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_running_processes',
    description:
      'Alias for get_running_processes. Get a bounded running-process snapshot from the user desktop. For current-document work, use its visible WPS/Microsoft Office window_title/window_titles as background candidates only when exactly one supported document title is present; otherwise ask the user to focus the intended document. Do not treat the number of process entries as the total number of open apps or windows.',
    parameters: {
      type: 'object',
      properties: {
        top: { type: 'number', description: 'Maximum number of processes to return. Default 30.' },
      },
      required: [],
    },
    handler: getRunningProcesses,
    permission: 'user',
    securityLevel: 'safe',
    evidence: {
      capability: 'desktop_processes',
      operation: 'observe',
      assurance: 'measured',
    },
  });

  registry.register({
    name: 'capture_screen',
    description:
      'Capture a screenshot of the user\'s primary monitor and save it to disk. Returns the file path and dimensions. Use this sparingly when the user asks Lumi to look at the screen or when a desktop task needs current visual confirmation; do not use it for continuous surveillance.',
    parameters: {
      type: 'object',
      properties: {
        quality: { type: 'number', description: 'JPEG quality 1-100. Default 60 (smaller file).' },
      },
      required: [],
    },
    handler: captureScreen,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_capture_screen',
    description:
      'Alias for capture_screen. Capture a fresh screenshot of the primary monitor for visible desktop verification. Use sparingly and only for current task context.',
    parameters: {
      type: 'object',
      properties: {
        quality: { type: 'number', description: 'JPEG quality 1-100. Default 60 (smaller file).' },
      },
      required: [],
    },
    handler: captureScreen,
    permission: 'user',
    securityLevel: 'safe',
  });
}
