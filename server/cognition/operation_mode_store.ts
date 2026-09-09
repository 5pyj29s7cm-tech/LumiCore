import { readDB, writeDB } from '../../db_layer';
import {
  normalizeOperationMode,
  parseStoredOperationMode,
  type OperationMode,
} from './operation_modes';

function preferenceKey(userId: string): string {
  return `op_mode_${userId || 'anonymous'}`;
}

export function getStoredOperationMode(userId: string): OperationMode {
  const db = readDB();
  const setting = (db.settings || []).find((item: any) => item.key === preferenceKey(userId));
  return setting ? parseStoredOperationMode(setting.value) : 'assistant';
}

export function saveStoredOperationMode(userId: string, requestedMode: string): {
  mode: OperationMode;
  autonomyLevel?: 'reactive' | 'semi' | 'full';
} {
  const mode = normalizeOperationMode(requestedMode);
  const db = readDB();
  if (!db.settings) db.settings = [];
  const key = preferenceKey(userId);
  const value = JSON.stringify({ mode });
  const existing = db.settings.findIndex((item: any) => item.key === key);
  if (existing >= 0) db.settings[existing].value = value;
  else db.settings.push({ key, value });
  writeDB(db);

  // Compatibility state must never rewrite background-work authorization or budgets.
  return { mode };
}
