import { exec } from 'child_process';
import os from 'os';
import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { assertValidCommandForHost } from '../command_platform';

const DEFAULT_ALLOWED_COMMANDS = new Set([
  'ls', 'dir', 'cat', 'type', 'echo', 'find', 'grep',
  'node', 'npm', 'npx', 'git', 'python', 'python3', 'pip', 'pip3',
  'curl', 'wget', 'pwd', 'whoami', 'date', 'ps', 'netstat',
  'df', 'du', 'head', 'tail', 'wc', 'sort', 'uniq',
  'touch', 'mkdir', 'cp', 'mv', 'chmod', 'chown',
  'which', 'where', 'printenv', 'gh', 'docker',
]);

function getAllowedCommands(): Set<string> {
  const envOverride = process.env.LUMI_ALLOWED_COMMANDS;
  if (envOverride) {
    return new Set(envOverride.split(',').map(c => c.trim().toLowerCase()).filter(Boolean));
  }
  return DEFAULT_ALLOWED_COMMANDS;
}

export function assertAllowlistedRunCommand(
  rawCommand: unknown,
  platform: NodeJS.Platform = process.platform,
): ReturnType<typeof assertValidCommandForHost> {
  const validation = assertValidCommandForHost(rawCommand, platform);
  const allowedCommands = getAllowedCommands();
  if (!allowedCommands.has(validation.executable)) {
    const error = new Error(
      `Command "${validation.executable}" is not in the allowlist. ` +
      `Allowed commands: ${Array.from(allowedCommands).sort().join(', ')}`
    ) as Error & { code?: string; platform?: NodeJS.Platform };
    error.name = 'CommandAllowlistValidationError';
    error.code = 'command_not_allowlisted';
    error.platform = validation.platform;
    throw error;
  }
  return validation;
}

async function runCommandHandler(args: Record<string, any>): Promise<string> {
  const command = String(args.command || '');
  if (!command.trim()) {
    throw new Error('No command provided.');
  }

  assertAllowlistedRunCommand(command, process.platform);

  return new Promise((resolve) => {
    exec(command, {
      timeout: 30000,
      maxBuffer: 500 * 1024,
      cwd: process.cwd(),
    }, (error, stdout, stderr) => {
      if (error) {
        resolve(JSON.stringify({
          ok: false,
          status: 'failed',
          exitCode: typeof error.code === 'number' ? error.code : null,
          stdout,
          stderr: stderr || error.message,
        }, null, 2));
      } else {
        resolve(JSON.stringify({
          ok: true,
          status: 'completed',
          exitCode: 0,
          stdout,
          stderr,
        }, null, 2));
      }
    });
  });
}

async function getSystemInfoHandler(): Promise<string> {
  const info = {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
    freeMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
    uptimeSeconds: Math.round(os.uptime()),
    cpuCount: os.cpus().length,
    homeDir: os.homedir(),
    cwd: process.cwd(),
    nodeVersion: process.version,
    pid: process.pid,
  };
  return JSON.stringify(info, null, 2);
}

export function registerSystemOpsTools(registry: ToolRegistry): void {
  registry.register({
    name: 'run_command',
    description: 'Execute a shell command. Only allowlisted commands can run. Use for git, npm, file ops, system queries.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
      },
      required: ['command'],
    },
    preflight: args => {
      assertAllowlistedRunCommand(args.command, process.platform);
    },
    handler: runCommandHandler,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'system.command.run',
      family: 'system_command',
      lane: 'system',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [{ type: 'process_execution', scope: 'allowlisted local command', reversible: false }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'exitCode'],
        requiredValues: { ok: true, status: 'completed', exitCode: 0 },
        successStatuses: ['completed'],
        successSignals: ['the allowlisted process exited with code zero'],
        limitations: ['Exit code zero does not independently verify every external state change made by the command.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'system.command.run',
      operation: 'mutate',
      subjectArgument: 'command',
      limitations: ['Command-specific artifacts or state changes require a stronger follow-up capability.'],
    }),
  });

  registry.register({
    name: 'get_system_info',
    description: 'Get system information including OS, CPU, memory, uptime, and Node.js version.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: getSystemInfoHandler,
    permission: 'public',
    securityLevel: 'safe',
  });
}
