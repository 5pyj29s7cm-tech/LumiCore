import './helpers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LLM_GETTERS } from './helpers';

vi.mock('../server/llm/providers', () => ({
  makeLLMCall: vi.fn(async () => ({ text: '[]' })),
}));

describe('Lumi autonomous chain pressure', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
    vi.clearAllMocks();
  });

  it('keeps autonomous body and web learning throttled across repeated users', async () => {
    const { readDB, writeDB } = await import('../db_layer');
    const { saveGateConfig } = await import('../server/autonomy/safety_gate');
    const { generateAutonomousTasks } = await import('../server/autonomy/task_generator');
    const { getTaskQueue } = await import('../server/autonomy/task_queue');
    const db = readDB();
    const userIds = Array.from({ length: 6 }, (_, index) => `pressure_autonomy_user_${index + 1}`);

    db.professionProfiles = [{
      profession: 'lawyer',
      confidence: 0.9,
      evidence: ['中国裁判文书网', '企查查', '法院立案网'],
      knowledgeDomains: ['诉讼法', '法律检索', '证据规则'],
      personaHints: ['严谨'],
      installedRelevantTools: ['中国裁判文书网', '企查查'],
    }];
    db.memories = [
      ...(db.memories || []),
      ...userIds.map((userId, index) => ({
        id: `pressure_habit_${index}`,
        userId,
        type: 'habit',
        content: '用户做法律工作时要求三段论、现行有效法律核验、证据目录和类案来源都清楚。',
        keywords: '[]',
        confidence: 0.9,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
    ];
    writeDB(db);
    saveGateConfig({ autonomyLevel: 'full' });

    const firstPass = [];
    for (const userId of userIds) {
      firstPass.push(await generateAutonomousTasks(userId, LLM_GETTERS));
    }
    const secondPass = [];
    for (const userId of userIds) {
      secondPass.push(await generateAutonomousTasks(userId, LLM_GETTERS));
    }

    expect(firstPass).toEqual(userIds.map(() => 2));
    expect(secondPass).toEqual(userIds.map(() => 0));

    const queued = getTaskQueue().filter(task => userIds.includes(task.userId));
    expect(queued).toHaveLength(userIds.length * 2);
    expect(queued.filter(task => task.title === '本机身体地图观察')).toHaveLength(userIds.length);
    expect(queued.filter(task => task.title === '公开来源学习更新巡检')).toHaveLength(userIds.length);
    expect(queued.every(task => task.workflowId === 'workflow_lumi_continuous_learning')).toBe(true);
    expect(queued.filter(task => task.mode === 'desktop')).toHaveLength(userIds.length);
    expect(queued.filter(task => task.mode === 'analysis')).toHaveLength(userIds.length);
  });

  it('keeps local body learning on an observation-only policy under pressure', async () => {
    const { buildAutonomousToolPolicy, isLocalBodyLearningTask } = await import('../server/autonomy/task_executor');
    const unsafeTools = [
      'desktop_open',
      'desktop_capture_screen',
      'desktop_run_command',
      'computer_use',
      'desktop_ui_click',
      'desktop_ui_type',
      'keyboard_type',
      'mouse_click',
      'write_file',
      'authority_research_save',
      'desktop_ai_register_target',
    ];

    for (let index = 0; index < 20; index++) {
      const task = {
        title: index % 2 === 0 ? '本机身体地图观察' : 'local machine body refresh',
        description: 'desktop_body_map local_machine_awareness: observe apps, files, processes, and foreground window only.',
      } as any;
      const policy = buildAutonomousToolPolicy(task, 50);

      expect(isLocalBodyLearningTask(task)).toBe(true);
      expect(policy.allowedTools).toContain('desktop_list_apps');
      expect(policy.allowedTools).toContain('desktop_list_files');
      for (const tool of unsafeTools) {
        expect(policy.allowedTools).not.toContain(tool);
      }
      expect(policy.maxIterations).toBeLessThanOrEqual(16);
    }
  });

  it('registers a desktop AI catalog and resolves exactly one explicit target', async () => {
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerDesktopAiTools } = await import('../server/tools/definitions/desktop_ai_tools');
    const registry = new ToolRegistry();
    const userId = 'pressure_desktop_ai_user';
    registerDesktopAiTools(registry);

    for (let index = 0; index < 10; index++) {
      await registry.execute('desktop_ai_register_target', {
        id: `pressure-ai-${index}`,
        label: `Pressure AI ${index}`,
        aliases: [`PressureTool${index}`],
        openTargets: [`Pressure AI ${index}`, `https://example.com/pressure-ai-${index}`],
        surface: index % 2 === 0 ? 'browser_app' : 'desktop_app',
        sourceUrls: [`https://example.com/pressure-ai-${index}`],
        notes: 'Pressure-test registered target from source-grounded candidate.',
      }, { userId, userConfirmed: true });
    }

    const list = JSON.parse(await registry.execute('desktop_ai_list_targets', {}, { userId }));
    const registered = list.targets.filter((target: any) => String(target.id).startsWith('pressure-ai-'));
    expect(registered).toHaveLength(10);
    expect(registered.every((target: any) => target.source === 'registered')).toBe(true);

    let foreground = 'Lumi';
    const ask = JSON.parse(await registry.execute('desktop_ai_ask', {
      question: 'Return one concise test answer.',
      target: 'pressure-ai-7',
      send: false,
    }, {
      userId,
      desktopRelay: async (name, args) => {
        if (name === 'desktop_active_window') return JSON.stringify({ title: foreground, process_name: foreground });
        if (name === 'desktop_open') {
          foreground = 'Pressure AI 7';
          return JSON.stringify({ ok: true, target: args.target });
        }
        if (name === 'desktop_clipboard_write') return 'Clipboard updated';
        if (name === 'desktop_keyboard_press') return `Pressed ${args.key}`;
        return 'ok';
      },
    }));

    expect(ask.preparedCount).toBe(1);
    expect(ask.results).toHaveLength(1);
    expect(ask.results[0]).toMatchObject({
      target: 'pressure-ai-7',
      label: 'Pressure AI 7',
      status: 'prepared',
    });
  });
});
