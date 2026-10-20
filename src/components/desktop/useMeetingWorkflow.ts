

import { type MeetingNote } from "./runtime_state";

import React, { useEffect, useCallback, useState, useRef } from 'react';
import { isTauriRuntime } from '@/services/apiBridge';

import { toast } from 'sonner';

import { useVoiceCall } from '@/hooks/useVoiceCall';
import { useApp, type OperationMode } from '@/contexts/AppContext';


import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import { desktopWorkflowCopy } from "../../i18n/locales/desktopWorkflows";

type useMeetingWorkflowInput = {
meetingStartedAt: number | null;
legalMeetingCaseTitle: string;
meetingReport: string;
meetingReportGenerating: boolean;
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
createMeetingRecord: (caseInfo?: { id: string; title: string }) => boolean;
selectMeetingRecord: (id: string) => boolean;
importMeetingRecords: (text: string) => boolean;
meetingHistoryReadOnly: boolean;
meetingRecordId: string;
meetingNotesOpen: boolean;
setPendingOperationMode: React.Dispatch<React.SetStateAction<OperationMode | null>>;
pendingOperationMode: OperationMode | null;
};
export function useMeetingWorkflow({ meetingStartedAt, legalMeetingCaseTitle, meetingReport, meetingReportGenerating, meetingNotes, formatMeetingNoteForExport, lang, meetingIdentityRef, setMeetingReport, meetingStorageKeys, setMeetingReportGenerating, workDomain, orgConnection, aiConfig, waitForMeetingRefinement, stopMeetingAudio, setMeetingNotesOpen, operationMode, endCall, setMeetingPaused, meetingVoiceActiveRef, meetingStartAttemptRef, callState, setOperationMode, meetingPaused, renewMeetingIdentity, createMeetingRecord, selectMeetingRecord, importMeetingRecords, meetingHistoryReadOnly, meetingRecordId, meetingNotesOpen, setPendingOperationMode, pendingOperationMode }: useMeetingWorkflowInput) {
  const copy = desktopWorkflowCopy(lang).meetingWorkspace;
  const [meetingReportError, setMeetingReportError] = useState('');
  const analysisAttempt = useRef<{identity: typeof meetingIdentityRef.current; controller: AbortController} | null>(null);
  useEffect(() => {
    const cancel = () => { analysisAttempt.current?.controller.abort(); analysisAttempt.current = null; };
    cancel(); setMeetingReportError('');
    return cancel;
  }, [meetingRecordId, meetingIdentityRef.current.scope]);
  const [meetingExport, setMeetingExport] = useState<{ scope: string; meetingId: string; path: string } | null>(null);
  const [meetingExportBusy, setMeetingExportBusy] = useState(false);
  const [meetingExportError, setMeetingExportError] = useState('');
  const exportAttempt = useRef<object | null>(null);
  const exportIdentity = meetingIdentityRef.current;
  const meetingExportPath = meetingExport?.scope === exportIdentity.scope && meetingExport.meetingId === exportIdentity.meetingId ? meetingExport.path : '';
  useEffect(() => { exportAttempt.current = null; setMeetingExportBusy(false); setMeetingExportError(''); }, [meetingStorageKeys.identity, exportIdentity.scope, exportIdentity.meetingId]);

  const formatMeetingTime = useCallback((value: number) => {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }, []);

  const buildMeetingMarkdown = useCallback(() => {
    const started = meetingStartedAt ? new Date(meetingStartedAt) : new Date();
    const lines = [
      `# Lumi Meeting Notes`,
      '',
      `Session opened (includes pauses): ${started.toLocaleString()}`,
      ...(legalMeetingCaseTitle ? [`Case: ${legalMeetingCaseTitle}`] : []),
      '',
      ...(meetingReport ? ['## Lumi Report', '', meetingReport, ''] : []),
      '## Transcript',
      '',
      ...[...meetingNotes].sort((a, b) => a.time - b.time).map(note => `- [${formatMeetingTime(note.time)}] ${formatMeetingNoteForExport(note)}`),
      '',
    ];
    return lines.join('\n');
  }, [formatMeetingNoteForExport, formatMeetingTime, legalMeetingCaseTitle, meetingNotes, meetingReport, meetingStartedAt]);

  const analyzeMeetingNotes = useCallback(async (endedAt = Date.now(), notesOverride?: MeetingNote[], identity = meetingIdentityRef.current) => {
    if (meetingIdentityRef.current !== identity || analysisAttempt.current) return "";
    const notesForAnalysis = notesOverride || meetingNotes;
    setMeetingReportError('');
    if (notesForAnalysis.length === 0) {
      setMeetingReportGenerating(false);
      setMeetingReport('');
      setMeetingReportError(copy.noTranscript);
      toast.info(copy.noTranscript);
      return '';
    }

    const attempt = { identity, controller: new AbortController() };
    analysisAttempt.current = attempt;
    const isCurrent = () => analysisAttempt.current === attempt && !attempt.controller.signal.aborted && meetingIdentityRef.current === identity;
    setMeetingReportGenerating(true);
    try {
      const workScope = workDomain === 'work' && Boolean(orgConnection?.connected && orgConnection?.orgId);
      const res = await fetch('/api/meeting/analyze', {
        signal: attempt.controller.signal,
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
          purpose: 'meeting',
          domain: workScope ? 'work' : 'personal',
          orgId: workScope ? orgConnection?.orgId : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!isCurrent()) return '';
      if (!res.ok) throw new Error(data.error || 'Failed to analyze meeting');
      const report = String(data.report || '').trim();
      if (!report) throw new Error('No report returned');
      setMeetingReport(report);
      toast.success(uiMessage('desktop-ui.lumi-generated-the-meeting-report.ebfd03daff', (lang === 'zh') ? 'zh' : 'en'));
      return report;
    } catch (err: any) {
      if (!isCurrent()) return '';
      const message = copy.analysisIncomplete(notesForAnalysis.length);
      setMeetingReport('');
      setMeetingReportError(message);
      toast.error(message);
      return '';
    } finally {
      const current = isCurrent();
      if (analysisAttempt.current === attempt) analysisAttempt.current = null;
      if (current) setMeetingReportGenerating(false);
    }
  }, [aiConfig?.model, aiConfig?.provider, copy, lang, meetingIdentityRef, meetingNotes, meetingStartedAt, orgConnection?.connected, orgConnection?.orgId, setMeetingReport, setMeetingReportGenerating, workDomain]);

  const endMeetingAndReport = useCallback(async () => {
    if (meetingHistoryReadOnly || (meetingReport && operationMode !== 'meeting')) return;
    const identity = { ...meetingIdentityRef.current, refinementId: crypto.randomUUID() };
    meetingIdentityRef.current = identity;
    const endedAt = Date.now();
    setMeetingReportGenerating(true);
    const refinementPromise = waitForMeetingRefinement(identity);
    stopMeetingAudio({ refineTranscript: true, refinementId: identity.refinementId });
    setMeetingNotesOpen(true);
    const refinedNotes = await refinementPromise;
    if (meetingIdentityRef.current !== identity) return;
    await analyzeMeetingNotes(endedAt, refinedNotes || undefined, identity);
  }, [analyzeMeetingNotes, meetingHistoryReadOnly, meetingIdentityRef, meetingReport, operationMode, setMeetingNotesOpen, setMeetingReportGenerating, stopMeetingAudio, waitForMeetingRefinement]);

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
    if (meetingIdentityRef.current.refinementId) renewMeetingIdentity();
    meetingStartAttemptRef.current = 0;
    setMeetingPaused(false);
    if (operationMode !== 'meeting') setOperationMode('meeting');
    setMeetingNotesOpen(true);
    toast.success(uiMessage('desktop-ui.meeting-capture-resumed.1fe9ed28f8', (lang === 'zh') ? 'zh' : 'en'));
  }, [lang, meetingIdentityRef, renewMeetingIdentity, meetingStartAttemptRef, operationMode, setMeetingNotesOpen, setMeetingPaused, setOperationMode]);

  const toggleMeetingCapturePaused = useCallback(() => {
    if (meetingHistoryReadOnly) return;
    if (meetingPaused || operationMode !== 'meeting') {
      resumeMeetingCapture();
      return;
    }
    pauseMeetingCapture();
  }, [meetingHistoryReadOnly, meetingPaused, operationMode, pauseMeetingCapture, resumeMeetingCapture]);

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

  const downloadMeetingNotes = useCallback(async () => {
    if (!meetingNotes.length || exportAttempt.current) return;
    const identity = { ...meetingIdentityRef.current };
    const attempt = {};
    exportAttempt.current = attempt;
    const isCurrent = () => exportAttempt.current === attempt && meetingIdentityRef.current.scope === identity.scope && meetingIdentityRef.current.meetingId === identity.meetingId;
    setMeetingExportBusy(true); setMeetingExportError('');
    const content = buildMeetingMarkdown();
    const stamp = new Date(meetingStartedAt || Date.now()).toISOString().replace(/[:.]/g, '-');
    const fileName = 'lumi-meeting-' + stamp + '-' + crypto.randomUUID().slice(0, 8) + '.md';
    try {
      if (isTauriRuntime()) {
        const { downloadDir, join } = await import('@tauri-apps/api/path');
        const { invoke } = await import('@tauri-apps/api/core');
        const path = await join(await downloadDir(), fileName);
        if (!isCurrent()) return;
        const result = await invoke<{ success: boolean; path: string; readBackMatched: boolean }>('write_text_file', { path, content, encoding: 'utf-8', overwritePolicy: 'fail_if_exists' });
        if (!result.success || !result.readBackMatched || !result.path) throw new Error(copy.exportFailed);
        if (isCurrent()) { setMeetingExport({ ...identity, path: result.path }); toast.success(copy.saved); }
      } else {
        const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
        const anchor = document.createElement('a');
        try { anchor.href = url; anchor.download = fileName; document.body.appendChild(anchor); anchor.click(); }
        finally { anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
        if (isCurrent()) toast.info(copy.browserDownload);
      }
    } catch {
      if (isCurrent()) { setMeetingExportError(copy.exportFailed); toast.error(copy.exportFailed); }
    } finally {
      if (isCurrent()) { exportAttempt.current = null; setMeetingExportBusy(false); }
    }
  }, [buildMeetingMarkdown, copy, meetingIdentityRef, meetingNotes.length, meetingStartedAt]);

  const openMeetingExport = useCallback(async (folder = false) => {
    if (!meetingExportPath) return;
    const identity = { ...meetingIdentityRef.current };
    setMeetingExportError('');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const { dirname } = await import('@tauri-apps/api/path');
      const target = folder ? await dirname(meetingExportPath) : meetingExportPath;
      if (meetingIdentityRef.current.scope !== identity.scope || meetingIdentityRef.current.meetingId !== identity.meetingId) return;
      const result = await invoke<{ success: boolean }>('open_item', { target });
      if (!result.success) throw new Error(copy.openFailed);
    } catch {
      if (meetingIdentityRef.current.scope === identity.scope && meetingIdentityRef.current.meetingId === identity.meetingId) setMeetingExportError(copy.openFailed);
    }
  }, [copy, meetingExportPath, meetingIdentityRef]);

  const clearMeetingNotes = useCallback(() => {
    if (meetingReportGenerating || meetingExportBusy || (operationMode === 'meeting' && !meetingPaused)) return;
    if (!window.confirm(copy.newConfirm) || !createMeetingRecord()) return;
    pauseMeetingCapture();
  }, [copy.newConfirm, createMeetingRecord, meetingExportBusy, meetingPaused, meetingReportGenerating, operationMode, pauseMeetingCapture]);

  const selectMeetingHistoryRecord = useCallback((id: string) => {
    if (meetingReportGenerating || meetingExportBusy || (operationMode === 'meeting' && !meetingPaused)) return;
    if (selectMeetingRecord(id)) { pauseMeetingCapture(); setMeetingNotesOpen(true); }
  }, [meetingExportBusy, meetingPaused, meetingReportGenerating, operationMode, pauseMeetingCapture, selectMeetingRecord, setMeetingNotesOpen]);

  const importMeetingHistoryFile = useCallback(async (file: File) => {
    if (meetingReportGenerating || meetingExportBusy || (operationMode === 'meeting' && !meetingPaused)) return;
    const identity = meetingIdentityRef.current;
    try {
      const text = await file.text();
      if (meetingIdentityRef.current !== identity) return;
      if (importMeetingRecords(text)) toast.success(copy.historyImported);
    } catch { if (meetingIdentityRef.current === identity) toast.error(copy.historyImportFailed); }
  }, [copy.historyImportFailed, copy.historyImported, importMeetingRecords, meetingExportBusy, meetingIdentityRef, meetingPaused, meetingReportGenerating, operationMode]);

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
    if (pendingOperationMode === 'meeting' && operationMode !== 'meeting' && callState !== 'idle') endCall();
    setOperationMode(pendingOperationMode);
    if (pendingOperationMode === 'meeting') {
      setMeetingPaused(true);
      setMeetingNotesOpen(true);
    }
    setPendingOperationMode(null);
  }, [callState, endCall, operationMode, pendingOperationMode, setMeetingNotesOpen, setMeetingPaused, setOperationMode, setPendingOperationMode]);

  type MeetingModeRequestDetail = {
    confirmed?: boolean;
    resetNotes?: boolean;
    respond?: (payload?: unknown) => void;
    reject?: (message: string) => void;
  };

  const openMeetingMode = useCallback(async (detail: MeetingModeRequestDetail = {}) => {
    try {
      let readOnlyView = meetingHistoryReadOnly;
      if (detail.resetNotes) {
        if (operationMode === 'meeting' && !meetingPaused) throw new Error(copy.finishBeforeNew);
        if (!createMeetingRecord()) throw new Error(copy.historyUpdateFailed);
        readOnlyView = false;
      }
      if (detail.confirmed) {
        if (operationMode !== 'meeting') {
          if (callState !== 'idle') endCall();
          setMeetingPaused(true);
        }
        setOperationMode('meeting');
        setMeetingNotesOpen(true);
        detail.respond?.({ ok: true, action: 'start_meeting_mode', mode: 'meeting', status: readOnlyView ? 'history' : 'ready' });
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
  }, [callState, copy.finishBeforeNew, copy.historyUpdateFailed, createMeetingRecord, endCall, meetingHistoryReadOnly, meetingPaused, operationMode, requestOperationModeChange, setMeetingNotesOpen, setMeetingPaused, setOperationMode]);

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
    openMeetingMode({ confirmed: true });
  }, [openMeetingMode, operationMode, setMeetingNotesOpen]);
return { meetingExportPath, meetingExportBusy, meetingExportError, openMeetingExport, endMeetingAndReport, endVoiceCallFromUI, openMeetingModeWithConfirm, copyMeetingNotes, downloadMeetingNotes, formatMeetingTime, toggleMeetingCapturePaused, clearMeetingNotes, selectMeetingHistoryRecord, importMeetingHistoryFile, meetingReportError, confirmOperationModeChange };
}
