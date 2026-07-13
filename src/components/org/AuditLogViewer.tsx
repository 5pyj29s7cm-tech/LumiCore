import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Download,
  FileText,
  Filter,
  Loader2,
  ScrollText,
  Search,
  User,
} from 'lucide-react';
import { useT } from '../../lib/useT';
import { formatUiMessage, uiMessage } from '../../i18n/uiMessages';

interface AuditEntry {
  id: string;
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  details: string;
  timestamp: string;
}

type Feedback = { type: 'success' | 'error'; text: string };

export function AuditLogViewer() {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ userId: '', action: '', resourceType: '' });
  const [showFilters, setShowFilters] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const loadEntries = useCallback(async (withFilters = filters) => {
    setLoading(true);
    setFeedback(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', '100');
      if (withFilters.userId.trim()) params.set('userId', withFilters.userId.trim());
      if (withFilters.action.trim()) params.set('action', withFilters.action.trim());
      if (withFilters.resourceType.trim()) params.set('resourceType', withFilters.resourceType.trim());
      const res = await fetch(`/api/org/audit?${params.toString()}`, { credentials: 'include' });
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error((data as any).error || formatUiMessage('audit-log-viewer.audit-log-load-failed-value0.3784d1af66', { value0: res.status }));
      setEntries(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [filters, ui]);

  useEffect(() => {
    void loadEntries();
  }, []); // initial load only; explicit filter button controls filtered reload

  const handleFilter = () => {
    void loadEntries(filters);
  };

  const handleClear = () => {
    const empty = { userId: '', action: '', resourceType: '' };
    setFilters(empty);
    void loadEntries(empty);
  };

  const handleExport = async () => {
    setFeedback(null);
    try {
      const params = new URLSearchParams();
      if (filters.userId.trim()) params.set('userId', filters.userId.trim());
      if (filters.action.trim()) params.set('action', filters.action.trim());
      if (filters.resourceType.trim()) params.set('resourceType', filters.resourceType.trim());
      const res = await fetch(`/api/org/audit/export?${params.toString()}`, { credentials: 'include' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || formatUiMessage('audit-log-viewer.audit-export-failed-value0.7234f86e58', { value0: res.status }));
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `audit-export-${Date.now()}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      setFeedback({ type: 'success', text: uiMessage('audit-log-viewer.audit-csv-exported.e2579c1ff2') });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
    }
  };

  const parseDetails = (details: string): Record<string, any> => {
    try { return JSON.parse(details); } catch { return {}; }
  };

  const actionColor = (action: string): string => {
    if (action.includes('create') || action.includes('submit') || action.includes('publish')) return 'text-emerald-300';
    if (action.includes('delete') || action.includes('reject') || action.includes('remove')) return 'text-red-300';
    if (action.includes('update') || action.includes('approve')) return 'text-blue-300';
    if (action.includes('login') || action.includes('register')) return 'text-violet-300';
    return 'text-white/60';
  };

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-amber-400/20 bg-amber-500/10 text-amber-300">
                <ScrollText size={22} />
              </span>
              <div>
                <h2 className="text-xl font-semibold text-white">{t.orgAudit || uiMessage('audit-log-viewer.audit-log.bd5de459f0')}</h2>
                <p className="mt-1 text-sm text-white/50">{formatUiMessage('audit-log-viewer.value0-entries.5100b27748', { value0: entries.length })}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setShowFilters(prev => !prev)}
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                  showFilters
                    ? 'border-amber-400/25 bg-amber-500/15 text-amber-100'
                    : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                }`}
              >
                <Filter size={14} />
                {uiMessage('audit-log-viewer.filters.85b8708db9')}
              </button>
              <button
                onClick={handleExport}
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white"
              >
                <Download size={14} />
                {uiMessage('audit-log-viewer.export-csv.013f0e9fde')}
              </button>
            </div>
          </div>
        </section>

        {feedback && <FeedbackBanner feedback={feedback} />}

        {showFilters && (
          <motion.section
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-lg border border-white/10 bg-white/[0.04] p-4"
          >
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto_auto]">
              <FilterInput
                label={uiMessage('audit-log-viewer.user-id.2618235b37')}
                value={filters.userId}
                placeholder={uiMessage('audit-log-viewer.filter-by-user.a267c6cd6c')}
                onChange={value => setFilters(prev => ({ ...prev, userId: value }))}
              />
              <FilterInput
                label={uiMessage('audit-log-viewer.action.91069d1d41')}
                value={filters.action}
                placeholder="template.create"
                onChange={value => setFilters(prev => ({ ...prev, action: value }))}
              />
              <FilterInput
                label={uiMessage('audit-log-viewer.resource-type.9c659dd26c')}
                value={filters.resourceType}
                placeholder="agent_template"
                onChange={value => setFilters(prev => ({ ...prev, resourceType: value }))}
              />
              <button
                onClick={handleFilter}
                className="self-end inline-flex items-center justify-center gap-2 rounded-lg border border-amber-400/20 bg-amber-500/15 px-3 py-2 text-sm font-medium text-amber-100 transition hover:bg-amber-500/25"
              >
                <Search size={14} />
                {uiMessage('audit-log-viewer.search.05fdb9c15c')}
              </button>
              <button
                onClick={handleClear}
                className="self-end rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/60 transition hover:bg-white/10"
              >
                {uiMessage('audit-log-viewer.clear.684270d636')}
              </button>
            </div>
          </motion.section>
        )}

        <section className="min-h-[360px] overflow-hidden rounded-lg border border-white/10 bg-white/[0.04]">
          {loading ? (
            <div className="flex h-72 items-center justify-center text-white/55">
              <Loader2 size={24} className="animate-spin" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex h-72 flex-col items-center justify-center gap-2 text-center text-sm text-white/45">
              <ScrollText size={32} className="text-white/20" />
              <span>{uiMessage('audit-log-viewer.no-audit-entries-found.be752eeb23')}</span>
            </div>
          ) : (
            <div className="divide-y divide-white/8">
              {entries.map(entry => {
                const details = parseDetails(entry.details);
                const detailPreview = Object.keys(details).length > 0 ? JSON.stringify(details) : '-';
                return (
                  <div key={entry.id} className="grid gap-3 p-4 text-xs transition hover:bg-white/[0.04] lg:grid-cols-[150px_170px_140px_140px_minmax(0,1fr)]">
                    <span className="inline-flex items-center gap-2 text-white/45">
                      <Clock size={12} />
                      {new Date(entry.timestamp).toLocaleString(isZh ? 'zh-CN' : undefined)}
                    </span>
                    <span className={`font-medium ${actionColor(entry.action)}`}>{entry.action}</span>
                    <span className="inline-flex min-w-0 items-center gap-1 text-white/55">
                      <User size={11} />
                      <span className="truncate">{entry.userId}</span>
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-1 text-white/55">
                      <FileText size={11} />
                      <span className="truncate">{entry.resourceType}</span>
                    </span>
                    <span className="min-w-0 truncate font-mono text-white/40" title={detailPreview}>
                      {detailPreview}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function FilterInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span className="mb-1 block text-xs text-white/50">{label}</span>
      <input
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/35 focus:border-amber-400/35"
      />
    </label>
  );
}

function FeedbackBanner({ feedback }: { feedback: Feedback }) {
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
      feedback.type === 'success'
        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
        : 'border-red-500/20 bg-red-500/10 text-red-200'
    }`}>
      {feedback.type === 'success' ? <CheckCircle size={16} className="mt-0.5 shrink-0" /> : <AlertCircle size={16} className="mt-0.5 shrink-0" />}
      <span>{feedback.text}</span>
    </div>
  );
}
