import './helpers';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { classifySkillAuthoringIntent, executionBeforeWorkflowSave } from '../server/skills/authoring_intent';
import { isConversationExecutionFactQuestion } from '../server/conversation/execution_facts';
import { buildLumiTurnDispatch } from '../server/cognition/turn_dispatch';
import { buildLumiExecutionDecision } from '../server/cognition/execution_decision';
import { buildLumiCapabilitySelection, buildModelToolProjection } from '../server/cognition/capability_selection';
import { registerAllTools } from '../server/tools/definitions';
import { registerWorkflowTools } from '../server/tools/definitions/workflow_tools';
import { ToolRegistry } from '../server/tools/registry';
import { clearWorkflows, getRecentWorkflows, recordWorkflow, workflowCaptureBlocker, boundCapturedWorkflowSteps } from '../server/skills/worklog';
import { getWorkflow } from '../server/agents/workflows';
import { resolveWorkflowValue, validateWorkflowSteps } from '../server/workflows/runtime';
import { buildHandlerFunction } from '../server/skills/generator';
import ts from 'typescript';

const saveText = '把这个对话里刚才读取订单、按数量乘单价计算明细和总额的流程保存成可复用技能，命名为“订单汇总”。以后我给新的订单文件，就按这个名称使用。请实际保存并登记好；需要确认的具体内容列出来。';
const createText = '请生成可复用技能“订单汇总”。功能：接收商品、数量、单价组成的订单条目数组，返回每项金额和总额，金额等于数量乘单价。生成完成后展示审核结果并登记，使它能被再次调用。';

beforeAll(async () => { await initDatabase(); });
beforeEach(() => clearWorkflows());

describe('explicit skill authoring and captured workflow boundary', () => {
  it.each(['write_file', 'desktop_write_text_file'])('binds the actual content parameter of %s to calculated output', name => {
    const record = recordWorkflow({ userId: 'binding-user', conversationId: 'binding-conv', taskId: 'binding-task',
      userIntent: 'Read and calculate', conversationExcerpt: '', toolSequence: [
        { name: 'read_file', args: { path: 'source.csv' }, result: '4,18', resultSummary: '', verified: true },
        { name: 'code_execution', args: { code: 'input', input: '4,18' }, result: '{"ok":true,"output":"72"}', resultSummary: '', verified: true },
        { name, args: { path: 'output.csv', content: '72' }, result: 'saved', resultSummary: '', verified: true },
      ] });
    expect(boundCapturedWorkflowSteps(record)?.[2].args.content).toEqual({ $stepOutputRef: 'step_2.output' });
    record.toolSequence[2].args = { path: 'output.csv', text: '72' };
    expect(boundCapturedWorkflowSteps(record)).toBeNull();
  });
  it('retains the same task across confirmation while rejecting model-only parsing gaps', () => {
    const identity = { userId: 'trace-owner', conversationId: 'trace-conversation', taskId: 'trace-task', userIntent: 'Read CSV, calculate totals and save workflow', conversationExcerpt: '' };
    const read = { name: 'read_file', args: { path: 'sample.csv' }, result: 'quantity,price\n4,18', resultSummary: '', verified: true, operation: 'observe' };
    recordWorkflow({ ...identity, toolSequence: [read] });
    const merged = recordWorkflow({ ...identity, userIntent: 'Confirmed', toolSequence: [{ name: 'code_execution',
      args: { code: 'input.quantity * input.price', input: { quantity: 4, price: 18 } },
      result: '{"ok":true,"status":"completed","output":"72"}', resultSummary: '', verified: true, operation: 'test' }] });
    expect(getRecentWorkflows('trace-owner')).toHaveLength(1);
    expect(merged.userIntent).toBe(identity.userIntent);
    expect(merged.toolSequence).toHaveLength(2);
    expect(workflowCaptureBlocker(merged)).toContain('dataflow gap');
    recordWorkflow({ ...identity, conversationId: 'other', toolSequence: [read] });
    expect(getRecentWorkflows('trace-owner', 'personal', '', 'other')).toHaveLength(1);
    const failed = recordWorkflow({ ...identity, toolSequence: [{ ...read, verified: false, result: undefined }] });
    expect(workflowCaptureBlocker(failed)).toContain('failed or unverified');
  });
  it('keeps execution tools when the user asks to perform a task and then save its workflow', () => {
    const text = '请读取 C:/orders/input.csv，按数量乘单价计算金额，生成 C:/orders/output.csv。然后把读取、计算、写文件保存成可复用工作流草稿。';
    const registry = new ToolRegistry(); registerAllTools(registry);
    const pipeline = buildLumiExecutionPipeline({ dispatch: { userId: 'compound-authoring', text, channel: 'chat', source: 'command-center-chat', domain: 'personal', operationMode: 'assistant', targetIsLumi: true }, registry, taskId: 'compound-save' });
    expect(pipeline.modelToolProjection.toolNames).toEqual(expect.arrayContaining(['read_file', 'write_file', 'code_execution', 'save_workflow']));
    expect(executionBeforeWorkflowSave(saveText)).toBe('');
    expect(executionBeforeWorkflowSave('示例：读取 CSV 然后保存工作流。只生成技能草稿，不要执行。')).toBe('');
    expect(executionBeforeWorkflowSave('不要读取文件，然后保存工作流草稿。')).toBe('');
  });
  it.each(['继续当前工作流，不创建新运行。我已核对并确认第 1 步，然后查看同一运行。', '调用工作流的 decide_workflow_confirmation 来确认现有运行的第 1 步。只通过工作流控制继续这个运行，然后用 get_workflow_run 查询同一个 runId。不要在工作流外另行读文件或口算，不创建新的运行。'])('keeps exact workflow step approval executable: %s', text => {
    const registry = new ToolRegistry(); registerAllTools(registry);
    const dispatch = buildLumiTurnDispatch({ userId: 'authoring', text, channel: 'chat', source: 'command-center-chat', operationMode: 'assistant', targetIsLumi: true });
    const execution = buildLumiExecutionDecision({ flow: dispatch.flow, text, toolDeclarations: registry.getToolDeclarations(), toolRegistry: registry });
    const selection = buildLumiCapabilitySelection({ dispatch, execution, text, registry });
    const projection = buildModelToolProjection(execution, { lane: selection.lane, preferredTools: selection.preferredTools });
    expect(projection.toolNames, JSON.stringify({ intent: classifySkillAuthoringIntent(text), route: execution.toolRoute, policy: execution.baseToolPolicy })).toContain('decide_workflow_confirmation');
    const pipeline = buildLumiExecutionPipeline({ dispatch: { userId: 'authoring', text, channel: 'chat', source: 'command-center-chat', domain: 'personal', operationMode: 'assistant', targetIsLumi: true }, registry, taskId: 'workflow-control' });
    expect(pipeline.modelToolProjection.toolNames).toContain('decide_workflow_confirmation');
    expect(pipeline.modelToolProjection.toolNames).not.toContain('run_workflow');
  });
  it.each(['运行已经发布的工作流 LC-WORKFLOW-订单汇总-V16。不要重新生成技能。', '调用已安装的技能计算新订单', '请执行已发布工作流', 'Run the published workflow'])('routes reuse rather than repeating lifecycle changes: %s', text => {
    expect(classifySkillAuthoringIntent(text)).toBe('use');
    const registry = new ToolRegistry(); registerAllTools(registry);
    const dispatch = buildLumiTurnDispatch({ userId: 'authoring', text, channel: 'chat', source: 'command-center-chat', operationMode: 'assistant', targetIsLumi: true });
    const execution = buildLumiExecutionDecision({ flow: dispatch.flow, text, toolDeclarations: registry.getToolDeclarations(), toolRegistry: registry });
    expect(execution.toolRoute.toolNames).toContain('run_workflow');
  });
  it.each([[saveText, 'generate', 'generate_skill'], [createText, 'generate', 'generate_skill'], ['把刚才读取和计算的流程保存成工作流草稿。', 'save', 'capture_recent_workflow']])('exposes the exact authoring door for %s', (text, intent, firstTool) => {
    expect(classifySkillAuthoringIntent(text)).toBe(intent);
    expect(isConversationExecutionFactQuestion(text)).toBe(false);
    const registry = new ToolRegistry(); registerAllTools(registry);
    const dispatch = buildLumiTurnDispatch({ userId: 'authoring', text, channel: 'chat', source: 'command-center-chat', operationMode: 'assistant', targetIsLumi: true });
    const execution = buildLumiExecutionDecision({ flow: dispatch.flow, text, toolDeclarations: registry.getToolDeclarations(), toolRegistry: registry });
    const selection = buildLumiCapabilitySelection({ dispatch, execution, text, registry });
    const projection = buildModelToolProjection(execution, { lane: selection.lane, preferredTools: selection.preferredTools });
    expect(selection.lane).toBe('capability_learning');
    expect(projection.toolNames[0], JSON.stringify({ preferred: selection.preferredTools, route: execution.toolRoute, base: execution.baseToolPolicy })).toBe(firstTool);
    expect(projection.requiredToolNames).toContain(firstTool);
    expect(projection.toolNames.length).toBeLessThanOrEqual(32);
  });

  it.each(['刚才保存技能了吗？', '不要创建技能，只告诉我刚才读取的是哪个文件。', 'Did you already save the workflow?', '不要保存流程'])('does not reinterpret recall or negation as authoring: %s', text => {
    expect(classifySkillAuthoringIntent(text)).toBe('none');
  });

  it('does not capture another conversation or turn a read/model calculation into an executable algorithm', async () => {
    const registry = new ToolRegistry(); registerWorkflowTools(registry);
    recordWorkflow({ userId: 'capture-user', userIntent: '计算明细和总额', conversationExcerpt: '', conversationId: 'one', taskId: 'task-one', toolSequence: [{ name: 'read_file', args: { path: 'sample.csv' }, resultSummary: 'sample data', verified: true, operation: 'observe' }] });
    expect(getRecentWorkflows('capture-user', 'personal', '', 'two')).toHaveLength(0);
    const other = await registry.execute('capture_recent_workflow', { name: 'wrong-scope' }, { userId: 'capture-user', conversationId: 'two' });
    expect(JSON.parse(other)).toMatchObject({ ok: false, status: 'failed', code: 'no_recent_activity', availableSources: [] });
    expect(JSON.parse(other).nextAction).toContain('save_workflow');
    expect(getWorkflow('capture-user', 'wrong-scope')).toBeNull();
    const result = JSON.parse(await registry.execute('capture_recent_workflow', { name: 'not-an-algorithm' }, { userId: 'capture-user', conversationId: 'one' }));
    expect(result).toMatchObject({ ok: false, status: 'needs_authoring', sourceTaskId: 'task-one' });
    expect(result.nextAction).toContain('save_workflow');
    expect(result.nextAction).toContain('args.code');
    expect(result.nextAction).not.toContain('Call generate_skill');
    expect(getWorkflow('capture-user', 'not-an-algorithm')).toBeNull();
    registry.register({ name: 'read_file', description: 'Read input', parameters: {}, permission: 'public', securityLevel: 'safe', handler: async () => 'data' });
    await expect(registry.execute('save_workflow', { name: 'bypassed-capture', description: 'Read and calculate totals', steps: [{ tool: 'read_file', args: { path: { $inputRef: 'inputs.path' } } }] }, { userId: 'capture-user', conversationId: 'one', actionIntent: '把刚才流程保存成技能' })).rejects.toThrow('input-dependent calculation');
    expect(getWorkflow('capture-user', 'bypassed-capture')).toBeNull();
  });

  it('rejects forward, undeclared, malformed and prototype output references before saving', () => {
    for (const ref of ['step_2.items', 'other.items', 'step_1.__proto__.x', 4]) {
      expect(() => validateWorkflowSteps([
        { stepId: 'step_1', capabilityId: 'first', argumentsTemplate: { value: { $stepOutputRef: ref } } },
        { stepId: 'step_2', capabilityId: 'second', dependsOn: ['step_1'] },
      ])).toThrow();
    }
    expect(() => resolveWorkflowValue({ $stepOutputRef: 'step_1.items' }, {})).toThrow('current workflow run');
  });

  it.each(['${$inputRef:inputs.sourcePath}', '${$stepOutputRef:step_1}', '${$secretRef:inputs.key}'])(
    'rejects model-authored interpolation %s before persisting a draft', async reference => {
      const registry = new ToolRegistry(); registerWorkflowTools(registry);
      const userId = 'invalid-interpolation';
      await expect(registry.execute('save_workflow', {
        name: reference, steps: [{ tool: 'read_file', args: { path: reference } }],
      }, { userId })).rejects.toThrow('Workflow references must be JSON objects');
      expect(getWorkflow(userId, reference)).toBeNull();
    },
  );

  it('offers named skill/workflow discovery in a fresh turn and retains host-normalized computation results', async () => {
    expect(classifySkillAuthoringIntent('使用技能“订单汇总”处理新的条目数组')).toBe('use');
    const source = buildHandlerFunction('result = JSON.stringify({ total: args.values.reduce((sum: number, value: number) => {\nreturn sum + value;\n}, 0) });', { properties: { values: { type: 'array' } } });
    // The test supplies this pure synthetic body; it does not evaluate user or model source.
    const handler = new Function(ts.transpile(`return (${source});`, { target: ts.ScriptTarget.ES2022 }))();
    const first = JSON.parse((await handler({ values: [24, 24, 12] })).content[0].text);
    const second = JSON.parse((await handler({ values: [19, 12, 12.5] })).content[0].text);
    expect(first).toEqual({ status: 'completed', data: { total: 60 } });
    expect(second).toEqual({ status: 'completed', data: { total: 43.5 } });
  });
});
