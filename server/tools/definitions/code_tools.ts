import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { executeSandboxedJavaScript } from '../javascript_sandbox';
import type { ToolContext } from '../types';

async function codeExecutionHandler(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const code = String(args.code || '');
  const timeout = Math.min(Math.max(Number(args.timeout) || 10000, 1000), 30000);

  return executeSandboxedJavaScript(code, timeout, context);
}

export function registerCodeOpsTools(registry: ToolRegistry): void {
  registry.register({
    name: 'code_execution',
    description: 'Execute JavaScript calculations in an isolated QuickJS WebAssembly heap. Returns console output or the last expression value. No filesystem, network, Node.js APIs, imports or host timers. Code limit 64 KiB; memory 16 MiB; output 128 KiB. Settled promises are supported.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 10000, max 30000)' },
      },
      required: ['code'],
    },
    handler: codeExecutionHandler,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'code.javascript.sandbox.execute',
      family: 'code_execution',
      lane: 'system',
      operation: 'test',
      risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'ephemeral QuickJS WebAssembly heap in a bounded worker', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'output'],
        requiredValues: { ok: true, status: 'completed' },
        successStatuses: ['completed'],
        successSignals: ['the isolated VM completed without an exception or timeout'],
        limitations: ['Completion proves sandbox execution, not correctness of the supplied program.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'code.javascript.sandbox.execute',
      operation: 'test',
      subjectArgument: 'code',
    }),
  });
}
