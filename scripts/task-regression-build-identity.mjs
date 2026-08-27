#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  computeTaskRegressionBuildIdentity,
  projectTaskRegressionMatrixBuildIdentity,
  stableTaskRegressionBuildIdentityJson,
  TaskRegressionBuildIdentityError,
} from './lib/task-regression-build-identity.mjs';

function parseArgs(argv) {
  const result = {
    root: process.cwd(),
    pretty: false,
    help: false,
    runtimeArtifactPath: null,
    runtimeArtifactSha256: null,
    collectedAt: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--root') {
      const root = argv[index + 1];
      if (!root || root.startsWith('--')) throw new TaskRegressionBuildIdentityError('cli_root_required');
      result.root = path.resolve(root);
      index += 1;
    } else if (value === '--pretty') {
      result.pretty = true;
    } else if (value === '--runtime-fingerprint-sha256') {
      const digest = argv[index + 1];
      if (!digest || digest.startsWith('--') || result.runtimeArtifactSha256 !== null) {
        throw new TaskRegressionBuildIdentityError('cli_runtime_fingerprint_sha256_required');
      }
      result.runtimeArtifactSha256 = digest;
      index += 1;
    } else if (value === '--runtime-artifact') {
      const artifactPath = argv[index + 1];
      if (!artifactPath || artifactPath.startsWith('--') || result.runtimeArtifactPath !== null) {
        throw new TaskRegressionBuildIdentityError('cli_runtime_artifact_required');
      }
      result.runtimeArtifactPath = path.resolve(artifactPath);
      index += 1;
    } else if (value === '--collected-at') {
      const collectedAt = argv[index + 1];
      if (!collectedAt || collectedAt.startsWith('--') || result.collectedAt !== null) {
        throw new TaskRegressionBuildIdentityError('cli_collected_at_required');
      }
      result.collectedAt = collectedAt;
      index += 1;
    } else if (value === '--help' || value === '-h') {
      result.help = true;
    } else {
      throw new TaskRegressionBuildIdentityError('cli_argument_invalid');
    }
  }
  return result;
}

export function taskRegressionBuildIdentityCli(argv = process.argv.slice(2), io = process) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      io.stdout.write([
        'Usage: node scripts/task-regression-build-identity.mjs [options]',
        '',
        'Options:',
        '  --root <repository>  Git worktree to identify (defaults to cwd)',
        '  --runtime-fingerprint-sha256 <sha256>',
        '                         Project to the matrix identity using an independently',
        '                         computed SHA-256 of the exact runtime artifact under test',
        '  --runtime-artifact <absolute-file>',
        '                         Verify the supplied SHA-256 against the exact artifact',
        '  --collected-at <iso>   Canonical UTC millisecond timestamp for the projection',
        '  --pretty             Pretty-print JSON',
        '  --help               Show this help',
        '',
      ].join('\n'));
      return 0;
    }
    if (args.collectedAt && !args.runtimeArtifactSha256) {
      throw new TaskRegressionBuildIdentityError('cli_collected_at_requires_runtime_fingerprint');
    }
    if (args.runtimeArtifactSha256 && !args.runtimeArtifactPath) {
      throw new TaskRegressionBuildIdentityError('cli_runtime_artifact_required');
    }
    if (args.runtimeArtifactPath && !args.runtimeArtifactSha256) {
      throw new TaskRegressionBuildIdentityError('cli_runtime_artifact_requires_fingerprint');
    }
    const identity = computeTaskRegressionBuildIdentity(args.root);
    const output = args.runtimeArtifactSha256
      ? projectTaskRegressionMatrixBuildIdentity(identity, {
        runtimeArtifactPath: args.runtimeArtifactPath,
        runtimeArtifactSha256: args.runtimeArtifactSha256,
        collectedAt: args.collectedAt || new Date().toISOString(),
      })
      : identity;
    io.stdout.write(`${stableTaskRegressionBuildIdentityJson(output, args.pretty)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof TaskRegressionBuildIdentityError
      ? error.code
      : 'build_identity_failed';
    io.stderr.write(`${stableTaskRegressionBuildIdentityJson({ ok: false, error: code })}\n`);
    return 1;
  }
}

function isDirectExecution() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectExecution()) process.exitCode = taskRegressionBuildIdentityCli();
