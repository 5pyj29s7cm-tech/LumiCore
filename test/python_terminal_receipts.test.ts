import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerPythonTools } from '../server/tools/definitions/python_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';
import { getGeneratedOutputDir } from '../server/config/data_path';

describe('Python terminal receipts', () => {
  it('keeps concurrent Python output receipts bound to their own job', async () => {
    const registry = new ToolRegistry();
    registerPythonTools(registry);
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const firstName = `first_${suffix}.png`;
    const secondName = `second_${suffix}.png`;
    const execute = (name: string, pause: number) => registry.execute('python_exec', {
      code: `import time\ntime.sleep(${pause})\nwith open('${name}', 'wb') as image:\n    image.write(b'synthetic-image')\nprint('done')`,
    }, { requestConfirmation: async () => true }).then(result => JSON.parse(result));
    const results = await Promise.all([execute(firstName, 0.2), execute(secondName, 0)]);
    try {
      expect(results.map(result => result.artifacts.map((artifact: any) => path.basename(artifact.path))))
        .toEqual([[firstName], [secondName]]);
      expect(results[0].outputDirectory).not.toBe(results[1].outputDirectory);
    } finally {
      for (const result of results) {
        for (const artifact of result.artifacts) fs.rmSync(artifact.path, { force: true });
        fs.rmdirSync(result.outputDirectory);
      }
    }
  });

  it('excludes an image produced by another tool while Python is running and preserves follow-up access', async () => {
    const registry = new ToolRegistry();
    registerPythonTools(registry);
    const externalImage = path.join(getGeneratedOutputDir(), `other-tool-${Date.now()}.png`);
    const execution = registry.execute('python_exec', {
      code: `import os, time\nwhile not os.path.exists(${JSON.stringify(externalImage)}):\n    time.sleep(0.01)\nwith open('chart.png', 'wb') as image:\n    image.write(b'python-chart')\nprint('own-image-ready')`,
    }, { requestConfirmation: async () => true });
    let result: any;
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      fs.writeFileSync(externalImage, 'another tool image');
      result = JSON.parse(await execution);
      expect(result.artifacts).toEqual([{ type: 'image', path: path.join(result.outputDirectory, 'chart.png') }]);
      expect(fs.readFileSync(result.artifacts[0].path, 'utf8')).toBe('python-chart');
      const followup = JSON.parse(await registry.execute('python_exec', {
        code: `with open(${JSON.stringify(result.artifacts[0].path)}, 'rb') as previous:\n    print(previous.read().decode())`,
      }, { requestConfirmation: async () => true }));
      expect(followup.stdout).toBe('python-chart');
      expect(followup.artifacts).toEqual([]);
    } finally {
      fs.rmSync(externalImage, { force: true });
      if (result) {
        for (const artifact of result.artifacts) fs.rmSync(artifact.path, { force: true });
        fs.rmdirSync(result.outputDirectory);
      }
    }
  });

  it('keeps JavaScript timers responsive while a real Python process is running', async () => {
    const registry = new ToolRegistry();
    registerPythonTools(registry);
    let finished = false;
    const execution = registry.execute('python_exec', {
      code: "import time\ntime.sleep(0.5)\nprint('async-ok')",
    }, { requestConfirmation: async () => true }).finally(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(finished).toBe(false);
    expect(JSON.parse(await execution).stdout).toBe('async-ok');
  });

  it('records exit-zero execution as a structured verified receipt', async () => {
    const registry = new ToolRegistry();
    registerPythonTools(registry);
    const record = await executeToolCall({
      registry,
      name: 'python_exec',
      arguments: { code: "print('receipt-ok')" },
      context: { requestConfirmation: async () => true },
    });

    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(record.result)).toMatchObject({
      ok: true,
      status: 'completed',
      exitCode: 0,
      stdout: 'receipt-ok',
      artifacts: [],
    });
  });

  it('does not require matplotlib for non-plotting Python execution', async () => {
    const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-python-no-matplotlib-'));
    fs.writeFileSync(
      path.join(shadowDir, 'matplotlib.py'),
      "raise RuntimeError('matplotlib must not be imported for a plain Python task')\n",
      'utf8',
    );
    const previousPythonPath = process.env.PYTHONPATH;
    process.env.PYTHONPATH = previousPythonPath
      ? `${shadowDir}${path.delimiter}${previousPythonPath}`
      : shadowDir;

    try {
      const registry = new ToolRegistry();
      registerPythonTools(registry);
      const record = await executeToolCall({
        registry,
        name: 'python_exec',
        arguments: { code: "print('plain-python-ok')" },
        context: { requestConfirmation: async () => true },
      });

      expect(record.error).toBeUndefined();
      expect(record.terminalVerification?.status).toBe('verified');
      expect(JSON.parse(record.result)).toMatchObject({
        ok: true,
        status: 'completed',
        exitCode: 0,
        stdout: 'plain-python-ok',
      });
    } finally {
      if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = previousPythonPath;
      fs.rmSync(shadowDir, { recursive: true, force: true });
    }
  });

  it('records a Python exception as a failed tool call instead of successful Markdown', async () => {
    const registry = new ToolRegistry();
    registerPythonTools(registry);
    const record = await executeToolCall({
      registry,
      name: 'python_exec',
      arguments: { code: "raise RuntimeError('receipt-failure')" },
      context: { requestConfirmation: async () => true },
    });

    expect(record.error).toContain('Python execution failed');
    expect(record.terminalVerification?.status).toBe('failed');
    expect(record.result).toBe('');
  });
});
