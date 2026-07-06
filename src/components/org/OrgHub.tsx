import React, { Suspense, lazy, useMemo, useState } from 'react';
import {
  Building2, BookOpen, Package, Users, Settings,
  ClipboardCheck, ScrollText, MessageSquare, ArrowLeft,
  Shield, User, Briefcase, Home, Scale, Palette, GitBranch, Loader2, MessagesSquare,
} from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { useT } from '../../lib/useT';
import { toast } from 'sonner';

const AuditLogViewer = lazy(() => import('./AuditLogViewer').then(m => ({ default: m.AuditLogViewer })));
const BranchDashboard = lazy(() => import('./BranchDashboard').then(m => ({ default: m.BranchDashboard })));
const CentralLumiChat = lazy(() => import('./CentralLumiChat').then(m => ({ default: m.CentralLumiChat })));
const DesignHub = lazy(() => import('./DesignHub').then(m => ({ default: m.DesignHub })));
const KnowledgeBaseBrowser = lazy(() => import('./KnowledgeBaseBrowser').then(m => ({ default: m.KnowledgeBaseBrowser })));
const KnowledgeBaseEditor = lazy(() => import('./KnowledgeBaseEditor').then(m => ({ default: m.KnowledgeBaseEditor })));
const LegalHub = lazy(() => import('./LegalHub').then(m => ({ default: m.LegalHub })));
const MessagingHub = lazy(() => import('../MessagingHub').then(m => ({ default: m.MessagingHub })));
const OrgBranchPanel = lazy(() => import('../OrgBranchPanel').then(m => ({ default: m.OrgBranchPanel })));
const OrgMembers = lazy(() => import('./OrgMembers').then(m => ({ default: m.OrgMembers })));
const OrgSettings = lazy(() => import('./OrgSettings').then(m => ({ default: m.OrgSettings })));
const TemplateCreator = lazy(() => import('./TemplateCreator').then(m => ({ default: m.TemplateCreator })));
const TemplateMarketplace = lazy(() => import('./TemplateMarketplace').then(m => ({ default: m.TemplateMarketplace })));
const TemplateReviewQueue = lazy(() => import('./TemplateReviewQueue').then(m => ({ default: m.TemplateReviewQueue })));

type SubView = 'dashboard' | 'kb' | 'kb-edit' | 'templates' | 'templates-create' | 'review' | 'chat' | 'messaging' | 'members' | 'settings' | 'audit' | 'legal' | 'design' | 'branch';

interface NavItem {
  id: SubView;
  label: string;
  icon: React.ReactNode;
  roles: Array<'owner' | 'admin' | 'member' | 'viewer'>;
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
  const [subView, setSubView] = useState<SubView>('dashboard');
  const [editingArticleId, setEditingArticleId] = useState<string | undefined>(undefined);
  const [switchBusy, setSwitchBusy] = useState(false);
  const { workDomain, switchDomain, orgConnection } = useApp();
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);

  const allNavItems: NavItem[] = useMemo(() => [
    { id: 'dashboard', label: t.orgDashboard, icon: <Home size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
    { id: 'chat', label: t.orgChat, icon: <MessageSquare size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
    { id: 'kb', label: t.orgKB, icon: <BookOpen size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
    { id: 'messaging', label: t.messaging || ui('消息接入', 'Messaging'), icon: <MessagesSquare size={16} />, roles: ['owner', 'admin', 'member'] },
    { id: 'templates', label: t.orgTemplates, icon: <Package size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
    { id: 'review', label: t.orgReview, icon: <ClipboardCheck size={16} />, roles: ['owner', 'admin'] },
    { id: 'members', label: t.orgMembers, icon: <Users size={16} />, roles: ['owner', 'admin'] },
    { id: 'audit', label: t.orgAudit, icon: <ScrollText size={16} />, roles: ['owner', 'admin'] },
    { id: 'legal', label: t.legalHub || ui('律所', 'Legal'), icon: <Scale size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
    { id: 'design', label: t.designHub || ui('设计所', 'Design'), icon: <Palette size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
    { id: 'settings', label: t.orgSettings, icon: <Settings size={16} />, roles: ['owner', 'admin'] },
    { id: 'branch', label: t.branchTerminal || ui('分支终端', 'Branch Terminal'), icon: <GitBranch size={16} />, roles: ['owner', 'admin', 'member', 'viewer'] },
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
        if (detail.sub === 'kb-edit') setEditingArticleId(detail.articleId || undefined);
        else if (detail.sub === 'kb') setEditingArticleId(undefined);
        setSubView(detail.sub as SubView);
      }
    };
    window.addEventListener('lumi:navigate', handler);
    return () => window.removeEventListener('lumi:navigate', handler);
  }, []);

  const orgRole = orgConnection?.orgRole || 'member';
  const visibleItems = allNavItems.filter(item => item.roles.includes(orgRole as any));
  const roleInfo = roleLabel[orgRole] || roleLabel.member;
  const currentItem = visibleItems.find(item => item.id === subView) || allNavItems.find(item => item.id === subView) || allNavItems[0];

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
    if (result.success) toast.success(result.message || (target === 'work' ? ui('已进入工作域', 'Entered work domain') : ui('已进入个人域', 'Entered personal domain')));
    else toast.error(result.message || ui('工作域切换失败', 'Failed to switch domain'));
  };

  const renderView = () => {
    switch (subView) {
      case 'dashboard': return <BranchDashboard />;
      case 'kb': return <KnowledgeBaseBrowser />;
      case 'kb-edit': return <KnowledgeBaseEditor articleId={editingArticleId} onSaved={() => { setEditingArticleId(undefined); setSubView('kb'); }} />;
      case 'templates': return <TemplateMarketplace />;
      case 'templates-create': return <TemplateCreator />;
      case 'review': return <TemplateReviewQueue />;
      case 'chat': return <CentralLumiChat />;
      case 'messaging': return <MessagingHub t={t} />;
      case 'members': return <OrgMembers />;
      case 'settings': return <OrgSettings />;
      case 'audit': return <AuditLogViewer />;
      case 'legal': return <LegalHub />;
      case 'design': return <DesignHub />;
      case 'branch': return <OrgBranchPanel />;
      default: return <BranchDashboard />;
    }
  };

  return (
    <div className="lumi-surface flex h-full overflow-hidden rounded-none border-0 bg-black/20">
      {/* Sidebar */}
      <div className="flex w-60 shrink-0 flex-col border-r border-white/[0.08] bg-black/25">
        <div className="space-y-3 border-b border-white/[0.08] p-4">
          <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.12em] text-white/85">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-blue-300/15 bg-blue-400/10 text-blue-200">
              <Building2 size={16} />
            </span>
            <span className="min-w-0 truncate">{t.orgWorkSpace}</span>
          </h3>
          {orgConnection?.orgName && (
            <p className="truncate text-xs text-white/55">{orgConnection.orgName}</p>
          )}
          {/* Role badge */}
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] ${roleInfo.color}`}>
            {roleInfo.icon} {roleInfo.label}
          </span>
          {/* Domain switch */}
          <button
            onClick={handleDomainToggle}
            disabled={switchBusy}
            className={`lumi-button h-9 w-full justify-start px-3 ${
              workDomain === 'work'
                ? 'border-blue-400/25 bg-blue-500/10 text-blue-300'
                : ''
            }`}
          >
            {switchBusy ? <Loader2 size={12} className="animate-spin" /> : workDomain === 'work' ? <Briefcase size={12} /> : <User size={12} />}
            {switchBusy ? (t.switching || ui('切换中...', 'Switching...')) : workDomain === 'work' ? t.orgWorkDomain : t.orgPersonalDomain}
          </button>
        </div>

        <nav className="custom-scrollbar flex-1 space-y-1 overflow-y-auto p-2">
          {visibleItems.map(item => (
            <button
              key={item.id}
              onClick={() => openSubView(item.id)}
              className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors ${
                subView === item.id
                  ? 'border border-blue-400/20 bg-blue-500/10 text-blue-200'
                  : 'border border-transparent text-white/50 hover:border-white/[0.08] hover:bg-white/[0.05] hover:text-white/80'
              }`}
            >
              <span className="shrink-0">{item.icon}</span>
              <span className="min-w-0 truncate">{item.label}</span>
            </button>
          ))}
          <div className="my-2 border-t border-white/[0.08]" />
          <button
            onClick={() => {
              void switchDomain('personal').finally(() => {
                window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'home' } }));
              });
            }}
            className="flex w-full items-center gap-2 rounded-xl border border-transparent px-3 py-2 text-sm text-white/40 transition-colors hover:border-white/[0.08] hover:bg-white/[0.05] hover:text-white/70"
          >
            <ArrowLeft size={16} />
            <span className="min-w-0 truncate">{t.orgExitWorkSpace}</span>
          </button>
        </nav>
      </div>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-white/[0.08] bg-black/30 px-5 py-3 backdrop-blur-xl">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-white/85">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-blue-300/15 bg-blue-400/10 text-blue-200">{currentItem.icon}</span>
              <h2 className="truncate text-sm font-black uppercase tracking-[0.14em]">{currentItem.label}</h2>
            </div>
            <p className="mt-0.5 truncate text-xs text-white/35">
              {orgConnection?.orgName || t.orgWorkSpace} · {workDomain === 'work' ? t.orgWorkDomain : t.orgPersonalDomain}
            </p>
          </div>
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${roleInfo.color}`}>
            {roleInfo.label}
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
