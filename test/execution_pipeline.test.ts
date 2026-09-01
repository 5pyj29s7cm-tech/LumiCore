import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerAllTools(registry);
  return registry;
}

describe('unified execution pipeline', () => {
  it('routes a new persistent task to the task hub while keeping external sends fenced', () => {
    const registry = createRegistry();
    const text = '\u8bf7\u521b\u5efa\u4e00\u4e2a\u53ef\u8de8\u91cd\u542f\u7ee7\u7eed\u7684\u6301\u4e45\u4efb\u52a1\u3002\u6807\u9898\u201c\u9752\u7a79\u5ba2\u6237\u8ddf\u8fdb\u95ed\u73af\u201d\uff0c\u7c7b\u522b customer\uff0c\u6765\u6e90 chat\u3002\u73b0\u5728\u53ea\u521b\u5efa\u5e76\u6301\u4e45\u5316\u4efb\u52a1\uff0c\u4e0d\u8981\u53d1\u9001\u4efb\u4f55\u6d88\u606f\u3002';
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-work-task-user',
        text,
        channel: 'chat',
        source: 'command-center-chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['*'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 25,
      },
    });

    expect(pipeline.normalizedIntent).toMatchObject({
      kind: 'work_task',
      operation: 'create',
      relation: 'new',
    });
    expect(pipeline.execution.allowToolUse).toBe(true);
    expect(pipeline.execution.toolRoute?.toolNames).toContain('work_takeover_task_create');
    expect(pipeline.execution.toolPolicy.forbiddenTools).not.toContain('work_takeover_task_create');
    expect(pipeline.execution.toolPolicy.requireConfirmation).not.toContain('work_takeover_task_create');
  });

  it('keeps exact Lumi client navigation when the user forbids other programs and content changes', () => {
    const registry = createRegistry();
    const text = '主程序实机验收·原生导航闭环第一步：请返回 Lumi 个人主页，只执行客户端导航，不要打开其他程序，不要修改任何内容。完成后只根据本轮真实回执回答。';
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-client-navigation-user',
        text,
        channel: 'chat',
        source: 'command-center-chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['*'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 25,
      },
    });

    expect(pipeline.normalizedIntent).toMatchObject({
      kind: 'client_navigation',
      operation: 'navigate',
      target: 'home',
      clientAction: 'focus_home',
      sideEffectClass: 'none',
    });
    expect(pipeline.turnIntent.flow.clientActionOnlyTurn).toBe(true);
    expect(pipeline.execution.toolPolicy.allowedTools).toEqual(expect.arrayContaining([
      'client_get_state',
      'client_action',
    ]));
    expect(pipeline.execution.toolPolicy.allowedTools.length).toBeGreaterThan(2);
    expect(pipeline.execution.toolPolicy.forbiddenTools).not.toContain('client_action');
  });

  it('keeps the exact requested local write when the user forbids all other file and external mutations', () => {
    const registry = createRegistry();
    const text = '请在 C:\\Users\\test-user\\Documents\\Lumi主程序实机验收_20260817.txt 新建一个 TXT 文件，只写入以下三行：第一行“验收对象：Lumi 主程序”；第二行“验收项目：本地文件创建与回读”；第三行“验收代号：青穹-17”。写入后必须重新读取。除这个文件外不得修改其他文件，不要打开其他应用，不要发送、上传或发布任何内容。';
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text,
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['*'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 25,
      },
    });
    expect(pipeline.execution.toolRoute?.toolNames).toEqual(expect.arrayContaining(['write_file', 'read_file']));
    expect(pipeline.execution.toolPolicy.forbiddenTools).not.toContain('write_file');
    expect(pipeline.execution.toolPolicy.allowedTools).toContain('write_file');
  });

  it('keeps an exact app launch when the user forbids file edits and substitute apps', () => {
    const registry = createRegistry();
    const text = '主程序实机验收：请打开 Windows 计算器。不得用浏览器、同名文件或其他应用替代；打开后读取当前活动窗口。不要输入算式，不要修改文件。';
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user', text, channel: 'chat', source: 'chat',
        operationMode: 'assistant', targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 25,
      },
    });
    expect(pipeline.normalizedIntent).toMatchObject({ kind: 'desktop_operation', target: 'Windows 计算器' });
    expect(pipeline.execution.toolRoute?.toolNames).toEqual(expect.arrayContaining(['desktop_open', 'desktop_active_window']));
    expect(pipeline.execution.toolPolicy.forbiddenTools).not.toContain('desktop_open');
  });

  it('builds turn intent, capability plan, policy and trace from one call', () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: '打开 AutoCAD',
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      source: 'chat',
    });

    expect(pipeline.turnIntent.flow.routeText).toContain('AutoCAD');
    expect(pipeline.execution.allowToolUse).toBe(true);
    expect(pipeline.capabilityPlan.schemaVersion).toBe(1);
    expect(pipeline.capabilityPlan.taskLedgerRequired).toBe(true);
    expect(pipeline.capabilityPlan.capabilityIds.length).toBeGreaterThan(0);
    expect(pipeline.executionPlan.decisionAuthority).toBe('semantic_planner');
    expect(pipeline.executionPlan.scriptAuthority).toBe('adapter_only');
    expect(pipeline.executionPlan.nodes.length).toBeGreaterThan(0);
    const adapterNodes = pipeline.executionPlan.nodes
      .filter(node => node.executionRole === 'adapter');
    expect(pipeline.executionPlan.expectedEvidence.length)
      .toBe(adapterNodes.length);
    expect(pipeline.executionPlan.edges.length).toBeGreaterThan(0);
    expect(pipeline.executionPlan.nodes.some(node => node.executionRole === 'planner')).toBe(true);
    expect(pipeline.executionPlan.nodes.some(node => node.executionRole === 'verifier')).toBe(true);
    expect(pipeline.executionPlan.nodes.some(node => node.executionRole === 'join')).toBe(true);
    for (const adapter of adapterNodes) {
      expect(pipeline.executionPlan.edges).toContainEqual(expect.objectContaining({
        to: adapter.nodeId,
        condition: 'selected',
      }));
      expect(pipeline.executionPlan.edges).toContainEqual(expect.objectContaining({
        from: adapter.nodeId,
        condition: 'success',
      }));
    }
    expect(pipeline.capabilityPlan.promptOverlay).toContain('Capability Execution Plan');
    expect(pipeline.intentTrace.toolPolicy.allowedTools)
      .toEqual(pipeline.execution.toolPolicy.allowedTools);
  });

  it('keeps capability identity shared across chat, voice and task entrances', () => {
    const registry = createRegistry();
    const build = (channel: 'chat' | 'voice' | 'task') => buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: '打开 AutoCAD',
        channel,
        source: channel,
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      source: channel,
    });
    const chat = build('chat');
    const voice = build('voice');
    const task = build('task');
    const toolCapability = registry.getCapabilityManifest()
      .find(entry => entry.toolName === 'desktop_open')?.capabilityId;

    expect(toolCapability).toBeTruthy();
    expect(chat.capabilityPlan.capabilityIds).toContain(toolCapability);
    expect(voice.capabilityPlan.capabilityIds).toContain(toolCapability);
    expect(task.capabilityPlan.capabilityIds).toContain(toolCapability);
    expect(chat.turnIntent.channel).toBe('chat');
    expect(voice.turnIntent.channel).toBe('voice');
    expect(task.turnIntent.channel).toBe('task');
    expect(chat.executionPlan.planId).toBe(voice.executionPlan.planId);
    expect(voice.executionPlan.planId).toBe(task.executionPlan.planId);
  });

  it('does not turn product feedback into execution merely because chat can see the manifest', () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-feedback-user',
        text: '你发消息给我的时候能不能不要一坨丢过来',
        channel: 'chat',
        source: 'command-center-chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['*'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 25,
      },
    });

    // The operation mode is an authorization ceiling, not permission to
    // execute an action in a conversational turn.
    expect(pipeline.execution.allowToolUse).toBe(false);
    expect(pipeline.turnIntent.flow.allowToolUseForTurn).toBe(false);
    expect(pipeline.executionRequested).toBe(false);
    expect(pipeline.trustedActionContinuation).toBe(false);
    expect(pipeline.capabilityPlan.taskLedgerRequired).toBe(false);
  });

  it('keeps an explicit desktop request executable in assistant mode', () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-explicit-action-user',
        text: '打开网易云音乐并播放一首歌',
        channel: 'chat',
        source: 'command-center-chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['*'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 25,
      },
    });

    expect(pipeline.turnIntent.flow.allowToolUseForTurn).toBe(true);
    expect(pipeline.executionRequested).toBe(true);
    expect(pipeline.modelToolProjection.toolNames).toContain('desktop_open');
  });

  it('fails external commits closed and binds confirmation to immutable payload evidence', () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: 'send to Alice: deployment is complete',
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
    });

    expect(pipeline.normalizedIntent.sideEffectClass).toBe('external_commit');
    expect(pipeline.executionPlan.risk.requiresConfirmation).toBe(true);
    expect(pipeline.executionPlan.risk.failClosed).toBe(true);
    expect(pipeline.executionPlan.risk.confirmationBinding).toMatchObject({
      taskId: pipeline.executionPlan.taskId,
      target: 'Alice',
      tool: '',
    });
    expect(pipeline.executionPlan.risk.confirmationBinding?.payloadDigest).toHaveLength(64);
    expect(pipeline.executionPlan.fallbackPolicy).toMatchObject({
      maxRetries: 0,
      reconcileUnknownOutcome: true,
      allowLegacyRoute: false,
      onUnknownOutcome: 'reconcile_then_stop',
    });
  });

  it('keeps confirmation-only external commits executable only up to the confirmation gate', () => {
    const registry = createRegistry();
    const text = '请准备给测试联系人“验收占位联系人”发送消息“Lumi外发确认测试”，但在真正发送前必须向我确认；现在只到等待确认，不要发送。';
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text,
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['*'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 25,
      },
    });

    expect(pipeline.normalizedIntent).toMatchObject({
      kind: 'messaging_send',
      target: '验收占位联系人',
      payload: 'Lumi外发确认测试',
      sideEffectClass: 'external_commit',
    });
    expect(pipeline.execution.toolRoute?.toolNames).toEqual(['wechat_send_message']);
    expect(pipeline.execution.toolPolicy.allowedTools).toEqual(['wechat_send_message']);
    expect(pipeline.execution.toolPolicy.forbiddenTools).not.toContain('wechat_send_message');
    expect(pipeline.executionPlan.risk).toMatchObject({
      requiresConfirmation: true,
      failClosed: true,
    });
  });

  it('permits bounded jittered retry only for read/status plans', () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: 'read messages from Alice',
        channel: 'voice',
        source: 'voice',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
    });

    expect(pipeline.normalizedIntent.operation).toBe('read');
    expect(pipeline.executionPlan.risk.sideEffectClass).toBe('none');
    expect(pipeline.executionPlan.fallbackPolicy).toMatchObject({
      retryClass: 'idempotent_only',
      maxRetries: 2,
      jitter: true,
      allowLegacyRoute: false,
    });
  });

  it('compiles a chat workflow match as a model-owned capability candidate', () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: 'Lumi, show me a visible demo of yourself',
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      source: 'chat',
    });

    expect(pipeline.turnIntent.boundary).not.toBe('skill_workflow');
    expect(pipeline.turnIntent.flow.specialWorkflow).toBeNull();
    expect(pipeline.turnIntent.flow.workflowHint?.id).toBe('self_intro_demo');
    expect(pipeline.turnIntent.flow.workflowRouting).toBe('model_hint');
    expect(pipeline.executionPlan.nodes).toContainEqual(expect.objectContaining({
      type: 'skill',
      executionRole: 'adapter',
      capabilityId: 'desktop-automation/self_intro_demo',
    }));
    expect(pipeline.executionPlan.decisionAuthority).toBe('semantic_planner');
    expect(pipeline.executionPlan.nodes.filter(node => node.toolName).length).toBeGreaterThan(0);
    expect(pipeline.executionPlan.nodes).toContainEqual(expect.objectContaining({
      toolName: 'client_action',
      state: 'candidate',
    }));
  });
});
