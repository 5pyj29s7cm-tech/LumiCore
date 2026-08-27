import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('Vitest inventory diagnostics', () => {
  it('emits a GitHub Checks annotation for a failed assertion', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lumi-vitest-inventory-'));
    tempDirectories.push(directory);
    const reportPath = path.join(directory, 'vitest-results.json');
    const testPath = path.join(process.cwd(), 'test', 'example_failure.test.ts');
    await writeFile(reportPath, JSON.stringify({
      success: false,
      numFailedTests: 1,
      numTotalTests: 1,
      testResults: [{
        name: testPath,
        status: 'failed',
        assertionResults: [{
          status: 'failed',
          fullName: 'example suite rejects a bad value',
          failureMessages: ['expected true to be false\nsecond line'],
        }],
      }],
    }));

    const result = spawnSync(process.execPath, [
      path.resolve(process.cwd(), 'scripts/check-vitest-count.mjs'),
      reportPath,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: 'true' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '::error file=test/example_failure.test.ts,title=example suite rejects a bad value::expected true to be false%0Asecond line',
    );
  });
});
