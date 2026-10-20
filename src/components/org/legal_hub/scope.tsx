import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Scale, FileText, Search, Crosshair, Shield, Brain, CheckCircle, Upload, ClipboardList, FolderOpen, Database, ArrowRight, Archive } from "lucide-react";
import { toast } from "sonner";
import { LegalBidWorkbench } from "../LegalBidWorkbench";
import { LegalCaseSearch } from "../LegalCaseSearch";
import { LegalAssetTrace } from "../LegalAssetTrace";
import { LegalContractReview } from "../LegalContractReview";
import { LegalDataSourcesSettings } from "../LegalDataSourcesSettings";
import { useT } from "../../../lib/useT";
import { useApp } from "../../../contexts/AppContext";
import { useLegalDocument } from "../../../hooks/useLegalDocument";
import { apiJson } from "../../../services/apiClient";
import { refreshPersonalLegalCasesFromRuntime, syncPersonalLegalCaseToRuntime, deletePersonalLegalCaseFromRuntime, addLegalCaseMaterial, clearLegalConsultationCaseId, createEmptyLegalCase, getActiveLegalCaseId, getLegalConsultationCaseId, hasLegacyLegalCases, importLegacyLegalCases, isLegalCaseAccount, LEGAL_CASES_CHANGED_EVENT, readLegalCaseFiles, setActiveLegalCaseId, setLegalConsultationCaseId, updateLegalCase, writeLegalCaseFiles, type LegalCaseFile, type LegalCaseMaterial } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import type { LegalView, NavItem, LegalCaseCreateInput } from './contracts';
import { resolveLegalCaseActiveId, legalCaseTitle } from './case_values';
import { LegalCaseWorkspace } from './workspace';
import { LegalPacketView } from './packet';
import { LegalExternalResearchView } from './external_research';
import { LegalStrategyView } from './strategy';
import { LegalVerifyView } from './verification';
import { LegalImportView } from './material_import';
import { LegalKnowledgeSyncView } from './knowledge_sync';
import { LegalCaseCreateDialog, LegalCaseDeleteDialog } from './case_dialogs';

export function LegalHubScope() {
  const { user, workDomain, orgConnection } = useApp();
  const [view, setView] = useState<LegalView>('workspace');
  const [caseFilter, setCaseFilter] = useState('');
  const [cases, setCases] = useState<LegalCaseFile[]>(() => workDomain === 'work' ? [] : readLegalCaseFiles());
  const [activeCaseId, setActiveCaseIdState] = useState(() => getActiveLegalCaseId());
  const [orgCasesLoading, setOrgCasesLoading] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LegalCaseFile | null>(null);
  const mutation = useLegalDocument('', { error: uiMessage('legal-hub.failed-to-save-case.90f7d722b2') });
  const lifetime = useRef<AbortController | null>(null);
  const reading = useRef<AbortController | null>(null);
  const writing = useRef<Promise<void> | null>(null);
  const pendingEdit = useRef<{ id: string; patch: Partial<LegalCaseFile>; result: Promise<boolean> } | null>(null);
  const confirmedCases = useRef(cases);
  const t = useT();
  const useOrgCases = workDomain === 'work' && Boolean(orgConnection?.connected && orgConnection?.orgId);
  const canDeleteCases = !useOrgCases || ['owner', 'admin'].includes(String(orgConnection?.orgRole || '').toLowerCase());
  const isCurrent = () => isLegalCaseAccount(user?.uid) && !lifetime.current?.signal.aborted;

  const refreshCases = useCallback(async (readRuntime = true) => {
    if (!lifetime.current || !isCurrent()) return;
    if (!useOrgCases && (workDomain === 'work' || !readRuntime)) {
      const loaded = workDomain === 'work' ? [] : readLegalCaseFiles();
      setCases(loaded);
      setActiveCaseIdState(prev => resolveLegalCaseActiveId(loaded, prev || getActiveLegalCaseId()));
      return;
    }
    reading.current?.abort();
    const request = new AbortController();
    reading.current = request;
    setOrgCasesLoading(true);
    try {
      if (writing.current) await writing.current;
      if (request.signal.aborted || !isCurrent()) return;
      const loaded = useOrgCases
        ? (await apiJson('/api/org/legal/cases', { signal: request.signal })).cases
        : await refreshPersonalLegalCasesFromRuntime(request.signal);
      if (request.signal.aborted || !isCurrent()) return;
      const snapshot = Array.isArray(loaded) ? loaded : [];
      confirmedCases.current = snapshot;
      setCases(snapshot);
      setActiveCaseIdState(prev => resolveLegalCaseActiveId(snapshot, prev || getActiveLegalCaseId()));
    } catch (err: any) {
      if (!request.signal.aborted && isCurrent()) toast.error(err?.message || uiMessage('token-dashboard.failed-to-load.1131733383'));
    } finally {
      if (!request.signal.aborted && isCurrent()) setOrgCasesLoading(false);
    }
  }, [useOrgCases, workDomain, user?.uid]);

  useEffect(() => {
    const owner = new AbortController();
    lifetime.current = owner;
    const eventName = useOrgCases ? 'lumi:org-legal-cases-changed' : LEGAL_CASES_CHANGED_EVENT;
    const refreshCache = () => { void refreshCases(useOrgCases); };
    const refreshRuntime = () => { void refreshCases(); };
    const syncStorage = (event: StorageEvent) => {
      if (!useOrgCases && (!event.key || event.key.startsWith('lumi_legal_'))) refreshCache();
    };
    refreshRuntime();
    window.addEventListener(eventName, refreshCache);
    window.addEventListener('storage', syncStorage);
    window.addEventListener('focus', refreshRuntime);
    return () => {
      owner.abort();
      reading.current?.abort();
      window.removeEventListener(eventName, refreshCache);
      window.removeEventListener('storage', syncStorage);
      window.removeEventListener('focus', refreshRuntime);
    };
  }, [refreshCases, useOrgCases]);

  const scopedRequest = async <T,>(url: string, body: unknown, method = 'POST') => {
    const owner = lifetime.current?.signal;
    if (!owner || !isCurrent()) throw new DOMException('View closed', 'AbortError');
    const signal = AbortSignal.any([owner, AbortSignal.timeout(15_000)]);
    const data = await apiJson<T>(url, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal,
    });
    signal.throwIfAborted();
    if (!isCurrent()) throw new DOMException('View closed', 'AbortError');
    return data;
  };
  const reportFailure = (error: any, fallback: string) => {
    if (isCurrent()) toast.error(error?.message || fallback);
  };
  const writeOrgCase = <T,>(path: string, method: string, body: unknown, apply: (current: LegalCaseFile[], data: T) => LegalCaseFile[]) => {
    pendingEdit.current = null;
    const signal = lifetime.current?.signal;
    reading.current?.abort();
    setOrgCasesLoading(false);
    const execute = async () => {
      if (pendingEdit.current?.patch === body) pendingEdit.current = null;
      if (!signal || signal.aborted) throw new DOMException('View closed', 'AbortError');
      const data = await scopedRequest<T>(`/api/org/legal/cases${path}`, body, method);
      signal.throwIfAborted();
      const receipt = data as { id?: string; success?: boolean };
      if (method === 'DELETE' ? receipt?.success !== true : !receipt?.id) throw new Error(uiMessage('legal-hub.failed-to-save-case.90f7d722b2'));
      confirmedCases.current = apply(confirmedCases.current, data);
      return data;
    };
    const result = writing.current ? writing.current.then(execute) : execute();
    const settled = result.then(() => {}, () => {}).then(() => {
      if (writing.current !== settled) return;
      writing.current = null;
      if (!signal?.aborted) setCases(confirmedCases.current);
    });
    writing.current = settled;
    return result;
  };

  const navItems: NavItem[] = useMemo(() => [
    { id: 'workspace', label: uiMessage('legal-hub.case-workspace.9f165fc920'), icon: <FolderOpen size={16} /> },
    { id: 'import', label: t.legalImportJudgment, icon: <Upload size={16} /> },
    { id: 'external-research', label: uiMessage('legal-hub.research.fd18b45d25'), icon: <Search size={16} /> },
    { id: 'case-search', label: t.legalCaseSearch, icon: <Search size={16} /> },
    { id: 'asset-trace', label: t.legalAssetTrace, icon: <Crosshair size={16} /> },
    { id: 'contract-review', label: t.legalContractReview, icon: <Shield size={16} /> },
    { id: 'strategy', label: t.legalCaseStrategy, icon: <Brain size={16} /> },
    { id: 'packet', label: uiMessage('legal-hub.packet.1758eaea66'), icon: <ClipboardList size={16} /> },
    { id: 'verify', label: t.legalVerifyCitation, icon: <CheckCircle size={16} /> },
    { id: 'knowledge-sync', label: uiMessage('legal-hub.sync-to-kb.f5314698c5'), icon: <Archive size={16} /> },
    { id: 'bid', label: t.legalBidWorkbench, icon: <FileText size={16} /> },
    { id: 'data-sources', label: uiMessage('legal-hub.data-sources.5ed118a719'), icon: <Database size={16} /> },
  ], [t]);

  const workflowNavItems = useMemo(() => navItems.filter(item => item.id !== 'data-sources' && item.id !== 'bid'), [navItems]);
  const specialToolNavItems = useMemo(() => navItems.filter(item => item.id === 'bid'), [navItems]);
  const utilityNavItems = useMemo(() => navItems.filter(item => item.id === 'data-sources'), [navItems]);

  const activeCase = useMemo(() => {
    return cases.find(item => item.id === activeCaseId) || cases[0] || null;
  }, [activeCaseId, cases]);
  useEffect(() => {
    if (useOrgCases || workDomain === 'work' || !activeCase || !isCurrent()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void syncPersonalLegalCaseToRuntime(activeCase, controller.signal).catch(error => {
      if (!controller.signal.aborted && isCurrent()) toast.error(error?.message || uiMessage('legal-hub.failed-to-save-case.90f7d722b2'));
    }); }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [activeCase, useOrgCases, workDomain, user?.uid]);
  const workflowStepIndex = workflowNavItems.findIndex(item => item.id === view);
  const isWorkflowView = workflowStepIndex >= 0;
  const isSpecialToolView = specialToolNavItems.some(item => item.id === view);
  const currentStep = navItems.find(item => item.id === view);
  const nextStep = isWorkflowView ? (workflowNavItems[workflowStepIndex + 1] || null) : null;
  const legalOrgId = useOrgCases ? orgConnection?.orgId : undefined;

  const createCase = (input: LegalCaseCreateInput) => mutation.save(async () => {
    if (!isCurrent()) return false;
    const nextCase = {
      ...createEmptyLegalCase(),
      ...input,
      title: input.title.trim() || input.party.trim() || input.caseNumber.trim() || uiMessage('legal-hub.untitled-case.796e2578d9'),
    };
    if (useOrgCases) {
      const data = await writeOrgCase<LegalCaseFile>('', 'POST', nextCase, (current, created) => [created, ...current]);
      setActiveCaseIdState(data.id);
      setActiveLegalCaseId(data.id);
    } else {
      writeLegalCaseFiles([nextCase, ...readLegalCaseFiles()], nextCase.id);
    }
    setCreateDialogOpen(false);
    setView('workspace');
    return true;
  }, uiMessage('legal-hub.case-file-created.24082b4003'));

  const deleteCase = () => mutation.save(async () => {
    if (!isCurrent() || !deleteTarget) return false;
    if (useOrgCases) {
      await writeOrgCase(`/${encodeURIComponent(deleteTarget.id)}`, 'DELETE', undefined, current => current.filter(item => item.id !== deleteTarget.id));
      const nextActiveId = resolveLegalCaseActiveId(confirmedCases.current, getActiveLegalCaseId());
      setActiveCaseIdState(nextActiveId);
      setActiveLegalCaseId(nextActiveId);
    } else {
      await deletePersonalLegalCaseFromRuntime(deleteTarget.id, lifetime.current?.signal);
      if (!isCurrent()) return false;
      const next = readLegalCaseFiles().filter(item => item.id !== deleteTarget.id);
      writeLegalCaseFiles(next, resolveLegalCaseActiveId(next, getActiveLegalCaseId()));
    }
    if (getLegalConsultationCaseId() === deleteTarget.id) clearLegalConsultationCaseId();
    setDeleteTarget(null);
    setView('workspace');
    return true;
  }, uiMessage('legal-hub.case-deleted.6afeed7983'));

  const updateCase = (id: string, patch: Partial<LegalCaseFile>) => {
    if (!isCurrent()) return false;
    if (!useOrgCases) return Boolean(updateLegalCase(id, patch));
    setCases(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
    if (pendingEdit.current?.id === id) {
      Object.assign(pendingEdit.current.patch, patch);
      return pendingEdit.current.result;
    }
    const queued = Boolean(writing.current);
    const result = writeOrgCase<LegalCaseFile>(`/${encodeURIComponent(id)}`, 'PUT', patch, (current, saved) => current.map(item => item.id === id ? saved : item))
      .then(() => true).catch(error => { reportFailure(error, uiMessage('legal-hub.failed-to-save-case.90f7d722b2')); return false; });
    if (queued) pendingEdit.current = { id, patch, result };
    return result;
  };

  const addMaterial = (type: LegalCaseMaterial['type'], title: string, content?: string, source: LegalCaseMaterial['source'] = 'manual') => {
    if (!isCurrent()) return false;
    if (!activeCase) {
      toast.info(uiMessage('legal-hub.create-a-case-file-first.a26c342dec'));
      return false;
    }
    if (!useOrgCases) return Boolean(addLegalCaseMaterial(activeCase.id, { type, title, content, source }));
    return writeOrgCase<LegalCaseMaterial>(`/${encodeURIComponent(activeCase.id)}/materials`, 'POST', { type, title, content, source }, (current, material) => current.map(item => item.id === activeCase.id ? {
      ...item, materials: [material, ...(item.materials || [])],
    } : item)).then(() => true).catch(error => { reportFailure(error, uiMessage('legal-hub.failed-to-archive-material.4ed52ef083')); return false; });
  };

  const createReminder = async (content: string, dueAt?: string) => {
    try {
      await scopedRequest('/api/reminders', { content, dueAt: dueAt ? `${dueAt}T09:00:00` : null });
      toast.success(uiMessage('legal-hub.reminder-added.5dba21bd39'));
    } catch (err: any) {
      reportFailure(err, uiMessage('legal-hub.failed-to-create-reminder.880d5a66e2'));
    }
  };

  const createCasePlan = async () => {
    if (!activeCase) {
      toast.info(uiMessage('legal-hub.create-a-case-file-first.a26c342dec'));
      return;
    }
    const title = `${uiMessage('legal-hub.case-plan.66f8396b22')}: ${activeCase.title || activeCase.party || activeCase.caseNumber || activeCase.id}`;
    try {
      await scopedRequest('/api/plans', {
        title,
        description: activeCase.notes || activeCase.cause || '',
        tags: ['legal', activeCase.stage, activeCase.cause].filter(Boolean),
        source: 'user',
        priority: activeCase.stage === 'trial' || activeCase.stage === 'judgment' ? 'high' : 'medium',
        steps: [
          { title: uiMessage('legal-hub.organize-party-statements-and-evidence.dd4cfb3b29'), description: activeCase.notes || '' },
          { title: uiMessage('legal-hub.search-similar-cases-and-identify.bc6a84e94c'), description: activeCase.cause || '' },
          { title: uiMessage('legal-hub.draft-documents-for-lawyer-review.8ad498dd83'), description: activeCase.caseNumber || '' },
        ],
      });
      toast.success(uiMessage('legal-hub.case-plan-created.2289f19321'));
      window.dispatchEvent(new CustomEvent('lumi:client-action', { detail: { action: 'open_plans' } }));
    } catch (err: any) {
      reportFailure(err, uiMessage('legal-hub.failed-to-create-case-plan.c0b35de7a9'));
    }
  };

  const startConsultation = () => {
    if (!isCurrent()) return;
    if (!activeCase) {
      toast.info(uiMessage('legal-hub.create-a-case-file-first.a26c342dec'));
      return;
    }
    setLegalConsultationCaseId(activeCase.id);
    window.dispatchEvent(new CustomEvent('lumi:request-meeting-mode', {
      detail: {
        action: 'start_meeting_mode',
        confirmed: true,
        resetNotes: true,
        legalCaseId: activeCase.id,
        legalCaseTitle: activeCase.title || activeCase.party || activeCase.caseNumber || uiMessage('legal-hub.untitled-case.796e2578d9'),
        respond: () => { if (!lifetime.current?.signal.aborted) toast.success(uiMessage('legal-hub.consultation-capture-started-the-report.bfd4c10bbd')); },
        reject: (message: string) => {
          if (lifetime.current?.signal.aborted) return;
          clearLegalConsultationCaseId();
          toast.error(message || uiMessage('legal-hub.failed-to-start-consultation-capture.99681efb6d'));
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
            key={activeCase?.id}
            caseFilter={caseFilter}
            setCaseFilter={setCaseFilter}
            cases={cases}
            activeCase={activeCase}
            onCreateCase={() => setCreateDialogOpen(true)}
            onDeleteCase={setDeleteTarget}
            onSelectCase={(id) => {
              if (!isCurrent()) return;
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
            canDeleteCases={canDeleteCases}
            orgId={legalOrgId}
            refreshing={orgCasesLoading}
          />
      );
      case 'packet': return <LegalPacketView key={activeCase?.id} caseFile={activeCase} orgId={legalOrgId} onAddMaterial={addMaterial} />;
      case 'external-research': return <LegalExternalResearchView key={activeCase?.id} caseFile={activeCase} orgId={legalOrgId} onAddMaterial={addMaterial} />;
      case 'data-sources': return <LegalDataSourcesPanel />;
      case 'bid': return <LegalBidWorkbench caseFile={activeCase} orgId={legalOrgId} />;
      case 'case-search': return <LegalCaseSearch caseFile={activeCase} onAddMaterial={addMaterial} />;
      case 'asset-trace': return <LegalAssetTrace caseFile={activeCase} orgId={legalOrgId} onAddMaterial={addMaterial} />;
      case 'contract-review': return <LegalContractReview caseFile={activeCase} />;
      case 'strategy': return <LegalStrategyView key={activeCase?.id} caseFile={activeCase} orgId={legalOrgId} onAddMaterial={addMaterial} />;
      case 'verify': return <LegalVerifyView key={activeCase?.id} caseFile={activeCase} orgId={legalOrgId} onAddMaterial={addMaterial} />;
      case 'import': return <LegalImportView key={activeCase?.id} caseFile={activeCase} orgId={legalOrgId} onAddMaterial={addMaterial} />;
      case 'knowledge-sync': return <LegalKnowledgeSyncView key={activeCase?.id} caseFile={activeCase} />;
      default: return <LegalCaseSearch />;
    }
  };

  return (
    <>
      <div data-organization-wallpaper-module="legal" className="lumi-org-module-shell lumi-legal-workbench flex h-full">
      <div data-wallpaper-tool="organization-module-tools" className="lumi-org-module-tools lumi-legal-navigation flex w-56 shrink-0 flex-col border-r border-white/[0.08] bg-black/20">
        <div className="lumi-org-module-tool-header border-b border-white/[0.08] p-4">
          <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.12em] text-white/85">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-amber-300/15 bg-amber-400/10 text-amber-300">
              <Scale size={16} />
            </span>
            <span className="lumi-org-module-tool-copy min-w-0 truncate">{t.legalHub || uiMessage('legal-hub.law-firm.a283f14451')}</span>
          </h3>
          {activeCase && (
            <p className="lumi-org-module-tool-copy mt-2 line-clamp-2 text-xs text-white/45">
              {activeCase.title || activeCase.party || activeCase.caseNumber || uiMessage('legal-hub.untitled-case.796e2578d9')}
            </p>
          )}
        </div>
        <nav className="lumi-org-module-tool-nav custom-scrollbar flex-1 space-y-1 overflow-y-auto p-2">
          {workflowNavItems.map((item, index) => (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              title={item.label}
              aria-label={item.label}
              className={`lumi-org-module-tool-button lumi-legal-workflow-tool flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${
                view === item.id
                  ? 'border-amber-400/20 bg-amber-500/10 text-amber-200'
                  : 'border-transparent text-white/50 hover:border-white/[0.08] hover:bg-white/[0.05] hover:text-white/80'
              }`}
            >
              <span className={`lumi-legal-step-index flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border text-[10px] font-bold ${
                view === item.id
                  ? 'border-amber-300/25 bg-amber-400/15 text-amber-100'
                  : 'border-white/10 bg-white/[0.035] text-white/35'
              }`}>
                {index + 1}
              </span>
              <span className="lumi-org-module-tool-icon shrink-0">{item.icon}</span>
              <span className="lumi-org-module-tool-copy min-w-0 truncate">{item.label}</span>
            </button>
          ))}
          {[
            { items: specialToolNavItems, title: uiMessage('legal-hub.special-tools.77554fcb98'), activeClass: 'border-violet-400/20 bg-violet-500/10 text-violet-200' },
            { items: utilityNavItems, title: uiMessage('legal-hub.settings.57cc04dce6'), activeClass: 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200' },
          ].map(group => group.items.length > 0 && (
            <React.Fragment key={group.title}>
              <div className="lumi-org-module-tool-copy my-2 border-t border-white/[0.08]" />
              <div className="lumi-org-module-tool-copy px-3 pb-1 pt-1 text-[10px] font-black uppercase tracking-[0.14em] text-white/28">
                {group.title}
              </div>
              {group.items.map(item => (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  title={item.label}
                  aria-label={item.label}
                  className={`lumi-org-module-tool-button flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${
                    view === item.id
                      ? group.activeClass
                      : 'border-transparent text-white/45 hover:border-white/[0.08] hover:bg-white/[0.05] hover:text-white/80'
                  }`}
                >
                  <span className="lumi-org-module-tool-icon shrink-0">{item.icon}</span>
                  <span className="lumi-org-module-tool-copy min-w-0 truncate">{item.label}</span>
                </button>
              ))}
            </React.Fragment>
          ))}
        </nav>
      </div>
      <div data-wallpaper-tool="organization-module-workspace" className="lumi-org-module-workspace lumi-legal-workspace flex min-w-0 flex-1 flex-col bg-black/10">
        {!useOrgCases && hasLegacyLegalCases() && <div role="status" className="border-b border-amber-400/20 p-4 text-sm text-amber-100">
          <p>{uiMessage('legal-hub.legacy-cases-unassigned')}</p>
          <button type="button" className="lumi-button mt-2 px-3 py-2" onClick={() => {
            if (!window.confirm(uiMessage('legal-hub.confirm-legacy-case-ownership'))) return;
            void mutation.save(async () => isCurrent() && importLegacyLegalCases(), uiMessage('legal-hub.case-file-created.24082b4003'));
          }}>{uiMessage('legal-hub.import-legacy-cases')}</button>
        </div>}
        <div data-wallpaper-tool="organization-module-context" className="lumi-legal-context border-b border-white/[0.08] bg-black/25 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-amber-200/70">
                <span>{isWorkflowView ? uiMessage('legal-hub.case-workflow.f359a263f7') : isSpecialToolView ? uiMessage('legal-hub.legal-special-tool.53e70e4ac3') : uiMessage('legal-hub.legal-settings.0b819765e7')}</span>
                {isWorkflowView && (
                  <>
                    <span className="text-white/25">/</span>
                    <span>{workflowStepIndex + 1}/{workflowNavItems.length}</span>
                  </>
                )}
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-2 text-sm text-white/70">
                <span className="truncate font-semibold text-white/85">{legalCaseTitle(activeCase)}</span>
                <span className="text-white/25">&rarr;</span>
                <span className="truncate">{currentStep?.label}</span>
                <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-white/40">
                  {(activeCase?.materials || []).length} {uiMessage('legal-hub.materials.e065db1968')}
                </span>
              </div>
            </div>
            {nextStep ? (
              <button
                type="button"
                onClick={() => setView(nextStep.id)}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-500/10 px-3 text-xs font-bold text-amber-100 transition hover:bg-amber-500/18"
              >
                <span>{uiMessage('legal-hub.next.b527069e7f')}</span>
                <span className="max-w-[160px] truncate">{nextStep.label}</span>
                <ArrowRight size={14} />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'chat' } }))}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-500/10 px-3 text-xs font-bold text-cyan-100 transition hover:bg-cyan-500/18"
              >
                <span>{uiMessage('legal-hub.ask-lumi-in-work-workspace.6fe76d2092')}</span>
                <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>
        <div className="lumi-org-module-scroll lumi-legal-content custom-scrollbar min-h-0 flex-1 overflow-y-auto">
          {renderView()}
        </div>
      </div>
      </div>
      {createDialogOpen && (
        <LegalCaseCreateDialog
          busy={Boolean(mutation.busy)}
          onClose={() => !mutation.busy && setCreateDialogOpen(false)}
          onSubmit={createCase}
        />
      )}
      {deleteTarget && (
        <LegalCaseDeleteDialog
          caseFile={deleteTarget}
          busy={Boolean(mutation.busy)}
          onClose={() => !mutation.busy && setDeleteTarget(null)}
          onConfirm={deleteCase}
        />
      )}
    </>
  );
}

function LegalDataSourcesPanel() {
  return (
    <div className="custom-scrollbar h-full overflow-y-auto p-5">
      <LegalDataSourcesSettings />
    </div>
  );
}
