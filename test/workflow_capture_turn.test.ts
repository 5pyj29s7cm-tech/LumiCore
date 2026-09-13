import './helpers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../server/llm/providers', async () => ({
  ...await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers'),
  makeLLMCall: mocks.call,
}));
import { initDatabase } from '../db_layer';
import { runWithTools } from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';
import { registerWorkflowTools } from '../server/tools/definitions/workflow_tools';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { registerCodeOpsTools } from '../server/tools/definitions/code_tools';
import { getWorkflow } from '../server/agents/workflows';
beforeAll(async () => { await initDatabase(); });

it('executes and captures in one model/tool turn without letting authoring displace calculation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-capture-turn-'));
  const sourcePath = path.join(root, 'input.csv'), outputPath = path.join(root, 'output.csv');
  const input = 'quantity,price\n4,18\n', output = 'quantity,price,total\n4,18,72\n';
  fs.writeFileSync(sourcePath, input);
  const registry = new ToolRegistry(); registerFileOpsTools(registry); registerCodeOpsTools(registry); registerWorkflowTools(registry);
  const userId = 'capture-model-turn', name = 'captured-model-turn';
  const task = `Read ${sourcePath}, calculate quantity times price and write ${outputPath}, then save the workflow.`;
  const calls = [
    { name: 'read_file', arguments: { path: sourcePath } },
    { name: 'code_execution', arguments: { input, code: "(() => { const rows = input.trim().split('\\n').map(row => row.split(',')); return rows.map((r,i) => r.join(',') + ',' + (i ? Number(r[0])*Number(r[1]) : 'total')).join('\\n') + '\\n'; })()" } },
    { name: 'write_file', arguments: { path: outputPath, content: output } },
    { name: 'capture_recent_workflow', arguments: { name } },
  ];
  let iteration = 0;
  mocks.call.mockImplementation(async (_messages, declarations, config) => {
    const names = declarations.map((tool: any) => tool.function.name);
    if (iteration < 3) {
      expect(names).not.toContain('save_workflow');
      expect(names).not.toContain('capture_recent_workflow');
      expect(config.localRequiredToolNames).toContain('code_execution');
    } else {
      expect(names).toContain('capture_recent_workflow');
      expect(names).not.toContain('write_file');
    }
    const call = calls[iteration++];
    return call ? { text: null, toolCalls: [{ id: `call-${iteration}`, ...call }] } : { text: 'The file and workflow draft were saved.' };
  });
  try {
    const result = await runWithTools([{ role: 'user', content: task }], registry,
      { provider: 'deepseek', model: 'fixture', userId, conversationId: userId }, undefined, 6,
      () => null, () => null, () => null, () => null, () => null, undefined,
      { userId, conversationId: userId, taskId: 'capture-task', requestId: 'capture-request',
        source: 'e2e-formal-client', executionBoundary: 'trusted_local', localExecution: true, authenticated: true,
        cwd: root, actionIntent: task, routedTaskText: task, requestConfirmation: async () => true });
    expect(result.toolCalls.find(record => record.name === 'capture_recent_workflow')?.error).toBeUndefined();
    const saved = getWorkflow(userId, name);
    expect(saved?.steps).toHaveLength(3);
    expect(saved?.steps[1].args.input).toEqual({ $stepOutputRef: 'step_1' });
    expect(saved?.steps[2].args.content).toEqual({ $stepOutputRef: 'step_2.output' });
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(output);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(input);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
