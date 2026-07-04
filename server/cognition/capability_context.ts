import type { ToolRegistry } from '../tools/registry';
import { getAdapterRegistry } from '../adapters/registry';
import { listSkillWorkflows } from '../skills/workflow_registry';
import { getActiveWorkTakeoverTasksForContinuity } from '../work_takeover/continuity';
import type { LumiTurnFlow } from './turn_flow';

export interface LumiRuntimeCapabilityContextInput {
  userId: string;
  text: string;
  flow: LumiTurnFlow;
  toolRegistry: ToolRegistry;
  domain?: string;
  orgId?: string;
}

function compact(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function groupTools(toolNames: string[]): string[] {
  const groups: Array<[string, RegExp]> = [
    ['client/ui', /^(client_|adapter_|external_app_)/],
    ['task', /^(work_takeover_|work_product_)/],
    ['desktop', /^(desktop_|computer_use$|capture_screen|get_active_window)/],
    ['web/account', /^(web_|url_|browser_|mcp_playwright_|external_control_)/],
    ['files/docs', /^(read_|write_|create_|extract_|pdf_|ocr_|transcribe_|list_|search_|grep_)/],
    ['cad/design', /^(cad_|floorplan_|generate_image|edit_image)/],
    ['legal/research', /^(legal_|authority_|capability_research)/],
    ['code/git', /^(git_|run_tests|type_check|code_execution|python_exec|run_command)/],
    ['calendar/message', /^(calendar_|send_email|recent_emails|wechat_|feishu_)/],
    ['self-extension', /^(self_extension_|capability_gap_|capability_learning_|generate_skill|install_skill|client_repair_skill)/],
  ];
  const counts = new Map<string, number>();
  for (const name of toolNames) {
    const matched = groups.find(([, pattern]) => pattern.test(name));
    const key = matched?.[0] || 'other';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}=${count}`);
}

function relevantAdapters(flow: LumiTurnFlow, userId: string): string[] {
  try {
    const registry = getAdapterRegistry({ userId });
    const desired = new Set<string>();
    if (flow.workTakeover.activeTasks.length || flow.surface === 'work') desired.add('automation');
    if (flow.workSurfaceRoute.directDesktop || flow.workSurfaceRoute.artifactFirst) desired.add('automation');
    if (flow.workSurfaceRoute.artifactFirst) desired.add('cad_bim');
    if (flow.visionIntent || flow.clientActionOnlyTurn || flow.selfRepairTurn) desired.add('client');
    if (/微信|消息|客户|wechat|message/i.test(flow.routeText)) desired.add('messaging');
    if (/网页|浏览器|搜索|登录|店铺|账号|平台|browser|web|login|store|creator/i.test(flow.routeText)) desired.add('web');
    if (/技能|MCP|工具|agent|能力|接入|skill|tool|adapter/i.test(flow.routeText)) desired.add('ai');
    if (!desired.size) {
      desired.add('client');
      desired.add('automation');
    }
    return registry.adapters
      .filter(adapter => desired.has(adapter.category) || adapter.id.includes('work_takeover') || adapter.id.includes('self_extension'))
      .slice(0, 8)
      .map(adapter => `${adapter.label} (${adapter.id}) status=${adapter.status}${adapter.requiresConfirmation ? ', confirm' : ''}`);
  } catch {
    return ['Adapter registry unavailable.'];
  }
}

function activeTaskLines(input: LumiRuntimeCapabilityContextInput): string[] {
  const tasks = input.flow.workTakeover.activeTasks.length
    ? input.flow.workTakeover.activeTasks
    : getActiveWorkTakeoverTasksForContinuity(input.userId, {
      domain: input.domain,
      orgId: input.orgId,
      limit: 3,
    });
  return tasks.slice(0, 3).map(task => {
    const next = compact(task.nextActions[task.currentActionIndex]) || compact(task.nextActions[0]);
    const artifacts = task.artifacts.filter(a => a.status === 'prepared' || a.status === 'needs_review').map(a => a.label).slice(0, 3);
    return [
      `${task.title} [${task.id}]`,
      `status=${task.status}`,
      `category=${task.category}`,
      next ? `next=${next}` : '',
      artifacts.length ? `artifacts=${artifacts.join(', ')}` : '',
      task.confirmationRequired.length ? `confirm=${task.confirmationRequired.slice(0, 2).join('; ')}` : '',
      task.blockedBy.length ? `blocked=${task.blockedBy.slice(0, 2).join('; ')}` : '',
    ].filter(Boolean).join(' | ');
  });
}

function skillLines(flow: LumiTurnFlow): string[] {
  const workflows = listSkillWorkflows();
  const matched = flow.specialWorkflow;
  const relevant = matched
    ? [matched, ...workflows.filter(workflow => workflow.id !== matched.id).slice(0, 3)]
    : workflows.slice(0, 5);
  return relevant.map(workflow => `${workflow.skillId}/${workflow.id}${matched?.id === workflow.id ? ' (matched)' : ''}`);
}

export function buildLumiRuntimeCapabilityContext(input: LumiRuntimeCapabilityContextInput): string {
  const declarations = input.toolRegistry.getToolDeclarations();
  const toolNames = declarations.map(declaration => declaration.function.name);
  const taskLines = activeTaskLines(input);
  const adapterLines = relevantAdapters(input.flow, input.userId);
  const workflows = skillLines(input.flow);
  const toolGroups = groupTools(toolNames);

  return [
    '## Lumi Runtime Capability Context',
    'This is the compact runtime map for this turn. Lumi is the subject; tools, skills, task center, sub-agents, browser, desktop, and external software are capabilities Lumi may choose after understanding the user.',
    `Input surface=${input.flow.surface}; mode=${input.flow.operationMode}->${input.flow.effectiveOperationMode}; tools=${input.flow.allowToolUseForTurn ? 'available' : 'not for this turn'}; taskSignal=${input.flow.workTakeover.intent || 'none'}/${input.flow.workTakeover.strength}.`,
    `Execution governance: verify=${input.flow.executionGovernance.verificationIntent}; delegation=${input.flow.executionGovernance.delegationIntent}; capabilityLearning=${input.flow.executionGovernance.capabilityLearningIntent}; inspectCapabilitiesFirst=${input.flow.executionGovernance.shouldInspectCapabilitiesFirst ? 'yes' : 'no'}.`,
    `Tool groups available: ${toolGroups.join(', ') || 'none'}.`,
    `Skill workflows known: ${workflows.join(', ') || 'none'}.`,
    taskLines.length
      ? ['Active task pointers:', ...taskLines.map(line => `- ${line}`)].join('\n')
      : 'Active task pointers: none.',
    adapterLines.length
      ? ['Relevant adapters/external systems:', ...adapterLines.map(line => `- ${line}`)].join('\n')
      : 'Relevant adapters/external systems: none.',
    'Use this order: understand the turn -> decide chat/work -> if persistent work, bind/create task -> if repeatable pattern, use skill workflow -> if external execution is needed, choose adapter/tool -> verify result -> report humanly.',
  ].join('\n');
}
