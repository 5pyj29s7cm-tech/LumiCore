import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerPythonTools } from '../server/tools/definitions/python_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';

describe('Python terminal receipts', () => {
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
