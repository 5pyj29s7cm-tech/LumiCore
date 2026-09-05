import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerPythonTools } from '../server/tools/definitions/python_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';

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
    } finally {
      for (const result of results) for (const artifact of result.artifacts) fs.rmSync(artifact.path, { force: true });
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
