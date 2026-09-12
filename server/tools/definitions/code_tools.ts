import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { executeSandboxedJavaScript } from '../javascript_sandbox';
import type { ToolContext } from '../types';

async function codeExecutionHandler(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const code = String(args.code || '');
  const timeout = Math.min(Math.max(Number(args.timeout) || 10000, 1000), 30000);

  return executeSandboxedJavaScript(code, timeout, context, args.input);
}

export function registerCodeOpsTools(registry: ToolRegistry): void {
  registry.register({
    name: 'code_execution',
    description: 'Execute JavaScript calculations in an isolated QuickJS WebAssembly heap. Pass fresh data in input and read it as global input inside the code. Reusable workflows must bind input to current inputs or a previous step output, never embed previous results in code. Returns console output or the last expression value. No filesystem, network, Node.js APIs, imports or host timers. Code limit 64 KiB; input/output 128 KiB; memory 16 MiB. Settled promises are supported.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'A JavaScript script evaluated as-is, not a function body. Use the last expression or an invoked function for the result; no top-level return. Encode JSON escapes only once.' },
        input: { description: 'Optional JSON value exposed as global input. Pass the actual decoded data, not a JSON.stringify copy or quoted representation of the data. In workflows use a typed $inputRef or $stepOutputRef here; return the transformed result as the last expression.' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 10000, max 30000)' },
      },
      required: ['code'],
    },
    handler: codeExecutionHandler,
    permission: 'user',
    // This handler can only mutate its disposable guest heap. File access,
    // host commands and external effects remain separate guarded tools.
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'code.javascript.sandbox.execute',
      family: 'code_execution',
      lane: 'system',
      operation: 'test',
      risk: 'low',
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
