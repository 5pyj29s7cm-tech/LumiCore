import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Scale, FileText, Search, Crosshair, Shield, Brain, CheckCircle, Upload,
  Calendar, ClipboardList, Plus, FolderOpen, Gavel, AlertTriangle, RefreshCw, Loader2, Database,
  ArrowRight, Archive,
} from 'lucide-react';
import { toast } from 'sonner';
import { LegalBidWorkbench } from './LegalBidWorkbench';
import { LegalCaseSearch } from './LegalCaseSearch';
import { LegalAssetTrace } from './LegalAssetTrace';
import { LegalContractReview } from './LegalContractReview';
import { LegalDataSourcesSettings } from './LegalDataSourcesSettings';
import { useT } from '../../lib/useT';
import { useApp } from '../../contexts/AppContext';
import {
  clearLegalConsultationCaseId,
  createEmptyLegalCase,
  getActiveLegalCaseId,
  LEGAL_CASES_CHANGED_EVENT,
  readLegalCaseFiles,
  setActiveLegalCaseId,
  setLegalConsultationCaseId,
  writeLegalCaseFiles,
  type LegalCaseFile,
  type LegalCaseMaterial,
  type LegalCaseStage,
} from '../../lib/legalCaseStore';

type LegalView = 'workspace' | 'packet' | 'external-research' | 'data-sources' | 'bid' | 'case-search' | 'asset-trace' | 'contract-review' | 'strategy' | 'verify' | 'import' | 'knowledge-sync';

interface NavItem {
  id: LegalView;
  label: string;
  icon: React.ReactNode;
}

const LEGAL_WORKFLOW_ORDER: LegalView[] = [
  'workspace',
  'import',
  'external-research',
  'case-search',
  'asset-trace',
  'contract-review',
  'strategy',
  'packet',
  'verify',
  'knowledge-sync',
];

function legalCaseTitle(caseFile?: LegalCaseFile | null): string {
  if (!caseFile) return 'Untitled legal case';
  return caseFile.title || caseFile.party || caseFile.caseNumber || 'Untitled legal case';
}

function buildLegalCaseKnowledgeMarkdown(caseFile: LegalCaseFile): string {
  const materialLines = (caseFile.materials || []).map((material, index) => [
    `## Material ${index + 1}: ${material.title}`,
    `- Type: ${material.type}`,
    `- Source: ${material.source || 'manual'}`,
    `- Created: ${material.createdAt}`,
    '',
    material.content || '(No extracted content)',
  ].join('\n'));

  return [
    `# Legal Case Archive: ${legalCaseTitle(caseFile)}`,
    '',
    '## Case Profile',
    `- Case number: ${caseFile.caseNumber || '-'}`,
    `- Party: ${caseFile.party || '-'}`,
    `- Cause: ${caseFile.cause || '-'}`,
    `- Court: ${caseFile.court || '-'}`,
    `- Judge: ${caseFile.judge || '-'}`,
    `- Stage: ${caseFile.stage || '-'}`,
    `- Hearing date: ${caseFile.hearingDate || '-'}`,
    `- Judgment date: ${caseFile.judgmentDate || '-'}`,
    `- Appeal deadline: ${caseFile.appealDeadline || '-'}`,
    `- Enforcement deadline: ${caseFile.enforcementDeadline || '-'}`,
    '',
    '## Facts / Notes',
    caseFile.notes || '(No notes)',
    '',
    '## Archived Materials',
    materialLines.length > 0 ? materialLines.join('\n\n') : '(No materials archived yet)',
  ].join('\n');
}

function addDays(dateValue: string, days: number): string {
  if (!dateValue) return '';
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function inferLegalMaterialTitle(content: string, fallback: string): string {
  const caseNumber = content.match(/[（(]\d{4}[）)][^\n，。；;]{2,80}(?:号|字第?\d+号?)/)?.[0];
  if (caseNumber) return `${fallback} ${caseNumber}`;
  const firstLine = content.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 80) : fallback;
}

export function LegalHub() {
  const [view, setView] = useState<LegalView>('workspace');
  const [cases, setCases] = useState<LegalCaseFile[]>(() => readLegalCaseFiles());
  const [activeCaseId, setActiveCaseIdState] = useState(() => getActiveLegalCaseId());
  const [orgCasesLoading, setOrgCasesLoading] = useState(false);
  const { workDomain, orgConnection } = useApp();
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);
  const useOrgCases = workDomain === 'work' && Boolean(orgConnection?.connected && orgConnection?.orgId);

  const refreshCases = useCallback(async () => {
    if (!useOrgCases) {
      setCases(readLegalCaseFiles());
      setActiveCaseIdState(getActiveLegalCaseId());
      return;
    }

    setOrgCasesLoading(true);
    try {
      const res = await fetch('/api/org/legal/cases', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui('组织案件加载失败', 'Failed to load organization cases'));
      const loaded = Array.isArray(data.cases) ? data.cases : [];
      setCases(loaded);
      setActiveCaseIdState(prev => (prev && loaded.some((item: LegalCaseFile) => item.id === prev)) ? prev : (loaded[0]?.id || ''));
    } catch (err: any) {
      toast.error(err?.message || ui('组织案件加载失败', 'Failed to load organization cases'));
    } finally {
      setOrgCasesLoading(false);
    }
  }, [ui, useOrgCases]);

  useEffect(() => {
    const syncCases = () => {
      if (useOrgCases) return;
      setCases(readLegalCaseFiles());
      setActiveCaseIdState(getActiveLegalCaseId());
    };
    const syncStorage = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith('lumi_legal_')) syncCases();
    };
    window.addEventListener(LEGAL_CASES_CHANGED_EVENT, syncCases);
    window.addEventListener('storage', syncStorage);
    return () => {
      window.removeEventListener(LEGAL_CASES_CHANGED_EVENT, syncCases);
      window.removeEventListener('storage', syncStorage);
    };
  }, [useOrgCases]);

  useEffect(() => {
    if (!useOrgCases) {
      setCases(readLegalCaseFiles());
      setActiveCaseIdState(getActiveLegalCaseId());
      return;
    }
    void refreshCases();
    window.addEventListener('lumi:org-legal-cases-changed', refreshCases);
    return () => {
      window.removeEventListener('lumi:org-legal-cases-changed', refreshCases);
    };
  }, [orgConnection?.orgId, refreshCases, useOrgCases]);

  const navItems: NavItem[] = useMemo(() => [
    { id: 'workspace', label: ui('案件工作台', 'Case Workspace'), icon: <FolderOpen size={16} /> },
    { id: 'packet', label: ui('文书包', 'Packet'), icon: <ClipboardList size={16} /> },
    { id: 'external-research', label: ui('外部检索', 'Research'), icon: <Search size={16} /> },
    { id: 'data-sources', label: ui('数据源', 'Data Sources'), icon: <Database size={16} /> },
    { id: 'bid', label: t.legalBidWorkbench, icon: <FileText size={16} /> },
    { id: 'case-search', label: t.legalCaseSearch, icon: <Search size={16} /> },
    { id: 'asset-trace', label: t.legalAssetTrace, icon: <Crosshair size={16} /> },
    { id: 'contract-review', label: t.legalContractReview, icon: <Shield size={16} /> },
    { id: 'strategy', label: t.legalCaseStrategy, icon: <Brain size={16} /> },
    { id: 'verify', label: t.legalVerifyCitation, icon: <CheckCircle size={16} /> },
    { id: 'import', label: t.legalImportJudgment, icon: <Upload size={16} /> },
    { id: 'knowledge-sync', label: ui('同步知识库', 'Sync to KB'), icon: <Archive size={16} /> },
  ], [t, ui]);

  const workflowNavItems = useMemo(() => {
    const order = new Map(LEGAL_WORKFLOW_ORDER.map((id, index) => [id, index]));
    return navItems
      .filter(item => item.id !== 'data-sources' && item.id !== 'bid')
      .sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
  }, [navItems]);
  const specialToolNavItems = useMemo(() => navItems.filter(item => item.id === 'bid'), [navItems]);
  const utilityNavItems = useMemo(() => navItems.filter(item => item.id === 'data-sources'), [navItems]);

  const activeCase = useMemo(() => {
    return cases.find(item => item.id === activeCaseId) || cases[0] || null;
  }, [activeCaseId, cases]);
  const workflowStepIndex = workflowNavItems.findIndex(item => item.id === view);
  const isWorkflowView = workflowStepIndex >= 0;
  const isSpecialToolView = specialToolNavItems.some(item => item.id === view);
  const activeStepIndex = isWorkflowView ? workflowStepIndex : 0;
  const currentStep = isWorkflowView ? workflowNavItems[activeStepIndex] : navItems.find(item => item.id === view);
  const nextStep = isWorkflowView ? (workflowNavItems[activeStepIndex + 1] || null) : null;

  const saveCases = (next: LegalCaseFile[], nextActiveId = activeCaseId) => {
    setCases(next);
    if (!useOrgCases) writeLegalCaseFiles(next, nextActiveId);
    if (nextActiveId) setActiveCaseIdState(nextActiveId);
  };

  const createCase = async () => {
    const nextCase = createEmptyLegalCase();
    nextCase.title = ui('新案件', 'New Case');
    try {
      if (useOrgCases) {
        const res = await fetch('/api/org/legal/cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(nextCase),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ui('案件创建失败', 'Failed to create case'));
        saveCases([data, ...cases], data.id);
      } else {
        saveCases([nextCase, ...cases], nextCase.id);
      }
      setView('workspace');
      toast.success(ui('已创建案件档案', 'Case file created'));
    } catch (err: any) {
      toast.error(err?.message || ui('案件创建失败', 'Failed to create case'));
    }
  };

  const updateCase = (id: string, patch: Partial<LegalCaseFile>) => {
    const next = cases.map(item => item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item);
    saveCases(next, id);
    if (useOrgCases) {
      void fetch(`/api/org/legal/cases/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(patch),
      }).then(async res => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || ui('案件保存失败', 'Failed to save case'));
        }
      }).catch((err: any) => toast.error(err?.message || ui('案件保存失败', 'Failed to save case')));
    }
  };

  const addMaterial = (type: LegalCaseMaterial['type'], title: string, content?: string, source: LegalCaseMaterial['source'] = 'manual') => {
    if (!activeCase) {
      toast.info(ui('请先创建案件档案', 'Create a case file first'));
      return;
    }
    const material: LegalCaseMaterial = {
      id: `mat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type,
      title,
      content,
      source,
      createdAt: new Date().toISOString(),
    };
    if (useOrgCases) {
      setCases(prev => prev.map(item => item.id === activeCase.id ? {
        ...item,
        materials: [material, ...(item.materials || [])],
        updatedAt: new Date().toISOString(),
      } : item));
      void fetch(`/api/org/legal/cases/${encodeURIComponent(activeCase.id)}/materials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(material),
      }).then(async res => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || ui('材料归档失败', 'Failed to archive material'));
        }
      }).catch((err: any) => {
        setCases(prev => prev.map(item => item.id === activeCase.id ? {
          ...item,
          materials: (item.materials || []).filter(existing => existing.id !== material.id),
        } : item));
        toast.error(err?.message || ui('材料归档失败', 'Failed to archive material'));
      });
    } else {
      updateCase(activeCase.id, { materials: [material, ...(activeCase.materials || [])] });
    }
  };

  const createReminder = async (content: string, dueAt?: string) => {
    try {
      const res = await fetch('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content, dueAt: dueAt ? `${dueAt}T09:00:00` : null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui('提醒创建失败', 'Failed to create reminder'));
      toast.success(ui('已加入提醒', 'Reminder added'));
    } catch (err: any) {
      toast.error(err?.message || ui('提醒创建失败', 'Failed to create reminder'));
    }
  };

  const createCasePlan = async () => {
    if (!activeCase) {
      toast.info(ui('请先创建案件档案', 'Create a case file first'));
      return;
    }
    const title = `${ui('案件推进', 'Case plan')}: ${activeCase.title || activeCase.party || activeCase.caseNumber || activeCase.id}`;
    try {
      const res = await fetch('/api/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title,
          description: activeCase.notes || activeCase.cause || '',
          tags: ['legal', activeCase.stage, activeCase.cause].filter(Boolean),
          source: 'user',
          priority: activeCase.stage === 'trial' || activeCase.stage === 'judgment' ? 'high' : 'medium',
          steps: [
            { title: ui('整理当事人陈述和证据材料', 'Organize party statements and evidence'), description: activeCase.notes || '' },
            { title: ui('检索类案并形成争议焦点', 'Search similar cases and identify issues'), description: activeCase.cause || '' },
            { title: ui('生成文书草稿并由律师复核', 'Draft documents for lawyer review'), description: activeCase.caseNumber || '' },
          ],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui('案件计划创建失败', 'Failed to create case plan'));
      toast.success(ui('案件计划已创建', 'Case plan created'));
      window.dispatchEvent(new CustomEvent('lumi:client-action', { detail: { action: 'open_plans' } }));
    } catch (err: any) {
      toast.error(err?.message || ui('案件计划创建失败', 'Failed to create case plan'));
    }
  };

  const startConsultation = () => {
    if (!activeCase) {
      toast.info(ui('请先创建案件档案', 'Create a case file first'));
      return;
    }
    setLegalConsultationCaseId(activeCase.id);
    window.dispatchEvent(new CustomEvent('lumi:request-meeting-mode', {
      detail: {
        action: 'start_meeting_mode',
        confirmed: true,
        resetNotes: true,
        legalCaseId: activeCase.id,
        legalCaseTitle: activeCase.title || activeCase.party || activeCase.caseNumber || ui('未命名案件', 'Untitled case'),
        respond: () => toast.success(ui('已进入会谈记录模式，结束后会自动归档到当前案件', 'Consultation capture started; the report will archive to this case')),
        reject: (message: string) => {
          clearLegalConsultationCaseId();
          toast.error(message || ui('无法启动会谈记录', 'Failed to start consultation capture'));
        },
      },
    }));
  };

  const openMeetingNotes = () => {
    window.dispatchEvent(new CustomEvent('lumi:client-action', {
      detail: { action: 'open_meeting_notes', respond: () => {} },
    }));
  };

  const renderView = () => {
    switch (view) {
      case 'workspace':
        return (
          <LegalCaseWorkspace
            cases={cases}
            activeCase={activeCase}
            activeCaseId={activeCase?.id || ''}
            onCreateCase={createCase}
            onSelectCase={(id) => {
              setActiveCaseIdState(id);
              setActiveLegalCaseId(id);
            }}
            onUpdateCase={updateCase}
            onSetView={setView}
            onStartConsultation={startConsultation}
            onOpenMeetingNotes={openMeetingNotes}
            onCreateReminder={createReminder}
            onCreatePlan={createCasePlan}
            onAddMaterial={addMaterial}
            onRefreshCases={refreshCases}
            orgBacked={useOrgCases}
            refreshing={orgCasesLoading}
            ui={ui}
          />
      );
      case 'packet': return <LegalPacketView caseFile={activeCase} onAddMaterial={addMaterial} />;
      case 'external-research': return <LegalExternalResearchView caseFile={activeCase} onAddMaterial={addMaterial} />;
      case 'data-sources': return <LegalDataSourcesPanel />;
      case 'bid': return <LegalBidWorkbench onSwitchView={setView} />;
      case 'case-search': return <LegalCaseSearch />;
      case 'asset-trace': return <LegalAssetTrace />;
      case 'contract-review': return <LegalContractReview />;
      case 'strategy': return <LegalStrategyView caseFile={activeCase} onAddMaterial={addMaterial} />;
      case 'verify': return <LegalVerifyView caseFile={activeCase} onAddMaterial={addMaterial} />;
      case 'import': return <LegalImportView caseFile={activeCase} onAddMaterial={addMaterial} />;
      case 'knowledge-sync': return <LegalKnowledgeSyncView caseFile={activeCase} />;
      default: return <LegalCaseSearch />;
    }
  };

  return (
    <div className="flex h-full">
      <div className="flex w-56 shrink-0 flex-col border-r border-white/[0.08] bg-black/20">
        <div className="border-b border-white/[0.08] p-4">
          <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.12em] text-white/85">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-amber-300/15 bg-amber-400/10 text-amber-300">
              <Scale size={16} />
            </span>
            <span className="min-w-0 truncate">{t.legalHub || ui('律所', 'Law Firm')}</span>
          </h3>
          {activeCase && (
            <p className="mt-2 line-clamp-2 text-xs text-white/45">
              {activeCase.title || activeCase.party || activeCase.caseNumber || ui('未命名案件', 'Untitled case')}
            </p>
          )}
        </div>
        <nav className="custom-scrollbar flex-1 space-y-1 overflow-y-auto p-2">
          {workflowNavItems.map((item, index) => (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${
                view === item.id
                  ? 'border-amber-400/20 bg-amber-500/10 text-amber-200'
                  : 'border-transparent text-white/50 hover:border-white/[0.08] hover:bg-white/[0.05] hover:text-white/80'
              }`}
            >
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border text-[10px] font-bold ${
                view === item.id
                  ? 'border-amber-300/25 bg-amber-400/15 text-amber-100'
                  : 'border-white/10 bg-white/[0.035] text-white/35'
              }`}>
                {index + 1}
              </span>
              <span className="shrink-0">{item.icon}</span>
              <span className="min-w-0 truncate">{item.label}</span>
            </button>
          ))}
          {specialToolNavItems.length > 0 && (
            <>
              <div className="my-2 border-t border-white/[0.08]" />
              <div className="px-3 pb-1 pt-1 text-[10px] font-black uppercase tracking-[0.14em] text-white/28">
                {ui('专项工具', 'Special Tools')}
              </div>
              {specialToolNavItems.map(item => (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${
                    view === item.id
                      ? 'border-violet-400/20 bg-violet-500/10 text-violet-200'
                      : 'border-transparent text-white/45 hover:border-white/[0.08] hover:bg-white/[0.05] hover:text-white/80'
                  }`}
                >
                  <span className="shrink-0">{item.icon}</span>
                  <span className="min-w-0 truncate">{item.label}</span>
                </button>
              ))}
            </>
          )}
          {utilityNavItems.length > 0 && (
            <>
              <div className="my-2 border-t border-white/[0.08]" />
              <div className="px-3 pb-1 pt-1 text-[10px] font-black uppercase tracking-[0.14em] text-white/28">
                {ui('配置', 'Settings')}
              </div>
              {utilityNavItems.map(item => (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${
                    view === item.id
                      ? 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200'
                      : 'border-transparent text-white/45 hover:border-white/[0.08] hover:bg-white/[0.05] hover:text-white/80'
                  }`}
                >
                  <span className="shrink-0">{item.icon}</span>
                  <span className="min-w-0 truncate">{item.label}</span>
                </button>
              ))}
            </>
          )}
        </nav>
      </div>
      <div className="flex min-w-0 flex-1 flex-col bg-black/10">
        <div className="border-b border-white/[0.08] bg-black/25 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-amber-200/70">
                <span>{isWorkflowView ? ui('案件流水线', 'Case Workflow') : isSpecialToolView ? ui('律所专项工具', 'Legal Special Tool') : ui('律所配置', 'Legal Settings')}</span>
                {isWorkflowView && (
                  <>
                    <span className="text-white/25">/</span>
                    <span>{activeStepIndex + 1}/{workflowNavItems.length}</span>
                  </>
                )}
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-2 text-sm text-white/70">
                <span className="truncate font-semibold text-white/85">{legalCaseTitle(activeCase)}</span>
                <span className="text-white/25">&rarr;</span>
                <span className="truncate">{currentStep?.label}</span>
                <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-white/40">
                  {(activeCase?.materials || []).length} {ui('份材料', 'materials')}
                </span>
              </div>
            </div>
            {nextStep ? (
              <button
                type="button"
                onClick={() => setView(nextStep.id)}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-500/10 px-3 text-xs font-bold text-amber-100 transition hover:bg-amber-500/18"
              >
                <span>{ui('下一步', 'Next')}</span>
                <span className="max-w-[160px] truncate">{nextStep.label}</span>
                <ArrowRight size={14} />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'chat' } }))}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-500/10 px-3 text-xs font-bold text-cyan-100 transition hover:bg-cyan-500/18"
              >
                <span>{ui('去公司 Lumi 引用', 'Ask Company Lumi')}</span>
                <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
          {renderView()}
        </div>
      </div>
    </div>
  );
}

function LegalCaseWorkspace({
  cases,
  activeCase,
  activeCaseId,
  onCreateCase,
  onSelectCase,
  onUpdateCase,
  onSetView,
  onStartConsultation,
  onOpenMeetingNotes,
  onCreateReminder,
  onCreatePlan,
  onAddMaterial,
  onRefreshCases,
  orgBacked,
  refreshing,
  ui,
}: {
  cases: LegalCaseFile[];
  activeCase: LegalCaseFile | null;
  activeCaseId: string;
  onCreateCase: () => void;
  onSelectCase: (id: string) => void;
  onUpdateCase: (id: string, patch: Partial<LegalCaseFile>) => void;
  onSetView: (view: LegalView) => void;
  onStartConsultation: () => void;
  onOpenMeetingNotes: () => void;
  onCreateReminder: (content: string, dueAt?: string) => void;
  onCreatePlan: () => void;
  onAddMaterial: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => void;
  onRefreshCases: () => void;
  orgBacked: boolean;
  refreshing: boolean;
  ui: (zh: string, en: string) => string;
}) {
  const [noticeText, setNoticeText] = useState('');
  const [noticeStatus, setNoticeStatus] = useState('');
  const [documentStatus, setDocumentStatus] = useState('');
  const [documentLoading, setDocumentLoading] = useState<'engagement' | ''>('');
  const [selectedMaterialId, setSelectedMaterialId] = useState('');
  const [caseFilter, setCaseFilter] = useState('');

  const stageLabels: Record<LegalCaseStage, string> = {
    consultation: ui('咨询', 'Consultation'),
    filing: ui('立案', 'Filing'),
    trial: ui('庭审', 'Trial'),
    judgment: ui('判决', 'Judgment'),
    enforcement: ui('执行', 'Enforcement'),
    closed: ui('结案', 'Closed'),
  };

  const update = (patch: Partial<LegalCaseFile>) => {
    if (!activeCase) return;
    onUpdateCase(activeCase.id, patch);
  };

  const filteredCases = useMemo(() => {
    const q = caseFilter.trim().toLowerCase();
    if (!q) return cases;
    return cases.filter(item => [
      item.title,
      item.caseNumber,
      item.party,
      item.cause,
      item.court,
      item.judge,
      item.notes,
    ].join('\n').toLowerCase().includes(q));
  }, [caseFilter, cases]);

  const calculateAppealDeadline = () => {
    if (!activeCase?.judgmentDate) {
      toast.info(ui('先填写判决书日期', 'Enter the judgment date first'));
      return;
    }
    const deadline = addDays(activeCase.judgmentDate, 15);
    update({ appealDeadline: deadline });
    toast.success(ui('已按常见民事判决 15 日规则计算上诉期限，请律师复核', 'Appeal deadline calculated with the default 15-day civil judgment rule; lawyer review required'));
  };

  const createDateReminder = (kind: 'hearing' | 'appeal' | 'enforcement') => {
    if (!activeCase) return;
    const date =
      kind === 'hearing' ? activeCase.hearingDate :
      kind === 'appeal' ? activeCase.appealDeadline :
      activeCase.enforcementDeadline;
    if (!date) {
      toast.info(ui('请先填写日期', 'Enter the date first'));
      return;
    }
    const label =
      kind === 'hearing' ? ui('开庭提醒', 'Hearing reminder') :
      kind === 'appeal' ? ui('上诉期限提醒', 'Appeal deadline reminder') :
      ui('执行期限提醒', 'Enforcement reminder');
    const caseName = activeCase.title || activeCase.party || activeCase.caseNumber || ui('未命名案件', 'Untitled case');
    void onCreateReminder(`${label}: ${caseName}`, date);
  };

  const extractNotice = () => {
    if (!activeCase || !noticeText.trim()) return;
    const caseNumber = noticeText.match(/[（(]\d{4}[）)][^，。；;\n]{2,80}(?:号|字第?\d+号?)/)?.[0] || '';
    const court = noticeText.match(/[\u4e00-\u9fa5]{2,40}(?:人民法院|法院)/)?.[0] || '';
    const dateMatch = noticeText.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:\s*(\d{1,2})[:：时](\d{1,2})?分?)?/);
    const hearingDate = dateMatch
      ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
      : '';
    const patch: Partial<LegalCaseFile> = {};
    if (caseNumber && !activeCase.caseNumber) patch.caseNumber = caseNumber;
    if (court && !activeCase.court) patch.court = court;
    if (hearingDate) patch.hearingDate = hearingDate;
    patch.notes = [activeCase.notes, ui('开庭通知原文：', 'Hearing notice:'), noticeText].filter(Boolean).join('\n');
    onUpdateCase(activeCase.id, patch);
    onAddMaterial('note', ui('开庭通知/短信', 'Hearing notice/SMS'), noticeText, 'notice');
    setNoticeStatus(ui('已提取通知信息，请复核案号、法院和日期。', 'Notice extracted. Review case number, court, and date.'));
  };

  const generateEngagementLetter = async () => {
    if (!activeCase || documentLoading) return;
    setDocumentLoading('engagement');
    setDocumentStatus('');
    const caseProfile = [
      activeCase.title && `案件名称：${activeCase.title}`,
      activeCase.caseNumber && `案号：${activeCase.caseNumber}`,
      activeCase.party && `当事人：${activeCase.party}`,
      activeCase.cause && `案由：${activeCase.cause}`,
      activeCase.court && `法院：${activeCase.court}`,
      activeCase.judge && `承办法官：${activeCase.judge}`,
      activeCase.stage && `阶段：${stageLabels[activeCase.stage] || activeCase.stage}`,
      activeCase.notes && `事实摘要/待补材料：\n${activeCase.notes}`,
      (activeCase.materials || []).length > 0 && `已归档材料：\n${(activeCase.materials || []).slice(0, 8).map(item => `- ${item.title}（${item.type}）`).join('\n')}`,
    ].filter(Boolean).join('\n');

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          message: `请基于下面案件档案生成一份律师委托/代理手续草稿，供律师复核后使用。\n\n要求：\n1. 使用正式法律文书结构，保留需要人工补充的字段并标注【待填写】。\n2. 不要声称已经完成正式签署或出具最终法律意见。\n3. 输出包含：委托事项、授权范围、费用/风险提示占位、双方信息、签署栏、附件清单。\n4. 如案件信息不足，仍生成可编辑草稿，并列出待补信息。\n\n## 案件档案\n${caseProfile || '当前案件档案信息较少，请生成通用委托书草稿。'}`,
          stream: false,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui('委托书草稿生成失败', 'Failed to draft engagement letter'));
      const draft = data.text || data.response || data.reply || data.message || '';
      if (!draft.trim()) throw new Error(ui('委托书草稿为空', 'Engagement letter draft is empty'));
      onAddMaterial('pleading', ui('委托书草稿', 'Engagement letter draft'), draft, 'tool');
      setDocumentStatus(ui('委托书草稿已生成并归档到当前案件材料。', 'Engagement letter draft generated and archived to current case materials.'));
    } catch (err: any) {
      setDocumentStatus(err?.message || ui('委托书草稿生成失败', 'Failed to draft engagement letter'));
    } finally {
      setDocumentLoading('');
    }
  };

  if (!activeCase) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-300">
            <Scale size={26} />
          </div>
          <h2 className="text-xl font-bold text-white">{ui('先建立一个案件档案', 'Create a case file first')}</h2>
          <p className="mt-2 text-sm leading-6 text-white/45">
            {ui('律所能力围绕案件流转：会谈、材料、类案、文书、期限和庭审都归到同一个档案里。', 'Legal work flows around a case: consultations, materials, precedents, documents, deadlines, and trial notes stay in one file.')}
          </p>
          <button
            onClick={onCreateCase}
            className="lumi-button-primary mt-6 border-amber-400/25 bg-amber-500/15 px-5 py-3 text-amber-200 hover:bg-amber-500/25"
          >
            <Plus size={16} />
            {ui('新建案件', 'New Case')}
          </button>
        </div>
      </div>
    );
  }

  const caseTitle = activeCase.title || activeCase.party || activeCase.caseNumber || ui('未命名案件', 'Untitled case');
  const selectedMaterial = (activeCase.materials || []).find(material => material.id === selectedMaterialId) || (activeCase.materials || [])[0] || null;

  return (
    <div className="custom-scrollbar h-full overflow-y-auto p-5">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-amber-300">
            <Scale size={17} />
            <span className="text-xs font-black uppercase tracking-[0.16em]">{ui('案件工作台', 'Case Workspace')}</span>
          </div>
          <h2 className="mt-1 text-2xl font-bold text-white">{caseTitle}</h2>
          <p className="mt-1 text-sm text-white/42">
            {ui('辅助律师办案，不替代执业律师的最终判断。', 'Assists legal work; final judgment remains with licensed counsel.')}
          </p>
        </div>
        <LegalMeetingInlineButton className="ml-auto" label={ui('会议', 'Meeting')} onClick={onStartConsultation} />
        <button
          onClick={onCreateCase}
          className="lumi-button h-10 px-4 text-sm"
        >
          <Plus size={15} />
          {ui('新建案件', 'New Case')}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="lumi-panel p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-bold uppercase tracking-[0.14em] text-white/40">{ui('案件列表', 'Cases')}</div>
              {orgBacked && (
                <button
                  type="button"
                  onClick={onRefreshCases}
                  disabled={refreshing}
                  className="lumi-icon-button h-7 w-7 rounded-lg"
                  title={ui('刷新组织案件', 'Refresh organization cases')}
                >
                  <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
                </button>
              )}
            </div>
            <div className="lumi-field mb-2 flex items-center gap-2 rounded-lg px-2 py-0">
              <Search size={13} className="shrink-0 text-white/30" />
              <input
                value={caseFilter}
                onChange={event => setCaseFilter(event.target.value)}
                placeholder={ui('搜索案名、案号、当事人...', 'Search case, number, party...')}
                className="h-8 min-w-0 flex-1 bg-transparent text-xs text-white/70 outline-none placeholder:text-white/25"
              />
            </div>
            <div className="space-y-1.5">
              {filteredCases.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-white/30">
                  {ui('没有匹配案件', 'No matching cases')}
                </div>
              ) : filteredCases.map(item => (
                <button
                  key={item.id}
                  onClick={() => onSelectCase(item.id)}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                    item.id === activeCaseId
                      ? 'border-amber-400/20 bg-amber-500/[0.12] text-amber-200'
                      : 'border-transparent bg-white/[0.03] text-white/58 hover:border-white/[0.08] hover:bg-white/[0.06] hover:text-white/75'
                  }`}
                >
                  <div className="truncate text-sm font-semibold">{item.title || item.party || item.caseNumber || ui('未命名案件', 'Untitled case')}</div>
                  <div className="mt-0.5 truncate text-xs text-white/32">{stageLabels[item.stage]} / {item.cause || ui('未填写案由', 'No cause')}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="lumi-panel border-amber-400/15 bg-amber-400/[0.045] p-3">
            <div className="flex items-start gap-2 text-amber-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <p className="text-xs leading-5 text-amber-100/70">
                {ui('期限计算按常见规则给出辅助提醒，涉外、刑事、行政、公告送达等情形必须人工复核。', 'Deadline calculations are assistant reminders for common matters; special cases require manual review.')}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <section className="lumi-panel p-4">
            <div className="mb-4 flex items-center gap-2 text-white/78">
              <FolderOpen size={16} className="text-amber-300" />
              <h3 className="text-sm font-bold">{ui('案件档案', 'Case File')}</h3>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <CaseField label={ui('案件名称', 'Case name')} value={activeCase.title} onChange={value => update({ title: value })} />
              <CaseField label={ui('案号', 'Case number')} value={activeCase.caseNumber} onChange={value => update({ caseNumber: value })} />
              <CaseField label={ui('当事人', 'Party')} value={activeCase.party} onChange={value => update({ party: value })} />
              <CaseField label={ui('案由', 'Cause')} value={activeCase.cause} onChange={value => update({ cause: value })} />
              <CaseField label={ui('法院', 'Court')} value={activeCase.court} onChange={value => update({ court: value })} />
              <CaseField label={ui('承办法官', 'Judge')} value={activeCase.judge} onChange={value => update({ judge: value })} />
              <label className="space-y-1.5">
                <span className="text-xs text-white/42">{ui('阶段', 'Stage')}</span>
                <select
                  value={activeCase.stage}
                  onChange={event => update({ stage: event.target.value as LegalCaseStage })}
                  className="lumi-field h-10 w-full rounded-lg focus:border-amber-400/50"
                >
                  {Object.entries(stageLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-3 block space-y-1.5">
              <span className="text-xs text-white/42">{ui('事实摘要 / 待补材料', 'Facts / missing materials')}</span>
              <textarea
                value={activeCase.notes}
                onChange={event => update({ notes: event.target.value })}
                rows={4}
                className="lumi-field w-full resize-none rounded-lg text-sm leading-6 focus:border-amber-400/50"
                placeholder={ui('记录当事人陈述、争议焦点、证据缺口、下一步动作...', 'Record statements, issues, evidence gaps, and next actions...')}
              />
            </label>
          </section>

          <section className="grid grid-cols-1 gap-3 lg:grid-cols-4">
            <LegalMeetingActionButton title={ui('当事人会谈', 'Consultation')} desc={ui('开启会议转写并归档', 'Start transcription')} onClick={onStartConsultation} />
            <LegalActionButton icon={<Search size={16} />} title={ui('类案分析', 'Case analysis')} desc={ui('按事实检索裁判思路', 'Search precedents')} onClick={() => onSetView('case-search')} />
            <LegalActionButton icon={<Brain size={16} />} title={ui('诉讼策略', 'Strategy')} desc={ui('形成争议焦点和打法', 'Build litigation route')} onClick={() => onSetView('strategy')} />
            <LegalActionButton icon={<ClipboardList size={16} />} title={ui('案件计划', 'Case plan')} desc={ui('生成推进步骤', 'Create workflow')} onClick={onCreatePlan} />
          </section>

          <section className="lumi-panel p-4">
            <div className="mb-4 flex items-center gap-2 text-white/78">
              <Calendar size={16} className="text-cyan-300" />
              <h3 className="text-sm font-bold">{ui('期限与开庭', 'Deadlines and Hearings')}</h3>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <DateField label={ui('开庭日期', 'Hearing date')} value={activeCase.hearingDate} onChange={value => update({ hearingDate: value })} onReminder={() => createDateReminder('hearing')} />
              <DateField label={ui('判决书日期', 'Judgment date')} value={activeCase.judgmentDate} onChange={value => update({ judgmentDate: value })} />
              <DateField label={ui('上诉期限', 'Appeal deadline')} value={activeCase.appealDeadline} onChange={value => update({ appealDeadline: value })} onReminder={() => createDateReminder('appeal')} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={calculateAppealDeadline} className="lumi-button h-9 px-3 text-xs">
                {ui('按判决日期计算上诉期限', 'Calculate appeal deadline')}
              </button>
              <LegalMeetingInlineButton label={ui('打开会谈笔记', 'Open meeting notes')} onClick={onOpenMeetingNotes} />
              <button onClick={() => onSetView('import')} className="lumi-button h-9 px-3 text-xs">
                {ui('导入裁判文书', 'Import judgment')}
              </button>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <div className="lumi-panel p-4">
              <div className="mb-3 flex items-center gap-2 text-white/78">
                <Gavel size={16} className="text-amber-300" />
                <h3 className="text-sm font-bold">{ui('开庭短信/通知提取', 'Hearing Notice Extractor')}</h3>
              </div>
              <textarea
                value={noticeText}
                onChange={event => setNoticeText(event.target.value)}
                rows={5}
                className="lumi-field w-full resize-none rounded-lg text-sm leading-6 focus:border-amber-400/50"
                placeholder={ui('粘贴短信或法院通知，自动提取案号、法院、开庭日期...', 'Paste SMS or court notice to extract case number, court, and hearing date...')}
              />
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={extractNotice}
                  disabled={!noticeText.trim()}
                  className="lumi-button-primary h-9 border-amber-400/25 bg-amber-500/15 px-4 text-xs text-amber-200 hover:bg-amber-500/25"
                >
                  {ui('提取到案件', 'Extract')}
                </button>
                {noticeStatus && <span className="text-xs text-emerald-300/70">{noticeStatus}</span>}
              </div>
            </div>

            <div className="lumi-panel p-4">
              <div className="mb-3 flex items-center gap-2 text-white/78">
                <FileText size={16} className="text-blue-300" />
                <h3 className="text-sm font-bold">{ui('材料与文书', 'Materials and Documents')}</h3>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={generateEngagementLetter}
                  disabled={documentLoading === 'engagement'}
                  className="lumi-button h-9 px-3 text-xs"
                >
                  {documentLoading === 'engagement' ? ui('生成中...', 'Drafting...') : ui('生成委托书', 'Engagement letter')}
                </button>
                <LegalMeetingInlineButton
                  label={ui('庭审笔录', 'Trial notes')}
                  onClick={() => {
                    setDocumentStatus(ui('已启动庭审/会谈转写，结束后会把纪要归档到当前案件。', 'Trial/consultation transcription started; notes will archive to this case when finished.'));
                    onStartConsultation();
                  }}
                />
                <button onClick={() => onSetView('contract-review')} className="lumi-button h-9 px-3 text-xs">
                  {ui('合同审查', 'Contract review')}
                </button>
                <button onClick={() => onSetView('asset-trace')} className="lumi-button h-9 px-3 text-xs">
                  {ui('财产线索', 'Asset trace')}
                </button>
              </div>
              {documentStatus && (
                <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
                  /失败|错误|empty|failed|Error/i.test(documentStatus)
                    ? 'border-red-400/20 bg-red-500/[0.08] text-red-200/80'
                    : 'border-emerald-400/[0.18] bg-emerald-500/[0.08] text-emerald-200/78'
                }`}>
                  {documentStatus}
                </div>
              )}
              <div className="mt-4 space-y-2">
                {(activeCase.materials || []).length === 0 ? (
                  <p className="text-sm text-white/28">{ui('暂无归档材料。会谈、短信、文书草稿会出现在这里。', 'No materials yet. Consultations, notices, and drafts appear here.')}</p>
                ) : (
                  activeCase.materials.slice(0, 8).map(material => (
                    <button
                      key={material.id}
                      type="button"
                      onClick={() => setSelectedMaterialId(material.id)}
                       className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left transition-colors ${
                        selectedMaterial?.id === material.id ? 'bg-cyan-400/10' : 'bg-black/22 hover:bg-white/[0.055]'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm text-white/72">{material.title}</div>
                        <div className="text-xs text-white/30">{material.type} / {new Date(material.createdAt).toLocaleString()}</div>
                      </div>
                    </button>
                  ))
                )}
              </div>
              {selectedMaterial?.content && (
                <div className="lumi-panel mt-4 rounded-xl bg-black/24 p-3">
                  <div className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-white/35">{ui('材料内容', 'Material Content')}</div>
                  <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap text-xs leading-6 text-white/68 custom-scrollbar">{selectedMaterial.content}</pre>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function CaseField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="space-y-1.5">
      <span className="text-xs text-white/42">{label}</span>
      <input
        value={value}
        onChange={event => onChange(event.target.value)}
        className="lumi-field h-10 w-full rounded-lg focus:border-amber-400/50"
      />
    </label>
  );
}

function DateField({ label, value, onChange, onReminder }: { label: string; value: string; onChange: (value: string) => void; onReminder?: () => void }) {
  return (
    <label className="space-y-1.5">
      <span className="text-xs text-white/42">{label}</span>
      <div className="flex gap-2">
        <input
          type="date"
          value={value}
          onChange={event => onChange(event.target.value)}
          className="lumi-field h-10 min-w-0 flex-1 rounded-lg focus:border-amber-400/50"
        />
        {onReminder && (
          <button type="button" onClick={onReminder} className="lumi-button h-10 rounded-lg px-3 text-xs">
            +
          </button>
        )}
      </div>
    </label>
  );
}

function LegalMeetingInlineButton({ label, onClick, className = '' }: { label: string; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 text-xs font-black uppercase tracking-[0.12em] text-cyan-100 transition-colors hover:border-cyan-300/35 hover:bg-cyan-400/15 ${className}`}
    >
      <span className="h-2 w-2 rounded-full bg-cyan-300" />
      <FileText size={14} />
      <span>{label}</span>
    </button>
  );
}

function LegalMeetingActionButton({ title, desc, onClick }: { title: string; desc: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="lumi-panel group border-cyan-400/15 bg-cyan-400/[0.045] p-4 text-left transition-colors hover:border-cyan-300/30 hover:bg-cyan-400/[0.075]"
    >
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-200 group-hover:bg-cyan-400/15">
        <FileText size={16} />
      </div>
      <div className="text-sm font-bold text-cyan-100">{title}</div>
      <div className="mt-1 text-xs leading-5 text-cyan-100/48">{desc}</div>
    </button>
  );
}

function LegalActionButton({ icon, title, desc, onClick }: { icon: React.ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="lumi-panel group p-4 text-left transition-colors hover:border-amber-400/25 hover:bg-amber-400/[0.045]"
    >
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-white/[0.08] text-amber-300 group-hover:bg-amber-400/[0.12]">
        {icon}
      </div>
      <div className="text-sm font-bold text-white/82">{title}</div>
      <div className="mt-1 text-xs leading-5 text-white/35">{desc}</div>
    </button>
  );
}

function LegalDataSourcesPanel() {
  return (
    <div className="custom-scrollbar h-full overflow-y-auto p-5">
      <LegalDataSourcesSettings />
    </div>
  );
}

function legalCaseDraftContext(caseFile?: LegalCaseFile | null): string {
  if (!caseFile) return '';
  return [
    caseFile.title && `案件：${caseFile.title}`,
    caseFile.caseNumber && `案号：${caseFile.caseNumber}`,
    caseFile.party && `当事人：${caseFile.party}`,
    caseFile.cause && `案由：${caseFile.cause}`,
    caseFile.court && `法院：${caseFile.court}`,
    caseFile.judge && `承办法官：${caseFile.judge}`,
    caseFile.notes && `事实摘要/待补材料：\n${caseFile.notes}`,
    ...(caseFile.materials || []).slice(0, 6).map(material => `材料：${material.title}\n${material.content || ''}`),
  ].filter(Boolean).join('\n\n');
}

function LegalPacketView({
  caseFile,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => void;
}) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const defaultFacts = useMemo(() => legalCaseDraftContext(caseFile), [caseFile]);
  const [role, setRole] = useState('原告');
  const [facts, setFacts] = useState(defaultFacts);
  const [claims, setClaims] = useState('');
  const [evidence, setEvidence] = useState('');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setFacts(defaultFacts);
    setResult('');
  }, [defaultFacts]);

  const generate = async () => {
    if ((!facts.trim() && !evidence.trim()) || loading) return;
    setLoading(true);
    setResult('');
    try {
      const message = [
        '请使用 legal_generate_litigation_packet 工具生成半自动诉讼文书包。',
        `案件名称：${caseFile?.title || caseFile?.caseNumber || '未命名案件'}`,
        `我方身份：${role}`,
        `案由：${caseFile?.cause || ''}`,
        `法院：${caseFile?.court || ''}`,
        `当事人：${caseFile?.party || ''}`,
        `诉请/目标：${claims}`,
        `事实：\n${facts}`,
        `证据：\n${evidence}`,
        '要求：输出必须保留律师确认点，不要自动提交或宣称可直接使用。',
      ].join('\n\n');
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, stream: false }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui('文书包生成失败', 'Packet generation failed'));
      setResult(data.text || data.response || data.reply || data.message || JSON.stringify(data));
    } catch (err: any) {
      setResult(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const archive = () => {
    if (!result || !onAddMaterial) return;
    onAddMaterial('pleading', `${caseFile?.title || caseFile?.caseNumber || ui('案件', 'Case')} 半自动文书包`, result, 'tool');
  };

  return (
    <LegalTwoPaneTool
      icon={<ClipboardList size={22} />}
      accent="amber"
      title={ui('半自动诉讼文书包', 'Semi-Automated Litigation Packet')}
      desc={ui('生成起诉/答辩/质证/委托/立案组卷工作底稿，提交和签发保留人工确认。', 'Draft complaint/defense/evidence/retainer/filing work papers with human confirmation gates.')}
      left={(
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <input value={role} onChange={event => setRole(event.target.value)} placeholder={ui('我方身份：原告/被告', 'Role: plaintiff/defendant')} className="lumi-field h-10 rounded-lg" />
            <input value={claims} onChange={event => setClaims(event.target.value)} placeholder={ui('诉请、抗辩目标或办理目标', 'Claims, defenses, or objective')} className="lumi-field h-10 rounded-lg" />
          </div>
          <textarea value={facts} onChange={event => setFacts(event.target.value)} placeholder={ui('案件事实、时间线、当事人信息...', 'Facts, timeline, parties...')} className="mt-3 min-h-[240px] w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-amber-400/35" />
          <textarea value={evidence} onChange={event => setEvidence(event.target.value)} placeholder={ui('已有证据、对方材料、缺证点...', 'Evidence, opponent materials, gaps...')} className="mt-3 min-h-[140px] w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-amber-400/35" />
          <button onClick={generate} disabled={loading || (!facts.trim() && !evidence.trim())} className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg border border-amber-400/20 bg-amber-500/15 px-4 py-2.5 text-sm font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:opacity-50">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <ClipboardList size={16} />}
            {loading ? ui('生成中...', 'Generating...') : ui('生成文书包', 'Generate Packet')}
          </button>
        </>
      )}
      result={result}
      emptyText={ui('半自动文书包会显示在这里。', 'The packet will appear here.')}
      archiveLabel={ui('归档到案件', 'Archive to Case')}
      onArchive={result ? archive : undefined}
    />
  );
}

function LegalExternalResearchView({
  caseFile,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => void;
}) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const defaultFacts = useMemo(() => legalCaseDraftContext(caseFile), [caseFile]);
  const [issues, setIssues] = useState(caseFile?.cause || '');
  const [companies, setCompanies] = useState(caseFile?.party || '');
  const [facts, setFacts] = useState(defaultFacts);
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setIssues(caseFile?.cause || '');
    setCompanies(caseFile?.party || '');
    setFacts(defaultFacts);
    setResult('');
  }, [caseFile?.cause, caseFile?.party, defaultFacts]);

  const generate = async () => {
    if (!facts.trim() && !issues.trim() && !companies.trim()) return;
    setLoading(true);
    setResult('');
    try {
      const message = [
        '请使用 legal_external_research_plan 工具生成半自动外部检索行动单。',
        `案由：${caseFile?.cause || ''}`,
        `事实：\n${facts}`,
        `争议焦点：${issues}`,
        `公司/被执行人：${companies}`,
        '要求：输出网页登录预设、检索顺序、检索词和来源登记表。不要要求把第三方平台数据导入 Lumi。',
      ].join('\n\n');
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, stream: false }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui('外部检索计划生成失败', 'Research plan failed'));
      setResult(data.text || data.response || data.reply || data.message || JSON.stringify(data));
    } catch (err: any) {
      setResult(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const archive = () => {
    if (!result || !onAddMaterial) return;
    onAddMaterial('note', `${caseFile?.title || caseFile?.caseNumber || ui('案件', 'Case')} 外部检索行动单`, result, 'tool');
  };

  return (
    <LegalTwoPaneTool
      icon={<Search size={22} />}
      accent="cyan"
      title={ui('半自动外部检索', 'Semi-Automated External Research')}
      desc={ui('生成打开外部法律网站的检索词、网页登录预设和来源登记表；内容由律师在网页内确认。', 'Generate search terms, login presets, and source logs for external legal sites.')}
      left={(
        <>
          <input value={issues} onChange={event => setIssues(event.target.value)} placeholder={ui('争议焦点，多个用逗号分隔', 'Issues, comma-separated')} className="lumi-field h-10 w-full rounded-lg" />
          <input value={companies} onChange={event => setCompanies(event.target.value)} placeholder={ui('公司/被执行人名称，多个用逗号分隔', 'Companies/debtors, comma-separated')} className="lumi-field mt-3 h-10 w-full rounded-lg" />
          <textarea value={facts} onChange={event => setFacts(event.target.value)} placeholder={ui('案件事实和检索背景...', 'Facts and research context...')} className="mt-3 min-h-[340px] w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-cyan-400/35" />
          <button onClick={generate} disabled={loading || (!facts.trim() && !issues.trim() && !companies.trim())} className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-500/15 px-4 py-2.5 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/25 disabled:opacity-50">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            {loading ? ui('生成中...', 'Generating...') : ui('生成检索行动单', 'Generate Plan')}
          </button>
        </>
      )}
      result={result}
      emptyText={ui('外部检索行动单会显示在这里。', 'External research plan will appear here.')}
      archiveLabel={ui('归档到案件', 'Archive to Case')}
      onArchive={result ? archive : undefined}
    />
  );
}

function LegalTwoPaneTool({
  icon,
  accent,
  title,
  desc,
  left,
  result,
  emptyText,
  archiveLabel,
  onArchive,
}: {
  icon: React.ReactNode;
  accent: 'amber' | 'emerald' | 'cyan';
  title: string;
  desc: string;
  left: React.ReactNode;
  result: string;
  emptyText: string;
  archiveLabel?: string;
  onArchive?: () => void;
}) {
  const color = {
    amber: 'border-amber-400/20 bg-amber-500/10 text-amber-300 focus:border-amber-400/35',
    emerald: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-300 focus:border-emerald-400/35',
    cyan: 'border-cyan-400/20 bg-cyan-500/10 text-cyan-300 focus:border-cyan-400/35',
  }[accent];
  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex items-start gap-3">
            <span className={`flex h-10 w-10 items-center justify-center rounded-lg border ${color}`}>
              {icon}
            </span>
            <div>
              <h2 className="text-xl font-semibold text-white">{title}</h2>
              <p className="mt-1 text-sm leading-6 text-white/50">{desc}</p>
            </div>
          </div>
        </section>
        <section className="grid min-h-[560px] gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">{left}</div>
          <div className="flex min-h-0 flex-col rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-white">Output</h3>
              {onArchive && (
                <button onClick={onArchive} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white">
                  <FolderOpen size={14} />
                  {archiveLabel || 'Archive'}
                </button>
              )}
            </div>
            <div className="min-h-[460px] flex-1 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-4 custom-scrollbar">
              {result ? (
                <article className="whitespace-pre-wrap text-sm leading-7 text-white/78">{result}</article>
              ) : (
                <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
                  <FileText size={32} className="text-white/20" />
                  <span>{emptyText}</span>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function LegalStrategyView({
  caseFile,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => void;
}) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const defaultFacts = useMemo(() => {
    if (!caseFile) return '';
    return [
      caseFile.title && `案件：${caseFile.title}`,
      caseFile.caseNumber && `案号：${caseFile.caseNumber}`,
      caseFile.party && `当事人：${caseFile.party}`,
      caseFile.cause && `案由：${caseFile.cause}`,
      caseFile.court && `法院：${caseFile.court}`,
      caseFile.judge && `承办法官：${caseFile.judge}`,
      caseFile.notes && `事实摘要：\n${caseFile.notes}`,
    ].filter(Boolean).join('\n');
  }, [caseFile]);
  const [facts, setFacts] = useState(defaultFacts);
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setFacts(defaultFacts);
    setResult('');
  }, [defaultFacts]);

  const analyze = async () => {
    if (!facts.trim() || loading) return;
    setLoading(true);
    setResult('');
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `请使用 legal_case_strategy 工具分析以下案件事实：\n\n${facts}`,
          stream: false,
        }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui('案件策略分析失败', 'Case strategy analysis failed'));
      setResult(data.text || data.response || data.reply || data.message || JSON.stringify(data));
    } catch (e: any) {
      setResult(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };
  const archive = () => {
    if (!result || !onAddMaterial) return;
    onAddMaterial('note', `${legalCaseTitle(caseFile)} 诉讼策略分析`, result, 'tool');
    toast.success(ui('策略分析已归档到当前案件', 'Strategy analysis archived to the current case'));
  };

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-amber-400/20 bg-amber-500/10 text-amber-300">
              <Brain size={22} />
            </span>
            <div>
              <h2 className="text-xl font-semibold text-white">{t.legalCaseStrategyTitle}</h2>
              <p className="mt-1 text-sm leading-6 text-white/50">{t.legalCaseStrategyDesc}</p>
            </div>
          </div>
        </section>

        <section className="grid min-h-[520px] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <label className="mb-2 text-sm font-medium text-white">{ui('案件事实', 'Case facts')}</label>
            <textarea
              value={facts}
              onChange={e => setFacts(e.target.value)}
              placeholder={t.legalCaseStrategyPlaceholder}
              className="min-h-[360px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-amber-400/35"
            />
            <button
              onClick={analyze}
              disabled={loading || !facts.trim()}
              className="mt-3 inline-flex items-center justify-center gap-2 self-end rounded-lg border border-amber-400/20 bg-amber-500/15 px-4 py-2.5 text-sm font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Brain size={16} />}
              {loading ? ui('分析中...', 'Analyzing...') : t.legalCaseStrategyAnalyze}
            </button>
          </div>

          <div className="min-h-0 rounded-lg border border-white/10 bg-white/[0.04] p-4">
            {result ? (
              <div className="flex h-full min-h-[420px] flex-col gap-3">
                <div className="flex justify-end">
                  <button onClick={archive} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white">
                    <FolderOpen size={14} />
                    {ui('归档到案件', 'Archive to Case')}
                  </button>
                </div>
                <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/20 p-4 text-sm leading-7 text-white/76 custom-scrollbar">
                  {result}
                </pre>
              </div>
            ) : (
              <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
                <Brain size={32} className="text-white/20" />
                <span>{ui('策略分析结果会显示在这里。', 'Strategy analysis will appear here.')}</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function LegalVerifyView({
  caseFile,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => void;
}) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [text, setText] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);

  const verify = async () => {
    if (!text.trim() || loading) return;
    setLoading(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `请使用 legal_verify_citation 验证以下文本中所有法条与案例引用：\n\n${text}`,
          stream: false,
        }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui('引用核验失败', 'Citation verification failed'));
      setResults([{ content: data.text || data.response || data.reply || data.message || ui('校验完成', 'Verification complete') }]);
    } catch (e: any) {
      setResults([{ error: e.message }]);
    } finally {
      setLoading(false);
    }
  };
  const verificationText = (results || []).map((item: any) => item.content || item.error || '').filter(Boolean).join('\n\n');
  const archive = () => {
    if (!verificationText || !onAddMaterial) return;
    onAddMaterial('note', `${legalCaseTitle(caseFile)} 引用校验`, verificationText, 'tool');
    toast.success(ui('引用校验已归档到当前案件', 'Citation verification archived to the current case'));
  };

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
              <CheckCircle size={22} />
            </span>
            <div>
              <h2 className="text-xl font-semibold text-white">{t.legalVerifyCitationTitle}</h2>
              <p className="mt-1 text-sm leading-6 text-white/50">{t.legalVerifyCitationDesc}</p>
            </div>
          </div>
        </section>

        <section className="grid min-h-[500px] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <label className="mb-2 text-sm font-medium text-white">{ui('待校验文本', 'Text to verify')}</label>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={t.legalVerifyCitationPlaceholder}
              className="min-h-[340px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-emerald-400/35"
            />
            <button
              onClick={verify}
              disabled={loading || !text.trim()}
              className="mt-3 inline-flex items-center justify-center gap-2 self-end rounded-lg border border-emerald-400/20 bg-emerald-500/15 px-4 py-2.5 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle size={16} />}
              {loading ? ui('校验中...', 'Verifying...') : t.legalVerifyCitationVerify}
            </button>
          </div>

          <div className="min-h-0 rounded-lg border border-white/10 bg-white/[0.04] p-4">
            {results && results.length > 0 ? (
              <div className="flex h-full min-h-[400px] flex-col gap-3">
                <div className="flex justify-end">
                  <button onClick={archive} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white">
                    <FolderOpen size={14} />
                    {ui('归档到案件', 'Archive to Case')}
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-4 text-sm leading-7 text-white/76 custom-scrollbar">
                  {results.map((r: any, i: number) => (
                    <div key={i} className={r.error ? 'text-red-300' : 'whitespace-pre-wrap'}>{r.content || r.error}</div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-[400px] flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
                <CheckCircle size={32} className="text-white/20" />
                <span>{ui('引用校验结果会显示在这里。', 'Citation verification results will appear here.')}</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function LegalKnowledgeSyncView({ caseFile }: { caseFile?: LegalCaseFile | null }) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const caseTitle = legalCaseTitle(caseFile);
  const articleTitle = `${caseTitle} - ${ui('案件知识归档', 'Case Knowledge Archive')}`;
  const articleContent = useMemo(() => (
    caseFile ? buildLegalCaseKnowledgeMarkdown(caseFile) : ''
  ), [caseFile]);

  const syncToKnowledgeBase = async () => {
    if (!caseFile || loading) return;
    setLoading(true);
    setStatus('');
    try {
      const res = await fetch('/api/org/kb/articles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: articleTitle,
          content: articleContent,
          category: 'legal_case',
          tags: ['legal', 'case', caseFile.stage, caseFile.cause].filter(Boolean),
          status: 'published',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui('同步知识库失败', 'Failed to sync to knowledge base'));
      const articleId = data.id || data.article?.id || data.articleId || '';
      window.dispatchEvent(new CustomEvent('lumi:knowledge-updated', {
        detail: {
          domain: 'work',
          files: [{ id: articleId, name: articleTitle, displayName: articleTitle }],
        },
      }));
      window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
      setStatus(ui('已同步到组织知识库。公司 Lumi 可以在组织知识中检索并引用这份案件归档。', 'Synced to the organization knowledge base. Company Lumi can retrieve and cite this case archive.'));
      toast.success(ui('案件已同步到组织知识库', 'Case synced to organization knowledge base'));
    } catch (err: any) {
      const message = err?.message || ui('同步知识库失败', 'Failed to sync to knowledge base');
      setStatus(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  if (!caseFile) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-white">
        <div className="max-w-md text-center">
          <Archive size={36} className="mx-auto mb-3 text-white/25" />
          <h2 className="text-xl font-semibold">{ui('先建立案件档案', 'Create a case first')}</h2>
          <p className="mt-2 text-sm leading-6 text-white/45">
            {ui('案件归档需要当前案件、事实摘要和材料池。', 'Knowledge sync needs a current case, facts, and archived materials.')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <section className="rounded-lg border border-emerald-400/15 bg-emerald-500/[0.045] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
                <Archive size={22} />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-xl font-semibold text-white">{ui('同步到组织知识库', 'Sync to Organization Knowledge')}</h2>
                <p className="mt-1 text-sm leading-6 text-white/50">
                  {ui('把当前案件、事实摘要、会谈纪要、裁判文书和工具产物汇总成组织知识，供公司 Lumi 后续引用。', 'Package the current case, facts, consultation notes, judgments, and tool outputs into organization knowledge for Company Lumi.')}
                </p>
              </div>
            </div>
            <button
              onClick={syncToKnowledgeBase}
              disabled={loading || !articleContent.trim()}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/15 px-4 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-45"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Archive size={16} />}
              {loading ? ui('同步中...', 'Syncing...') : ui('同步知识库', 'Sync to KB')}
            </button>
          </div>
          {status && (
            <div className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
              /失败|failed|error/i.test(status)
                ? 'border-red-400/20 bg-red-500/[0.08] text-red-200'
                : 'border-emerald-400/20 bg-emerald-500/[0.08] text-emerald-100'
            }`}>
              {status}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'kb' } }))}
              className="lumi-button h-9 px-3 text-xs"
            >
              {ui('打开组织知识库', 'Open Knowledge Base')}
            </button>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'chat' } }))}
              className="lumi-button h-9 px-3 text-xs"
            >
              {ui('去公司 Lumi 引用', 'Ask Company Lumi')}
            </button>
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <h3 className="text-sm font-semibold text-white">{ui('归档摘要', 'Archive Summary')}</h3>
            <div className="mt-3 space-y-2 text-sm text-white/62">
              <div>{ui('案件', 'Case')}: {caseTitle}</div>
              <div>{ui('案号', 'Case number')}: {caseFile.caseNumber || '-'}</div>
              <div>{ui('案由', 'Cause')}: {caseFile.cause || '-'}</div>
              <div>{ui('阶段', 'Stage')}: {caseFile.stage || '-'}</div>
              <div>{ui('材料数', 'Materials')}: {(caseFile.materials || []).length}</div>
            </div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-white">{ui('将写入知识库的内容预览', 'Knowledge Preview')}</h3>
              <span className="text-xs text-white/35">{articleContent.length} chars</span>
            </div>
            <pre className="max-h-[560px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/25 p-4 text-xs leading-6 text-white/72 custom-scrollbar">
              {articleContent}
            </pre>
          </div>
        </section>
      </div>
    </div>
  );
}

function LegalImportView({
  caseFile,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => void;
}) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [content, setContent] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const importJudgment = async () => {
    if (!content.trim() || loading) return;
    setLoading(true);
    setStatus('');
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `请使用 legal_import_judgment 导入以下裁判文书：\n\n${content}`,
          stream: false,
        }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui('裁判文书导入失败', 'Judgment import failed'));
      const reply = data.text || data.response || data.reply || data.message || ui('导入请求已发送', 'Import request sent');
      if (caseFile && onAddMaterial) {
        const title = inferLegalMaterialTitle(content, ui('裁判文书', 'Judgment document'));
        onAddMaterial('judgment', title, content, 'import');
        setStatus(`${reply}\n\n${ui('已归档到当前案件材料。', 'Archived to the current case materials.')}`);
      } else {
        setStatus(reply);
      }
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-blue-400/20 bg-blue-500/10 text-blue-300">
              <Upload size={22} />
            </span>
            <div>
              <h2 className="text-xl font-semibold text-white">{t.legalImportJudgmentTitle}</h2>
              <p className="mt-1 text-sm leading-6 text-white/50">{t.legalImportJudgmentDesc}</p>
            </div>
          </div>
        </section>

        <section className="grid min-h-[560px] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <label className="mb-2 text-sm font-medium text-white">{ui('裁判文书正文', 'Judgment document content')}</label>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder={ui('粘贴裁判文书正文，或在聊天窗口上传 PDF/DOCX 文件后让 Lumi 导入...', 'Paste judgment document content here, or upload PDF/DOCX files in chat and ask Lumi to import them...')}
              className="min-h-[420px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 font-mono text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-blue-400/35"
            />
            <button
              onClick={importJudgment}
              disabled={loading || !content.trim()}
              className="mt-3 inline-flex items-center justify-center gap-2 self-end rounded-lg border border-blue-400/20 bg-blue-500/15 px-4 py-2.5 text-sm font-medium text-blue-100 transition hover:bg-blue-500/25 disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
              {loading ? ui('导入中...', 'Importing...') : t.legalImportJudgment}
            </button>
          </div>

          <div className="min-h-0 rounded-lg border border-white/10 bg-white/[0.04] p-4">
            {status ? (
              <pre className="h-full min-h-[460px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/20 p-4 text-sm leading-7 text-white/76 custom-scrollbar">
                {status}
              </pre>
            ) : (
              <div className="flex h-full min-h-[460px] flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
                <Upload size={32} className="text-white/20" />
                <span>{ui('导入结果和归档状态会显示在这里。', 'Import result and archive status will appear here.')}</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
