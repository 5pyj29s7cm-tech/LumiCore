export type CommandHostPlatform = NodeJS.Platform | 'windows' | 'macos';

export type CommandValidationCode =
  | 'empty_command'
  | 'shell_control_operator'
  | 'nested_shell_command'
  | 'unsupported_platform_command';

export interface CommandValidationResult {
  ok: boolean;
  platform: NodeJS.Platform;
  executable: string;
  code?: CommandValidationCode;
  reason?: string;
}

function normalizePlatform(platform: CommandHostPlatform): NodeJS.Platform {
  if (platform === 'windows') return 'win32';
  if (platform === 'macos') return 'darwin';
  return platform;
}

function parseExecutable(command: string): { executable: string; remainder: string } {
  const trimmed = command.trim();
  const match = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))(?:\s+([\s\S]*))?$/);
  const executable = String(match?.[1] || match?.[2] || match?.[3] || '');
  return { executable, remainder: String(match?.[4] || '').trim() };
}

function executableName(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return (normalized.split('/').pop() || normalized).toLowerCase().replace(/\.exe$/i, '');
}

function findShellControlOperator(command: string, platform: NodeJS.Platform): string | null {
  let quote: 'single' | 'double' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1] || '';
    if (char === '\r' || char === '\n') return 'newline';

    if (platform === 'win32' && char === '^' && quote === null) {
      index += 1;
      continue;
    }
    if (platform !== 'win32' && char === '\\' && quote !== 'single') {
      index += 1;
      continue;
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }

    // Command substitution is executable even inside POSIX double quotes and
    // is unsafe in an otherwise allowlisted raw shell string.
    if (quote !== 'single' && (char === '`' || (char === '$' && next === '('))) {
      return char === '`' ? '`' : '$(';
    }
    if (quote === null && /[&|;<>]/.test(char)) return char;
  }
  return null;
}

export function validateCommandForHost(
  rawCommand: unknown,
  rawPlatform: CommandHostPlatform = process.platform,
): CommandValidationResult {
  const command = String(rawCommand || '').trim();
  const platform = normalizePlatform(rawPlatform);
  if (!command) {
    return {
      ok: false,
      platform,
      executable: '',
      code: 'empty_command',
      reason: 'No command was provided.',
    };
  }

  const shellOperator = findShellControlOperator(command, platform);
  const parsed = parseExecutable(command);
  const name = executableName(parsed.executable);
  if (shellOperator) {
    return {
      ok: false,
      platform,
      executable: name,
      code: 'shell_control_operator',
      reason: `Raw shell control operator "${shellOperator}" is not allowed. Use one structured command per tool call.`,
    };
  }

  if (platform === 'win32') {
    const normalizedExecutable = parsed.executable.replace(/\\/g, '/').toLowerCase();
    const nestedShell = name === 'cmd'
      || name === '%comspec%'
      || ['wscript', 'cscript', 'mshta'].includes(name)
      || ['powershell', 'pwsh'].includes(name);
    if (nestedShell) {
      return {
        ok: false,
        platform,
        executable: name,
        code: 'nested_shell_command',
        reason: `Nested shell or script-host command "${parsed.executable}" is not allowed through the raw command adapter. Use a structured executable and argument list.`,
      };
    }
    if (
      normalizedExecutable.startsWith('/bin/')
      || ['rm', 'sh', 'bash', 'zsh', 'sudo'].includes(name)
    ) {
      return {
        ok: false,
        platform,
        executable: name,
        code: 'unsupported_platform_command',
        reason: `Command "${parsed.executable}" is a POSIX command and cannot run through the Windows command adapter.`,
      };
    }
    if (name === 'find' && /^(?:\/(?:\s|$)|~(?:[\\/]|\s|$))/.test(parsed.remainder)) {
      return {
        ok: false,
        platform,
        executable: name,
        code: 'unsupported_platform_command',
        reason: 'POSIX find path syntax is not supported on Windows. Use the native desktop file tools.',
      };
    }
  } else if (['cmd', 'findstr', 'taskmgr'].includes(name)) {
    return {
      ok: false,
      platform,
      executable: name,
      code: 'unsupported_platform_command',
      reason: `Command "${parsed.executable}" is Windows-specific and cannot run on ${platform}.`,
    };
  }

  return { ok: true, platform, executable: name };
}

export function assertValidCommandForHost(
  command: unknown,
  platform: CommandHostPlatform = process.platform,
): CommandValidationResult {
  const result = validateCommandForHost(command, platform);
  if (!result.ok) {
    const error = new Error(result.reason || 'Command is not valid for this host platform');
    error.name = 'CommandPlatformValidationError';
    Object.assign(error, { code: result.code, platform: result.platform });
    throw error;
  }
  return result;
}
