import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Bot,
  Building2,
  Clock,
  Package,
  RefreshCw,
  ShieldCheck,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useT } from '../../lib/useT';
import { useApp } from '../../contexts/AppContext';
import { formatUiMessage, uiMessage } from '../../i18n/uiMessages';

interface DashboardStats {
  memberCount: number;
  kbArticleCount: number;
  templateCount: number;
  installedAgentCount: number;
  syncStatus: 'connected' | 'offline' | 'syncing';
  lastSync: string | null;
}

interface InstalledTeamAgent {
  id: string;
  name: string;
  category: string;
  isFrozen?: boolean;
  installedTemplateVersion?: number;
  knowledgeDomains?: string[];
}

export function BranchDashboard() {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);
  const { orgConnection, workDomain } = useApp();
  const [stats, setStats] = useState<DashboardStats>({
    memberCount: 0,
    kbArticleCount: 0,
    templateCount: 0,
    installedAgentCount: 0,
    syncStatus: 'connected',
    lastSync: null,
  });
  const [installedAgents, setInstalledAgents] = useState<InstalledTeamAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const readArray = useCallback(async (url: string) => {
    const response = await fetch(url, { credentials: 'include' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${url} failed (${response.status})`);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.articles)) return data.articles;
    if (Array.isArray(data.templates)) return data.templates;
    if (Array.isArray(data.members)) return data.members;
    return [];
  }, []);

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const statusRes = await fetch('/api/org/status', { credentials: 'include' });
      const status = await statusRes.json().catch(() => ({}));
      if (!statusRes.ok) throw new Error(status.error || uiMessage('branch-dashboard.failed-to-load-organization-status.d4517ef501'));

      let orgId = orgConnection?.orgId || status.orgId || '';
      if (!orgId) {
        const orgs = await readArray('/api/org/org');
        orgId = orgs[0]?.id || orgs[0]?.orgId || '';
      }

      const partialErrors: string[] = [];
      const [members, articles, templates, agents] = await Promise.all([
        orgId ? readArray(`/api/org/org/${orgId}/members`).catch(err => { partialErrors.push(err.message); return []; }) : Promise.resolve([]),
        readArray('/api/org/kb/articles?status=published').catch(err => { partialErrors.push(err.message); return []; }),
        readArray('/api/org/templates?status=published').catch(err => { partialErrors.push(err.message); return []; }),
        readArray('/api/agents').catch(err => { partialErrors.push(err.message); return []; }),
      ]);
      const installedTemplateAgents = agents
        .filter((agent: any) => agent?.installedTemplateId && agent.status !== 'terminated')
        .map((agent: any) => ({
          id: String(agent.id),
          name: String(agent.name || uiMessage('branch-dashboard.untitled-assistant.16370b0265')),
          category: String(agent.category || 'general'),
          isFrozen: Boolean(agent.isFrozen),
          installedTemplateVersion: Number(agent.installedTemplateVersion) || undefined,
          knowledgeDomains: Array.isArray(agent.knowledgeDomains) ? agent.knowledgeDomains.map(String) : [],
        }));

      if (partialErrors.length > 0) {
        setError(uiMessage('branch-dashboard.some-organization-data-failed-to.1601df32ce'));
      }
      setInstalledAgents(installedTemplateAgents);

      setStats({
        memberCount: members.length,
        kbArticleCount: articles.length,
        templateCount: templates.length,
        installedAgentCount: installedTemplateAgents.length,
        syncStatus: status.connected ? 'connected' : 'offline',
        lastSync: new Date().toISOString(),
      });
    } catch (err: any) {
      setError(err?.message || uiMessage('branch-dashboard.failed-to-load-organization-workspace.b1ad2b265e'));
      setStats(prev => ({ ...prev, syncStatus: 'offline' }));
      setInstalledAgents([]);
    } finally {
      setLoading(false);
    }
  }, [orgConnection?.orgId, readArray, ui]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    const refresh = () => void loadStats();
    window.addEventListener('lumi:agents-changed', refresh);
    return () => window.removeEventListener('lumi:agents-changed', refresh);
  }, [loadStats]);

  const cards = useMemo(() => [
    {
      label: t.orgMembers || uiMessage('branch-dashboard.members.437a10e110'),
      value: stats.memberCount,
      icon: <Users size={18} />,
      tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-400/20',
    },
    {
      label: t.orgKB || uiMessage('branch-dashboard.knowledge-base.e30b5fc119'),
      value: stats.kbArticleCount,
      icon: <BookOpen size={18} />,
      tone: 'text-blue-300 bg-blue-500/10 border-blue-400/20',
    },
    {
      label: t.orgTemplates || uiMessage('branch-dashboard.agent-templates.9cc4c8c9d0'),
      value: stats.templateCount,
      icon: <Package size={18} />,
      tone: 'text-violet-300 bg-violet-500/10 border-violet-400/20',
    },
    {
      label: uiMessage('branch-dashboard.team-agents.4363c79c8f'),
      value: stats.installedAgentCount,
      icon: <Bot size={18} />,
      tone: 'text-cyan-300 bg-cyan-500/10 border-cyan-400/20',
    },
  ], [stats.installedAgentCount, stats.kbArticleCount, stats.memberCount, stats.templateCount, t.orgKB, t.orgMembers, t.orgTemplates, ui]);

  const openTeamAgent = (agentId?: string) => {
    if (agentId) {
      try { window.sessionStorage.setItem('lumi:team:selected-agent-id', agentId); } catch {}
    }
    window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'team', agentId } }));
    if (agentId) {
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('lumi:team:select-agent', { detail: { agentId } }));
      }, 80);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-blue-400/20 bg-blue-500/10 text-blue-300">
                  <Building2 size={22} />
                </span>
                <div>
                  <h1 className="text-xl font-semibold text-white">{uiMessage('branch-dashboard.organization-workspace.dbc27e701a')}</h1>
                  <p className="text-sm text-white/55">
                    {orgConnection?.orgName || uiMessage('branch-dashboard.local-organization-domain.707a7949c6')}
                    {' · '}
                    {workDomain === 'work' ? uiMessage('branch-dashboard.work-domain-active.a7d1aced7d') : uiMessage('branch-dashboard.personal-domain-active.3b73f4f5a4')}
                  </p>
                </div>
              </div>
              <p className="max-w-2xl text-sm leading-6 text-white/60">
                {uiMessage('branch-dashboard.review-members-knowledge-installable-team.e395488c6e')}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                stats.syncStatus === 'connected'
                  ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-300'
                  : 'border-amber-400/20 bg-amber-500/10 text-amber-300'
              }`}>
                {stats.syncStatus === 'connected' ? <Wifi size={14} /> : <WifiOff size={14} />}
                {stats.syncStatus === 'connected'
                  ? (t.orgConnectionOnline || uiMessage('branch-dashboard.connected.77956f6a16'))
                  : (t.orgConnectionOffline || uiMessage('branch-dashboard.offline.921b60f32a'))}
              </span>
              <button
                onClick={loadStats}
                disabled={loading}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
                aria-label={uiMessage('branch-dashboard.refresh.cba212b169')}
              >
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
        </section>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100/80">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-300" />
            <span>{error}</span>
          </div>
        )}

        <section className="grid gap-3 md:grid-cols-4">
          {loading ? [1, 2, 3, 4].map(item => (
            <div key={item} className="h-28 animate-pulse rounded-lg border border-white/10 bg-white/[0.04]" />
          )) : cards.map((card, index) => (
            <motion.div
              key={card.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.04 }}
              className="rounded-lg border border-white/10 bg-white/[0.04] p-4"
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm text-white/55">{card.label}</span>
                <span className={`rounded-lg border p-2 ${card.tone}`}>{card.icon}</span>
              </div>
              <div className="text-3xl font-semibold text-white">{card.value}</div>
            </motion.div>
          ))}
        </section>

        <section className="rounded-lg border border-cyan-400/15 bg-cyan-500/[0.04] p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-cyan-100">
                <Bot size={17} />
                {uiMessage('branch-dashboard.work-assistants-installed-to-lumi.83ef29b794')}
              </h2>
              <p className="mt-1 text-xs leading-5 text-cyan-100/55">
                {uiMessage('branch-dashboard.sub-agents-installed-from-the.3c8615f16a')}
              </p>
            </div>
            <button
              onClick={() => openTeamAgent()}
              className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/20 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-100 transition hover:bg-cyan-400/20"
            >
              <ArrowRight size={14} />
              {uiMessage('branch-dashboard.open-lumi-team.e4e08bcaa7')}
            </button>
          </div>

          {loading ? (
            <div className="grid gap-3 md:grid-cols-3">
              {[1, 2, 3].map(item => <div key={item} className="h-24 animate-pulse rounded-lg border border-white/10 bg-white/[0.04]" />)}
            </div>
          ) : installedAgents.length === 0 ? (
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'templates' } }))}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.04] p-4 text-left transition hover:border-cyan-300/25 hover:bg-white/[0.07]"
            >
              <span>
                <span className="block text-sm font-medium text-white">{uiMessage('branch-dashboard.no-organization-sub-agent-installed.21910a6eef')}</span>
                <span className="mt-1 block text-xs text-white/50">{uiMessage('branch-dashboard.install-one-from-the-agent.ee355dd175')}</span>
              </span>
              <ArrowRight size={15} className="text-cyan-200/70" />
            </button>
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              {installedAgents.slice(0, 6).map(agent => (
                <button
                  key={agent.id}
                  onClick={() => openTeamAgent(agent.id)}
                  className="rounded-lg border border-white/10 bg-white/[0.04] p-4 text-left transition hover:border-cyan-300/25 hover:bg-white/[0.07]"
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-cyan-300/15 bg-cyan-500/10 text-cyan-200">
                      <Bot size={16} />
                    </span>
                    <span className={`rounded-full px-2 py-1 text-[11px] ${agent.isFrozen ? 'bg-white/5 text-white/40' : 'bg-emerald-500/10 text-emerald-200'}`}>
                      {agent.isFrozen ? uiMessage('branch-dashboard.paused.cf54b602eb') : uiMessage('branch-dashboard.ready.761a3caa34')}
                    </span>
                  </div>
                  <h3 className="truncate text-sm font-medium text-white">{agent.name}</h3>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className="rounded-md bg-white/5 px-2 py-1 text-[11px] text-white/45">{agent.category}</span>
                    {agent.installedTemplateVersion && <span className="rounded-md bg-white/5 px-2 py-1 text-[11px] text-white/45">v{agent.installedTemplateVersion}</span>}
                    {agent.knowledgeDomains?.slice(0, 2).map(domain => (
                      <span key={domain} className="rounded-md bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-100/55">{domain}</span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="grid gap-3 md:grid-cols-2">
          <QuickAction
            icon={<BookOpen size={18} />}
            label={uiMessage('branch-dashboard.open-knowledge-base.c51d425f5e')}
            desc={uiMessage('branch-dashboard.browse-search-and-edit-organization.ab59b8dfae')}
            onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'kb' } }))}
          />
          <QuickAction
            icon={<Package size={18} />}
            label={uiMessage('branch-dashboard.agent-template-marketplace.f417d328f7')}
            desc={uiMessage('branch-dashboard.review-and-publish-organization-templates.542d6a1cc5')}
            onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'templates' } }))}
          />
          <QuickAction
            icon={<Activity size={18} />}
            label={uiMessage('branch-dashboard.lumi-work-workspace.1bd0a7273b')}
            desc={uiMessage('branch-dashboard.ask-organization-level-questions-about.be4a518a8e')}
            onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'chat' } }))}
          />
          <QuickAction
            icon={<ShieldCheck size={18} />}
            label={uiMessage('branch-dashboard.members-and-access.6ff72d328b')}
            desc={uiMessage('branch-dashboard.review-members-roles-and-organization.73e7aea535')}
            onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'members' } }))}
          />
        </section>

        {stats.lastSync && (
          <div className="flex items-center gap-2 text-xs text-white/45">
            <Clock size={13} />
            <span>{formatUiMessage('branch-dashboard.last-refreshed-value0.0140c57047', { value0: { en: new Date(stats.lastSync).toLocaleString(), zh: new Date(stats.lastSync).toLocaleString('zh-CN') } })}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function QuickAction({
  icon,
  label,
  desc,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <motion.button
      whileHover={{ y: -1 }}
      onClick={onClick}
      className="group flex items-center gap-4 rounded-lg border border-white/10 bg-white/[0.04] p-4 text-left transition hover:border-blue-400/25 hover:bg-white/[0.07]"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/65 group-hover:text-blue-300">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-white">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-white/50">{desc}</span>
      </span>
      <ArrowRight size={15} className="shrink-0 text-white/35 group-hover:text-blue-300" />
    </motion.button>
  );
}
