import { describe, expect, it } from 'vitest';
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
