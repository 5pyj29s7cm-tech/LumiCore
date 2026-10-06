import React, { useState } from "react";
import { Globe, Loader2, ExternalLink } from "lucide-react";
import { Button } from "../ui/button";
import { useApp } from "@/contexts/AppContext";
import { apiFetch } from "@/services/apiClient";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import { LUMI_OFFICIAL_BASE_URL } from "../../../shared/model_provider_capabilities";
import { useServerCredentials, ModelSettingsStatus } from './model_operations';
import { SettingsDisclosure } from './components';
import { readStoredRelayBaseUrl, LUMI_RELAY_BASE_URL_PLACEHOLDER } from './official_models';

export function ApiKeyField(props: Parameters<typeof ServerApiKeyField>[0]) {
  const { user } = useApp();
  return user ? <ServerApiKeyField key={JSON.stringify([user.uid, user.role, props.serverKey])} {...props} /> : null;
}

export function ServerApiKeyField({ icon, label, placeholder, disabled = false, storageKey, serverKey, hint, consoleUrl, testEndpoint, t }: { icon: React.ReactNode, label: string, placeholder: string, disabled?: boolean, storageKey: string, serverKey: string, hint?: string, consoleUrl?: string, testEndpoint?: string, t?: any }) {
  const [value, setValue] = useState('');
  const { status, loadError, reload, operation, changeKeys } = useServerCredentials(storageKey, t);
  const serverConfigured = Boolean(status?.[serverKey]);
  const changeKey = (remove: boolean) => {
    if (disabled || (!remove && !value.trim())) return;
    return changeKeys({ [serverKey]: remove ? '' : value.trim() }, remove, () => setValue(''));
  };

  const handleTest = () => {
    if (disabled || !testEndpoint || !serverConfigured || value.trim()) return;
    return operation.run('testing', async signal => {
      const response = await apiFetch(testEndpoint, { method: 'POST', credentials: 'include', signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) {
        const details = [payload?.streamingStt?.error, payload?.speechSynthesis?.error, payload?.error].filter(Boolean).join(' | ');
        throw new Error(details || uiMessage('settings.live-call-failed.cd19d46055'));
      }
      return formatUiMessage('settings.live-call-passed-value0-ms.9f3242a245', { value0: Number(payload.latencyMs || 0) }, t?.langCode === 'en' ? 'en' : 'zh');
    });
  };

  return (
    <SettingsDisclosure
      icon={icon}
      label={label}
      badges={<>
        {serverConfigured && <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-400">{t?.configured || uiMessage('settings.configured.d7f5ed6e15')}</span>}
      </>}
    >
      {!status ? <ModelSettingsStatus error={loadError} retry={reload} /> : <div className="space-y-3">
      {consoleUrl && (
        <a href={consoleUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-cyan-300/70 hover:text-cyan-200">
          {uiMessage('settings.provider-console.f2138df9a1')} <ExternalLink size={12} />
        </a>
      )}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="relative flex-1">
          <input
            disabled={disabled || operation.busy}
            type="password"
            value={value}
            onChange={e => { setValue(e.target.value); operation.reset(); }}
            onKeyDown={e => e.key === 'Enter' && changeKey(false)}
            placeholder={serverConfigured && !value ? (t?.keySavedOnServer || uiMessage('settings.key-saved-on-server-type.3b51321a15')) : placeholder}
            className="h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 pr-20 font-mono text-sm text-white outline-none transition-colors focus:border-celestial-saturn/50 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => changeKey(true)}
            disabled={disabled || operation.busy || (!value && !serverConfigured)}
            className="absolute right-1.5 top-1.5 h-8 rounded-md border border-red-500/20 bg-red-500/10 px-2.5 text-[11px] font-semibold text-red-400 transition-all hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-20"
          >
            {t?.remove || uiMessage('settings.remove.78190c6054')}
          </button>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => changeKey(false)}
            disabled={disabled || operation.busy || !value.trim()}
            className="h-11 rounded-lg bg-celestial-saturn px-5 text-xs font-semibold text-black transition-all hover:bg-celestial-saturn/90 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {t?.save || uiMessage('settings.save.ec8e6d5819')}
          </Button>
          {testEndpoint && (
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={disabled || operation.busy || !serverConfigured || Boolean(value.trim())}
              className="h-11 rounded-lg border-white/15 px-4 text-xs font-semibold text-white/75 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {operation.testing ? <Loader2 size={14} className="animate-spin" /> : uiMessage('settings.test.9408c1ff3a')}
            </Button>
          )}
        </div>
      </div>
      {hint && <p className="text-[12px] text-white/45 leading-relaxed">{hint}</p>}
      {operation.message && (
        <p className={`text-[12px] leading-relaxed ${operation.state === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>
          {operation.message}
        </p>
      )}
      </div>}
    </SettingsDisclosure>
  );
}

export function RelayProviderRow(props: Parameters<typeof RelayProviderEditor>[0]) {
  const { user } = useApp();
  return user ? <RelayProviderEditor key={JSON.stringify([user.uid, user.role])} {...props} /> : null;
}

export function RelayProviderEditor({ t, label }: { t?: any; label?: string }) {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(() => readStoredRelayBaseUrl() || LUMI_OFFICIAL_BASE_URL);
  const { status, loadError, reload, operation, changeKeys } = useServerCredentials('lumi_relay_key', t);
  const serverKeyOk = Boolean(status?.RELAY_API_KEY), serverUrlOk = Boolean(status?.RELAY_BASE_URL);
  const changeRelay = (remove: boolean) => {
    const enteredKey = apiKey.trim(), url = baseUrl.trim();
    if (!remove && ((!enteredKey && !serverKeyOk) || !url)) return;
    return changeKeys(remove ? { RELAY_API_KEY: '', RELAY_BASE_URL: '' } : { RELAY_BASE_URL: url, ...(enteredKey ? { RELAY_API_KEY: enteredKey } : {}) }, remove, () => {
      try { if (remove) localStorage.removeItem('lumi_relay_url'); else localStorage.setItem('lumi_relay_url', url); } catch {}
      setApiKey(''); setBaseUrl(remove ? '' : url);
    });
  };

  return (
    <SettingsDisclosure
      icon={<Globe size={18} className="text-cyan-400" />}
      label={label || t?.apiRelayLabel || 'API Relay'}
      badges={<>
        {serverKeyOk && serverUrlOk && <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-400">{uiMessage('settings.configured.d7f5ed6e15')}</span>}
      </>}
    >
      {!status ? <ModelSettingsStatus error={loadError} retry={reload} /> : <>
      <div className="space-y-3">
        <input
          disabled={operation.busy}
          type="password"
          value={apiKey}
          onChange={e => { setApiKey(e.target.value); operation.reset(); }}
          onKeyDown={e => e.key === 'Enter' && changeRelay(false)}
          placeholder="API Key"
          className="h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-sm text-white outline-none transition-colors focus:border-cyan-400/50"
        />
        <input
          disabled={operation.busy}
          type="text"
          value={baseUrl}
          onChange={e => { setBaseUrl(e.target.value); operation.reset(); }}
          onKeyDown={e => e.key === 'Enter' && changeRelay(false)}
          placeholder={LUMI_RELAY_BASE_URL_PLACEHOLDER}
          className="h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-sm text-white outline-none transition-colors focus:border-cyan-400/50"
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          onClick={() => changeRelay(false)}
          disabled={operation.busy || (!apiKey.trim() && !serverKeyOk) || !baseUrl.trim()}
          className="h-10 rounded-lg bg-cyan-600 px-4 text-xs font-semibold text-white transition-all hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {t?.save || uiMessage('settings.save.ec8e6d5819')}
        </Button>
        <Button
          onClick={() => changeRelay(true)}
          disabled={operation.busy || (!apiKey && !serverKeyOk && !serverUrlOk)}
          className="h-10 rounded-lg border border-red-500/20 bg-red-500/10 px-4 text-xs font-semibold text-red-400 transition-all hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-20"
        >
          {t?.remove || uiMessage('settings.remove.78190c6054')}
        </Button>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-amber-200/65">{uiMessage('settings.lumi-official-endpoint-warning.f7a8b9c0d1')}</p>
      {operation.message && <p className={operation.state === 'ok' ? 'text-emerald-300' : 'text-red-300'}>{operation.message}</p>}
      </>}
    </SettingsDisclosure>
  );
}
