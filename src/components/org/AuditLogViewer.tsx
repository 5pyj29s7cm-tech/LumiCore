import { FeedbackBanner } from './FeedbackBanner';
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  Clock,
  Download,
  FileText,
  Filter,
  Loader2,
  ScrollText,
  Search,
  User,
} from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { useAsyncOperation } from '../../hooks/useAsyncOperation';
import { apiFetch, apiJson } from '../../services/apiClient';
import { useT } from '../../lib/useT';
import { uiMessage } from '../../i18n/uiMessages';
import { organizationRecoveryCopy } from '../../i18n/locales/organizationRecovery';
import { orgAdminCompletenessCopy } from '../../i18n/locales/orgAdminCompleteness';
import type { AuditEntry as StoredAuditEntry } from '../../../server/org/db';

type AuditEntry = Pick<StoredAuditEntry, 'id' | 'userId' | 'action' | 'resourceType' | 'resourceId' | 'details' | 'timestamp'>;

function paramsFor(value: Record<string, string>) {
  return new URLSearchParams(Object.fromEntries(Object.entries(value).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value)));
}

export function AuditLogViewer() {
  const { user, workDomain, orgConnection } = useApp();
  return user ? <AuditLog key={JSON.stringify([user.uid, user.role, workDomain, orgConnection?.orgId, orgConnection?.orgRole])} /> : null;
}
function AuditLog() {
  const t = useT(), isZh = t.langCode !== 'en';
  const recovery = organizationRecoveryCopy(t.langCode);
  const copy = orgAdminCompletenessCopy(t.langCode);
  const [records, setRecords] = useState<AuditEntry[] | null>(null);
  const [filters, setFilters] = useState({ userId: '', action: '', resourceType: '' });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [page, setPage] = useState({ offset: 0, total: 0, nextCursor: null as string | null, previousCursor: null as string | null });
  const [requestedPage, setRequestedPage] = useState({ filters, cursor: '' });
  const [retryKind, setRetryKind] = useState<'load' | 'export'>('load');
  const [showFilters, setShowFilters] = useState(false), [message, setMessage] = useState('');
  const { busy, error, run, cancel } = useAsyncOperation();
  const entries = records || [], loading = busy === 'load' || (records === null && !error);
  const feedback = error ? { type: 'error' as const, text: error } : message ? { type: 'success' as const, text: message } : null;
  const loadEntries = useCallback((value = { userId: '', action: '', resourceType: '' }, cursor = '') => {
    cancel(); setMessage('');
    setRetryKind('load');
    setRequestedPage({ filters: value, cursor });
    void run('load', async signal => {
      const params = paramsFor(value); params.set('limit', '100'); params.set('pagination', 'cursor');
      if (cursor) params.set('cursor', cursor);
      const data = await apiJson('/api/org/audit?' + params, { signal });
      if (!data || !Array.isArray(data.entries) || !data.entries.every((item: any) => item && ['id', 'userId', 'action', 'resourceType', 'timestamp'].every(field => typeof item[field] === 'string'))
        || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.offset) || data.offset < 0 || data.offset % 100 !== 0
        || data.entries.length !== Math.min(100, data.total - data.offset) || (!cursor && data.offset !== 0)
        || new Set(data.entries.map((item: any) => item.id)).size !== data.entries.length
        || typeof data.cursor !== 'string' || !data.cursor || (cursor && data.cursor !== cursor)
        || ![data.nextCursor, data.previousCursor].every(value => value === null || (typeof value === 'string' && value.length > 0))
        || (data.nextCursor !== null) !== (data.offset + data.entries.length < data.total)
        || (data.previousCursor !== null) !== (data.offset > 0)) throw new Error('Invalid audit log response');
      return () => { setRecords(data.entries); setAppliedFilters(value); setPage({ offset: data.offset, total: data.total, nextCursor: data.nextCursor, previousCursor: data.previousCursor }); };
    });
  }, [run, cancel]);
  useEffect(() => { loadEntries(); }, [loadEntries]);
  const handleFilter = () => loadEntries(filters);
  const handleClear = () => {
    const empty = { userId: '', action: '', resourceType: '' }; setFilters(empty); loadEntries(empty);
  };
  const handleExport = () => {
    setMessage(''); setRetryKind('export');
    return run('export', async signal => {
      const response = await apiFetch('/api/org/audit/export?' + paramsFor(appliedFilters), { signal });
      if (!response.ok) throw new Error('Audit export failed: HTTP ' + response.status);
      const blob = await response.blob();
      return () => {
        const url = URL.createObjectURL(blob), anchor = document.createElement('a');
        anchor.href = url; anchor.download = `audit-export-${Date.now()}.csv`;
        document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
        setMessage(uiMessage('audit-log-viewer.audit-csv-exported.e2579c1ff2'));
      };
    }, 60_000);
  };

  const parseDetails = (details: string): Record<string, any> => {
    try {
      const parsed = JSON.parse(details);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
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
                <p className="mt-1 text-sm text-white/50">{records !== null && copy.auditCount(entries.length, page.total)}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={Boolean(busy)} onClick={() => loadEntries(appliedFilters)} className="rounded-lg border border-white/10 px-3 py-2 text-sm disabled:opacity-40">{copy.refreshAudit}</button>
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
                disabled={Boolean(busy)}
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white"
              >
                <Download size={14} />
                {uiMessage('audit-log-viewer.export-csv.013f0e9fde')}
              </button>
            </div>
          </div>
        </section>

        {feedback && <FeedbackBanner feedback={feedback} />}
        {error && <button type="button" disabled={Boolean(busy)} onClick={() => retryKind === 'export' ? void handleExport() : loadEntries(requestedPage.filters, requestedPage.cursor)} className="self-start rounded-lg border border-white/10 px-3 py-2 text-sm">{recovery.retry}</button>}

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
                placeholder="document"
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
          {loading && records === null ? (
            <div className="flex h-72 items-center justify-center text-white/55">
              <Loader2 size={24} className="animate-spin" />
            </div>
          ) : entries.length === 0 && !error ? (
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
        {(page.offset > 0 || page.nextCursor) && (
          <div className="flex justify-end gap-3">
            <span className="self-center text-sm text-white/50">{recovery.page} {page.offset / 100 + 1}</span>
            <button type="button" disabled={Boolean(busy) || !page.previousCursor} onClick={() => loadEntries(appliedFilters, page.previousCursor!)} className="rounded-lg border border-white/10 px-3 py-2 text-sm disabled:opacity-40">{recovery.previous}</button>
            <button type="button" disabled={Boolean(busy) || !page.nextCursor} onClick={() => loadEntries(appliedFilters, page.nextCursor!)} className="rounded-lg border border-white/10 px-3 py-2 text-sm disabled:opacity-40">{recovery.next}</button>
          </div>
        )}
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
