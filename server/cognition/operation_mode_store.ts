import { readSetting, writeSetting } from '../persistence/settings_repository';
import {
  normalizeOperationMode,
  parseStoredOperationMode,
  type OperationMode,
} from './operation_modes';

function preferenceKey(userId: string): string {
  return `op_mode_${userId || 'anonymous'}`;
}

export function getStoredOperationMode(userId: string): OperationMode {
  const value = readSetting(preferenceKey(userId));
  return value === undefined ? 'assistant' : parseStoredOperationMode(value);
}

export function saveStoredOperationMode(userId: string, requestedMode: string): {
  mode: OperationMode;
  autonomyLevel?: 'reactive' | 'semi' | 'full';
} {
  const mode = normalizeOperationMode(requestedMode);
  writeSetting(preferenceKey(userId), JSON.stringify({ mode }));

  // Compatibility state must never rewrite background-work authorization or budgets.
  return { mode };
}
