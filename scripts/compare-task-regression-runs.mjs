#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  compareTaskRegressionRuns,
  stableTaskRegressionJson,
} from './lib/task-regression-matrix.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/compare-task-regression-runs.mjs \\',
    '    --baseline <baseline-run.json> --candidate <candidate-run.json> \\',
    '    [--expected-baseline-revision 28c08cd] [--expected-candidate-revision <git-oid>] \\',
    '    [--require-candidate-dirty] [--allow-dirty-baseline] [--pretty]',
    '',
    'Exit codes:',
    '  0  comparison is valid, all candidate scenarios pass, and none regressed',
    '  1  comparison is valid but its acceptance gate fails',
    '  2  arguments, files, JSON, or evidence artifacts are invalid',
  ].join('\n');
}

export function parseTaskRegressionComparisonArgs(argv) {
  const parsed = {
    baselinePath: null,
    candidatePath: null,
    expectedBaselineRevision: null,
    expectedCandidateRevision: null,
    requireCandidateDirty: false,
    requireBaselineClean: true,
    pretty: false,
    help: false,
  };
  const valueFlags = new Map([
    ['--baseline', 'baselinePath'],
    ['--candidate', 'candidatePath'],
    ['--expected-baseline-revision', 'expectedBaselineRevision'],
    ['--expected-candidate-revision', 'expectedCandidateRevision'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valueFlags.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`missing_value:${argument}`);
      parsed[valueFlags.get(argument)] = value;
      index += 1;
      continue;
    }
    if (argument === '--require-candidate-dirty') parsed.requireCandidateDirty = true;
    else if (argument === '--allow-dirty-baseline') parsed.requireBaselineClean = false;
    else if (argument === '--pretty') parsed.pretty = true;
    else if (argument === '--help' || argument === '-h') parsed.help = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (!parsed.help && (!parsed.baselinePath || !parsed.candidatePath)) {
    throw new Error('baseline_and_candidate_required');
  }
  return parsed;
}

function readJsonArtifact(filePath, label) {
  const resolved = path.resolve(filePath);
  let metadata;
  try {
    metadata = fs.lstatSync(resolved);
  } catch (error) {
    throw new Error(`${label}_file_unreadable:${error?.message || 'unknown'}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 256 * 1024 * 1024) {
    throw new Error(`${label}_file_invalid`);
  }
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY);
    const before = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`${label}_file_changed_during_read`);
    }
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (String(error?.message || '').startsWith(`${label}_file_changed_during_read`)) throw error;
    throw new Error(`${label}_json_invalid:${error?.message || 'unknown'}`);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

export function taskRegressionComparisonExitCode(comparison) {
  if (!comparison?.comparisonValid) return 2;
  return comparison.overallPassed ? 0 : 1;
}

export function runTaskRegressionComparisonCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const args = parseTaskRegressionComparisonArgs(argv);
    if (args.help) {
      stdout.write(`${usage()}\n`);
      return 0;
    }
    const baseline = readJsonArtifact(args.baselinePath, 'baseline');
    const candidate = readJsonArtifact(args.candidatePath, 'candidate');
    const comparison = compareTaskRegressionRuns(baseline, candidate, {
      expectedBaselineRevision: args.expectedBaselineRevision || undefined,
      expectedCandidateRevision: args.expectedCandidateRevision || undefined,
      requireCandidateDirty: args.requireCandidateDirty,
      requireBaselineClean: args.requireBaselineClean,
    });
    stdout.write(args.pretty
      ? `${JSON.stringify(comparison, null, 2)}\n`
      : `${stableTaskRegressionJson(comparison)}\n`);
    return taskRegressionComparisonExitCode(comparison);
  } catch (error) {
    stderr.write(`${JSON.stringify({
      kind: 'lumi.task-regression-comparison-error',
      error: error?.message || String(error),
    })}\n`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = runTaskRegressionComparisonCli(process.argv.slice(2));
}
