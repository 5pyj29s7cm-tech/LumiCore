import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Database,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { getSavedKeyStatus, saveServerKeys, type KeyStatus } from '../../services/settingsKeys';
import { useT } from '../../lib/useT';
import { uiMessage } from '../../i18n/uiMessages';
import {
  CHINA_LEGAL_BROWSER_SOURCE_IDS,
  CHINA_LEGAL_DATA_SOURCES,
  chinaLegalCopy,
  type ChinaLegalDataSourceDefinition,
  type ChinaLegalDataSourceField,
} from '../../i18n/regions/cn/legal';

type DataSourceField = ChinaLegalDataSourceField;
type DataSourceConfig = ChinaLegalDataSourceDefinition;

const LEGAL_DATA_SOURCES = CHINA_LEGAL_DATA_SOURCES;
const BROWSER_COLLABORATION_SOURCES = CHINA_LEGAL_BROWSER_SOURCE_IDS;

export function LegalDataSourcesSettings() {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const regionalCopy = chinaLegalCopy(isZh ? 'zh' : 'en');
  const [status, setStatus] = useState<KeyStatus>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await getSavedKeyStatus();
      setStatus(next);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const configuredCount = useMemo(() => {
    const keys = LEGAL_DATA_SOURCES.flatMap(source => source.fields.map(field => field.keyName));
    return keys.filter(key => status[key]).length;
  }, [status]);

  const sourceConfigured = (source: DataSourceConfig) => {
    if (source.id === 'qichacha') return Boolean(status.QICHACHA_APP_KEY && status.QICHACHA_SECRET_KEY);
    if (source.id === 'tianyancha') return Boolean(status.TIANYANCHA_API_KEY);
    if (source.id === 'pkulaw') return Boolean((status.PKULAW_API_KEY || status.PKULAW_TOKEN) && (status.PKULAW_BASE_URL || status.PKULAW_MCP_URL));
    if (source.id === 'farui') return Boolean(status.FARUI_API_KEY && status.FARUI_BASE_URL);
    return source.fields.some(field => status[field.keyName]);
  };

  const saveField = async (field: DataSourceField) => {
    const value = (drafts[field.keyName] || '').trim();
    if (!value) return;
    setBusyKey(field.keyName);
    try {
      await saveServerKeys({ [field.keyName]: value });
      setDrafts(prev => ({ ...prev, [field.keyName]: '' }));
      await loadStatus();
      toast.success(uiMessage('legal-data-sources-settings.legal-data-source-key-saved.aa9bdea122'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('legal-data-sources-settings.save-failed.5b5ea27d01'));
    } finally {
      setBusyKey('');
    }
  };

  const removeField = async (field: DataSourceField) => {
    setBusyKey(field.keyName);
    try {
      await saveServerKeys({ [field.keyName]: '' });
      setDrafts(prev => ({ ...prev, [field.keyName]: '' }));
      await loadStatus();
      toast.success(uiMessage('legal-data-sources-settings.legal-data-source-key-removed.a6062630fb'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('legal-data-sources-settings.remove-failed.415d663686'));
    } finally {
      setBusyKey('');
    }
  };

  return (
    <section id="legal-data-sources" className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-cyan-300/20 bg-cyan-500/10 text-cyan-200">
            <Database size={20} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white">{uiMessage('legal-data-sources-settings.legal-data-sources.55a8bdbafb')}</h3>
            <p className="mt-1 text-sm leading-6 text-white/50">
              {uiMessage('legal-data-sources-settings.configure-firm-authorized-legal-and.474116ab2c')}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={loadStatus}
          disabled={loading}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 text-xs font-medium text-white/70 transition hover:bg-white/10 disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {uiMessage('legal-data-sources-settings.refresh.05348f5f9a')}
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-100">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <StatusPill
          icon={<KeyRound size={15} />}
          label={uiMessage('legal-data-sources-settings.saved-fields.2b3ded4e80')}
          value={String(configuredCount)}
        />
        <StatusPill
          icon={<ShieldCheck size={15} />}
          label={uiMessage('legal-data-sources-settings.api-sources.5021c6a7a9')}
          value={String(LEGAL_DATA_SOURCES.filter(sourceConfigured).length)}
        />
        <StatusPill
          icon={<ExternalLink size={15} />}
          label={uiMessage('legal-data-sources-settings.browser-collaboration.57929883b6')}
          value={String(BROWSER_COLLABORATION_SOURCES.length)}
        />
      </div>

      <div className="divide-y divide-white/10 border-y border-white/10">
        {LEGAL_DATA_SOURCES.map(source => {
          const ready = sourceConfigured(source);
          const sourceCopy = regionalCopy.dataSources[source.id];
          return (
            <div key={source.id} className="py-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-medium text-white">{sourceCopy.label}</h4>
                    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${
                      ready
                        ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200'
                        : 'border-white/10 bg-white/5 text-white/45'
                    }`}>
                      {ready ? <CheckCircle size={12} /> : <KeyRound size={12} />}
                      {ready ? uiMessage('legal-data-sources-settings.configured.b0740e7ebe') : uiMessage('legal-data-sources-settings.not-configured.8b6c7ecc15')}
                    </span>
                    <span className="rounded-md border border-blue-300/15 bg-blue-500/10 px-2 py-1 text-[11px] text-blue-100/70">
                      API
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-white/45">
                    {sourceCopy.boundary}
                  </p>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                {source.fields.map(field => {
                  const configured = Boolean(status[field.keyName]);
                  const busy = busyKey === field.keyName;
                  const value = drafts[field.keyName] || '';
                  return (
                    <div key={field.keyName} className="grid gap-2 rounded-lg border border-white/10 bg-black/15 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label htmlFor={`legal-source-${field.keyName}`} className="text-xs font-medium text-white/65">
                          {field.label}
                          {field.required && <span className="ml-1 text-cyan-200">*</span>}
                        </label>
                        {configured && (
                          <span className="text-[11px] text-emerald-200/80">{uiMessage('legal-data-sources-settings.saved-on-server.8ea35de0cc')}</span>
                        )}
                      </div>
                      <div className="grid grid-cols-[1fr_auto_auto] gap-2">
                        <input
                          id={`legal-source-${field.keyName}`}
                          value={value}
                          type={field.kind === 'secret' ? 'password' : 'text'}
                          onChange={event => setDrafts(prev => ({ ...prev, [field.keyName]: event.target.value }))}
                          onKeyDown={event => {
                            if (event.key === 'Enter') void saveField(field);
                          }}
                          placeholder={configured && !value ? uiMessage('legal-data-sources-settings.saved-type-to-replace.bbdf5a8d1e') : field.placeholder}
                          className="h-9 min-w-0 rounded-lg border border-white/10 bg-black/25 px-3 text-sm text-white outline-none transition focus:border-cyan-300/35"
                        />
                        <button
                          type="button"
                          onClick={() => saveField(field)}
                          disabled={busy || !value.trim()}
                          title={uiMessage('legal-data-sources-settings.save.ec8e6d5819')}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-cyan-300/20 bg-cyan-500/10 text-cyan-100 transition hover:bg-cyan-500/20 disabled:opacity-35"
                        >
                          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeField(field)}
                          disabled={busy || (!configured && !value)}
                          title={uiMessage('legal-data-sources-settings.remove.78190c6054')}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-red-300/20 bg-red-500/10 text-red-100 transition hover:bg-red-500/20 disabled:opacity-30"
                        >
                          {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                        </button>
                      </div>
                      <code className="text-[11px] text-white/35">{field.keyName}</code>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-lg border border-amber-300/15 bg-amber-500/10 p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-100">
          <ExternalLink size={15} />
          {uiMessage('legal-data-sources-settings.browser-collaboration.57929883b6')}
        </div>
        <div className="flex flex-wrap gap-2">
          {BROWSER_COLLABORATION_SOURCES.map(source => (
            <span key={source} className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/55">
              {regionalCopy.browserSources[source]}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs leading-5 text-white/45">
          {uiMessage('legal-data-sources-settings.these-sites-do-not-store.1c975a2b1a')}
        </p>
      </div>
    </section>
  );
}

function StatusPill({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-black/15 px-3 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/65">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] text-white/40">{label}</span>
        <span className="mt-0.5 block text-lg font-semibold text-white">{value}</span>
      </span>
    </div>
  );
}
