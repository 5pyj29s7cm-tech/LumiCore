import crypto from 'node:crypto';
import { flushDBOrThrow, readDB, writeDB } from '../../db_layer';
import { enqueue, getTaskQueue, type AutonomousTask } from '../autonomy/task_queue';
import {
  acquireSelfImprovementRepositoryLease,
  resolveTrustedSelfImprovementRepository,
  sameSelfImprovementRepository,
} from './repository_identity';

export type SelfImprovementMode = 'propose' | 'supervised' | 'autonomous_low_risk';
export type SelfImprovementTarget = 'core' | 'variant';
export type SelfImprovementRisk = 'low' | 'medium' | 'high';
export type SelfImprovementOperation =
  | 'code_change'
  | 'test_change'
  | 'documentation_change'
  | 'dependency_change'
  | 'data_migration'
  | 'git_commit'
  | 'git_push'
  | 'deployment'
  | 'external_communication';

export interface SelfImprovementScope {
  userId: string;
  domain?: 'personal' | 'work';
  orgId?: string;
}

export interface SelfImprovementProgram {
  schemaVersion: 1;
  id: string;
  revision: number;
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  enabled: boolean;
  mode: SelfImprovementMode;
  allowedTargets: SelfImprovementTarget[];
  allowedVariantIds: string[];
  allowedPathPrefixes: string[];
  verificationProfiles: Array<'targeted' | 'standard' | 'full'>;
  maxFilesPerChange: number;
  maxPatchBytes: number;
  requireIsolatedBranch: true;
  requireVerifiedTests: true;
  allowLocalCommit: boolean;
  allowPush: false;
  expiresAt: string;
  authorizationReason: string;
  createdAt: string;
  updatedAt: string;
}

export interface SelfImprovementRequest {
  goal: string;
  target: SelfImprovementTarget;
  variantId?: string;
  risk: SelfImprovementRisk;
  operations: SelfImprovementOperation[];
  changedPaths?: string[];
  estimatedFiles?: number;
  estimatedPatchBytes?: number;
  verificationProfile?: 'targeted' | 'standard' | 'full';
}

export type SelfImprovementDecision =
  | 'eligible_autonomous'
  | 'eligible_supervised'
  | 'proposal_only'
  | 'review_required'
  | 'blocked';

export interface SelfImprovementEvaluation {
  decision: SelfImprovementDecision;
  authorized: boolean;
  programId: string;
  programRevision: number;
  reasons: string[];
  blockers: string[];
  requiredGates: string[];
}

export interface SelfImprovementProposal extends SelfImprovementRequest {
  schemaVersion: 1;
  id: string;
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  programId: string;
  programRevision: number;
  status: 'proposed' | 'queued' | 'review_required' | 'blocked' | 'staged' | 'verified' | 'activated' | 'rejected';
  evaluation: SelfImprovementEvaluation;
  taskId?: string;
  /** Durable proof that the queue admission came from a local administrator surface. */
  localAdminAuthorizedAt?: string;
  /** Exact SHA-256 of a supervised patch confirmed on the foreground administrator surface. */
  reviewedPatchDigest?: string;
  reviewedPatchAt?: string;
  reviewedBaseCommit?: string;
  reviewedDeliveryBranch?: string;
  reviewedVerificationProfile?: 'targeted' | 'standard' | 'full';
  repositoryId?: string;
  repositoryRoot?: string;
  repositoryOrigin?: string;
  repositoryObjectFormat?: string;
  stagedPatchDigest?: string;
  stagedTreeDigest?: string;
  stagingProtocol?: 'static_git_plumbing_v1' | 'supervised_worktree_v1';
  deliveryBranch?: string;
  baseCommit?: string;
  worktreePath?: string;
  stagedBranch?: string;
  stagedCommit?: string;
  activatedCommit?: string;
  activatedAt?: string;
  evidence?: Array<{ kind: string; ref: string; status: string; summary: string }>;
  createdAt: string;
  updatedAt: string;
}

const SETTINGS_KEY = 'self_improvement_program_v1';
const MAX_PROPOSALS = 200;
const DEFAULT_PATH_PREFIXES = [
  'server/',
  'src/',
  'routes/',
  'test/',
  'docs/',
  'src-tauri/src/',
  'VARIANT_WORKFLOW.md',
];
const FORBIDDEN_PATH = /(?:^|\/)(?:\.git|\.env(?:\.|$)|data|node_modules|dist(?:-server)?|desktop-resources|src-tauri\/target[^/]*|secrets?|credentials?|private[_-]?keys?)(?:\/|$)|\.(?:pem|p12|pfx|key|sqlite|db)$/i;
const EXECUTABLE_VERIFICATION_CONFIGURATION = /^(?:(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc(?:\.yml)?|(?:vite|vitest|eslint|jest|playwright)(?:\.[^/]+)?\.config\.[cm]?[jt]s|tsconfig(?:\.[^/]+)?\.json)$|(?:scripts|\.github)(?:\/|$)|src-tauri\/(?:Cargo\.toml|Cargo\.lock|build\.rs)$)/i;
const ALWAYS_REVIEW_OPERATIONS = new Set<SelfImprovementOperation>([
  'dependency_change',
  'data_migration',
  'git_push',
  'deployment',
  'external_communication',
]);
const UNSAFE_PATH_TEXT = /[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

interface PersistedSelfImprovementState {
  programs: SelfImprovementProgram[];
  proposals: SelfImprovementProposal[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function identifier(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function compact(value: unknown, max = 800): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function normalizeScope(scope: SelfImprovementScope): Required<SelfImprovementScope> {
  const userId = compact(scope.userId, 180) || 'anonymous';
  const orgId = compact(scope.orgId, 180);
  const domain = scope.domain === 'work' && orgId ? 'work' : 'personal';
  return { userId, domain, orgId: domain === 'work' ? orgId : '' };
}

function sameScope(
  record: { userId: string; domain: 'personal' | 'work'; orgId: string },
  scope: Required<SelfImprovementScope>,
): boolean {
  return record.userId === scope.userId && record.domain === scope.domain && record.orgId === scope.orgId;
}

function normalizeRelativePath(value: unknown): string {
  const raw = String(value || '');
  if (UNSAFE_PATH_TEXT.test(raw)) return '';
  const candidate = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!candidate || candidate.startsWith('/') || /^[a-z]:\//i.test(candidate)) return '';
  const segments = candidate.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return '';
  return segments.join('/');
}

export function isSelfImprovementVerificationConfigurationPath(value: unknown): boolean {
  const normalized = normalizeRelativePath(value);
  return Boolean(normalized && EXECUTABLE_VERIFICATION_CONFIGURATION.test(normalized));
}

export function isAutonomousSelfImprovementDocumentationPath(value: unknown): boolean {
  const normalized = normalizeRelativePath(value);
  return Boolean(normalized && /^(?:docs\/[^\0]*\.md|VARIANT_WORKFLOW\.md)$/i.test(normalized));
}

function requiredOperationForPath(file: string): SelfImprovementOperation {
  if (/^(?:docs\/.*|VARIANT_WORKFLOW\.md$)/i.test(file) && /\.md$/i.test(file)) {
    return 'documentation_change';
  }
  if (/^test\//i.test(file)) return 'test_change';
  return 'code_change';
}

function normalizePrefix(value: unknown): string {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  const directoryPrefix = raw.endsWith('/');
  const path = normalizeRelativePath(raw.replace(/\/+$/, ''));
  if (!path || FORBIDDEN_PATH.test(path)) return '';
  return directoryPrefix ? `${path}/` : path;
}

function defaultProgram(scopeInput: SelfImprovementScope, at = nowIso()): SelfImprovementProgram {
  const scope = normalizeScope(scopeInput);
  return {
    schemaVersion: 1,
    id: `self_improvement_${crypto.createHash('sha256').update(`${scope.userId}\0${scope.domain}\0${scope.orgId}`).digest('hex').slice(0, 16)}`,
    revision: 0,
    ...scope,
    enabled: false,
    mode: 'propose',
    allowedTargets: ['core'],
    allowedVariantIds: [],
    allowedPathPrefixes: [...DEFAULT_PATH_PREFIXES],
    verificationProfiles: ['targeted', 'standard'],
    maxFilesPerChange: 12,
    maxPatchBytes: 160_000,
    requireIsolatedBranch: true,
    requireVerifiedTests: true,
    allowLocalCommit: true,
    allowPush: false,
    expiresAt: '',
    authorizationReason: '',
    createdAt: at,
    updatedAt: at,
  };
}

function normalizeProgram(value: Partial<SelfImprovementProgram>, fallback: SelfImprovementProgram): SelfImprovementProgram {
  const hasAllowedTargets = Array.isArray(value.allowedTargets);
  const hasPathPrefixes = Array.isArray(value.allowedPathPrefixes);
  const hasVerificationProfiles = Array.isArray(value.verificationProfiles);
  const allowedTargets = unique((hasAllowedTargets ? value.allowedTargets! : fallback.allowedTargets)
    .filter((target): target is SelfImprovementTarget => target === 'core' || target === 'variant'));
  const pathPrefixes = unique((hasPathPrefixes ? value.allowedPathPrefixes! : fallback.allowedPathPrefixes)
    .map(normalizePrefix)
    .filter(Boolean));
  const verificationProfiles = unique((hasVerificationProfiles ? value.verificationProfiles! : fallback.verificationProfiles)
    .filter((profile): profile is 'targeted' | 'standard' | 'full' => ['targeted', 'standard', 'full'].includes(profile)));
  return {
    ...fallback,
    ...value,
    schemaVersion: 1,
    userId: fallback.userId,
    domain: fallback.domain,
    orgId: fallback.orgId,
    mode: ['propose', 'supervised', 'autonomous_low_risk'].includes(String(value.mode))
      ? value.mode as SelfImprovementMode
      : fallback.mode,
    allowedTargets: hasAllowedTargets ? allowedTargets : (allowedTargets.length ? allowedTargets : ['core']),
    allowedVariantIds: unique((value.allowedVariantIds || fallback.allowedVariantIds)
      .map(item => compact(item, 100).toLowerCase())
      .filter(item => /^[a-z0-9][a-z0-9-]*$/.test(item))),
    allowedPathPrefixes: hasPathPrefixes ? pathPrefixes : (pathPrefixes.length ? pathPrefixes : [...DEFAULT_PATH_PREFIXES]),
    verificationProfiles: hasVerificationProfiles ? verificationProfiles : (verificationProfiles.length ? verificationProfiles : ['targeted']),
    maxFilesPerChange: Math.max(1, Math.min(50, Number(value.maxFilesPerChange) || fallback.maxFilesPerChange)),
    maxPatchBytes: Math.max(4_096, Math.min(1_000_000, Number(value.maxPatchBytes) || fallback.maxPatchBytes)),
    requireIsolatedBranch: true,
    requireVerifiedTests: true,
    allowLocalCommit: value.allowLocalCommit !== false,
    allowPush: false,
    expiresAt: compact(value.expiresAt, 80),
    authorizationReason: compact(value.authorizationReason, 800),
  };
}

function readState(): PersistedSelfImprovementState {
  try {
    const db = readDB();
    const row = (db.settings || []).find((item: any) => item?.key === SETTINGS_KEY);
    const parsed = row?.value ? JSON.parse(row.value) : null;
    return {
      programs: Array.isArray(parsed?.programs) ? parsed.programs : [],
      proposals: Array.isArray(parsed?.proposals) ? parsed.proposals : [],
    };
  } catch {
    return { programs: [], proposals: [] };
  }
}

async function writeState(state: PersistedSelfImprovementState): Promise<void> {
  const db = readDB();
  if (!Array.isArray(db.settings)) db.settings = [];
  const previousRow = db.settings.find((item: any) => item?.key === SETTINGS_KEY);
  const previousValue = previousRow ? String(previousRow.value || '') : undefined;
  const value = JSON.stringify({
    programs: state.programs,
    proposals: state.proposals
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-MAX_PROPOSALS),
  });
  const index = db.settings.findIndex((item: any) => item?.key === SETTINGS_KEY);
  if (index >= 0) db.settings[index].value = value;
  else db.settings.push({ key: SETTINGS_KEY, value });
  writeDB(db);
  try {
    await flushDBOrThrow();
  } catch (error) {
    // Do not leave a failed durable authorization/receipt write visible only
    // in memory. Restore this one registry row while preserving unrelated DB
    // mutations that may have occurred during the awaited strict flush.
    const current = readDB();
    if (!Array.isArray(current.settings)) current.settings = [];
    const currentIndex = current.settings.findIndex((item: any) => item?.key === SETTINGS_KEY);
    if (previousValue === undefined) {
      if (currentIndex >= 0) current.settings.splice(currentIndex, 1);
    } else if (currentIndex >= 0) {
      current.settings[currentIndex].value = previousValue;
    } else {
      current.settings.push({ key: SETTINGS_KEY, value: previousValue });
    }
    writeDB(current);
    try { await flushDBOrThrow(); } catch {}
    throw error;
  }
}

export function getSelfImprovementProgram(scopeInput: SelfImprovementScope): SelfImprovementProgram {
  const scope = normalizeScope(scopeInput);
  const fallback = defaultProgram(scope);
  const stored = readState().programs.find(program => sameScope(program, scope));
  return normalizeProgram(stored || {}, fallback);
}

export async function updateSelfImprovementProgram(
  scopeInput: SelfImprovementScope,
  patch: Partial<Pick<SelfImprovementProgram,
    | 'enabled'
    | 'mode'
    | 'allowedTargets'
    | 'allowedVariantIds'
    | 'allowedPathPrefixes'
    | 'verificationProfiles'
    | 'maxFilesPerChange'
    | 'maxPatchBytes'
    | 'allowLocalCommit'
    | 'expiresAt'
    | 'authorizationReason'>>,
): Promise<SelfImprovementProgram> {
  const scope = normalizeScope(scopeInput);
  let authorizationLease: ReturnType<typeof acquireSelfImprovementRepositoryLease> | undefined;
  let repository: ReturnType<typeof resolveTrustedSelfImprovementRepository> | undefined;
  try {
    repository = resolveTrustedSelfImprovementRepository();
  } catch {}
  // A repository identity can legitimately be unavailable in proposal-only
  // deployments. Once it resolves, every lease failure is security-relevant
  // and must fail closed rather than silently updating authorization.
  if (repository) authorizationLease = acquireSelfImprovementRepositoryLease(repository, 'authorization_update');
  try {
  const state = readState();
  const existingIndex = state.programs.findIndex(program => sameScope(program, scope));
  const previous = existingIndex >= 0
    ? normalizeProgram(state.programs[existingIndex], defaultProgram(scope))
    : defaultProgram(scope);
  const timestamp = nowIso();
  const updated = normalizeProgram({
    ...previous,
    ...patch,
    revision: previous.revision + 1,
    updatedAt: timestamp,
    createdAt: previous.createdAt || timestamp,
  }, previous);
  if (updated.enabled && !updated.authorizationReason) {
    throw new Error('A durable user authorization reason is required before self-improvement can be enabled.');
  }
  if (updated.expiresAt && !Number.isFinite(Date.parse(updated.expiresAt))) {
    throw new Error('Self-improvement authorization expiry must be an ISO timestamp.');
  }
  if (existingIndex >= 0) state.programs[existingIndex] = updated;
  else state.programs.push(updated);
  await writeState(state);
  return updated;
  } finally {
    authorizationLease?.release();
  }
}

function pathIsAllowed(path: string, program: SelfImprovementProgram): boolean {
  return program.allowedPathPrefixes.some(prefix => (
    prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix
  ));
}

export function evaluateSelfImprovementRequest(
  program: SelfImprovementProgram,
  request: SelfImprovementRequest,
  at = new Date(),
): SelfImprovementEvaluation {
  const blockers: string[] = [];
  const reasons: string[] = [];
  const requiredGates = ['isolated_branch', 'verified_tests', 'terminal_receipt'];
  const paths = unique((request.changedPaths || []).map(normalizeRelativePath).filter(Boolean));
  const rawPathCount = (request.changedPaths || []).length;

  if (!program.enabled) blockers.push('self_improvement_disabled');
  if (program.expiresAt && Date.parse(program.expiresAt) <= at.getTime()) blockers.push('authorization_expired');
  if (!program.allowedTargets.includes(request.target)) blockers.push('target_not_authorized');
  if (request.target === 'variant') {
    const variantId = compact(request.variantId, 100).toLowerCase();
    if (!variantId || !program.allowedVariantIds.includes(variantId)) blockers.push('variant_not_authorized');
  }
  if (!compact(request.goal)) blockers.push('goal_missing');
  if (!request.operations.length) blockers.push('operation_missing');
  if (rawPathCount !== paths.length) blockers.push('invalid_or_ambiguous_path');
  if (paths.some(path => FORBIDDEN_PATH.test(path))) blockers.push('sensitive_or_runtime_path_forbidden');
  if (paths.some(path => isSelfImprovementVerificationConfigurationPath(path))) {
    blockers.push('verification_configuration_path_forbidden');
  }
  if (paths.some(path => !pathIsAllowed(path, program))) blockers.push('path_outside_authorized_scope');
  if (paths.some(path => !request.operations.includes(requiredOperationForPath(path)))) {
    blockers.push('path_operation_mismatch');
  }
  const fileCount = Math.max(paths.length, Number(request.estimatedFiles) || 0);
  if (fileCount > program.maxFilesPerChange) blockers.push('file_budget_exceeded');
  if ((Number(request.estimatedPatchBytes) || 0) > program.maxPatchBytes) blockers.push('patch_budget_exceeded');
  const profile = request.verificationProfile || 'standard';
  if (!program.verificationProfiles.includes(profile)) blockers.push('verification_profile_not_authorized');
  if (request.operations.includes('git_push')) blockers.push('automatic_push_forbidden');
  if (request.operations.includes('deployment')) blockers.push('automatic_deployment_forbidden');
  if (request.operations.includes('external_communication')) blockers.push('external_communication_forbidden');

  const requiresLiveReview = request.risk !== 'low'
    || request.operations.some(operation => ALWAYS_REVIEW_OPERATIONS.has(operation));
  if (requiresLiveReview) requiredGates.push('live_user_review');
  if (request.operations.includes('dependency_change')) requiredGates.push('dependency_review');
  if (request.operations.includes('data_migration')) requiredGates.push('migration_review');
  if (program.allowLocalCommit) requiredGates.push('local_commit_receipt');

  if (blockers.length > 0) {
    return {
      decision: 'blocked',
      authorized: false,
      programId: program.id,
      programRevision: program.revision,
      reasons,
      blockers: unique(blockers),
      requiredGates: unique(requiredGates),
    };
  }

  if (paths.length === 0 && request.operations.some(operation => (
    operation === 'code_change' || operation === 'test_change' || operation === 'documentation_change'
  ))) {
    reasons.push('The exact source boundary has not been identified yet; Lumi may investigate but cannot stage a patch.');
    return {
      decision: 'proposal_only', authorized: false, programId: program.id, programRevision: program.revision,
      reasons, blockers: [], requiredGates: unique([...requiredGates, 'path_scope_review']),
    };
  }

  if (request.target === 'variant') {
    reasons.push('Variant source activation is unavailable until the proposal is bound to a verified variant release-train repository identity.');
    return {
      decision: 'review_required', authorized: false, programId: program.id, programRevision: program.revision,
      reasons, blockers: [], requiredGates: unique([...requiredGates, 'variant_release_train_repository']),
    };
  }

  if (program.mode === 'propose') {
    reasons.push('Program is proposal-only; Lumi may diagnose and draft but may not stage source changes.');
    return {
      decision: 'proposal_only', authorized: false, programId: program.id, programRevision: program.revision,
      reasons, blockers: [], requiredGates: unique([...requiredGates, 'explicit_user_approval']),
    };
  }
  if (program.mode === 'supervised') {
    reasons.push('The durable program permits isolated staging after an explicit per-change review.');
    return {
      decision: 'eligible_supervised', authorized: true, programId: program.id, programRevision: program.revision,
      reasons, blockers: [], requiredGates: unique([...requiredGates, 'explicit_user_approval']),
    };
  }
  if (requiresLiveReview) {
    reasons.push('Autonomous mode is limited to low-risk changes; this proposal needs live review.');
    return {
      decision: 'review_required', authorized: false, programId: program.id, programRevision: program.revision,
      reasons, blockers: [], requiredGates: unique(requiredGates),
    };
  }
  const autonomousStaticDocumentationOnly = request.operations.length === 1
    && request.operations[0] === 'documentation_change'
    && paths.length > 0
    && paths.every(isAutonomousSelfImprovementDocumentationPath);
  if (!autonomousStaticDocumentationOnly) {
    reasons.push('Autonomous self-improvement is limited to static Markdown documentation until code verification runs in a true OS sandbox.');
    return {
      decision: 'review_required', authorized: false, programId: program.id, programRevision: program.revision,
      reasons, blockers: [], requiredGates: unique([...requiredGates, 'exact_patch_review', 'supervised_execution']),
    };
  }
  if (!program.allowLocalCommit) {
    reasons.push('Autonomous documentation requires an isolated local commit so the exact tree can be verified and activated later.');
    return {
      decision: 'review_required', authorized: false, programId: program.id, programRevision: program.revision,
      reasons, blockers: [], requiredGates: unique([...requiredGates, 'local_commit_receipt']),
    };
  }
  reasons.push('Low-risk change is authorized for isolated staging; activation and push remain separate.');
  return {
    decision: 'eligible_autonomous', authorized: true, programId: program.id, programRevision: program.revision,
    reasons, blockers: [], requiredGates: unique(requiredGates),
  };
}

export async function createSelfImprovementProposal(
  scopeInput: SelfImprovementScope,
  input: SelfImprovementRequest,
): Promise<SelfImprovementProposal> {
  const scope = normalizeScope(scopeInput);
  const state = readState();
  const program = getSelfImprovementProgram(scope);
  const rawChangedPaths = (input.changedPaths || []).map(path => String(path || '').trim()).filter(Boolean);
  const normalized: SelfImprovementRequest = {
    goal: compact(input.goal),
    target: input.target === 'variant' ? 'variant' : 'core',
    variantId: input.target === 'variant' ? compact(input.variantId, 100).toLowerCase() : undefined,
    risk: ['low', 'medium', 'high'].includes(input.risk) ? input.risk : 'high',
    operations: unique((input.operations || []).filter(operation => [
      'code_change', 'test_change', 'documentation_change', 'dependency_change', 'data_migration',
      'git_commit', 'git_push', 'deployment', 'external_communication',
    ].includes(operation))),
    changedPaths: unique(rawChangedPaths.map(normalizeRelativePath).filter(Boolean)),
    estimatedFiles: Math.max(0, Number(input.estimatedFiles) || 0),
    estimatedPatchBytes: Math.max(0, Number(input.estimatedPatchBytes) || 0),
    verificationProfile: input.verificationProfile || 'standard',
  };
  const evaluation = evaluateSelfImprovementRequest(program, {
    ...normalized,
    // Evaluate the raw set so duplicate, absolute, or ambiguous paths fail
    // closed, while only normalized paths are persisted.
    changedPaths: rawChangedPaths,
  });
  const timestamp = nowIso();
  const proposal: SelfImprovementProposal = {
    schemaVersion: 1,
    id: identifier('improvement'),
    ...scope,
    ...normalized,
    programId: program.id,
    programRevision: program.revision,
    status: evaluation.decision === 'blocked'
      ? 'blocked'
      : evaluation.decision === 'review_required' || evaluation.decision === 'eligible_supervised'
        ? 'review_required'
        : 'proposed',
    evaluation,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (normalized.target === 'core') {
    try {
      const repository = resolveTrustedSelfImprovementRepository();
      proposal.repositoryId = repository.repositoryId;
      proposal.repositoryRoot = repository.root;
      proposal.repositoryOrigin = repository.origin;
      proposal.repositoryObjectFormat = repository.objectFormat;
    } catch (error: any) {
      proposal.evaluation = {
        ...proposal.evaluation,
        decision: 'proposal_only',
        authorized: false,
        reasons: unique([
          ...proposal.evaluation.reasons,
          'No trusted LumiCore source repository identity is available; diagnosis may continue but staging is disabled.',
        ]),
        blockers: unique([...proposal.evaluation.blockers, 'repository_identity_unavailable']),
        requiredGates: unique([...proposal.evaluation.requiredGates, 'trusted_repository_identity']),
      };
      proposal.status = 'proposed';
    }
  }
  state.proposals.push(proposal);
  await writeState(state);
  return proposal;
}

export function listSelfImprovementProposals(
  scopeInput: SelfImprovementScope,
  limit = 30,
): SelfImprovementProposal[] {
  const scope = normalizeScope(scopeInput);
  return readState().proposals
    .filter(proposal => sameScope(proposal, scope))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 30)))
    .map(proposal => JSON.parse(JSON.stringify(proposal)));
}

export function getSelfImprovementProposal(
  scopeInput: SelfImprovementScope,
  proposalId: string,
): SelfImprovementProposal | null {
  const scope = normalizeScope(scopeInput);
  const proposal = readState().proposals.find(item => item.id === proposalId && sameScope(item, scope));
  return proposal ? JSON.parse(JSON.stringify(proposal)) : null;
}

export function authorizeSelfImprovementStage(
  scopeInput: SelfImprovementScope,
  proposalId: string,
  options: { reviewedPatchDigest?: string } = {},
): { program: SelfImprovementProgram; proposal: SelfImprovementProposal; evaluation: SelfImprovementEvaluation } {
  const scope = normalizeScope(scopeInput);
  const proposal = getSelfImprovementProposal(scope, proposalId);
  if (!proposal) throw new Error('Self-improvement proposal not found in this user scope.');
  const program = getSelfImprovementProgram(scope);
  if (
    proposal.target !== 'core'
    || !proposal.repositoryId
    || !proposal.repositoryRoot
    || !proposal.repositoryOrigin
    || !proposal.repositoryObjectFormat
  ) {
    throw new Error('Self-improvement proposal is not bound to a trusted core repository identity.');
  }
  const repository = resolveTrustedSelfImprovementRepository();
  if (!sameSelfImprovementRepository({
    repositoryId: proposal.repositoryId,
    root: proposal.repositoryRoot,
    origin: proposal.repositoryOrigin,
    objectFormat: proposal.repositoryObjectFormat,
  }, repository)) {
    throw new Error('Trusted self-improvement repository identity changed; create a new proposal for the intended repository.');
  }
  if (program.id !== proposal.programId || program.revision !== proposal.programRevision) {
    throw new Error('Self-improvement authorization changed; the proposal must be reviewed again.');
  }
  const evaluation = evaluateSelfImprovementRequest(program, proposal);
  const reviewedPatchDigest = compact(options.reviewedPatchDigest, 100).toLowerCase();
  const authorized = evaluation.decision === 'eligible_autonomous'
    || evaluation.decision === 'eligible_supervised'
      && /^[0-9a-f]{64}$/.test(reviewedPatchDigest)
      && proposal.reviewedPatchDigest === reviewedPatchDigest
      && Boolean(proposal.reviewedPatchAt);
  if (!authorized) {
    throw new Error(`Self-improvement staging is not authorized: ${evaluation.blockers.join(', ') || evaluation.decision}.`);
  }
  return { program, proposal, evaluation };
}

export async function recordSelfImprovementPatchReview(
  scopeInput: SelfImprovementScope,
  proposalId: string,
  review: {
    patchDigest: string;
    baseCommit: string;
    deliveryBranch: string;
    verificationProfile: 'targeted' | 'standard' | 'full';
  },
): Promise<SelfImprovementProposal> {
  const scope = normalizeScope(scopeInput);
  const normalizedDigest = compact(review.patchDigest, 100).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedDigest)) {
    throw new Error('A valid SHA-256 digest is required for supervised self-improvement review.');
  }
  const state = readState();
  const index = state.proposals.findIndex(item => item.id === proposalId && sameScope(item, scope));
  if (index < 0) throw new Error('Self-improvement proposal not found in this user scope.');
  const proposal = state.proposals[index];
  if (proposal.status !== 'review_required') {
    throw new Error(`Self-improvement patch review is immutable after staging begins (current status: ${proposal.status}).`);
  }
  const program = getSelfImprovementProgram(scope);
  if (program.id !== proposal.programId || program.revision !== proposal.programRevision) {
    throw new Error('Self-improvement authorization changed; the exact patch must be reviewed again.');
  }
  const evaluation = evaluateSelfImprovementRequest(program, proposal);
  if (evaluation.decision !== 'eligible_supervised') {
    throw new Error('Exact patch review is available only for a supervised self-improvement proposal.');
  }
  const baseCommit = compact(review.baseCommit, 100).toLowerCase();
  const deliveryBranch = compact(review.deliveryBranch, 220);
  if (!/^[0-9a-f]{40,64}$/.test(baseCommit) || !deliveryBranch || /[\0\r\n]/.test(deliveryBranch)) {
    throw new Error('Supervised self-improvement review requires an exact Git base commit and delivery branch.');
  }
  if (review.verificationProfile !== proposal.verificationProfile) {
    throw new Error('Supervised self-improvement review profile does not match the persisted proposal.');
  }
  proposal.reviewedPatchDigest = normalizedDigest;
  proposal.reviewedBaseCommit = baseCommit;
  proposal.reviewedDeliveryBranch = deliveryBranch;
  proposal.reviewedVerificationProfile = review.verificationProfile;
  proposal.reviewedPatchAt = nowIso();
  proposal.evaluation = evaluation;
  proposal.updatedAt = proposal.reviewedPatchAt;
  state.proposals[index] = proposal;
  await writeState(state);
  return JSON.parse(JSON.stringify(proposal));
}

/**
 * A queued proposal is the durable, task-bound confirmation that lets the
 * autonomous executor perform the otherwise-confirmed isolated staging call.
 * It cannot widen the program, approve an unreviewed supervised proposal, or
 * authorize activation/push. The exact proposal must still belong to the
 * current program revision and the exact autonomous task that is executing it.
 */
export function canUseQueuedSelfImprovementStageAuthorization(
  scopeInput: SelfImprovementScope,
  proposalId: string,
  taskId: string,
): boolean {
  try {
    const { proposal, evaluation } = authorizeSelfImprovementStage(scopeInput, proposalId);
    const task = getTaskQueue(proposal.userId).find(item => item.id === taskId);
    const liveTaskLease = Boolean(
      task
      && task.status === 'running'
      && task.leaseId
      && task.leaseExpiresAt
      && Date.parse(task.leaseExpiresAt) > Date.now()
      && !task.cancelRequestedAt
      && !task.pauseRequestedAt
    );
    return (proposal.status === 'queued' || proposal.status === 'verified')
      && proposal.taskId === taskId
      && Boolean(proposal.localAdminAuthorizedAt)
      && evaluation.decision === 'eligible_autonomous'
      && liveTaskLease;
  } catch {
    return false;
  }
}

export function isLocalAdminAuthorizedSelfImprovementTask(
  scopeInput: SelfImprovementScope,
  taskId: string,
  idempotencyKey?: string,
): boolean {
  const scope = normalizeScope(scopeInput);
  const proposal = readState().proposals.find(item => (
    sameScope(item, scope)
    && (item.status === 'queued' || item.status === 'verified')
    && item.taskId === taskId
    && Boolean(item.localAdminAuthorizedAt)
    && idempotencyKey === `self-improvement:${item.id}:${item.programRevision}`
  ));
  if (!proposal) return false;
  return canUseQueuedSelfImprovementStageAuthorization(scope, proposal.id, taskId);
}

export async function recordSelfImprovementStage(
  scopeInput: SelfImprovementScope,
  proposalId: string,
  stage: {
    status: 'staged' | 'verified';
    baseCommit: string;
    worktreePath: string;
    branch: string;
    commit?: string;
    patchDigest: string;
    treeDigest?: string;
    stagingProtocol: 'static_git_plumbing_v1' | 'supervised_worktree_v1';
    deliveryBranch: string;
    evidence: Array<{ kind: string; ref: string; status: string; summary: string }>;
  },
): Promise<SelfImprovementProposal> {
  const scope = normalizeScope(scopeInput);
  const state = readState();
  const index = state.proposals.findIndex(item => item.id === proposalId && sameScope(item, scope));
  if (index < 0) throw new Error('Self-improvement proposal not found in this user scope.');
  const current = state.proposals[index];
  const program = getSelfImprovementProgram(scope);
  if (current.programId !== program.id || current.programRevision !== program.revision) {
    throw new Error('Self-improvement authorization changed before the stage receipt was persisted.');
  }
  current.status = stage.status;
  current.baseCommit = compact(stage.baseCommit, 100);
  current.worktreePath = String(stage.worktreePath || '').slice(0, 1_000);
  current.stagedBranch = compact(stage.branch, 220);
  current.stagedCommit = compact(stage.commit, 100) || undefined;
  current.stagedPatchDigest = compact(stage.patchDigest, 100).toLowerCase();
  current.stagedTreeDigest = compact(stage.treeDigest, 100).toLowerCase() || undefined;
  current.stagingProtocol = stage.stagingProtocol;
  current.deliveryBranch = compact(stage.deliveryBranch, 220);
  current.evidence = stage.evidence.slice(0, 40).map(item => ({
    kind: compact(item.kind, 80),
    ref: compact(item.ref, 500),
    status: compact(item.status, 80),
    summary: compact(item.summary, 500),
  }));
  current.updatedAt = nowIso();
  state.proposals[index] = current;
  await writeState(state);
  return JSON.parse(JSON.stringify(current));
}

export function authorizeSelfImprovementActivation(
  scopeInput: SelfImprovementScope,
  proposalId: string,
): { program: SelfImprovementProgram; proposal: SelfImprovementProposal } {
  const scope = normalizeScope(scopeInput);
  const proposal = getSelfImprovementProposal(scope, proposalId);
  if (!proposal) throw new Error('Self-improvement proposal not found in this user scope.');
  const program = getSelfImprovementProgram(scope);
  if (!program.enabled || program.id !== proposal.programId || program.revision !== proposal.programRevision) {
    throw new Error('Self-improvement authorization changed or was disabled; activation requires a new review.');
  }
  const evaluation = evaluateSelfImprovementRequest(program, proposal);
  if (evaluation.decision !== 'eligible_autonomous' && evaluation.decision !== 'eligible_supervised') {
    throw new Error(`Self-improvement activation is not authorized: ${evaluation.blockers.join(', ') || evaluation.decision}.`);
  }
  const stagedDigestIsValid = /^[0-9a-f]{64}$/.test(proposal.stagedPatchDigest || '');
  const exactPatchWasReviewed = /^[0-9a-f]{64}$/.test(proposal.reviewedPatchDigest || '')
    && proposal.stagedPatchDigest === proposal.reviewedPatchDigest
    && proposal.baseCommit === proposal.reviewedBaseCommit
    && proposal.deliveryBranch === proposal.reviewedDeliveryBranch
    && proposal.verificationProfile === proposal.reviewedVerificationProfile
    && Boolean(proposal.reviewedPatchAt);
  const artifactDigestAuthorized = evaluation.decision === 'eligible_autonomous'
    ? stagedDigestIsValid
    : exactPatchWasReviewed;
  if (evaluation.decision === 'eligible_autonomous') {
    if (
      proposal.stagingProtocol !== 'static_git_plumbing_v1'
      || !/^[0-9a-f]{64}$/.test(proposal.stagedTreeDigest || '')
      || !proposal.repositoryId
      || !proposal.repositoryRoot
      || !proposal.repositoryOrigin
      || !proposal.repositoryObjectFormat
    ) {
      throw new Error('Legacy or incomplete autonomous stages must be re-staged with the current static Git plumbing protocol.');
    }
    const repository = resolveTrustedSelfImprovementRepository();
    if (!sameSelfImprovementRepository({
      repositoryId: proposal.repositoryId,
      root: proposal.repositoryRoot,
      origin: proposal.repositoryOrigin,
      objectFormat: proposal.repositoryObjectFormat,
    }, repository)) {
      throw new Error('The autonomous stage repository identity changed; create and stage a new proposal.');
    }
  }
  if (
    proposal.status !== 'verified'
    || !proposal.baseCommit
    || !proposal.stagedBranch
    || !proposal.stagedCommit
    || !artifactDigestAuthorized
    || !proposal.deliveryBranch
    || !proposal.worktreePath
  ) {
    throw new Error('Only an isolated, verified, locally committed proposal can be activated.');
  }
  return { program, proposal };
}

export async function recordSelfImprovementActivation(
  scopeInput: SelfImprovementScope,
  proposalId: string,
  activation: {
    commit: string;
    evidence: Array<{ kind: string; ref: string; status: string; summary: string }>;
  },
): Promise<SelfImprovementProposal> {
  const scope = normalizeScope(scopeInput);
  const state = readState();
  const index = state.proposals.findIndex(item => item.id === proposalId && sameScope(item, scope));
  if (index < 0) throw new Error('Self-improvement proposal not found in this user scope.');
  const current = state.proposals[index];
  const authorized = authorizeSelfImprovementActivation(scope, proposalId);
  if (authorized.proposal.stagedCommit !== compact(activation.commit, 100)) {
    throw new Error('Activated commit does not match the reviewed staged commit.');
  }
  current.status = 'activated';
  current.activatedCommit = compact(activation.commit, 100);
  current.activatedAt = nowIso();
  current.evidence = [...(current.evidence || []), ...activation.evidence]
    .slice(-40)
    .map(item => ({
      kind: compact(item.kind, 80),
      ref: compact(item.ref, 500),
      status: compact(item.status, 80),
      summary: compact(item.summary, 500),
    }));
  current.updatedAt = current.activatedAt;
  state.proposals[index] = current;
  await writeState(state);
  return JSON.parse(JSON.stringify(current));
}

export async function enqueueSelfImprovementProposal(
  scopeInput: SelfImprovementScope,
  proposalId: string,
  options: { reviewed?: boolean; localAdminAuthorized?: boolean } = {},
): Promise<{ proposal: SelfImprovementProposal; task: AutonomousTask }> {
  const scope = normalizeScope(scopeInput);
  const state = readState();
  const index = state.proposals.findIndex(proposal => proposal.id === proposalId && sameScope(proposal, scope));
  if (index < 0) throw new Error('Self-improvement proposal not found in this user scope.');
  const proposal = state.proposals[index];
  const program = getSelfImprovementProgram(scope);
  if (program.id !== proposal.programId || program.revision !== proposal.programRevision) {
    throw new Error('Self-improvement authorization changed; create or re-evaluate the proposal before execution.');
  }
  const evaluation = evaluateSelfImprovementRequest(program, proposal);
  if (evaluation.decision === 'blocked' || evaluation.decision === 'proposal_only') {
    throw new Error(`Self-improvement proposal cannot be queued: ${evaluation.blockers.join(', ') || evaluation.decision}.`);
  }
  if (evaluation.decision !== 'eligible_autonomous') {
    throw new Error('Only static low-risk documentation proposals may enter the autonomous self-improvement queue; code and test patches require foreground exact-patch review.');
  }
  if (proposal.status !== 'proposed' && proposal.status !== 'queued') {
    throw new Error(`Self-improvement proposal in status ${proposal.status} cannot be queued again.`);
  }
  if (options.localAdminAuthorized !== true) {
    throw new Error('Self-improvement queue admission requires a local administrator authorization.');
  }
  // Re-run the repository-bound authorization immediately before queueing so
  // a proposal created while identity resolution failed cannot enter a fake
  // queue that will always fail at execution time.
  authorizeSelfImprovementStage(scope, proposal.id);
  const task = enqueue({
    userId: scope.userId,
    title: `Self-improvement: ${proposal.goal}`.slice(0, 120),
    description: [
      `Execute persisted self-improvement proposal ${proposal.id} under program ${program.id} revision ${program.revision}.`,
      `Goal: ${proposal.goal}`,
      `Target: ${proposal.target}${proposal.variantId ? `/${proposal.variantId}` : ''}.`,
      `Authorized paths: ${(proposal.changedPaths || []).join(', ') || 'discover first, then stop for scope review'}.`,
      `Verification profile: ${proposal.verificationProfile}.`,
      'Use only the scoped source reader and self-improvement staging capability. This autonomous lane is limited to static Markdown integrity verification; preserve the live worktree and never execute project code, push, deploy, read secrets, or claim activation.',
    ].join('\n'),
    source: 'user_request',
    priority: proposal.risk === 'low' ? 5 : 3,
    mode: 'terminal',
    idempotencyKey: `self-improvement:${proposal.id}:${program.revision}`,
  });
  if (!task) throw new Error('Autonomous queue is full; self-improvement proposal was not queued.');
  if (!['pending', 'running'].includes(task.status)) {
    proposal.status = 'review_required';
    proposal.taskId = undefined;
    proposal.localAdminAuthorizedAt = undefined;
    proposal.evaluation = {
      ...evaluation,
      decision: 'review_required',
      authorized: false,
      reasons: unique([
        ...evaluation.reasons,
        'The previous task with this idempotency key is terminal; a fresh proposal and local queue admission are required.',
      ]),
      requiredGates: unique([...evaluation.requiredGates, 'fresh_proposal_revision', 'local_admin_queue_admission']),
    };
    proposal.updatedAt = nowIso();
    state.proposals[index] = proposal;
    await writeState(state);
    throw new Error(`An earlier self-improvement task with this idempotency key is already terminal (${task.status}); create a new proposal revision instead of reporting it as queued.`);
  }
  if (
    task.userId !== scope.userId
    || task.idempotencyKey !== `self-improvement:${proposal.id}:${program.revision}`
    || (proposal.taskId && proposal.taskId !== task.id)
  ) {
    throw new Error('The autonomous queue returned a task that is not bound to this exact self-improvement proposal.');
  }
  proposal.status = 'queued';
  proposal.taskId = task.id;
  proposal.localAdminAuthorizedAt = nowIso();
  proposal.evaluation = evaluation;
  proposal.updatedAt = nowIso();
  state.proposals[index] = proposal;
  await writeState(state);
  return { proposal: JSON.parse(JSON.stringify(proposal)), task };
}

export function resetSelfImprovementStateForTests(): void {
  const db = readDB();
  if (!Array.isArray(db.settings)) return;
  db.settings = db.settings.filter((item: any) => item?.key !== SETTINGS_KEY);
  writeDB(db);
}
