import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { canUseQueuedSelfImprovementStageAuthorization, getSelfImprovementProposal } from '../../self_extension/improvement_program';
import { resolveTrustedSelfImprovementRepository, sameSelfImprovementRepository, selfImprovementGitArgs, selfImprovementGitEnvironment } from '../../self_extension/repository_identity';
import type { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { containsSelfImprovementSecret } from '../../self_extension/content_security';
import { createSelfImprovementProposal, getSelfImprovementProgram, listSelfImprovementProposals, updateSelfImprovementProgram } from '../../self_extension/improvement_program';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { selfImprovementScope, registerLocalSelfImprovementTool } from './self_extension_shared';

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

export function registerSelfExtensionProgramTools(registry: ToolRegistry): void {
  registerLocalSelfImprovementTool(registry, {
    name: 'self_improvement_program_get',
    description: 'Read the durable self-improvement authorization for the current user scope. This distinguishes proposal-only, supervised, and bounded autonomous low-risk staging; activation and remote push are always separate.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args, context) => {
      return JSON.stringify({
        ok: true,
        status: 'read',
        program: getSelfImprovementProgram(selfImprovementScope(context)),
      }, null, 2);
    },
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

  registerLocalSelfImprovementTool(registry, {
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
      const scope = selfImprovementScope(context);
      const before = getSelfImprovementProgram(scope);
      const program = await updateSelfImprovementProgram(scope, args);
      const persisted = getSelfImprovementProgram(scope);
      if (persisted.revision !== program.revision || persisted.revision <= before.revision) {
        throw new Error('Self-improvement authorization was not durably persisted.');
      }
      return JSON.stringify({ ok: true, status: 'updated', persisted: true, program: persisted }, null, 2);
    },
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

  registerLocalSelfImprovementTool(registry, {
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
      const proposal = await createSelfImprovementProposal(selfImprovementScope(context), args as any);
      return JSON.stringify({
        ok: proposal.status !== 'blocked',
        status: proposal.status,
        persisted: true,
        proposal,
      }, null, 2);
    },
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

  registerLocalSelfImprovementTool(registry, {
    name: 'self_improvement_list',
    description: 'List persisted self-improvement proposals and their real authorization/execution state for the current user scope.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
    handler: async (args, context) => {
      return JSON.stringify({
        ok: true,
        status: 'read',
        proposals: listSelfImprovementProposals(selfImprovementScope(context), args.limit),
      }, null, 2);
    },
    securityLevel: 'safe',
  });

  registerLocalSelfImprovementTool(registry, {
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
    securityLevel: 'safe',
  });
}