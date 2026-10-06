import fs from "fs";
import path from "path";
import { SKILLS_DIR } from "../../mcp/client";
import { getDataPath } from "../../config/data_path";

export const SKILLS_DIR_PATH = SKILLS_DIR;

export const SKILL_DRAFTS_DIR = getDataPath('skill-drafts');

export function comparablePath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

/**
 * Classify by the trusted storage boundary, not by attacker-editable manifest
 * flags. A damaged or stripped manifest inside this directory must still take
 * the generated-draft approval path and fail closed during strict validation.
 */
export function isGeneratedSkillDraftLocation(directory: string): boolean {
  const requested = path.resolve(String(directory || '').trim());
  const draftsRoot = path.resolve(SKILL_DRAFTS_DIR);
  if (comparablePath(path.dirname(requested)) === comparablePath(draftsRoot)) return true;
  try {
    const resolvedDraft = fs.realpathSync(requested);
    const resolvedRoot = fs.realpathSync(draftsRoot);
    return comparablePath(path.dirname(resolvedDraft)) === comparablePath(resolvedRoot);
  } catch {
    return false;
  }
}

export function allocateDraftDirectory(skillName: string, generatedAt: string): string {
  const suffix = generatedAt.replace(/[:.]/g, '-');
  const preferred = path.join(SKILL_DRAFTS_DIR, `${skillName}-${suffix}`);
  if (!fs.existsSync(preferred)) return preferred;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${preferred}-${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate a draft directory for "${skillName}".`);
}
