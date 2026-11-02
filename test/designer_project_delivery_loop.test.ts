import './helpers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { flushDBOrThrow, readDB, writeDB } from '../db_layer';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { ensureBackgroundConversationActionTask } from '../server/conversation/ledger/background';
import {
  createInteriorProject,
  getActiveInteriorProject,
  personalInteriorProjectScope,
  setActiveInteriorProject,
  updateInteriorProject,
} from '../server/design/projects';
import {
  getInteriorProjectWorkflow,
  getMissingInteriorProjectPrerequisites,
  linkInteriorProjectWorkflowStage,
} from '../server/design/project_workflow';
import {
  recordIndustryWorkflowExecution,
  startIndustryWorkflow,
} from '../server/industry/workflow_service';
import { ToolRegistry } from '../server/tools/registry';
import { registerIndustryWorkflowTools } from '../server/tools/definitions/industry_workflow_tools';
import { registerAllTools } from '../server/tools/definitions';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import {
  formatIndustryCapabilityProfilePrompt,
  formatIndustryWorkflowRoutingPrompt,
  isDesignProjectCreationRequest,
} from '../server/regions/packs/cn/industry_capability_profile';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

function stageResult(entryId: string): string {
  const results: Record<string, string> = {
    project: 'concept layout risk implementation brief reviewed and archived. The project scope, fixed conditions, evidence gaps, design direction, room relationships, professional review boundaries, and next implementation actions are recorded for accountable review before later drawing work.',
    cad: 'CAD geometry dimension layer verification reviewed and archived. The source basis, fixed dimensions, coordinate relationships, drawing layers, openings, unresolved structure and MEP conflicts, output path, and geometry verification record are documented for professional review.',
    visualization: 'camera lighting material render image reviewed and archived. The selected space, camera composition, daylight and artificial lighting, material references, creative assumptions, image outputs, and review notes are recorded against the bound project.',
    presentation: 'proposal storyline layout material implementation PPT reviewed and archived. The audience, decision goal, verified project facts, concept sequence, spatial scheme, visual assets, material direction, implementation notes, and presentation file review are documented.',
    handoff: 'drawing schedule version checklist handoff reviewed and archived. The drawing register, file versions, CAD and visual outputs, proposal, material schedules, unresolved items, recipient scope, opening checks, professional approvals, and delivery manifest are documented.',
  };
  return results[entryId];
}

function stageFile(directory: string, entryId: string): string[] {
  const extensions: Record<string, string> = {
    cad: '.dxf',
    visualization: '.png',
    presentation: '.pptx',
    handoff: '.zip',
  };
  const extension = extensions[entryId];
  if (!extension) return [];
  const filePath = path.join(directory, `${entryId}${extension}`);
  if (extension === '.dxf') fs.writeFileSync(filePath, stageResult(entryId), 'utf8');
  else fs.writeFileSync(filePath, Buffer.alloc(256, 9));
  return [filePath];
}

function stageToolRecords(entryId: string, binding: {
  task: { id: string };
  conversationTaskId: string;
  requestId: string;
}): any[] {
    const names: Record<string, string[]> = {
    project: [
      'mcp_design-studio-pack_interior_project_brief',
      'mcp_design-studio-pack_space_planning_checklist',
    ],
    cad: ['mcp_design-studio-pack_drawing_ingest_qa', 'cad_generate_dxf'],
    visualization: ['mcp_design-studio-pack_interior_visual_direction', 'generate_image'],
    presentation: ['interior_design_project_status', 'create_ppt'],
    handoff: ['interior_design_project_status', 'design_delivery_package_create'],
  };
  return (names[entryId] || []).map((name, index) => ({
    id: `${entryId}-${binding.requestId}-${index}`,
    taskId: binding.conversationTaskId,
    requestId: binding.requestId,
    name,
    arguments: {},
    result: JSON.stringify({
      ok: true,
      status: 'verified',
      taskId: binding.task.id,
      summary: stageResult(entryId),
    }),
    terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'verified test receipt' },
  }));
}

describe('designer project delivery loop', () => {
  it('keeps a previously verified project stage valid while a later replay is interrupted', () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_verified_replay_${suffix}`;
    const scopeId = personalInteriorProjectScope(userId);
    const project = createInteriorProject(scopeId, userId, { name: 'Verified replay project' });
    setActiveInteriorProject(scopeId, userId, project.id);
    const scope = { userId, domain: 'personal' as const, orgId: '' };
    const first = startIndustryWorkflow({ ...scope, entryId: 'project', source: 'chat' });
    const delivered = recordIndustryWorkflowExecution({
      ...scope,
      taskId: first.task.id,
      resultText: stageResult('project'),
      toolRecords: stageToolRecords('project', first),
    });
    expect(delivered.verification.passed).toBe(true);

    linkInteriorProjectWorkflowStage({
      orgId: scopeId,
      projectId: project.id,
      entryId: 'project',
      taskId: `wt_task_interrupted_${suffix}`,
      conversationTaskId: `conversation_task_${suffix}`,
      rootConversationId: `conversation_${suffix}`,
      rootTaskId: `root_${suffix}`,
    });
    const workflow = getInteriorProjectWorkflow(scopeId, project.id)!;
    expect(workflow.stages.project.status).toBe('in_progress');
    expect(workflow.stages.project.verificationStatus).toBe('passed');
    expect(getMissingInteriorProjectPrerequisites(workflow, 'cad')).toEqual([]);

    const cad = linkInteriorProjectWorkflowStage({
      orgId: scopeId,
      projectId: project.id,
      entryId: 'cad',
      taskId: `wt_task_cad_${suffix}`,
      conversationTaskId: `conversation_task_cad_${suffix}`,
      rootConversationId: `conversation_${suffix}`,
      rootTaskId: `root_${suffix}`,
    });
    expect(cad.stages.cad.sourceTaskIds).toContain(first.task.id);
    expect(cad.stages.cad.sourceTaskIds).not.toContain(`wt_task_interrupted_${suffix}`);
  });

  it('persists an active project binding per user for voice and chat inheritance', () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const owner = `design_active_owner_${suffix}`;
    const other = `design_active_other_${suffix}`;
    const scopeId = personalInteriorProjectScope(owner);
    const project = createInteriorProject(scopeId, owner, { name: 'Persistent voice project' });

    expect(getActiveInteriorProject(scopeId, owner)).toBeNull();
    setActiveInteriorProject(scopeId, owner, project.id);
    expect(getActiveInteriorProject(scopeId, owner)?.id).toBe(project.id);
    expect(getActiveInteriorProject(scopeId, other)).toBeNull();
  });

  it('requires explicit standalone mode and never advances the active project from an independent stage task', () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_standalone_continuity_${suffix}`;
    const scopeId = personalInteriorProjectScope(userId);
    const project = createInteriorProject(scopeId, userId, { name: 'Protected continuity project' });
    setActiveInteriorProject(scopeId, userId, project.id);
    const scope = { userId, domain: 'personal' as const, orgId: '' };
    const independentUserId = `${userId}_without_project`;

    expect(() => startIndustryWorkflow({
      userId: independentUserId,
      domain: 'personal',
      orgId: '',
      entryId: 'cad',
      source: 'chat',
    })).toThrow(/requires a bound project.*explicit independent task/i);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-design-standalone-'));
    try {
      const standalone = startIndustryWorkflow({
        ...scope,
        entryId: 'cad',
        sourceInput: 'Create an independent CAD geometry check without attaching it to the active project.',
        source: 'designer_standalone_workspace',
        context: { mode: 'standalone' },
      });
      expect(standalone.project).toBeUndefined();
      expect(standalone.projectWorkflow).toBeUndefined();
      expect(standalone.task.metadata.industryWorkflow.context).toMatchObject({ mode: 'standalone' });
      expect(standalone.task.metadata.industryWorkflow.context).not.toHaveProperty('projectId');
      expect(standalone.handoffPrompt).toMatch(/explicit standalone independent task/i);

      const delivered = recordIndustryWorkflowExecution({
        ...scope,
        taskId: standalone.task.id,
        resultText: stageResult('cad'),
        filePaths: stageFile(directory, 'cad'),
        toolRecords: stageToolRecords('cad', standalone),
      });
      expect(delivered.verification.passed).toBe(true);
      expect(delivered.task.status).toBe('delivered');
      const protectedWorkflow = getInteriorProjectWorkflow(scopeId, project.id)!;
      expect(protectedWorkflow.rootTaskId).toBe('');
      expect(protectedWorkflow.activeStage).toBe('');
      expect(Object.values(protectedWorkflow.stages).every(stage => (
        stage.status === 'not_started'
        && stage.taskIds.length === 0
        && stage.receiptIds.length === 0
      ))).toBe(true);
      expect(getActiveInteriorProject(scopeId, userId)).toMatchObject({
        id: project.id,
        status: 'brief',
      });
      const actionTask = readDB().conversationActionTasks.find(
        (task: any) => task.id === standalone.conversationTaskId,
      );
      expect(actionTask?.parentTaskId || '').not.toBe(`design_project_${project.id}`);
      expect(JSON.parse(actionTask.context).industryWorkflow).toMatchObject({ mode: 'standalone' });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rebinds a reused blocked stage to the current conversation action task', () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_rebind_${suffix}`;
    const scopeId = personalInteriorProjectScope(userId);
    const project = createInteriorProject(scopeId, userId, { name: 'Rebind project' });
    setActiveInteriorProject(scopeId, userId, project.id);
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const firstTaskId = `conversation_first_${suffix}`;
    const secondTaskId = `conversation_second_${suffix}`;
    const db = readDB();
    ensureBackgroundConversationActionTask(db, {
      taskId: firstTaskId,
      conversationId: conversation.id,
      userId,
      domain: 'personal',
      orgId: '',
      goal: 'Create project scheme',
      target: 'design:project',
      requestId: `request_first_${suffix}`,
      source: 'chat',
    });
    ensureBackgroundConversationActionTask(db, {
      taskId: secondTaskId,
      conversationId: conversation.id,
      userId,
      domain: 'personal',
      orgId: '',
      goal: 'Retry project scheme',
      target: 'design:project',
      requestId: `request_second_${suffix}`,
      source: 'chat',
    });
    writeDB(db);

    const first = startIndustryWorkflow({
      userId,
      domain: 'personal',
      orgId: '',
      entryId: 'project',
      source: 'chat',
      conversationId: conversation.id,
      conversationTaskId: firstTaskId,
      requestId: `request_first_${suffix}`,
    });
    recordIndustryWorkflowExecution({
      userId,
      domain: 'personal',
      orgId: '',
      taskId: first.task.id,
      resultText: 'Project scheme is blocked because no verified professional receipt exists.',
      toolRecords: [],
    });
    const resumed = startIndustryWorkflow({
      userId,
      domain: 'personal',
      orgId: '',
      entryId: 'project',
      source: 'chat',
      conversationId: conversation.id,
      conversationTaskId: secondTaskId,
      requestId: `request_second_${suffix}`,
    });

    expect(resumed.reused).toBe(true);
    expect(resumed.task.id).toBe(first.task.id);
    expect(resumed.conversationTaskId).toBe(secondTaskId);
    expect(resumed.task.metadata.industryWorkflow.conversationTaskId).toBe(secondTaskId);
    const reboundActionTask = readDB().conversationActionTasks.find((task: any) => task.id === secondTaskId);
    expect(reboundActionTask).toMatchObject({ status: 'executing', parentTaskId: `design_project_${project.id}` });
    expect(JSON.parse(reboundActionTask.context).industryWorkflow.workTakeoverTaskId).toBe(first.task.id);
  });

  it('settles the project root between verified stages instead of leaving a ghost execution', () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_root_settlement_${suffix}`;
    const scopeId = personalInteriorProjectScope(userId);
    const project = createInteriorProject(scopeId, userId, { name: 'Root settlement project' });
    setActiveInteriorProject(scopeId, userId, project.id);
    const scope = { userId, domain: 'personal' as const, orgId: '' };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-design-root-'));
    try {
      const projectStage = startIndustryWorkflow({ ...scope, entryId: 'project', source: 'chat' });
      recordIndustryWorkflowExecution({
        ...scope,
        taskId: projectStage.task.id,
        resultText: stageResult('project'),
        toolRecords: stageToolRecords('project', projectStage),
      });
      const cadStage = startIndustryWorkflow({ ...scope, entryId: 'cad', source: 'chat' });
      const cadResult = recordIndustryWorkflowExecution({
        ...scope,
        taskId: cadStage.task.id,
        resultText: stageResult('cad'),
        filePaths: stageFile(directory, 'cad'),
        toolRecords: stageToolRecords('cad', cadStage),
      });

      expect(cadResult.verification.passed).toBe(true);
      const rootTask = readDB().conversationActionTasks.find(
        (task: any) => task.id === `design_project_${project.id}`,
      );
      expect(rootTask).toMatchObject({ status: 'blocked', activeRequestId: '' });
      expect(rootTask.blocker).toMatch(/Stage cad is verified.*next design stage/i);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('links all five stages to one project root and completes only from verified receipts', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_loop_${suffix}`;
    const scopeId = personalInteriorProjectScope(userId);
    const project = createInteriorProject(scopeId, userId, {
      name: 'Apartment full delivery',
      projectType: 'residential',
      brief: { area: '120 m2', requirements: 'Three bedrooms and shared family space' },
    });
    setActiveInteriorProject(scopeId, userId, project.id);
    const scope = { userId, domain: 'personal' as const, orgId: '' };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-design-loop-'));

    try {
      const projectStage = startIndustryWorkflow({ ...scope, entryId: 'project', source: 'voice' });
      expect(projectStage.project?.id).toBe(project.id);
      expect(projectStage.handoffPrompt).toContain(project.id);
      expect(projectStage.projectWorkflow?.rootTaskId).toBe(`design_project_${project.id}`);

      const duplicate = startIndustryWorkflow({ ...scope, entryId: 'project', source: 'chat' });
      expect(duplicate.reused).toBe(true);
      expect(duplicate.task.id).toBe(projectStage.task.id);

      const earlyHandoff = startIndustryWorkflow({ ...scope, entryId: 'handoff', source: 'voice' });
      const blockedHandoff = recordIndustryWorkflowExecution({
        ...scope,
        taskId: earlyHandoff.task.id,
        resultText: stageResult('handoff'),
        filePaths: stageFile(directory, 'handoff'),
        toolRecords: stageToolRecords('handoff', earlyHandoff),
      });
      expect(blockedHandoff.verification.passed).toBe(false);
      expect(blockedHandoff.verification.summary).toMatch(/upstream stages/i);

      const projectResult = recordIndustryWorkflowExecution({
        ...scope,
        taskId: projectStage.task.id,
        resultText: stageResult('project'),
        toolRecords: stageToolRecords('project', duplicate),
      });
      expect(projectResult.verification.passed).toBe(true);

      for (const entryId of ['cad', 'visualization', 'presentation'] as const) {
        const started = startIndustryWorkflow({ ...scope, entryId, source: 'voice' });
        expect(started.handoffPrompt).toContain(projectStage.task.id);
        const recorded = recordIndustryWorkflowExecution({
          ...scope,
          taskId: started.task.id,
          resultText: stageResult(entryId),
          filePaths: stageFile(directory, entryId),
          toolRecords: stageToolRecords(entryId, started),
        });
        expect(recorded.verification.passed, `${entryId}: ${recorded.verification.summary}; ${JSON.stringify(recorded.verification.checks)}`).toBe(true);
      }

      const resumedHandoff = startIndustryWorkflow({ ...scope, entryId: 'handoff', source: 'chat' });
      expect(resumedHandoff.task.id).toBe(earlyHandoff.task.id);
      const delivered = recordIndustryWorkflowExecution({
        ...scope,
        taskId: resumedHandoff.task.id,
        resultText: stageResult('handoff'),
        filePaths: stageFile(directory, 'handoff'),
        toolRecords: stageToolRecords('handoff', resumedHandoff),
      });
      expect(delivered.verification.passed).toBe(true);

      await flushDBOrThrow();
      const workflow = getInteriorProjectWorkflow(scopeId, project.id)!;
      expect(Object.values(workflow.stages).every(stage => stage.status === 'completed')).toBe(true);
      expect(workflow.stages.cad.sourceTaskIds).toContain(projectStage.task.id);
      expect(workflow.stages.handoff.sourceTaskIds).toHaveLength(4);
      expect(workflow.stages.handoff.artifacts.some(artifact => artifact.fileName === 'handoff.zip')).toBe(true);
      expect(workflow.stages.handoff.receiptIds).toContain(`industry_receipt_${delivered.verification.verificationId}`);

      const db = readDB();
      const rootTask = db.conversationActionTasks.find((task: any) => task.id === workflow.rootTaskId);
      expect(rootTask).toMatchObject({ status: 'completed', completionSource: 'tool_receipt' });
      const childTasks = db.conversationActionTasks.filter((task: any) => task.parentTaskId === workflow.rootTaskId);
      expect(childTasks.length).toBeGreaterThanOrEqual(5);

      const statusRegistry = new ToolRegistry();
      registerIndustryWorkflowTools(statusRegistry);
      const projected = JSON.parse(await statusRegistry.execute('interior_design_project_status', {
        projectId: project.id,
      }, { userId, domain: 'personal', orgId: '' } as any));
      expect(projected.workflow.completedStages).toEqual(['project', 'cad', 'visualization', 'presentation', 'handoff']);
      expect(Object.values(projected.workflow.stages).flatMap((stage: any) => stage.artifacts)
        .every((artifact: any) => Boolean(artifact.path) || artifact.status === 'delivered')).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('exposes project creation and receipt-grounded status to the model tool layer', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_tools_${suffix}`;
    const registry = new ToolRegistry();
    registerIndustryWorkflowTools(registry);
    const context = { userId, domain: 'personal' as const, orgId: '' } as any;

    const created = JSON.parse(await registry.execute('interior_design_project_create', {
      name: 'Voice-created studio',
      projectType: 'office',
      area: '88 m2',
    }, context));
    expect(created).toMatchObject({ ok: true, status: 'created', persisted: true, active: true });

    const status = JSON.parse(await registry.execute('interior_design_project_status', {}, context));
    expect(status.project.id).toBe(created.project.id);
    expect(status.workflow.stages).toHaveProperty('handoff');
  });

  it('does not regress the overall project status when an earlier stage is rerun', () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_status_monotonic_${suffix}`;
    const scopeId = personalInteriorProjectScope(userId);
    const project = createInteriorProject(scopeId, userId, { name: 'Monotonic stage project' });
    setActiveInteriorProject(scopeId, userId, project.id);
    const scope = { userId, domain: 'personal' as const, orgId: '' };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-design-status-monotonic-'));
    try {
      const projectStage = startIndustryWorkflow({ ...scope, entryId: 'project', source: 'chat' });
      recordIndustryWorkflowExecution({
        ...scope,
        taskId: projectStage.task.id,
        resultText: stageResult('project'),
        toolRecords: stageToolRecords('project', projectStage),
      });
      const cadStage = startIndustryWorkflow({ ...scope, entryId: 'cad', source: 'chat' });
      recordIndustryWorkflowExecution({
        ...scope,
        taskId: cadStage.task.id,
        resultText: stageResult('cad'),
        filePaths: stageFile(directory, 'cad'),
        toolRecords: stageToolRecords('cad', cadStage),
      });
      expect(getActiveInteriorProject(scopeId, userId)?.status).toBe('design');

      const repeatedProjectStage = startIndustryWorkflow({ ...scope, entryId: 'project', source: 'chat' });
      recordIndustryWorkflowExecution({
        ...scope,
        taskId: repeatedProjectStage.task.id,
        resultText: stageResult('project'),
        toolRecords: stageToolRecords('project', repeatedProjectStage),
      });
      expect(getActiveInteriorProject(scopeId, userId)?.status).toBe('design');
      expect(getInteriorProjectWorkflow(scopeId, project.id)?.activeStage).toBe('cad');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports insufficient CAD source as a business blocker instead of a capability failure', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_cad_blocker_${suffix}`;
    const scopeId = personalInteriorProjectScope(userId);
    const project = createInteriorProject(scopeId, userId, { name: 'CAD blocker project' });
    setActiveInteriorProject(scopeId, userId, project.id);
    const scope = { userId, domain: 'personal' as const, orgId: '' };
    const projectStage = startIndustryWorkflow({ ...scope, entryId: 'project', source: 'chat' });
    recordIndustryWorkflowExecution({
      ...scope,
      taskId: projectStage.task.id,
      resultText: stageResult('project'),
      toolRecords: stageToolRecords('project', projectStage),
    });
    const started = startIndustryWorkflow({ ...scope, entryId: 'cad', source: 'chat' });
    const assessment = stageToolRecords('cad', started)[0];
    assessment.result = JSON.stringify({
      status: 'insufficient_verified_geometry',
      evidenceGaps: ['No measured wall coordinates or openings'],
    });

    const recorded = recordIndustryWorkflowExecution({
      ...scope,
      taskId: started.task.id,
      resultText: 'The source has no measured wall coordinates, openings, level heights, or verified dimensions, so drawing generation stopped without a placeholder.',
      toolRecords: [assessment],
    });

    expect(recorded.task.status).toBe('blocked');
    expect(recorded.verification.status).toBe('blocked');
    expect(recorded.verification.summary).toMatch(/verified geometry/i);
    expect(recorded.verification.summary).not.toMatch(/cad_generate_dxf/i);

    const registry = new ToolRegistry();
    registerIndustryWorkflowTools(registry);
    const status = JSON.parse(await registry.execute('interior_design_project_status', {
      projectId: project.id,
    }, { userId, domain: 'personal', orgId: '' } as any));
    expect(status.workflow.stages.cad.status).toBe('blocked');
    expect(status.workflow.stages.cad.blocker).toMatch(/verified geometry/i);
  });

  it('reports a failed CAD generator honestly after source QA has passed', () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_cad_generator_blocker_${suffix}`;
    const scopeId = personalInteriorProjectScope(userId);
    const project = createInteriorProject(scopeId, userId, { name: 'CAD generator blocker project' });
    setActiveInteriorProject(scopeId, userId, project.id);
    const scope = { userId, domain: 'personal' as const, orgId: '' };
    const projectStage = startIndustryWorkflow({ ...scope, entryId: 'project', source: 'chat' });
    recordIndustryWorkflowExecution({
      ...scope,
      taskId: projectStage.task.id,
      resultText: stageResult('project'),
      toolRecords: stageToolRecords('project', projectStage),
    });
    const started = startIndustryWorkflow({ ...scope, entryId: 'cad', source: 'chat' });
    const assessment = stageToolRecords('cad', started)[0];
    assessment.result = JSON.stringify({ status: 'ready_for_geometry_extraction', evidenceGaps: [] });
    const generation = {
      ...stageToolRecords('cad', started)[1],
      result: '',
      error: 'Tool "cad_generate_dxf" requires user confirmation: Local write actions require confirmation unless the current turn explicitly requested a local deliverable.',
      terminalVerification: { status: 'failed', strategy: 'terminal_receipt', reason: 'confirmation required' },
    };

    const recorded = recordIndustryWorkflowExecution({
      ...scope,
      taskId: started.task.id,
      resultText: 'The CAD file could not be created.',
      toolRecords: [assessment, generation],
    });

    expect(recorded.task.status).toBe('blocked');
    expect(recorded.verification.summary).toMatch(/did not run.*local-file authorization/i);
    expect(recorded.verification.summary).not.toMatch(/does not contain enough verified geometry/i);
  });

  it('preserves the real image-provider blocker without exposing internal tool names', () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_visual_provider_blocker_${suffix}`;
    const scopeId = personalInteriorProjectScope(userId);
    const project = createInteriorProject(scopeId, userId, { name: 'Visualization provider blocker' });
    setActiveInteriorProject(scopeId, userId, project.id);
    const scope = { userId, domain: 'personal' as const, orgId: '' };
    const projectStage = startIndustryWorkflow({ ...scope, entryId: 'project', source: 'chat' });
    recordIndustryWorkflowExecution({
      ...scope,
      taskId: projectStage.task.id,
      resultText: stageResult('project'),
      toolRecords: stageToolRecords('project', projectStage),
    });
    const cadStage = startIndustryWorkflow({ ...scope, entryId: 'cad', source: 'chat' });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-design-provider-blocker-'));
    try {
      recordIndustryWorkflowExecution({
        ...scope,
        taskId: cadStage.task.id,
        resultText: stageResult('cad'),
        filePaths: stageFile(directory, 'cad'),
        toolRecords: stageToolRecords('cad', cadStage),
      });
      const visual = startIndustryWorkflow({ ...scope, entryId: 'visualization', source: 'chat' });
      const direction = stageToolRecords('visualization', visual)[0];
      const failedImage = {
        ...stageToolRecords('visualization', visual)[1],
        result: '',
        error: 'All configured image providers failed: qwen: DashScope image error (Arrearage): Access denied.',
        terminalVerification: { status: 'failed', strategy: 'provider_ack', reason: 'provider failure' },
      };
      const recorded = recordIndustryWorkflowExecution({
        ...scope,
        taskId: visual.task.id,
        resultText: 'The visual direction is ready, but no image file was produced.',
        toolRecords: [direction, failedImage],
      });

      expect(recorded.verification.summary).toMatch(/Image generation failed.*Arrearage/i);
      expect(recorded.verification.summary).not.toMatch(/generate_image/i);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not archive historical paths returned by a read-only project-status receipt as new output', () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_status_path_${suffix}`;
    const scopeId = personalInteriorProjectScope(userId);
    const project = createInteriorProject(scopeId, userId, { name: 'Read-only path project' });
    setActiveInteriorProject(scopeId, userId, project.id);
    const scope = { userId, domain: 'personal' as const, orgId: '' };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-design-status-path-'));
    try {
      const projectStage = startIndustryWorkflow({ ...scope, entryId: 'project', source: 'chat' });
      recordIndustryWorkflowExecution({
        ...scope,
        taskId: projectStage.task.id,
        resultText: stageResult('project'),
        toolRecords: stageToolRecords('project', projectStage),
      });
      const cadStage = startIndustryWorkflow({ ...scope, entryId: 'cad', source: 'chat' });
      recordIndustryWorkflowExecution({
        ...scope,
        taskId: cadStage.task.id,
        resultText: stageResult('cad'),
        filePaths: stageFile(directory, 'cad'),
        toolRecords: stageToolRecords('cad', cadStage),
      });
      const historicalPpt = stageFile(directory, 'presentation')[0];
      const presentation = startIndustryWorkflow({ ...scope, entryId: 'presentation', source: 'chat' });
      const statusRecord = {
        id: 'status-with-history',
        name: 'interior_design_project_status',
        arguments: { projectId: project.id },
        result: JSON.stringify({
          ok: true,
          status: 'observed',
          persisted: true,
          project: { id: project.id },
          workflow: { stages: { prior: { artifacts: [{ path: historicalPpt }] } } },
        }),
        terminalVerification: { status: 'verified', strategy: 'measured', reason: 'durable state' },
        capability: {
          capabilityId: 'design.project.status', lane: 'industry', operation: 'observe', risk: 'low',
          sideEffects: [{ type: 'none', scope: 'project state', reversible: true }],
          verification: { strategy: 'measured', required: true, requiredFields: [], successSignals: [], limitations: [] },
        },
      } as any;

      const recorded = recordIndustryWorkflowExecution({
        ...scope,
        taskId: presentation.task.id,
        resultText: 'Visualization is not complete, so no presentation was generated.',
        toolRecords: [statusRecord],
      });

      expect(recorded.archivedFilePaths).toEqual([]);
      expect(recorded.task.status).toBe('blocked');
      expect(recorded.task.artifacts.some(artifact => artifact.path === historicalPpt)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes the verified professional brief back to the durable project facts', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_brief_sync_${suffix}`;
    const scopeId = personalInteriorProjectScope(userId);
    const project = createInteriorProject(scopeId, userId, {
      name: 'Brief sync project',
      brief: { area: '96 m2', constraints: 'Measured shell: 9600 x 10000 mm' },
    });
    setActiveInteriorProject(scopeId, userId, project.id);
    const scope = { userId, domain: 'personal' as const, orgId: '' };
    const started = startIndustryWorkflow({ ...scope, entryId: 'project', source: 'chat' });
    const toolRecords = stageToolRecords('project', started);
    toolRecords[0].result = JSON.stringify({
      grossArea: '96 m2 measured shell',
      occupants: 'Three-person household',
      budget: 'CNY 350,000',
      priorities: ['modern natural style', 'south daylight'],
      requiredSpaces: ['three bedrooms', 'connected living and dining'],
      existingConstraints: 'Measured shell: 9600 x 10000 mm; height 2800 mm',
      decisions: ['verify structure and MEP before drawing'],
    });

    const recorded = recordIndustryWorkflowExecution({
      ...scope,
      taskId: started.task.id,
      resultText: stageResult('project'),
      toolRecords,
    });

    expect(recorded.verification.passed).toBe(true);
    const updated = getActiveInteriorProject(scopeId, userId)!;
    expect(updated.brief.occupants).toBe('Three-person household');
    expect(updated.brief.budget).toBe('CNY 350,000');
    expect(updated.brief.style).toContain('modern natural style');
    expect(updated.brief.requirements).toContain('three bedrooms');
    expect(updated.brief.constraints).toContain('height 2800 mm');

    updateInteriorProject(scopeId, project.id, {
      brief: { occupants: '', budget: '', style: '', requirements: '', constraints: '' },
    });
    const registry = new ToolRegistry();
    registerIndustryWorkflowTools(registry);
    const status = JSON.parse(await registry.execute('interior_design_project_status', {
      projectId: project.id,
    }, { userId, domain: 'personal', orgId: '' } as any));
    expect(status.project.brief.occupants).toBe('');
    expect(status.project.brief.budget).toBe('');
    expect(status.project.brief.constraints).toBe(''); // A read-only status query must not overwrite a user's later edits.
  });

  it('never reuses a verified completion receipt from another workflow task', () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_cross_receipt_${suffix}`;
    const scopeId = personalInteriorProjectScope(userId);
    const project = createInteriorProject(scopeId, userId, { name: 'Receipt isolation project' });
    setActiveInteriorProject(scopeId, userId, project.id);
    const scope = { userId, domain: 'personal' as const, orgId: '' };
    const started = startIndustryWorkflow({ ...scope, entryId: 'project', source: 'chat' });
    const delivered = recordIndustryWorkflowExecution({
      ...scope,
      taskId: started.task.id,
      resultText: stageResult('project'),
      toolRecords: stageToolRecords('project', started),
    });
    expect(delivered.verification.passed).toBe(true);

    const foreignReceipt: any = {
      id: 'foreign-completion',
      name: 'industry_workflow_complete',
      arguments: { taskId: 'wt_task_foreign' },
      result: JSON.stringify({
        ok: true, status: 'verified', persisted: true,
        task: { id: 'wt_task_foreign' }, verification: { passed: true },
      }),
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'foreign receipt' },
    };
    expect(() => recordIndustryWorkflowExecution({
      ...scope, taskId: started.task.id, resultText: stageResult('project'), toolRecords: [foreignReceipt],
    })).toThrow(/delivered workflow is immutable/i);
  });

  it('rejects required domain receipts copied from workflow A into workflow B', () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_cross_required_${suffix}`;
    const scopeId = personalInteriorProjectScope(userId);
    const project = createInteriorProject(scopeId, userId, { name: 'Required receipt isolation project' });
    setActiveInteriorProject(scopeId, userId, project.id);
    const scope = { userId, domain: 'personal' as const, orgId: '' };
    const startedA = startIndustryWorkflow({
      ...scope,
      entryId: 'project',
      source: 'chat',
      requestId: `request_a_${suffix}`,
    });
    const recordsA = stageToolRecords('project', startedA);
    const deliveredA = recordIndustryWorkflowExecution({
      ...scope,
      taskId: startedA.task.id,
      resultText: stageResult('project'),
      toolRecords: recordsA,
    });
    expect(deliveredA.verification.passed).toBe(true);

    const startedB = startIndustryWorkflow({
      ...scope,
      entryId: 'project',
      source: 'chat',
      requestId: `request_b_${suffix}`,
    });
    expect(startedB.task.id).not.toBe(startedA.task.id);
    const rejectedB = recordIndustryWorkflowExecution({
      ...scope,
      taskId: startedB.task.id,
      resultText: stageResult('project'),
      toolRecords: recordsA,
    });

    expect(rejectedB.verification.passed).toBe(false);
    expect(rejectedB.task.status).not.toBe('delivered');
    expect(rejectedB.verification.summary).toMatch(/Missing verified required capability receipts/i);
  });

  it('makes an exact receipt replay idempotent and rejects a conflicting reuse of the same id', () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `design_receipt_replay_${suffix}`;
    const scopeId = personalInteriorProjectScope(userId);
    const project = createInteriorProject(scopeId, userId, { name: 'Receipt replay project' });
    setActiveInteriorProject(scopeId, userId, project.id);
    const scope = { userId, domain: 'personal' as const, orgId: '' };
    const started = startIndustryWorkflow({
      ...scope,
      entryId: 'project',
      source: 'chat',
      requestId: `request_replay_${suffix}`,
    });
    const toolRecords = stageToolRecords('project', started);
    const submission = {
      ...scope,
      taskId: started.task.id,
      resultText: stageResult('project'),
      toolRecords,
    };
    const first = recordIndustryWorkflowExecution(submission);
    expect(first.verification.passed).toBe(true);
    const trackedActionTaskIds = new Set([
      started.conversationTaskId,
      `design_project_${project.id}`,
    ]);
    const actionReceiptCount = (readDB().conversationActionReceipts || [])
      .filter((receipt: any) => trackedActionTaskIds.has(receipt.taskId)).length;
    const toolRunCount = (first.task.metadata.workTakeoverToolRuns || []).length;
    const artifactCount = first.task.artifacts.length;

    const replayed = recordIndustryWorkflowExecution(submission);
    expect(replayed.verification.verificationId).toBe(first.verification.verificationId);
    expect(replayed.task.metadata.workTakeoverToolRuns).toHaveLength(toolRunCount);
    expect(replayed.task.artifacts).toHaveLength(artifactCount);
    expect((readDB().conversationActionReceipts || [])
      .filter((receipt: any) => trackedActionTaskIds.has(receipt.taskId))).toHaveLength(actionReceiptCount);

    const conflictingRecords = toolRecords.map(record => ({ ...record }));
    conflictingRecords[0] = {
      ...conflictingRecords[0],
      result: JSON.stringify({ ok: true, status: 'verified', taskId: started.task.id, changed: true }),
    };
    expect(() => recordIndustryWorkflowExecution({ ...submission, toolRecords: conflictingRecords }))
      .toThrow(/conflicting industry tool receipt reused an existing record id/i);
    expect((readDB().conversationActionReceipts || [])
      .filter((receipt: any) => trackedActionTaskIds.has(receipt.taskId))).toHaveLength(actionReceiptCount);
  });

  it('routes spoken project creation to the durable project tool before stage execution', () => {
    const command = '\u65b0\u5efa\u4e00\u4e2a\u5ba4\u5185\u8bbe\u8ba1\u9879\u76ee';
    expect(isDesignProjectCreationRequest(command)).toBe(true);
    expect(formatIndustryCapabilityProfilePrompt(command)).toContain('interior_design_project_create');
    const routing = formatIndustryWorkflowRoutingPrompt(command);
    expect(routing).toContain('interior_design_project_create');
    expect(routing).not.toContain('industry_workflow_start(entryId=');

    const registry = new ToolRegistry();
    registerAllTools(registry);
    for (const channel of ['voice', 'chat'] as const) {
      const pipeline = buildLumiExecutionPipeline({
        dispatch: {
          userId: `design_project_create_${channel}`,
          text: command,
          channel,
          source: channel,
          operationMode: 'chat',
          targetIsLumi: true,
        },
        registry,
        source: channel,
      });
      expect(pipeline.turnIntent.flow.industryWorkflowEntryId).toBe('project');
      expect(pipeline.execution.toolPolicy.allowedTools).toContain('interior_design_project_create');
      expect(pipeline.execution.promptOverlay).toContain('interior_design_project_create');
    }
  });

  it('routes a natural project-name progress question to the aggregate project ledger', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    for (const channel of ['voice', 'chat'] as const) {
      const pipeline = buildLumiExecutionPipeline({
        dispatch: {
          userId: `design_project_status_${channel}`,
          text: '澄境样板间现在进行到哪一步？',
          channel,
          source: channel,
          operationMode: 'chat',
          targetIsLumi: true,
        },
        registry,
        source: channel,
      });
      expect(pipeline.execution.toolPolicy.allowedTools).toEqual(['interior_design_project_status']);
    }
  });

  it('routes a named-project facts-and-progress question identically in voice and chat', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    for (const channel of ['voice', 'chat'] as const) {
      const pipeline = buildLumiExecutionPipeline({
        dispatch: {
          userId: `design_project_facts_${channel}`,
          text: '矩衡验收户型A现在的项目事实和进度是什么？',
          channel,
          source: channel,
          operationMode: 'chat',
          targetIsLumi: true,
        },
        registry,
        source: channel,
      });
      expect(pipeline.execution.toolPolicy.allowedTools).toEqual(['interior_design_project_status']);
    }
  });

  it('does not misroute a named-project stage command as a status-only query', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    for (const channel of ['voice', 'chat'] as const) {
      const pipeline = buildLumiExecutionPipeline({
        dispatch: {
          userId: `design_project_visualization_${channel}`,
          text: '矩衡验收户型A进入效果图阶段，先读取项目事实再开始生成。',
          channel,
          source: channel,
          operationMode: 'chat',
          targetIsLumi: true,
        },
        registry,
        source: channel,
      });
      expect(pipeline.execution.toolPolicy.allowedTools).toContain('industry_workflow_start');
      expect(pipeline.execution.toolPolicy.allowedTools).not.toEqual(['interior_design_project_status']);
    }
  });
});
