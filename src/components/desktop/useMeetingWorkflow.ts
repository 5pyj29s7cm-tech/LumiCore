

import { type MeetingNote } from "./runtime_state";

import React, { useEffect, useCallback } from 'react';

import { toast } from 'sonner';

import { useVoiceCall } from '@/hooks/useVoiceCall';
import { useApp, type OperationMode } from '@/contexts/AppContext';

import { archiveLegalMeetingToConsultationCase, isLegalCaseAccount, clearLegalConsultationCaseId, getLegalCaseLabel, getLegalConsultationCase, getLegalConsultationCaseId, setLegalConsultationCaseId } from '@/lib/legalCaseStore';

import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import { desktopWorkflowCopy } from "../../i18n/locales/desktopWorkflows";

type useMeetingWorkflowInput = {
meetingStartedAt: number;
legalMeetingCaseTitle: string;
meetingReport: string;
meetingNotes: MeetingNote[];
formatMeetingNoteForExport: (note: MeetingNote) => string;
lang: "en" | "zh";
meetingIdentityRef: React.RefObject<{ scope: string; meetingId: string; refinementId: string; }>;
setMeetingReport: React.Dispatch<React.SetStateAction<string>>;
meetingStorageKeys: { identity: string; startedAt: string; notes: string; report: string; };
setMeetingReportGenerating: React.Dispatch<React.SetStateAction<boolean>>;
workDomain: "personal" | "work";
orgConnection: ReturnType<typeof useApp>["orgConnection"];
aiConfig: ReturnType<typeof useApp>["aiConfig"];
lastLegalMeetingArchiveRef: React.RefObject<string>;
setLegalMeetingCaseTitle: React.Dispatch<React.SetStateAction<string>>;
user: any;
waitForMeetingRefinement: (identity: { scope: string; meetingId: string; refinementId: string; }) => Promise<MeetingNote[]>;
stopMeetingAudio: (options?: { refineTranscript?: boolean; refinementId?: string; }) => void;
setMeetingNotesOpen: React.Dispatch<React.SetStateAction<boolean>>;
operationMode: OperationMode;
endCall: ReturnType<typeof useVoiceCall>["endCall"];
setMeetingPaused: React.Dispatch<React.SetStateAction<boolean>>;
meetingVoiceActiveRef: React.RefObject<boolean>;
meetingStartAttemptRef: React.RefObject<number>;
callState: ReturnType<typeof useVoiceCall>["callState"];
setOperationMode: (mode: OperationMode) => void;
meetingPaused: boolean;
renewMeetingIdentity: () => void;
setMeetingNotes: React.Dispatch<React.SetStateAction<MeetingNote[]>>;
setMeetingSpeakerCount: React.Dispatch<React.SetStateAction<number>>;
setMeetingStartedAt: React.Dispatch<React.SetStateAction<number>>;
lastMeetingTranscriptRef: React.RefObject<{ text: string; at: number; speakerKey: string; }>;
setPendingOperationMode: React.Dispatch<React.SetStateAction<OperationMode | null>>;
pendingOperationMode: OperationMode | null;
resetMeetingCapture: (startedAt?: number) => void;
};
export function useMeetingWorkflow({ meetingStartedAt, legalMeetingCaseTitle, meetingReport, meetingNotes, formatMeetingNoteForExport, lang, meetingIdentityRef, setMeetingReport, meetingStorageKeys, setMeetingReportGenerating, workDomain, orgConnection, aiConfig, lastLegalMeetingArchiveRef, setLegalMeetingCaseTitle, user, waitForMeetingRefinement, stopMeetingAudio, setMeetingNotesOpen, operationMode, endCall, setMeetingPaused, meetingVoiceActiveRef, meetingStartAttemptRef, callState, setOperationMode, meetingPaused, renewMeetingIdentity, setMeetingNotes, setMeetingSpeakerCount, setMeetingStartedAt, lastMeetingTranscriptRef, setPendingOperationMode, pendingOperationMode, resetMeetingCapture }: useMeetingWorkflowInput) {

  const formatMeetingTime = useCallback((value: number) => {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }, []);

  const buildMeetingMarkdown = useCallback(() => {
    const started = meetingStartedAt ? new Date(meetingStartedAt) : new Date();
    const lines = [
      `# Lumi Meeting Notes`,
      '',
      `Started: ${started.toLocaleString()}`,
      ...(legalMeetingCaseTitle ? [`Case: ${legalMeetingCaseTitle}`] : []),
      '',
      ...(meetingReport ? ['## Lumi Report', '', meetingReport, ''] : []),
      '## Transcript',
      '',
      ...meetingNotes.map(note => `- [${formatMeetingTime(note.time)}] ${formatMeetingNoteForExport(note)}`),
      '',
    ];
    return lines.join('\n');
  }, [formatMeetingNoteForExport, formatMeetingTime, legalMeetingCaseTitle, meetingNotes, meetingReport, meetingStartedAt]);

  const buildFallbackMeetingReport = useCallback((notesOverride?: MeetingNote[]) => {
    const notesForReport = notesOverride || meetingNotes;
    const started = meetingStartedAt ? new Date(meetingStartedAt).toLocaleString() : new Date().toLocaleString();
    const legalCase = getLegalConsultationCase();
    const legalCaseTitle = legalCase ? getLegalCaseLabel(legalCase) : legalMeetingCaseTitle;
    const actionHints = notesForReport
      .filter(note => /(todo|action|next|follow|owner|deadline|需要|安排|确认|推进|负责|下周|明天|今天|完成|决定|风险|问题|证据|材料|开庭|上诉|法院|法官)/i.test(note.text))
      .slice(-8)
      .map(note => `- [${formatMeetingTime(note.time)}] ${formatMeetingNoteForExport(note)}`);
    if (legalCaseTitle) {
      return [
        uiMessage('desktop-ui.lumi-legal-consultation-memo.10af7cc379', (lang === 'zh') ? 'zh' : 'en'),
        '',
        `${uiMessage('desktop-ui.case.8a53cf13fb', (lang === 'zh') ? 'zh' : 'en')}: ${legalCaseTitle}`,
        `${uiMessage('desktop-ui.started.364ae4adf2', (lang === 'zh') ? 'zh' : 'en')}: ${started}`,
        `${uiMessage('desktop-ui.transcript-items.8cb25feb7a', (lang === 'zh') ? 'zh' : 'en')}: ${notesForReport.length}`,
        '',
        `## ${uiMessage('desktop-ui.consultation-summary.5f868bd7fc', (lang === 'zh') ? 'zh' : 'en')}`,
        notesForReport.length > 0
          ? (formatUiMessage('desktop-ui.captured-value0-transcript-items-llm.bcf7f95e8c', { value0: notesForReport.length }, (lang === 'zh') ? 'zh' : 'en'))
          : (uiMessage('desktop-ui.no-transcript-was-captured-for.97f574a507', (lang === 'zh') ? 'zh' : 'en')),
        '',
        `## ${uiMessage('desktop-ui.fact-summary.9a77b99032', (lang === 'zh') ? 'zh' : 'en')}`,
        ...(notesForReport.slice(-6).map(note => `- ${formatMeetingNoteForExport(note)}`)),
        ...(notesForReport.length === 0 ? [`- ${uiMessage('desktop-ui.no-fact-summary-yet.d293f70162', (lang === 'zh') ? 'zh' : 'en')}`] : []),
        '',
        `## ${uiMessage('desktop-ui.issues.f9911a3802', (lang === 'zh') ? 'zh' : 'en')}`,
        `- ${uiMessage('desktop-ui.counsel-should-confirm-issues-against.7df3dafccd', (lang === 'zh') ? 'zh' : 'en')}`,
        '',
        `## ${uiMessage('desktop-ui.missing-materials.ad6cf1dcaa', (lang === 'zh') ? 'zh' : 'en')}`,
        ...(actionHints.length > 0 ? actionHints : [`- ${uiMessage('desktop-ui.no-clear-missing-materials-detected.b86e0b077d', (lang === 'zh') ? 'zh' : 'en')}`]),
        '',
        `## ${uiMessage('desktop-ui.next-steps.cfcab769f5', (lang === 'zh') ? 'zh' : 'en')}`,
        `- ${uiMessage('desktop-ui.review-the-transcript-and-add.1176eea1c1', (lang === 'zh') ? 'zh' : 'en')}`,
        '',
        `## ${uiMessage('desktop-ui.safety-boundary.0f86bb1e83', (lang === 'zh') ? 'zh' : 'en')}`,
        `- ${uiMessage('desktop-ui.this-memo-assists-legal-analysis.678ef98abe', (lang === 'zh') ? 'zh' : 'en')}`,
      ].join('\n');
    }
    return [
      uiMessage('desktop-ui.lumi-meeting-report.8f1af8ddfd', (lang === 'zh') ? 'zh' : 'en'),
      '',
      `${uiMessage('desktop-ui.started.364ae4adf2', (lang === 'zh') ? 'zh' : 'en')}: ${started}`,
      `${uiMessage('desktop-ui.transcript-items.8cb25feb7a', (lang === 'zh') ? 'zh' : 'en')}: ${notesForReport.length}`,
      '',
      `## ${uiMessage('desktop-ui.summary.6a1255c05e', (lang === 'zh') ? 'zh' : 'en')}`,
      notesForReport.length > 0
        ? (formatUiMessage('desktop-ui.captured-value0-transcript-items-llm.2d05f10a79', { value0: notesForReport.length }, (lang === 'zh') ? 'zh' : 'en'))
        : (uiMessage('desktop-ui.no-transcript-was-captured-for.2e5c4be8f2', (lang === 'zh') ? 'zh' : 'en')),
      '',
      `## ${uiMessage('desktop-ui.action-decision-signals.c44c197db8', (lang === 'zh') ? 'zh' : 'en')}`,
      ...(actionHints.length > 0 ? actionHints : [`- ${uiMessage('desktop-ui.no-clear-action-or-decision.0c5b66381b', (lang === 'zh') ? 'zh' : 'en')}`]),
      '',
      `## ${uiMessage('desktop-ui.suggestion.2ed069fe41', (lang === 'zh') ? 'zh' : 'en')}`,
      `- ${uiMessage('desktop-ui.review-the-transcript-manually-and.78769e1374', (lang === 'zh') ? 'zh' : 'en')}`,
    ].join('\n');
  }, [formatMeetingNoteForExport, formatMeetingTime, lang, legalMeetingCaseTitle, meetingNotes, meetingStartedAt]);

  const analyzeMeetingNotes = useCallback(async (endedAt = Date.now(), notesOverride?: MeetingNote[], identity = meetingIdentityRef.current) => {
    const isCurrent = () => meetingIdentityRef.current === identity;
    if (!isCurrent()) return "";
    const notesForAnalysis = notesOverride || meetingNotes;
    if (notesForAnalysis.length === 0) {
      const fallback = buildFallbackMeetingReport(notesForAnalysis);
      setMeetingReport(fallback);
      localStorage.setItem(meetingStorageKeys.report, fallback);
      toast.info(uiMessage('desktop-ui.no-transcript-captured-generated-an.b6e7d4d221', (lang === 'zh') ? 'zh' : 'en'));
      return fallback;
    }

    setMeetingReportGenerating(true);
    try {
      const legalCase = getLegalConsultationCase();
      const legalCaseId = legalCase?.id || getLegalConsultationCaseId();
      const workLegalScope = workDomain === 'work' && Boolean(orgConnection?.connected && orgConnection?.orgId);
      const legalCaseTitle = legalCase ? getLegalCaseLabel(legalCase) : legalMeetingCaseTitle;
      const legalCaseForAnalysis = legalCaseTitle ? {
        id: legalCaseId,
        title: legalCase?.title || legalCaseTitle,
        caseNumber: legalCase?.caseNumber || '',
        party: legalCase?.party || '',
        cause: legalCase?.cause || '',
        court: legalCase?.court || '',
        judge: legalCase?.judge || '',
        stage: legalCase?.stage || '',
        notes: legalCase?.notes || '',
        domain: workDomain,
        orgId: workLegalScope ? orgConnection?.orgId : '',
      } : null;
      const res = await fetch('/api/meeting/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          provider: aiConfig?.provider || 'gemini',
          model: aiConfig?.model,
          notes: notesForAnalysis,
          startedAt: meetingStartedAt,
          endedAt,
          language: lang,
          purpose: legalCaseForAnalysis ? 'legal_consultation' : 'meeting',
          domain: workLegalScope ? 'work' : 'personal',
          orgId: workLegalScope ? orgConnection?.orgId : undefined,
          legalCase: legalCaseForAnalysis || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!isCurrent()) return '';
      if (!res.ok) throw new Error(data.error || 'Failed to analyze meeting');
      const report = String(data.report || '').trim() || buildFallbackMeetingReport(notesForAnalysis);
      setMeetingReport(report);
      localStorage.setItem(meetingStorageKeys.report, report);
      if (data.legalCaseArchived && workLegalScope && legalCaseId && notesForAnalysis.length > 0) {
        const lastNote = notesForAnalysis[notesForAnalysis.length - 1];
        const archiveKey = `${legalCaseId}:${meetingStartedAt || ''}:${lastNote?.id || notesForAnalysis.length}`;
        lastLegalMeetingArchiveRef.current = archiveKey;
        clearLegalConsultationCaseId();
        setLegalMeetingCaseTitle('');
        window.dispatchEvent(new CustomEvent('lumi:org-legal-cases-changed'));
      }
      toast.success(uiMessage('desktop-ui.lumi-generated-the-meeting-report.ebfd03daff', (lang === 'zh') ? 'zh' : 'en'));
      return report;
    } catch (err: any) {
      if (!isCurrent()) return '';
      const fallback = buildFallbackMeetingReport(notesForAnalysis);
      setMeetingReport(fallback);
      localStorage.setItem(meetingStorageKeys.report, fallback);
      toast.error(err?.message || (uiMessage('desktop-ui.meeting-analysis-failed-generated-a.2106efcb98', (lang === 'zh') ? 'zh' : 'en')));
      return fallback;
    } finally {
      if (isCurrent()) setMeetingReportGenerating(false);
    }
  }, [aiConfig?.model, aiConfig?.provider, buildFallbackMeetingReport, lang, lastLegalMeetingArchiveRef, legalMeetingCaseTitle, meetingIdentityRef, meetingNotes, meetingStartedAt, meetingStorageKeys.report, orgConnection?.connected, orgConnection?.orgId, setLegalMeetingCaseTitle, setMeetingReport, setMeetingReportGenerating, workDomain]);

  const archiveLegalMeetingReport = useCallback(async (report: string, endedAt: number, notesOverride?: MeetingNote[]) => {
    if (!isLegalCaseAccount(user?.uid)) return;
    const notesForArchive = notesOverride || meetingNotes;
    const consultationCaseId = getLegalConsultationCaseId();
    if (!consultationCaseId || notesForArchive.length === 0) return;
    const lastNote = notesForArchive[notesForArchive.length - 1];
    const archiveKey = `${consultationCaseId}:${meetingStartedAt || ''}:${lastNote?.id || notesForArchive.length}`;
    if (lastLegalMeetingArchiveRef.current === archiveKey) return;

    if (workDomain === 'work' && orgConnection?.connected) {
      const started = meetingStartedAt ? new Date(meetingStartedAt) : new Date(endedAt);
      const meetingCopy = desktopWorkflowCopy(lang).legalMeeting;
      const transcript = notesForArchive
        .map(note => `- [${formatMeetingTime(note.time)}] ${formatMeetingNoteForExport(note)}`)
        .join('\n');
      const content = [
        `# ${meetingCopy.title} ${started.toLocaleString()}`,
        '',
        `## ${meetingCopy.lumiSummary}`,
        '',
        report,
        '',
        `## ${meetingCopy.rawTranscript}`,
        '',
        transcript,
        '',
        `## ${meetingCopy.safetyBoundary}`,
        '',
        meetingCopy.boundaryText,
      ].join('\n');
      try {
        const res = await fetch(`/api/org/legal/cases/${encodeURIComponent(consultationCaseId)}/materials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            type: 'consultation',
            title: `${meetingCopy.title} ${started.toLocaleString()}`,
            content,
            source: 'meeting',
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to archive consultation');
        if (!isLegalCaseAccount(user?.uid)) return;
        lastLegalMeetingArchiveRef.current = archiveKey;
        clearLegalConsultationCaseId();
        setLegalMeetingCaseTitle('');
        window.dispatchEvent(new CustomEvent('lumi:org-legal-cases-changed'));
        toast.success(uiMessage('desktop-ui.consultation-archived-to-organization-case.0f5a7a5269', (lang === 'zh') ? 'zh' : 'en'));
        return;
      } catch (err: any) {
        toast.error(err?.message || (uiMessage('desktop-ui.failed-to-archive-consultation-to.7fac8fb2e5', (lang === 'zh') ? 'zh' : 'en')));
        return;
      }
    }

    const archived = archiveLegalMeetingToConsultationCase({
      report,
      notes: notesForArchive,
      startedAt: meetingStartedAt,
      endedAt,
    });
    if (!archived) {
      toast.error(uiMessage('desktop-ui.failed-to-archive-consultation-to.3a4ddc3b05', (lang === 'zh') ? 'zh' : 'en'));
      return;
    }
    lastLegalMeetingArchiveRef.current = archiveKey;
    setLegalMeetingCaseTitle('');
    toast.success(formatUiMessage('desktop-ui.consultation-archived-to-case-value0.213430958c', { value0: getLegalCaseLabel(archived.caseFile) }, (lang === 'zh') ? 'zh' : 'en'));
  }, [user?.uid, meetingNotes, meetingStartedAt, lastLegalMeetingArchiveRef, workDomain, orgConnection?.connected, setLegalMeetingCaseTitle, lang, formatMeetingTime, formatMeetingNoteForExport]);

  const endMeetingAndReport = useCallback(async () => {
    const identity = { ...meetingIdentityRef.current, refinementId: crypto.randomUUID() };
    meetingIdentityRef.current = identity;
    const endedAt = Date.now();
    setMeetingReportGenerating(true);
    const refinementPromise = waitForMeetingRefinement(identity);
    stopMeetingAudio({ refineTranscript: true, refinementId: identity.refinementId });
    setMeetingNotesOpen(true);
    const refinedNotes = await refinementPromise;
    if (meetingIdentityRef.current !== identity) return;
    const report = await analyzeMeetingNotes(endedAt, refinedNotes || undefined, identity);
    if (meetingIdentityRef.current !== identity) return;
    await archiveLegalMeetingReport(report, endedAt, refinedNotes || undefined);
  }, [analyzeMeetingNotes, archiveLegalMeetingReport, meetingIdentityRef, setMeetingNotesOpen, setMeetingReportGenerating, stopMeetingAudio, waitForMeetingRefinement]);

  const endVoiceCallFromUI = useCallback(() => {
    if (operationMode === 'meeting') {
      void endMeetingAndReport();
      return;
    }
    endCall();
  }, [endCall, endMeetingAndReport, operationMode]);

  const pauseMeetingCapture = useCallback(() => {
    setMeetingPaused(true);
    meetingVoiceActiveRef.current = false;
    meetingStartAttemptRef.current = 0;
    if (callState !== 'idle') endCall({ preserveMeeting: true });
    toast.success(uiMessage('desktop-ui.meeting-capture-paused.01ffd43760', (lang === 'zh') ? 'zh' : 'en'));
  }, [callState, endCall, lang, meetingStartAttemptRef, meetingVoiceActiveRef, setMeetingPaused]);

  const resumeMeetingCapture = useCallback(() => {
    meetingStartAttemptRef.current = 0;
    setMeetingPaused(false);
    if (operationMode !== 'meeting') setOperationMode('meeting');
    setMeetingNotesOpen(true);
    toast.success(uiMessage('desktop-ui.meeting-capture-resumed.1fe9ed28f8', (lang === 'zh') ? 'zh' : 'en'));
  }, [lang, meetingStartAttemptRef, operationMode, setMeetingNotesOpen, setMeetingPaused, setOperationMode]);

  const toggleMeetingCapturePaused = useCallback(() => {
    if (meetingPaused) {
      resumeMeetingCapture();
      return;
    }
    pauseMeetingCapture();
  }, [meetingPaused, pauseMeetingCapture, resumeMeetingCapture]);

  const copyMeetingNotes = useCallback(async () => {
    if (meetingNotes.length === 0) {
      toast.info(uiMessage('desktop-ui.no-meeting-notes-yet.8b36e2125c', (lang === 'zh') ? 'zh' : 'en'));
      return;
    }
    try {
      await navigator.clipboard.writeText(buildMeetingMarkdown());
      toast.success(uiMessage('desktop-ui.meeting-notes-copied.57d4f4a1c3', (lang === 'zh') ? 'zh' : 'en'));
    } catch (err: any) {
      toast.error(err?.message || (uiMessage('desktop-ui.failed-to-copy-notes.1c8b4242e3', (lang === 'zh') ? 'zh' : 'en')));
    }
  }, [buildMeetingMarkdown, lang, meetingNotes.length]);

  const downloadMeetingNotes = useCallback(() => {
    if (meetingNotes.length === 0) {
      toast.info(uiMessage('desktop-ui.no-meeting-notes-yet.8b36e2125c', (lang === 'zh') ? 'zh' : 'en'));
      return;
    }
    const blob = new Blob([buildMeetingMarkdown()], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const stamp = new Date(meetingStartedAt || Date.now()).toISOString().replace(/[:.]/g, '-');
    anchor.href = url;
    anchor.download = `lumi-meeting-${stamp}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast.success(uiMessage('desktop-ui.meeting-notes-exported.27f3f8fb53', (lang === 'zh') ? 'zh' : 'en'));
  }, [buildMeetingMarkdown, lang, meetingNotes.length, meetingStartedAt]);

  const clearMeetingNotes = useCallback(() => {
    renewMeetingIdentity();
    const now = Date.now();
    setMeetingNotes([]);
    setMeetingSpeakerCount(0);
    setMeetingReport('');
    setMeetingStartedAt(now);
    localStorage.setItem(meetingStorageKeys.notes, '[]');
    localStorage.removeItem(meetingStorageKeys.report);
    localStorage.setItem(meetingStorageKeys.startedAt, String(now));
    lastMeetingTranscriptRef.current = { text: '', at: 0, speakerKey: '' };
    lastLegalMeetingArchiveRef.current = '';
    toast.success(uiMessage('desktop-ui.meeting-notes-cleared.935a6beea8', (lang === 'zh') ? 'zh' : 'en'));
  }, [lang, lastLegalMeetingArchiveRef, lastMeetingTranscriptRef, meetingStorageKeys.notes, meetingStorageKeys.report, meetingStorageKeys.startedAt, renewMeetingIdentity, setMeetingNotes, setMeetingReport, setMeetingSpeakerCount, setMeetingStartedAt]);

  const requestOperationModeChange = useCallback((nextMode: OperationMode) => {
    if (nextMode === operationMode) return;
    if (nextMode === 'meeting') {
      setPendingOperationMode(nextMode);
      return;
    }
    setOperationMode(nextMode);
  }, [operationMode, setOperationMode, setPendingOperationMode]);

  const confirmOperationModeChange = useCallback(() => {
    if (!pendingOperationMode) return;
    setOperationMode(pendingOperationMode);
    if (pendingOperationMode === 'meeting') {
      if (meetingIdentityRef.current.refinementId) resetMeetingCapture();
      setMeetingPaused(false);
      setMeetingNotesOpen(true);
    }
    setPendingOperationMode(null);
  }, [meetingIdentityRef, pendingOperationMode, resetMeetingCapture, setMeetingNotesOpen, setMeetingPaused, setOperationMode, setPendingOperationMode]);

  type MeetingModeRequestDetail = {
    confirmed?: boolean;
    resetNotes?: boolean;
    legalCaseId?: string;
    legalCaseTitle?: string;
    respond?: (payload?: unknown) => void;
    reject?: (message: string) => void;
  };

  const openMeetingMode = useCallback((detail: MeetingModeRequestDetail = {}) => {
    try {
      if (detail.resetNotes || meetingIdentityRef.current.refinementId) resetMeetingCapture();
      if (detail.legalCaseId) setLegalConsultationCaseId(String(detail.legalCaseId));
      if (detail.legalCaseTitle) setLegalMeetingCaseTitle(String(detail.legalCaseTitle));
      else if (!getLegalConsultationCaseId()) setLegalMeetingCaseTitle('');

      if (detail.confirmed) {
        setMeetingPaused(false);
        setOperationMode('meeting');
        setMeetingNotesOpen(true);
        detail.respond?.({ ok: true, action: 'start_meeting_mode', mode: 'meeting' });
        return;
      }

      if (operationMode === 'meeting') {
        setMeetingNotesOpen(true);
        detail.respond?.({ ok: true, action: 'open_meeting_notes', mode: 'meeting' });
        return;
      }

      requestOperationModeChange('meeting');
    } catch (err: any) {
      detail.reject?.(err?.message || String(err));
    }
  }, [meetingIdentityRef, operationMode, requestOperationModeChange, resetMeetingCapture, setLegalMeetingCaseTitle, setMeetingNotesOpen, setMeetingPaused, setOperationMode]);

  useEffect(() => {
    const handler = (event: Event) => {
      openMeetingMode(((event as CustomEvent).detail || {}) as MeetingModeRequestDetail);
    };
    window.addEventListener('lumi:request-meeting-mode', handler);
    return () => window.removeEventListener('lumi:request-meeting-mode', handler);
  }, [openMeetingMode]);

  const openMeetingModeWithConfirm = useCallback(() => {
    if (operationMode === 'meeting') {
      setMeetingNotesOpen(true);
      return;
    }
    requestOperationModeChange('meeting');
  }, [operationMode, requestOperationModeChange, setMeetingNotesOpen]);
return { endMeetingAndReport, endVoiceCallFromUI, openMeetingModeWithConfirm, copyMeetingNotes, downloadMeetingNotes, formatMeetingTime, toggleMeetingCapturePaused, clearMeetingNotes, confirmOperationModeChange };
}
