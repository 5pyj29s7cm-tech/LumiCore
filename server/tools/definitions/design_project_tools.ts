import crypto from 'node:crypto';
import { captureOrganizationMembershipAuthorization, isOrganizationMembershipAuthorizationCurrent } from '../../org/membership_authorization';
import { runDurableInteriorProjectMutation } from '../../design/durable_routes';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import type { ToolContext } from '../types';
import {
  createInteriorProject,
  getActiveInteriorProject,
  getInteriorProject,
  listInteriorProjects,
  personalInteriorProjectScope,
  setActiveInteriorProject,
} from '../../design/projects';
import { getInteriorProjectWorkflow } from '../../design/project_workflow';
import { getGeneratedOutputDir } from '../../config/data_path';

// i18n-allow: The multilingual routing hints below are internal tool-selection
// aliases for Chinese industry requests; they are never rendered as UI copy.

function scope(context?: ToolContext) {
  return {
    userId: context?.userId || 'anonymous',
    domain: context?.domain === 'work' ? 'work' as const : 'personal' as const,
    orgId: context?.domain === 'work' ? String(context?.orgId || '') : '',
  };
}

function designScope(context?: ToolContext): { scopeId: string; userId: string } {
  const active = scope(context);
  if (active.userId === 'anonymous') throw new Error('Authenticated design identity is required.');
  if (active.domain === 'work') captureOrganizationMembershipAuthorization(active.orgId, active.userId);
  const scopeId = active.domain === 'work' ? active.orgId : personalInteriorProjectScope(active.userId);
  if (!scopeId) throw new Error('Organization scope is required for organization design projects.');
  return { scopeId, userId: active.userId };
}

function findDesignProject(args: Record<string, any>, context?: ToolContext) {
  const active = designScope(context);
  const projectId = String(args.projectId || '').trim();
  if (projectId) return { ...active, project: getInteriorProject(active.scopeId, projectId) };
  const projects = listInteriorProjects(active.scopeId);
  const routedText = String(context?.routedTaskText || '');
  const routedMatch = projects.find(project => routedText.includes(project.name));
  if (routedMatch) return { ...active, project: routedMatch };
  const name = String(args.name || '').trim().toLocaleLowerCase();
  if (name) {
    const matches = projects.filter(project => project.name.toLocaleLowerCase() === name);
    if (matches.length > 1) throw new Error('More than one design project has that name; use projectId.');
    return { ...active, project: matches[0] || null };
  }
  const selected = getActiveInteriorProject(active.scopeId, active.userId);
  if (selected) return { ...active, project: selected };
  const owned = projects.filter(project => project.ownerUserId === active.userId);
  return { ...active, project: owned.length === 1 ? owned[0] : null };
}

function designMutationAuthority(context?: ToolContext) {
  const active = designScope(context);
  const accepted = scope(context);
  const membership = accepted.domain === 'work'
    ? captureOrganizationMembershipAuthorization(accepted.orgId, accepted.userId) : undefined;
  const assertCurrent = () => {
    context?.executionSignal?.throwIfAborted();
    if (context?.isCancelled?.()) throw new Error('Design project mutation was cancelled.');
    const current = designScope(context);
    if (current.scopeId !== active.scopeId || current.userId !== active.userId
      || membership && !isOrganizationMembershipAuthorizationCurrent(membership, accepted.orgId, accepted.userId)) {
      throw new Error('The accepted design project authority is no longer current.');
    }
  };
  return { active, assertCurrent };
}

function projectStatusProjection(workflow: NonNullable<ReturnType<typeof getInteriorProjectWorkflow>>) {
  const stages = Object.fromEntries(Object.entries(workflow.stages).map(([entryId, stage]) => [
    entryId,
    {
      entryId: stage.entryId,
      status: stage.status,
      currentTaskId: stage.currentTaskId,
      verificationId: stage.verificationId,
      verificationStatus: stage.verificationStatus,
      blocker: stage.blocker,
      attempts: stage.attempts,
      startedAt: stage.startedAt,
      updatedAt: stage.updatedAt,
      completedAt: stage.completedAt,
      artifacts: stage.artifacts
        .filter(artifact => Boolean(artifact.path) || artifact.status === 'delivered')
        .slice(-8),
    },
  ]));
  const ordered = ['project', 'cad', 'visualization', 'presentation', 'handoff'];
  const completedStages = ordered.filter(entryId => (stages as any)[entryId]?.status === 'completed');
  const nextStage = ordered.find(entryId => (stages as any)[entryId]?.status !== 'completed') || '';
  return {
    schemaVersion: workflow.schemaVersion,
    rootTaskId: workflow.rootTaskId,
    activeStage: workflow.activeStage,
    completedStages,
    nextStage,
    stages,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

function safeDeliveryName(value: unknown): string {
  return String(value || 'interior-design')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 90) || 'interior-design';
}

async function createDesignDeliveryPackage(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const resolved = findDesignProject(args, context);
  if (!resolved.project) throw new Error('No active design project is bound. Create or select a project first.');
  const workflow = getInteriorProjectWorkflow(resolved.scopeId, resolved.project.id);
  if (!workflow) throw new Error('The active design project has no durable workflow ledger.');
  const requiredStages = ['project', 'cad', 'visualization', 'presentation'] as const;
  const missingStages = requiredStages.filter(entryId => workflow.stages[entryId].status !== 'completed');
  if (missingStages.length) {
    throw new Error(`Delivery package is blocked until verified upstream stages complete: ${missingStages.join(', ')}.`);
  }

  const zip = new JSZip();
  const included: Array<{ stage: string; label: string; fileName: string; size: number }> = [];
  const seen = new Set<string>();
  for (const entryId of requiredStages) {
    for (const artifact of workflow.stages[entryId].artifacts) {
      const filePath = String(artifact.path || '').trim();
      if (!filePath || seen.has(filePath) || !fs.existsSync(filePath)) continue;
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size < 1) continue;
      seen.add(filePath);
      const fileName = path.basename(filePath);
      zip.file(`${entryId}/${fileName}`, fs.readFileSync(filePath));
      included.push({ stage: entryId, label: artifact.label, fileName, size: stat.size });
    }
  }
  if (!included.length) throw new Error('No verified upstream files are available for the delivery package.');

  const version = String(args.version || 'v1').trim().slice(0, 40) || 'v1';
  const manifest = {
    schemaVersion: 1,
    project: { id: resolved.project.id, name: resolved.project.name, type: resolved.project.projectType },
    version,
    createdAt: new Date().toISOString(),
    scope: 'Local review package; external delivery and professional sign-off are not implied.',
    checklist: requiredStages.map(entryId => ({
      stage: entryId,
      status: workflow.stages[entryId].status,
      verificationId: workflow.stages[entryId].verificationId,
      artifacts: included.filter(item => item.stage === entryId),
    })),
    drawingCount: included.filter(item => item.stage === 'cad').length,
    schedule: 'Review drawing, visualization, presentation, version, and client-facing claims before handoff.',
    handoff: { externallyDelivered: false, approvalRequired: true },
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const outputDir = getGeneratedOutputDir();
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${safeDeliveryName(resolved.project.name)}_${safeDeliveryName(version)}_${crypto.randomUUID()}_delivery.zip`);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  context?.executionSignal?.throwIfAborted();
  if (context?.isCancelled?.()) throw new Error('Design package creation was cancelled before writing.');
  designScope(context); // Re-check current membership after asynchronous ZIP generation.
  fs.writeFileSync(outputPath, buffer);
  const size = fs.statSync(outputPath).size;
  if (size < 16) throw new Error('Delivery archive writer returned an empty package.');
  return JSON.stringify({
    ok: true,
    status: 'created',
    outputPath,
    size,
    projectId: resolved.project.id,
    projectName: resolved.project.name,
    version,
    includedFiles: included,
    manifest,
  }, null, 2);
}

export function registerDesignProjectTools(registry: ToolRegistry): void {
  registry.register({
    name: 'interior_design_project_create',
    description: 'Create and activate one durable interior design project before CAD, visualization, proposal, and handoff work. Use this for a new project, not industry_workflow_start alone.',
    // i18n-allow: Reviewed Chinese input-recognition aliases; not rendered as UI copy.
    routingHints: ['new interior design project', 'create design project', '新建室内设计项目', '创建设计项目', '新建设计项目'],
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name. Ask the user when it is missing.' },
        projectType: { type: 'string', enum: ['residential', 'office', 'retail', 'hospitality', 'other'] },
        location: { type: 'string' },
        area: { type: 'string' },
        occupants: { type: 'string' },
        budget: { type: 'string' },
        style: { type: 'string' },
        requirements: { type: 'string' },
        constraints: { type: 'string' },
      },
      required: ['name'],
    },
    handler: async (args, context) => {
      const { active, assertCurrent } = designMutationAuthority(context);
      return runDurableInteriorProjectMutation(active.scopeId, active.userId, assertCurrent, () => {
      const project = createInteriorProject(active.scopeId, active.userId, {
        name: args.name,
        projectType: args.projectType || 'other',
        brief: {
          location: args.location || '',
          area: args.area || '',
          occupants: args.occupants || '',
          budget: args.budget || '',
          style: args.style || '',
          requirements: args.requirements || '',
          constraints: args.constraints || '',
        },
      });
      setActiveInteriorProject(active.scopeId, active.userId, project.id);
      return JSON.stringify({
        ok: true,
        status: 'created',
        persisted: true,
        active: true,
        project,
        workflow: getInteriorProjectWorkflow(active.scopeId, project.id),
      }, null, 2);
      });
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'design.project.create', family: 'industry', lane: 'industry', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'interior design project and active project binding', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'persisted', 'active', 'project.id', 'project.name'],
        requiredValues: { ok: true, persisted: true, active: true }, successStatuses: ['created'],
        successSignals: ['durable scoped project returned'],
        limitations: ['Creates the project container; it does not complete any design deliverable.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'design.project.create', operation: 'create', subjectArgument: 'name', limitations: ['Later stage receipts are required.'] }),
  });

  registry.register({
    name: 'interior_design_project_select',
    description: 'Select the active durable design project by exact id or exact name so later voice/chat workflow commands inherit the same project.',
    // i18n-allow: Reviewed Chinese input-recognition aliases; not rendered as UI copy.
    routingHints: ['select design project', 'switch design project', '选择设计项目', '切换设计项目', '打开这个项目'],
    parameters: {
      type: 'object',
      properties: { projectId: { type: 'string' }, name: { type: 'string' } },
      required: [],
    },
    handler: async (args, context) => {
      const { active, assertCurrent } = designMutationAuthority(context);
      return runDurableInteriorProjectMutation(active.scopeId, active.userId, assertCurrent, () => {
      const resolved = findDesignProject(args, context);
      if (!resolved.project) throw new Error('Design project not found. Provide an exact project id or name.');
      const project = setActiveInteriorProject(resolved.scopeId, resolved.userId, resolved.project.id);
      return JSON.stringify({
        ok: true, status: 'selected', persisted: true, active: true, project,
        workflow: getInteriorProjectWorkflow(resolved.scopeId, resolved.project.id),
      }, null, 2);
      });
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'design.project.select', family: 'industry', lane: 'industry', operation: 'mutate', risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'active design project binding', reversible: true }],
      verification: {
        strategy: 'state_diff', required: true,
        requiredFields: ['ok', 'status', 'persisted', 'active', 'project.id'],
        requiredValues: { ok: true, persisted: true, active: true }, successStatuses: ['selected'],
        successSignals: ['server-owned active project binding updated'],
        limitations: ['Does not execute a design stage.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'design.project.select', operation: 'mutate', subjectArgument: 'projectId', limitations: ['Only changes the current project context.'] }),
  });

  registry.register({
    name: 'interior_design_project_status',
    description: 'Read the active design project and its durable project/CAD/visualization/presentation/handoff task, receipt, artifact, blocker, and completion state.',
    // i18n-allow: Reviewed Chinese input-recognition aliases; not rendered as UI copy.
    routingHints: ['design project status', 'project delivery progress', '设计项目进度', '项目做到哪了', 'CAD效果图PPT进度'],
    parameters: {
      type: 'object',
      properties: { projectId: { type: 'string' }, name: { type: 'string' } },
      required: [],
    },
    handler: async (args, context) => {
      const resolved = findDesignProject(args, context);
      if (!resolved.project) throw new Error('No active design project is bound. Create or select a project first.');
      const workflow = getInteriorProjectWorkflow(resolved.scopeId, resolved.project.id);
      if (!workflow) throw new Error('The active design project has no durable workflow ledger.');
      const reconciled = resolved.project;
      const { workflow: _omittedWorkflow, ...project } = reconciled;
      return JSON.stringify({
        ok: true, status: 'observed', persisted: true, project,
        workflow: projectStatusProjection(workflow),
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'design.project.status', family: 'industry', lane: 'industry', operation: 'observe', risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'design project workflow state', reversible: true }],
      verification: {
        strategy: 'measured', required: true,
        requiredFields: ['ok', 'status', 'persisted', 'project.id', 'workflow.stages'],
        requiredValues: { ok: true, persisted: true }, successStatuses: ['observed'],
        successSignals: ['durable project workflow state returned'],
        limitations: ['Reports persisted receipts and blockers; it does not infer unrecorded progress.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'design.project.status', operation: 'observe', subjectArgument: 'projectId', limitations: ['Read-only status query.'] }),
  });

  registry.register({
    name: 'design_delivery_package_create',
    description: 'Create a local ZIP handoff package for the active interior project from verified upstream CAD, visualization, and presentation artifacts. Refuses to package incomplete stages and never sends the archive externally.',
    // i18n-allow: exact multilingual input routing aliases, not displayed copy.
    routingHints: ['create design delivery package', 'package verified project files', '生成交付包', '打包项目交付文件'],
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Optional exact project id; defaults to the active project.' },
        name: { type: 'string', description: 'Optional exact project name.' },
        version: { type: 'string', description: 'Local package version, for example v1 or review-2026-08-16.' },
      },
      required: [],
    },
    handler: createDesignDeliveryPackage,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'design.delivery.package.create', family: 'industry', lane: 'industry', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_write', scope: 'verified interior design delivery ZIP', reversible: true }],
      verification: {
        strategy: 'artifact', required: true,
        requiredFields: ['ok', 'status', 'outputPath', 'size', 'projectId', 'version', 'manifest.checklist'],
        requiredValues: { ok: true, status: 'created' }, successStatuses: ['created'],
        requiredArtifacts: ['outputPath'],
        successSignals: ['non-empty archive contains a manifest and verified upstream project files'],
        limitations: ['Archive creation is not professional sign-off, client acceptance, or external delivery.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'design.delivery.package.create', operation: 'create', subjectArgument: 'projectId',
      limitations: ['Creates a local review package only; sending remains a separate confirmed action.'],
    }),
  });
}
