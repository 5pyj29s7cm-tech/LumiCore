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
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
beforeAll(async () => { await initDatabase(); });

it.each(['en', 'zh', 'zh_resume'])('executes and captures through the authorized pipeline (%s)', async language => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-capture-turn-'));
  const sourcePath = path.join(root, 'input.csv'), outputPath = path.join(root, 'output.csv');
  const input = 'quantity,price\n4,18\n', output = 'quantity,price,total\n4,18,72\n';
  fs.writeFileSync(sourcePath, input);
  const registry = new ToolRegistry(); registerFileOpsTools(registry); registerCodeOpsTools(registry); registerWorkflowTools(registry);
  const userId = `capture-model-turn-${language}`, name = `captured-model-turn-${language}`;
  const task = language === 'en'
    ? `Read ${sourcePath}, calculate quantity times price and save as ${outputPath}, then save the workflow. Do not modify the source file.`
    : `请读取 ${sourcePath}，按数量乘单价增加 total 列，保存为 ${outputPath}。然后把完整的读取、计算、写文件流程保存为可复用工作流草稿。源文件不要改动。`;
  const pipeline = buildLumiExecutionPipeline({ registry, dispatch: { userId, channel: 'chat', source: 'e2e-formal-client',
    operationMode: 'assistant', text: task, targetIsLumi: true },
    personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 6 } });
  const calls = [
    { name: 'read_file', arguments: { path: sourcePath } },
    { name: 'code_execution', arguments: { input: { result: input }, code: "(() => { const rows = input.result.trim().split('\\n').map(row => row.split(',')); return { csv: rows.map((r,i) => r.join(',') + ',' + (i ? Number(r[0])*Number(r[1]) : 'total')).join('\\n') + '\\n' }; })()" } },
    { name: 'write_file', arguments: { path: outputPath, content: output } },
    { name: 'capture_recent_workflow', arguments: { name } },
  ];
  let priorToolRecords: any[] = [];
  if (language === 'zh_resume') {
    let first = true;
    mocks.call.mockImplementation(async () => first
      ? (first = false, { text: null, toolCalls: [{ id: 'prior-read', ...calls[0] }] })
      : { text: 'Reading finished; the calculation remains incomplete.' });
    const partial = await runWithTools([{ role: 'user', content: task }], registry,
      { provider: 'deepseek', model: 'fixture', userId, conversationId: userId }, undefined, 2,
      () => null, () => null, () => null, () => null, () => null, undefined,
      { userId, conversationId: userId, taskId: 'capture-task', requestId: 'prior-request', source: 'e2e-formal-client',
        executionBoundary: 'trusted_local', localExecution: true, authenticated: true, cwd: root,
        actionIntent: task, routedTaskText: task, toolPolicy: pipeline.authorizationPolicy,
        modelToolProjection: pipeline.modelToolProjection, requestConfirmation: async () => true });
    expect(partial.toolCalls).toHaveLength(1);
    priorToolRecords = partial.toolCalls.map(record => ({ ...record, envelope: undefined,
      result: record.result?.replace(/\s+/g, ' ') }));
    calls.shift();
  }
  let iteration = 0;
  mocks.call.mockImplementation(async (_messages, declarations, config) => {
    const names = declarations.map((tool: any) => tool.function.name);
    if (iteration < (language === 'zh_resume' ? 2 : 3)) {
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
    const result = await runWithTools([{ role: 'user', content: language === 'zh_resume'
      ? '继续完成刚才未完成的任务，再保存刚才要求的工作流。' : task }], registry,
      { provider: 'deepseek', model: 'fixture', userId, conversationId: userId }, undefined, 6,
      () => null, () => null, () => null, () => null, () => null, undefined,
      { userId, conversationId: userId, taskId: 'capture-task', requestId: 'capture-request',
        source: 'e2e-formal-client', executionBoundary: 'trusted_local', localExecution: true, authenticated: true,
        toolPolicy: pipeline.authorizationPolicy, modelToolProjection: pipeline.modelToolProjection,
        priorToolRecords,
        cwd: root, actionIntent: task, routedTaskText: task, requestConfirmation: async () => true });
    expect(result.toolCalls.find(record => record.name === 'capture_recent_workflow')?.error).toBeUndefined();
    const saved = getWorkflow(userId, name);
    expect(saved?.steps).toHaveLength(3);
    expect(saved?.steps[1].args.input).toEqual({ result: { $stepOutputRef: 'step_1' } });
    expect(saved?.steps[2].args.content).toEqual({ $stepOutputRef: 'step_2.output.csv' });
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(output);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(input);
    const final = finalizeLumiResponse({ taskText: task, responseText: result.text, toolRecords: result.toolCalls,
      source: 'chat', requestId: 'capture-request', taskId: 'capture-task', flow: pipeline.turnIntent.flow });
    expect(final.blocked).toBe(false);
    expect(final.text).toContain(name);
    const publishText = language === 'en'
      ? `Publish the reviewed workflow ${name} with hash ${saved!.runtimeHash}. Do not run it yet.`
      : `请发布已审核的本地工作流草稿 ${name}，审核哈希是 ${saved!.runtimeHash}。本轮只发布，暂不运行。`;
    const publication = buildLumiExecutionPipeline({ registry, dispatch: { userId, channel: 'chat', source: 'e2e-formal-client',
      operationMode: 'assistant', text: publishText, targetIsLumi: true },
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 } });
    mocks.call.mockResolvedValue({ text: null, toolCalls: [{ id: 'publish-reviewed', name: 'publish_workflow',
      arguments: { name, expectedHash: saved!.runtimeHash } }] });
    const published = await runWithTools([{ role: 'user', content: publishText }], registry,
      { provider: 'deepseek', model: 'fixture', userId, conversationId: userId }, undefined, 4,
      () => null, () => null, () => null, () => null, () => null, undefined,
      { userId, conversationId: userId, taskId: 'publish-task', requestId: 'publish-request', source: 'e2e-formal-client',
        executionBoundary: 'trusted_local', localExecution: true, authenticated: true, cwd: root,
        actionIntent: publishText, routedTaskText: publishText, toolPolicy: publication.authorizationPolicy,
        modelToolProjection: publication.modelToolProjection, requestConfirmation: async () => true });
    expect(published.toolCalls).toHaveLength(1);
    const publishFinal = finalizeLumiResponse({ taskText: publishText, responseText: published.text, toolRecords: published.toolCalls,
      source: 'chat', requestId: 'publish-request', taskId: 'publish-task', flow: publication.turnIntent.flow });
    expect(publishFinal.blocked).toBe(false);
    expect(publishFinal.reason).toBe('workflow_published');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
