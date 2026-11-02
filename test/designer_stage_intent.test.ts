import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { buildLumiTurnDispatch } from '../server/cognition/turn_dispatch';
import { buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { classifyConversationActionFollowupIntent } from '../server/cognition/action_continuation';
import { formatConversationActionLedgerStatus } from '../server/conversation/ledger/status';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { designerStatusRequest, designerInstructionText } from '../server/cognition/designer_instruction_projection';
import { isLegalEntryTurn } from '../server/cognition/legal_entry';
import { isDesignProjectStatusRequest } from '../server/design/status_intent';
import {
  isDesignProjectCreationRequest,
  isCurrentIndustryMultiWorkspaceLedgerStatusRequest,
  matchCurrentIndustryWorkflow,
} from '../server/regions/packs/cn/industry_capability_profile';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

const STAGE_REQUEST = '\u7ee7\u7eed\u5f53\u524d\u5df2\u6fc0\u6d3b\u7684\u201c\u8bbe\u8ba1\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4f4f\u5b85\u201d\uff0c\u6267\u884c\u201c\u8bbe\u8ba1\u9879\u76ee\u201d\u65b9\u6848\u9636\u6bb5\u3002\u53ea\u4f7f\u7528\u5df2\u4fdd\u5b58\u7684Brief\uff0c\u4e0d\u8865\u9020\u5c3a\u5bf8\u3001\u7ed3\u6784\u3001\u6d88\u9632\u6216\u673a\u7535\u6761\u4ef6\u3002\u8bf7\u5f62\u6210\u5e76\u5f52\u6863\u4e00\u4efd\u53ef\u590d\u6838\u7684Project scheme\u3002\u4e0d\u8981\u65b0\u5efa\u7b2c\u4e8c\u4e2a\u9879\u76ee\uff0c\u4e0d\u8981\u751f\u6210CAD\u3001\u6548\u679c\u56fe\u6216PPT\u3002';
const VISUALIZATION_REQUEST = '\u7ee7\u7eed\u5f53\u524d\u5df2\u6fc0\u6d3b\u7684\u201c\u8bbe\u8ba1\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4f4f\u5b85\u201d\uff0c\u6267\u884c\u201c\u6548\u679c\u56fe\u201d\u9636\u6bb5\u5e76\u5b8c\u6574\u5f52\u6863\u3002\u4ee5\u5df2\u4fdd\u5b58\u7684\u9879\u76ee Brief \u548c\u5df2\u9a8c\u8bc1\u7684 CAD \u9636\u6bb5\u4e3a\u9879\u76ee\u4f9d\u636e\uff1a\u5148\u5f62\u6210\u5ba2\u9910\u5385\u7684\u4e13\u4e1a\u89c6\u89c9\u65b9\u5411\uff0c\u518d\u751f\u6210\u4e00\u5f20\u771f\u5b9e\u672c\u5730\u6548\u679c\u56fe\uff0c\u8981\u6c42\u73b0\u4ee3\u81ea\u7136\u98ce\u3001\u5f00\u653e\u5f0f\u5ba2\u9910\u5385\u3001\u81ea\u7136\u6728\u8272\u4e0e\u6d45\u6696\u7070\u3001\u65e5\u95f4\u81ea\u7136\u5149\u3001\u89c6\u89d2\u80fd\u4f53\u73b0\u5ba2\u5385\u4e0e\u9910\u5385\u5173\u7cfb\uff1b\u6750\u8d28\u3001\u5bb6\u5177\u3001\u706f\u5149\u5747\u6807\u6ce8\u4e3a\u521b\u610f\u65b9\u6848\uff0c\u4e0d\u5f97\u5192\u5145\u73b0\u573a\u4e8b\u5b9e\u3002\u751f\u6210\u540e\u5fc5\u987b\u9a8c\u8bc1\u771f\u5b9e\u56fe\u7247\u6587\u4ef6\u3001\u9879\u76ee\u5f52\u5c5e\u548c\u6548\u679c\u56fe\u9636\u6bb5\u8d26\u672c\u3002\u4e0d\u8981\u6253\u5f00\u6216\u4fee\u6539\u5916\u90e8\u8f6f\u4ef6\uff0c\u4e0d\u8981\u5916\u53d1\uff1b\u7f3a\u5c11\u89c6\u89c9\u65b9\u5411\u56de\u6267\u3001\u771f\u5b9e\u56fe\u7247\u6216\u9a8c\u8bc1\u56de\u6267\u4e2d\u7684\u4efb\u610f\u4e00\u9879\uff0c\u5c31\u660e\u786e\u505c\u6b62\u4e3a\u672a\u5b8c\u6210\u3002';
const HANDOFF_REQUEST = '\u7ee7\u7eed\u5f53\u524d\u5df2\u6fc0\u6d3b\u7684\u201c\u8bbe\u8ba1\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4f4f\u5b85\u201d\uff0c\u6267\u884c\u201c\u4ea4\u4ed8\u4e2d\u5fc3\u201d\u9636\u6bb5\u3002\u4ea4\u4ed8\u5305\u5fc5\u987b\u7ee7\u627f\u5e76\u9a8c\u8bc1\u9879\u76ee\u65b9\u6848\u3001CAD\u3001\u6548\u679c\u56fe\u548c\u63d0\u6848 PPT \u7684\u771f\u5b9e\u56de\u6267\u4e0e\u6587\u4ef6\uff1b\u4efb\u4f55\u524d\u7f6e\u9636\u6bb5\u672a\u5b8c\u6210\u5c31\u7acb\u5373\u505c\u6b62\uff0c\u4e0d\u5f97\u751f\u6210\u7a7a\u5305\u6216\u5360\u4f4d\u6587\u4ef6\uff0c\u4e0d\u8981\u6253\u5f00\u5916\u90e8\u8f6f\u4ef6\uff0c\u4e0d\u8981\u5916\u53d1\u3002\u8bf7\u7ed9\u51fa\u963b\u585e\u9636\u6bb5\u548c\u6062\u590d\u987a\u5e8f\u3002';

beforeAll(async () => {
  await initDatabase();
});

describe('designer stage intent', () => {
  it('does not turn a negated second-project guard into project creation', () => {
    expect(isDesignProjectCreationRequest(STAGE_REQUEST)).toBe(false);
    expect(isDesignProjectCreationRequest('\u65b0\u5efa\u5e76\u6fc0\u6d3b\u4e00\u4e2a\u5ba4\u5185\u8bbe\u8ba1\u9879\u76ee')).toBe(true);
  });

  it('does not turn an explicit project-stage execution into a status query', () => {
    expect(isDesignProjectStatusRequest(STAGE_REQUEST)).toBe(false);
    expect(isDesignProjectStatusRequest('\u5f53\u524d\u8bbe\u8ba1\u9879\u76ee\u8fdb\u5ea6\u5230\u54ea\u4e00\u6b65\u4e86\uff1f')).toBe(true);
  });

  it('does not turn a create-and-scheme request into a status query', () => {
    const request = '\u8bbe\u8ba1\u9879\u76ee\u5b9e\u673a\u9a8c\u6536\uff1a\u65b0\u5efa\u5e76\u6fc0\u6d3b\u5ba4\u5185\u8bbe\u8ba1\u9879\u76ee\u201c\u66ae\u84dd-26\u9a8c\u6536\u4f4f\u5b85\u201d\uff1b\u8bf7\u521b\u5efa\u6301\u4e45\u9879\u76ee\u5e76\u751f\u6210\u53ef\u5ba1\u6838\u7684\u9879\u76ee\u65b9\u6848\uff0c\u5305\u542b\u5b9e\u65bd\u9636\u6bb5\u548c\u9879\u76ee\u7f16\u53f7\u3002';
    expect(isDesignProjectCreationRequest(request)).toBe(true);
    expect(isDesignProjectStatusRequest(request)).toBe(false);
  });

  it('does not turn an explicit CAD generation and verification request into a status query', () => {
    const request = 'CAD \u65b9\u6848\u5b9e\u673a\u9a8c\u6536\uff1a\u7ee7\u7eed\u5f53\u524d\u5df2\u6fc0\u6d3b\u9879\u76ee\u201c\u66ae\u84dd-26\u9a8c\u6536\u4f4f\u5b85\u201d\uff0c\u4ec5\u4f7f\u7528\u660e\u786e\u51e0\u4f55\u4e8b\u5b9e\u3002\u8bf7\u751f\u6210\u5e76\u6838\u9a8c\u4e00\u4efd\u53ef\u5ba1\u6838\u7684 DXF \u548c SVG \u9884\u89c8\uff0c\u6807\u6ce8\u6587\u4ef6\u8def\u5f84\u3001\u6301\u4e45\u4efb\u52a1\u7f16\u53f7\u548c\u9a8c\u8bc1\u56de\u6267\uff1b\u4e0d\u6253\u5f00\u5916\u90e8\u8f6f\u4ef6\u3002';
    expect(matchCurrentIndustryWorkflow(request)?.entry.entryId).toBe('cad');
    expect(isDesignProjectStatusRequest(request)).toBe(false);
  });

  it('does not collapse a five-workspace receipt summary into the active project status reader', () => {
    const multiWorkspaceQuery = '设计师版文字验收：请只根据已经存在的行业任务账本和最终回执，分别列出“设计项目、CAD 方案、效果图、提案 PPT、交付中心”的最近任务状态、关键结果、交付物和确认边界；不要重新执行工作流。';
    expect(isDesignProjectStatusRequest(multiWorkspaceQuery)).toBe(false);
    expect(isCurrentIndustryMultiWorkspaceLedgerStatusRequest(multiWorkspaceQuery)).toBe(true);
    expect(normalizeActionIntent(multiWorkspaceQuery).kind, JSON.stringify({ status: designerStatusRequest(multiWorkspaceQuery), projection: designerInstructionText(multiWorkspaceQuery) })).toBe('status_query');
    expect(classifyConversationActionFollowupIntent(multiWorkspaceQuery)).toBe('status');
    const dispatch = buildLumiTurnDispatch({
      userId: 'designer-multi-workspace-status',
      text: multiWorkspaceQuery,
      channel: 'chat',
      source: 'command-center-chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    expect(dispatch.flow.industryWorkflowEntryId).toBe('');
  });

  it('reads the five-workspace summary from the durable project ledger across conversations', () => {
    const query = '设计师版文字验收：请只根据已经存在的行业任务账本和最终回执，分别列出“设计项目、CAD 方案、效果图、提案 PPT、交付中心”的最近任务状态、关键结果、交付物和确认边界；不要重新执行工作流。';
    const stage = (entryId: string, status: string, verificationStatus: string, extras: Record<string, unknown> = {}) => ({
      entryId,
      status,
      verificationStatus,
      currentTaskId: `task-${entryId}`,
      artifacts: [],
      blocker: '',
      ...extras,
    });
    const db = {
      conversations: [{ id: 'current-conversation', userId: 'designer-user', domain: 'personal', orgId: '' }],
      conversationActionTasks: [],
      conversationActionReceipts: [],
      interiorProjects: [{
        id: 'project-1',
        orgId: 'personal:designer-user',
        ownerUserId: 'designer-user',
        name: '设计师版稳定性验收住宅',
        status: 'active',
        createdAt: '2026-08-18T10:00:00.000Z',
        updatedAt: '2026-08-18T10:00:00.000Z',
        workflow: {
          stages: {
            project: stage('project', 'completed', 'passed', { artifacts: [{ label: 'Project scheme', fileName: '' }] }),
            cad: stage('cad', 'completed', 'passed', { artifacts: [{ label: 'Verified CAD deliverable', fileName: 'verified.dxf' }] }),
            visualization: stage('visualization', 'blocked', 'blocked', { blocker: 'DashScope Arrearage/overdue' }),
            presentation: stage('presentation', 'blocked', 'blocked', { blocker: '上游效果图未完成' }),
            handoff: stage('handoff', 'blocked', 'blocked', { blocker: '上游效果图和提案 PPT 未完成' }),
          },
        },
      }],
    };

    const stored = readDB();
    stored.interiorProjects.push(...db.interiorProjects as any);
    writeDB(stored);
    const result = formatConversationActionLedgerStatus(db, {
      conversationId: 'current-conversation',
      userId: 'designer-user',
      query,
    });

    expect(result).toContain('【设计项目】\n最近任务状态：已完成（最终回执已验证）');
    expect(result).toContain('Project scheme');
    expect(result).toContain('【CAD 方案】\n最近任务状态：已完成（最终回执已验证）');
    expect(result).toContain('Verified CAD deliverable（verified.dxf）');
    expect(result).toContain('【效果图】\n最近任务状态：受阻（验证状态：blocked）');
    expect(result).toContain('DashScope Arrearage/overdue');
    expect(result).toContain('【提案 PPT】\n最近任务状态：受阻');
    expect(result).toContain('【交付中心】\n最近任务状态：受阻');
    expect(result).toContain('未重新执行工作流、未调用外部工具、未创建新任务');
  });

  it('recognizes a project-specific CAD receipt query as design project status', () => {
    const statusQuery = '\u53ea\u67e5\u8be2\u5f53\u524d\u5df2\u6fc0\u6d3b\u7684\u201c\u8bbe\u8ba1\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4f4f\u5b85\u201d\u7684\u9879\u76ee\u8d26\u672c\u72b6\u6001\uff1aCAD \u65b9\u6848\u662f\u5426\u5df2\u7ecf\u5b8c\u6210\uff1f\u8bf7\u7ed9\u51faCAD\u9636\u6bb5\u72b6\u6001\u3001\u9a8c\u8bc1\u72b6\u6001\u3001\u5f53\u524d\u4efb\u52a1ID\u3001\u4ea4\u4ed8\u6587\u4ef6\u8def\u5f84\u548c\u4e0b\u4e00\u9636\u6bb5\u3002';
    expect(isDesignProjectStatusRequest(statusQuery)).toBe(true);
    expect(buildActionContract(statusQuery).kind).toBe('design_delivery');
    expect(hasCoreActionEvidence(buildActionContract(statusQuery), [{
      name: 'interior_design_project_status',
      arguments: {},
      terminalVerification: { status: 'verified', strategy: 'measured', reason: 'fixture ledger' },
      result: JSON.stringify({
        ok: true,
        persisted: true,
        project: { id: 'design-project-1' },
        workflow: { stages: { cad: { status: 'completed', verificationStatus: 'passed' } } },
      }),
    }], statusQuery)).toBe(true);
  });

  it('keeps a presentation ledger query read-only when it contains explicit negative execution guards', () => {
    const statusQuery = '\u53ea\u67e5\u8be2\u5f53\u524d\u5df2\u6fc0\u6d3b\u7684\u201c\u8bbe\u8ba1\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4f4f\u5b85\u201d\u9879\u76ee\u8d26\u672c\uff1a\u63d0\u6848 PPT \u9636\u6bb5\u73b0\u5728\u662f\u4ec0\u4e48\u72b6\u6001\uff1f\u8bf7\u7ed9\u51fa\u9636\u6bb5\u72b6\u6001\u3001\u9a8c\u8bc1\u72b6\u6001\u3001\u963b\u585e\u539f\u56e0\u3001\u5f53\u524d\u4efb\u52a1ID\u548c\u4e0b\u4e00\u6b65\u3002\u4e0d\u8981\u751f\u6210 PPT\uff0c\u4e0d\u8981\u6267\u884c\u65b0\u8bbe\u8ba1\uff0c\u4e0d\u8981\u6253\u5f00\u5916\u90e8\u8f6f\u4ef6\uff0c\u4e0d\u8981\u5916\u53d1\u3002';
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'designer-presentation-status-guard',
        text: statusQuery,
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      source: 'chat',
    });

    expect(isDesignProjectStatusRequest(statusQuery)).toBe(true);
    expect(pipeline.normalizedIntent.kind).toBe('status_query');
    expect(pipeline.execution.toolPolicy.allowedTools).toEqual(['interior_design_project_status']);
    expect(pipeline.execution.toolPolicy.allowedTools).not.toContain('create_ppt');
  });

  it('does not mistake missing information for a legal bad-credit query', () => {
    expect(isLegalEntryTurn(STAGE_REQUEST)).toBe(false);
    expect(isLegalEntryTurn('\u67e5\u8be2\u8fd9\u5bb6\u516c\u53f8\u7684\u5931\u4fe1\u8bb0\u5f55')).toBe(true);
  });

  it('exposes the complete project-stage tool contract for the real replay wording', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'designer-stage-intent',
        text: STAGE_REQUEST,
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      source: 'chat',
    });
    expect(pipeline.turnIntent.flow.industryWorkflowEntryId).toBe('project');
    // Main's modular planner retains its artifact lane; the edition contract
    // is enforced by the actual projected tool set and bound workflow entry.
    expect(pipeline.authorizationPolicy.allowedTools).toContain('industry_workflow_complete');
    expect(pipeline.execution.toolPolicy.allowedTools).toEqual(expect.arrayContaining([
      'industry_workflow_start',
      'industry_workflow_complete',
      'interior_design_project_status',
    ]));
    expect(pipeline.execution.toolPolicy.allowedTools).not.toContain('work_takeover_task_get');
    expect(matchCurrentIndustryWorkflow(STAGE_REQUEST)?.entry.contract.executionTools).toEqual(expect.arrayContaining([
      'mcp_design-studio-pack_interior_project_brief',
      'mcp_design-studio-pack_space_planning_checklist',
    ]));
    expect(pipeline.execution.toolPolicy.allowedTools).not.toContain('interior_design_project_create');
    expect(pipeline.execution.promptOverlay).toContain('entryId=project');
    expect(pipeline.execution.promptOverlay).not.toContain('Design Project Creation Route');
  });

  it('prioritizes an explicit visualization workspace over generic project context', () => {
    expect(matchCurrentIndustryWorkflow(VISUALIZATION_REQUEST)?.entry.entryId).toBe('visualization');
    expect(matchCurrentIndustryWorkflow('继续项目方案；不要生成效果图，只归档项目 Brief')?.entry.entryId).toBe('project');
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'designer-visualization-intent',
        text: VISUALIZATION_REQUEST,
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      source: 'chat',
    });
    expect(pipeline.normalizedIntent.kind).toBe('media_generation');
    expect(pipeline.execution.toolPolicy.allowedTools).toContain('generate_image');
    expect(pipeline.authorizationPolicy.allowedTools).toContain('generate_image');
    expect(pipeline.execution.toolPolicy.allowedTools).not.toContain('generate_video');
  });

  it('prioritizes the explicitly executed handoff stage over its presentation dependency list', () => {
    const match = matchCurrentIndustryWorkflow(HANDOFF_REQUEST);
    expect(match?.entry.entryId).toBe('handoff');
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'designer-handoff-target',
        text: HANDOFF_REQUEST,
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      source: 'chat',
    });
    expect(pipeline.turnIntent.flow.industryWorkflowEntryId).toBe('handoff');
    expect(pipeline.execution.toolPolicy.allowedTools).toContain('design_delivery_package_create');
    expect(pipeline.execution.toolPolicy.allowedTools).not.toContain('create_ppt');
  });

  it('keeps explicit visualization status questions read-only', () => {
    const status = '\u5f53\u524d\u6548\u679c\u56fe\u9636\u6bb5\u662f\u5426\u5df2\u7ecf\u5b8c\u6210\uff1f';
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'designer-visualization-status',
        text: status,
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      source: 'chat',
    });
    expect(pipeline.normalizedIntent.kind).toBe('status_query');
    expect(pipeline.execution.toolPolicy.allowedTools).not.toContain('generate_image');
  });

  it('does not let recovered task status text replace the current visualization intent', () => {
    const dispatchInput = {
      userId: 'designer-visualization-active-task',
      text: VISUALIZATION_REQUEST,
      channel: 'chat' as const,
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    };
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const pipeline = buildLumiExecutionPipeline({
      userText: VISUALIZATION_REQUEST,
      dispatch: { ...dispatchInput, text: `${VISUALIZATION_REQUEST}\n\n- prior task status: blocked` },
      registry,
      source: 'chat',
    });
    expect(pipeline.normalizedIntent.kind).toBe('media_generation');
    expect(pipeline.authorizationPolicy.allowedTools).toContain('generate_image');
    expect(pipeline.execution.toolPolicy.allowedTools).toContain('generate_image');
  });
});
