import { useState } from "react";
import { Shield } from "lucide-react";
import { uiMessage } from "../../i18n/uiMessages";
import type { ProviderRuntimeStatus, ProviderScope } from './connections';
import { OfficialProviderSettings, ServiceProviderSettings } from './official_provider';
import { LocalProviderSettings } from './local_provider';
import { SettingsSection } from './components';

export function AIProvidersPage({ t, providerStatus }: { t: any; providerStatus: Record<string, ProviderRuntimeStatus> }) {
  const [scope, setScope] = useState<ProviderScope>('official');
  const extensionProviders = Object.entries(providerStatus).filter(([, status]) => {
    if (status.extension !== true) return false;
    if (scope === 'local') return status.local === true;
    if (scope === 'services') return status.local !== true;
    return false;
  });
  const tabs: Array<{ id: ProviderScope; label: string }> = [
    { id: 'official', label: uiMessage('settings.provider-scope-official-lumi.0f4d8e2a11') },
    { id: 'local', label: uiMessage('settings.provider-scope-local.3b7c1a9e20') },
    { id: 'services', label: uiMessage('settings.provider-scope-services.6e2f9c4b18') },
  ];
  return (
    <div className="space-y-6">
      <div className="border-b border-white/10 pb-4">
        <h2 className="text-lg font-semibold text-white">{uiMessage('settings.ai-providers.38c3f21901')}</h2>
        <div className="mt-4 grid grid-cols-3 gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
          {tabs.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => setScope(item.id)}
              role="tab"
              aria-selected={scope === item.id}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${scope === item.id ? 'bg-celestial-saturn text-black shadow-sm' : 'text-white/45 hover:bg-white/[0.06] hover:text-white/70'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {scope === 'official'
        ? <OfficialProviderSettings t={t} />
        : scope === 'local'
          ? <LocalProviderSettings t={t} />
          : <ServiceProviderSettings t={t} providerStatus={providerStatus} />}
      {extensionProviders.length > 0 && (
        <SettingsSection title="Signed extension Providers" icon={<Shield size={18} className="text-emerald-300" />}>
          <div className="divide-y divide-white/10 border-y border-white/10">
            {extensionProviders.map(([providerId, status]) => (
              <div key={providerId} className="grid gap-2 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-white">
                    <span>{providerId}</span>
                    <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-200">signed</span>
                    {status.version && <span className="font-mono text-[10px] text-white/35">v{status.version}</span>}
                  </div>
                  <p className="mt-1 text-xs text-white/40">
                    {status.model || 'No default model'} · {status.compatibility?.status || 'compatibility unknown'} · credentials {status.configured ? 'ready' : 'missing'}
                  </p>
                </div>
                <span className={`text-xs font-medium ${status.available ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {status.available ? 'available' : 'unavailable'}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-white/35">
            Installation, permission review, rollback, and disable operations use Lumi's confirmed extension registry and persistent receipts. Credentials are referenced from the local credential store and are never embedded in manifests.
          </p>
        </SettingsSection>
      )}
    </div>
  );
}
