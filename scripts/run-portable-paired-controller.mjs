#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PORTABLE_PAIRED_CONTROLLER_BASELINE_REVISION,
} from './lib/portable-paired-controller-runtime.mjs';
import {
  runPortablePairedController,
  validatePortablePairedControllerReport,
} from './lib/portable-paired-controller.mjs';
import { stablePortableEvidenceJson } from './lib/portable-external-evidence.mjs';

export class PortablePairedControllerCliError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'PortablePairedControllerCliError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details) {
  throw new PortablePairedControllerCliError(code, details);
}

function integerFlag(value, name) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail('portable_paired_controller_cli_integer_invalid', { name });
  return parsed;
}

export function parsePortablePairedControllerCliArgs(argv) {
  if (!Array.isArray(argv)) fail('portable_paired_controller_cli_args_invalid');
  if (argv.length === 1 && argv[0] === '--help') return { command: 'help' };
  const allowed = new Set([
    '--baseline-worktree', '--candidate-worktree', '--output', '--baseline-revision',
    '--temp-base', '--run-nonce', '--turn-ms', '--provider-ms', '--passive-store-ms',
    '--settle-ms', '--startup-ms', '--long-provider-delay-ms',
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || String(value).startsWith('--')) {
      fail('portable_paired_controller_cli_flag_invalid', { flag });
    }
    if (Object.hasOwn(values, flag)) fail('portable_paired_controller_cli_flag_duplicate', { flag });
    values[flag] = value;
  }
  for (const flag of ['--baseline-worktree', '--candidate-worktree', '--output']) {
    if (!values[flag]) fail('portable_paired_controller_cli_flag_required', { flag });
  }
  const output = path.resolve(String(values['--output']));
  const numeric = {
    ...(values['--turn-ms'] ? { turnMs: integerFlag(values['--turn-ms'], '--turn-ms') } : {}),
    ...(values['--provider-ms'] ? { providerMs: integerFlag(values['--provider-ms'], '--provider-ms') } : {}),
    ...(values['--passive-store-ms'] ? {
      passiveStoreMs: integerFlag(values['--passive-store-ms'], '--passive-store-ms'),
    } : {}),
    ...(values['--settle-ms'] ? { settleMs: integerFlag(values['--settle-ms'], '--settle-ms') } : {}),
    ...(values['--startup-ms'] ? { startupMs: integerFlag(values['--startup-ms'], '--startup-ms') } : {}),
    ...(values['--long-provider-delay-ms'] ? {
      longProviderDelayMs: integerFlag(
        values['--long-provider-delay-ms'],
        '--long-provider-delay-ms',
      ),
    } : {}),
  };
  return {
    command: 'run',
    output,
    options: {
      baselineWorktree: path.resolve(String(values['--baseline-worktree'])),
      candidateWorktree: path.resolve(String(values['--candidate-worktree'])),
      expectedBaselineRevision: String(
        values['--baseline-revision'] || PORTABLE_PAIRED_CONTROLLER_BASELINE_REVISION,
      ).toLowerCase(),
      ...(values['--temp-base'] ? { tempBase: path.resolve(String(values['--temp-base'])) } : {}),
      ...(values['--run-nonce'] ? { runNonce: String(values['--run-nonce']) } : {}),
      ...numeric,
    },
  };
}

function help() {
  return [
    'Usage:',
    '  node scripts/run-portable-paired-controller.mjs',
    '    --baseline-worktree <clean-28c-worktree>',
    '    --candidate-worktree <candidate-worktree>',
    '    --output <report.json>',
    '',
    'The controller starts only isolated backend processes and loopback provider stubs.',
    'It never starts the native client and rejects non-clean/non-28c baselines.',
  ].join('\n');
}

function writeAtomicJson(filename, value) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(temporary, `${stablePortableEvidenceJson(value)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporary, filename);
}

export async function runPortablePairedControllerCli(argv, io = process) {
  let parsed;
  try { parsed = parsePortablePairedControllerCliArgs(argv); } catch (error) {
    io.stderr?.write?.(`${JSON.stringify({ ok: false, code: error?.code || 'cli_invalid' })}\n`);
    return 2;
  }
  if (parsed.command === 'help') {
    io.stdout?.write?.(`${help()}\n`);
    return 0;
  }
  try {
    const report = await runPortablePairedController(parsed.options);
    writeAtomicJson(parsed.output, report);
    const validation = validatePortablePairedControllerReport(report);
    io.stdout?.write?.(`${JSON.stringify({
      ok: validation.ok,
      complete: report.complete,
      behaviorPassed: report.behaviorPassed,
      output: parsed.output,
      reportSha256: report.reportSha256,
      issues: validation.issues,
    })}\n`);
    if (!validation.ok || report.complete !== true) return 2;
    return report.behaviorPassed === true ? 0 : 1;
  } catch (error) {
    io.stderr?.write?.(`${JSON.stringify({
      ok: false,
      code: String(error?.code || 'portable_paired_controller_failed'),
      details: error?.details || {},
    })}\n`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  process.exitCode = await runPortablePairedControllerCli(process.argv.slice(2));
}
