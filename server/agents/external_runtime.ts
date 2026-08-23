/**
 * External Agent Runtime
 *
 * Executes tasks on external agents (OpenClaw, Hermes, etc.) via CLI.
 * These agents run as child processes — Lumi dispatches a task, waits for
 * the result, and feeds it back into the orchestrator's aggregation pipeline.
 *
 * Security: commands are shell-quoted, tasks are capped at 4000 chars,
 * and execution has a configurable timeout.
 */

import { spawn } from 'child_process';

export interface ExternalAgentConfig {
  /** CLI command template. {task} is replaced with the task text. */
  command: string;
  /** Timeout in ms (default: 120000) */
  timeout?: number;
  /** Working directory for the process */
  cwd?: string;
  /** Durable authorization set only by the authenticated local administrator surface. */
  authorized?: boolean;
}

export interface ExternalResult {
  success: boolean;
  output: string;
  exitCode: number | null;
  durationMs: number;
}

function parseCommandTemplate(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaped || quote) throw new Error('External command contains an incomplete escape or quote.');
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Execute a task on an external agent via CLI.
 *
 * The command template supports one placeholder:
 *   {task} — replaced with the user's task text (shell-quoted)
 *
 * Examples:
 *   openclaw send --agent assistant --message "{task}"
 *   hermes chat --task "{task}"
 */
export async function executeExternalAgent(
  config: ExternalAgentConfig,
  task: string,
): Promise<ExternalResult> {
  const startTime = Date.now();
  const timeout = config.timeout || 120_000;
  if (config.authorized !== true) {
    return { success: false, output: 'External runtime is not authorized by the local administrator.', exitCode: -1, durationMs: 0 };
  }
  let template: string[];
  try {
    template = parseCommandTemplate(config.command);
  } catch (error: any) {
    return { success: false, output: error?.message || 'External command parsing failed.', exitCode: -1, durationMs: 0 };
  }
  const executable = template[0];
  const args = template.slice(1).map(value => value === '{task}' ? task.slice(0, 4000) : value);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(executable, args, {
      shell: false,
      cwd: config.cwd || process.cwd(),
      timeout,
      windowsHide: true,
    });

    const done = (success: boolean, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      const output = stdout.trim() || stderr.trim() || '(no output)';
      resolve({
        success,
        output: output.slice(0, 8000), // cap output
        exitCode,
        durationMs: Date.now() - startTime,
      });
    };

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      done(code === 0, code);
    });

    child.on('error', (err) => {
      stderr += err.message;
      done(false, -1);
    });

    setTimeout(() => {
      if (!settled) {
        child.kill('SIGTERM');
        done(false, null);
      }
    }, timeout + 2000); // 2s grace beyond timeout
  });
}

/**
 * Validate that a CLI command looks safe to execute.
 * Returns an error string if the command is rejected, null if OK.
 */
export function validateExternalCommand(command: string): string | null {
  const trimmed = command?.trim();
  if (!trimmed) {
    return 'External command is empty';
  }
  if (trimmed.length > 1500) {
    return 'External command is too long';
  }
  let tokens: string[];
  try {
    tokens = parseCommandTemplate(trimmed);
  } catch (error: any) {
    return error?.message || 'External command is invalid';
  }
  if (tokens.length < 2 || !tokens[0] || /[\0\r\n]/.test(tokens[0])) {
    return 'External command must contain an executable and arguments';
  }
  const placeholders = tokens.filter(token => token === '{task}');
  if (placeholders.length === 0) {
    return 'External command must include {task} placeholder';
  }
  if (placeholders.length > 1) {
    return 'External command must include exactly one {task} placeholder';
  }
  if (/[\r\n]/.test(trimmed)) {
    return 'External command cannot contain newlines';
  }

  const controlTokens = ['&&', '||', ';', '|', '>', '<', '`', '$(', '%COMSPEC%', '%CMD%', '${'];
  for (const token of controlTokens) {
    if (trimmed.includes(token)) return `Command contains shell control token: "${token}"`;
  }

  const lower = trimmed.toLowerCase();
  const blocked = [
    'rm -rf',
    'shutdown',
    'reboot',
    'format ',
    'diskpart',
    'del /f',
    'erase ',
    'rd /s',
    'rmdir /s',
    'remove-item',
    'stop-computer',
    'restart-computer',
    'mkfs',
    'dd if=',
  ];
  for (const b of blocked) {
    if (lower.includes(b)) return `Command contains blocked pattern: "${b}"`;
  }
  if (/^\s*(?:cmd|cmd\.exe)\s+\/c\b/i.test(trimmed)) {
    return 'External command cannot launch cmd /c';
  }
  if (/^\s*(?:powershell|pwsh)(?:\.exe)?\s+-(?:command|c|encodedcommand)\b/i.test(trimmed)) {
    return 'External command cannot launch inline PowerShell';
  }
  const executable = tokens[0].toLowerCase().replace(/^.*[\\/]/, '');
  if (/^(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|sh|bash|zsh|wscript(?:\.exe)?|cscript(?:\.exe)?)$/i.test(executable)) {
    return 'External command must invoke a dedicated agent CLI, not a general-purpose shell or script host';
  }
  if (tokens.some(token => token !== '{task}' && /\{task\}/.test(token))) {
    return 'The {task} placeholder must be one complete command argument';
  }
  return null;
}
