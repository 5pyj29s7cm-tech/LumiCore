import './helpers';
import { describe, expect, it } from 'vitest';

describe('Lumi runtime capability context', () => {
  it('summarizes tools, skills, adapters, and active task pointers for the turn', async () => {
    const { initDatabase } = await import('../db_layer');
    const { ToolRegistry } = await import('../server/tools/registry');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const { buildLumiRuntimeCapabilityContext } = await import('../server/cognition/capability_context');
    await initDatabase();

    const registry = new ToolRegistry();
    registry.register({
      name: 'client_get_state',
      description: 'Read Lumi client state.',
      parameters: {},
      handler: async () => '{}',
      permission: 'user',
      securityLevel: 'safe',
    });
    registry.register({
      name: 'work_takeover_task_advance',
      description: 'Advance a task.',
      parameters: {},
      handler: async () => '{}',
      permission: 'user',
      securityLevel: 'safe',
    });
    registry.register({
      name: 'desktop_ui_snapshot',
      description: 'Inspect desktop UI.',
      parameters: {},
      handler: async () => '{}',
      permission: 'user',
      securityLevel: 'safe',
    });
    registry.register({
      name: 'web_login_run',
      description: 'Run saved web login.',
      parameters: {},
      handler: async () => '{}',
      permission: 'user',
      securityLevel: 'safe',
    });

    const task = createWorkTakeoverTask({
      userId: 'capability_context_user',
      category: 'store',
      title: '接管店铺账号',
      nextActions: ['准备商品内容矩阵'],
      source: 'wechat',
      status: 'in_progress',
    });

    const flow = buildLumiTurnFlow({
      userId: 'capability_context_user',
      text: '继续推进这个任务',
      channel: 'chat',
      source: 'org-chat',
      category: 'organization',
      domain: 'work',
      orgId: 'org-a',
      operationMode: 'chat',
    });
    const prompt = buildLumiRuntimeCapabilityContext({
      userId: 'capability_context_user',
      text: '继续推进这个任务',
      flow,
      toolRegistry: registry,
      domain: 'work',
      orgId: 'org-a',
    });

    expect(prompt).toContain('Lumi Runtime Capability Context');
    expect(prompt).toContain('client/ui=1');
    expect(prompt).toContain('task=1');
    expect(prompt).toContain('desktop=1');
    expect(prompt).toContain('web/account=1');
    expect(prompt).toContain('Execution governance:');
    expect(prompt).toContain('verify=');
    expect(prompt).toContain('delegation=');
    expect(prompt).toContain('capabilityLearning=');
    expect(prompt).toContain('Skill workflows known');
    expect(prompt).toContain(task.id);
    expect(prompt).toContain('Relevant adapters/external systems');
    expect(prompt).toContain('understand the turn -> decide chat/work');
  });
});
