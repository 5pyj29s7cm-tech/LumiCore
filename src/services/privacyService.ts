import { apiFetch } from './apiClient';

export type PrivacyMode = 'standard' | 'strict';
export interface PrivacySettingsState {
  mode: PrivacyMode;
  configuredMode: PrivacyMode;
  locked: boolean;
  canManage: boolean;
  restartRequired: boolean;
}

function parsePrivacyState(value: any): PrivacySettingsState {
  const isMode = (mode: unknown): mode is PrivacyMode => mode === 'standard' || mode === 'strict';
  if (!value || !isMode(value.mode) || !isMode(value.configuredMode)
    || typeof value.locked !== 'boolean' || typeof value.canManage !== 'boolean'
    || typeof value.restartRequired !== 'boolean') {
    throw new Error('Privacy settings response is invalid');
  }
  return {
    mode: value.mode,
    configuredMode: value.configuredMode,
    locked: value.locked,
    canManage: value.canManage,
    restartRequired: value.restartRequired,
  };
}

async function requestPrivacyState(init: RequestInit): Promise<PrivacySettingsState> {
  const response = await apiFetch('/api/privacy', { cache: 'no-store', ...init });
  if (!response.ok) throw new Error(`Privacy settings request failed (${response.status})`);
  return parsePrivacyState(await response.json());
}

export function getPrivacySettings(signal?: AbortSignal) {
  return requestPrivacyState({ signal });
}

export function updatePrivacySettings(mode: PrivacyMode, signal?: AbortSignal) {
  return requestPrivacyState({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
    signal,
  });
}
