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

type FieldKind = 'secret' | 'url';

interface DataSourceField {
  keyName: string;
  label: string;
  kind: FieldKind;
  placeholder: string;
  required?: boolean;
}

interface DataSourceConfig {
  id: string;
  label: string;
  mode: 'api' | 'browser';
  fields: DataSourceField[];
  boundaryZh: string;
  boundaryEn: string;
}

const LEGAL_DATA_SOURCES: DataSourceConfig[] = [
  {
    id: 'qichacha',
    label: '企查查',
    mode: 'api',
    boundaryZh: '官方 API 接入；未配置时使用授权网页登录协作。',
    boundaryEn: 'Official API integration; falls back to authorized browser collaboration when unconfigured.',
    fields: [
      { keyName: 'QICHACHA_APP_KEY', label: 'App Key', kind: 'secret', placeholder: 'QICHACHA_APP_KEY', required: true },
      { keyName: 'QICHACHA_SECRET_KEY', label: 'Secret Key', kind: 'secret', placeholder: 'QICHACHA_SECRET_KEY', required: true },
      { keyName: 'QICHACHA_BASE_URL', label: 'Base URL', kind: 'url', placeholder: 'https://api.qichacha.com' },
    ],
  },
  {
    id: 'tianyancha',
    label: '天眼查',
    mode: 'api',
    boundaryZh: '官方 API 接入；用于企业主体、工商和风险信息查询。',
    boundaryEn: 'Official API integration for company profile, registry, and risk lookup.',
    fields: [
      { keyName: 'TIANYANCHA_API_KEY', label: 'API Key', kind: 'secret', placeholder: 'TIANYANCHA_API_KEY', required: true },
      { keyName: 'TIANYANCHA_BASE_URL', label: 'Base URL', kind: 'url', placeholder: 'https://open.api.tianyancha.com' },
    ],
  },
  {
    id: 'pkulaw',
    label: '北大法宝',
    mode: 'api',
    boundaryZh: '授权 API/MCP 网关；用于法规、案例和法条依据检索。',
    boundaryEn: 'Authorized API/MCP gateway for statutes, cases, and legal authorities.',
    fields: [
      { keyName: 'PKULAW_API_KEY', label: 'API Key', kind: 'secret', placeholder: 'PKULAW_API_KEY' },
      { keyName: 'PKULAW_TOKEN', label: 'Token', kind: 'secret', placeholder: 'PKULAW_TOKEN' },
      { keyName: 'PKULAW_BASE_URL', label: 'API Base URL', kind: 'url', placeholder: 'https://...' },
      { keyName: 'PKULAW_MCP_URL', label: 'MCP URL', kind: 'url', placeholder: 'https://mcp.pkulaw.com/...' },
    ],
  },
  {
    id: 'farui',
    label: '通义法睿',
    mode: 'api',
    boundaryZh: '显式授权网关；必须配置 FARUI_API_KEY 和 FARUI_BASE_URL 才会自动查询。',
    boundaryEn: 'Explicit authorized gateway; requires FARUI_API_KEY and FARUI_BASE_URL for automatic lookup.',
    fields: [
      { keyName: 'FARUI_API_KEY', label: 'API Key', kind: 'secret', placeholder: 'FARUI_API_KEY', required: true },
      { keyName: 'FARUI_BASE_URL', label: 'Base URL', kind: 'url', placeholder: 'https://...', required: true },
    ],
  },
];

const BROWSER_COLLABORATION_SOURCES = [
  '法蝉',
  'Alpha',
  '中国裁判文书网',
  '人民法院案例库',
  '国家企业信用信息公示系统',
];

export function LegalDataSourcesSettings() {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);
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
      toast.success(ui('法律数据源密钥已保存', 'Legal data source key saved'));
    } catch (err: any) {
      toast.error(err?.message || ui('保存失败', 'Save failed'));
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
      toast.success(ui('法律数据源密钥已移除', 'Legal data source key removed'));
    } catch (err: any) {
      toast.error(err?.message || ui('移除失败', 'Remove failed'));
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
            <h3 className="text-sm font-semibold text-white">{ui('法律数据源', 'Legal Data Sources')}</h3>
            <p className="mt-1 text-sm leading-6 text-white/50">
              {ui('配置律所授权的法律库和企业库。聊天、语音和律所工作台会调用同一套组织数据源。', 'Configure firm-authorized legal and company databases for chat, voice, and the legal workspace.')}
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
          {ui('刷新状态', 'Refresh')}
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
          label={ui('已保存字段', 'Saved Fields')}
          value={String(configuredCount)}
        />
        <StatusPill
          icon={<ShieldCheck size={15} />}
          label={ui('自动 API', 'API Sources')}
          value={String(LEGAL_DATA_SOURCES.filter(sourceConfigured).length)}
        />
        <StatusPill
          icon={<ExternalLink size={15} />}
          label={ui('网页登录协作', 'Browser Collaboration')}
          value={String(BROWSER_COLLABORATION_SOURCES.length)}
        />
      </div>

      <div className="divide-y divide-white/10 border-y border-white/10">
        {LEGAL_DATA_SOURCES.map(source => {
          const ready = sourceConfigured(source);
          return (
            <div key={source.id} className="py-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-medium text-white">{source.label}</h4>
                    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${
                      ready
                        ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200'
                        : 'border-white/10 bg-white/5 text-white/45'
                    }`}>
                      {ready ? <CheckCircle size={12} /> : <KeyRound size={12} />}
                      {ready ? ui('已配置', 'Configured') : ui('未配置', 'Not configured')}
                    </span>
                    <span className="rounded-md border border-blue-300/15 bg-blue-500/10 px-2 py-1 text-[11px] text-blue-100/70">
                      API
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-white/45">
                    {isZh ? source.boundaryZh : source.boundaryEn}
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
                          <span className="text-[11px] text-emerald-200/80">{ui('服务端已保存', 'Saved on server')}</span>
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
                          placeholder={configured && !value ? ui('已保存，输入可替换', 'Saved, type to replace') : field.placeholder}
                          className="h-9 min-w-0 rounded-lg border border-white/10 bg-black/25 px-3 text-sm text-white outline-none transition focus:border-cyan-300/35"
                        />
                        <button
                          type="button"
                          onClick={() => saveField(field)}
                          disabled={busy || !value.trim()}
                          title={ui('保存', 'Save')}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-cyan-300/20 bg-cyan-500/10 text-cyan-100 transition hover:bg-cyan-500/20 disabled:opacity-35"
                        >
                          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeField(field)}
                          disabled={busy || (!configured && !value)}
                          title={ui('移除', 'Remove')}
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
          {ui('网页登录协作', 'Browser Collaboration')}
        </div>
        <div className="flex flex-wrap gap-2">
          {BROWSER_COLLABORATION_SOURCES.map(source => (
            <span key={source} className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/55">
              {source}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs leading-5 text-white/45">
          {ui('这些站点不在这里填写平台账号。Lumi 会通过授权浏览器打开网页，由律师登录、确认来源，再把结果导入知识库。', 'These sites do not store platform credentials here. Lumi opens an authorized browser session, the lawyer logs in and confirms sources, then imports results to the knowledge base.')}
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
