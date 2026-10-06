import type { GeneratedSkillDraftReview } from './contracts';
import { validateGeneratedSkillProtocolStructure } from './protocol_validation';
import { normalizeStringList, computeGeneratedSkillArtifactHash } from './artifact_hash';
import { buildDraftPackageJson } from './manifest_validation';

export function inspectGeneratedSkillSource(source: string): {
  permissions: string[];
  sideEffects: string[];
  risk: GeneratedSkillDraftReview['risk'];
  findings: string[];
} {
  return {
    permissions: [],
    sideEffects: [],
    risk: 'low',
    findings: validateGeneratedSkillProtocolStructure(source),
  };
}

export function normalizeRisk(
  declared: unknown,
  inferred: GeneratedSkillDraftReview['risk'],
): GeneratedSkillDraftReview['risk'] {
  const ranks = { low: 0, medium: 1, high: 2 } as const;
  const requested = String(declared || '').toLowerCase() as keyof typeof ranks;
  if (!(requested in ranks)) return inferred;
  return ranks[requested] > ranks[inferred] ? requested : inferred;
}

export function buildGeneratedSkillDraftReview(input: {
  source: string;
  manifestSource?: string;
  lockfileSource?: string;
  generatedAt: string;
  declaredPermissions?: unknown;
  declaredSideEffects?: unknown;
  declaredRisk?: unknown;
  validationPassed: boolean;
}): GeneratedSkillDraftReview {
  const inspection = inspectGeneratedSkillSource(input.source);
  const declaredPermissions = normalizeStringList(input.declaredPermissions);
  const declaredSideEffects = normalizeStringList(input.declaredSideEffects);
  const declarationFindings = [
    ...(declaredPermissions.length > 0
      ? ['Generated skill drafts cannot declare host permissions; only pure computation and in-memory data transformation are allowed.']
      : []),
    ...(declaredSideEffects.length > 0
      ? ['Generated skill drafts cannot declare side effects; only pure computation and in-memory data transformation are allowed.']
      : []),
  ];
  const findings = Array.from(new Set([
    ...inspection.findings,
    ...declarationFindings,
  ]));
  return {
    status: 'draft',
    generatedAt: input.generatedAt,
    contentHash: computeGeneratedSkillArtifactHash(
      input.source,
      input.manifestSource,
      input.lockfileSource,
    ),
    permissions: Array.from(new Set([
      ...declaredPermissions,
      ...inspection.permissions,
    ])).sort((left, right) => left.localeCompare(right)),
    sideEffects: Array.from(new Set([
      ...declaredSideEffects,
      ...inspection.sideEffects,
    ])).sort((left, right) => left.localeCompare(right)),
    risk: normalizeRisk(input.declaredRisk, inspection.risk),
    evidence: {
      kind: 'protocol_structure_validation',
      assurance: 'non_executing',
      limitations: [
        'No generated handler code was executed before approval; domain behavior is verified only after approved installation and activation.',
      ],
    },
    staticCheck: {
      passed: findings.length === 0,
      findings,
    },
    trialRun: {
      passed: input.validationPassed,
      note: input.validationPassed
        ? 'The non-executing protocol structure and locked dependency validation passed.'
        : 'The non-executing protocol structure and locked dependency validation have not passed.',
    },
    requiresUserApproval: true,
  };
}

export function assembleReviewedDraftPackage(input: {
  skillName: string;
  toolDescription: string;
  generatedFrom: string;
  generatedAt: string;
  source: string;
  lockfileSource: string;
  review: GeneratedSkillDraftReview;
}): { packageJson: string; review: GeneratedSkillDraftReview } {
  const reviewWithoutHash: GeneratedSkillDraftReview = {
    ...input.review,
    contentHash: '',
  };
  const manifestForHash = buildDraftPackageJson({
    skillName: input.skillName,
    toolDescription: input.toolDescription,
    generatedFrom: input.generatedFrom,
    generatedAt: input.generatedAt,
    review: reviewWithoutHash,
  });
  const review: GeneratedSkillDraftReview = {
    ...reviewWithoutHash,
    contentHash: computeGeneratedSkillArtifactHash(
      input.source,
      manifestForHash,
      input.lockfileSource,
    ),
  };
  return {
    review,
    packageJson: buildDraftPackageJson({
      skillName: input.skillName,
      toolDescription: input.toolDescription,
      generatedFrom: input.generatedFrom,
      generatedAt: input.generatedAt,
      review,
    }),
  };
}
