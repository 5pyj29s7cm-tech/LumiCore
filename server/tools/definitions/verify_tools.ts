import { exec } from 'child_process';
import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

const REPO_ROOT = process.cwd();

async function typeCheckHandler(args: Record<string, any>): Promise<string> {
  const projectPath = args.path ? String(args.path) : REPO_ROOT;

  return new Promise((resolve) => {
    exec('npx tsc --noEmit', {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      cwd: projectPath,
    }, (error, stdout, stderr) => {
      const output = (stdout + '\n' + stderr).trim();

      if (!error && !output) {
        resolve(JSON.stringify({ ok: true, status: 'passed', errorCount: 0, output: '' }, null, 2));
        return;
      }

      if (!output) {
        resolve(JSON.stringify({ ok: false, status: 'failed', errorCount: null, output: '', error: error?.message || 'Type check failed with no output.' }, null, 2));
        return;
      }

      // Group errors by file for readability
      const lines = output.split('\n');
      const byFile = new Map<string, string[]>();
      const filePattern = /^(.+?\.(ts|tsx))\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)/;

      for (const line of lines) {
        const match = line.match(filePattern);
        if (match) {
          const file = match[1];
          const lineNum = match[3];
          const severity = match[5];
          const code = match[6];
          const msg = match[7];
          if (!byFile.has(file)) byFile.set(file, []);
          byFile.get(file)!.push(`  L${lineNum}: ${severity} ${code}: ${msg}`);
        }
      }

      if (byFile.size === 0) {
        resolve(JSON.stringify({
          ok: !error,
          status: error ? 'failed' : 'passed',
          errorCount: error ? null : 0,
          output: output.slice(0, 2000),
        }, null, 2));
        return;
      }

      const result: string[] = [`Type check found errors in ${byFile.size} file(s):\n`];
      for (const [file, msgs] of byFile) {
        result.push(`${file}:`);
        result.push(...msgs.slice(0, 15)); // max 15 errors per file
        if (msgs.length > 15) result.push(`  ... and ${msgs.length - 15} more errors`);
        result.push('');
      }
      resolve(JSON.stringify({
        ok: false,
        status: 'failed',
        errorCount: Array.from(byFile.values()).reduce((total, messages) => total + messages.length, 0),
        fileCount: byFile.size,
        output: result.join('\n'),
      }, null, 2));
    });
  });
}

async function runTestsHandler(args: Record<string, any>): Promise<string> {
  const testCommand = args.command ? String(args.command) : 'npm test';
  const projectPath = args.path ? String(args.path) : REPO_ROOT;

  return new Promise((resolve) => {
    exec(testCommand, {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      cwd: projectPath,
    }, (error, stdout, stderr) => {
      const output = (stdout + '\n' + stderr).trim();

      if (error && !output) {
        resolve(JSON.stringify({ ok: false, status: 'failed', exitCode: error.code ?? null, output: '', error: error.message }, null, 2));
        return;
      }

      const maxLen = 3000;
      const truncated = output.length > maxLen
        ? output.slice(output.length - maxLen)
        : output;

      if (error) {
        resolve(JSON.stringify({ ok: false, status: 'failed', exitCode: error.code ?? null, output: truncated }, null, 2));
      } else {
        resolve(JSON.stringify({ ok: true, status: 'passed', exitCode: 0, output: truncated }, null, 2));
      }
    });
  });
}

export function registerVerifyTools(registry: ToolRegistry): void {
  registry.register({
    name: 'type_check',
    description: 'Run TypeScript type checker (npx tsc --noEmit). Returns errors grouped by file with line numbers. Use after modifying code to verify correctness.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the project root. Defaults to current directory.' },
      },
      required: [],
    },
    handler: typeCheckHandler,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'code.typescript.type-check',
      family: 'verification',
      lane: 'system',
      operation: 'test',
      risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'ephemeral TypeScript checker process and cache', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'errorCount'],
        requiredValues: { ok: true, status: 'passed', errorCount: 0 },
        successStatuses: ['passed'],
        successSignals: ['the TypeScript checker exited without diagnostics'],
        limitations: ['Type correctness does not prove runtime behavior.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'code.typescript.type-check',
      operation: 'test',
      subjectArgument: 'path',
    }),
  });

  registry.register({
    name: 'run_tests',
    description: 'Run the test suite and report results. Defaults to "npm test". Use "command" to run a specific test (e.g. "npx vitest run path/to/test.test.ts").',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Test command to run. Defaults to "npm test".' },
        path: { type: 'string', description: 'Path to the project root. Defaults to current directory.' },
      },
      required: [],
    },
    handler: runTestsHandler,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'code.test-suite.run',
      family: 'verification',
      lane: 'system',
      operation: 'test',
      risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'workspace test process and generated test caches', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'exitCode'],
        requiredValues: { ok: true, status: 'passed', exitCode: 0 },
        successStatuses: ['passed'],
        successSignals: ['the selected test command exited with code zero'],
        limitations: ['A passing selected suite only covers the tests that command actually ran.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'code.test-suite.run',
      operation: 'test',
      subjectArgument: 'command',
    }),
  });
}
