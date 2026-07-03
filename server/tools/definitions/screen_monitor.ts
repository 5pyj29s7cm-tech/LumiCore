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
  return context.desktopRelay('desktop_running_processes', {
    top: args.top || 30,
  });
}

async function captureScreen(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Screen monitoring requires the Tauri desktop app');
  }
  return context.desktopRelay('desktop_capture_screen', {
    quality: args.quality || 60,
  });
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
  });

  registry.register({
    name: 'get_running_processes',
    description:
      'Get the list of running processes on the user\'s desktop, sorted by CPU usage. Includes process name, PID, CPU%, and memory usage. Use this to understand the user\'s overall activity context: what apps are open, what is consuming resources, and what the user is likely working on.',
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
      'Alias for get_running_processes. Get running processes from the user desktop so Lumi can detect whether external apps such as WeChat, WPS, CAD, Revit, browsers, or editors are actually running.',
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
