import './helpers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LLM_GETTERS } from './helpers';

vi.mock('../server/llm/providers', () => ({
  makeLLMCall: vi.fn(async () => ({ text: '[]' })),
}));

describe('autonomous public web learning', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
    vi.clearAllMocks();
  });

  it('keeps the default learning workflow enabled for bounded public web learning', async () => {
    const { ensureLearningWorkflow } = await import('../server/autonomy/workflows');
    const { workflowAllowsPublicWebLearning } = await import('../server/autonomy/task_generator');

    const workflow = ensureLearningWorkflow('web_learning_workflow_user');

    expect(workflow.enabled).toBe(true);
    expect(workflow.allowedModes).toEqual(['analysis', 'desktop']);
    expect(workflow.externalAppsAllowed).toBe(false);
    expect(workflow.allowedActions).toEqual(expect.arrayContaining([
      'local_machine_awareness',
      'local_file_landmark_scan',
      'desktop_app_inventory',
      'running_process_observation',
      'desktop_body_map',
      'public_web_search',
      'industry_habit_research',
      'profession_context',
      'workflow_standard_refresh',
      'web_search',
      'url_fetch',
      'authority_research',
      'desktop_ai_list_targets',
      'desktop_ai_discovery_plan',
      'desktop_tool_target_discovery',
      'source_grounded_digest',
      'knowledge_update_candidate',
    ]));
    expect(workflowAllowsPublicWebLearning(workflow)).toBe(true);
    expect(workflow.description).toContain('公开网页');
    expect(workflow.description).toContain('登录墙');
  });

  it('seeds a throttled public-source refresh when autonomous generation returns no task', async () => {
    const { saveGateConfig } = await import('../server/autonomy/safety_gate');
    const { generateAutonomousTasks } = await import('../server/autonomy/task_generator');
    const { getTaskQueue } = await import('../server/autonomy/task_queue');
    const { readDB, writeDB } = await import('../db_layer');
    const userId = 'web_learning_seed_user';
    const db = readDB();
    db.professionProfiles = [{
      profession: 'lawyer',
      confidence: 0.86,
      evidence: ['中国裁判文书网', '企查查'],
      knowledgeDomains: ['诉讼法', '法律检索'],
      personaHints: ['严谨'],
      installedRelevantTools: ['中国裁判文书网'],
    }];
    db.memories = [
      ...(db.memories || []),
      {
        id: 'habit_web_learning_lawyer',
        userId,
        type: 'habit',
        content: '用户做法律工作时习惯先核验现行有效法律，再整理证据目录和代理词。',
        keywords: '[]',
        confidence: 0.9,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    writeDB(db);

    saveGateConfig({ autonomyLevel: 'full' });

    const first = await generateAutonomousTasks(userId, LLM_GETTERS);
    const queued = getTaskQueue().filter(task => task.userId === userId);
    const seeded = queued.find(task => task.title === '公开来源学习更新巡检');
    const bodyTask = queued.find(task => task.title === '本机身体地图观察');

    expect(first).toBe(2);
    expect(bodyTask).toBeTruthy();
    expect(bodyTask?.workflowId).toBe('workflow_lumi_continuous_learning');
    expect(bodyTask?.mode).toBe('desktop');
    expect(bodyTask?.description).toContain('自主本机身体学习任务');
    expect(bodyTask?.description).toContain('desktop_list_apps');
    expect(bodyTask?.description).toContain('不要打开应用');
    expect(bodyTask?.description).toContain('不要读取文件正文');
    expect(seeded).toBeTruthy();
    expect(seeded?.workflowId).toBe('workflow_lumi_continuous_learning');
    expect(seeded?.mode).toBe('analysis');
    expect(seeded?.description).toContain('web_search');
    expect(seeded?.description).toContain('authority_research');
    expect(seeded?.description).toContain('desktop_ai_discovery_plan');
    expect(seeded?.description).toContain('desktop_ai_register_target');
    expect(seeded?.description).toContain('不要使用需要登录');
    expect(seeded?.description).toContain('使用者行业习惯画像');
    expect(seeded?.description).toContain('legal_casework');
    expect(seeded?.description).toContain('现行有效法律');

    const second = await generateAutonomousTasks(userId, LLM_GETTERS);
    expect(second).toBe(0);
  });

  it('restricts local body learning tasks to observation tools', async () => {
    const { buildAutonomousToolPolicy, isLocalBodyLearningTask } = await import('../server/autonomy/task_executor');
    const task = {
      title: '本机身体地图观察',
      description: '自主本机身体学习任务：只观察本地电脑里的文件和桌面应用。',
    } as any;

    const policy = buildAutonomousToolPolicy(task, 50);

    expect(isLocalBodyLearningTask(task)).toBe(true);
    expect(policy.allowedTools).toEqual(expect.arrayContaining([
      'desktop_system_info',
      'desktop_list_apps',
      'desktop_list_files',
      'desktop_running_processes',
      'desktop_active_window',
    ]));
    expect(policy.allowedTools).not.toContain('desktop_open');
    expect(policy.allowedTools).not.toContain('desktop_capture_screen');
    expect(policy.allowedTools).not.toContain('desktop_run_command');
    expect(policy.allowedTools).not.toContain('computer_use');
    expect(policy.maxIterations).toBeLessThanOrEqual(16);
  });
});
