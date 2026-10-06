import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useLegalDocument } from "../../../hooks/useLegalDocument";
import { runLegalTool } from "../../../lib/legalToolClient";
import type { LegalCaseFile, LegalCaseMaterial } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import { buildChinaLegalCaseProfile, CHINA_LEGAL_TOOL_COPY, inferChinaLegalDocumentType } from "../../../i18n/regions/cn/legal";
import type { LegalView } from './contracts';
import { legalStageLabels, addDays, legalCaseToolArgs, legalCaseDraftContext } from './case_values';

export function useLegalCaseWorkspaceState({
  caseFilter,
  setCaseFilter,
  cases,
  activeCase,
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
}: {
  caseFilter: string;
  setCaseFilter: (value: string) => void;
  cases: LegalCaseFile[];
  activeCase: LegalCaseFile | null;
  onCreateCase: () => void;
  onDeleteCase: (caseFile: LegalCaseFile) => void;
  onSelectCase: (id: string) => void;
  onUpdateCase: (id: string, patch: Partial<LegalCaseFile>) => boolean | Promise<boolean>;
  onSetView: (view: LegalView) => void;
  onStartConsultation: () => void;
  onOpenMeetingNotes: () => void;
  onCreateReminder: (content: string, dueAt?: string) => void;
  onCreatePlan: () => void;
  onAddMaterial: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => boolean | Promise<boolean>;
  onRefreshCases: () => void;
  orgBacked: boolean;
  canDeleteCases: boolean;
  orgId?: string;
  refreshing: boolean;
}) {

  const notice = useLegalDocument('', { error: 'Error' });
  const { text: noticeText, setText: setNoticeText, result: noticeStatus, busy: noticeLoading } = notice;
  const documents = useLegalDocument('', { error: 'Error' });
  const { result: documentStatus, busy: documentLoading } = documents;
  const [selectedMaterialId, setSelectedMaterialId] = useState('');

  const stageLabels = legalStageLabels();

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

  const extractNotice = async (signal: AbortSignal) => {
    if (!activeCase || !noticeText.trim()) return '';
    // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
    const caseNumber = noticeText.match(/[（(]\d{4}[）)][^，。；;\n]{2,80}(?:号|字第?\d+号?)/)?.[0] || '';
    // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
    const court = noticeText.match(/[\u4e00-\u9fa5]{2,40}(?:人民法院|法院)/)?.[0] || '';
    // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
    const dateMatch = noticeText.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:\s*(\d{1,2})[:：时](\d{1,2})?分?)?/);
    const hearingDate = dateMatch
      ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
      : '';
    const patch: Partial<LegalCaseFile> = {};
    if (caseNumber && !activeCase.caseNumber) patch.caseNumber = caseNumber;
    if (court && !activeCase.court) patch.court = court;
    if (hearingDate) patch.hearingDate = hearingDate;
    patch.notes = [activeCase.notes, uiMessage('legal-hub.hearing-notice.ce5d4e47fe'), noticeText].filter(Boolean).join('\n');
    if (!await onUpdateCase(activeCase.id, patch)) throw new Error(uiMessage('legal-hub.failed-to-save-case.90f7d722b2'));
    signal.throwIfAborted();
    if (!await onAddMaterial('note', uiMessage('legal-hub.hearing-notice-sms.10239017c5'), noticeText, 'notice')) throw new Error(uiMessage('legal-hub.failed-to-archive-material.4ed52ef083'));
    signal.throwIfAborted();
    return uiMessage('legal-hub.notice-extracted-review-case-number.77a3bafd0a');
  };

  const executeCaseTool = async (signal: AbortSignal, tool: string, args: Record<string, any>, type: LegalCaseMaterial['type'], title: string) => {
    signal.throwIfAborted();
    const report = await runLegalTool(tool, { ...legalCaseToolArgs(activeCase, orgId), ...args }, signal);
    signal.throwIfAborted();
    if (!report.trim()) throw new Error(`${tool} failed`);
    if (!orgId && !await onAddMaterial(type, title, report, 'tool')) throw new Error(uiMessage('legal-hub.failed-to-archive-material.4ed52ef083'));
    signal.throwIfAborted();
    return report;
  };

  const processNoticeLink = () => {
    if (!activeCase || !noticeText.trim()) return;
    return notice.generate(async signal => {
      await extractNotice(signal);
      if (!/https?:\/\/\S+/i.test(noticeText)) return uiMessage('legal-hub.notice-extracted-no-downloadable-link.44ba9b77e8');
      return executeCaseTool(signal, 'legal_process_notice_link', {
        message: noticeText,
        noticeText,
        title: CHINA_LEGAL_TOOL_COPY.noticeLinkMaterial,
        confirmedForKb: false,
        includeExtractedText: true,
        extractedTextLimit: 8000,
      }, 'note', uiMessage('legal-hub.notice-link-processing-result.ba3682e3c6'));
    });
  };

  const generateEngagementLetter = () => {
    if (!activeCase) return;
    const caseProfile = buildChinaLegalCaseProfile(activeCase, stageLabels[activeCase.stage] || activeCase.stage);
    return documents.generate(signal => executeCaseTool(signal, 'legal_generate_litigation_packet', {
      role: activeCase.party ? CHINA_LEGAL_TOOL_COPY.clientOrParty : CHINA_LEGAL_TOOL_COPY.party,
      facts: caseProfile || activeCase.notes || CHINA_LEGAL_TOOL_COPY.sparseEngagementFacts,
      claims: CHINA_LEGAL_TOOL_COPY.engagementClaim,
      evidence: (activeCase.materials || []).slice(0, 8).map(item => `${item.title}（${item.type}）`).join('\n'),
    }, 'pleading', uiMessage('legal-hub.engagement-letter-draft.f24d4df695')));
  };

  const generateReasoningMatrix = () => {
    if (!activeCase) return;
    const profile = legalCaseDraftContext(activeCase);
    return documents.generate(signal => executeCaseTool(signal, 'legal_case_reasoning_matrix', {
      facts: profile || activeCase.notes || CHINA_LEGAL_TOOL_COPY.sparseReasoningFacts,
      materials: profile,
      writeFiles: true,
    }, 'note', uiMessage('legal-hub.legal-reasoning-matrix.6511ae764d')));
  };

  const runDeliveryGate = () => {
    if (!activeCase) return;
    const pickedMaterial = (activeCase.materials || []).find(material => material.id === selectedMaterialId) || null;
    const candidate = pickedMaterial?.content
      ? pickedMaterial
      : (activeCase.materials || []).find(material => (
        material.content && (
          material.type === 'pleading'
          || material.type === 'contract'
          // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
          || /起诉状|答辩状|质证|代理词|法律意见|证据目录|合同|标书|投标/.test(material.title)
        )
      ));
    if (!candidate?.content?.trim()) {
      toast.info(uiMessage('legal-hub.generate-or-select-a-draft.301d3cf2b7'));
      onSetView('packet');
      return;
    }
    return documents.generate(signal => executeCaseTool(signal, 'legal_finalize_delivery_package', {
      documentType: inferChinaLegalDocumentType(candidate.title, candidate.type),
      content: candidate.content.slice(0, 24000),
      includeDocx: true,
      includePdf: false,
    }, 'note', `${candidate.title} ${uiMessage('legal-hub.delivery-gate-record.410a32f38e')}`));
  };
  return { activeCase, onCreateCase, selectedMaterialId, onStartConsultation, orgBacked, onRefreshCases, refreshing, caseFilter, setCaseFilter, filteredCases, onSelectCase, stageLabels, canDeleteCases, onDeleteCase, update, onSetView, onCreatePlan, generateReasoningMatrix, documentLoading, runDeliveryGate, createDateReminder, calculateAppealDeadline, onOpenMeetingNotes, noticeText, setNoticeText, notice, extractNotice, noticeLoading, processNoticeLink, noticeStatus, generateEngagementLetter, documentStatus, documents, setSelectedMaterialId };
}
