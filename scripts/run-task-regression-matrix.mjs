#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  IMPLEMENTED_BLACK_BOX_SCENARIOS,
  runTaskRegressionBlackBoxProbe,
  stableTaskRegressionProbeJson,
  taskRegressionProbeExitCode,
} from './lib/task-regression-black-box-runner.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/run-task-regression-matrix.mjs --worktree <absolute-path> --role <baseline|candidate> [options]',
    '',
    'Options:',
    `  --scenarios <ids>          Comma-separated ids or ordinals; default ${IMPLEMENTED_BLACK_BOX_SCENARIOS.join(',')}`,
    '  --output <absolute-json>   Write the fail-closed probe report in addition to stdout',
    '  --temp-base <absolute-dir> Owned temporary parent; defaults to the OS temporary directory',
    '  --startup-timeout-ms <n>   Backend startup deadline (10s..180s)',
    '  --turn-timeout-ms <n>      Per-turn deadline (5s..120s)',
    '',
    'The runner never starts a GUI client, never reads the product LumiOS/LumiCore data roots,',
    'never inherits model secrets, and always deletes its owned data root. Exit 0 is reserved',
    'for an exact eight-scenario probe that is assembled and independently revalidated as a',
    'lumi.task-regression-run.v1 artifact. Exit 2 means evidence remains incomplete. This',
    'isolated backend matrix never claims native-client, microphone, WPS, OS, or Stage 9 acceptance.',
  ].join('\n');
}

function integer(value, name, minimum, maximum) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name}_invalid`);
  }
  return parsed;
}

function parseArgs(argv) {
  const output = {
    worktree: '',
    role: '',
    scenarios: null,
    output: '',
    tempBase: '',
    startupTimeoutMs: 90_000,
    turnTimeoutMs: 45_000,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') { output.help = true; continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing_value_for_${flag}`);
    index += 1;
    if (flag === '--worktree') output.worktree = value;
    else if (flag === '--role') output.role = value;
    else if (flag === '--scenarios') output.scenarios = value.split(',').map(item => item.trim()).filter(Boolean);
    else if (flag === '--output') output.output = value;
    else if (flag === '--temp-base') output.tempBase = value;
    else if (flag === '--startup-timeout-ms') output.startupTimeoutMs = integer(value, 'startup_timeout', 10_000, 180_000);
    else if (flag === '--turn-timeout-ms') output.turnTimeoutMs = integer(value, 'turn_timeout', 5_000, 120_000);
    else throw new Error(`unknown_option_${flag}`);
  }
  if (output.help) return output;
  if (!path.isAbsolute(output.worktree)) throw new Error('absolute_worktree_required');
  if (!['baseline', 'candidate'].includes(output.role)) throw new Error('role_required');
  if (output.output && !path.isAbsolute(output.output)) throw new Error('absolute_output_required');
  if (output.tempBase && !path.isAbsolute(output.tempBase)) throw new Error('absolute_temp_base_required');
  return output;
}

async function writeOutput(filename, serialized) {
  const parent = path.dirname(filename);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('output_parent_not_safe');
  const temporary = path.join(parent, `.${path.basename(filename)}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(temporary, `${serialized}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    await fsp.rename(temporary, filename);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error?.message || error}\n\n${usage()}\n`);
  process.exitCode = 1;
}

if (args?.help) {
  process.stdout.write(`${usage()}\n`);
  process.exitCode = 2;
} else if (args) {
  const report = await runTaskRegressionBlackBoxProbe({
    worktree: args.worktree,
    role: args.role,
    scenarios: args.scenarios,
    tempBase: args.tempBase || undefined,
    startupTimeoutMs: args.startupTimeoutMs,
    turnTimeoutMs: args.turnTimeoutMs,
  });
  const serialized = stableTaskRegressionProbeJson(report, true);
  if (args.output) await writeOutput(args.output, serialized);
  process.stdout.write(`${serialized}\n`);
  process.exitCode = taskRegressionProbeExitCode(report);
}
