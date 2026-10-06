import { useEffect, useState } from "react";
import { Cpu, Database, Sparkle, Wrench, FileText } from "lucide-react";
import { MCPSettings } from "../MCPSettings";
import { uiMessage } from "../../i18n/uiMessages";
import { LegalDataSourcesSettings } from "../org/LegalDataSourcesSettings";
import { SettingsSection } from './components';
import { ApiKeyField } from './provider_access';

export function ApplicationConnections({ t }: { t: any }) {
  return (
    <SettingsSection title={uiMessage('settings.application-service-connections.4c05e32d49')} icon={<FileText size={18} className="text-sky-300" />}>
      <div className="border-y border-white/10">
        <ApiKeyField icon={<Wrench size={18} className="text-white/70" />} label="GitHub" placeholder="Personal access token" storageKey="lumi_github_token" serverKey="GITHUB_TOKEN" t={t} />
        <ApiKeyField icon={<FileText size={18} className="text-white/70" />} label="Notion" placeholder="Integration token" storageKey="lumi_notion_api_key" serverKey="NOTION_API_KEY" t={t} />
        <ApiKeyField icon={<Sparkle size={18} className="text-pink-300" />} label="Figma" placeholder="Access token" storageKey="lumi_figma_access_token" serverKey="FIGMA_ACCESS_TOKEN" t={t} />
      </div>
    </SettingsSection>
  );
}

export function ExternalConnectionsPage({
  t,
  initialTab = 'data-sources',
}: {
  t: any;
  initialTab?: 'data-sources' | 'applications';
}) {
  const [tab, setTab] = useState<'data-sources' | 'applications'>(initialTab);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  return (
    <div className="space-y-6">
      <div className="border-b border-white/10 pb-4">
        <h2 className="text-lg font-semibold text-white">
          {uiMessage('settings.external-connections.a83a9fc1d2')}
        </h2>
        <div className="mt-4 flex gap-5" role="tablist" aria-label={uiMessage('settings.external-connections.a83a9fc1d2')}>
          {([
            { id: 'data-sources', label: uiMessage('settings.data-sources.9f7efbc2df'), icon: <Database size={15} /> },
            { id: 'applications', label: uiMessage('settings.applications.36d70e9597'), icon: <FileText size={15} /> },
          ] as const).map(item => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(item.id)}
                className={`flex items-center gap-2 border-b-2 pb-2 text-sm font-semibold transition-colors ${
                  active
                    ? 'border-celestial-saturn text-white'
                    : 'border-transparent text-white/45 hover:text-white/75'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === 'data-sources'
        ? <LegalDataSourcesSettings />
        : <ApplicationConnections t={t} />}
    </div>
  );
}

export function ToolRuntimeConnections({ t }: { t: any }) {
  return (
    <div className="space-y-8">
      <SettingsSection title={uiMessage('settings.tool-runtime-connections.3942c3052f')} icon={<Cpu size={18} className="text-violet-300" />}>
        <div className="border-y border-white/10">
          <ApiKeyField icon={<Cpu size={18} className="text-violet-300" />} label="E2B Code Sandbox" placeholder="API Key" storageKey="lumi_e2b_api_key" serverKey="E2B_API_KEY" t={t} />
        </div>
      </SettingsSection>
      <MCPSettings t={t} />
    </div>
  );
}

export interface ProviderRuntimeStatus {
  available: boolean;
  configured?: boolean;
  model: string;
  extension?: boolean;
  local?: boolean;
  version?: string;
  models?: Array<string | { id?: string; capabilities?: Record<string, boolean> }>;
  compatibility?: { status?: string; checkedAt?: string; latencyMs?: number };
  manifestDigest?: string;
  signerFingerprint?: string;
  lastProbe?: {
    ok: boolean;
    testedAt: string;
    latencyMs?: number;
    errorCategory?: string;
  } | null;
}

export type ProviderScope = 'official' | 'local' | 'services';
