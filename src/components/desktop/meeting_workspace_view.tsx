import { X, Play, Pause, Copy, Download, FolderOpen, FileText, Plus, Mic, Loader2 } from 'lucide-react';
import { uiMessage } from '../../i18n/uiMessages';
import { desktopWorkflowCopy } from '../../i18n/locales/desktopWorkflows';
import type { DesktopShellViewInput } from './DesktopShellView';

type MeetingWorkspaceProps = Pick<DesktopShellViewInput,
  'meetingNotesOpen' | 'resolvedAppearanceMode' | 'operationMode' | 'meetingPaused' | 'callState' | 'callError' | 't' | 'lang' |
  'legalMeetingCaseTitle' | 'copyMeetingNotes' | 'downloadMeetingNotes' | 'setMeetingNotesOpen' | 'meetingNotes' |
  'meetingSpeakerCount' | 'meetingReportGenerating' | 'meetingReport' | 'meetingReportError' | 'formatMeetingTime' |
  'meetingNoteHasSpeakerInfo' | 'meetingSpeakerLabel' | 'toggleMeetingCapturePaused' | 'endMeetingAndReport' |
  'clearMeetingNotes' | 'meetingHistory' | 'meetingRecordId' | 'meetingHistoryReadOnly' | 'selectMeetingHistoryRecord' | 'importMeetingHistoryFile' | 'meetingExportPath' | 'meetingExportBusy' | 'meetingExportError' | 'openMeetingExport'>;

export function renderMeetingWorkspace(props: MeetingWorkspaceProps) {
  const { meetingNotesOpen, resolvedAppearanceMode, operationMode, meetingPaused, callState, callError, t, lang,
    legalMeetingCaseTitle, copyMeetingNotes, downloadMeetingNotes, setMeetingNotesOpen, meetingNotes,
    meetingSpeakerCount, meetingReportGenerating, meetingReport, meetingReportError, formatMeetingTime, meetingNoteHasSpeakerInfo,
    meetingSpeakerLabel, toggleMeetingCapturePaused, endMeetingAndReport, clearMeetingNotes,
    meetingExportPath, meetingExportBusy, meetingExportError, openMeetingExport, meetingHistory = [], meetingRecordId = '', meetingHistoryReadOnly = false, selectMeetingHistoryRecord, importMeetingHistoryFile } = props;
  if (!meetingNotesOpen) return null;
  const c = desktopWorkflowCopy(lang).meetingWorkspace;
  const light = resolvedAppearanceMode === 'light';
  const active = operationMode === 'meeting' && !meetingPaused;
  const voiceLabel = { idle: c.connecting, connecting: c.connecting, listening: c.recording, thinking: t.thinking, speaking: t.speaking, passive: t.passive, queued: uiMessage('desktop-ui.queued.bb6e139347', lang) }[callState];
  const state = meetingHistoryReadOnly ? c.historyView : meetingReportGenerating ? c.organizing : callError && operationMode === 'meeting' ? c.captureFailed : active ? voiceLabel
    : meetingReportError ? c.noSummary : meetingReport ? c.completed : meetingNotes.length ? c.paused : c.ready;
  const panel = light ? 'border-[var(--border)] bg-[var(--card)] shadow-sm' : 'border-slate-700/70 bg-slate-900/90';
  const muted = light ? 'text-slate-600' : 'text-slate-400';
  const button = 'inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ' + (light ? 'border-[var(--border)] bg-[var(--card)] hover:bg-[var(--secondary)]' : 'border-slate-600 bg-slate-800 hover:bg-slate-700');
  const notes = [...meetingNotes].sort((a, b) => a.time - b.time);
  const historyBusy = active || meetingReportGenerating || meetingExportBusy;
  return <div role="dialog" aria-modal="true" aria-label={c.title} data-meeting-workspace data-theme={light ? 'light' : 'dark'} className={'fixed inset-0 z-[100000] pointer-events-auto flex flex-col overflow-y-auto p-4 md:p-6 ' + (light ? 'bg-[var(--background)] text-[var(--foreground)]' : 'bg-slate-950 text-slate-100')}>
    <header className="mx-auto mb-4 flex w-full max-w-[1600px] shrink-0 flex-wrap items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-3"><Mic size={22} className={light ? 'text-teal-700' : 'text-teal-300'} /><h2 className="text-xl font-semibold">{c.title}</h2><span role="status" className={'rounded-full px-3 py-1 text-xs font-semibold ' + (active ? light ? 'bg-rose-100 text-rose-800' : 'bg-rose-400/15 text-rose-200' : light ? 'bg-teal-100 text-teal-800' : 'bg-teal-400/15 text-teal-200')}>{state}</span></div>
        <p className={'mt-2 text-sm ' + muted}>{meetingHistoryReadOnly ? c.historyHint : active ? c.recordingHint : c.readyHint}</p>
        {callError && operationMode === 'meeting' && <p role="alert" className={'mt-2 text-sm ' + (light ? 'text-red-700' : 'text-red-300')}>{callError}</p>}
      </div>
      <button type="button" className={button} onClick={() => setMeetingNotesOpen(false)}><X size={16} />{c.close}</button>
    </header>
    <div className="mx-auto mb-4 flex w-full max-w-[1600px] shrink-0 flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 text-xs font-medium">{c.history}
        <select aria-label={c.history} value={meetingHistory.some(record => record.id === meetingRecordId) ? meetingRecordId : ''} disabled={historyBusy} onChange={event => selectMeetingHistoryRecord(event.target.value)} className={'mt-1 block w-full rounded-xl border p-2.5 text-sm ' + (light ? 'border-[var(--border)] bg-[var(--popover)]' : 'border-slate-600 bg-slate-900')}>
          {!meetingHistory.some(record => record.id === meetingRecordId) && <option value="">{c.historyCurrent}</option>}
          {meetingHistory.map(record => <option key={record.id} value={record.id}>{record.startedAt ? new Date(record.startedAt).toLocaleString() : c.historyCurrent} · {record.caseTitle || record.notes[0]?.text.slice(0, 24) || c.ready} · {record.notes.length} {c.entries}</option>)}
        </select>
      </label>
      <label className={button + ' relative focus-within:outline focus-within:outline-2 focus-within:outline-teal-500'}>{c.historyImport}<input type="file" accept=".json,application/json" aria-label={c.historyImport} disabled={historyBusy} className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importMeetingHistoryFile(file); }} /></label>
    </div>
    <main className="mx-auto grid min-h-0 w-full max-w-[1600px] flex-1 gap-4 overflow-y-auto lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)] lg:overflow-hidden">
      <section aria-label={c.transcript} className={'flex h-[52vh] min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border lg:h-full ' + panel}>
        <div className={'shrink-0 border-b p-4 ' + (light ? 'border-slate-200' : 'border-slate-700')}>
          <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{c.transcript}</h3><span className={'text-xs ' + muted}>{notes.length} {c.entries} · {meetingSpeakerCount} {c.speakers}</span></div>
          <p className={'mt-2 text-xs leading-5 ' + muted}>{c.transcriptHint}</p>
        </div>
        <ol aria-label={c.transcript} className="custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-4 md:p-5">
          {notes.length ? notes.map(note => <li key={note.id} className={'border-l-2 pl-4 ' + (light ? 'border-teal-300' : 'border-teal-700')}>
            <div className={'mb-1 flex flex-wrap gap-3 text-xs ' + muted}><time>{formatMeetingTime(note.time)}</time>{meetingNoteHasSpeakerInfo(note) && <span>{meetingSpeakerLabel(note)}</span>}</div>
            <p className="whitespace-pre-wrap break-words text-sm leading-7">{note.text}</p>
          </li>) : <li className={'py-12 text-center text-sm ' + muted}>{c.emptyTranscript}</li>}
        </ol>
      </section>
      <section aria-label={c.summary} className={'flex h-[52vh] min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border lg:h-full ' + panel}>
        <div className={'shrink-0 border-b p-4 ' + (light ? 'border-slate-200' : 'border-slate-700')}><h3 className="font-semibold">{c.summary}</h3><p className={'mt-2 text-xs leading-5 ' + muted}>{c.summaryHint}</p></div>
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
          {meetingReportGenerating && <p role="status" className="mb-4 flex items-center gap-2 text-sm"><Loader2 size={16} className="animate-spin" />{c.organizing}</p>}
          {meetingReportError && <p role="alert" className={'mb-4 text-sm leading-6 ' + (light ? 'text-red-700' : 'text-red-300')}>{meetingReportError}</p>}
          {meetingReport ? <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7">{meetingReport}</pre> : <p className={'py-12 text-center text-sm ' + muted}>{c.emptySummary}</p>}
        </div>
      </section>
    </main>
    <footer className="mx-auto mt-4 w-full max-w-[1600px] shrink-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} onClick={toggleMeetingCapturePaused} disabled={meetingHistoryReadOnly || meetingReportGenerating}>{active ? <Pause size={16} /> : <Play size={16} />}{active ? c.pause : notes.length ? c.resume : c.start}</button>
          <button type="button" onClick={() => void endMeetingAndReport()} disabled={meetingHistoryReadOnly || meetingReportGenerating || (!notes.length && !active) || Boolean(meetingReport && !active)} className="inline-flex items-center gap-2 rounded-xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-40"><FileText size={16} />{meetingReportGenerating ? c.organizing : c.finish}</button>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} onClick={() => void copyMeetingNotes()} disabled={!notes.length}><Copy size={15} />{c.copy}</button>
          <button type="button" className={button} onClick={() => void downloadMeetingNotes()} disabled={!notes.length || meetingExportBusy}><Download size={15} />{meetingExportBusy ? c.saving : c.export}</button>
          <button type="button" className={button} onClick={clearMeetingNotes} disabled={historyBusy}><Plus size={15} />{c.newRecord}</button>
        </div>
      </div>
      <div className={'text-xs leading-5 ' + muted}>
        <p>{c.exportHint}</p>
        {meetingExportPath && <div className="mt-2 flex flex-wrap items-center gap-2"><p className="min-w-0 flex-1 break-all">{c.savedAt}：{meetingExportPath}</p><button type="button" className={button} onClick={() => void openMeetingExport(false)}><FileText size={14} />{c.openFile}</button><button type="button" className={button} onClick={() => void openMeetingExport(true)}><FolderOpen size={14} />{c.openFolder}</button></div>}
        {meetingExportError && <p role="alert" className={light ? 'text-red-700' : 'text-red-300'}>{meetingExportError}</p>}
      </div>
    </footer>
  </div>;
}
