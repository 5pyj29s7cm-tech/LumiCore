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
  return context.desktopRelay('desktop_list_files', {
    path: args.path || '',
    limit: args.limit || 100,
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
      'List files and directories on the user\'s real desktop machine at the given path using the native desktop client. Prefer this for Desktop/Documents folders, Chinese filenames, file discovery, and verifying that a generated file really exists. Defaults to the home directory. Returns name, path, type, size, and modified time.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list. Leave empty for home directory.' },
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
}
