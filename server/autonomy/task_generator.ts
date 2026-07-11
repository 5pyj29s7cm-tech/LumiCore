/**
 * Autonomous Task Generator — curiosity-driven self-initiation.
 * Gathers context about the user's state and asks the LLM to suggest useful autonomous tasks.
 */
import { isAutonomousWorkAllowed } from './safety_gate';
import { enqueue } from './task_queue';
import {
  DEFAULT_LEARNING_WORKFLOW_ID,
  listEnabledAutonomousWorkflows,
  type AutonomousWorkflow,
} from './workflows';
import { createPlan, updatePlan, type LumiPlan } from './planner';
import { readDB, writeDB } from '../../db_layer';
import { makeLLMCall, NormalizedMessage } from '../llm/providers';
import { getRecentActivity } from '../context/activity_stream';
import { getUserPreferredLLMConfig } from '../llm/user_preferences';
import { formatIndustryLearningContext } from './industry_learning';

interface LLMGetters {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
}

type GeneratedAutonomousTask = {
  title: string;
  description: string;
  mode: 'desktop' | 'terminal' | 'analysis';
  priority: number;
  workflowId?: string;
};

export const AUTONOMOUS_WEB_LEARNING_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const AUTONOMOUS_WEB_LEARNING_SETTING_PREFIX = 'autonomous_public_web_learning_last_run:';
export const AUTONOMOUS_LOCAL_BODY_LEARNING_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const AUTONOMOUS_LOCAL_BODY_LEARNING_SETTING_PREFIX = 'autonomous_local_body_learning_last_run:';

function toPlanPriority(priority: number): LumiPlan['priority'] {
  if (priority >= 9) return 'critical';
  if (priority >= 7) return 'high';
  if (priority <= 3) return 'low';
  return 'medium';
}

export function workflowAllowsPublicWebLearning(workflow: Pick<AutonomousWorkflow, 'allowedActions'>): boolean {
  const actions = new Set((workflow.allowedActions || []).map(action => String(action || '').trim()));
  return actions.has('public_web_search') || actions.has('web_search') || actions.has('authority_research');
}

export function workflowAllowsLocalBodyLearning(workflow: Pick<AutonomousWorkflow, 'allowedActions' | 'allowedModes'>): boolean {
  const actions = new Set((workflow.allowedActions || []).map(action => String(action || '').trim()));
  return workflow.allowedModes.includes('desktop') && (
    actions.has('local_machine_awareness') ||
    actions.has('desktop_app_inventory') ||
    actions.has('local_file_landmark_scan') ||
    actions.has('desktop_body_map')
  );
}

export function buildPublicWebLearningTaskDescription(contextParts: string[]): string {
  const context = contextParts.length > 0 ? contextParts.join('\n') : '暂无额外上下文。';
  return [
    '自主联网学习任务：根据当前上下文选择 1 个对用户近期目标最有价值、且需要时效更新的主题。',
    '选题必须优先贴合使用者的行业习惯、常用平台、术语、交付物格式、验收标准和风险边界；不要泛泛追 AI 热点。',
    '优先主题包括：使用者行业的现行规则/政策/平台流程更新、Lumi 桌面自动化与外部 AI 协作稳定性、桌面 AI/桌面工具目标目录更新、知识库/组织库连接、用户最近反复提到的工作流。',
    '如果主题涉及“其他桌面 AI/桌面工具目标”，先用 desktop_ai_list_targets 查看现有目录，再用 desktop_ai_discovery_plan 生成候选结构，并结合 web_search、url_fetch、authority_research 检索公开/官方来源。',
    '可用工具边界：可以使用 web_search、url_fetch、authority_research 检索公开网页、公开文档和权威来源；不要使用需要登录、付费、验证码、扫码、二次验证或账号授权的页面作为已完成来源。',
    '输出要求：给出来源 URL、检索时间、可信度、不确定点、可吸收的候选知识、对 Lumi 能力/工作流的更新建议；涉及桌面 AI/工具时额外输出可供 desktop_ai_register_target 使用的候选 JSON（id、label、aliases、openTargets、surface、sourceUrls、notes）。不能把未核验信息写成确定事实。',
    '写入边界：除非任务里已有明确用户授权，不要调用 authority_research_save、desktop_ai_register_target 或其他长期知识/配置写入工具；先把候选知识和来源整理为摘要。',
    '',
    '当前上下文：',
    context,
  ].join('\n');
}

export function buildLocalBodyLearningTaskDescription(contextParts: string[]): string {
  const context = contextParts.length > 0 ? contextParts.join('\n') : '暂无额外上下文。';
  return [
    '自主本机身体学习任务：把本地电脑当作 Lumi 的身体进行低风险观察，只建立地图，不执行外部动作。',
    '允许的观察：desktop_system_info、desktop_list_apps、desktop_list_files、desktop_path_info、desktop_running_processes、desktop_active_window、desktop_idle_time、desktop_poll_activity。',
    '文件学习边界：只列出 Desktop、Documents、Downloads 或用户明确工作目录的顶层文件/文件夹元数据；不要读取文件正文，不要打开文件，不要上传/复制/删除/移动文件。',
    '应用学习边界：整理可启动应用、正在运行进程、前台窗口、常用行业工具和可能的工作入口；不要打开应用，不要点击，不要键入，不要截图，不要运行命令。',
    '输出要求：形成“本机身体地图”：主机/桌面目录/重要文件夹线索/常用应用/正在运行应用/行业相关工具/未知缺口/下一次需要用户确认的探索项。',
    '隐私要求：遇到明显私人、敏感、财务、医疗、法律客户材料时只记录类别和路径线索，不摘录内容；不把本地文件名推断成确定事实。',
    '',
    '当前上下文：',
    context,
  ].join('\n');
}

function createLearningPlanForTask(task: GeneratedAutonomousTask, workflowTitle: string): LumiPlan {
  return createPlan(
    task.title.slice(0, 120),
    [
      task.description.slice(0, 700),
      `来源工作流：${workflowTitle}`,
    ].join('\n\n'),
    'lumi',
    toPlanPriority(Math.max(1, Math.min(10, task.priority || 5))),
    [
      { title: '识别可吸收的新知识', description: '从最近上下文、记忆、资料、公开来源更新或知识缺口中确认本轮学习目标。' },
      { title: '执行学习与整理', description: '完成分析、归纳、对照、必要的公开来源检索和知识结构化。' },
      { title: '沉淀结果', description: '输出可复用摘要、来源索引、候选记忆线索或下一步学习建议。' },
    ],
    ['lumi-learning', 'autonomous', task.workflowId || 'workflow'],
  );
}

function webLearningSettingKey(userId: string): string {
  return `${AUTONOMOUS_WEB_LEARNING_SETTING_PREFIX}${userId}`;
}

function localBodyLearningSettingKey(userId: string): string {
  return `${AUTONOMOUS_LOCAL_BODY_LEARNING_SETTING_PREFIX}${userId}`;
}

function getLastPublicWebLearningAt(userId: string): number {
  try {
    const db = readDB();
    const row = (db.settings || []).find((item: any) => item.key === webLearningSettingKey(userId));
    const value = Number(row?.value || 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function getLastLocalBodyLearningAt(userId: string): number {
  try {
    const db = readDB();
    const row = (db.settings || []).find((item: any) => item.key === localBodyLearningSettingKey(userId));
    const value = Number(row?.value || 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function recordPublicWebLearningAt(userId: string, timestamp: number) {
  try {
    const db = readDB();
    if (!db.settings) db.settings = [];
    const key = webLearningSettingKey(userId);
    const row = db.settings.find((item: any) => item.key === key);
    if (row) row.value = String(timestamp);
    else db.settings.push({ key, value: String(timestamp) });
    writeDB(db);
  } catch {}
}

function recordLocalBodyLearningAt(userId: string, timestamp: number) {
  try {
    const db = readDB();
    if (!db.settings) db.settings = [];
    const key = localBodyLearningSettingKey(userId);
    const row = db.settings.find((item: any) => item.key === key);
    if (row) row.value = String(timestamp);
    else db.settings.push({ key, value: String(timestamp) });
    writeDB(db);
  } catch {}
}

function enqueueGeneratedLearningTask(
  userId: string,
  workflow: AutonomousWorkflow,
  generated: GeneratedAutonomousTask,
  descriptionLimit: number,
): boolean {
  const plan = createLearningPlanForTask(generated, workflow.title);
  const task = enqueue({
    userId,
    workflowId: workflow.id,
    planId: plan.id,
    title: generated.title,
    description: generated.description.slice(0, descriptionLimit),
    source: 'curiosity',
    priority: generated.priority,
    mode: generated.mode,
  });

  if (!task) {
    updatePlan(plan.id, {
      status: 'cancelled',
      result: 'Autonomous queue is full, so this Lumi learning plan was not started.',
    });
    return false;
  }
  return true;
}

function seedLocalBodyLearningTaskIfDue(
  userId: string,
  workflows: AutonomousWorkflow[],
  contextParts: string[],
): number {
  const workflow = workflows.find(item => item.id === DEFAULT_LEARNING_WORKFLOW_ID && workflowAllowsLocalBodyLearning(item))
    || workflows.find(workflowAllowsLocalBodyLearning);
  if (!workflow) return 0;

  const now = Date.now();
  const lastRun = getLastLocalBodyLearningAt(userId);
  if (lastRun > 0 && now - lastRun < AUTONOMOUS_LOCAL_BODY_LEARNING_INTERVAL_MS) return 0;

  const generated: GeneratedAutonomousTask = {
    workflowId: workflow.id,
    title: '本机身体地图观察',
    description: buildLocalBodyLearningTaskDescription(contextParts),
    mode: 'desktop',
    priority: 5,
  };

  if (!enqueueGeneratedLearningTask(userId, workflow, generated, 2200)) return 0;
  recordLocalBodyLearningAt(userId, now);
  console.log(`[AutoTasks] Seeded local body learning refresh for ${userId}`);
  return 1;
}

function seedPublicWebLearningTaskIfDue(
  userId: string,
  workflows: AutonomousWorkflow[],
  contextParts: string[],
): number {
  const workflow = workflows.find(item => item.id === DEFAULT_LEARNING_WORKFLOW_ID && workflowAllowsPublicWebLearning(item))
    || workflows.find(workflowAllowsPublicWebLearning);
  if (!workflow || !workflow.allowedModes.includes('analysis')) return 0;

  const now = Date.now();
  const lastRun = getLastPublicWebLearningAt(userId);
  if (lastRun > 0 && now - lastRun < AUTONOMOUS_WEB_LEARNING_INTERVAL_MS) return 0;

  const generated: GeneratedAutonomousTask = {
    workflowId: workflow.id,
    title: '公开来源学习更新巡检',
    description: buildPublicWebLearningTaskDescription(contextParts),
    mode: 'analysis',
    priority: 4,
  };

  if (!enqueueGeneratedLearningTask(userId, workflow, generated, 2400)) return 0;
  recordPublicWebLearningAt(userId, now);
  console.log(`[AutoTasks] Seeded public web learning refresh for ${userId}`);
  return 1;
}

function seedFallbackLearningTasksIfDue(
  userId: string,
  workflows: AutonomousWorkflow[],
  contextParts: string[],
): number {
  return seedLocalBodyLearningTaskIfDue(userId, workflows, contextParts)
    + seedPublicWebLearningTaskIfDue(userId, workflows, contextParts);
}

export async function generateAutonomousTasks(
  userId: string,
  getters: LLMGetters,
): Promise<number> {
  // Safety gate check
  const gate = isAutonomousWorkAllowed(userId);
  if (!gate.allowed) {
    console.log(`[AutoTasks] Gate blocked: ${gate.reason}`);
    return 0;
  }

  const workflows = listEnabledAutonomousWorkflows(userId);
  if (workflows.length === 0) {
    console.log(`[AutoTasks] No enabled confirmed workflows for ${userId}`);
    return 0;
  }
  const workflowById = new Map(workflows.map(workflow => [workflow.id, workflow]));
  const workflowContext = workflows
    .map(workflow => [
      `- id=${workflow.id}`,
      `title=${workflow.title}`,
      `trigger=${workflow.trigger || 'manual/implicit'}`,
      `modes=${workflow.allowedModes.join(',')}`,
      `externalApps=${workflow.externalAppsAllowed ? 'allowed' : 'not_allowed'}`,
      `actions=${workflow.allowedActions.join(',') || 'not specified'}`,
      `description=${workflow.description}`,
    ].join(' | '))
    .join('\n');

  // Build context
  const contextParts: string[] = [];
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  const isWeekday = day >= 1 && day <= 5;
  contextParts.push(`当前时间: ${now.toLocaleString('zh-CN')} (${isWeekday ? '工作日' : '周末'})`);

  // Recent activity
  const recentActivity = getRecentActivity(userId, 15);
  const windowChanges = recentActivity.filter(e => e.type === 'window_changed');
  if (windowChanges.length > 0) {
    const appNames = [...new Set(windowChanges.map(e => e.data?.process_name).filter(Boolean))];
    contextParts.push(`最近活跃应用: ${appNames.join(', ')}`);

    // Detect specific app launches for contextual triggers
    const latestWindow = windowChanges[windowChanges.length - 1]?.data;
    if (latestWindow?.process_name) {
      const app = latestWindow.process_name.toLowerCase();
      if (app.includes('code') || app.includes('vscode')) contextParts.push('用户刚切换到了代码编辑器');
      if (app.includes('excel') || app.includes('wps')) contextParts.push('用户正在处理电子表格');
      if (app.includes('wechat')) contextParts.push('用户正在使用微信');
      if (app.includes('cad') || app.includes('autocad')) contextParts.push('用户正在使用CAD软件');
      if (app.includes('chrome') || app.includes('edge') || app.includes('firefox')) contextParts.push('用户正在浏览网页');
    }
  }

  // Clipboard context
  const clipboardEvents = recentActivity.filter(e => e.type === 'clipboard_changed');
  if (clipboardEvents.length > 0) {
    const clipText = clipboardEvents[clipboardEvents.length - 1]?.data?.text || '';
    if (clipText && clipText.length > 10 && clipText.length < 500) {
      contextParts.push(`剪贴板最新内容: "${clipText.slice(0, 200)}"`);
      if (clipText.includes('http://') || clipText.includes('https://')) contextParts.push('剪贴板包含URL链接');
      if (/```|function|class|def |import /.test(clipText)) contextParts.push('剪贴板包含代码片段');
      if (/TODO|FIXME|HACK|WIP/.test(clipText)) contextParts.push('剪贴板包含待办标记');
    }
  }

  // Time-of-day context
  if (isWeekday && hour >= 8 && hour <= 10) contextParts.push('工作日上午，用户可能在规划一天');
  if (isWeekday && hour >= 11 && hour <= 13) contextParts.push('临近午休时间');
  if (isWeekday && hour >= 16 && hour <= 18) contextParts.push('下午收尾阶段');
  if (hour >= 21 && hour <= 23) contextParts.push('晚间时段，用户可能在放松或学习');

  // Recent memories
  const db = readDB();
  const recentMemories = (db.memories || [])
    .filter((m: any) => m.userId === userId && m.confidence >= 0.4)
    .slice(-10)
    .map((m: any) => m.content.slice(0, 100));
  if (recentMemories.length > 0) {
    contextParts.push(`近期相关记忆: ${recentMemories.join('; ')}`);
  }

  // Pending reminders
  const pendingReminders = (db.memories || [])
    .filter((m: any) => m.userId === userId && m.type === 'reminder' && m.confidence > 0)
    .slice(0, 5)
    .map((m: any) => m.content);
  if (pendingReminders.length > 0) {
    contextParts.push(`待办事项: ${pendingReminders.join('; ')}`);
  }

  const industryContext = formatIndustryLearningContext(userId);
  if (industryContext) {
    contextParts.push(industryContext);
  }

  if (contextParts.length === 0) return 0;

  const prompt = `你是 Lumi 的后台自主学习与任务规划器。根据用户当前的上下文，建议 1-3 个你可以自主完成的小任务。

要求：
- 只能基于下面“已确认且启用的自动工作流”生成任务
- 每个任务必须填写 workflowId，且 workflowId 必须来自下面的工作流列表
- 任务 mode 必须在对应工作流的 allowedModes 内
- 如果任务需要外部应用，而工作流 externalApps=not_allowed，则不要生成该任务
- 必须根据“使用者行业习惯画像”选择学习主题：围绕行业常用平台、术语、交付物格式、验收标准、合规/确认边界和用户反复出现的实际任务去调研和进化
- 如果没有行业画像，先围绕最近任务/记忆/活跃应用推断行业候选，但要标注不确定性，不要把猜测当事实
- 公开网页搜索、url_fetch、authority_research 属于网络观察，不算外部应用自动化；只有工作流 allowedActions 包含 public_web_search、web_search 或 authority_research 时才可生成联网学习任务
- 如果用户上下文涉及“其他桌面 AI、桌面工具、外部 AI 目标、AI 客户端”，优先生成桌面 AI/工具目标目录更新任务：查看 desktop_ai_list_targets，使用 desktop_ai_discovery_plan 设计候选结构，再联网查公开/官方来源
- 本机电脑也是 Lumi 的身体：如果工作流允许 desktop 且 allowedActions 包含 local_machine_awareness、desktop_app_inventory、local_file_landmark_scan 或 desktop_body_map，可以生成本机身体学习任务，使用 desktop_system_info、desktop_list_apps、desktop_list_files、desktop_path_info、desktop_running_processes、desktop_active_window、desktop_idle_time、desktop_poll_activity 做只读观察
- 本机身体学习不等于外部应用自动化：不要打开应用/文件，不要点击/键入，不要截图，不要运行命令，不要读取文件正文；只整理文件夹/应用/进程/窗口的地图、线索、缺口和下一步确认项
- 联网学习任务只能检索公开来源；遇到登录、付费、验证码、扫码、二次验证、账号授权或私有页面，要记录阻塞和替代公开来源，不要假装完成
- 联网学习任务必须要求输出 URL、检索时间、可信度、不确定点和可吸收的候选知识
- 除非用户已明确授权长期写入，不要生成需要静默调用 authority_research_save、desktop_ai_register_target 的任务
- 优先生成学习、知识吸收、记忆整理、资料消化、能力补齐类任务
- 每个任务完成后应产出可沉淀的摘要、索引、记忆线索或下一步建议
- 安全无害（不删除文件、不执行危险命令）
- 快速完成（2分钟内，不要需要多轮交互）
- 真正有用（根据上下文判断）
- 自包含（不需要追问用户）

已确认且启用的自动工作流:
${workflowContext}

上下文:
${contextParts.join('\n')}

返回 JSON 数组（不要 markdown，不要解释）:
[
  {
    "workflowId": "来自上方工作流列表的 id",
    "title": "任务简短标题",
    "description": "详细执行描述，作为LLM执行提示词",
    "mode": "desktop" | "terminal" | "analysis",
    "priority": 1-10
  }
]

如果当前没有合适的自主任务，返回空数组 []。`;

  try {
    const messages: NormalizedMessage[] = [{ role: 'user', content: prompt }];
    const result = await makeLLMCall(
      messages, [],
      getUserPreferredLLMConfig(userId, { maxTokens: 500 }),
      getters.getDeepSeek, getters.getGemini,
      getters.getOpenAI || (() => null),
      getters.getAnthropic || (() => null),
      getters.getQwen || (() => null),
    );

    const text = (result.text || '').replace(/```json|```/g, '').trim();
    if (!text || text === '[]') return seedFallbackLearningTasksIfDue(userId, workflows, contextParts);

    let tasks: GeneratedAutonomousTask[];
    try {
      tasks = JSON.parse(text);
    } catch {
      console.log('[AutoTasks] Failed to parse LLM response:', text.slice(0, 200));
      return seedFallbackLearningTasksIfDue(userId, workflows, contextParts);
    }

    if (!Array.isArray(tasks) || tasks.length === 0) return seedFallbackLearningTasksIfDue(userId, workflows, contextParts);

    let enqueued = 0;
    for (const t of tasks) {
      if (!t.title || !t.description) continue;
      if (!t.workflowId || !workflowById.has(t.workflowId)) {
        console.log(`[AutoTasks] Skipped task without enabled workflow: ${t.title}`);
        continue;
      }
      const workflow = workflowById.get(t.workflowId)!;
      const requestedMode = t.mode === 'desktop' || t.mode === 'terminal' ? t.mode : 'analysis';
      if (!workflow.allowedModes.includes(requestedMode)) {
        console.log(`[AutoTasks] Skipped task with disallowed mode ${requestedMode} for workflow ${workflow.id}`);
        continue;
      }
      const plan = createLearningPlanForTask(t, workflow.title);
      const task = enqueue({
        userId,
        workflowId: workflow.id,
        planId: plan.id,
        title: t.title.slice(0, 120),
        description: t.description.slice(0, 500),
        source: 'curiosity',
        priority: Math.max(1, Math.min(10, t.priority || 5)),
        mode: requestedMode,
      });
      if (task) {
        enqueued++;
      } else {
        updatePlan(plan.id, {
          status: 'cancelled',
          result: 'Autonomous queue is full, so this Lumi learning plan was not started.',
        });
      }
    }

    if (enqueued === 0) {
      enqueued += seedFallbackLearningTasksIfDue(userId, workflows, contextParts);
    }

    console.log(`[AutoTasks] Generated ${enqueued} autonomous tasks for ${userId}`);
    return enqueued;
  } catch (err: any) {
    console.warn(`[AutoTasks] Generation failed:`, err.message);
    return seedFallbackLearningTasksIfDue(userId, workflows, contextParts);
  }
}
