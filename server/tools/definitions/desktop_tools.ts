import { ToolRegistry } from '../registry';

async function desktopSystemInfo(_args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_system_info', {});
}

async function desktopListFiles(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  const routedTaskText = String(context?.routedTaskText || context?.actionIntent || '');
  const requestedPath = String(args.path || '').trim();
  const desktopFilesRequested = /(?:\u684c\u9762|\bdesktop\b).{0,24}(?:\u6587\u4ef6|\u6587\u4ef6\u5939|\u76ee\u5f55|\bfiles?\b|\bfolders?\b)/iu.test(routedTaskText);
  const desktopCountRequested = /(?:\u6587\u4ef6|\u6761\u76ee|\bfiles?\b|\bentries\b).{0,16}(?:\u6570\u91cf|\u591a\u5c11|\u51e0\u4e2a|\bcount\b|\bhow\s+many\b)|(?:\u6570\u91cf|\u591a\u5c11|\u51e0\u4e2a|\bcount\b|\bhow\s+many\b).{0,16}(?:\u6587\u4ef6|\u6761\u76ee|\bfiles?\b|\bentries\b)/iu.test(routedTaskText);
  const path = !requestedPath && desktopFilesRequested
    ? '~/Desktop'
    : requestedPath;
  const requestedLimit = Number(args.limit) || 100;
  return context.desktopRelay('desktop_list_files', {
    path,
    limit: desktopFilesRequested && desktopCountRequested
      ? Math.max(requestedLimit, 1000)
      : requestedLimit,
  });
}

async function desktopListApps(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_list_apps', {
    query: args.query || '',
    limit: args.limit || 80,
  });
}

async function desktopOpen(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_open', {
    target: args.target || '',
  });
}

async function desktopShowLumiWindow(_args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_show_lumi_window', {});
}

async function desktopPathInfo(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_path_info', {
    target: args.target || args.path || '',
  });
}

async function desktopRunCommand(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_run_command', {
    command: args.command || '',
    cwd: args.cwd || '',
  });
}

async function desktopIdleTime(_args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_idle_time', {});
}

async function desktopPollActivity(_args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Desktop tools require a Tauri frontend relay (not available in web mode)');
  }
  return context.desktopRelay('desktop_poll_activity', {});
}

export function registerDesktopTools(registry: ToolRegistry): void {
  registry.register({
    name: 'desktop_system_info',
    description:
      'Get real host system info (OS, CPU, memory, home directory) from the desktop machine. Use this instead of get_system_info when you need actual hardware details, not just the server process view.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: desktopSystemInfo,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_list_files',
    description:
      'List files and directories on the user\'s real desktop machine at the given path using the native desktop client. Prefer this for Desktop/Documents folders, Chinese filenames, file discovery, and verifying that a generated file really exists. Use "~/Desktop" for the user\'s Desktop and limit 1000 for a requested count/inventory; an empty path defaults to the home directory unless the current request explicitly asks for Desktop files. Returns name, path, type, size, and modified time.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list. Use "~/Desktop" for the user Desktop. Leave empty for home directory.' },
        limit: { type: 'number', description: 'Maximum entries to return (default 100).' },
      },
      required: [],
    },
    handler: desktopListFiles,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_open',
    description:
      'Open a file, folder, application, or URL using the OS default handler. For common apps, the native client first resolves launch history, Desktop shortcuts, Start Menu shortcuts, and known install paths, so app names like "微信", "WeChat", "WPS", "浏览器", "剪映", or "CAD" should be opened through this tool instead of guessing paths. This is the preferred way to visibly launch something on the user\'s desktop.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The file, folder, app name, or URL to open. Examples: "notepad.exe", "calc.exe", "C:\\Users", "https://github.com"' },
      },
      required: ['target'],
    },
    handler: desktopOpen,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_list_apps',
    description:
      'List launchable local desktop applications known by the native client. It checks successful launch history, Desktop shortcuts, Start Menu shortcuts, and common install paths. Use this before opening an app when the exact local path is unknown, especially for Chinese app names or user-specific installs.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional app name or alias to search, such as "微信", "WPS", "浏览器", "剪映", "CAD", "WeChat", or "VS Code".' },
        limit: { type: 'number', description: 'Maximum entries to return (default 80).' },
      },
      required: [],
    },
    handler: desktopListApps,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_show_lumi_window',
    description:
      'Bring the Lumi desktop window to the foreground using the native client. Use this to return Lumi to the user or recover focus before client/UI work; it does not control external applications.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: desktopShowLumiWindow,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_path_info',
    description:
      'Check whether an exact file or folder path exists on the user\'s real desktop machine. Use this after creating files, especially CAD/doc/image outputs, before telling the user the file is ready.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Exact file or folder path to check.' },
        path: { type: 'string', description: 'Alias for target.' },
      },
      required: [],
    },
    handler: desktopPathInfo,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_run_command',
    description:
      'Execute a shell command on the user\'s real desktop machine. Supports cmd.exe /C on Windows and sh -c on Linux/macOS. Use desktop_list_files for file discovery instead of shell dir/ls, especially for Unicode paths.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute on the host machine.' },
        cwd: { type: 'string', description: 'Working directory for the command. Leave empty for default.' },
      },
      required: ['command'],
    },
    handler: desktopRunCommand,
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'desktop_idle_time',
    description:
      'Read the current desktop idle-time signal from the native client. Use this to understand whether the user appears active or idle before proposing background/visible desktop work.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: desktopIdleTime,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_poll_activity',
    description:
      'Poll the native desktop activity snapshot, including foreground/idle signals exposed by the client. Use this for readiness checks, not for continuous surveillance.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: desktopPollActivity,
    permission: 'user',
    securityLevel: 'safe',
  });
}
