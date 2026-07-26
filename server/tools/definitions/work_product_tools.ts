import { createWorkProductPlan, getWorkProductPlan, verifyWorkProduct } from '../../work_product/supervisor';
import { getLumiPersonalityConstitution } from '../../personality/constitution';
import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

export function registerWorkProductTools(registry: ToolRegistry): void {
  registry.register({
    name: 'lumi_constitution',
    description: 'Read Lumi Personality Constitution: stable identity, truth-about-work, owner sovereignty, memory/privacy firewall, action boundaries, work product supervision, self-extension consent, growth stability, and collaboration rules.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => JSON.stringify(getLumiPersonalityConstitution(), null, 2),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'work_product_plan',
    description: 'Create a work product supervision plan before real work: define the deliverable, acceptance criteria, checkpoints, verification actions, repair loop, and stop conditions. Use this for tasks that should produce a file, report, drawing, code change, client action, research result, meeting report, or other concrete deliverable.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'User task or work request.' },
        deliverableType: {
          type: 'string',
          enum: ['document', 'drawing', 'code', 'design', 'music', 'meeting_report', 'client_action', 'research', 'data', 'general'],
          description: 'Optional deliverable type. If omitted, Lumi infers it.',
        },
        finalOutput: { type: 'string', description: 'Optional description of the expected final output.' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Optional explicit acceptance criteria.' },
        expectedArtifacts: {
          type: 'array',
          description: 'Optional expected artifacts, e.g. [{path,label,kind,minBytes,requiredText}].',
          items: { type: 'object' },
        },
        maxRepairCycles: { type: 'number', description: 'Maximum repair/verification cycles before reporting blocked. Defaults to 3.' },
        persist: { type: 'boolean', description: 'Persist this plan for later verification. Defaults to true.' },
      },
      required: ['task'],
    },
    handler: async (args, context) => {
      const userId = context?.userId || 'anonymous';
      const shouldPersist = args.persist !== false;
      const plan = createWorkProductPlan({
        userId,
        task: String(args.task || ''),
        deliverableType: args.deliverableType,
        finalOutput: args.finalOutput,
        acceptanceCriteria: args.acceptanceCriteria,
        expectedArtifacts: args.expectedArtifacts,
        maxRepairCycles: args.maxRepairCycles,
        persist: shouldPersist,
      });
      const persistedPlan = shouldPersist ? getWorkProductPlan(userId, plan.id) : null;
      if (shouldPersist && !persistedPlan) {
        throw new Error('Work product plan was not persisted.');
      }
      return JSON.stringify({
        ok: true,
        status: shouldPersist ? 'persisted' : 'planned',
        persisted: Boolean(persistedPlan),
        ...plan,
        plan: persistedPlan || plan,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'work-product.plan.create',
      family: 'work-product',
      lane: 'general',
      operation: 'create',
      risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'work-product supervision plan', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'plan.id', 'plan.acceptanceCriteria', 'plan.verificationActions'],
        requiredValues: { ok: true },
        successStatuses: ['planned', 'persisted'],
        failureStatuses: ['failed', 'unverified'],
        successSignals: ['plan contains acceptance criteria, verification actions, and stop conditions', 'persisted plans are reread by id'],
        limitations: ['Creating a plan is not evidence that any work step or deliverable is complete.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'work-product.plan.create',
      operation: 'create',
      subjectArgument: 'task',
      limitations: ['The plan supervises later work but does not execute it.'],
    }),
  });

  registry.register({
    name: 'work_product_verify',
    description: 'Verify a work product against a plan or acceptance criteria. Checks artifact paths, file size/readability, required text, and returns pass/partial/fail/blocked plus repair actions. Call this before claiming a real task is complete, and call it again after repairs.',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Optional plan id returned by work_product_plan.' },
        task: { type: 'string', description: 'Task text, required if planId is not provided.' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Optional acceptance criteria override.' },
        artifacts: {
          type: 'array',
          description: 'Artifacts to verify, e.g. [{path,label,kind,expectedExists,minBytes,requiredText}].',
          items: { type: 'object' },
        },
        completedCriteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Acceptance criteria that Lumi has explicitly satisfied through prior tool results, final text, or domain checks.',
        },
        repairCycle: { type: 'number', description: 'Current repair cycle number, starting at 0.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const report = verifyWorkProduct({
        userId: context?.userId || 'anonymous',
        planId: args.planId,
        task: args.task,
        acceptanceCriteria: args.acceptanceCriteria,
        artifacts: args.artifacts,
        completedCriteria: args.completedCriteria,
        repairCycle: args.repairCycle,
      });
      return JSON.stringify(report, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });
}
