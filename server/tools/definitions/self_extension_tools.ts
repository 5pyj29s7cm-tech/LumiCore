import { buildSelfExtensionPlan } from '../../self_extension/pipeline';
import { runCapabilityGapAutofix } from '../../self_extension/autofix';
import { listCapabilityLearningRecords, summarizeCapabilityRecord } from '../../self_extension/capability_memory';
import { getClientStateForScope } from '../../client/self_model';
import { ToolRegistry } from '../registry';
import { executeToolCallOrThrow } from '../execution_engine';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

export function registerSelfExtensionTools(registry: ToolRegistry): void {
  registry.register({
    name: 'self_extension_plan',
    description: [
      'Plan how Lumi should extend itself when a requested capability appears missing or incomplete.',
      'This inspects the client adapter registry, installed skills, marketplace skills, and current tool registry.',
      'It returns whether Lumi should use existing tools, repair/install a skill, research an adapter, generate a skill draft, or escalate to core code work.',
      'This tool does not install, generate, execute third-party code, or modify Lumi core by itself.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The missing or desired capability, e.g. "summarize today model usage", "control Revit", or "reply to Feishu messages".',
        },
        domain: {
          type: 'string',
          description: 'Optional domain hint, e.g. usage_monitoring, client_control, cad_bim, messaging, legal, design, finance, music, files.',
        },
      },
      required: ['goal'],
    },
    handler: async (args, context) => {
      const userId = context?.userId || 'anonymous';
      const plan = buildSelfExtensionPlan({
        userId,
        scopeDomain: context?.domain === 'work' && context?.orgId ? 'work' : 'personal',
        orgId: context?.domain === 'work' ? context?.orgId : '',
        goal: String(args.goal || ''),
        domain: args.domain ? String(args.domain) : undefined,
        clientState: getClientStateForScope(userId, { domain: context?.domain, orgId: context?.orgId }) as Record<string, any> | null,
        tools: registry.list(),
      });
      return JSON.stringify({
        ok: true,
        status: 'planned',
        ...plan,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'self-extension.plan',
      family: 'self-extension',
      lane: 'system',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'none', scope: 'read-only capability planning', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'goal', 'readiness', 'resolution.decision'],
        requiredValues: { ok: true, status: 'planned' },
        successStatuses: ['planned'],
        failureStatuses: ['failed'],
        successSignals: ['plan reports current coverage and a bounded next route'],
        limitations: ['Planning does not install, execute, or prove a new capability.'],
      },
    },
    evidence: capabilityEvidence({
      id: 'self-extension.plan',
      operation: 'observe',
      subjectArgument: 'goal',
      limitations: ['The returned plan is advisory and does not mutate the runtime.'],
    }),
  });

  registry.register({
    name: 'capability_gap_autofix',
    description: [
      'Turn a missing or weak Lumi capability into a reusable learned route.',
      'It first reuses existing learned routes, tools, adapters, and skills when they already cover the request.',
      'Only when coverage is absent or failure evidence shows the current path is brittle, it selects the best interface pattern, prepares or runs a minimal verification experiment when safe, persists one reusable route into Lumi capability memory, and returns the next-use rule.',
      'Use this when Lumi notices it is falling back to brittle scripts, raw mouse control, or repeated manual coding for an external software/workflow.',
      'External execution, third-party install, messaging, publishing, payments, and core code changes remain confirmation-gated.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Capability gap to fix, e.g. "AutoCAD should draw stroke by stroke through MCP/COM instead of mouse or generated-file fallback".' },
        domain: { type: 'string', description: 'Optional domain hint, e.g. cad_bim, messaging, design, browser, client_control.' },
        context: { type: 'string', description: 'Optional task context or user expectation.' },
        observedFailure: { type: 'string', description: 'What went wrong or felt too manual/scripted.' },
        outputDirectory: { type: 'string', description: 'Optional folder for generated minimal experiment artifacts.' },
        allowExternalExecution: { type: 'boolean', description: 'Allow the minimal experiment to launch/control external software. Defaults false.' },
        allowResearch: { type: 'boolean', description: 'Allow research-needed status and research suggestions. Defaults true.' },
        allowSkillDraft: { type: 'boolean', description: 'Reserved for future auto skill draft generation; defaults false.' },
        record: { type: 'boolean', description: 'Persist the learned route to Lumi capability memory. Defaults true.' },
      },
      required: ['goal'],
    },
    handler: async (args, context) => {
      const userId = context?.userId || 'anonymous';
      const result = await runCapabilityGapAutofix({
        userId,
        scopeDomain: context?.domain === 'work' && context?.orgId ? 'work' : 'personal',
        orgId: context?.domain === 'work' ? context?.orgId : '',
        goal: String(args.goal || ''),
        domain: args.domain ? String(args.domain) : undefined,
        context: args.context ? String(args.context) : undefined,
        observedFailure: args.observedFailure ? String(args.observedFailure) : undefined,
        outputDirectory: args.outputDirectory ? String(args.outputDirectory) : undefined,
        allowExternalExecution: args.allowExternalExecution === true,
        allowResearch: args.allowResearch !== false,
        allowSkillDraft: args.allowSkillDraft === true,
        record: args.record !== false,
        clientState: getClientStateForScope(userId, { domain: context?.domain, orgId: context?.orgId }) as Record<string, any> | null,
        tools: registry.list(),
        executeTool: (name, toolArgs) => executeToolCallOrThrow({
          registry,
          name,
          arguments: toolArgs,
          context,
        }),
      });
      const shouldPersist = args.record !== false;
      let persisted = false;
      if (shouldPersist) {
        persisted = listCapabilityLearningRecords({
          userId,
          scopeDomain: context?.domain === 'work' && context?.orgId ? 'work' : 'personal',
          orgId: context?.domain === 'work' ? context?.orgId : '',
          limit: 250,
        }).some(record => record.id === result.record.id);
        if (!persisted && !result.reusedExistingCoverage) {
          throw new Error('Capability learning route was not persisted.');
        }
      }
      const status = result.experiment.status === 'blocked'
        ? 'blocked'
        : result.reusedExistingCoverage
          ? 'reused'
          : result.experiment.status === 'passed'
            ? 'experiment_passed'
            : result.experiment.status === 'prepared'
              ? 'experiment_prepared'
              : 'learned';
      return JSON.stringify({
        ok: status !== 'blocked',
        status,
        persisted,
        ...result,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'self-extension.capability-gap.autofix',
      family: 'self-extension',
      lane: 'system',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [
        { type: 'local_state_change', scope: 'capability learning memory', reversible: true },
        { type: 'desktop_control', scope: 'optional minimal external-app verification experiment', reversible: true },
        { type: 'process_execution', scope: 'optional capability verification adapter', reversible: true },
      ],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'selectedRoute.id', 'experiment.status', 'record.id'],
        requiredValues: { ok: true },
        successStatuses: ['reused', 'learned', 'experiment_prepared', 'experiment_passed'],
        failureStatuses: ['blocked', 'failed'],
        successSignals: ['existing route reused or a bounded capability route recorded', 'any minimal experiment reports its own terminal status'],
        limitations: ['A prepared experiment is not proof that the external capability works.', 'This capability never authorizes third-party installation or core-code mutation by itself.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'self-extension.capability-gap.autofix',
      operation: 'mutate',
      subjectArgument: 'goal',
      limitations: ['Only experiment_passed proves the selected external route was exercised successfully.'],
    }),
  });

  registry.register({
    name: 'capability_learning_list',
    description: 'List Lumi capability learning records created or updated by capability_gap_autofix. Use this before generating new skills or core code to see what routes Lumi has actually learned and what minimal experiments verified them.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Optional domain filter.' },
        goal: { type: 'string', description: 'Optional goal/query filter.' },
        status: { type: 'string', description: 'Optional learned/experiment_prepared/experiment_passed/needs_research/blocked filter.' },
        limit: { type: 'number', description: 'Maximum records to return. Defaults to 20.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const records = listCapabilityLearningRecords({
        userId: context?.userId || 'anonymous',
        scopeDomain: context?.domain === 'work' && context?.orgId ? 'work' : 'personal',
        orgId: context?.domain === 'work' ? context?.orgId : '',
        domain: args.domain ? String(args.domain) : undefined,
        goal: args.goal ? String(args.goal) : undefined,
        status: args.status ? String(args.status) as any : undefined,
        limit: args.limit,
      });
      return JSON.stringify({
        records,
        summaries: records.map(summarizeCapabilityRecord),
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });
}
