import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Scale, FileText, Search, Crosshair, Shield, Brain, CheckCircle, Upload,
  Calendar, ClipboardList, Plus, FolderOpen, Gavel, AlertTriangle, RefreshCw, Loader2, Database,
  ArrowRight, Archive, Trash2, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { LegalBidWorkbench } from './LegalBidWorkbench';
import { LegalCaseSearch } from './LegalCaseSearch';
import { LegalAssetTrace } from './LegalAssetTrace';
import { LegalContractReview } from './LegalContractReview';
import { LegalDataSourcesSettings } from './LegalDataSourcesSettings';
import { LegalCaseContextBar } from './LegalCaseContextBar';
import { useT } from '../../lib/useT';
import { useApp } from '../../contexts/AppContext';
import { runLegalTool } from '../../lib/legalToolClient';
import {
  clearLegalConsultationCaseId,
  createEmptyLegalCase,
  getActiveLegalCaseId,
  getLegalConsultationCaseId,
  LEGAL_CASES_CHANGED_EVENT,
  readLegalCaseFiles,
  setActiveLegalCaseId,
  setLegalConsultationCaseId,
  writeLegalCaseFiles,
  type LegalCaseFile,
  type LegalCaseMaterial,
  type LegalCaseStage,
} from '../../lib/legalCaseStore';
import { formatUiMessage, uiMessage } from '../../i18n/uiMessages';
import {
  buildChinaLegalCaseProfile,
  CHINA_LEGAL_TOOL_COPY,
  inferChinaLegalDocumentType,
} from '../../i18n/regions/cn/legal';

type LegalView = 'workspace' | 'packet' | 'external-research' | 'data-sources' | 'bid' | 'case-search' | 'asset-trace' | 'contract-review' | 'strategy' | 'verify' | 'import' | 'knowledge-sync';

interface NavItem {
  id: LegalView;
  label: string;
  icon: React.ReactNode;
}

type LegalCaseCreateInput = Pick<LegalCaseFile, 'title' | 'caseNumber' | 'party' | 'cause' | 'stage' | 'notes'>;

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

function resolveLegalCaseActiveId(cases: LegalCaseFile[], requestedId: string): string {
  return cases.some(item => item.id === requestedId) ? requestedId : (cases[0]?.id || '');
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

interface LegalCaseReadinessItem {
  key: string;
  label: string;
  detail: string;
  status: 'done' | 'ready' | 'missing' | 'blocked' | 'manual';
  nextStep: string;
  done: boolean;
  view?: LegalView;
  tool?: string;
}

const LEGAL_CASE_READINESS_TOOLS: Record<string, string> = {
  intake: 'legal_message_intake_to_case / legal_import_materials_to_kb',
  identity: 'legal_case_workspace / legal_import_materials_to_kb',
  facts: 'legal_meeting_minutes_to_case / legal_case_workspace',
  reasoning: 'legal_case_reasoning_matrix',
  evidence: 'legal_generate_litigation_packet',
  law: 'legal_search_statute / legal_generate_citation_verification_report',
  sources: 'legal_external_research_plan / legal_search_external_authorities',
  'work-product': 'legal_generate_litigation_packet / legal_generate_argument_or_opinion',
  filing: 'legal_prepare_filing_handoff',
  delivery: 'legal_finalize_delivery_package',
};

function legalCaseMaterialText(caseFile: LegalCaseFile): string {
  return [
    caseFile.notes,
    ...(caseFile.materials || []).map(material => [
      material.type,
      material.title,
      material.source || '',
      material.content || '',
    ].join('\n')),
  ].join('\n').toLowerCase();
}

function legalCaseHasSignal(caseFile: LegalCaseFile, patterns: RegExp[]): boolean {
  const text = legalCaseMaterialText(caseFile);
  return patterns.some(pattern => pattern.test(text));
}

function buildLegalCaseReadiness(caseFile: LegalCaseFile, ui: (zh: string, en: string) => string): LegalCaseReadinessItem[] {
  const materials = caseFile.materials || [];
  const hasIntake = Boolean(caseFile.notes.trim() || materials.length > 0);
  const hasIdentity = Boolean(caseFile.party.trim())
    && legalCaseHasSignal(caseFile, [/身份证|营业执照|统一社会信用代码|主体资格|授权委托|律所函|律师证/i]);
  const hasFacts = Boolean(caseFile.notes.trim().length >= 20)
    || legalCaseHasSignal(caseFile, [/事实摘要|案件事实|时间线|履行|付款|交付|解除|侵权|庭审|会议纪要/i]);
  const hasReasoning = legalCaseHasSignal(caseFile, [/三段论|大前提|小前提|涵摄|legal_case_reasoning_matrix|法律分析三段论/i]);
  const hasEvidence = materials.some(material => material.type === 'evidence')
    || legalCaseHasSignal(caseFile, [/证据目录|证明目的|三性|真实性|合法性|关联性|质证/i]);
  const hasSources = legalCaseHasSignal(caseFile, [/来源登记|外部检索|法源|类案|裁判文书|人民法院案例库|legal_external_research_plan|legal_search_external_authorities/i]);
  const hasWorkProduct = materials.some(material => material.type === 'pleading' || material.type === 'contract')
    || legalCaseHasSignal(caseFile, [/起诉状|答辩状|质证意见|代理词|法律意见书|合同审查|合同起草|投标书|标书|诉讼策略/i]);
  const hasLawBlocked = legalCaseHasSignal(caseFile, [/现行有效法律预检：未通过|硬门槛未通过|正式交付包未生成|不得标记为正式成果|已废止/i]);
  const hasLawPassed = !hasLawBlocked && legalCaseHasSignal(caseFile, [/现行有效法律预检：通过|现行有效法律硬门槛：通过|引用核验|引用校验|citation-verification-report/i]);
  const hasFiling = legalCaseHasSignal(caseFile, [/半自动立案交接单|立案网交接单|法院在线服务|legal_prepare_filing_handoff/i]);
  const hasDeliveryGate = legalCaseHasSignal(caseFile, [/正式交付包|现行有效法律硬门槛|引用核验|引用校验|source-register|来源登记表|legal_finalize_delivery_package/i]);

  const items: LegalCaseReadinessItem[] = [
    {
      key: 'intake',
      label: uiMessage('legal-hub.intake.795643fe2e'),
      detail: hasIntake ? uiMessage('legal-hub.archived.1638832a14') : uiMessage('legal-hub.missing.3a25cf328c'),
      status: hasIntake ? 'done' : 'missing',
      nextStep: uiMessage('legal-hub.import-meeting-notes-pleadings-evidence.76c0fc3d9c'),
      done: hasIntake,
      view: 'import',
    },
    {
      key: 'identity',
      label: uiMessage('legal-hub.identity.1a371622a1'),
      detail: hasIdentity ? uiMessage('legal-hub.checked.9642f15399') : caseFile.party ? uiMessage('legal-hub.needs-check.bc00456c9a') : uiMessage('legal-hub.missing.2623bb38bf'),
      status: hasIdentity ? 'done' : caseFile.party ? 'ready' : 'missing',
      nextStep: uiMessage('legal-hub.add-identity-authority-and-service.8e402725fd'),
      done: hasIdentity,
      view: 'workspace',
    },
    {
      key: 'facts',
      label: uiMessage('legal-hub.facts.5d7a5e1f8e'),
      detail: hasFacts ? uiMessage('legal-hub.prepared.9c28beac05') : hasIntake ? uiMessage('legal-hub.ready.2ade9ebc78') : uiMessage('legal-hub.missing.2623bb38bf'),
      status: hasFacts ? 'done' : hasIntake ? 'ready' : 'missing',
      nextStep: uiMessage('legal-hub.build-a-timeline-of-parties.17d8b862d0'),
      done: hasFacts,
      view: 'workspace',
    },
    {
      key: 'reasoning',
      label: uiMessage('legal-hub.reasoning-matrix.83dc0f2ce5'),
      detail: hasReasoning ? uiMessage('legal-hub.ready.3280ebf66e') : uiMessage('legal-hub.required.de4a95adb4'),
      status: hasReasoning ? 'done' : hasFacts || hasEvidence ? 'ready' : 'missing',
      nextStep: uiMessage('legal-hub.generate-the-authority-evidence-and.46ae098910'),
      done: hasReasoning,
      view: 'strategy',
    },
    {
      key: 'evidence',
      label: uiMessage('legal-hub.evidence-review.904c0f7be0'),
      detail: hasEvidence ? uiMessage('legal-hub.prepared.9c28beac05') : uiMessage('legal-hub.missing.293c592854'),
      status: hasEvidence ? 'done' : hasIntake ? 'ready' : 'missing',
      nextStep: uiMessage('legal-hub.map-proof-purpose-original-status.0f3a872b6e'),
      done: hasEvidence,
      view: 'packet',
    },
    {
      key: 'law',
      label: uiMessage('legal-hub.current-law.85754e3378'),
      detail: hasLawBlocked ? uiMessage('legal-hub.blocked.3044b5e296') : hasLawPassed ? uiMessage('legal-hub.passed.24c823b3b1') : uiMessage('legal-hub.missing.ba39d5a9c2'),
      status: hasLawBlocked ? 'blocked' : hasLawPassed ? 'done' : hasReasoning || hasWorkProduct ? 'ready' : 'missing',
      nextStep: hasLawBlocked
        ? uiMessage('legal-hub.replace-or-verify-blocking-authorities.d6248457ac')
        : uiMessage('legal-hub.verify-all-statutes-interpretations-and.4348622a41'),
      done: hasLawPassed,
      view: 'verify',
    },
    {
      key: 'sources',
      label: uiMessage('legal-hub.sources.fbb50fb2b2'),
      detail: hasSources ? uiMessage('legal-hub.logged.2bd1b41ec1') : uiMessage('legal-hub.missing.b1cd9e1420'),
      status: hasSources ? 'done' : hasFacts || hasReasoning ? 'ready' : 'missing',
      nextStep: uiMessage('legal-hub.log-authorities-from-supreme-high.adfac8a04d'),
      done: hasSources,
      view: 'external-research',
    },
    {
      key: 'work-product',
      label: uiMessage('legal-hub.drafts.1b1bddcf17'),
      detail: hasWorkProduct ? uiMessage('legal-hub.drafted.ded8cf6f43') : uiMessage('legal-hub.missing.ee4d2a7e05'),
      status: hasWorkProduct ? 'done' : hasEvidence && hasReasoning ? 'ready' : 'missing',
      nextStep: uiMessage('legal-hub.generate-complaint-answer-cross-exam.f2aab3a8b7'),
      done: hasWorkProduct,
      view: 'packet',
    },
    {
      key: 'filing',
      label: uiMessage('legal-hub.filing.b85688fcb5'),
      detail: hasFiling ? uiMessage('legal-hub.handoff-ready.bf79982539') : hasWorkProduct ? uiMessage('legal-hub.manual.24f17bdf15') : uiMessage('legal-hub.not-ready.b358df0cab'),
      status: hasFiling ? 'done' : hasWorkProduct ? 'manual' : 'missing',
      nextStep: uiMessage('legal-hub.prepare-court-platform-fields-and.29f878ee91'),
      done: hasFiling,
      view: 'packet',
    },
    {
      key: 'delivery',
      label: uiMessage('legal-hub.delivery-gate.94b193e100'),
      detail: hasLawBlocked ? uiMessage('legal-hub.blocked.e5862a2c38') : hasDeliveryGate ? uiMessage('legal-hub.recorded.5dd3865391') : uiMessage('legal-hub.missing.b4ee8a4d72'),
      status: hasLawBlocked ? 'blocked' : hasDeliveryGate ? 'done' : hasLawPassed && hasWorkProduct ? 'ready' : 'missing',
      nextStep: hasLawBlocked
        ? uiMessage('legal-hub.fix-authorities-before-formal-delivery.b2e1639fb7')
        : uiMessage('legal-hub.run-the-formal-delivery-gate.3a08dedc0f'),
      done: hasDeliveryGate && !hasLawBlocked,
      view: 'verify',
    },
  ];
  return items.map(item => ({ ...item, tool: LEGAL_CASE_READINESS_TOOLS[item.key] }));
}

function legalReadinessTone(status: LegalCaseReadinessItem['status']): string {
  if (status === 'done') return 'border-emerald-400/18 bg-emerald-500/[0.07] text-emerald-100';
  if (status === 'blocked') return 'border-rose-400/24 bg-rose-500/[0.08] text-rose-100';
  if (status === 'ready') return 'border-amber-400/22 bg-amber-500/[0.07] text-amber-100 hover:border-amber-300/35';
  if (status === 'manual') return 'border-cyan-400/20 bg-cyan-500/[0.06] text-cyan-100 hover:border-cyan-300/35';
  return 'border-white/10 bg-black/18 text-white/58 hover:border-white/16 hover:bg-white/[0.05]';
}

function legalReadinessIcon(item: LegalCaseReadinessItem) {
  if (item.status === 'done') return <CheckCircle size={12} />;
  return <AlertTriangle size={12} />;
}

function legalCaseToolArgs(caseFile?: LegalCaseFile | null, orgId?: string): Record<string, any> {
  if (!caseFile) return orgId ? { orgId } : {};
  return {
    caseId: caseFile.id,
    caseName: legalCaseTitle(caseFile),
    caseType: caseFile.cause || undefined,
    court: caseFile.court || undefined,
    parties: caseFile.party || undefined,
    stage: caseFile.stage || undefined,
    orgId,
    persistCase: true,
  };
}

export function LegalHub() {
  const [view, setView] = useState<LegalView>('workspace');
  const [cases, setCases] = useState<LegalCaseFile[]>(() => readLegalCaseFiles());
  const [activeCaseId, setActiveCaseIdState] = useState(() => getActiveLegalCaseId());
  const [orgCasesLoading, setOrgCasesLoading] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LegalCaseFile | null>(null);
  const [caseMutation, setCaseMutation] = useState<'create' | 'delete' | ''>('');
  const { workDomain, orgConnection } = useApp();
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);
  const useOrgCases = workDomain === 'work' && Boolean(orgConnection?.connected && orgConnection?.orgId);
  const canDeleteCases = !useOrgCases || ['owner', 'admin'].includes(String(orgConnection?.orgRole || '').toLowerCase());

  const refreshCases = useCallback(async () => {
    if (!useOrgCases) {
      const loaded = readLegalCaseFiles();
      const storedActiveId = getActiveLegalCaseId();
      const resolvedActiveId = resolveLegalCaseActiveId(loaded, storedActiveId);
      setCases(loaded);
      setActiveCaseIdState(resolvedActiveId);
      if (storedActiveId !== resolvedActiveId) setActiveLegalCaseId(resolvedActiveId);
      return;
    }

    setOrgCasesLoading(true);
    try {
      const res = await fetch('/api/org/legal/cases', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('legal-hub.failed-to-load-organization-cases.9523d68ad5'));
      const loaded = Array.isArray(data.cases) ? data.cases : [];
      setCases(loaded);
      setActiveCaseIdState(prev => (prev && loaded.some((item: LegalCaseFile) => item.id === prev)) ? prev : (loaded[0]?.id || ''));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('legal-hub.failed-to-load-organization-cases.9523d68ad5'));
    } finally {
      setOrgCasesLoading(false);
    }
  }, [ui, useOrgCases]);

  useEffect(() => {
    const syncCases = () => {
      if (useOrgCases) return;
      const loaded = readLegalCaseFiles();
      const storedActiveId = getActiveLegalCaseId();
      const resolvedActiveId = resolveLegalCaseActiveId(loaded, storedActiveId);
      setCases(loaded);
      setActiveCaseIdState(resolvedActiveId);
      if (storedActiveId !== resolvedActiveId) setActiveLegalCaseId(resolvedActiveId);
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
      const loaded = readLegalCaseFiles();
      const storedActiveId = getActiveLegalCaseId();
      const resolvedActiveId = resolveLegalCaseActiveId(loaded, storedActiveId);
      setCases(loaded);
      setActiveCaseIdState(resolvedActiveId);
      if (storedActiveId !== resolvedActiveId) setActiveLegalCaseId(resolvedActiveId);
      return;
    }
    void refreshCases();
    window.addEventListener('lumi:org-legal-cases-changed', refreshCases);
    return () => {
      window.removeEventListener('lumi:org-legal-cases-changed', refreshCases);
    };
  }, [orgConnection?.orgId, refreshCases, useOrgCases]);

  const navItems: NavItem[] = useMemo(() => [
    { id: 'workspace', label: uiMessage('legal-hub.case-workspace.9f165fc920'), icon: <FolderOpen size={16} /> },
    { id: 'packet', label: uiMessage('legal-hub.packet.1758eaea66'), icon: <ClipboardList size={16} /> },
    { id: 'external-research', label: uiMessage('legal-hub.research.fd18b45d25'), icon: <Search size={16} /> },
    { id: 'data-sources', label: uiMessage('legal-hub.data-sources.5ed118a719'), icon: <Database size={16} /> },
    { id: 'bid', label: t.legalBidWorkbench, icon: <FileText size={16} /> },
    { id: 'case-search', label: t.legalCaseSearch, icon: <Search size={16} /> },
    { id: 'asset-trace', label: t.legalAssetTrace, icon: <Crosshair size={16} /> },
    { id: 'contract-review', label: t.legalContractReview, icon: <Shield size={16} /> },
    { id: 'strategy', label: t.legalCaseStrategy, icon: <Brain size={16} /> },
    { id: 'verify', label: t.legalVerifyCitation, icon: <CheckCircle size={16} /> },
    { id: 'import', label: t.legalImportJudgment, icon: <Upload size={16} /> },
    { id: 'knowledge-sync', label: uiMessage('legal-hub.sync-to-kb.f5314698c5'), icon: <Archive size={16} /> },
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
  const legalOrgId = useOrgCases ? orgConnection?.orgId : undefined;

  const saveCases = (next: LegalCaseFile[], nextActiveId = activeCaseId) => {
    const resolvedActiveId = resolveLegalCaseActiveId(next, nextActiveId);
    setCases(next);
    setActiveCaseIdState(resolvedActiveId);
    if (!useOrgCases) writeLegalCaseFiles(next, resolvedActiveId);
    else setActiveLegalCaseId(resolvedActiveId);
  };

  const createCase = async (input: LegalCaseCreateInput) => {
    const nextCase = {
      ...createEmptyLegalCase(),
      ...input,
      title: input.title.trim() || input.party.trim() || input.caseNumber.trim() || uiMessage('legal-hub.untitled-case.796e2578d9'),
    };
    setCaseMutation('create');
    try {
      if (useOrgCases) {
        const res = await fetch('/api/org/legal/cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(nextCase),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || uiMessage('legal-hub.failed-to-create-case.d77857142e'));
        saveCases([data, ...cases], data.id);
      } else {
        saveCases([nextCase, ...cases], nextCase.id);
      }
      setCreateDialogOpen(false);
      setView('workspace');
      toast.success(uiMessage('legal-hub.case-file-created.24082b4003'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('legal-hub.failed-to-create-case.d77857142e'));
    } finally {
      setCaseMutation('');
    }
  };

  const deleteCase = async () => {
    if (!deleteTarget || caseMutation) return;
    setCaseMutation('delete');
    try {
      if (useOrgCases) {
        const res = await fetch(`/api/org/legal/cases/${encodeURIComponent(deleteTarget.id)}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || uiMessage('legal-hub.failed-to-delete-case.34167edea4'));
      }

      const next = cases.filter(item => item.id !== deleteTarget.id);
      const nextActiveId = activeCaseId === deleteTarget.id ? (next[0]?.id || '') : activeCaseId;
      if (getLegalConsultationCaseId() === deleteTarget.id) clearLegalConsultationCaseId();
      saveCases(next, nextActiveId);
      setDeleteTarget(null);
      setView('workspace');
      toast.success(uiMessage('legal-hub.case-deleted.6afeed7983'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('legal-hub.failed-to-delete-case.34167edea4'));
    } finally {
      setCaseMutation('');
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
          throw new Error(data.error || uiMessage('legal-hub.failed-to-save-case.90f7d722b2'));
        }
      }).catch((err: any) => toast.error(err?.message || uiMessage('legal-hub.failed-to-save-case.90f7d722b2')));
    }
  };

  const addMaterial = (type: LegalCaseMaterial['type'], title: string, content?: string, source: LegalCaseMaterial['source'] = 'manual') => {
    if (!activeCase) {
      toast.info(uiMessage('legal-hub.create-a-case-file-first.a26c342dec'));
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
          throw new Error(data.error || uiMessage('legal-hub.failed-to-archive-material.4ed52ef083'));
        }
      }).catch((err: any) => {
        setCases(prev => prev.map(item => item.id === activeCase.id ? {
          ...item,
          materials: (item.materials || []).filter(existing => existing.id !== material.id),
        } : item));
        toast.error(err?.message || uiMessage('legal-hub.failed-to-archive-material.4ed52ef083'));
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
      if (!res.ok) throw new Error(data.error || uiMessage('legal-hub.failed-to-create-reminder.880d5a66e2'));
      toast.success(uiMessage('legal-hub.reminder-added.5dba21bd39'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('legal-hub.failed-to-create-reminder.880d5a66e2'));
    }
  };

  const createCasePlan = async () => {
    if (!activeCase) {
      toast.info(uiMessage('legal-hub.create-a-case-file-first.a26c342dec'));
      return;
    }
    const title = `${uiMessage('legal-hub.case-plan.66f8396b22')}: ${activeCase.title || activeCase.party || activeCase.caseNumber || activeCase.id}`;
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
            { title: uiMessage('legal-hub.organize-party-statements-and-evidence.dd4cfb3b29'), description: activeCase.notes || '' },
            { title: uiMessage('legal-hub.search-similar-cases-and-identify.bc6a84e94c'), description: activeCase.cause || '' },
            { title: uiMessage('legal-hub.draft-documents-for-lawyer-review.8ad498dd83'), description: activeCase.caseNumber || '' },
          ],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('legal-hub.failed-to-create-case-plan.c0b35de7a9'));
      toast.success(uiMessage('legal-hub.case-plan-created.2289f19321'));
      window.dispatchEvent(new CustomEvent('lumi:client-action', { detail: { action: 'open_plans' } }));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('legal-hub.failed-to-create-case-plan.c0b35de7a9'));
    }
  };

  const startConsultation = () => {
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
        respond: () => toast.success(uiMessage('legal-hub.consultation-capture-started-the-report.bfd4c10bbd')),
        reject: (message: string) => {
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
            cases={cases}
            activeCase={activeCase}
            activeCaseId={activeCase?.id || ''}
            onCreateCase={() => setCreateDialogOpen(true)}
            onDeleteCase={setDeleteTarget}
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
            canDeleteCases={canDeleteCases}
            orgId={legalOrgId}
            refreshing={orgCasesLoading}
            ui={ui}
          />
      );
      case 'packet': return <LegalPacketView caseFile={activeCase} orgId={legalOrgId} onAddMaterial={addMaterial} />;
      case 'external-research': return <LegalExternalResearchView caseFile={activeCase} orgId={legalOrgId} onAddMaterial={addMaterial} />;
      case 'data-sources': return <LegalDataSourcesPanel />;
      case 'bid': return <LegalBidWorkbench onSwitchView={setView} caseFile={activeCase} orgId={legalOrgId} />;
      case 'case-search': return <LegalCaseSearch caseFile={activeCase} onAddMaterial={addMaterial} />;
      case 'asset-trace': return <LegalAssetTrace caseFile={activeCase} orgId={legalOrgId} onAddMaterial={addMaterial} />;
      case 'contract-review': return <LegalContractReview caseFile={activeCase} />;
      case 'strategy': return <LegalStrategyView caseFile={activeCase} orgId={legalOrgId} onAddMaterial={addMaterial} />;
      case 'verify': return <LegalVerifyView caseFile={activeCase} orgId={legalOrgId} onAddMaterial={addMaterial} />;
      case 'import': return <LegalImportView caseFile={activeCase} orgId={legalOrgId} onAddMaterial={addMaterial} />;
      case 'knowledge-sync': return <LegalKnowledgeSyncView caseFile={activeCase} />;
      default: return <LegalCaseSearch />;
    }
  };

  return (
    <>
      <div className="flex h-full">
      <div className="flex w-56 shrink-0 flex-col border-r border-white/[0.08] bg-black/20">
        <div className="border-b border-white/[0.08] p-4">
          <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.12em] text-white/85">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-amber-300/15 bg-amber-400/10 text-amber-300">
              <Scale size={16} />
            </span>
            <span className="min-w-0 truncate">{t.legalHub || uiMessage('legal-hub.law-firm.a283f14451')}</span>
          </h3>
          {activeCase && (
            <p className="mt-2 line-clamp-2 text-xs text-white/45">
              {activeCase.title || activeCase.party || activeCase.caseNumber || uiMessage('legal-hub.untitled-case.796e2578d9')}
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
                {uiMessage('legal-hub.special-tools.77554fcb98')}
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
                {uiMessage('legal-hub.settings.57cc04dce6')}
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
                <span>{isWorkflowView ? uiMessage('legal-hub.case-workflow.f359a263f7') : isSpecialToolView ? uiMessage('legal-hub.legal-special-tool.53e70e4ac3') : uiMessage('legal-hub.legal-settings.0b819765e7')}</span>
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
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
          {renderView()}
        </div>
      </div>
      </div>
      {createDialogOpen && (
        <LegalCaseCreateDialog
          busy={caseMutation === 'create'}
          onClose={() => !caseMutation && setCreateDialogOpen(false)}
          onSubmit={createCase}
          ui={ui}
        />
      )}
      {deleteTarget && (
        <LegalCaseDeleteDialog
          caseFile={deleteTarget}
          busy={caseMutation === 'delete'}
          onClose={() => !caseMutation && setDeleteTarget(null)}
          onConfirm={deleteCase}
          ui={ui}
        />
      )}
    </>
  );
}

function LegalCaseCreateDialog({
  busy,
  onClose,
  onSubmit,
  ui,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: LegalCaseCreateInput) => void | Promise<void>;
  ui: (zh: string, en: string) => string;
}) {
  const [draft, setDraft] = useState<LegalCaseCreateInput>({
    title: '',
    caseNumber: '',
    party: '',
    cause: '',
    stage: 'consultation',
    notes: '',
  });
  const updateDraft = <K extends keyof LegalCaseCreateInput>(key: K, value: LegalCaseCreateInput[K]) => {
    setDraft(current => ({ ...current, [key]: value }));
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.title.trim() || busy) return;
    void onSubmit({
      ...draft,
      title: draft.title.trim(),
      caseNumber: draft.caseNumber.trim(),
      party: draft.party.trim(),
      cause: draft.cause.trim(),
      notes: draft.notes.trim(),
    });
  };

  const stages: Array<{ value: LegalCaseStage; label: string }> = [
    { value: 'consultation', label: uiMessage('legal-hub.consultation.7a3d850bb4') },
    { value: 'filing', label: uiMessage('legal-hub.filing.84e2c4dc09') },
    { value: 'trial', label: uiMessage('legal-hub.trial.26f80dc45f') },
    { value: 'judgment', label: uiMessage('legal-hub.judgment.407839a173') },
    { value: 'enforcement', label: uiMessage('legal-hub.enforcement.10a7440dfb') },
    { value: 'closed', label: uiMessage('legal-hub.closed.8d3c2a38e3') },
  ];

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <button type="button" className="absolute inset-0" onClick={onClose} aria-label={uiMessage('legal-hub.close-new-case.cc85fb0c91')} />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-create-case-title"
        onSubmit={submit}
        className="relative z-10 w-full max-w-2xl rounded-lg border border-white/12 bg-[#11151b] p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="legal-create-case-title" className="text-lg font-bold text-white">{uiMessage('legal-hub.new-case.8aa99242cb')}</h2>
            <p className="mt-1 text-sm text-white/45">{uiMessage('legal-hub.create-the-case-profile-first.1f798cd917')}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="lumi-icon-button h-9 w-9" title={uiMessage('legal-hub.close.6cf4a7773a')}>
            <X size={16} />
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="space-y-1.5 md:col-span-2">
            <span className="text-xs text-white/48">{uiMessage('legal-hub.case-name.55c6d2512f')} *</span>
            <input
              autoFocus
              required
              value={draft.title}
              onChange={event => updateDraft('title', event.target.value)}
              className="lumi-field h-10 w-full rounded-lg focus:border-amber-400/50"
              placeholder={uiMessage('legal-hub.example-alpha-v-beta-sales.b1bd15cfe1')}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs text-white/48">{uiMessage('legal-hub.party.9f6b14598d')}</span>
            <input value={draft.party} onChange={event => updateDraft('party', event.target.value)} className="lumi-field h-10 w-full rounded-lg focus:border-amber-400/50" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs text-white/48">{uiMessage('legal-hub.case-number.1adfaa625a')}</span>
            <input value={draft.caseNumber} onChange={event => updateDraft('caseNumber', event.target.value)} className="lumi-field h-10 w-full rounded-lg focus:border-amber-400/50" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs text-white/48">{uiMessage('legal-hub.cause.8d47df5928')}</span>
            <input value={draft.cause} onChange={event => updateDraft('cause', event.target.value)} className="lumi-field h-10 w-full rounded-lg focus:border-amber-400/50" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs text-white/48">{uiMessage('legal-hub.current-stage.44a8df1018')}</span>
            <select value={draft.stage} onChange={event => updateDraft('stage', event.target.value as LegalCaseStage)} className="lumi-field h-10 w-full rounded-lg focus:border-amber-400/50">
              {stages.map(stage => <option key={stage.value} value={stage.value}>{stage.label}</option>)}
            </select>
          </label>
          <label className="space-y-1.5 md:col-span-2">
            <span className="text-xs text-white/48">{uiMessage('legal-hub.case-summary.da1171fae6')}</span>
            <textarea
              value={draft.notes}
              onChange={event => updateDraft('notes', event.target.value)}
              rows={4}
              className="lumi-field w-full resize-none rounded-lg focus:border-amber-400/50"
            />
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="lumi-button h-10 px-4 text-sm">{uiMessage('legal-hub.cancel.998b9c48fb')}</button>
          <button type="submit" disabled={busy || !draft.title.trim()} className="lumi-button-primary h-10 border-amber-400/25 bg-amber-500/15 px-4 text-sm text-amber-100 hover:bg-amber-500/25">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            {busy ? uiMessage('legal-hub.creating.ba147d5f24') : uiMessage('legal-hub.create-case.ed15df1c91')}
          </button>
        </div>
      </form>
    </div>
  );
}

function LegalCaseDeleteDialog({
  caseFile,
  busy,
  onClose,
  onConfirm,
  ui,
}: {
  caseFile: LegalCaseFile;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  ui: (zh: string, en: string) => string;
}) {
  return (
    <div className="fixed inset-0 z-[310] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <button type="button" className="absolute inset-0" onClick={onClose} aria-label={uiMessage('legal-hub.close-delete-confirmation.ccd3d3d67d')} />
      <div role="dialog" aria-modal="true" aria-labelledby="legal-delete-case-title" className="relative z-10 w-full max-w-md rounded-lg border border-rose-400/18 bg-[#11151b] p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-rose-400/20 bg-rose-500/10 text-rose-200">
            <Trash2 size={18} />
          </span>
          <div className="min-w-0">
            <h2 id="legal-delete-case-title" className="text-lg font-bold text-white">{uiMessage('legal-hub.delete-case.ba2912671e')}</h2>
            <p className="mt-2 text-sm leading-6 text-white/55">
              {formatUiMessage('legal-hub.this-removes-value0-and-value1.366643037e', { value0: legalCaseTitle(caseFile), value1: caseFile.materials?.length || 0 })}
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="lumi-button h-10 px-4 text-sm">{uiMessage('legal-hub.cancel.998b9c48fb')}</button>
          <button type="button" onClick={() => void onConfirm()} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-lg border border-rose-400/25 bg-rose-500/12 px-4 text-sm font-bold text-rose-100 transition hover:bg-rose-500/20 disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
            {busy ? uiMessage('legal-hub.deleting.052026caec') : uiMessage('legal-hub.delete.d95c2d03f8')}
          </button>
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
  onDeleteCase,
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
  canDeleteCases,
  orgId,
  refreshing,
  ui,
}: {
  cases: LegalCaseFile[];
  activeCase: LegalCaseFile | null;
  activeCaseId: string;
  onCreateCase: () => void;
  onDeleteCase: (caseFile: LegalCaseFile) => void;
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
  canDeleteCases: boolean;
  orgId?: string;
  refreshing: boolean;
  ui: (zh: string, en: string) => string;
}) {
  const [noticeText, setNoticeText] = useState('');
  const [noticeStatus, setNoticeStatus] = useState('');
  const [noticeLoading, setNoticeLoading] = useState(false);
  const [documentStatus, setDocumentStatus] = useState('');
  const [documentLoading, setDocumentLoading] = useState<'engagement' | 'reasoning' | 'delivery' | ''>('');
  const [selectedMaterialId, setSelectedMaterialId] = useState('');
  const [caseFilter, setCaseFilter] = useState('');

  const stageLabels: Record<LegalCaseStage, string> = {
    consultation: uiMessage('legal-hub.consultation.7a3d850bb4'),
    filing: uiMessage('legal-hub.filing.84e2c4dc09'),
    trial: uiMessage('legal-hub.trial.26f80dc45f'),
    judgment: uiMessage('legal-hub.judgment.407839a173'),
    enforcement: uiMessage('legal-hub.enforcement.10a7440dfb'),
    closed: uiMessage('legal-hub.closed.8d3c2a38e3'),
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
      toast.info(uiMessage('legal-hub.enter-the-judgment-date-first.b19faa56d5'));
      return;
    }
    const deadline = addDays(activeCase.judgmentDate, 15);
    update({ appealDeadline: deadline });
    toast.success(uiMessage('legal-hub.appeal-deadline-calculated-with-the.46cc282758'));
  };

  const createDateReminder = (kind: 'hearing' | 'appeal' | 'enforcement') => {
    if (!activeCase) return;
    const date =
      kind === 'hearing' ? activeCase.hearingDate :
      kind === 'appeal' ? activeCase.appealDeadline :
      activeCase.enforcementDeadline;
    if (!date) {
      toast.info(uiMessage('legal-hub.enter-the-date-first.1349d04548'));
      return;
    }
    const label =
      kind === 'hearing' ? uiMessage('legal-hub.hearing-reminder.59c173ecb2') :
      kind === 'appeal' ? uiMessage('legal-hub.appeal-deadline-reminder.e731769a1e') :
      uiMessage('legal-hub.enforcement-reminder.6b6c485b5d');
    const caseName = activeCase.title || activeCase.party || activeCase.caseNumber || uiMessage('legal-hub.untitled-case.796e2578d9');
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
    patch.notes = [activeCase.notes, uiMessage('legal-hub.hearing-notice.ce5d4e47fe'), noticeText].filter(Boolean).join('\n');
    onUpdateCase(activeCase.id, patch);
    onAddMaterial('note', uiMessage('legal-hub.hearing-notice-sms.10239017c5'), noticeText, 'notice');
    setNoticeStatus(uiMessage('legal-hub.notice-extracted-review-case-number.77a3bafd0a'));
  };

  const processNoticeLink = async () => {
    if (!activeCase || !noticeText.trim() || noticeLoading) return;
    if (!/https?:\/\/\S+/i.test(noticeText)) {
      extractNotice();
      setNoticeStatus(uiMessage('legal-hub.notice-extracted-no-downloadable-link.44ba9b77e8'));
      return;
    }
    setNoticeLoading(true);
    setNoticeStatus('');
    try {
      extractNotice();
      const report = await runLegalTool('legal_process_notice_link', {
        ...legalCaseToolArgs(activeCase, orgId),
        message: noticeText,
        noticeText,
        title: CHINA_LEGAL_TOOL_COPY.noticeLinkMaterial,
        confirmedForKb: false,
        includeExtractedText: true,
        extractedTextLimit: 8000,
      });
      if (!report.trim()) throw new Error(uiMessage('legal-hub.notice-link-result-is-empty.8480219467'));
      onAddMaterial('note', uiMessage('legal-hub.notice-link-processing-result.ba3682e3c6'), report, 'tool');
      setNoticeStatus(uiMessage('legal-hub.notice-link-processed-and-archived.ca52301c48'));
    } catch (err: any) {
      setNoticeStatus(err?.message || uiMessage('legal-hub.notice-link-processing-failed.b6c4f793c8'));
    } finally {
      setNoticeLoading(false);
    }
  };

  const generateEngagementLetter = async () => {
    if (!activeCase || documentLoading) return;
    setDocumentLoading('engagement');
    setDocumentStatus('');
    const caseProfile = buildChinaLegalCaseProfile(activeCase, stageLabels[activeCase.stage] || activeCase.stage);

    try {
      const draft = await runLegalTool('legal_generate_litigation_packet', {
        ...legalCaseToolArgs(activeCase, orgId),
        role: activeCase.party ? CHINA_LEGAL_TOOL_COPY.clientOrParty : CHINA_LEGAL_TOOL_COPY.party,
        facts: caseProfile || activeCase.notes || CHINA_LEGAL_TOOL_COPY.sparseEngagementFacts,
        claims: CHINA_LEGAL_TOOL_COPY.engagementClaim,
        evidence: (activeCase.materials || []).slice(0, 8).map(item => `${item.title}（${item.type}）`).join('\n'),
      });
      if (!draft.trim()) throw new Error(uiMessage('legal-hub.engagement-letter-draft-is-empty.4b8b7ac964'));
      onAddMaterial('pleading', uiMessage('legal-hub.engagement-letter-draft.f24d4df695'), draft, 'tool');
      setDocumentStatus(uiMessage('legal-hub.engagement-letter-draft-generated-and.736bcca40e'));
    } catch (err: any) {
      setDocumentStatus(err?.message || uiMessage('legal-hub.failed-to-draft-engagement-letter.da1f0cf7bb'));
    } finally {
      setDocumentLoading('');
    }
  };

  const generateReasoningMatrix = async () => {
    if (!activeCase || documentLoading) return;
    setDocumentLoading('reasoning');
    setDocumentStatus('');
    try {
      const profile = legalCaseDraftContext(activeCase);
      const draft = await runLegalTool('legal_case_reasoning_matrix', {
        ...legalCaseToolArgs(activeCase, orgId),
        facts: profile || activeCase.notes || CHINA_LEGAL_TOOL_COPY.sparseReasoningFacts,
        materials: profile,
        writeFiles: true,
      });
      if (!draft.trim()) throw new Error(uiMessage('legal-hub.reasoning-matrix-is-empty.11a8fdc054'));
      onAddMaterial('note', uiMessage('legal-hub.legal-reasoning-matrix.6511ae764d'), draft, 'tool');
      setDocumentStatus(uiMessage('legal-hub.reasoning-matrix-generated-and-archived.bab25bd4e7'));
    } catch (err: any) {
      setDocumentStatus(err?.message || uiMessage('legal-hub.reasoning-matrix-generation-failed.2f463a82fa'));
    } finally {
      setDocumentLoading('');
    }
  };

  const runDeliveryGate = async () => {
    if (!activeCase || documentLoading) return;
    const pickedMaterial = (activeCase.materials || []).find(material => material.id === selectedMaterialId) || null;
    const candidate = pickedMaterial?.content
      ? pickedMaterial
      : (activeCase.materials || []).find(material => (
        material.content && (
          material.type === 'pleading'
          || material.type === 'contract'
          || /起诉状|答辩状|质证|代理词|法律意见|证据目录|合同|标书|投标/.test(material.title)
        )
      ));
    if (!candidate?.content?.trim()) {
      toast.info(uiMessage('legal-hub.generate-or-select-a-draft.301d3cf2b7'));
      onSetView('packet');
      return;
    }
    setDocumentLoading('delivery');
    setDocumentStatus('');
    try {
      const report = await runLegalTool('legal_finalize_delivery_package', {
        ...legalCaseToolArgs(activeCase, orgId),
        documentType: inferChinaLegalDocumentType(candidate.title, candidate.type),
        content: candidate.content.slice(0, 24000),
        includeDocx: true,
        includePdf: false,
      });
      if (!report.trim()) throw new Error(uiMessage('legal-hub.delivery-gate-result-is-empty.f8a71afa2b'));
      onAddMaterial('note', `${candidate.title} ${uiMessage('legal-hub.delivery-gate-record.410a32f38e')}`, report, 'tool');
      setDocumentStatus(uiMessage('legal-hub.delivery-gate-completed-and-archived.a3ad6b85db'));
    } catch (err: any) {
      setDocumentStatus(err?.message || uiMessage('legal-hub.delivery-gate-failed.733db09c91'));
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
          <h2 className="text-xl font-bold text-white">{uiMessage('legal-hub.create-a-case-file-first.05eb2b4304')}</h2>
          <p className="mt-2 text-sm leading-6 text-white/45">
            {uiMessage('legal-hub.legal-work-flows-around-a.07585ffb03')}
          </p>
          <button
            onClick={onCreateCase}
            className="lumi-button-primary mt-6 border-amber-400/25 bg-amber-500/15 px-5 py-3 text-amber-200 hover:bg-amber-500/25"
          >
            <Plus size={16} />
            {uiMessage('legal-hub.new-case.8aa99242cb')}
          </button>
        </div>
      </div>
    );
  }

  const caseTitle = activeCase.title || activeCase.party || activeCase.caseNumber || uiMessage('legal-hub.untitled-case.796e2578d9');
  const selectedMaterial = (activeCase.materials || []).find(material => material.id === selectedMaterialId) || (activeCase.materials || [])[0] || null;
  const readinessItems = buildLegalCaseReadiness(activeCase, ui);
  const readinessDone = readinessItems.filter(item => item.done).length;
  const readinessNext = readinessItems.find(item => item.status === 'blocked')
    || readinessItems.find(item => item.status === 'ready')
    || readinessItems.find(item => item.status === 'missing')
    || readinessItems.find(item => item.status === 'manual')
    || null;

  return (
    <div className="custom-scrollbar h-full overflow-y-auto p-5">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-amber-300">
            <Scale size={17} />
            <span className="text-xs font-black uppercase tracking-[0.16em]">{uiMessage('legal-hub.case-workspace.9f165fc920')}</span>
          </div>
          <h2 className="mt-1 text-2xl font-bold text-white">{caseTitle}</h2>
          <p className="mt-1 text-sm text-white/42">
            {uiMessage('legal-hub.assists-legal-work-final-judgment.57ea0942e9')}
          </p>
        </div>
        <LegalMeetingInlineButton className="ml-auto" label={uiMessage('legal-hub.meeting.e16a90b510')} onClick={onStartConsultation} />
        <button
          onClick={onCreateCase}
          className="lumi-button h-10 px-4 text-sm"
        >
          <Plus size={15} />
          {uiMessage('legal-hub.new-case.8aa99242cb')}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="lumi-panel p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-bold uppercase tracking-[0.14em] text-white/40">{uiMessage('legal-hub.cases.f93a5c3a91')}</div>
              {orgBacked && (
                <button
                  type="button"
                  onClick={onRefreshCases}
                  disabled={refreshing}
                  className="lumi-icon-button h-7 w-7 rounded-lg"
                  title={uiMessage('legal-hub.refresh-organization-cases.ff33e945a4')}
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
                placeholder={uiMessage('legal-hub.search-case-number-party.102dc53546')}
                className="h-8 min-w-0 flex-1 bg-transparent text-xs text-white/70 outline-none placeholder:text-white/25"
              />
            </div>
            <div className="space-y-1.5">
              {filteredCases.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-white/30">
                  {uiMessage('legal-hub.no-matching-cases.1bc9817d75')}
                </div>
              ) : filteredCases.map(item => (
                <div
                  key={item.id}
                  className={`group flex items-center rounded-xl border transition-colors ${
                    item.id === activeCaseId
                      ? 'border-amber-400/20 bg-amber-500/[0.12] text-amber-200'
                      : 'border-transparent bg-white/[0.03] text-white/58 hover:border-white/[0.08] hover:bg-white/[0.06] hover:text-white/75'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectCase(item.id)}
                    className="min-w-0 flex-1 px-3 py-2 text-left"
                  >
                    <span className="block truncate text-sm font-semibold">{item.title || item.party || item.caseNumber || uiMessage('legal-hub.untitled-case.796e2578d9')}</span>
                    <span className="mt-0.5 block truncate text-xs text-white/32">{stageLabels[item.stage]} / {item.cause || uiMessage('legal-hub.no-cause.88636fe5c2')}</span>
                  </button>
                  {canDeleteCases && (
                    <button
                      type="button"
                      onClick={() => onDeleteCase(item)}
                      className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/30 transition hover:bg-rose-500/12 hover:text-rose-200"
                      aria-label={formatUiMessage('legal-hub.delete-case-value0.2812ed70f8', { value0: item.title || item.caseNumber || '' })}
                      title={uiMessage('legal-hub.delete-case.d0c1c0a330')}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="lumi-panel border-amber-400/15 bg-amber-400/[0.045] p-3">
            <div className="flex items-start gap-2 text-amber-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <p className="text-xs leading-5 text-amber-100/70">
                {uiMessage('legal-hub.deadline-calculations-are-assistant-reminders.e596ac453b')}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <section className="lumi-panel p-4">
            <div className="mb-4 flex items-center gap-2 text-white/78">
              <FolderOpen size={16} className="text-amber-300" />
              <h3 className="text-sm font-bold">{uiMessage('legal-hub.case-file.65a38706c2')}</h3>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <CaseField label={uiMessage('legal-hub.case-name.55c6d2512f')} value={activeCase.title} onChange={value => update({ title: value })} />
              <CaseField label={uiMessage('legal-hub.case-number.1adfaa625a')} value={activeCase.caseNumber} onChange={value => update({ caseNumber: value })} />
              <CaseField label={uiMessage('legal-hub.party.9f6b14598d')} value={activeCase.party} onChange={value => update({ party: value })} />
              <CaseField label={uiMessage('legal-hub.cause.8d47df5928')} value={activeCase.cause} onChange={value => update({ cause: value })} />
              <CaseField label={uiMessage('legal-hub.court.4dc052bdf6')} value={activeCase.court} onChange={value => update({ court: value })} />
              <CaseField label={uiMessage('legal-hub.judge.329c4c5855')} value={activeCase.judge} onChange={value => update({ judge: value })} />
              <label className="space-y-1.5">
                <span className="text-xs text-white/42">{uiMessage('legal-hub.stage.1f0cfbfea3')}</span>
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
              <span className="text-xs text-white/42">{uiMessage('legal-hub.facts-missing-materials.af3bad57e8')}</span>
              <textarea
                value={activeCase.notes}
                onChange={event => update({ notes: event.target.value })}
                rows={4}
                className="lumi-field w-full resize-none rounded-lg text-sm leading-6 focus:border-amber-400/50"
                placeholder={uiMessage('legal-hub.record-statements-issues-evidence-gaps.f97abfc047')}
              />
            </label>
          </section>

          <section className="grid grid-cols-1 gap-3 lg:grid-cols-4">
            <LegalMeetingActionButton title={uiMessage('legal-hub.consultation.921ab7edb9')} desc={uiMessage('legal-hub.start-transcription.c0d64487e4')} onClick={onStartConsultation} />
            <LegalActionButton icon={<Search size={16} />} title={uiMessage('legal-hub.case-analysis.4e8fce63e9')} desc={uiMessage('legal-hub.search-precedents.5d3dd9e729')} onClick={() => onSetView('case-search')} />
            <LegalActionButton icon={<Brain size={16} />} title={uiMessage('legal-hub.strategy.25d1bf401d')} desc={uiMessage('legal-hub.build-litigation-route.7c821a3812')} onClick={() => onSetView('strategy')} />
            <LegalActionButton icon={<ClipboardList size={16} />} title={uiMessage('legal-hub.case-plan.ed9eaee22d')} desc={uiMessage('legal-hub.create-workflow.9ccc04284c')} onClick={onCreatePlan} />
          </section>

          <section className="lumi-panel p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-white/78">
                <CheckCircle size={16} className="text-emerald-300" />
                <h3 className="text-sm font-bold">{uiMessage('legal-hub.case-loop.9317db1dd1')}</h3>
              </div>
              <span className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-white/45">
                {readinessDone}/{readinessItems.length}
              </span>
            </div>
            {readinessNext && (
              <button
                type="button"
                onClick={() => readinessNext.view && onSetView(readinessNext.view)}
                className="mb-3 w-full rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 text-left text-xs text-white/58 transition-colors hover:border-amber-400/18 hover:bg-amber-500/[0.05]"
              >
                <span className="font-semibold text-white/76">{uiMessage('legal-hub.next.b527069e7f')}</span>
                <span className="mx-2 text-white/22">/</span>
                <span className={readinessNext.status === 'blocked' ? 'text-rose-200' : 'text-amber-100/80'}>{readinessNext.label}</span>
                <span className="ml-2 text-white/45">{readinessNext.nextStep}</span>
              </button>
            )}
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
              {readinessItems.map(item => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => item.view && onSetView(item.view)}
                  title={item.nextStep}
                  className={`min-h-[76px] rounded-lg border px-3 py-2 text-left transition-colors ${legalReadinessTone(item.status)}`}
                >
                  <div className="flex items-center gap-1.5 text-xs font-bold">
                    {legalReadinessIcon(item)}
                    <span className="min-w-0 truncate">{item.label}</span>
                  </div>
                  <div className="mt-2 text-[11px] text-white/50">{item.detail}</div>
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={generateReasoningMatrix}
                disabled={documentLoading === 'reasoning'}
                className="lumi-button h-9 px-3 text-xs"
              >
                {documentLoading === 'reasoning' ? uiMessage('legal-hub.generating.634308f29b') : uiMessage('legal-hub.reasoning-matrix.7e54736217')}
              </button>
              <button type="button" onClick={() => onSetView('external-research')} className="lumi-button h-9 px-3 text-xs">
                {uiMessage('legal-hub.sources.2c0ee0fd12')}
              </button>
              <button type="button" onClick={() => onSetView('packet')} className="lumi-button h-9 px-3 text-xs">
                {uiMessage('legal-hub.packet.1758eaea66')}
              </button>
              <button
                type="button"
                onClick={runDeliveryGate}
                disabled={documentLoading === 'delivery'}
                className="lumi-button h-9 px-3 text-xs"
              >
                {documentLoading === 'delivery' ? uiMessage('legal-hub.checking.913563d226') : uiMessage('legal-hub.delivery-gate.de13676f0a')}
              </button>
            </div>
          </section>

          <section className="lumi-panel p-4">
            <div className="mb-4 flex items-center gap-2 text-white/78">
              <Calendar size={16} className="text-cyan-300" />
              <h3 className="text-sm font-bold">{uiMessage('legal-hub.deadlines-and-hearings.804d0a2db1')}</h3>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <DateField label={uiMessage('legal-hub.hearing-date.e3930c19c4')} value={activeCase.hearingDate} onChange={value => update({ hearingDate: value })} onReminder={() => createDateReminder('hearing')} />
              <DateField label={uiMessage('legal-hub.judgment-date.abf2b584c3')} value={activeCase.judgmentDate} onChange={value => update({ judgmentDate: value })} />
              <DateField label={uiMessage('legal-hub.appeal-deadline.0e3e1ebb0f')} value={activeCase.appealDeadline} onChange={value => update({ appealDeadline: value })} onReminder={() => createDateReminder('appeal')} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={calculateAppealDeadline} className="lumi-button h-9 px-3 text-xs">
                {uiMessage('legal-hub.calculate-appeal-deadline.7fb9a79f48')}
              </button>
              <LegalMeetingInlineButton label={uiMessage('legal-hub.open-meeting-notes.8f232a1703')} onClick={onOpenMeetingNotes} />
              <button onClick={() => onSetView('import')} className="lumi-button h-9 px-3 text-xs">
                {uiMessage('legal-hub.import-judgment.7b322fc577')}
              </button>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <div className="lumi-panel p-4">
              <div className="mb-3 flex items-center gap-2 text-white/78">
                <Gavel size={16} className="text-amber-300" />
                <h3 className="text-sm font-bold">{uiMessage('legal-hub.hearing-notice-extractor.291c653bd1')}</h3>
              </div>
              <textarea
                value={noticeText}
                onChange={event => setNoticeText(event.target.value)}
                rows={5}
                className="lumi-field w-full resize-none rounded-lg text-sm leading-6 focus:border-amber-400/50"
                placeholder={uiMessage('legal-hub.paste-sms-or-court-notice.e888cb415d')}
              />
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={extractNotice}
                  disabled={!noticeText.trim() || noticeLoading}
                  className="lumi-button-primary h-9 border-amber-400/25 bg-amber-500/15 px-4 text-xs text-amber-200 hover:bg-amber-500/25"
                >
                  {uiMessage('legal-hub.extract.c127c363a4')}
                </button>
                <button
                  onClick={processNoticeLink}
                  disabled={!noticeText.trim() || noticeLoading}
                  className="lumi-button h-9 px-3 text-xs"
                >
                  {noticeLoading ? uiMessage('legal-hub.processing.45c0c78af6') : uiMessage('legal-hub.process-link.7a43f618ce')}
                </button>
                {noticeStatus && <span className="text-xs text-emerald-300/70">{noticeStatus}</span>}
              </div>
            </div>

            <div className="lumi-panel p-4">
              <div className="mb-3 flex items-center gap-2 text-white/78">
                <FileText size={16} className="text-blue-300" />
                <h3 className="text-sm font-bold">{uiMessage('legal-hub.materials-and-documents.af06979d97')}</h3>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={generateEngagementLetter}
                  disabled={documentLoading === 'engagement'}
                  className="lumi-button h-9 px-3 text-xs"
                >
                  {documentLoading === 'engagement' ? uiMessage('legal-hub.drafting.7a57e7e31f') : uiMessage('legal-hub.engagement-letter.260ac284a3')}
                </button>
                <LegalMeetingInlineButton
                  label={uiMessage('legal-hub.trial-notes.25b8c590da')}
                  onClick={() => {
                    setDocumentStatus(uiMessage('legal-hub.trial-consultation-transcription-started-notes.d47206cbc8'));
                    onStartConsultation();
                  }}
                />
                <button onClick={() => onSetView('contract-review')} className="lumi-button h-9 px-3 text-xs">
                  {uiMessage('legal-hub.contract-review.798c7d6913')}
                </button>
                <button onClick={() => onSetView('asset-trace')} className="lumi-button h-9 px-3 text-xs">
                  {uiMessage('legal-hub.asset-trace.24d93c8873')}
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
                  <p className="text-sm text-white/28">{uiMessage('legal-hub.no-materials-yet-consultations-notices.9b7ef37152')}</p>
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
                  <div className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-white/35">{uiMessage('legal-hub.material-content.a5b29f0203')}</div>
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
  orgId,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => void;
}) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const defaultFacts = useMemo(() => legalCaseDraftContext(caseFile), [caseFile]);
  const defaultEvidence = useMemo(() => (
    (caseFile?.materials || [])
      .filter(material => material.type === 'evidence')
      .map(material => `${material.title}\n${material.content || ''}`)
      .join('\n\n')
  ), [caseFile]);
  const [role, setRole] = useState('plaintiff');
  const [facts, setFacts] = useState(defaultFacts);
  const [claims, setClaims] = useState('');
  const [evidence, setEvidence] = useState(defaultEvidence);
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setFacts(defaultFacts);
    setEvidence(defaultEvidence);
    setResult('');
  }, [caseFile?.id]);

  const generate = async () => {
    if ((!facts.trim() && !evidence.trim()) || loading) return;
    setLoading(true);
    setResult('');
    try {
      const text = await runLegalTool('legal_generate_litigation_packet', {
        ...legalCaseToolArgs(caseFile, orgId),
        role,
        claims,
        facts,
        evidence,
      });
      setResult(text);
    } catch (err: any) {
      setResult(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const archive = () => {
    if (!result || !onAddMaterial) return;
    onAddMaterial('pleading', `${caseFile?.title || caseFile?.caseNumber || uiMessage('legal-hub.case.8a53cf13fb')} 半自动文书包`, result, 'tool');
  };

  return (
    <LegalTwoPaneTool
      icon={<ClipboardList size={22} />}
      accent="amber"
      title={uiMessage('legal-hub.semi-automated-litigation-packet.37b15d0cf5')}
      desc={uiMessage('legal-hub.draft-complaint-defense-evidence-retainer.da01b9a635')}
      caseFile={caseFile}
      running={loading}
      left={(
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <select value={role} onChange={event => setRole(event.target.value)} className="lumi-field h-10 rounded-lg">
              <option value="plaintiff">{uiMessage('legal-hub.plaintiff.607f2116c4')}</option>
              <option value="defendant">{uiMessage('legal-hub.defendant.a3bd508da0')}</option>
              <option value="applicant">{uiMessage('legal-hub.applicant.5be3a82eea')}</option>
              <option value="respondent">{uiMessage('legal-hub.respondent.f726ebb1c2')}</option>
            </select>
            <input value={claims} onChange={event => setClaims(event.target.value)} placeholder={uiMessage('legal-hub.claims-defenses-or-objective.00855c8c20')} className="lumi-field h-10 rounded-lg" />
          </div>
          <textarea value={facts} onChange={event => setFacts(event.target.value)} placeholder={uiMessage('legal-hub.facts-timeline-parties.6783b7303c')} className="mt-3 min-h-[240px] w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-amber-400/35" />
          <textarea value={evidence} onChange={event => setEvidence(event.target.value)} placeholder={uiMessage('legal-hub.evidence-opponent-materials-gaps.61eff6246d')} className="mt-3 min-h-[140px] w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-amber-400/35" />
          <button onClick={generate} disabled={loading || (!facts.trim() && !evidence.trim())} className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg border border-amber-400/20 bg-amber-500/15 px-4 py-2.5 text-sm font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:opacity-50">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <ClipboardList size={16} />}
            {loading ? uiMessage('legal-hub.generating.634308f29b') : uiMessage('legal-hub.generate-packet.8494e1ff7c')}
          </button>
        </>
      )}
      result={result}
      emptyText={uiMessage('legal-hub.the-packet-will-appear-here.52a02955fa')}
      archiveLabel={uiMessage('legal-hub.archive-to-case.6dc41a223d')}
      onArchive={!orgId && result ? archive : undefined}
    />
  );
}

function LegalExternalResearchView({
  caseFile,
  orgId,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
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
  }, [caseFile?.id]);

  const generate = async () => {
    if (!facts.trim() && !issues.trim() && !companies.trim()) return;
    setLoading(true);
    setResult('');
    try {
      const text = await runLegalTool('legal_external_research_plan', {
        ...legalCaseToolArgs(caseFile, orgId),
        facts,
        issues: issues.split(/[，,；;\n]/).map(item => item.trim()).filter(Boolean),
        companyNames: companies.split(/[，,；;\n]/).map(item => item.trim()).filter(Boolean),
      });
      setResult(text);
    } catch (err: any) {
      setResult(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const archive = () => {
    if (!result || !onAddMaterial) return;
    onAddMaterial('note', `${caseFile?.title || caseFile?.caseNumber || uiMessage('legal-hub.case.8a53cf13fb')} 外部检索行动单`, result, 'tool');
  };

  return (
    <LegalTwoPaneTool
      icon={<Search size={22} />}
      accent="cyan"
      title={uiMessage('legal-hub.semi-automated-external-research.a9fe50cd06')}
      desc={uiMessage('legal-hub.generate-search-terms-login-presets.497732dec9')}
      caseFile={caseFile}
      running={loading}
      left={(
        <>
          <input value={issues} onChange={event => setIssues(event.target.value)} placeholder={uiMessage('legal-hub.issues-comma-separated.f2f8ca4339')} className="lumi-field h-10 w-full rounded-lg" />
          <input value={companies} onChange={event => setCompanies(event.target.value)} placeholder={uiMessage('legal-hub.companies-debtors-comma-separated.052f39a297')} className="lumi-field mt-3 h-10 w-full rounded-lg" />
          <textarea value={facts} onChange={event => setFacts(event.target.value)} placeholder={uiMessage('legal-hub.facts-and-research-context.cd7839dce0')} className="mt-3 min-h-[340px] w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-cyan-400/35" />
          <button onClick={generate} disabled={loading || (!facts.trim() && !issues.trim() && !companies.trim())} className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-500/15 px-4 py-2.5 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/25 disabled:opacity-50">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            {loading ? uiMessage('legal-hub.generating.634308f29b') : uiMessage('legal-hub.generate-plan.6825d94075')}
          </button>
        </>
      )}
      result={result}
      emptyText={uiMessage('legal-hub.external-research-plan-will-appear.701d667eed')}
      archiveLabel={uiMessage('legal-hub.archive-to-case.6dc41a223d')}
      onArchive={!orgId && result ? archive : undefined}
    />
  );
}

function LegalTwoPaneTool({
  icon,
  accent,
  title,
  desc,
  caseFile,
  running = false,
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
  caseFile?: LegalCaseFile | null;
  running?: boolean;
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
        <LegalCaseContextBar caseFile={caseFile} state={running ? 'running' : result ? 'result' : 'input'} />
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
  orgId,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => void;
}) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const defaultFacts = useMemo(() => legalCaseDraftContext(caseFile), [caseFile]);
  const [facts, setFacts] = useState(defaultFacts);
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setFacts(defaultFacts);
    setResult('');
  }, [caseFile?.id]);

  const analyze = async () => {
    if (!facts.trim() || loading) return;
    setLoading(true);
    setResult('');
    try {
      const text = await runLegalTool('legal_case_strategy', {
        ...legalCaseToolArgs(caseFile, orgId),
        facts,
      });
      setResult(text);
    } catch (e: any) {
      setResult(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };
  const archive = () => {
    if (!result || !onAddMaterial) return;
    onAddMaterial('note', `${legalCaseTitle(caseFile)} 诉讼策略分析`, result, 'tool');
    toast.success(uiMessage('legal-hub.strategy-analysis-archived-to-the.7220b483ae'));
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

        <LegalCaseContextBar caseFile={caseFile} state={loading ? 'running' : result ? 'result' : 'input'} />

        <section className="grid min-h-[520px] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <label className="mb-2 text-sm font-medium text-white">{uiMessage('legal-hub.case-facts.a83dee9a30')}</label>
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
              {loading ? uiMessage('legal-hub.analyzing.3b98929aff') : t.legalCaseStrategyAnalyze}
            </button>
          </div>

          <div className="min-h-0 rounded-lg border border-white/10 bg-white/[0.04] p-4">
            {result ? (
              <div className="flex h-full min-h-[420px] flex-col gap-3">
                {!orgId && (
                  <div className="flex justify-end">
                    <button onClick={archive} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white">
                      <FolderOpen size={14} />
                      {uiMessage('legal-hub.archive-to-case.6dc41a223d')}
                    </button>
                  </div>
                )}
                <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/20 p-4 text-sm leading-7 text-white/76 custom-scrollbar">
                  {result}
                </pre>
              </div>
            ) : (
              <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
                <Brain size={32} className="text-white/20" />
                <span>{uiMessage('legal-hub.strategy-analysis-will-appear-here.61c7ee7a79')}</span>
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
  orgId,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => void;
}) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const defaultText = useMemo(() => (
    (caseFile?.materials || []).find(material => (
      Boolean(material.content) && (material.type === 'pleading' || material.type === 'contract')
    ))?.content || ''
  ), [caseFile]);
  const [text, setText] = useState(defaultText);
  const [results, setResults] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setText(defaultText);
    setResults(null);
  }, [caseFile?.id]);

  const verify = async () => {
    if (!text.trim() || loading) return;
    setLoading(true);
    try {
      const verification = await runLegalTool('legal_verify_citation', {
        ...legalCaseToolArgs(caseFile, orgId),
        text,
      });
      setResults([{ content: verification || uiMessage('legal-hub.verification-complete.684377838d') }]);
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
    toast.success(uiMessage('legal-hub.citation-verification-archived-to-the.9d6dce0d48'));
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

        <LegalCaseContextBar caseFile={caseFile} state={loading ? 'running' : verificationText ? 'result' : 'input'} />

        <section className="grid min-h-[500px] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <label className="mb-2 text-sm font-medium text-white">{uiMessage('legal-hub.text-to-verify.e83f5c99d9')}</label>
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
              {loading ? uiMessage('legal-hub.verifying.1c01a1f8ae') : t.legalVerifyCitationVerify}
            </button>
          </div>

          <div className="min-h-0 rounded-lg border border-white/10 bg-white/[0.04] p-4">
            {results && results.length > 0 ? (
              <div className="flex h-full min-h-[400px] flex-col gap-3">
                <div className="flex justify-end">
                  <button onClick={archive} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white">
                    <FolderOpen size={14} />
                    {uiMessage('legal-hub.archive-to-case.6dc41a223d')}
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
                <span>{uiMessage('legal-hub.citation-verification-results-will-appear.7fa754234b')}</span>
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
  const articleTitle = `${caseTitle} - ${uiMessage('legal-hub.case-knowledge-archive.fb5aa7cf62')}`;
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
      if (!res.ok) throw new Error(data.error || uiMessage('legal-hub.failed-to-sync-to-knowledge.c0a55da5a1'));
      const articleId = data.id || data.article?.id || data.articleId || '';
      window.dispatchEvent(new CustomEvent('lumi:knowledge-updated', {
        detail: {
          domain: 'work',
          files: [{ id: articleId, name: articleTitle, displayName: articleTitle }],
        },
      }));
      window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
      setStatus(uiMessage('legal-hub.synced-to-the-organization-knowledge.f95c36e4c6'));
      toast.success(uiMessage('legal-hub.case-synced-to-organization-knowledge.e5d9130fb8'));
    } catch (err: any) {
      const message = err?.message || uiMessage('legal-hub.failed-to-sync-to-knowledge.c0a55da5a1');
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
          <h2 className="text-xl font-semibold">{uiMessage('legal-hub.create-a-case-first.277e87bd38')}</h2>
          <p className="mt-2 text-sm leading-6 text-white/45">
            {uiMessage('legal-hub.knowledge-sync-needs-a-current.b4ab7aa09b')}
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
                <h2 className="truncate text-xl font-semibold text-white">{uiMessage('legal-hub.sync-to-organization-knowledge.06ec3e8e07')}</h2>
                <p className="mt-1 text-sm leading-6 text-white/50">
                  {uiMessage('legal-hub.package-the-current-case-facts.ac1c53077e')}
                </p>
              </div>
            </div>
            <button
              onClick={syncToKnowledgeBase}
              disabled={loading || !articleContent.trim()}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/15 px-4 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-45"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Archive size={16} />}
              {loading ? uiMessage('legal-hub.syncing.379d137ae4') : uiMessage('legal-hub.sync-to-kb.f5314698c5')}
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
              {uiMessage('legal-hub.open-knowledge-base.fecb312d9e')}
            </button>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'chat' } }))}
              className="lumi-button h-9 px-3 text-xs"
            >
              {uiMessage('legal-hub.ask-lumi-in-work-workspace.6fe76d2092')}
            </button>
          </div>
        </section>

        <LegalCaseContextBar caseFile={caseFile} state={status ? 'result' : loading ? 'running' : 'input'} />

        <section className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <h3 className="text-sm font-semibold text-white">{uiMessage('legal-hub.archive-summary.089620ba4e')}</h3>
            <div className="mt-3 space-y-2 text-sm text-white/62">
              <div>{uiMessage('legal-hub.case.8a53cf13fb')}: {caseTitle}</div>
              <div>{uiMessage('legal-hub.case-number.1adfaa625a')}: {caseFile.caseNumber || '-'}</div>
              <div>{uiMessage('legal-hub.cause.8d47df5928')}: {caseFile.cause || '-'}</div>
              <div>{uiMessage('legal-hub.stage.1f0cfbfea3')}: {caseFile.stage || '-'}</div>
              <div>{uiMessage('legal-hub.materials.987ed9a5e2')}: {(caseFile.materials || []).length}</div>
            </div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-white">{uiMessage('legal-hub.knowledge-preview.5f5d84067a')}</h3>
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
  orgId,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
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
      const reply = await runLegalTool('legal_import_judgment', {
        ...legalCaseToolArgs(caseFile, orgId),
        content,
      });
      if (caseFile && onAddMaterial) {
        const title = inferLegalMaterialTitle(content, uiMessage('legal-hub.judgment-document.3349b60486'));
        onAddMaterial('judgment', title, content, 'import');
        setStatus(`${reply}\n\n${uiMessage('legal-hub.archived-to-the-current-case.e823bb894a')}`);
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

        <LegalCaseContextBar caseFile={caseFile} state={loading ? 'running' : status ? 'result' : 'input'} />

        <section className="grid min-h-[560px] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <label className="mb-2 text-sm font-medium text-white">{uiMessage('legal-hub.judgment-document-content.a5f6676889')}</label>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder={uiMessage('legal-hub.paste-judgment-document-content-here.2534452d81')}
              className="min-h-[420px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 font-mono text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-blue-400/35"
            />
            <button
              onClick={importJudgment}
              disabled={loading || !content.trim()}
              className="mt-3 inline-flex items-center justify-center gap-2 self-end rounded-lg border border-blue-400/20 bg-blue-500/15 px-4 py-2.5 text-sm font-medium text-blue-100 transition hover:bg-blue-500/25 disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
              {loading ? uiMessage('legal-hub.importing.ec01cb1a24') : t.legalImportJudgment}
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
                <span>{uiMessage('legal-hub.import-result-and-archive-status.ef57344682')}</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
