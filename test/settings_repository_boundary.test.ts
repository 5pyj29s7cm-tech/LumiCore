import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  database: { settings: [] as Array<{ key: string; value: string }> },
  refuseWrites: false,
  flush: vi.fn<() => Promise<void>>(),
}));
vi.mock('../db_layer', () => ({
  readDB: () => state.database,
  flushDBOrThrow: () => state.flush(),
  writeDB: (database: typeof state.database) => {
    if (state.refuseWrites) throw new Error('Database is closing');
    state.database = database;
  },
}));
import { readSettingRecord, updateSetting, updateSettings, writeSetting, writeSettingDurably } from '../server/persistence/settings_repository';

beforeEach(() => {
  state.database = { settings: [{ key: 'model', value: 'old' }, { key: 'other-owner', value: 'untouched' }] };
  state.refuseWrites = false;
  state.flush.mockReset().mockResolvedValue(undefined);
});

it('does not change live rows or remove legacy settings when the database refuses a write', () => {
  const live = state.database;
  state.refuseWrites = true;
  expect(() => updateSetting('model', () => 'new', ['other-owner'])).toThrow('Database is closing');
  expect(state.database).toBe(live);
  expect(state.database.settings).toEqual([{ key: 'model', value: 'old' }, { key: 'other-owner', value: 'untouched' }]);
});

it('returns detached records and replaces only the selected row when saving or deleting', () => {
  const record = readSettingRecord('model')!;
  (record as { value: string }).value = 'caller mutation';
  expect(readSettingRecord('model')?.value).toBe('old');
  writeSetting('model', 'new');
  writeSetting('model', undefined);
  expect(state.database.settings).toEqual([{ key: 'other-owner', value: 'untouched' }]);
});

it('keeps a multi-row settings transaction atomic when validation or persistence fails', () => {
  const before = state.database;
  expect(() => updateSettings(['model'], () => ({ model: 'new', 'other-owner': 'bad' }))).toThrow('selected keys');
  expect(state.database).toBe(before);
  state.refuseWrites = true;
  expect(() => updateSettings(['model', 'selection'], () => ({ model: 'new', selection: 'new' }))).toThrow('closing');
  expect(state.database).toBe(before);
});

it('restores a failed durable write without losing an unrelated owner update', async () => {
  state.flush.mockImplementationOnce(async () => {
    writeSetting('other-owner', 'concurrent'); throw new Error('Disk full');
  });
  await expect(writeSettingDurably('model', 'failed')).rejects.toThrow('Disk full');
  expect(readSettingRecord('model')?.value).toBe('old');
  expect(readSettingRecord('other-owner')?.value).toBe('concurrent');
});

it('does not roll back a newer write to the same setting after an earlier flush fails', async () => {
  state.flush.mockImplementationOnce(async () => {
    writeSetting('model', 'newer'); throw new Error('Disk full');
  });
  await expect(writeSettingDurably('model', 'failed')).rejects.toThrow('Disk full');
  expect(readSettingRecord('model')?.value).toBe('newer');
});
