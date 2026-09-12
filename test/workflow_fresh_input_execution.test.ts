import './helpers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerWorkflowTools } from '../server/tools/definitions/workflow_tools';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { registerCodeOpsTools } from '../server/tools/definitions/code_tools';

describe('one reviewed workflow with fresh input files', () => {
  beforeAll(async () => { await initDatabase(); });
  it('reads, recomputes and writes through the real workflow executor on both runs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-dynamic-workflow-'));
    const registry = new ToolRegistry();
    registerFileOpsTools(registry); registerCodeOpsTools(registry); registerWorkflowTools(registry);
    const userId = `workflow-fresh-${Date.now()}`;
    const context = { userId, authenticated: true, localExecution: true, executionBoundary: 'trusted_local' as const,
      source: 'e2e-test', domain: 'personal', cwd: root, requestConfirmation: async () => true };
    const name = `fresh-CSV-${Date.now()}`;
    try {
      const saved = JSON.parse(await registry.execute('save_workflow', {
        name, description: 'Read CSV and calculate line totals with current input data', steps: [
          { tool: 'read_file', args: { path: { $inputRef: 'inputs.sourcePath' } } },
          { tool: 'code_execution', args: { input: { $stepOutputRef: 'step_1' },
            code: "(() => { const rows = input.trim().split(/\\r?\\n/).map(row => row.split(',')); return rows.map((row, i) => row.join(',') + ',' + (i === 0 ? 'total' : Number(row[1]) * Number(row[2]))).join('\\n') + '\\n'; })()" } },
          { tool: 'write_file', args: { path: { $inputRef: 'inputs.outputPath' }, content: { $stepOutputRef: 'step_2.output' } } },
        ],
      }, context));
      const published = JSON.parse(await registry.execute('publish_workflow', { name, expectedHash: saved.hash }, context));
      expect(published.status).toBe('published');
      for (const quantity of [4, 5]) {
        const sourcePath = path.join(root, `input-${quantity}.csv`), outputPath = path.join(root, `output-${quantity}.csv`);
        const original = `product,quantity,price\nblue-cup,${quantity},18\n`;
        fs.writeFileSync(sourcePath, original);
        const inputs = { sourcePath, outputPath };
        const started = JSON.parse(await registry.execute('run_workflow', { name, inputs }, context));
        expect(started.status).toBe('started');
        let finished = false;
        for (let attempt = 0; attempt < 400; attempt++) {
          const state = JSON.parse(await registry.execute('get_workflow_run', { runId: started.runId }, context));
          if (state.status === 'waiting_confirmation') {
            await registry.execute('decide_workflow_confirmation', { runId: started.runId, expectedRevision: state.revision,
              confirmationId: state.confirmation.confirmationId, approved: true, inputs }, context);
          } else if (state.status === 'completed') {
            expect(state.completedSteps).toBe(3); finished = true; break;
          } else if (['blocked', 'failed', 'cancelled'].includes(state.status)) {
            throw new Error(JSON.stringify(state));
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(finished).toBe(true);
        expect(fs.readFileSync(outputPath, 'utf8')).toBe(`product,quantity,price,total\nblue-cup,${quantity},18,${quantity * 18}\n`);
        expect(fs.readFileSync(sourcePath, 'utf8')).toBe(original);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
});
