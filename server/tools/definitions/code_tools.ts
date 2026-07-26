import vm from 'vm';
import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

async function codeExecutionHandler(args: Record<string, any>): Promise<string> {
  const code = String(args.code || '');
  const timeout = Math.min(Math.max(Number(args.timeout) || 10000, 1000), 30000);

  if (!code.trim()) throw new Error('Code is required.');

  // Capture console output
  const output: string[] = [];
  const sandboxConsole = {
    log: (...args: any[]) => { output.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join(' ')); },
    warn: (...args: any[]) => { output.push('[warn] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join(' ')); },
    error: (...args: any[]) => { output.push('[error] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join(' ')); },
    info: (...args: any[]) => { output.push('[info] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join(' ')); },
  };

  const sandbox = {
    console: sandboxConsole,
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    Set,
    Promise,
    RegExp,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    require: undefined,
    process: undefined,
    global: undefined,
    globalThis: undefined,
    __dirname: undefined,
    __filename: undefined,
    module: undefined,
    exports: undefined,
    fetch: undefined,
  };

  const context = vm.createContext(sandbox);

  try {
    const result = await Promise.race([
      vm.runInContext(code, context, {
        timeout,
        displayErrors: true,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Execution timed out')), timeout)),
    ]);

    return JSON.stringify({
      ok: true,
      status: 'completed',
      output: output.length > 0
        ? output.join('\n')
        : result !== undefined
          ? result
          : null,
    }, null, 2);
  } catch (err: any) {
    return JSON.stringify({
      ok: false,
      status: 'failed',
      output: output.join('\n'),
      error: err.message,
    }, null, 2);
  }
}

export function registerCodeOpsTools(registry: ToolRegistry): void {
  registry.register({
    name: 'code_execution',
    description: 'Execute JavaScript code in a sandboxed environment. Returns stdout output or the last expression value. No access to filesystem, network, or Node.js APIs.',
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
      sideEffects: [{ type: 'local_state_change', scope: 'ephemeral isolated JavaScript VM', reversible: true }],
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
