import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Building2,
  Clock,
  RefreshCw,
  ShieldCheck,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useT } from '../../lib/useT';
import { useApp } from '../../contexts/AppContext';
import { formatUiMessage } from '../../i18n/uiMessages';
import { getBranchDashboardCopy } from '../../i18n/locales/branchDashboard';

interface DashboardStats {
  memberCount: number;
  kbArticleCount: number;
  syncStatus: 'connected' | 'offline';
  lastSync: string | null;
}

export function BranchDashboard() {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const copy = useMemo(() => getBranchDashboardCopy(isZh ? 'zh' : 'en'), [isZh]);
  const { orgConnection, workDomain } = useApp();
  const [stats, setStats] = useState<DashboardStats>({
    memberCount: 0,
    kbArticleCount: 0,
    syncStatus: 'connected',
    lastSync: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const readArray = useCallback(async (url: string) => {
    const response = await fetch(url, { credentials: 'include' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${url} failed (${response.status})`);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.articles)) return data.articles;
    if (Array.isArray(data.members)) return data.members;
    return [];
  }, []);

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const statusResponse = await fetch('/api/org/status', { credentials: 'include' });
      const status = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok) throw new Error(status.error || copy.statusLoadFailed);
      let orgId = orgConnection?.orgId || status.orgId || '';
      if (!orgId) {
        const organizations = await readArray('/api/org/org');
        orgId = organizations[0]?.id || organizations[0]?.orgId || '';
      }
      const partialErrors: string[] = [];
      const [members, articles] = await Promise.all([
        orgId ? readArray(`/api/org/org/${orgId}/members`).catch(cause => { partialErrors.push(cause.message); return []; }) : Promise.resolve([]),
        readArray('/api/org/kb/articles?status=published').catch(cause => { partialErrors.push(cause.message); return []; }),
      ]);
      if (partialErrors.length > 0) setError(copy.partialDataUnavailable);
      setStats({
        memberCount: members.length,
        kbArticleCount: articles.length,
        syncStatus: status.connected ? 'connected' : 'offline',
        lastSync: new Date().toISOString(),
      });
    } catch (cause: any) {
      setError(cause?.message || copy.workspaceLoadFailed);
      setStats(previous => ({ ...previous, syncStatus: 'offline' }));
    } finally {
      setLoading(false);
    }
  }, [copy.partialDataUnavailable, copy.statusLoadFailed, copy.workspaceLoadFailed, orgConnection?.orgId, readArray]);

  useEffect(() => { void loadStats(); }, [loadStats]);

  const cards = useMemo(() => [
    {
      label: t.orgMembers || copy.members,
      value: stats.memberCount,
      icon: <Users size={18} />,
      tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-400/20',
    },
    {
      label: t.orgKB || copy.knowledgeBase,
      value: stats.kbArticleCount,
      icon: <BookOpen size={18} />,
      tone: 'text-blue-300 bg-blue-500/10 border-blue-400/20',
    },
  ], [copy.knowledgeBase, copy.members, stats.kbArticleCount, stats.memberCount, t.orgKB, t.orgMembers]);

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-blue-400/20 bg-blue-500/10 text-blue-300"><Building2 size={22} /></span>
                <div>
                  <h1 className="text-xl font-semibold text-white">{copy.workspace}</h1>
                  <p className="text-sm text-white/55">{orgConnection?.orgName || copy.localOrganization} · {workDomain === 'work' ? copy.workDomain : copy.personalDomain}</p>
                </div>
              </div>
              <p className="max-w-2xl text-sm leading-6 text-white/60">{copy.description}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${stats.syncStatus === 'connected' ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-300' : 'border-amber-400/20 bg-amber-500/10 text-amber-300'}`}>
                {stats.syncStatus === 'connected' ? <Wifi size={14} /> : <WifiOff size={14} />}{stats.syncStatus === 'connected' ? copy.connected : copy.offline}
              </span>
              <button onClick={() => void loadStats()} disabled={loading} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-50" aria-label={copy.refresh}><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></button>
            </div>
          </div>
        </section>

        {error && <div className="flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100/80"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-300" /><span>{error}</span></div>}

        <section className="grid gap-3 md:grid-cols-2">
          {loading ? [1, 2].map(item => <div key={item} className="h-28 animate-pulse rounded-lg border border-white/10 bg-white/[0.04]" />) : cards.map((card, index) => (
            <motion.div key={card.label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04 }} className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
              <div className="mb-3 flex items-center justify-between"><span className="text-sm text-white/55">{card.label}</span><span className={`rounded-lg border p-2 ${card.tone}`}>{card.icon}</span></div><div className="text-3xl font-semibold text-white">{card.value}</div>
            </motion.div>
          ))}
        </section>

        <section className="grid gap-3 md:grid-cols-2">
          <QuickAction icon={<BookOpen size={18} />} label={copy.openKnowledge} desc={copy.openKnowledgeDescription} onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'kb' } }))} />
          <QuickAction icon={<Activity size={18} />} label={copy.organizationLumiCore} desc={copy.organizationLumiCoreDescription} onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'chat' } }))} />
          <QuickAction icon={<ShieldCheck size={18} />} label={copy.membersAndAccess} desc={copy.membersAndAccessDescription} onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'members' } }))} />
          <QuickAction icon={<Clock size={18} />} label={copy.auditLog} desc={copy.auditLogDescription} onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'audit' } }))} />
        </section>

        {stats.lastSync && <div className="flex items-center gap-2 text-xs text-white/45"><Clock size={13} /><span>{formatUiMessage('branch-dashboard.last-refreshed-value0.0140c57047', { value0: { en: new Date(stats.lastSync).toLocaleString(), zh: new Date(stats.lastSync).toLocaleString('zh-CN') } })}</span></div>}
      </div>
    </div>
  );
}

function QuickAction({ icon, label, desc, onClick }: { icon: React.ReactNode; label: string; desc: string; onClick: () => void }) {
  return (
    <motion.button whileHover={{ y: -1 }} onClick={onClick} className="group flex items-center gap-4 rounded-lg border border-white/10 bg-white/[0.04] p-4 text-left hover:border-blue-400/25 hover:bg-white/[0.07]">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/65 group-hover:text-blue-300">{icon}</span>
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-white">{label}</span><span className="mt-1 block text-xs leading-5 text-white/50">{desc}</span></span>
      <ArrowRight size={15} className="shrink-0 text-white/35 group-hover:text-blue-300" />
    </motion.button>
  );
}
