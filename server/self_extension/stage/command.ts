import { spawn } from "node:child_process";
import type { CommandRunner, CommandResult } from './contracts';
import { parsePorcelainStatus } from './patch_policy';

// Static autonomous documentation permits files up to 1 MB. Keep enough
// command output to materialize that upper bound, then independently verify
// the exact Git blob id before applying any patch. The hash check below still
// fails closed if this capture limit is ever exceeded.
const MAX_COMMAND_OUTPUT = 1_100_000;

export async function worktreeChangePaths(runner: CommandRunner, worktreePath: string): Promise<string[]> {
  const status = await runChecked(
    runner,
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    worktreePath,
    30_000,
  );
  return parsePorcelainStatus(status.stdout);
}

export async function defaultCommandRunner(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: env || process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const append = (current: string, chunk: unknown) => (
      `${current}${String(chunk || '')}`.slice(-MAX_COMMAND_OUTPUT)
    );
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

export async function runChecked(
  runner: CommandRunner,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const result = await runner(command, args, cwd, timeoutMs, env);
  if (result.exitCode !== 0) {
    const detail = `${result.stderr || result.stdout}`.replace(/\s+/g, ' ').trim().slice(0, 900);
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed with exit ${result.exitCode}: ${detail}`);
  }
  return result;
}
