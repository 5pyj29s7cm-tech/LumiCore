import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadRuntimeBuildMetadata,
  normalizeRuntimeBuildMetadata,
} from '../shared/runtime_build_metadata';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('runtime build metadata', () => {
  it('accepts only complete non-placeholder build records', () => {
    const valid = {
      schemaVersion: 1,
      name: 'lumi-core',
      version: '3.0.3',
      buildId: 'abcdef123456',
      sourceFingerprint: 'a'.repeat(64),
      sourceDirty: false,
      builtAt: '2026-07-26T00:00:00.000Z',
      channel: 'internal',
    };
    expect(normalizeRuntimeBuildMetadata(valid)).toEqual(valid);
    expect(normalizeRuntimeBuildMetadata({ ...valid, version: '0.0.0' })).toBeNull();
    expect(normalizeRuntimeBuildMetadata({ ...valid, buildId: '' })).toBeNull();
    expect(normalizeRuntimeBuildMetadata({ ...valid, sourceFingerprint: 'invalid' })).toBeNull();
    expect(normalizeRuntimeBuildMetadata({ ...valid, sourceDirty: undefined })).toBeNull();
  });

  it('prefers packaged metadata over ambient package and environment values', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-runtime-meta-'));
    temporaryDirectories.push(directory);
    const metadata = {
      schemaVersion: 1,
      name: 'lumi-core',
      version: '3.0.3',
      buildId: 'packaged-commit',
      sourceFingerprint: 'b'.repeat(64),
      sourceDirty: true,
      builtAt: '2026-07-26T00:00:00.000Z',
      channel: 'internal',
    };
    fs.writeFileSync(path.join(directory, 'runtime-meta.json'), JSON.stringify(metadata));
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'wrong', version: '9.9.9' }));

    expect(loadRuntimeBuildMetadata({
      cwd: directory,
      env: { LUMI_VERSION: '8.8.8', LUMI_BUILD_ID: 'ambient' },
    })).toEqual(metadata);
  });

  it('uses source package metadata without returning empty build identity', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-runtime-source-'));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'lumi-core', version: '3.0.3' }));
    const metadata = loadRuntimeBuildMetadata({ cwd: directory, env: {}, now: '2026-07-26T00:00:00.000Z' });
    expect(metadata).toMatchObject({
      name: 'lumi-core',
      version: '3.0.3',
      buildId: 'development',
      channel: 'internal',
    });
  });
});
