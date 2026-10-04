import { randomUUID } from 'node:crypto';
import { readSetting, updateSetting } from '../persistence/settings_repository';

const REVISION_FIELD = '_modelRoleRevisions';

function revisionsFrom(value: unknown): Record<string, string> {
  try {
    const raw = typeof value === 'string' ? JSON.parse(value) : value;
    const revisions = raw?.[REVISION_FIELD];
    if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)) return {};
    return Object.fromEntries(Object.entries(revisions).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string' && entry[1].length > 0
    )));
  } catch { return {}; }
}

/** Opaque, persisted write identities also distinguish same-value and ABA saves. */
export function getModelPreferenceRevision(key: string, role: string): string | undefined {
  return revisionsFrom(readSetting(key))[role];
}

/** All model preference writers use this boundary, including single-role UI saves.
 * A whole-row writer claims every role it replaces; a partial writer must merge
 * with the current value and claim both explicitly saved and changed roles. */
export function writeModelPreference(
  key: string,
  value: object,
  roles: readonly string[],
  obsoleteKeys: readonly string[] = [],
): void {
  updateSetting(key, previous => {
    const revisions = revisionsFrom(previous);
    for (const role of roles) revisions[role] = randomUUID();
    return JSON.stringify({ ...value, [REVISION_FIELD]: revisions });
  }, obsoleteKeys);
}
