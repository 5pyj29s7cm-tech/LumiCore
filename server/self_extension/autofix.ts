import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildSelfExtensionPlan } from './pipeline';
import {
  listCapabilityLearningRecords,
  upsertCapabilityLearningRecord,
  type CapabilityExperimentRecord,
  type CapabilityLearningRecord,
  type CapabilityLearningStatus,
  type CapabilityRoute,
} from './capability_memory';
import type { ToolDefinition } from '../tools/types';

export interface CapabilityGapAutofixOptions {
  userId?: string;
  scopeDomain?: 'personal' | 'work';
  orgId?: string;
  goal: string;
  domain?: string;
  context?: string;
  observedFailure?: string;
  clientState?: Record<string, any> | null;
  tools?: ToolDefinition[];
  outputDirectory?: string;
  allowExternalExecution?: boolean;
  allowResearch?: boolean;
  allowSkillDraft?: boolean;
  record?: boolean;
  executeTool?: (name: string, args: Record<string, any>) => Promise<string>;
}

export interface CapabilityGapAutofixResult {
  plan: ReturnType<typeof buildSelfExtensionPlan>;
  record: CapabilityLearningRecord;
  selectedRoute: CapabilityRoute;
  experiment: CapabilityExperimentRecord;
  reusedExistingCoverage?: boolean;
  note: string;
}

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map(compact).filter(Boolean)));
}

function toolNames(tools: ToolDefinition[] = []): string[] {
  return tools.map(tool => tool.name);
}

function hasTool(names: string[], name: string): boolean {
  return names.includes(name);
}

function inferRoute(goal: string, domain: string, tools: string[]): CapabilityRoute {
  const text = `${goal} ${domain}`.toLowerCase();
  if (/autocad|acad|cad|dwg|dxf|施工图|图纸|一笔一笔|画图|画线/i.test(text)) {
    return {
      id: 'cad.autocad_mcp_playback',
      label: 'AutoCAD MCP/COM drawing route',
      interfacePattern: 'mcp',
      preferredTools: [
        'floorplan_extract_geometry',
        'cad_prepare_autocad_operations',
        'mcp_cad-drafting_autocad_playback_file',
        'work_takeover_task_verify_result',
      ].filter(name => hasTool(tools, name)),
      fallbackTools: [],
      avoid: ['Do not draw CAD with raw pointer coordinates', 'Do not replace MCP with LISP, SCRIPT, or batch execution', 'Do not present DXF/DWG, browser/SVG previews, or an opened window as visible AutoCAD completion'],
      reason: 'Visible AutoCAD drawing uses validated entity operations and MCP/COM playback only, with the completion marker as acceptance evidence. A failure remains blocked instead of switching to generated drawings or scripts.',
      confirmationRequired: ['Confirm before overwriting an existing DWG/DXF or claiming production-ready drawings'],
    };
  }

  if (/browser|web|网页|网站|后台|平台|登录|账号|店铺|发布/i.test(text)) {
    return {
      id: 'web.playwright_session',
      label: '浏览器 DOM/已登录会话路线',
      interfacePattern: 'browser_dom',
      preferredTools: [
        'external_control_candidates',
        'external_control_configure_candidate',
        'mcp_playwright_browser_snapshot',
        'mcp_playwright_browser_navigate',
        'mcp_playwright_browser_click',
        'mcp_playwright_browser_fill_form',
        'web_login_profile_list',
        'web_login_run',
      ].filter(name => hasTool(tools, name)),
      fallbackTools: ['desktop_ui_snapshot', 'computer_use'].filter(name => hasTool(tools, name)),
      avoid: ['不要优先截图猜网页按钮位置', '不要绕过扫码/验证码/账号授权'],
      reason: '网页和平台后台应优先使用 Playwright/登录会话/DOM 快照，而不是鼠标坐标。',
      confirmationRequired: ['首次登录、扫码、验证码、切号、授权、发布、提交、付款前需要确认'],
    };
  }

  if (/wechat|微信|企微|消息|回复|send|message/i.test(text)) {
    return {
      id: 'messaging.draft_then_confirm',
      label: '消息草稿和确认发送路线',
      interfacePattern: 'windows_uia',
      preferredTools: ['wechat_prepare_reply', 'wechat_copy_reply_draft', 'desktop_ui_snapshot', 'desktop_active_window'].filter(name => hasTool(tools, name)),
      fallbackTools: ['desktop_clipboard_write', 'computer_use'].filter(name => hasTool(tools, name)),
      avoid: ['不要自动点击发送', '不要切换账号或处理扫码验证码'],
      reason: '消息类任务先准备草稿、恢复已登录窗口、等用户确认后再发送。',
      confirmationRequired: ['发送消息、切换账号、扫码、验证码、授权前需要确认'],
    };
  }

  if (/wps|word|excel|office|文档|表格|ppt|pdf/i.test(text)) {
    return {
      id: 'office.file_api_then_visible_handoff',
      label: '文件生成优先，办公软件可见交付路线',
      interfacePattern: 'file_handoff',
      preferredTools: ['create_docx', 'create_xlsx', 'create_ppt', 'create_pdf', 'desktop_open'].filter(name => hasTool(tools, name)),
      fallbackTools: ['desktop_ui_snapshot', 'computer_use'].filter(name => hasTool(tools, name)),
      avoid: ['不要在办公软件里空白打开后声称完成', '不要用记事本替代正式文档交付'],
      reason: '办公交付先用文件 API 生成真实内容，再打开 WPS/Office 做可见检查或演示。',
      confirmationRequired: ['覆盖用户文件、发送文件、对外承诺正式内容前需要确认'],
    };
  }

  return {
    id: 'general.existing_tools_then_skill',
    label: '现有工具优先，缺口转技能/适配器路线',
    interfacePattern: 'skill',
    preferredTools: tools.filter(name => /self_extension_plan|capability_research|generate_skill|install_skill|adapter_registry_list/.test(name)),
    fallbackTools: ['computer_use'].filter(name => hasTool(tools, name)),
    avoid: ['不要把一次性聊天回答当作永久能力', '不要未经确认安装或执行第三方代码'],
    reason: '通用能力缺口应先查现有工具，再研究/生成技能，最后才进入核心代码修改。',
    confirmationRequired: ['生成/安装/修复技能、连接第三方服务、修改核心代码前需要确认'],
  };
}

function defaultExperiment(summary = 'No runnable minimal experiment was selected for this route.'): CapabilityExperimentRecord {
  return {
    status: 'not_needed',
    summary,
    toolCalls: [],
    artifacts: [],
    verification: [],
  };
}

function hasFailureEvidence(options: CapabilityGapAutofixOptions): boolean {
  return Boolean(compact(options.observedFailure) || /brittle|failed|failure|manual|mouse|坐标|鼠标|失败|没成功|不稳定|脚本感|硬点/i.test(`${options.goal} ${options.context || ''}`));
}

function reusableLearnedRecord(
  userId: string,
  scopeDomain: 'personal' | 'work',
  orgId: string,
  domain: string,
  goal: string,
): CapabilityLearningRecord | undefined {
  return listCapabilityLearningRecords({ userId, scopeDomain, orgId, domain, goal, limit: 6 })
    .find(record => ['learned', 'experiment_prepared', 'experiment_passed'].includes(record.status));
}

function routeFromExistingCoverage(plan: ReturnType<typeof buildSelfExtensionPlan>, toolNamesForRoute: string[]): CapabilityRoute {
  const preferredTools = unique([
    ...plan.resolution.preferredTools,
    ...plan.existingCoverage.tools.map(tool => tool.name),
  ]).filter(name => toolNamesForRoute.includes(name));
  return {
    id: `existing.${plan.resolution.primarySource}`,
    label: plan.resolution.reason,
    interfacePattern: plan.resolution.primarySource === 'adapter' ? 'mcp' : 'skill',
    preferredTools,
    fallbackTools: [],
    avoid: ['不要为已有覆盖重复生成工具或核心代码', '不要把计划说成已验证结果'],
    reason: plan.resolution.reason,
    confirmationRequired: ['执行外部软件控制、发送消息、发布、付款、覆盖文件和修改核心代码前仍需确认'],
  };
}

function transientCoverageRecord(
  userId: string,
  scopeDomain: 'personal' | 'work',
  orgId: string,
  plan: ReturnType<typeof buildSelfExtensionPlan>,
  route: CapabilityRoute,
  experiment: CapabilityExperimentRecord,
): CapabilityLearningRecord {
  const timestamp = new Date().toISOString();
  return {
    id: 'existing_coverage_not_recorded',
    userId,
    scopeDomain,
    orgId,
    domain: plan.domain,
    goal: plan.goal,
    status: 'learned',
    selectedRoute: route,
    planReadiness: plan.readiness,
    existingTools: unique([
      ...plan.existingCoverage.tools.map(tool => tool.name),
      ...route.preferredTools,
    ]),
    nextUse: {
      triggerHints: triggerHints(plan.goal, route),
      preferredTools: route.preferredTools,
      firstStep: route.preferredTools[0] || 'self_extension_plan',
      reportRule: '先复用已有能力；只汇报已验证的结果、卡点和下一步确认事项。',
    },
    experiment,
    safety: unique([
      ...route.confirmationRequired,
      ...route.avoid,
    ]),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function experimentDirectory(outputDirectory?: string): string {
  const dir = outputDirectory
    ? path.resolve(outputDirectory.replace(/^~(?=$|[\\/])/, os.homedir()))
    : path.join(os.homedir(), 'Desktop', 'Lumi能力学习实验');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runAutocadMinimalExperiment(options: CapabilityGapAutofixOptions, route: CapabilityRoute): Promise<CapabilityExperimentRecord> {
  const executeTool = options.executeTool;
  if (!executeTool || !route.preferredTools.includes('cad_prepare_autocad_operations')) {
    return {
      status: 'needs_review',
      summary: 'AutoCAD route selected, but cad_prepare_autocad_operations is not available to run a minimal experiment.',
      toolCalls: [],
      artifacts: [],
      verification: [{ label: 'Available tool', passed: false, detail: 'Missing cad_prepare_autocad_operations' }],
    };
  }
  if (options.allowExternalExecution === true && !route.preferredTools.includes('mcp_cad-drafting_autocad_playback_file')) {
    return {
      status: 'blocked',
      summary: 'AutoCAD MCP/COM playback is unavailable. The experiment cannot fall back to scripts or generated drawings.',
      toolCalls: [],
      artifacts: [],
      verification: [{ label: 'AutoCAD MCP', passed: false, detail: 'Missing mcp_cad-drafting_autocad_playback_file' }],
    };
  }

  const dir = experimentDirectory(options.outputDirectory);
  const prepareArgs = {
    title: 'Lumi能力学习_AutoCAD一笔一笔绘图实验',
    width: 1600,
    height: 1000,
    unit: 'mm',
    wallThickness: 80,
    outputDirectory: dir,
    strokeDelayMs: 150,
    rooms: [{ name: '能力实验房间', x: 0, y: 0, width: 1600, height: 1000 }],
    walls: [
      { x1: 0, y1: 0, x2: 1600, y2: 0, thickness: 80 },
      { x1: 1600, y1: 0, x2: 1600, y2: 1000, thickness: 80 },
    ],
    doors: [{ hingeX: 600, hingeY: 0, width: 300, angle: 90, swing: 'left', label: 'D-test' }],
    windows: [{ x1: 300, y1: 1000, x2: 900, y2: 1000, width: 60, label: 'W-test' }],
    dimensions: [{ x1: 0, y1: 0, x2: 1600, y2: 0, text: '1600', offset: -160 }],
    labels: [{ text: 'Lumi AutoCAD capability probe', x: 120, y: 520, height: 80 }],
  };

  const toolCalls: CapabilityExperimentRecord['toolCalls'] = [];
  const artifacts: CapabilityExperimentRecord['artifacts'] = [];
  const verification: CapabilityExperimentRecord['verification'] = [];
  let activeTool = 'cad_prepare_autocad_operations';
  try {
    const raw = await executeTool('cad_prepare_autocad_operations', prepareArgs);
    const prepared = JSON.parse(raw);
    toolCalls.push({ name: 'cad_prepare_autocad_operations', args: prepareArgs, status: 'passed', result: prepared });
    for (const [label, filePath] of Object.entries({
      operations: prepared.operationsPath,
      manifest: prepared.manifestPath,
    })) {
      if (!filePath) continue;
      artifacts.push({ label, path: String(filePath), exists: fs.existsSync(String(filePath)) });
    }
    verification.push(
      { label: 'Operations file', passed: fs.existsSync(prepared.operationsPath), detail: prepared.operationsPath },
      { label: 'Operations manifest', passed: fs.existsSync(prepared.manifestPath), detail: prepared.manifestPath },
    );

    if (options.allowExternalExecution !== true) {
      return {
        status: verification.every(item => item.passed) ? 'prepared' : 'needs_review',
        summary: 'AutoCAD operations are prepared. No visible execution was attempted, and no drawing-complete claim is allowed.',
        toolCalls,
        artifacts,
        verification,
      };
    }

    activeTool = 'mcp_cad-drafting_autocad_playback_file';
    const savePath = path.join(dir, `lumi_autocad_mcp_probe_${Date.now()}.dwg`);
    const playbackArgs = {
      operationsPath: prepared.operationsPath,
      completionMarkerPath: prepared.completionMarkerPath,
      strokeDelayMs: prepared.strokeDelayMs,
      createNewDocument: true,
      savePath,
    };
    const playbackRaw = await executeTool('mcp_cad-drafting_autocad_playback_file', playbackArgs);
    const playback = JSON.parse(playbackRaw);
    toolCalls.push({ name: 'mcp_cad-drafting_autocad_playback_file', args: playbackArgs, status: playback.status, result: playback });
    artifacts.push(
      { label: 'completion_marker', path: prepared.completionMarkerPath, exists: fs.existsSync(prepared.completionMarkerPath) },
      { label: 'dwg', path: savePath, exists: fs.existsSync(savePath) },
    );
    verification.push({
      label: 'AutoCAD MCP/COM completion marker',
      passed: playback.status === 'completed'
        && playback.transport === 'mcp_autocad_com'
        && playback.visiblePlayback === true
        && playback.completionMarkerExists === true
        && fs.existsSync(prepared.completionMarkerPath),
      detail: playback.note || JSON.stringify(playback),
    });
    const passed = verification.every(item => item.passed);
    return {
      status: passed ? 'passed' : 'blocked',
      summary: passed
        ? 'AutoCAD MCP/COM minimal experiment completed and passed marker verification.'
        : 'AutoCAD MCP/COM playback did not pass verification. No fallback was attempted.',
      toolCalls,
      artifacts,
      verification,
    };
  } catch (error: any) {
    toolCalls.push({ name: activeTool, args: activeTool === 'cad_prepare_autocad_operations' ? prepareArgs : {}, status: 'blocked', error: error?.message || String(error) });
    return {
      status: 'blocked',
      summary: `${error?.message || 'AutoCAD minimal experiment failed.'} No fallback was attempted.`,
      toolCalls,
      artifacts,
      verification: [{ label: '实验执行', passed: false, detail: error?.message || String(error) }],
    };
  }
}

async function runMinimalExperiment(options: CapabilityGapAutofixOptions, route: CapabilityRoute): Promise<CapabilityExperimentRecord> {
  if (route.id === 'cad.autocad_mcp_playback') return runAutocadMinimalExperiment(options, route);
  return defaultExperiment();
}

function recordStatusFromExperiment(route: CapabilityRoute, experiment: CapabilityExperimentRecord, needsResearch: boolean): CapabilityLearningStatus {
  if (experiment.status === 'passed') return 'experiment_passed';
  if (experiment.status === 'prepared') return 'experiment_prepared';
  if (experiment.status === 'blocked') return 'blocked';
  if (needsResearch) return 'needs_research';
  if (route.interfacePattern === 'core') return 'needs_core_work';
  return 'learned';
}

function triggerHints(goal: string, route: CapabilityRoute): string[] {
  return unique([
    goal,
    route.id,
    ...route.preferredTools,
    route.interfacePattern,
    route.label,
  ]).slice(0, 10);
}

export async function runCapabilityGapAutofix(options: CapabilityGapAutofixOptions): Promise<CapabilityGapAutofixResult> {
  const userId = options.userId || 'anonymous';
  const orgId = String(options.orgId || '').trim();
  const scopeDomain: 'personal' | 'work' = options.scopeDomain === 'work' && orgId ? 'work' : 'personal';
  const goal = compact(options.goal);
  if (!goal) throw new Error('goal is required.');
  const tools = options.tools || [];
  const names = toolNames(tools);
  const plan = buildSelfExtensionPlan({
    userId,
    scopeDomain,
    orgId: scopeDomain === 'work' ? orgId : '',
    goal,
    domain: options.domain,
    clientState: options.clientState || null,
    tools,
  });
  const failureEvidence = hasFailureEvidence(options);
  const learned = reusableLearnedRecord(userId, scopeDomain, scopeDomain === 'work' ? orgId : '', plan.domain, goal);
  if (learned && !failureEvidence) {
    return {
      plan,
      selectedRoute: learned.selectedRoute,
      experiment: learned.experiment,
      record: learned,
      reusedExistingCoverage: true,
      note: `Existing learned route reused: ${learned.selectedRoute.label}. No duplicate capability record was created.`,
    };
  }

  if (!failureEvidence && !plan.resolution.shouldCreateNewCapability) {
    const selectedRoute = learned?.selectedRoute || routeFromExistingCoverage(plan, names);
    const experiment = defaultExperiment('Existing capability coverage is sufficient; Lumi should reuse it instead of creating a new route.');
    return {
      plan,
      selectedRoute,
      experiment,
      record: transientCoverageRecord(userId, scopeDomain, scopeDomain === 'work' ? orgId : '', plan, selectedRoute, experiment),
      reusedExistingCoverage: true,
      note: `Existing coverage reused: ${plan.resolution.reason} No new capability record was created.`,
    };
  }

  const selectedRoute = learned?.selectedRoute || inferRoute(`${goal} ${options.context || ''} ${options.observedFailure || ''}`, plan.domain, names);
  const needsResearch = plan.readiness === 'research_adapter' && options.allowResearch !== false;
  const experiment = await runMinimalExperiment(options, selectedRoute);
  const status = recordStatusFromExperiment(selectedRoute, experiment, needsResearch);
  const existingTools = unique([
    ...plan.existingCoverage.tools.map(tool => tool.name),
    ...selectedRoute.preferredTools,
  ]);

  const recordInput = {
    userId,
    scopeDomain,
    orgId: scopeDomain === 'work' ? orgId : '',
    domain: plan.domain,
    goal,
    context: compact(options.context) || undefined,
    observedFailure: compact(options.observedFailure) || undefined,
    status,
    selectedRoute,
    planReadiness: plan.readiness,
    existingTools,
    nextUse: {
      triggerHints: triggerHints(goal, selectedRoute),
      preferredTools: selectedRoute.preferredTools,
      firstStep: selectedRoute.preferredTools[0] || 'self_extension_plan',
      reportRule: '只汇报已验证的能力、卡点和下一步确认事项；不要把计划说成已经完成。',
    },
    experiment,
    safety: unique([
      ...selectedRoute.confirmationRequired,
      ...selectedRoute.avoid,
      '生成/安装/执行第三方代码、外部软件控制、发送消息、发布、付款、覆盖文件和核心代码修改都需要确认。',
      '能力只有在最小实验或健康检查通过后，才可以说“已掌握”。',
    ]),
  };
  const record = options.record === false
    ? {
        ...recordInput,
        id: 'not_recorded',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as CapabilityLearningRecord
    : upsertCapabilityLearningRecord(recordInput);

  return {
    plan,
    selectedRoute,
    experiment,
    record,
    note: [
      `Capability gap handled with route: ${selectedRoute.label}.`,
      experiment.status !== 'not_needed' ? `Minimal experiment: ${experiment.status}.` : '',
      options.record === false ? 'Record was not persisted.' : 'Route was persisted to Lumi capability memory.',
    ].map(compact).filter(Boolean).join(' '),
  };
}
