import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertTaskRegressionBuildIdentity,
  computeTaskRegressionBuildIdentity,
  isSelectedTaskRegressionUntrackedSource,
  projectTaskRegressionMatrixBuildIdentity,
  stableTaskRegressionBuildIdentityJson,
  TASK_REGRESSION_MATRIX_BUILD_IDENTITY_KIND,
  TaskRegressionBuildIdentityError,
  verifyTaskRegressionBuildIdentity,
} from '../scripts/lib/task-regression-build-identity.mjs';
import {
  validateTaskRegressionBuildIdentity as validateMatrixBuildIdentity,
} from '../scripts/lib/task-regression-matrix.mjs';

const roots: string[] = [];
const environment = {
  platform: 'win32',
  architecture: 'x64',
  nodeVersion: '22.14.0',
  nodeAbi: '127',
};

function runGit(root: string, args: string[]) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`fixture git failed: ${args[0]}`);
  return result.stdout.trim();
}

function write(root: string, relativePath: string, content: string | Buffer) {
  const destination = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function hash(value: string) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function runtimeArtifact(root: string, content: string) {
  const relativePath = 'dist/runtime-under-test.bin';
  write(root, relativePath, content);
  return {
    path: path.resolve(root, ...relativePath.split('/')),
    sha256: hash(content),
  };
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-build-identity-'));
  roots.push(root);
  runGit(root, ['init', '--quiet']);
  runGit(root, ['config', 'user.name', 'Lumi Test']);
  runGit(root, ['config', 'user.email', 'lumi-test@example.invalid']);
  runGit(root, ['config', 'core.autocrlf', 'false']);
  write(root, 'server/task.ts', 'export const task = 1;\n');
  write(root, 'package-lock.json', '{\n  "lockfileVersion": 3\n}\n');
  runGit(root, ['add', '--all']);
  runGit(root, ['commit', '--quiet', '-m', 'baseline']);
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('task regression build identity', () => {
  it('identifies a dirty candidate beyond HEAD and is deterministic', () => {
    const root = repository();
    const head = runGit(root, ['rev-parse', 'HEAD']);
    const clean = computeTaskRegressionBuildIdentity(root, { environment });
    write(root, 'server/task.ts', 'export const task = 2;\n');
    const dirty = computeTaskRegressionBuildIdentity(root, { environment });
    const repeated = computeTaskRegressionBuildIdentity(root, { environment });

    expect(dirty.candidate.headCommit).toBe(head);
    expect(clean.candidate.headCommit).toBe(head);
    expect(dirty.candidate.dirty).toBe(true);
    expect(dirty.candidate.trackedChanges.files).toMatchObject([
      { path: 'server/task.ts', change: 'modified' },
    ]);
    expect(dirty.sourceFingerprint).not.toBe(clean.sourceFingerprint);
    expect(dirty.buildIdentity).not.toBe(clean.buildIdentity);
    expect(dirty.buildIdentity).toBe(repeated.buildIdentity);
    expect(verifyTaskRegressionBuildIdentity(dirty)).toEqual({ ok: true, errors: [] });
  });

  it('sorts selected untracked sources and ignores secrets and runtime output', () => {
    const root = repository();
    write(root, 'test/zeta.test.ts', 'export const zeta = true;\n');
    write(root, 'scripts/alpha.mjs', 'export const alpha = true;\n');
    write(root, '.env', 'LUMI_SECRET=do-not-serialize\n');
    write(root, 'artifacts/generated.ts', 'export const artifact = true;\n');

    const identity = computeTaskRegressionBuildIdentity(root, { environment });
    expect(identity.candidate.selectedUntrackedSources.files.map((entry: any) => entry.path)).toEqual([
      'scripts/alpha.mjs',
      'test/zeta.test.ts',
    ]);
    const serialized = stableTaskRegressionBuildIdentityJson(identity);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('do-not-serialize');
    expect(serialized).not.toContain('LUMI_SECRET');
    expect(serialized).not.toContain('export const alpha');
    expect(identity.privacy).toEqual({
      absolutePathsIncluded: false,
      fileContentsIncluded: false,
      processEnvironmentIncluded: false,
      repositoryRelativePathsOnly: true,
    });
  });

  it('includes legal nested source directories while excluding known generated roots', () => {
    const root = repository();
    write(root, 'server/data/new.ts', 'export const nestedDataSource = true;\n');
    write(root, 'src/build/worker.ts', 'export const nestedBuildSource = true;\n');
    write(root, 'build/generated.ts', 'export const rootBuildOutput = true;\n');
    write(root, 'data/generated.ts', 'export const rootDataOutput = true;\n');
    write(root, 'src-tauri/target/generated.rs', 'pub const GENERATED: bool = true;\n');

    const identity = computeTaskRegressionBuildIdentity(root, { environment });
    expect(identity.candidate.selectedUntrackedSources.files.map((entry: any) => entry.path)).toEqual([
      'server/data/new.ts',
      'src/build/worker.ts',
    ]);
    expect(identity.candidate.dirty).toBe(true);
    expect(verifyTaskRegressionBuildIdentity(identity)).toEqual({ ok: true, errors: [] });
  });

  it('normalizes UTF-8 BOM and line endings for cross-platform text identity', () => {
    const root = repository();
    write(root, 'server/task.ts', 'export const task = 3;\nexport const next = true;\n');
    const lf = computeTaskRegressionBuildIdentity(root, { environment });
    write(root, 'server/task.ts', '\uFEFFexport const task = 3;\r\nexport const next = true;\r\n');
    const crlf = computeTaskRegressionBuildIdentity(root, { environment });

    expect(crlf.sourceFingerprint).toBe(lf.sourceFingerprint);
    expect(crlf.buildIdentity).toBe(lf.buildIdentity);
    expect(crlf.candidate.trackedChanges.files[0].content.normalization).toBe('utf8_bomless_lf');
  });

  it('includes dependency lockfiles and allowlisted build environment', () => {
    const root = repository();
    const win = computeTaskRegressionBuildIdentity(root, { environment });
    const mac = computeTaskRegressionBuildIdentity(root, {
      environment: { ...environment, platform: 'darwin', architecture: 'arm64' },
    });

    expect(win.candidate.dependencyLockfiles.files).toMatchObject([
      {
        path: 'package-lock.json',
        provenance: 'tracked',
        state: 'present',
        content: { normalization: 'utf8_bomless_lf' },
      },
    ]);
    expect(win.environment).toMatchObject({
      platform: 'win32', architecture: 'x64', nodeVersion: '22.14.0', nodeAbi: '127',
    });
    expect(mac.sourceFingerprint).toBe(win.sourceFingerprint);
    expect(mac.buildIdentity).not.toBe(win.buildIdentity);
  });

  it('treats an untracked dependency lockfile as candidate state', () => {
    const root = repository();
    write(root, 'packages/worker/pnpm-lock.yaml', 'lockfileVersion: 9\n');
    const identity = computeTaskRegressionBuildIdentity(root, { environment });

    expect(identity.candidate.dirty).toBe(true);
    expect(identity.candidate.selectedUntrackedSources.count).toBe(0);
    expect(identity.candidate.dependencyLockfiles.files).toContainEqual(
      expect.objectContaining({
        path: 'packages/worker/pnpm-lock.yaml',
        provenance: 'untracked',
        state: 'present',
      }),
    );
    expect(verifyTaskRegressionBuildIdentity(identity)).toEqual({ ok: true, errors: [] });
  });

  it('records a staged lockfile deletion explicitly', () => {
    const root = repository();
    fs.rmSync(path.join(root, 'package-lock.json'));
    runGit(root, ['add', '--update']);
    const identity = computeTaskRegressionBuildIdentity(root, { environment });

    expect(identity.candidate.dependencyLockfiles.files).toContainEqual({
      path: 'package-lock.json',
      provenance: 'tracked',
      state: 'deleted',
      content: null,
    });
    expect(identity.candidate.trackedChanges.files).toContainEqual(
      expect.objectContaining({ path: 'package-lock.json', change: 'deleted', content: null }),
    );
    expect(verifyTaskRegressionBuildIdentity(identity)).toEqual({ ok: true, errors: [] });
  });

  it('rejects a HEAD-only lookalike and tampered manifests', () => {
    const root = repository();
    const identity = computeTaskRegressionBuildIdentity(root, { environment });
    const headOnly = {
      ok: true,
      kind: identity.kind,
      schemaVersion: identity.schemaVersion,
      hashAlgorithm: 'sha256',
      identityScope: identity.identityScope,
      candidate: { headCommit: identity.candidate.headCommit },
      buildIdentity: identity.candidate.headCommit,
    };
    expect(verifyTaskRegressionBuildIdentity(headOnly).ok).toBe(false);
    expect(verifyTaskRegressionBuildIdentity(headOnly).errors).toContain('identity_basis_incomplete');
    expect(() => assertTaskRegressionBuildIdentity(headOnly)).toThrow('identity_basis_incomplete');

    const tampered = structuredClone(identity);
    tampered.candidate.trackedChanges.files.push({ path: 'server/other.ts' });
    expect(verifyTaskRegressionBuildIdentity(tampered).errors).toContain('tracked_count_invalid');
  });

  it('projects the complete identity to the exact matrix contract', () => {
    const root = repository();
    write(root, 'server/task.ts', 'export const task = 7;\n');
    const artifact = runtimeArtifact(root, 'compiled runtime artifact bytes');
    const identity = computeTaskRegressionBuildIdentity(root, { environment });
    const projection = projectTaskRegressionMatrixBuildIdentity(identity, {
      runtimeArtifactPath: artifact.path,
      runtimeArtifactSha256: artifact.sha256,
      collectedAt: '2026-08-27T14:30:00.000Z',
    });

    expect(projection).toEqual({
      kind: TASK_REGRESSION_MATRIX_BUILD_IDENTITY_KIND,
      revision: identity.candidate.headCommit,
      sourceFingerprintSha256: identity.sourceFingerprint,
      sourceDirty: true,
      runtimeFingerprintSha256: artifact.sha256,
      collectedAt: '2026-08-27T14:30:00.000Z',
    });
    expect(Object.keys(projection).sort()).toEqual([
      'collectedAt',
      'kind',
      'revision',
      'runtimeFingerprintSha256',
      'sourceDirty',
      'sourceFingerprintSha256',
    ]);
    expect(validateMatrixBuildIdentity(projection)).toEqual({ ok: true, value: projection });
  });

  it('requires an independent runtime artifact SHA-256', () => {
    const root = repository();
    const identity = computeTaskRegressionBuildIdentity(root, { environment });
    const artifact = runtimeArtifact(root, 'independent runtime artifact');
    const collectedAt = '2026-08-27T14:30:00.000Z';
    const headTextSha256 = hash(identity.candidate.headCommit);
    const headBytesSha256 = crypto.createHash('sha256')
      .update(Buffer.from(identity.candidate.headCommit, 'hex'))
      .digest('hex');

    for (const { runtimeArtifactSha256, expectedError } of [
      { runtimeArtifactSha256: undefined, expectedError: 'runtime_artifact_sha256_required' },
      { runtimeArtifactSha256: 'A'.repeat(64), expectedError: 'runtime_artifact_sha256_required' },
      { runtimeArtifactSha256: identity.candidate.headCommit, expectedError: 'runtime_artifact_sha256_required' },
      { runtimeArtifactSha256: identity.sourceFingerprint, expectedError: 'runtime_artifact_sha256_not_independent' },
      { runtimeArtifactSha256: identity.buildIdentity, expectedError: 'runtime_artifact_sha256_not_independent' },
      {
        runtimeArtifactSha256: identity.candidate.dependencyLockfiles.digest,
        expectedError: 'runtime_artifact_sha256_not_independent',
      },
      { runtimeArtifactSha256: headTextSha256, expectedError: 'runtime_artifact_sha256_not_independent' },
      { runtimeArtifactSha256: headBytesSha256, expectedError: 'runtime_artifact_sha256_not_independent' },
    ]) {
      expect(() => projectTaskRegressionMatrixBuildIdentity(identity, {
        runtimeArtifactPath: artifact.path,
        runtimeArtifactSha256,
        collectedAt,
      })).toThrow(expectedError);
    }
    expect(() => projectTaskRegressionMatrixBuildIdentity(identity, {
      runtimeArtifactSha256: artifact.sha256,
      collectedAt,
    })).toThrow('runtime_artifact_path_required');
    expect(() => projectTaskRegressionMatrixBuildIdentity(identity, {
      runtimeArtifactPath: artifact.path,
      runtimeArtifactSha256: hash('different runtime artifact'),
      collectedAt,
    })).toThrow('runtime_artifact_sha256_mismatch');
    expect(() => projectTaskRegressionMatrixBuildIdentity(identity, {
      runtimeArtifactPath: artifact.path,
      runtimeArtifactSha256: hash('runtime'),
      collectedAt,
      sourceFingerprintSha256: identity.sourceFingerprint,
    } as any)).toThrow('matrix_build_identity_projection_options_invalid');
  });

  it('requires a canonical UTC millisecond collection instant', () => {
    const root = repository();
    const artifact = runtimeArtifact(root, 'another runtime artifact');
    const identity = computeTaskRegressionBuildIdentity(root, { environment });

    for (const collectedAt of [
      undefined,
      '2026-08-27T14:30:00Z',
      '2026-08-27T22:30:00.000+08:00',
      '2026-02-30T14:30:00.000Z',
    ]) {
      expect(() => projectTaskRegressionMatrixBuildIdentity(identity, {
        runtimeArtifactPath: artifact.path,
        runtimeArtifactSha256: artifact.sha256,
        collectedAt,
      })).toThrow('matrix_build_identity_collected_at_invalid');
    }
  });

  it('uses a narrow, explicit untracked source selection policy', () => {
    expect(isSelectedTaskRegressionUntrackedSource('server/worker.ts')).toBe(true);
    expect(isSelectedTaskRegressionUntrackedSource('src-tauri/src/lib.rs')).toBe(true);
    expect(isSelectedTaskRegressionUntrackedSource('test/runtime.test.ts')).toBe(true);
    expect(isSelectedTaskRegressionUntrackedSource('server/data/new.ts')).toBe(true);
    expect(isSelectedTaskRegressionUntrackedSource('src/build/worker.ts')).toBe(true);
    expect(isSelectedTaskRegressionUntrackedSource('.env')).toBe(false);
    expect(isSelectedTaskRegressionUntrackedSource('config/credentials.json')).toBe(false);
    expect(isSelectedTaskRegressionUntrackedSource('secrets/provider.ts')).toBe(false);
    expect(isSelectedTaskRegressionUntrackedSource('build/generated.ts')).toBe(false);
    expect(isSelectedTaskRegressionUntrackedSource('data/generated.ts')).toBe(false);
    expect(isSelectedTaskRegressionUntrackedSource('src-tauri/target/generated.rs')).toBe(false);
    expect(isSelectedTaskRegressionUntrackedSource('packages/core/node_modules/generated.ts')).toBe(false);
    expect(isSelectedTaskRegressionUntrackedSource('../outside.ts')).toBe(false);
    expect(isSelectedTaskRegressionUntrackedSource('C:\\private\\outside.ts')).toBe(false);
  });

  it('emits verifiable, path-private JSON from the CLI', () => {
    const root = repository();
    write(root, 'server/task.ts', 'export const task = 9;\n');
    const cli = path.resolve('scripts/task-regression-build-identity.mjs');
    const result = spawnSync(process.execPath, [cli, '--root', root], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(root);
    const identity = JSON.parse(result.stdout);
    expect(identity.ok).toBe(true);
    expect(identity.candidate.dirty).toBe(true);
    expect(verifyTaskRegressionBuildIdentity(identity)).toEqual({ ok: true, errors: [] });
  });

  it('emits the strict matrix projection only when runtime evidence is explicit', () => {
    const root = repository();
    const cli = path.resolve('scripts/task-regression-build-identity.mjs');
    const artifact = runtimeArtifact(root, 'CLI runtime artifact bytes');
    const collectedAt = '2026-08-27T14:35:00.000Z';
    const result = spawnSync(process.execPath, [
      cli,
      '--root', root,
      '--runtime-fingerprint-sha256', artifact.sha256,
      '--runtime-artifact', artifact.path,
      '--collected-at', collectedAt,
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(root);
    const projection = JSON.parse(result.stdout);
    expect(projection.runtimeFingerprintSha256).toBe(artifact.sha256);
    expect(projection.collectedAt).toBe(collectedAt);
    expect(validateMatrixBuildIdentity(projection).ok).toBe(true);

    const missingRuntime = spawnSync(process.execPath, [cli, '--root', root, '--collected-at', collectedAt], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(missingRuntime.status).toBe(1);
    expect(JSON.parse(missingRuntime.stderr)).toEqual({
      ok: false,
      error: 'cli_collected_at_requires_runtime_fingerprint',
    });

    const missingArtifact = spawnSync(process.execPath, [
      cli,
      '--root', root,
      '--runtime-fingerprint-sha256', artifact.sha256,
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(missingArtifact.status).toBe(1);
    expect(JSON.parse(missingArtifact.stderr)).toEqual({
      ok: false,
      error: 'cli_runtime_artifact_required',
    });
  });

  it('fails closed with sanitized errors outside a Git worktree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-not-a-repo-'));
    roots.push(root);
    let thrown: unknown;
    try {
      computeTaskRegressionBuildIdentity(root, { environment });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TaskRegressionBuildIdentityError);
    expect((thrown as TaskRegressionBuildIdentityError).code).toBe('git_repository_unavailable');

    const cli = path.resolve('scripts/task-regression-build-identity.mjs');
    const result = spawnSync(process.execPath, [cli, '--root', root], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: 'git_repository_unavailable' });
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(root);
  });
});
