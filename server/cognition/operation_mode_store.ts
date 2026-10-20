import { normalizeDesktopExecutionPreference, type DesktopExecutionPreference } from '../../shared/operation_modes';
import { readSetting, writeSetting, writeSettingDurably } from '../persistence/settings_repository';
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

export function getStoredDesktopExecutionPreference(userId: string): DesktopExecutionPreference {
  try {
    const raw = readSetting('desktop_execution_' + userId);
    return normalizeDesktopExecutionPreference(raw ? JSON.parse(raw)?.preference : undefined);
  } catch { return 'internal'; }
}

export async function saveStoredDesktopExecutionPreference(userId: string, preference: DesktopExecutionPreference): Promise<DesktopExecutionPreference> {
  if (preference !== 'internal' && preference !== 'external') throw new Error('Invalid desktop execution preference');
  await writeSettingDurably('desktop_execution_' + userId, JSON.stringify({ preference }));
  return preference;
}
