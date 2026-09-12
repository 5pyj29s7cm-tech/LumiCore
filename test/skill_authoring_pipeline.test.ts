import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({ model: vi.fn(), dependencyCommand: vi.fn() }));
vi.mock('../server/llm/providers', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/providers')>(), makeLLMCall: doubles.model,
}));
vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(), exec: doubles.dependencyCommand,
}));

import { initDatabase, flushDBOrThrow } from '../db_layer';
import { addMessage, getMessages, getOrCreateActiveConversation } from '../server/conversation/manager';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { runWithTools } from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { registerWorkflowTools } from '../server/tools/definitions/workflow_tools';
import { registerSkillTools, setSkillLLMGetters } from '../server/tools/definitions/skill_tools';
import { registerAllTools } from '../server/tools/definitions';
import { clearWorkflows, getRecentWorkflows, recordWorkflow } from '../server/skills/worklog';
import { classifySkillAuthoringIntent } from '../server/skills/authoring_intent';
import { computeGeneratedSkillArtifactHash } from '../server/skills/generator';
import { getWorkflow } from '../server/agents/workflows';
import { guardTaskTargetToolCall } from '../server/conversation/task_target_anchor';
import type { ToolContext } from '../server/tools/types';

const noClient = [() => null, () => null, () => null, () => null, () => null] as const;
const onlyDraft = '把本会话刚才读取订单 CSV、按数量乘单价计算每项金额和总额的流程，保存成可重复使用的技能，命名“LC-SKILL-订单汇总-20260908B”。以后我给另一份 CSV 也能使用，不能固定今天的数据和答案。请实际生成草稿，给我审核信息，暂不安装或运行。';
let serial = 0;
beforeAll(() => initDatabase());
beforeEach(() => {
  clearWorkflows();
  doubles.model.mockReset();
  doubles.dependencyCommand.mockReset();
  // The real generator/reviewer writes and validates its actual draft files.
  // Only external package-manager I/O is isolated; no generated code runs.
  doubles.dependencyCommand.mockImplementation((command, options, callback) => {
    const directory = String(options.cwd);
    expect(command).toContain('--ignore-scripts');
    expect(directory).not.toBe(process.cwd());
    if (String(command).startsWith('npm install --package-lock-only ')) {
      const stagingRoot = path.join(String(process.env.LUMI_DATA_DIR), 'data', 'skill-draft-staging');
      expect(path.relative(stagingRoot, directory)).not.toMatch(/^\.\./);
      expect(path.dirname(directory)).toBe(stagingRoot);
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({
        name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
        packages: { '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies } },
      }));
    } else {
      expect(String(command)).toMatch(/^npm ci --ignore-scripts /);
      fs.mkdirSync(path.join(directory, 'node_modules'), { recursive: true });
    }
    callback(null, '', '');
    return { kill: vi.fn() };
  });
  setSkillLLMGetters({ getDeepSeek: () => null, getGemini: () => null, getRelay: () => null });
});

function plan(registry: ToolRegistry, userId: string, conversationId: string, text: string, taskId: string) {
  const pipeline = buildLumiExecutionPipeline({
    dispatch: { userId, text, channel: 'chat', source: 'local_acceptance_harness', domain: 'personal', operationMode: 'assistant', targetIsLumi: true },
    registry, taskId, persistedConversationHistory: getMessages(conversationId),
  });
  const context: ToolContext = {
    userId, conversationId, taskId, requestId: `${taskId}-request`, domain: 'personal', source: 'local_acceptance_harness',
    authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local',
    actionIntent: text, routedTaskText: pipeline.turnIntent.flow.routeText,
    acceptedTaskTarget: pipeline.turnIntent.flow.acceptedTaskTarget,
    currentTurnExecutionRequested: pipeline.executionRequested,
    toolPolicy: pipeline.authorizationPolicy, modelToolProjection: pipeline.modelToolProjection,
    requestConfirmation: async name => name === 'generate_skill' || name === 'capture_recent_workflow',
  };
  return { pipeline, context };
}

async function run(registry: ToolRegistry, context: ToolContext, text: string) {
  const messages = getMessages(context.conversationId!).map(row => ({ role: row.role as 'user' | 'assistant', content: row.message }));
  return runWithTools([...messages, { role: 'user', content: text }], registry,
    { provider: 'relay', model: 'synthetic-official', userId: context.userId, conversationId: context.conversationId, domain: 'personal', requestId: context.requestId },
    undefined, 6, ...noClient, undefined, context);
}

describe('normal pipeline skill authoring after real same-conversation work', () => {
  it('keeps a save-only follow-up on workflow tools without reopening generic capability discovery', () => {
    const registry = new ToolRegistry(); registerAllTools(registry);
    const conversation = getOrCreateActiveConversation('save-only-tools', 'lumi', 'personal', '');
    const { pipeline } = plan(registry, 'save-only-tools', conversation.id,
      '继续完成刚才未完成的工作流草稿保存。只保存读取、计算、写文件这三个步骤，文件路径用参数。不要发布或安装新技能。', 'save-only-task');
    expect(pipeline.modelToolProjection.toolNames).toEqual(['capture_recent_workflow', 'save_workflow', 'get_workflow', 'list_workflows']);
    expect(pipeline.modelToolProjection.allowDynamicDiscovery).toBe(false);
  });
  it('keeps a compound workflow save on execution and recipe tools, without generating a new package', () => {
    const registry = new ToolRegistry(); registerAllTools(registry);
    const userId = 'workflow-recipe-scope';
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const text = '这是虚构验收，不要记入个人记忆。请读取 C:/Users/test/Documents/input.csv，计算 total 并生成 output.csv。然后把读取、计算、写文件保存成可复用工作流草稿。先保存草稿，不发布。';
    const { pipeline } = plan(registry, userId, conversation.id, text, 'workflow-recipe-scope-task');
    const names = pipeline.modelToolProjection.toolNames;
    for (const name of ['read_file', 'code_execution', 'write_file', 'save_workflow']) expect(names).toContain(name);
    for (const name of ['generate_skill', 'install_skill', 'publish_workflow']) expect(names).not.toContain(name);
  });
  it.each([true, false])('creates only a reviewed draft after read/calculation (explicit draft=%s)', async explicitDraft => {
    const number = ++serial, userId = `skill-pipeline-${number}`;
    const registry = new ToolRegistry();
    const relayClient = { provider: 'synthetic-official-client' };
    const getRelay = () => relayClient;
    const getLmStudio = () => ({ provider: 'synthetic-local-client' });
    registerAllTools(registry, { getDeepSeek: noClient[0], getGemini: noClient[1], getRelay, getLmStudio });
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const filePath = path.join(String(process.env.LUMI_DATA_DIR), `LC-SKILL-INPUT-${number}.csv`);
    fs.writeFileSync(filePath, 'product,quantity,price\nA,2,12\nB,3,8\nC,4,3\n');
    const readText = `读取 ${filePath}，按数量乘单价计算每项金额和总额，不修改原文件。`;
    const read = plan(registry, userId, conversation.id, readText, `task-read-${number}`);
    doubles.model.mockResolvedValueOnce({ text: '', toolCalls: [{ id: 'read-input', name: 'read_file', arguments: { path: filePath } }] })
      .mockImplementationOnce(async messages => {
        const actual = [...messages].reverse().find(row => row.role === 'tool' && row.name === 'read_file');
        const csv = String(actual?.content).match(/product,quantity,price\r?\n(?:[ABC],\d+,\d+\r?\n?){3}/)?.[0];
        expect(csv).toBeTruthy();
        const amounts = csv!.trim().split(/\r?\n/).slice(1).map(line => { const [, quantity, price] = line.split(','); return Number(quantity) * Number(price); });
        return { text: `各项金额为${amounts.join('、')}，总额${amounts.reduce((a,b)=>a+b,0)}。`, toolCalls: [] };
      });
    const readResult = await run(registry, read.context, readText);
    expect(readResult.text).toContain('总额60');
    expect(readResult.toolCalls[0].envelope?.status).toBe('verified_success');
    addMessage({ userId, conversationId: conversation.id, role: 'user', content: readText, requestId: read.context.requestId, deferActionPreparation: true });
    addMessage({ userId, conversationId: conversation.id, role: 'assistant', content: readResult.text, toolCalls: readResult.toolCalls, requestId: read.context.requestId });
    await flushDBOrThrow();
    const trace = getRecentWorkflows(userId, 'personal', '', conversation.id);
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ taskId: read.context.taskId, conversationId: conversation.id });

    const name = `LC-SKILL-PIPELINE-${number}`;
    const authorText = explicitDraft ? onlyDraft.replace('LC-SKILL-订单汇总-20260908B', name)
      : `把刚才读取和计算的流程保存成可复用技能，命名“${name}”。`;
    const author = plan(registry, userId, conversation.id, authorText, `task-author-${number}`);
    expect(author.pipeline.executionRequested).toBe(true);
    expect(author.pipeline.authorizationPolicy.forbiddenTools).not.toContain('generate_skill');
    expect(author.pipeline.modelToolProjection.requiredToolNames).toContain('generate_skill');
    expect(registry.get('generate_skill')?.securityLevel).toBe('confirm');
    expect(registry.get('generate_skill')?.permission).toBe('admin');
    let iteration = 0;
    let generationCalls = 0;
    doubles.model.mockImplementation(async (messages, declarations, config, ...getters) => {
      if (config.source === 'skill_generator') {
        generationCalls += 1;
        expect(config.conversationId).toBe(conversation.id);
        expect(config.requestId).toBe(author.context.requestId);
        expect(config.domain).toBe('personal');
        expect(config.responseFormat).toBeUndefined();
        expect(config.thinkingMode).toBe('disabled');
        expect(config.maxTokens).toBe(4096);
        expect(String(messages[0].content)).toContain('Callable instance methods:');
        expect(String(messages[0].content)).toContain('not for/while/do loops');
        expect(String(messages[0].content)).toContain('throw a descriptive string');
        expect(getters[11]).toBe(getRelay);
        expect(getters[11]()).toBe(relayClient);
        expect(getters[6]).toBe(getLmStudio);
        expect(String(messages[0].content)).toContain('quantity');
        expect(String(messages[0].content)).not.toContain('JSON.stringify({{ total }})');
        const candidate = {
          skillName: `lc-pipeline-${number}`, toolName: `lc_pipeline_${number}`, toolDescription: 'Calculate line amounts and total.\nUse runtime order rows.',
          inputSchema: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { quantity: { type: 'number' }, price: { type: 'number' } }, required: ['quantity', 'price'] } } }, required: ['rows'] },
          handlerCode: explicitDraft && generationCalls === 1 ? "const invalid = '\n';" : 'const amounts = args.rows.map((row: any) => {\nreturn row.quantity * row.price;\n}); result = JSON.stringify({ amounts, total: amounts.reduce((sum: number, amount: number) => sum + amount, 0) });\n// Replacement syntax must stay literal: $& $` $\'',
          permissions: [], sideEffects: [], risk: 'low',
        };
        const { handlerCode, ...metadata } = candidate;
        return { text: '```json\n' + JSON.stringify(metadata) + '\n```\n```typescript\n' + handlerCode + '\n```', toolCalls: [] };
      }
      expect(declarations.map(row => row.function.name)).toContain('generate_skill');
      expect(config.protectedToolNames).toContain('generate_skill');
      const currentIteration = iteration++;
      if (!explicitDraft && currentIteration === 0) return { text: '', toolCalls: [{ id: 'bad-source', name: 'capture_recent_workflow', arguments: { name, sourceTaskId: 'LC-TASK-ORDERS' } }] };
      if (!explicitDraft && currentIteration === 1) {
        expect(String(messages.at(-1)?.content)).toContain('not exposed for the current task');
      }
      if (currentIteration === (explicitDraft ? 0 : 1)) return { text: '', toolCalls: [{ id: 'author-draft', name: 'generate_skill', arguments: { name, description: 'Accept runtime rows with quantity and price. Return each quantity*price amount and their total. Do not hardcode sample values, read host files, install, or run the generated code.' } }] };
      return { text: '草稿已生成，等待审核。尚未安装或运行。', toolCalls: [] };
    });
    const result = await run(registry, author.context, authorText);
    const created = result.toolCalls.find(record => record.name === 'generate_skill');
    expect(generationCalls).toBe(explicitDraft ? 2 : 1);
    expect(created, JSON.stringify(result.toolCalls.map(r=>({name:r.name,error:r.error,result:r.result})))).toBeTruthy();
    expect(created?.error).toBeUndefined();
    expect(created?.envelope?.status).toBe('verified_success');
    const draft = JSON.parse(created!.result!);
    expect(draft).toMatchObject({ ok: true, status: 'draft', executable: false, installed: false, displayName: name, review: { status: 'draft', requiresUserApproval: true, staticCheck: { passed: true }, trialRun: { passed: true } } });
    const source = fs.readFileSync(draft.entryPath, 'utf8');
    const manifest = fs.readFileSync(draft.manifestPath, 'utf8');
    const lock = fs.readFileSync(path.join(draft.draftDirectory, 'package-lock.json'), 'utf8');
    expect(source).toContain('row.quantity * row.price');
    expect(computeGeneratedSkillArtifactHash(source, manifest, lock)).toBe(draft.review.contentHash);
    expect(result.toolCalls.some(record => /^(install_skill|publish_workflow|run_workflow)$/.test(record.name))).toBe(false);
    expect(getWorkflow(userId, name)).toBeNull();
    if (!explicitDraft) {
      const captures = result.toolCalls.filter(record => record.name === 'capture_recent_workflow');
      expect(captures.some(record => record.envelope?.status === 'verified_success')).toBe(false);
    }
    // The authoring turn must not overwrite the business source trace.
    expect(getRecentWorkflows(userId, 'personal', '', conversation.id)).toHaveLength(1);
  });

  it('keeps explicit draft generation separate from the negated install/run steps', () => {
    expect(classifySkillAuthoringIntent(onlyDraft)).toBe('generate');
    expect(classifySkillAuthoringIntent('创建技能草稿，不要安装或运行。')).toBe('generate');
    expect(classifySkillAuthoringIntent('不要创建技能，暂不生成草稿。')).toBe('none');
    expect(classifySkillAuthoringIntent('你已经生成技能草稿了吗？')).toBe('none');
    expect(classifySkillAuthoringIntent('把刚才读取和计算的流程保存成可复用技能。')).toBe('generate');
    expect(classifySkillAuthoringIntent('把刚才读取和计算保存成可复用工作流草稿。')).toBe('save');
  });

  it('exempts only explicit draft authoring while preserving file and arbitrary process guards', () => {
    const guard = (taskText: string, toolName = 'generate_skill') => guardTaskTargetToolCall({
      taskText, toolName, arguments: {}, forbidUnstructuredExecution: true,
    });
    expect(guard(onlyDraft).allowed).toBe(true);
    expect(guard(onlyDraft, 'run_command').allowed).toBe(false);
    expect(guardTaskTargetToolCall({ taskText: onlyDraft, toolName: 'read_file', arguments: { path: 'C:/unrelated.csv' }, enforceStructuredFileRead: true }).allowed).toBe(false);
    for (const text of ['读取订单CSV并计算总额，不要生成技能。', '请只讲解如何读取CSV、计算总额并保存成技能，不要生成草稿。', '读取CSV计算总额。']) {
      expect(classifySkillAuthoringIntent(text)).toBe('none');
      expect(guard(text).allowed).toBe(false);
    }
  });

  it.each(['declined', 'remote', 'non-admin', 'forbidden'] as const)('preserves the %s authorization boundary before draft model or package activity', async boundary => {
    const registry = new ToolRegistry(); registerSkillTools(registry);
    const { context } = plan(registry, 'blocked-author', 'blocked-conversation', onlyDraft, `task-blocked-${boundary}`);
    if (boundary === 'declined') context.requestConfirmation = async () => false;
    if (boundary === 'remote') context.localExecution = false;
    if (boundary === 'non-admin') context.authRole = 'user';
    if (boundary === 'forbidden') context.toolPolicy = { ...context.toolPolicy, forbiddenTools: ['generate_skill'] };
    const result = await executeToolCall({ registry, context, name: 'generate_skill', arguments: { name: 'LC-BLOCKED-DRAFT', description: 'Compute a sum from runtime inputs.' } });
    expect(result.envelope?.status).not.toBe('verified_success');
    expect(doubles.model).not.toHaveBeenCalled();
    expect(doubles.dependencyCommand).not.toHaveBeenCalled();
  });

  it('never returns source IDs from another conversation and treats missing capture as failed', async () => {
    const registry = new ToolRegistry(); registerWorkflowTools(registry);
    recordWorkflow({ userId: 'isolated-capture', userIntent: 'Calculate a total', conversationExcerpt: '', conversationId: 'another-conversation', taskId: 'task-from-another-conversation', toolSequence: [{ name: 'read_file', args: {}, resultSummary: 'synthetic data', verified: true, operation: 'observe' }] });
    const record = await executeToolCall({ name: 'capture_recent_workflow', arguments: { name: 'LC-NO-TRACE', sourceTaskId: 'task-from-another-conversation' }, registry,
      context: { userId: 'isolated-capture', domain: 'personal', conversationId: 'empty-conversation', taskId: 'task-empty', requestId: 'request-empty', currentTurnExecutionRequested: true, actionIntent: '保存成可复用工作流', requestConfirmation: async () => true } });
    expect(record.envelope?.status).toBe('failed');
    expect(JSON.parse(record.result || '{}')).toMatchObject({ ok: false, status: 'failed', code: 'source_task_not_found', availableSources: [] });
  });
});
