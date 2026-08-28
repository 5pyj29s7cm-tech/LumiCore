import React, { Suspense, lazy, useMemo, useState } from 'react';
import {
  Building2, BookOpen, Users, Settings,
  ScrollText, MessageSquare, ArrowLeft,
  Shield, User, Briefcase, Home, Scale, Palette, GitBranch, Loader2, MessagesSquare,
  ChevronDown, ChevronRight, Layers,
} from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { useT } from '../../lib/useT';
import { toast } from 'sonner';
import {
  canAccessOrganizationWorkspaceView,
  listOrganizationWorkspaceViewsForRole,
  normalizeOrganizationWorkspaceView,
  type OrganizationWorkspaceView,
} from '../../../shared/org_workspace';
import {
  clearPendingOrganizationWorkspaceRoute,
  takePendingOrganizationWorkspaceRoute,
} from '../../lib/orgWorkspaceNavigation';
import { uiMessage } from '../../i18n/uiMessages';

const AuditLogViewer = lazy(() => import('./AuditLogViewer').then(m => ({ default: m.AuditLogViewer })));
const BranchDashboard = lazy(() => import('./BranchDashboard').then(m => ({ default: m.BranchDashboard })));
const CentralLumiChat = lazy(() => import('./CentralLumiChat').then(m => ({ default: m.CentralLumiChat })));
const DesignHub = lazy(() => import('./DesignHub').then(m => ({ default: m.DesignHub })));
const KnowledgeBaseBrowser = lazy(() => import('./KnowledgeBaseBrowser').then(m => ({ default: m.KnowledgeBaseBrowser })));
const KnowledgeBaseEditor = lazy(() => import('./KnowledgeBaseEditor').then(m => ({ default: m.KnowledgeBaseEditor })));
const LegalHub = lazy(() => import('./LegalHub').then(m => ({ default: m.LegalHub })));
const MessagingHub = lazy(() => import('../MessagingHub').then(m => ({ default: m.MessagingHub })));
const OrgMembers = lazy(() => import('./OrgMembers').then(m => ({ default: m.OrgMembers })));
const OrganizationSettingsWorkspace = lazy(() => import('./OrganizationSettingsWorkspace').then(m => ({ default: m.OrganizationSettingsWorkspace })));

type SubView = OrganizationWorkspaceView;

interface NavItem {
  id: SubView;
  label: string;
  icon: React.ReactNode;
  roles: Array<'owner' | 'admin' | 'member' | 'viewer'>;
  showInNav?: boolean;
}

function OrgViewFallback() {
  return (
    <div className="flex min-h-[320px] items-center justify-center text-white/35">
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-black uppercase tracking-[0.16em]">
        <Loader2 size={13} className="animate-spin" />
        <span>Loading</span>
      </div>
    </div>
  );
}

export function OrgHub() {
  const { workDomain, switchDomain, orgConnection } = useApp();
  const orgRole = orgConnection?.orgRole || 'member';
  const [initialRoute] = useState(() => {
    const route = takePendingOrganizationWorkspaceRoute();
    return route && canAccessOrganizationWorkspaceView(orgRole, route.view) ? route : null;
  });
  const [subView, setSubView] = useState<SubView>(() => initialRoute?.view || 'dashboard');
  const [editingArticleId, setEditingArticleId] = useState<string | undefined>(() => initialRoute?.articleId);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [orgModulesOpen, setOrgModulesOpen] = useState(false);
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);

  const allNavItems: NavItem[] = useMemo(() => [
    { id: 'dashboard', label: t.orgDashboard, icon: <Home size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
    { id: 'kb', label: t.orgKB, icon: <BookOpen size={16} />, roles: ['owner', 'admin', 'member', 'viewer'], showInNav: false },
    { id: 'chat', label: t.orgChat, icon: <MessageSquare size={16} />, roles: ['owner', 'admin', 'member', 'viewer'], showInNav: false },
    { id: 'messaging', label: t.messaging || uiMessage('org-hub.messaging.ec30100616'), icon: <MessagesSquare size={16} />, roles: ['owner', 'admin', 'member'] },
    { id: 'members', label: t.orgMembers, icon: <Users size={16} />, roles: ['owner', 'admin'], showInNav: false },
    { id: 'audit', label: t.orgAudit, icon: <ScrollText size={16} />, roles: ['owner', 'admin'] },
    { id: 'legal', label: t.legalHub || uiMessage('org-hub.legal.95d17f5100'), icon: <Scale size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
    { id: 'spatial-design', label: uiMessage('org-hub.spatial-architecture.ad5a608bfc'), icon: <Building2 size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
    { id: 'brand-design', label: uiMessage('org-hub.brand-creative.2ae19b7f69'), icon: <Palette size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
    { id: 'settings', label: t.orgSettings, icon: <Settings size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
    { id: 'branch', label: uiMessage('org-hub.branch-connection.9cecc72547'), icon: <GitBranch size={16} />, roles: ['owner', 'admin', 'member', 'viewer'], showInNav: false },
  ], [t, isZh]);

  const roleLabel: Record<string, { label: string; icon: React.ReactNode; color: string }> = useMemo(() => ({
    owner:  { label: t.orgRoleOwner,  icon: <Shield size={10} />, color: 'text-amber-400 bg-amber-500/10' },
    admin:  { label: t.orgRoleAdmin,  icon: <Shield size={10} />, color: 'text-red-400 bg-red-500/10' },
    member: { label: t.orgRoleMember, icon: <User size={10} />,   color: 'text-blue-400 bg-blue-500/10' },
    viewer: { label: t.orgRoleViewer, icon: <User size={10} />,   color: 'text-white/40 bg-white/5' },
  }), [t]);

  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tab === 'org' && detail?.sub) {
        const requestedView = normalizeOrganizationWorkspaceView(detail.sub);
        if (!requestedView || !canAccessOrganizationWorkspaceView(orgRole, requestedView)) return;
        if (requestedView === 'kb-edit') setEditingArticleId(detail.articleId || undefined);
        else if (requestedView === 'kb') setEditingArticleId(undefined);
        setSubView(requestedView);
        window.setTimeout(clearPendingOrganizationWorkspaceRoute, 0);
      }
    };
    window.addEventListener('lumi:navigate', handler);
    return () => window.removeEventListener('lumi:navigate', handler);
  }, [orgRole]);

  const visibleItems = allNavItems.filter(item => item.roles.includes(orgRole as any));
  const availableWorkspaceViews = useMemo(
    () => listOrganizationWorkspaceViewsForRole(orgRole),
    [orgRole],
  );
  const moduleItemIds = useMemo(() => new Set<SubView>(['legal', 'spatial-design', 'brand-design']), []);
  const primaryNavItems = visibleItems.filter(item => item.showInNav !== false && !moduleItemIds.has(item.id));
  const moduleNavItems = visibleItems.filter(item => moduleItemIds.has(item.id));
  const isModuleView = moduleItemIds.has(subView);
  const roleInfo = roleLabel[orgRole] || roleLabel.member;
  const currentItem = visibleItems.find(item => item.id === subView) || allNavItems.find(item => item.id === subView) || allNavItems[0];

  React.useEffect(() => {
    if (isModuleView) setOrgModulesOpen(true);
  }, [isModuleView]);

  React.useEffect(() => {
    if (!canAccessOrganizationWorkspaceView(orgRole, subView)) {
      setEditingArticleId(undefined);
      setSubView('dashboard');
    }
  }, [orgRole, subView]);

  React.useEffect(() => {
    window.dispatchEvent(new CustomEvent('lumi:org-view-changed', {
      detail: {
        activeView: subView,
        availableViews: availableWorkspaceViews,
        orgId: orgConnection?.orgId || '',
        role: orgRole,
      },
    }));
  }, [availableWorkspaceViews, orgConnection?.orgId, orgRole, subView]);

  const openSubView = (view: SubView) => {
    if (view !== 'kb-edit') setEditingArticleId(undefined);
    setSubView(view);
  };

  const handleDomainToggle = async () => {
    if (switchBusy) return;
    setSwitchBusy(true);
    const target = workDomain === 'personal' ? 'work' : 'personal';
    const result = await switchDomain(target);
    setSwitchBusy(false);
    if (result.success) toast.success(result.message || (target === 'work' ? uiMessage('org-hub.entered-work-domain.ba7297a3e8') : uiMessage('org-hub.entered-personal-domain.c96fa12de2')));
    else toast.error(result.message || uiMessage('org-hub.failed-to-switch-domain.297b767379'));
  };

  const displayedDomain = workDomain === 'work' ? t.orgWorkDomain : t.orgPersonalDomain;

  const renderView = () => {
    switch (subView) {
      case 'dashboard': return <BranchDashboard />;
      case 'kb': return <KnowledgeBaseBrowser />;
      case 'kb-edit': return <KnowledgeBaseEditor articleId={editingArticleId} onSaved={() => { setEditingArticleId(undefined); setSubView('kb'); }} />;
      case 'chat': return <CentralLumiChat />;
      case 'messaging': return <MessagingHub t={t} />;
      case 'members': return <OrgMembers />;
      case 'settings': return <OrganizationSettingsWorkspace />;
      case 'audit': return <AuditLogViewer />;
      case 'legal': return <LegalHub />;
      case 'spatial-design': return <DesignHub workspace="spatial" />;
      case 'brand-design': return <DesignHub workspace="brand" />;
      case 'branch': return <OrganizationSettingsWorkspace initialTab="branch" />;
      default: return <BranchDashboard />;
    }
  };

  return (
    <div className="lumi-work-surface lumi-surface flex h-full overflow-hidden rounded-none border-0 bg-black/20">
      {/* Sidebar */}
      <div className="lumi-org-sidebar flex w-16 shrink-0 flex-col border-r border-white/[0.08] bg-black/25 sm:w-60">
        <div className="space-y-3 border-b border-white/[0.08] p-2 sm:p-4">
          <h3 className="flex items-center justify-center gap-2 text-sm font-black uppercase tracking-[0.12em] text-white/85 sm:justify-start">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-blue-300/15 bg-blue-400/10 text-blue-200">
              <Building2 size={16} />
            </span>
            <span className="hidden min-w-0 truncate sm:block">{t.orgWorkSpace}</span>
          </h3>
          {orgConnection?.orgName && (
            <p className="hidden truncate text-xs text-white/55 sm:block">{orgConnection.orgName}</p>
          )}
          {/* Role badge */}
          <span title={roleInfo.label} className={`mx-auto flex w-fit items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] sm:mx-0 sm:py-0.5 ${roleInfo.color}`}>
            {roleInfo.icon} <span className="hidden sm:inline">{roleInfo.label}</span>
          </span>
          <button
            onClick={handleDomainToggle}
            disabled={switchBusy}
            aria-label={switchBusy ? (t.switching || uiMessage('org-hub.switching.c197a0b742')) : displayedDomain}
            title={switchBusy ? (t.switching || uiMessage('org-hub.switching.c197a0b742')) : displayedDomain}
            className={`lumi-button h-9 w-full justify-center px-2 sm:justify-start sm:px-3 ${
              workDomain === 'work'
                ? 'border-blue-400/25 bg-blue-500/10 text-blue-300'
                : ''
            }`}
          >
            {switchBusy ? <Loader2 size={12} className="animate-spin" /> : workDomain === 'work' ? <Briefcase size={12} /> : <User size={12} />}
            <span className="hidden sm:inline">{switchBusy ? (t.switching || uiMessage('org-hub.switching.c197a0b742')) : displayedDomain}</span>
          </button>
        </div>

        <nav className="custom-scrollbar flex-1 space-y-1 overflow-y-auto p-2">
          {primaryNavItems.map(item => (
            <button
              key={item.id}
              onClick={() => openSubView(item.id)}
              aria-label={item.label}
              title={item.label}
              className={`flex w-full items-center justify-center gap-2 rounded-xl px-2 py-2 text-sm transition-colors sm:justify-start sm:px-3 ${
                subView === item.id || (subView === 'kb-edit' && item.id === 'kb')
                  ? 'border border-blue-400/20 bg-blue-500/10 text-blue-200'
                  : 'border border-transparent text-white/50 hover:border-white/[0.08] hover:bg-white/[0.05] hover:text-white/80'
              }`}
            >
              <span className="shrink-0">{item.icon}</span>
              <span className="hidden min-w-0 truncate sm:block">{item.label}</span>
            </button>
          ))}
          {moduleNavItems.length > 0 && (
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setOrgModulesOpen(prev => !prev)}
                aria-label={uiMessage('org-hub.organization-modules.75dd9b5603')}
                title={uiMessage('org-hub.organization-modules.75dd9b5603')}
                className={`flex w-full items-center justify-center gap-2 rounded-xl border px-2 py-2 text-sm transition-colors sm:justify-start sm:px-3 ${
                  isModuleView
                    ? 'border-blue-400/20 bg-blue-500/10 text-blue-200'
                    : 'border-white/[0.08] bg-white/[0.03] text-white/55 hover:bg-white/[0.06] hover:text-white/80'
                }`}
              >
                <Layers size={16} className="shrink-0" />
                <span className="hidden min-w-0 flex-1 truncate text-left sm:block">{uiMessage('org-hub.organization-modules.75dd9b5603')}</span>
                <span className="hidden sm:block">{orgModulesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
              </button>
              {orgModulesOpen && (
                <div className="mt-1 space-y-1 sm:pl-3">
                  {moduleNavItems.map(item => (
                    <button
                      key={item.id}
                      onClick={() => openSubView(item.id)}
                      aria-label={item.label}
                      title={item.label}
                      className={`flex w-full items-center justify-center gap-2 rounded-xl px-2 py-2 text-sm transition-colors sm:justify-start sm:px-3 ${
                        subView === item.id
                          ? 'border border-blue-400/20 bg-blue-500/10 text-blue-200'
                          : 'border border-transparent text-white/45 hover:border-white/[0.08] hover:bg-white/[0.05] hover:text-white/80'
                      }`}
                    >
                      <span className="shrink-0">{item.icon}</span>
                      <span className="hidden min-w-0 truncate sm:block">{item.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="my-2 border-t border-white/[0.08]" />
          <button
            onClick={() => {
              void switchDomain('personal').finally(() => {
                window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'home' } }));
              });
            }}
            aria-label={t.orgExitWorkSpace}
            title={t.orgExitWorkSpace}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-transparent px-2 py-2 text-sm text-white/40 transition-colors hover:border-white/[0.08] hover:bg-white/[0.05] hover:text-white/70 sm:justify-start sm:px-3"
          >
            <ArrowLeft size={16} />
            <span className="hidden min-w-0 truncate sm:block">{t.orgExitWorkSpace}</span>
          </button>
        </nav>
      </div>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-white/[0.08] bg-black/30 px-3 py-3 backdrop-blur-xl sm:gap-4 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-white/85">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-blue-300/15 bg-blue-400/10 text-blue-200">{currentItem.icon}</span>
              <h2 className="truncate text-sm font-black uppercase tracking-[0.14em]">{currentItem.label}</h2>
            </div>
            <p className="mt-0.5 truncate text-xs text-white/35">
              {orgConnection?.orgName || t.orgWorkSpace} · {displayedDomain}
            </p>
          </div>
          <span title={roleInfo.label} className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] sm:px-2.5 ${roleInfo.color}`}>
            {roleInfo.icon}<span className="hidden sm:inline">{roleInfo.label}</span>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
          <Suspense fallback={<OrgViewFallback />}>
            {renderView()}
          </Suspense>
        </div>
      </div>
    </div>
  );
}
