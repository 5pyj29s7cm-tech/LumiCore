import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  it('rejects a missing functional suite even when the total count is large enough', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lumi-vitest-inventory-'));
    tempDirectories.push(directory);
    await mkdir(path.join(directory, 'test'));
    for (const name of ['chat', 'voice']) await writeFile(path.join(directory, 'test', `${name}.test.ts`), '');
    const reportPath = path.join(directory, 'results.json');
    await writeFile(reportPath, JSON.stringify({ success: true, numTotalTests: 10000,
      testResults: [{ name: path.join(directory, 'test/chat.test.ts'), status: 'passed', assertionResults: [] }] }));
    const result = spawnSync(process.execPath, [path.resolve('scripts/check-vitest-count.mjs'), reportPath], { cwd: directory, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('voice.test.ts');
  });
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
