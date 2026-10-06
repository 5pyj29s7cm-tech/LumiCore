import React, { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { toast } from "sonner";
import { useApp } from "@/contexts/AppContext";
import { getSavedKeyStatus, saveServerKeys } from "@/services/settingsKeys";
import { apiFetch, apiJson } from "@/services/apiClient";
import { formatUiMessage, uiMessage, type UiMessageKey } from "../../i18n/uiMessages";
import type { ProviderTestState } from './components';

export async function runModelConnectionTest(kind: 'llm' | 'llm/route' | 'vision', provider?: string, model = '', signal?: AbortSignal): Promise<{ latencyMs: number; model: string }> {
  const response = await apiFetch(`/api/${kind}/test`, {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...(kind === 'llm/route' ? {} : { body: JSON.stringify({ provider, model }) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    const label = { llm: 'Connection', 'llm/route': 'Route', vision: 'Vision' }[kind];
    throw new Error(data.error || `${label} test failed (${response.status})`);
  }
  return { latencyMs: Number(data.latencyMs) || 0, model: data.model || model };
}

export type OfficialRoleReceipt = {
  role: string;
  status: 'applied' | 'skipped' | 'failed';
  provider?: string;
  model?: string;
  reason?: string;
};

export type OfficialRoleApplyResponse = {
  ok: boolean;
  code?: string;
  error?: string;
  applied: OfficialRoleReceipt[];
  skipped: OfficialRoleReceipt[];
  failed: Array<{ role: string; reason: string }>;
  roles: Record<string, OfficialRoleReceipt>;
};

export async function applyOfficialModelRoles(signal: AbortSignal): Promise<OfficialRoleApplyResponse> {
  const response = await apiFetch('/api/preferences/official/apply', {
    signal, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({}),
  });
  const data = await response.json().catch(() => ({}));
  const responseCode = typeof data.code === 'string' ? data.code : undefined;
  if (!response.ok && responseCode !== 'OFFICIAL_API_NOT_CONFIGURED') {
    throw new Error(data.error || `Official API adaptation failed (${response.status})`);
  }
  const normalizeReceipts = (value: unknown, fallbackStatus: OfficialRoleReceipt['status']): OfficialRoleReceipt[] => {
    if (!Array.isArray(value)) return [];
    return value.map((item: any) => {
      if (typeof item === 'string') return { role: item, status: fallbackStatus };
      return {
        role: String(item?.role || ''),
        status: item?.status === 'failed' || item?.status === 'skipped' || item?.status === 'applied'
          ? item.status
          : fallbackStatus,
        ...(item?.provider ? { provider: String(item.provider) } : {}),
        ...(item?.model ? { model: String(item.model) } : {}),
        ...(item?.reason ? { reason: String(item.reason) } : {}),
      };
    }).filter(item => item.role);
  };
  const applied = normalizeReceipts(data.applied, 'applied');
  const skipped = normalizeReceipts(data.skipped, 'skipped');
  const roles: Record<string, OfficialRoleReceipt> = {};
  if (data.roles && typeof data.roles === 'object' && !Array.isArray(data.roles)) {
    for (const [role, item] of Object.entries(data.roles as Record<string, any>)) {
      if (!item || typeof item !== 'object') continue;
      roles[role] = {
        role,
        status: item.status === 'failed' || item.status === 'skipped' || item.status === 'applied' ? item.status : 'skipped',
        ...(item.provider ? { provider: String(item.provider) } : {}),
        ...(item.model ? { model: String(item.model) } : {}),
        ...(item.reason ? { reason: String(item.reason) } : {}),
      };
    }
  }
  [...applied, ...skipped].forEach(item => { if (!roles[item.role]) roles[item.role] = item; });
  return {
    ok: data.ok === true,
    code: responseCode,
    error: typeof data.error === 'string' ? data.error : undefined,
    applied,
    skipped,
    failed: Array.isArray(data.failed)
      ? data.failed.map((item: any) => ({ role: String(item?.role || ''), reason: String(item?.reason || '') }))
      : [],
    roles,
  };
}

export function useModelOperation(scope = '') {
  const { user } = useApp();
  const request = useRef<AbortController | null>(null);
  const [result, setResult] = useState({ state: 'idle' as ProviderTestState | 'saving', message: '' });
  const reset = useCallback(() => {
    request.current?.abort(); request.current = null;
    setResult({ state: 'idle', message: '' });
  }, []);
  useEffect(() => { reset(); return () => request.current?.abort(); }, [scope, user?.uid, reset]);
  const run = async (state: 'testing' | 'saving', action: (signal: AbortSignal) => Promise<string | false>, failureKey: UiMessageKey = 'settings.live-call-failed.cd19d46055') => {
    if (request.current) return false;
    const owner = new AbortController(); request.current = owner;
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(state === 'saving' ? 15_000 : 60_000)]);
    setResult({ state, message: '' });
    try {
      const message = await action(signal);
      if (owner.signal.aborted) return false;
      signal.throwIfAborted();
      setResult({ state: message === false ? 'error' : 'ok', message: message || '' });
      if (state === 'saving' && message) toast.success(message);
      return message !== false;
    } catch (error: any) {
      if (!owner.signal.aborted) {
        const message = error?.message || uiMessage(failureKey);
        setResult({ state: 'error', message });
        if (state === 'saving') toast.error(message);
      }
      return false;
    } finally { if (request.current === owner) request.current = null; }
  };
  return { ...result, reset, run, busy: result.state === 'saving' || result.state === 'testing', saving: result.state === 'saving', testing: result.state === 'testing' };
}

export function useServerCredentials(storageKey: string, t?: any) {
  const [status, setStatus] = useState<Record<string, boolean> | null>(null);
  const [loadError, setLoadError] = useState(''), [attempt, setAttempt] = useState(0);
  const operation = useModelOperation(storageKey);
  useEffect(() => {
    const owner = new AbortController(), signal = AbortSignal.any([owner.signal, AbortSignal.timeout(15_000)]);
    try { localStorage.removeItem(storageKey); } catch {}
    setStatus(null); setLoadError('');
    getSavedKeyStatus(signal)
      .then(data => { signal.throwIfAborted(); setStatus(data); })
      .catch(error => { if (!owner.signal.aborted) setLoadError(error?.message || String(error)); });
    return () => owner.abort();
  }, [storageKey, attempt]);
  const changeKeys = (keys: Record<string, string>, remove: boolean, confirmed: () => void) => {
    if (!status) return;
    return operation.run('saving', async signal => {
      const result = await saveServerKeys(keys, signal);
      signal.throwIfAborted(); setStatus(result.status); confirmed();
      return remove ? (t?.apiKeyRemoved || uiMessage('settings.api-key-removed.bae3220b94')) : (t?.apiKeySaved || uiMessage('settings.api-key-saved.a1dc4d42fb'));
    }, remove ? 'settings.failed-to-remove-key.065616ae8b' : 'settings.failed-to-save-key-to.be32a67a8a');
  };
  return { status, loadError, reload: () => setAttempt(value => value + 1), operation, changeKeys };
}

export function useModelSettings<T extends Record<string, any>>(endpoint: string, initial: T, loadErrorKey: UiMessageKey) {
  const { user } = useApp();
  const [value, setValue] = useState(initial), [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState({ uid: user?.uid, ready: false, error: '' });
  const defaults = useRef(initial), operation = useModelOperation();
  const request = useCallback(async (signal: AbortSignal, draft?: T) => {
    const data = await apiJson<T>(endpoint, { signal, ...(draft ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) } : {}) });
    signal.throwIfAborted();
    if (!matchesModelSettings(defaults.current, data)) throw new Error('Model settings confirmation missing or invalid');
    return data;
  }, [endpoint]);
  useEffect(() => {
    const owner = new AbortController(); setLoad({ uid: user?.uid, ready: false, error: '' });
    void request(AbortSignal.any([owner.signal, AbortSignal.timeout(15_000)]))
      .then(data => { if (!owner.signal.aborted) { setValue(data); setLoad({ uid: user?.uid, ready: true, error: '' }); } })
      .catch(error => { if (!owner.signal.aborted) setLoad({ uid: user?.uid, ready: false, error: error?.message || uiMessage(loadErrorKey) }); });
    return () => owner.abort();
  }, [request, user?.uid, loadErrorKey, attempt]);
  const ready = load.uid === user?.uid && load.ready;
  return { value, ready, error: load.uid === user?.uid ? load.error : '', reload: () => setAttempt(current => current + 1), operation,
    edit: (next: React.SetStateAction<T>) => { operation.reset(); setValue(next); },
    persist: async (signal: AbortSignal) => { if (!ready) throw new Error(uiMessage(loadErrorKey)); const data = await request(signal, value); setValue(data); return data; },
  };
}

export function matchesModelSettings(expected: any, value: any): boolean {
  if (typeof expected !== 'object') return typeof value === typeof expected && (typeof value !== 'number' || Number.isFinite(value));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(expected).every(([key, sample]) => key === 'models'
    ? value.models && typeof value.models === 'object' && !Array.isArray(value.models) && Object.values(value.models).every(model => typeof model === 'string')
    : matchesModelSettings(sample, value[key]));
}

export function ModelSettingsStatus({ error, retry }: { error: string; retry: () => void }) {
  return <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-sm text-white/55">
    {error ? <><p role="alert">{error}</p><Button onClick={retry}>{uiMessage('knowledge-base.retry.9db2a8180b')}</Button></> : <Loader2 className="animate-spin text-white/45" />}
  </div>;
}

export function useProviderModel(providerId: string, defaultModel: string, testScope: string) {
  const { aiConfig, updateAIConfig, user } = useApp();
  const savedModel = aiConfig.models?.[providerId] || (aiConfig.provider === providerId ? aiConfig.model : '') || defaultModel;
  const scope = JSON.stringify([providerId, user?.uid]);
  const [model, setModel] = useState(savedModel);
  const confirmed = useRef({ model, revision: 0, scope });
  const revision = useRef(0), lifetime = useRef<AbortController | null>(null);
  const test = useModelOperation(JSON.stringify([providerId, model, testScope]));
  const resetTest = test.reset;
  useEffect(() => {
    const previous = confirmed.current;
    confirmed.current = { ...previous, model: savedModel, scope };
    setModel(draft => previous.scope !== scope || draft === previous.model ? savedModel : draft);
  }, [savedModel, scope]);
  useEffect(() => { const owner = new AbortController(); lifetime.current = owner; return () => owner.abort(); }, [providerId, user?.uid]);
  const changeModel = async (nextModel: string) => {
    const owner = lifetime.current, current = ++revision.current;
    setModel(nextModel); resetTest();
    const saved = await updateAIConfig(aiConfig.provider === providerId ? { model: nextModel } : {}, { [providerId]: nextModel }).catch(() => false);
    if (!owner || owner.signal.aborted) return;
    if (saved && current > confirmed.current.revision) confirmed.current = { model: nextModel, revision: current, scope };
    if (!saved && current === revision.current) setModel(confirmed.current.model);
  };
  const testModel = () => model.trim() && test.run('testing', async signal => {
    const result = await runModelConnectionTest('llm', providerId, model.trim(), signal);
    return formatUiMessage('settings.live-call-passed-value0-ms.9f3242a245', { value0: result.latencyMs });
  });
  return { model, changeModel, testModel, resetTest, testState: test.state, testMessage: test.message };
}
