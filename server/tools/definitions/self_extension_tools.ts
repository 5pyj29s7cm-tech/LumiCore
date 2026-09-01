import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { buildSelfExtensionPlan } from '../../self_extension/pipeline';
import { runCapabilityGapAutofix } from '../../self_extension/autofix';
import { listCapabilityLearningRecords, summarizeCapabilityRecord } from '../../self_extension/capability_memory';
import {
  canUseQueuedSelfImprovementStageAuthorization,
  createSelfImprovementProposal,
  enqueueSelfImprovementProposal,
  getSelfImprovementProgram,
  getSelfImprovementProposal,
  listSelfImprovementProposals,
  recordSelfImprovementPatchReview,
  updateSelfImprovementProgram,
} from '../../self_extension/improvement_program';
import {
  activateSelfImprovementStage,
  replayVerifiedSelfImprovementStage,
  stageSelfImprovementPatch,
} from '../../self_extension/staging';
import {
  resolveTrustedSelfImprovementRepository,
  sameSelfImprovementRepository,
  selfImprovementGitArgs,
  selfImprovementGitEnvironment,
} from '../../self_extension/repository_identity';
import { getClientStateForScope } from '../../client/self_model';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { executeToolCallOrThrow } from '../execution_engine';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { containsSelfImprovementSecret } from '../../self_extension/content_security';

function selfImprovementScope(context?: ToolContext) {
  return {
    userId: context?.userId || 'anonymous',
    domain: context?.domain === 'work' ? 'work' as const : 'personal' as const,
    orgId: context?.domain === 'work' ? context?.orgId : '',
  };
}

function assertLocalSelfImprovementContext(context?: ToolContext): void {
  if (context?.localExecution !== true) {
    throw new Error('Self-improvement source operations are restricted to the authenticated local desktop administrator.');
  }
  if (context?.domain === 'work') {
    throw new Error('Host source self-improvement is available only in the local personal administrator workspace.');
  }
}

function assertInsideRepository(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('The reviewed self-improvement path escaped the repository root.');
  }
}

function inspectSelfImprovementScope(
  context: ToolContext | undefined,
  proposalId: string,
  reviewedPath: string,
  requestedOffset = 0,
  requestedBytes = 100_000,
) {
  assertLocalSelfImprovementContext(context);
  const scope = selfImprovementScope(context);
  const proposal = getSelfImprovementProposal(scope, proposalId);
  if (!proposal) throw new Error('Self-improvement proposal not found in this user scope.');
  if (context?.autonomous === true && !canUseQueuedSelfImprovementStageAuthorization(
    scope,
    proposal.id,
    String(context.taskId || ''),
  )) {
    throw new Error('Autonomous self-improvement inspection is not bound to this exact queued proposal and task.');
  }
  if (context?.autonomous === true && context.idempotencyKey !== `self-improvement:${proposal.id}:${proposal.programRevision}`) {
    throw new Error('Autonomous self-improvement inspection is not bound to the exact proposal idempotency key.');
  }
  if (!(proposal.changedPaths || []).includes(reviewedPath)) {
    throw new Error('Self-improvement scope inspection is limited to an exact path in the persisted proposal.');
  }
  const repository = resolveTrustedSelfImprovementRepository();
  if (!proposal.repositoryId || !proposal.repositoryRoot || !proposal.repositoryOrigin || !proposal.repositoryObjectFormat) {
    throw new Error('Self-improvement proposal has no trusted repository identity.');
  }
  if (!sameSelfImprovementRepository({
    repositoryId: proposal.repositoryId,
    root: proposal.repositoryRoot,
    origin: proposal.repositoryOrigin,
    objectFormat: proposal.repositoryObjectFormat,
  }, repository)) {
    throw new Error('Self-improvement repository identity no longer matches the persisted proposal.');
  }
  const repoRoot = repository.root;
  const absolute = path.resolve(repoRoot, ...reviewedPath.split('/'));
  assertInsideRepository(repoRoot, absolute);
  const gitOptions = {
    cwd: repoRoot, encoding: 'utf8' as const, windowsHide: true, timeout: 30_000,
    env: selfImprovementGitEnvironment(),
  };
  const baseCommit = execFileSync('git', selfImprovementGitArgs(['rev-parse', 'HEAD']), {
    ...gitOptions,
  }).trim();
  const deliveryBranch = execFileSync('git', selfImprovementGitArgs(['symbolic-ref', '--quiet', '--short', 'HEAD']), {
    ...gitOptions,
  }).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(baseCommit) || !deliveryBranch) {
    throw new Error('Self-improvement scope inspection requires a normal checked-out Git delivery branch.');
  }
  let contentBuffer = Buffer.alloc(0);
  let exists = true;
  try {
    const entry = execFileSync('git', selfImprovementGitArgs(['ls-tree', '-z', baseCommit, '--', reviewedPath]), {
      ...gitOptions, maxBuffer: 20_000,
    });
    if (!entry) throw Object.assign(new Error('path not present'), { status: 128 });
    const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t/.exec(entry);
    if (!match || match[1] !== '100644' || match[2] !== 'blob') {
      throw new Error('Reviewed autonomous documentation must be a regular 100644 Git blob.');
    }
    contentBuffer = execFileSync('git', selfImprovementGitArgs(['cat-file', 'blob', `${baseCommit}:${reviewedPath}`]), {
      cwd: repoRoot,
      encoding: null,
      windowsHide: true,
      timeout: 30_000,
      env: selfImprovementGitEnvironment(),
      maxBuffer: 1_100_000,
    }) as unknown as Buffer;
  } catch (error: any) {
    if (Number(error?.status) === 128 || /path not present/i.test(String(error?.message || ''))) exists = false;
    else throw error;
  }
  if (contentBuffer.length > 1_000_000) {
    throw new Error('A reviewed self-improvement source file exceeds the 1 MB static-document limit.');
  }
  const fullContent = contentBuffer.toString('utf8');
  if (contentBuffer.includes(0) || fullContent.includes('\uFFFD')) {
    throw new Error('The reviewed self-improvement source is not valid static UTF-8 text.');
  }
  if (containsSelfImprovementSecret(fullContent)) {
    throw new Error('The reviewed source appears to contain secret material; automatic model inspection was stopped.');
  }
  let contentByteOffset = Math.max(0, Math.min(contentBuffer.length, Math.floor(Number(requestedOffset) || 0)));
  while (contentByteOffset < contentBuffer.length && (contentBuffer[contentByteOffset] & 0xc0) === 0x80) {
    contentByteOffset += 1;
  }
  const maxBytes = Math.max(1_024, Math.min(100_000, Math.floor(Number(requestedBytes) || 100_000)));
  let contentByteEnd = Math.min(contentBuffer.length, contentByteOffset + maxBytes);
  while (contentByteEnd > contentByteOffset && contentByteEnd < contentBuffer.length
    && (contentBuffer[contentByteEnd] & 0xc0) === 0x80) {
    contentByteEnd -= 1;
  }
  const content = contentBuffer.subarray(contentByteOffset, contentByteEnd).toString('utf8');
  return {
    proposalId: proposal.id,
    programRevision: proposal.programRevision,
    verificationProfile: proposal.verificationProfile,
    repositoryId: repository.repositoryId,
    baseCommit,
    deliveryBranch,
    path: reviewedPath,
    exists,
    content,
    contentByteOffset,
    contentBytes: contentByteEnd - contentByteOffset,
    totalBytes: contentBuffer.length,
    complete: contentByteEnd >= contentBuffer.length,
    nextByteOffset: contentByteEnd < contentBuffer.length ? contentByteEnd : null,
  };
}

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
        tools: registry.listForContext(context),
        capabilityManifest: registry.getCapabilityManifest(undefined, { context }),
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
        tools: registry.listForContext(context),
        capabilityManifest: registry.getCapabilityManifest(undefined, { context }),
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

  registry.register({
    name: 'self_improvement_program_get',
    description: 'Read the durable self-improvement authorization for the current user scope. This distinguishes proposal-only, supervised, and bounded autonomous low-risk staging; activation and remote push are always separate.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args, context) => {
      assertLocalSelfImprovementContext(context);
      return JSON.stringify({
        ok: true,
        status: 'read',
        program: getSelfImprovementProgram(selfImprovementScope(context)),
      }, null, 2);
    },
    permission: 'admin',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'self-improvement.program.read',
      family: 'self-improvement',
      lane: 'system',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'none', scope: 'read-only self-improvement authorization', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'program.id', 'program.revision', 'program.mode', 'program.enabled'],
        requiredValues: { ok: true, status: 'read' },
        successStatuses: ['read'],
        successSignals: ['the persisted authorization is returned with its exact revision'],
        limitations: ['An enabled program is authorization, not evidence that any source change ran.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'self-improvement.program.read',
      operation: 'observe',
    }),
  });

  registry.register({
    name: 'self_improvement_program_update',
    description: 'Enable, disable, or narrow Lumi\'s durable self-improvement mandate after explicit user confirmation. It can authorize isolated local staging, but it can never authorize automatic push, deployment, secret access, or direct main-branch mutation.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Whether the durable program is enabled.' },
        mode: { type: 'string', enum: ['propose', 'supervised', 'autonomous_low_risk'] },
        allowedTargets: { type: 'array', items: { type: 'string', enum: ['core', 'variant'] } },
        allowedVariantIds: { type: 'array', items: { type: 'string' } },
        allowedPathPrefixes: { type: 'array', items: { type: 'string' }, description: 'Explicit repository-relative source/test/doc prefixes.' },
        verificationProfiles: { type: 'array', items: { type: 'string', enum: ['targeted', 'standard', 'full'] } },
        maxFilesPerChange: { type: 'number' },
        maxPatchBytes: { type: 'number' },
        allowLocalCommit: { type: 'boolean', description: 'Whether a verified isolated branch may receive a local commit. Push remains forbidden.' },
        expiresAt: { type: 'string', description: 'Optional ISO expiry timestamp.' },
        authorizationReason: { type: 'string', description: 'Required durable record of the user instruction when enabling.' },
      },
      required: ['authorizationReason'],
    },
    handler: async (args, context) => {
      assertLocalSelfImprovementContext(context);
      const scope = selfImprovementScope(context);
      const before = getSelfImprovementProgram(scope);
      const program = await updateSelfImprovementProgram(scope, args);
      const persisted = getSelfImprovementProgram(scope);
      if (persisted.revision !== program.revision || persisted.revision <= before.revision) {
        throw new Error('Self-improvement authorization was not durably persisted.');
      }
      return JSON.stringify({ ok: true, status: 'updated', persisted: true, program: persisted }, null, 2);
    },
    permission: 'admin',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'self-improvement.program.update',
      family: 'self-improvement',
      lane: 'system',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'durable self-improvement authorization', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'program.id', 'program.revision', 'program.allowPush'],
        requiredValues: { ok: true, status: 'updated', persisted: true, 'program.allowPush': false },
        successStatuses: ['updated'],
        successSignals: ['the persisted program revision increases and remote push remains disabled'],
        limitations: ['This changes authorization only; it neither edits source nor activates a change.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'self-improvement.program.update',
      operation: 'mutate',
      subjectArgument: 'authorizationReason',
    }),
  });

  registry.register({
    name: 'self_improvement_propose',
    description: 'Persist a bounded core or variant improvement proposal and evaluate it against the current durable mandate. Exact paths, risk, operations, budgets, and verification profile are required before autonomous staging can be authorized.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        target: { type: 'string', enum: ['core', 'variant'] },
        variantId: { type: 'string' },
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        operations: { type: 'array', items: { type: 'string', enum: ['code_change', 'test_change', 'documentation_change', 'dependency_change', 'data_migration', 'git_commit', 'git_push', 'deployment', 'external_communication'] } },
        changedPaths: { type: 'array', items: { type: 'string' } },
        estimatedFiles: { type: 'number' },
        estimatedPatchBytes: { type: 'number' },
        verificationProfile: { type: 'string', enum: ['targeted', 'standard', 'full'] },
      },
      required: ['goal', 'target', 'risk', 'operations'],
    },
    handler: async (args, context) => {
      assertLocalSelfImprovementContext(context);
      const proposal = await createSelfImprovementProposal(selfImprovementScope(context), args as any);
      return JSON.stringify({
        ok: proposal.status !== 'blocked',
        status: proposal.status,
        persisted: true,
        proposal,
      }, null, 2);
    },
    permission: 'admin',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'self-improvement.proposal.create',
      family: 'self-improvement',
      lane: 'system',
      operation: 'create',
      risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'self-improvement proposal ledger', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['status', 'persisted', 'proposal.id', 'proposal.evaluation.decision'],
        requiredValues: { persisted: true },
        successStatuses: ['proposed', 'review_required'],
        failureStatuses: ['blocked'],
        successSignals: ['the exact proposal and authorization revision are persisted'],
        limitations: ['A proposal is not a code change, test run, commit, activation, or push.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'self-improvement.proposal.create',
      operation: 'create',
      subjectArgument: 'goal',
    }),
  });

  registry.register({
    name: 'self_improvement_list',
    description: 'List persisted self-improvement proposals and their real authorization/execution state for the current user scope.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
    handler: async (args, context) => {
      assertLocalSelfImprovementContext(context);
      return JSON.stringify({
        ok: true,
        status: 'read',
        proposals: listSelfImprovementProposals(selfImprovementScope(context), args.limit),
      }, null, 2);
    },
    permission: 'admin',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'self_improvement_read_scope',
    description: 'Read one exact path from the persisted proposal at the current pinned Git commit. It cannot browse arbitrary paths and stops if secret-like content is detected.',
    parameters: {
      type: 'object',
      properties: {
        proposalId: { type: 'string' },
        path: { type: 'string', description: 'One exact path already persisted in the proposal changedPaths list.' },
        byteOffset: { type: 'number', description: 'UTF-8 byte offset for a pinned chunk; start at 0 and follow nextByteOffset.' },
        maxBytes: { type: 'number', description: 'Chunk size from 1024 to 100000 bytes.' },
      },
      required: ['proposalId', 'path'],
    },
    handler: async (args, context) => JSON.stringify(inspectSelfImprovementScope(
      context,
      String(args.proposalId || ''),
      String(args.path || '').replace(/\\/g, '/'),
      Number(args.byteOffset || 0),
      Number(args.maxBytes || 100_000),
    ), null, 2),
    permission: 'admin',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'self_improvement_replay_verified_stage',
    description: 'Recover an exact terminal receipt for this same durable task when static documentation staging was already persisted before a worker restart. It revalidates the repository, task, ref, parent commit, path set, tree digest, and isolated files; it does not regenerate a patch, activate, push, or deploy.',
    parameters: {
      type: 'object',
      properties: { proposalId: { type: 'string' } },
      required: ['proposalId'],
    },
    handler: async (args, context) => {
      assertLocalSelfImprovementContext(context);
      const proposalId = String(args.proposalId || '');
      const taskId = String(context?.taskId || '');
      if (context?.autonomous !== true || !canUseQueuedSelfImprovementStageAuthorization(
        selfImprovementScope(context),
        proposalId,
        taskId,
      )) {
        throw new Error('Verified stage replay requires the same live, locally authorized durable task lease.');
      }
      return JSON.stringify(await replayVerifiedSelfImprovementStage(
        selfImprovementScope(context),
        { proposalId, taskId },
        { isCancelled: context?.isCancelled },
      ), null, 2);
    },
    permission: 'admin',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'self-improvement.patch.replay-verified-stage',
      family: 'self-improvement',
      lane: 'system',
      operation: 'observe',
      risk: 'low',
      sideEffects: [],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'isolated', 'activated', 'pushed', 'proposal.id', 'proposal.status', 'proposal.taskId', 'baseCommit', 'branch', 'commit', 'treeDigest', 'repositoryId', 'worktreePath', 'changedPaths', 'verification', 'replayed'],
        requiredValues: {
          ok: true,
          status: 'verified',
          persisted: true,
          isolated: true,
          activated: false,
          pushed: false,
          replayed: true,
          'proposal.status': 'verified',
        },
        successStatuses: ['verified'],
        failureStatuses: ['blocked', 'failed', 'unverified'],
        successSignals: ['the exact persisted task-bound static stage was revalidated without repeating its write side effect'],
        limitations: ['This proves only the already-persisted isolated stage; activation and publication remain separate reviewed workflows.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'self-improvement.patch.replay-verified-stage',
      operation: 'observe',
      subjectArgument: 'proposalId',
    }),
  });

  registry.register({
    name: 'self_improvement_stage_patch',
    description: 'Apply one authorized unified diff in a separate Git worktree, run the proposal\'s fixed verification profile, and optionally create a local isolated commit. The live worktree is never modified; activation, push, deployment, dependency changes, secret paths, undeclared files, deletions, and unverified results are rejected.',
    parameters: {
      type: 'object',
      properties: {
        proposalId: { type: 'string', description: 'Persisted proposal id bound to the current authorization revision.' },
        patch: { type: 'string', description: 'Text-only unified diff whose exact target paths match the reviewed proposal.' },
        commitMessage: { type: 'string', description: 'Optional local isolated commit message.' },
        expectedBaseCommit: { type: 'string', description: 'Exact base commit returned by self_improvement_read_scope.' },
        expectedDeliveryBranch: { type: 'string', description: 'Exact delivery branch returned by self_improvement_read_scope.' },
      },
      required: ['proposalId', 'patch', 'expectedBaseCommit', 'expectedDeliveryBranch'],
    },
    handler: async (args, context) => {
      assertLocalSelfImprovementContext(context);
      const proposalId = String(args.proposalId || '');
      const patch = String(args.patch || '');
      const expectedBaseCommit = String(args.expectedBaseCommit || '').trim().toLowerCase();
      const expectedDeliveryBranch = String(args.expectedDeliveryBranch || '').trim();
      const proposal = getSelfImprovementProposal(selfImprovementScope(context), proposalId);
      if (!proposal) throw new Error('Self-improvement proposal not found in this user scope.');
      const expectedHashLength = proposal.repositoryObjectFormat === 'sha256' ? 64 : 40;
      if (!new RegExp(`^[0-9a-f]{${expectedHashLength}}$`, 'i').test(expectedBaseCommit)) {
        throw new Error('Self-improvement staging requires the exact non-empty base commit returned by scope inspection.');
      }
      if (
        !expectedDeliveryBranch
        || expectedDeliveryBranch.startsWith('-')
        || /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(expectedDeliveryBranch)
        || expectedDeliveryBranch.includes('..')
        || expectedDeliveryBranch.includes('@{')
      ) {
        throw new Error('Self-improvement staging requires a valid non-empty delivery branch returned by scope inspection.');
      }
      if (context?.autonomous === true && !canUseQueuedSelfImprovementStageAuthorization(
        selfImprovementScope(context),
        proposalId,
        String(context.taskId || ''),
      )) {
        throw new Error('Autonomous self-improvement staging lost its exact queued task authorization or lease.');
      }
      if (proposal.evaluation.decision === 'eligible_supervised') {
        if (context?.userConfirmed !== true) {
          throw new Error('Supervised self-improvement requires foreground confirmation of the exact patch and pinned Git identity.');
        }
        await recordSelfImprovementPatchReview(selfImprovementScope(context), proposalId, {
          patchDigest: crypto.createHash('sha256').update(patch).digest('hex'),
          baseCommit: expectedBaseCommit,
          deliveryBranch: expectedDeliveryBranch,
          verificationProfile: proposal.verificationProfile || 'standard',
        });
      }
      return JSON.stringify(await stageSelfImprovementPatch(
        selfImprovementScope(context),
        {
          proposalId,
          patch,
          commitMessage: args.commitMessage ? String(args.commitMessage) : undefined,
          expectedBaseCommit,
          expectedDeliveryBranch,
        },
        { isCancelled: context?.isCancelled },
      ), null, 2);
    },
    permission: 'admin',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'self-improvement.patch.stage',
      family: 'self-improvement',
      lane: 'system',
      operation: 'create',
      risk: 'high',
      sideEffects: [
        { type: 'process_execution', scope: 'fixed Git and verification commands in an isolated worktree', reversible: true },
        { type: 'local_write', scope: 'isolated self-improvement worktree and optional local branch commit', reversible: true },
      ],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'isolated', 'activated', 'pushed', 'proposal.id', 'proposal.status', 'baseCommit', 'branch', 'worktreePath', 'changedPaths', 'verification'],
        requiredValues: {
          ok: true,
          status: 'verified',
          persisted: true,
          isolated: true,
          activated: false,
          pushed: false,
          'proposal.status': 'verified',
        },
        successStatuses: ['verified'],
        failureStatuses: ['blocked', 'failed', 'unverified'],
        successSignals: ['patch paths match the reviewed scope and every fixed verification command passed before the isolated receipt was persisted'],
        limitations: ['A verified isolated branch is not activated, merged, pushed, deployed, or proven safe in the running desktop instance.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'self-improvement.patch.stage',
      operation: 'create',
      subjectArgument: 'proposalId',
      limitations: ['Activation and remote publication require separate reviewed workflows.'],
    }),
  });

  registry.register({
    name: 'self_improvement_queue',
    description: 'Queue one persisted, currently authorized improvement proposal for durable execution. Supervised proposals require this exact confirmed call. The worker may stage only in isolation and can never activate, push, deploy, or touch secrets.',
    parameters: {
      type: 'object',
      properties: { proposalId: { type: 'string' } },
      required: ['proposalId'],
    },
    handler: async (args, context) => {
      assertLocalSelfImprovementContext(context);
      const result = await enqueueSelfImprovementProposal(
        selfImprovementScope(context),
        String(args.proposalId || ''),
        { reviewed: true, localAdminAuthorized: true },
      );
      return JSON.stringify({
        ok: true,
        status: 'queued',
        persisted: true,
        proposal: result.proposal,
        task: { id: result.task.id, status: result.task.status, idempotencyKey: result.task.idempotencyKey },
      }, null, 2);
    },
    permission: 'admin',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'self-improvement.proposal.queue',
      family: 'self-improvement',
      lane: 'system',
      operation: 'create',
      risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'durable autonomous task queue', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'proposal.id', 'proposal.taskId', 'task.id', 'task.status'],
        requiredValues: { ok: true, status: 'queued', persisted: true, 'task.status': 'pending' },
        successStatuses: ['queued'],
        successSignals: ['the proposal is bound to a persisted pending task with an idempotency key'],
        limitations: ['Queueing does not prove the patch was staged, tested, committed, activated, or pushed.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'self-improvement.proposal.queue',
      operation: 'create',
      subjectArgument: 'proposalId',
    }),
  });

  registry.register({
    name: 'self_improvement_activate',
    description: 'After exact user confirmation, re-verify one isolated local self-improvement commit and fast-forward the currently checked-out clean delivery branch only when it still equals the reviewed base. This never pushes, deploys, rebases, overwrites local changes, or activates variant repositories.',
    parameters: {
      type: 'object',
      properties: {
        proposalId: { type: 'string', description: 'Verified proposal id whose exact staged commit should be activated locally.' },
        expectedRepositoryId: { type: 'string', description: 'Exact trusted repository identity shown for confirmation.' },
        expectedBaseCommit: { type: 'string', description: 'Exact reviewed base commit.' },
        expectedDeliveryBranch: { type: 'string', description: 'Exact live branch allowed to fast-forward.' },
        expectedStagedBranch: { type: 'string', description: 'Exact isolated staging branch.' },
        expectedStagedCommit: { type: 'string', description: 'Exact verified commit to activate.' },
        expectedTreeDigest: { type: 'string', description: 'Exact SHA-256 manifest digest of reviewed paths.' },
        expectedPatchDigest: { type: 'string', description: 'Exact SHA-256 digest of the staged patch.' },
        expectedVerificationProfile: { type: 'string', enum: ['targeted', 'standard', 'full'] },
        expectedChangedPaths: { type: 'array', items: { type: 'string' }, description: 'Exact reviewed repository-relative path set.' },
      },
      required: [
        'proposalId', 'expectedRepositoryId', 'expectedBaseCommit', 'expectedDeliveryBranch',
        'expectedStagedBranch', 'expectedStagedCommit', 'expectedTreeDigest', 'expectedPatchDigest',
        'expectedVerificationProfile', 'expectedChangedPaths',
      ],
    },
    handler: async (args, context) => {
      assertLocalSelfImprovementContext(context);
      if (context?.userConfirmed !== true) {
        throw new Error('Self-improvement activation requires explicit confirmation for the exact verified proposal.');
      }
      const scope = selfImprovementScope(context);
      const proposalId = String(args.proposalId || '');
      const proposal = getSelfImprovementProposal(scope, proposalId);
      if (!proposal) throw new Error('Self-improvement proposal not found in this user scope.');
      const expectedPaths = Array.isArray(args.expectedChangedPaths)
        ? args.expectedChangedPaths.map(String).sort()
        : [];
      const actualPaths = (proposal.changedPaths || []).map(String).sort();
      const exactIdentity = (
        String(args.expectedRepositoryId || '') === String(proposal.repositoryId || '')
        && String(args.expectedBaseCommit || '') === String(proposal.baseCommit || '')
        && String(args.expectedDeliveryBranch || '') === String(proposal.deliveryBranch || '')
        && String(args.expectedStagedBranch || '') === String(proposal.stagedBranch || '')
        && String(args.expectedStagedCommit || '') === String(proposal.stagedCommit || '')
        && String(args.expectedTreeDigest || '') === String(proposal.stagedTreeDigest || '')
        && String(args.expectedPatchDigest || '') === String(proposal.stagedPatchDigest || '')
        && String(args.expectedVerificationProfile || '') === String(proposal.verificationProfile || 'standard')
        && JSON.stringify(expectedPaths) === JSON.stringify(actualPaths)
      );
      if (!exactIdentity) {
        throw new Error('Self-improvement activation confirmation does not match the exact repository, commit, tree, patch, branch, profile, and path set.');
      }
      return JSON.stringify(await activateSelfImprovementStage(
        scope,
        { proposalId },
        { confirmed: true },
      ), null, 2);
    },
    permission: 'admin',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'self-improvement.patch.activate',
      family: 'self-improvement',
      lane: 'system',
      operation: 'mutate',
      risk: 'critical',
      sideEffects: [
        { type: 'process_execution', scope: 'fixed Git and verification commands for the reviewed proposal', reversible: true },
        { type: 'local_write', scope: 'fast-forward the clean checked-out delivery branch to the exact verified commit', reversible: true },
        { type: 'local_state_change', scope: 'persisted self-improvement activation receipt', reversible: true },
      ],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'activated', 'pushed', 'proposal.id', 'proposal.status', 'proposal.activatedCommit', 'branch', 'baseCommit', 'commit', 'verification', 'cleanup'],
        requiredValues: {
          ok: true,
          status: 'activated',
          persisted: true,
          activated: true,
          pushed: false,
          'proposal.status': 'activated',
        },
        successStatuses: ['activated'],
        failureStatuses: ['blocked', 'failed', 'unverified'],
        successSignals: ['the clean delivery branch reaches the exact staged commit after a fresh all-passing verification run'],
        limitations: ['Activation is local only. It does not push, deploy, publish, or prove the packaged desktop runtime.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'self-improvement.patch.activate',
      operation: 'mutate',
      subjectArgument: 'proposalId',
      limitations: ['Remote publication and runtime release remain separate reviewed workflows.'],
    }),
  });
}
