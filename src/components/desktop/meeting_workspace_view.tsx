import { motion, AnimatePresence } from 'motion/react';
import { X, Play, Pause, Copy, Download } from 'lucide-react';
import { GlassCard } from "../SharedUI";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import type { DesktopShellViewInput } from './DesktopShellView';

export function renderMeetingWorkspace({ meetingNotesOpen, resolvedAppearanceMode, operationMode, meetingPaused, callState, t, lang, legalMeetingCaseTitle, copyMeetingNotes, downloadMeetingNotes, setMeetingNotesOpen, meetingNotes, meetingSpeakerCount, meetingStartedAt, time, meetingReportGenerating, meetingReport, formatMeetingTime, meetingNoteHasSpeakerInfo, meetingSpeakerLabel, toggleMeetingCapturePaused, endMeetingAndReport, clearMeetingNotes }: Pick<DesktopShellViewInput, "meetingNotesOpen" | "resolvedAppearanceMode" | "operationMode" | "meetingPaused" | "callState" | "t" | "lang" | "legalMeetingCaseTitle" | "copyMeetingNotes" | "downloadMeetingNotes" | "setMeetingNotesOpen" | "meetingNotes" | "meetingSpeakerCount" | "meetingStartedAt" | "time" | "meetingReportGenerating" | "meetingReport" | "formatMeetingTime" | "meetingNoteHasSpeakerInfo" | "meetingSpeakerLabel" | "toggleMeetingCapturePaused" | "endMeetingAndReport" | "clearMeetingNotes">) {
  return (
<AnimatePresence>
        {meetingNotesOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.25, 0.1, 0.25, 1] }}
            className={`fixed inset-0 z-[100000] pointer-events-auto overflow-hidden ${
              resolvedAppearanceMode === 'light' ? 'bg-[#f4f7f2] text-slate-900' : 'bg-[#020711] text-white'
            }`}
            style={{
              background: resolvedAppearanceMode === 'light'
                ? 'radial-gradient(circle at 16% 12%, rgba(16,185,129,0.10) 0%, transparent 30%), radial-gradient(circle at 82% 18%, rgba(59,130,246,0.08) 0%, transparent 32%), linear-gradient(145deg, #f8fbf5 0%, #eef5ef 46%, #e8eef1 100%)'
                : 'radial-gradient(circle at 16% 12%, rgba(34,211,238,0.22) 0%, transparent 30%), radial-gradient(circle at 82% 18%, rgba(56,189,248,0.13) 0%, transparent 32%), linear-gradient(145deg, #020711 0%, #03111c 46%, #010203 100%)',
            }}
          >
            <GlassCard
              hoverEffect={false}
              className="flex h-full w-full flex-col overflow-hidden rounded-none border-0 bg-transparent p-4 shadow-none backdrop-blur-2xl md:p-8"
            >
              <div className="flex shrink-0 items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${operationMode === 'meeting' && !meetingPaused && callState !== 'idle' ? 'bg-cyan-400 animate-pulse' : meetingPaused ? 'bg-amber-300' : 'bg-white/25'}`} />
                    <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/80">
                      {t.meetingMode || (uiMessage('desktop-ui.meeting-mode.59774a9431', (lang === 'zh') ? 'zh' : 'en'))}
                    </h3>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-white/45">
                    {meetingPaused
                      ? (uiMessage('desktop-ui.meeting-capture-paused-existing-notes.9184207c36', (lang === 'zh') ? 'zh' : 'en'))
                      : operationMode === 'meeting'
                      ? (uiMessage('desktop-ui.recording-speech-to-text-notes.d1c840bc80', (lang === 'zh') ? 'zh' : 'en'))
                      : (uiMessage('desktop-ui.meeting-notes-paused.dbdda568f0', (lang === 'zh') ? 'zh' : 'en'))}
                  </p>
                  {legalMeetingCaseTitle && (
                    <p className="mt-1 text-[11px] leading-relaxed text-cyan-200/70">
                      {formatUiMessage('desktop-ui.archiving-to-case-value0.df7656835b', { value0: legalMeetingCaseTitle }, (lang === 'zh') ? 'zh' : 'en')}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={copyMeetingNotes}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/45 transition-colors hover:bg-white/10 hover:text-white"
                    title={uiMessage('desktop-ui.copy-notes.61d380527a', (lang === 'zh') ? 'zh' : 'en')}
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    onClick={downloadMeetingNotes}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/45 transition-colors hover:bg-white/10 hover:text-white"
                    title={uiMessage('desktop-ui.export-markdown.7ef9dff097', (lang === 'zh') ? 'zh' : 'en')}
                  >
                    <Download size={14} />
                  </button>
                  <button
                    onClick={() => setMeetingNotesOpen(false)}
                    className="flex h-9 items-center justify-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 text-xs font-black uppercase tracking-[0.14em] text-cyan-100 transition-colors hover:bg-cyan-400/15"
                    aria-label={uiMessage('desktop-ui.exit-fullscreen-keep-recording.5b39c4c75a', (lang === 'zh') ? 'zh' : 'en')}
                    title={uiMessage('desktop-ui.exit-fullscreen-keep-recording.5b39c4c75a', (lang === 'zh') ? 'zh' : 'en')}
                  >
                    <X size={15} />
                    <span>{uiMessage('desktop-ui.exit.a32b11f87a', (lang === 'zh') ? 'zh' : 'en')}</span>
                  </button>
                </div>
              </div>

              <div className="mt-5 grid shrink-0 grid-cols-2 gap-2 text-center md:grid-cols-4 md:gap-3">
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{uiMessage('desktop-ui.state.91c2d4012c', (lang === 'zh') ? 'zh' : 'en')}</div>
                  <div className={`mt-1 text-xs font-bold ${meetingPaused ? 'text-amber-300' : 'text-cyan-300'}`}>
                    {meetingPaused ? 'Paused' : callState === 'idle' ? 'Idle' : callState}
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{uiMessage('desktop-ui.items.81a207be82', (lang === 'zh') ? 'zh' : 'en')}</div>
                  <div className="mt-1 text-xs font-bold text-white/75">{meetingNotes.length}</div>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{uiMessage('desktop-ui.speakers.28c4329526', (lang === 'zh') ? 'zh' : 'en')}</div>
                  <div className="mt-1 text-xs font-bold text-white/75">{meetingSpeakerCount || '-'}</div>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/30">{uiMessage('desktop-ui.time.8a72c3e2a2', (lang === 'zh') ? 'zh' : 'en')}</div>
                  <div className="mt-1 text-xs font-bold text-white/75">
                    {meetingStartedAt ? `${Math.max(0, Math.floor((time.getTime() - meetingStartedAt) / 60000))}m` : '0m'}
                  </div>
                </div>
              </div>

              <div className="mt-5 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 custom-scrollbar">
                {meetingReportGenerating && (
                  <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3 text-xs font-bold text-cyan-200">
                    {uiMessage('desktop-ui.lumi-is-preparing-the-meeting.b2bd78cdbc', (lang === 'zh') ? 'zh' : 'en')}
                  </div>
                )}
                {meetingReport && !meetingReportGenerating && (
                  <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3">
                    <div className="text-[10px] font-black uppercase tracking-widest text-cyan-300/80">
                      {uiMessage('desktop-ui.lumi-report.3edec8f8b6', (lang === 'zh') ? 'zh' : 'en')}
                    </div>
                    <pre className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-white/75 font-sans">{meetingReport}</pre>
                  </div>
                )}
                {meetingNotes.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-xs leading-relaxed text-white/35">
                    {uiMessage('desktop-ui.speech-captured-in-meeting-mode.4372ef7c18', (lang === 'zh') ? 'zh' : 'en')}
                  </div>
                ) : (
                  meetingNotes.slice(-80).reverse().map(note => (
                    <div key={note.id} className="border-l border-cyan-400/25 pl-3">
                      <div className="flex flex-wrap items-center gap-2 text-[10px] font-black uppercase tracking-widest text-cyan-300/70">
                        <span>{formatMeetingTime(note.time)}</span>
                        {meetingNoteHasSpeakerInfo(note) && (
                          <span
                            className={`rounded-full border px-2 py-0.5 normal-case tracking-normal ${
                              note.speakerMatched
                                ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200'
                                : 'border-white/10 bg-white/5 text-white/35'
                            }`}
                          >
                            {meetingSpeakerLabel(note)}
                            {typeof note.speakerConfidence === 'number'
                              ? ` ${Math.round(note.speakerConfidence * 100)}%`
                              : ''}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-white/70">{note.text}</p>
                    </div>
                  ))
                )}
              </div>

              <div className="mt-5 flex shrink-0 flex-col gap-2 border-t border-white/10 pt-4 sm:flex-row">
                <button
                  onClick={toggleMeetingCapturePaused}
                  disabled={meetingReportGenerating}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-black uppercase tracking-widest transition-colors ${
                    meetingPaused
                      ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/15'
                      : 'border-amber-400/25 bg-amber-400/10 text-amber-200 hover:bg-amber-400/15'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {meetingPaused ? <Play size={14} /> : <Pause size={14} />}
                  <span>{meetingPaused ? (uiMessage('desktop-ui.resume.20a567499d', (lang === 'zh') ? 'zh' : 'en')) : (uiMessage('desktop-ui.pause.e9b4be6e7c', (lang === 'zh') ? 'zh' : 'en'))}</span>
                </button>
                <button
                  onClick={() => void endMeetingAndReport()}
                  disabled={meetingReportGenerating}
                  className="flex-1 rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs font-black uppercase tracking-widest text-cyan-200 transition-colors hover:bg-cyan-400/15"
                >
                  {meetingReportGenerating
                    ? (uiMessage('desktop-ui.preparing.47ac61c0ae', (lang === 'zh') ? 'zh' : 'en'))
                    : (uiMessage('desktop-ui.end-report.86a5ea4d29', (lang === 'zh') ? 'zh' : 'en'))}
                </button>
                <button
                  onClick={clearMeetingNotes}
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-black uppercase tracking-widest text-white/40 transition-colors hover:bg-white/10 hover:text-white"
                >
                  {uiMessage('desktop-ui.clear.684270d636', (lang === 'zh') ? 'zh' : 'en')}
                </button>
              </div>
            </GlassCard>
          </motion.div>
        )}
        </AnimatePresence>
  );
}
