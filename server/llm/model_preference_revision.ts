import { randomUUID } from 'node:crypto';
import { readDB, writeDB } from '../../db_layer';

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
  const row = (readDB().settings || []).find(item => item.key === key);
  return revisionsFrom(row?.value)[role];
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
  const db = readDB();
  const previous = (db.settings || []).find(item => item.key === key);
  const revisions = revisionsFrom(previous?.value);
  for (const role of roles) revisions[role] = randomUUID();
  const row = { key, value: JSON.stringify({ ...value, [REVISION_FIELD]: revisions }) };
  // Do not mutate the live row before writeDB accepts the write (e.g. closing).
  const settings = (db.settings || []).filter(item => !obsoleteKeys.includes(item.key)).slice();
  const index = settings.findIndex(item => item.key === key);
  if (index >= 0) settings[index] = row;
  else settings.push(row);
  writeDB({ ...db, settings });
}
