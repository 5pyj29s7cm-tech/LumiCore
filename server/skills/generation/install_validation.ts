import fs from "fs";
import path from "path";
import os from "os";
import { GENERATED_SKILL_TOP_LEVEL_ENTRIES } from './authoring_contract';
import { computeGeneratedSkillArtifactHash, canonicalJson } from './artifact_hash';
import type { GeneratedSkillDraftReview } from './contracts';
import { validateGeneratedDraftBoundary, readGeneratedSkillDraft, validateGeneratedDraftManifest } from './manifest_validation';
import { buildGeneratedSkillDraftReview } from './review';
import { validateGeneratedSkillProtocolStructure } from './protocol_validation';
import { installLockedSkillDeps } from './dependencies';

export function createGeneratedDraftValidationSnapshot(input: {
  manifestSource: string;
  lockfileSource: string;
  source: string;
  readmeSource: string;
}): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-skill-validated-'));
  try {
    fs.writeFileSync(path.join(directory, 'package.json'), input.manifestSource, 'utf8');
    fs.writeFileSync(path.join(directory, 'package-lock.json'), input.lockfileSource, 'utf8');
    fs.writeFileSync(path.join(directory, 'index.ts'), input.source, 'utf8');
    fs.writeFileSync(path.join(directory, 'README.md'), input.readmeSource, 'utf8');
    return directory;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function snapshotArtifactStillMatches(input: {
  directory: string;
  expectedHash: string;
  expectedReadmeSource: string;
}): boolean {
  try {
    const entries = fs.readdirSync(input.directory, { withFileTypes: true });
    if (entries.some(entry => !GENERATED_SKILL_TOP_LEVEL_ENTRIES.has(entry.name))) return false;
    for (const entry of entries) {
      const metadata = fs.lstatSync(path.join(input.directory, entry.name));
      if (metadata.isSymbolicLink()) return false;
      if (entry.name === 'node_modules' ? !metadata.isDirectory() : !metadata.isFile()) return false;
    }
    return computeGeneratedSkillArtifactHash(
      fs.readFileSync(path.join(input.directory, 'index.ts'), 'utf8'),
      fs.readFileSync(path.join(input.directory, 'package.json'), 'utf8'),
      fs.readFileSync(path.join(input.directory, 'package-lock.json'), 'utf8'),
    ) === input.expectedHash
      && fs.readFileSync(path.join(input.directory, 'README.md'), 'utf8') === input.expectedReadmeSource;
  } catch {
    return false;
  }
}

export async function validateGeneratedSkillDraftForInstall(directory: string): Promise<{
  valid: boolean;
  skillName?: string;
  review?: GeneratedSkillDraftReview;
  /** Clean validated snapshot; the caller must install it immediately, then remove it. */
  validatedDirectory?: string;
  errors: string[];
}> {
  const boundaryErrors = validateGeneratedDraftBoundary(directory);
  if (boundaryErrors.length > 0) return { valid: false, errors: boundaryErrors };
  const draft = readGeneratedSkillDraft(directory);
  if (!draft) return { valid: false, errors: ['The directory is not a generated Lumi skill draft.'] };
  const indexPath = path.join(directory, 'index.ts');
  const manifestValidation = validateGeneratedDraftManifest(directory, draft.skillName);
  if (manifestValidation.errors.length > 0) {
    return {
      valid: false,
      skillName: draft.skillName,
      review: draft.review,
      errors: manifestValidation.errors,
    };
  }
  let source = '';
  let readmeSource = '';
  try {
    source = fs.readFileSync(indexPath, 'utf8');
    readmeSource = fs.readFileSync(path.join(directory, 'README.md'), 'utf8');
  } catch {
    return {
      valid: false,
      skillName: draft.skillName,
      review: draft.review,
      errors: ['The generated draft source artifacts could not be read.'],
    };
  }
  const current = buildGeneratedSkillDraftReview({
    source,
    manifestSource: manifestValidation.manifestSource,
    lockfileSource: manifestValidation.lockfileSource,
    generatedAt: draft.review.generatedAt,
    declaredPermissions: draft.review.permissions,
    declaredSideEffects: draft.review.sideEffects,
    declaredRisk: draft.review.risk,
    // A generated draft has two legitimate reviewed states: the pre-trial
    // package and the final package whose successful trial is itself hashed.
    // Re-validating the latter must reconstruct the same review state before
    // running a fresh trial, otherwise an install-ready draft is spuriously
    // reported as changed after review.
    validationPassed: draft.review.trialRun.passed === true,
  });
  const errors = Array.from(new Set([
    ...current.staticCheck.findings,
    ...validateGeneratedSkillProtocolStructure(source),
  ]));
  const reviewedStaticFacts = {
    permissions: draft.review.permissions,
    sideEffects: draft.review.sideEffects,
    risk: draft.review.risk,
    evidence: draft.review.evidence,
    staticCheck: draft.review.staticCheck,
  };
  const inspectedStaticFacts = {
    permissions: current.permissions,
    sideEffects: current.sideEffects,
    risk: current.risk,
    evidence: current.evidence,
    staticCheck: current.staticCheck,
  };
  if (canonicalJson(reviewedStaticFacts) !== canonicalJson(inspectedStaticFacts)) {
    errors.push('The generated draft review no longer matches the static inspection of its source.');
  }
  if (current.contentHash !== draft.review.contentHash) {
    errors.push('The generated draft changed after review; generate or review it again before installation.');
  }
  if (errors.length > 0) {
    return {
      valid: false,
      skillName: draft.skillName,
      review: current,
      errors,
    };
  }

  let validatedDirectory = '';
  let protocolValidationPassed = false;
  try {
    validatedDirectory = createGeneratedDraftValidationSnapshot({
      manifestSource: manifestValidation.manifestSource,
      lockfileSource: manifestValidation.lockfileSource,
      source,
      readmeSource,
    });
    await installLockedSkillDeps(validatedDirectory);
    if (!snapshotArtifactStillMatches({
      directory: validatedDirectory,
      expectedHash: draft.review.contentHash,
      expectedReadmeSource: readmeSource,
    })) {
      errors.push('The clean generated-skill validation snapshot changed during dependency preparation.');
    }
    protocolValidationPassed = errors.length === 0;
    if (errors.length === 0) {
      // The returned snapshot is the immutable, reviewed four-file artifact.
      // Dependencies are reproduced from its lock in the caller's private
      // install staging directory. Keeping node_modules here both bloats the
      // copy and carries platform-specific .bin symlinks across filesystems.
      fs.rmSync(path.join(validatedDirectory, 'node_modules'), { recursive: true, force: true });
      if (!snapshotArtifactStillMatches({
        directory: validatedDirectory,
        expectedHash: draft.review.contentHash,
        expectedReadmeSource: readmeSource,
      })) {
        errors.push('The clean generated-skill artifact could not be sealed after protocol validation.');
      }
    }
  } catch (error: any) {
    errors.push(`Dependency snapshot preparation failed: ${error?.message || String(error)}`);
  }

  if (errors.length > 0 && validatedDirectory) {
    try { fs.rmSync(validatedDirectory, { recursive: true, force: true }); } catch {}
    validatedDirectory = '';
  }

  return {
    valid: errors.length === 0,
    skillName: draft.skillName,
    ...(validatedDirectory ? { validatedDirectory } : {}),
    review: errors.length === 0 && draft.review.trialRun.passed
      // A final, approved draft must retain the exact hash-bound review. A
      // fresh non-executing validation must not rewrite that evidence while
      // keeping the old contentHash.
      ? draft.review
      : {
          ...current,
          trialRun: {
            passed: protocolValidationPassed,
            note: protocolValidationPassed
              ? 'The non-executing protocol structure and locked dependency validation passed.'
              : 'The non-executing protocol structure or locked dependency validation failed.',
          },
        },
    errors,
  };
}
