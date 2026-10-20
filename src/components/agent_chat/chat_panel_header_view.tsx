import { Loader2, Ghost, FileText, XCircle, MessageCircle, CalendarClock } from 'lucide-react';
import { VoiceCallButton } from "../VoiceCallButton";
import { uiMessage } from "../../i18n/uiMessages";
import type { AgentChatViewInput } from './AgentChatView';

export function renderChatPanelHeader({ desktopModeControl, isOfficeCommandCenter, chatHeaderStyle, agentName, operationModeMeta, agentCategory, activeDomainLabel, OperationModeIcon, knowledgeFiles, knowledgeLoading, knowledgeStatusText, callState, audioLevel, startVoiceSession, endVoiceSession, voices, activeDomain, setShowWeChatSettings, setCommandCenterPlannerOpen, commandCenterPlannerOpen, commandCenterPlannerText, searchQuery, setSearchQuery, setSearchResults, setSearchError }: Pick<AgentChatViewInput, "desktopModeControl" | "isOfficeCommandCenter" | "chatHeaderStyle" | "agentName" | "operationModeMeta" | "agentCategory" | "activeDomainLabel" | "OperationModeIcon" | "knowledgeFiles" | "knowledgeLoading" | "knowledgeStatusText" | "callState" | "audioLevel" | "startVoiceSession" | "endVoiceSession" | "voices" | "activeDomain" | "setShowWeChatSettings" | "setCommandCenterPlannerOpen" | "commandCenterPlannerOpen" | "commandCenterPlannerText" | "searchQuery" | "setSearchQuery" | "setSearchResults" | "setSearchError">) {
  return (
<div
            className={`lumi-chat-panel-header flex items-center justify-between ${isOfficeCommandCenter ? 'border-0 bg-transparent px-5 py-3.5' : 'border-b p-4 md:p-6'}`}
            style={isOfficeCommandCenter
              ? { ...chatHeaderStyle, background: 'transparent', borderBottomColor: 'transparent' }
              : chatHeaderStyle}
          >
            <div className="flex min-w-0 items-center gap-3">
              {isOfficeCommandCenter && (
                <div
                  data-command-center-integrated-identity
                  className="flex min-w-0 items-center gap-2.5"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-celestial-saturn/20 bg-celestial-saturn/15 text-celestial-saturn">
                    <Ghost className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="max-w-[24vw] truncate text-sm font-bold tracking-tight text-white/90">{agentName}</span>
                      <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider ${operationModeMeta.badgeClass}`}>
                        {operationModeMeta.label}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[9px] font-bold uppercase tracking-[0.14em] text-white/38">
                      {agentCategory} · {activeDomainLabel}
                    </div>
                  </div>
                </div>
              )}
              <div className="flex shrink-0 items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-celestial-saturn animate-pulse" />
                <span className="text-xs font-bold uppercase tracking-widest text-white/60">
                  Neural Link
                </span>
              </div>
              <div
                className={`items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-widest ${operationModeMeta.subtleClass} ${isOfficeCommandCenter ? 'hidden' : 'inline-flex'}`}
                title={operationModeMeta.detail}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${operationModeMeta.dotClass}`} />
                <OperationModeIcon size={11} />
                <span>{operationModeMeta.label}</span>
              </div>
              {!isOfficeCommandCenter && (knowledgeFiles.length > 0 || knowledgeLoading) && (
                <div
                  className="ml-1 hidden min-w-0 items-center gap-1.5 rounded-full border border-emerald-400/15 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-100/75 sm:flex"
                  title={knowledgeStatusText}
                >
                  {knowledgeLoading ? <Loader2 size={11} className="animate-spin" /> : <FileText size={11} />}
                  <span className="max-w-[180px] truncate">{knowledgeStatusText}</span>
                </div>
              )}
            </div>
            <div className="lumi-chat-history-search relative flex flex-wrap items-center justify-end gap-2">
              {desktopModeControl}
              {isOfficeCommandCenter && (
                <VoiceCallButton
                  callState={callState}
                  audioLevel={audioLevel}
                  onStart={startVoiceSession}
                  onEnd={endVoiceSession}
                  hasVoice={voices.length > 0}
                  className="lumi-command-center-integrated-voice scale-[0.72] origin-right"
                />
              )}
              {isOfficeCommandCenter && activeDomain === 'personal' && (
                <button
                  type="button"
                  onClick={() => setShowWeChatSettings(true)}
                  className="flex h-8 w-8 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-200 transition-all hover:border-emerald-300/35 hover:bg-emerald-400/15 md:h-9 md:w-9"
                  title={uiMessage('agent-chat-page.personal-wechat.153d58f0e9')}
                  aria-label={uiMessage('agent-chat-page.open-personal-wechat-connection.24ff73324a')}
                >
                  <MessageCircle className="h-4 w-4" />
                </button>
              )}
              {isOfficeCommandCenter && (
                <button
                  type="button"
                  onClick={() => setCommandCenterPlannerOpen(value => !value)}
                  className={`flex h-8 items-center gap-1.5 rounded-xl border px-2.5 text-[9px] font-bold transition-colors ${
                    commandCenterPlannerOpen
                      ? 'border-cyan-300/30 bg-cyan-300/[0.10] text-cyan-50'
                      : 'border-white/10 bg-white/[0.04] text-white/45 hover:border-cyan-300/25 hover:text-cyan-100'
                  }`}
                  title={commandCenterPlannerText.plannerButtonTitle}
                  aria-pressed={commandCenterPlannerOpen}
                >
                  <CalendarClock size={13} />
                  <span>{commandCenterPlannerText.plannerButton}</span>
                </button>
              )}
              {!isOfficeCommandCenter && <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search saved history..."
                  className="h-7 w-40 px-3 py-0 text-xs bg-white/5 border border-white/10 rounded-full text-white/60 placeholder:text-white/20 outline-none focus:border-white/20 focus:bg-white/[0.07] transition-colors"
                />
                {searchQuery && (
                  <button
                    onClick={() => { setSearchQuery(''); setSearchResults([]); setSearchError(''); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
                  >
                    <XCircle size={12} />
                  </button>
                )}
              </div>}
            </div>
          </div>
  );
}
