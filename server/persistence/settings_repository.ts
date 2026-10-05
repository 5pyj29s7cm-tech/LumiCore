import { flushDBOrThrow, readDatabaseTables, commitDatabaseTables } from '../../db_layer';

/** Settings consumers receive values, never the live database or mutable rows. */
export function readSetting(key: string): string | undefined {
  return (readDatabaseTables(["settings"]).settings || []).find(row => row.key === key)?.value;
}

export function readSettingRecord(key: string): Readonly<{ key: string; value: string }> | undefined {
  const value = readSetting(key);
  return value === undefined ? undefined : { key, value };
}

export function readSettingJson<T = any>(key: string, fallback: T | null = null): T | null {
  try {
    const value = readSetting(key);
    return value ? JSON.parse(value) : fallback;
  } catch { return fallback; }
}

/** Stage every selected row before commitDatabaseTables accepts the transaction. */
export function updateSettings(
  keys: readonly string[],
  update: (previous: Readonly<Record<string, string | undefined>>) => Record<string, string | undefined>,
): void {
  const db = readDatabaseTables(["settings"]);
  const selected = new Set(keys);
  const previous = Object.fromEntries(keys.map(key => [key, (db.settings || []).find(row => row.key === key)?.value]));
  const changes = update(Object.freeze(previous));
  if (Object.keys(changes).some(key => !selected.has(key))) throw new Error('Setting update exceeds selected keys');
  const settings = (db.settings || []).filter(row => !Object.hasOwn(changes, row.key));
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) settings.push({ ...(db.settings || []).find(row => row.key === key), key, value });
  }
  commitDatabaseTables({ ...db, settings });
}

export function updateSetting(
  key: string,
  update: (previous: string | undefined) => string | undefined,
  obsoleteKeys: readonly string[] = [],
): void {
  updateSettings([key, ...obsoleteKeys], previous => ({
    ...Object.fromEntries(obsoleteKeys.map(obsolete => [obsolete, undefined])),
    [key]: update(previous[key]),
  }));
}

export function writeSetting(key: string, value: string | undefined): void {
  updateSetting(key, () => value);
}

/** Restore a failed durable write only while this value is still current. */
export async function writeSettingDurably(key: string, value: string | undefined): Promise<void> {
  const previous = readSetting(key);
  writeSetting(key, value);
  try { await flushDBOrThrow(); }
  catch (error) {
    try {
      if (readSetting(key) === value) {
        writeSetting(key, previous);
        await flushDBOrThrow();
      }
    } catch { /* The original persistence failure remains the caller's result. */ }
    throw error;
  }
}
