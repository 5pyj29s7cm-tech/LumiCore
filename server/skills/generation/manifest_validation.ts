import fs from "fs";
import path from "path";
import { SKILL_DRAFTS_DIR } from './paths';
import { GENERATED_SKILL_REQUIRED_FILES, GENERATED_SKILL_TOP_LEVEL_ENTRIES, GENERATED_SKILL_TOP_LEVEL_FIELDS, GENERATED_SKILL_DEPENDENCIES, GENERATED_SKILL_LUMI_FIELDS, GENERATED_SKILL_REVIEW_FIELDS, GENERATED_SKILL_EVIDENCE_FIELDS, GENERATED_SKILL_STATIC_CHECK_FIELDS, GENERATED_SKILL_TRIAL_RUN_FIELDS } from './authoring_contract';
import { canonicalJson } from './artifact_hash';
import type { GeneratedSkillDraftReview } from './contracts';
import { PACKAGE_TEMPLATE, escapeJsonString } from './templates';

export function isPlainJsonObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function hasOnlyFields(value: Record<string, any>, allowed: Set<string>): boolean {
  return Object.keys(value).every(field => allowed.has(field));
}

export function validateGeneratedDraftBoundary(directory: string): string[] {
  const errors: string[] = [];
  const requested = path.resolve(String(directory || '').trim());
  const draftsRoot = path.resolve(SKILL_DRAFTS_DIR);
  let resolvedRoot = '';
  let resolvedDraft = '';
  try {
    const rootMetadata = fs.lstatSync(draftsRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      return ['The formal generated-skill drafts root must be a real directory.'];
    }
    resolvedRoot = fs.realpathSync(draftsRoot);
    const draftMetadata = fs.lstatSync(requested);
    if (!draftMetadata.isDirectory() || draftMetadata.isSymbolicLink()) {
      return ['The generated skill draft root cannot be a symbolic link or junction.'];
    }
    resolvedDraft = fs.realpathSync(requested);
  } catch {
    return ['The generated skill draft root is missing or inaccessible.'];
  }

  const relative = path.relative(resolvedRoot, resolvedDraft);
  if (
    !relative
    || relative.startsWith('..')
    || path.isAbsolute(relative)
    || relative.includes(path.sep)
  ) {
    errors.push('Generated skill drafts must be direct children of the formal skill-drafts directory.');
    return errors;
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(resolvedDraft, { withFileTypes: true });
  } catch {
    return ['The generated skill draft directory cannot be read.'];
  }
  const entryNames = new Set(entries.map(entry => entry.name));
  for (const required of GENERATED_SKILL_REQUIRED_FILES) {
    if (!entryNames.has(required)) {
      errors.push(`Generated skill artifact is missing: ${required}.`);
    }
  }
  for (const entry of entries) {
    if (!GENERATED_SKILL_TOP_LEVEL_ENTRIES.has(entry.name)) {
      errors.push(`Generated skill draft contains an unsupported top-level entry: ${entry.name}.`);
      continue;
    }
    const entryPath = path.join(resolvedDraft, entry.name);
    try {
      const metadata = fs.lstatSync(entryPath);
      if (metadata.isSymbolicLink()) {
        errors.push(`Generated skill artifact cannot be a symbolic link or junction: ${entry.name}.`);
      } else if (entry.name === 'node_modules') {
        if (!metadata.isDirectory()) {
          errors.push('Generated skill node_modules must be a real directory when present.');
        }
      } else if (!metadata.isFile()) {
        errors.push(`Generated skill artifact must be a regular file: ${entry.name}.`);
      }
    } catch {
      errors.push(`Generated skill artifact is inaccessible: ${entry.name}.`);
    }
  }
  return errors;
}

export function validateGeneratedDraftManifest(
  directory: string,
  expectedSkillName: string,
): { manifestSource: string; lockfileSource: string; errors: string[] } {
  const errors: string[] = [];
  const manifestPath = path.join(directory, 'package.json');
  const lockfilePath = path.join(directory, 'package-lock.json');

  let manifestSource = '';
  let manifest: Record<string, any> | null = null;
  try {
    manifestSource = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(manifestSource);
    if (!isPlainJsonObject(parsed)) throw new Error('manifest must be an object');
    manifest = parsed;
  } catch {
    errors.push('The generated draft package manifest is invalid.');
    return { manifestSource, lockfileSource: '', errors };
  }

  const unexpectedFields = Object.keys(manifest)
    .filter(field => !GENERATED_SKILL_TOP_LEVEL_FIELDS.has(field));
  if (unexpectedFields.length > 0) {
    errors.push(`Generated draft manifest contains unsupported executable fields: ${unexpectedFields.join(', ')}.`);
  }
  if (manifest.name !== `lumi-skill-${expectedSkillName}`) {
    errors.push('Generated draft package name no longer matches the reviewed skill.');
  }
  if (manifest.version !== '1.0.0' || manifest.type !== 'module' || manifest.main !== 'index.ts') {
    errors.push('Generated draft entrypoint metadata no longer matches the reviewed template.');
  }
  if (typeof manifest.description !== 'string') {
    errors.push('Generated draft description must be a string.');
  }
  const scripts = isPlainJsonObject(manifest.scripts) ? manifest.scripts : {};
  if (
    Object.keys(scripts).length !== 1
    || scripts.start !== 'npx --no-install tsx index.ts'
  ) {
    errors.push('Generated draft lifecycle scripts changed after review.');
  }
  const dependencies = isPlainJsonObject(manifest.dependencies)
    ? manifest.dependencies
    : {};
  if (canonicalJson(dependencies) !== canonicalJson(GENERATED_SKILL_DEPENDENCIES)) {
    errors.push('Generated draft dependencies changed after review.');
  }
  const lumi = isPlainJsonObject(manifest.lumi) ? manifest.lumi : {};
  const unexpectedLumiFields = Object.keys(lumi)
    .filter(field => !GENERATED_SKILL_LUMI_FIELDS.has(field));
  if (unexpectedLumiFields.length > 0) {
    errors.push(`Generated draft lumi metadata contains unsupported fields: ${unexpectedLumiFields.join(', ')}.`);
  }
  if (
    lumi.autoGenerated !== true
    || lumi.status !== 'draft'
    || lumi.skillName !== expectedSkillName
    || lumi.toolCount !== 1
    || typeof lumi.generatedFrom !== 'string'
    || typeof lumi.installedAt !== 'string'
  ) {
    errors.push('Generated draft identity metadata no longer matches the reviewed skill.');
  }
  const review = isPlainJsonObject(lumi.draftReview) ? lumi.draftReview : {};
  const unexpectedReviewFields = Object.keys(review)
    .filter(field => !GENERATED_SKILL_REVIEW_FIELDS.has(field));
  if (unexpectedReviewFields.length > 0) {
    errors.push(`Generated draft review contains unsupported fields: ${unexpectedReviewFields.join(', ')}.`);
  }
  const evidence = isPlainJsonObject(review.evidence) ? review.evidence : {};
  const staticCheck = isPlainJsonObject(review.staticCheck) ? review.staticCheck : {};
  const trialRun = isPlainJsonObject(review.trialRun) ? review.trialRun : {};
  if (
    review.status !== 'draft'
    || typeof review.generatedAt !== 'string'
    || review.generatedAt !== lumi.installedAt
    || review.requiresUserApproval !== true
    || !/^[a-f0-9]{64}$/i.test(String(review.contentHash || ''))
    || !isStringList(review.permissions)
    || !isStringList(review.sideEffects)
    || !['low', 'medium', 'high'].includes(String(review.risk || ''))
    || !hasOnlyFields(evidence, GENERATED_SKILL_EVIDENCE_FIELDS)
    || evidence.kind !== 'protocol_structure_validation'
    || evidence.assurance !== 'non_executing'
    || !isStringList(evidence.limitations)
    || !hasOnlyFields(staticCheck, GENERATED_SKILL_STATIC_CHECK_FIELDS)
    || typeof staticCheck.passed !== 'boolean'
    || !isStringList(staticCheck.findings)
    || !hasOnlyFields(trialRun, GENERATED_SKILL_TRIAL_RUN_FIELDS)
    || typeof trialRun.passed !== 'boolean'
    || typeof trialRun.note !== 'string'
  ) {
    errors.push('Generated draft review metadata is incomplete or invalid.');
  }

  let lockfileSource = '';
  try {
    lockfileSource = fs.readFileSync(lockfilePath, 'utf8');
    const parsedLock = JSON.parse(lockfileSource);
    if (!isPlainJsonObject(parsedLock)) throw new Error('lockfile must be an object');
    const rootPackage = isPlainJsonObject(parsedLock.packages?.[''])
      ? parsedLock.packages['']
      : null;
    if (
      ![2, 3].includes(Number(parsedLock.lockfileVersion))
      || parsedLock.name !== manifest.name
      || parsedLock.version !== manifest.version
      || !rootPackage
      || rootPackage.name !== manifest.name
      || rootPackage.version !== manifest.version
      || canonicalJson(rootPackage.dependencies || {}) !== canonicalJson(GENERATED_SKILL_DEPENDENCIES)
    ) {
      errors.push('The generated draft dependency lockfile does not match package.json.');
    }
  } catch {
    lockfileSource = '';
    errors.push('The generated draft dependency lockfile is missing or invalid.');
  }
  return { manifestSource, lockfileSource, errors };
}

export function buildDraftPackageJson(input: {
  skillName: string;
  toolDescription: string;
  generatedFrom: string;
  generatedAt: string;
  review: GeneratedSkillDraftReview;
}): string {
  return PACKAGE_TEMPLATE
    .replace(/{skillName}/g, input.skillName)
    .replace(/{toolDescription}/g, () => escapeJsonString(input.toolDescription))
    .replace(/{generatedFrom}/g, () => escapeJsonString(input.generatedFrom))
    .replace(/{installedAt}/g, input.generatedAt)
    .replace('{draftReview}', JSON.stringify(input.review));
}

export function readGeneratedSkillDraft(directory: string): {
  skillName: string;
  review: GeneratedSkillDraftReview;
} | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (pkg?.lumi?.autoGenerated !== true || pkg?.lumi?.status !== 'draft') return null;
    const skillName = String(pkg?.lumi?.skillName || '').trim();
    const review = pkg?.lumi?.draftReview as GeneratedSkillDraftReview;
    if (!skillName || !review || review.status !== 'draft') return null;
    return { skillName, review };
  } catch {
    return null;
  }
}
