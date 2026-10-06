import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, Ghost, FileText, ChevronDown, MessageCircle, Briefcase, User } from 'lucide-react';
import { Button } from "../ui/button";
import { VoiceCallButton } from "../VoiceCallButton";
import { uiMessage } from "../../i18n/uiMessages";
import type { AgentChatViewInput } from './AgentChatView';

export function renderChatToolbar({ isOfficeCommandCenter, onClose, t, isZh, setShowVoicePicker, showVoicePicker, voices, selectedVoiceId, voicePickerRef, setSelectedVoiceId, callState, audioLevel, startVoiceSession, endVoiceSession, activeDomain, setShowWeChatSettings, requestMeetingMode, agentName, operationModeMeta, OperationModeIcon, isWorkChat, activeDomainDetail, activeDomainLabel, agentCategory }: Pick<AgentChatViewInput, "isOfficeCommandCenter" | "onClose" | "t" | "isZh" | "setShowVoicePicker" | "showVoicePicker" | "voices" | "selectedVoiceId" | "voicePickerRef" | "setSelectedVoiceId" | "callState" | "audioLevel" | "startVoiceSession" | "endVoiceSession" | "activeDomain" | "setShowWeChatSettings" | "requestMeetingMode" | "agentName" | "operationModeMeta" | "OperationModeIcon" | "isWorkChat" | "activeDomainDetail" | "activeDomainLabel" | "agentCategory">) {
  return (
<div className={`lumi-chat-toolbar relative z-[55] flex flex-shrink-0 items-center justify-between ${
        isOfficeCommandCenter
          ? 'h-14 border-b border-white/[0.07] bg-[#03070d]/92 px-4 shadow-[0_1px_0_rgba(255,255,255,0.025)]'
          : 'px-4 pt-6 md:px-0'
      }`}>
        <div className="flex shrink-0 items-center gap-2">
        {!isOfficeCommandCenter && <button
          onClick={onClose}
          className="w-10 h-10 flex items-center justify-center bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl text-white/40 hover:text-white hover:border-white/20 transition-all"
          aria-label={t.back || uiMessage('org-portal.back.5db5cac55e', isZh ? 'zh' : 'en')}
        >
          <ArrowLeft size={18} />
        </button>}
        </div>
        <div className={`lumi-chat-toolbar-actions flex min-w-0 items-center ${isOfficeCommandCenter ? 'gap-1.5' : 'gap-3'}`}>
          {!isOfficeCommandCenter && <div className="lumi-chat-voice-picker relative">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowVoicePicker(!showVoicePicker)}
              className="text-xs font-black uppercase tracking-widest text-white/40 flex items-center gap-2 hover:text-celestial-saturn transition-colors"
            >
              {voices.find(v => v.voiceId === selectedVoiceId)?.name || (t.selectVoice || 'Select Voice')}
              <ChevronDown size={12} />
            </Button>

            <AnimatePresence>
              {showVoicePicker && (
                <motion.div
                  ref={voicePickerRef}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="absolute top-full left-0 mt-2 w-48 bg-black/80 backdrop-blur-xl border border-white/10 rounded-2xl p-2 z-50 shadow-2xl max-h-64 overflow-y-auto custom-scrollbar"
                >
                  {voices.map(v => (
                    <button
                      key={v.voiceId}
                      onClick={() => {
                        setSelectedVoiceId(v.voiceId, v.provider);
                        setShowVoicePicker(false);
                      }}
                      className={`w-full text-left p-2 rounded-xl text-xs font-bold uppercase transition-all ${
                        selectedVoiceId === v.voiceId ? 'bg-celestial-saturn text-black' : 'text-white/60 hover:bg-white/5 hover:text-white'
                      }`}
                    >
                      {v.name}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>}

          <VoiceCallButton
            callState={callState}
            audioLevel={audioLevel}
            onStart={startVoiceSession}
            onEnd={endVoiceSession}
            hasVoice={voices.length > 0}
          />
          {activeDomain === 'personal' && (
            <button
              type="button"
              onClick={() => setShowWeChatSettings(true)}
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-200 transition-all hover:border-emerald-300/35 hover:bg-emerald-400/15 md:h-10 md:w-10"
              title={uiMessage('agent-chat-page.personal-wechat.153d58f0e9')}
              aria-label={uiMessage('agent-chat-page.open-personal-wechat-connection.24ff73324a')}
            >
              <MessageCircle className="h-4 w-4 md:h-5 md:w-5" />
            </button>
          )}
          {!isOfficeCommandCenter && <button
            type="button"
            onClick={requestMeetingMode}
            className="flex h-8 w-8 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-200 transition-all hover:border-cyan-300/35 hover:bg-cyan-400/15 md:h-10 md:w-10"
            title={uiMessage('agent-chat-page.meeting-mode.958510fb80')}
            aria-label={uiMessage('agent-chat-page.open-meeting-mode.3aabc87fcb')}
          >
            <FileText className="h-4 w-4 md:h-5 md:w-5" />
          </button>}
          <div className="lumi-chat-agent-mark flex h-8 w-8 items-center justify-center rounded-xl border border-celestial-saturn/20 bg-celestial-saturn/20 text-celestial-saturn md:h-10 md:w-10">
            <Ghost className="w-4 h-4 md:w-5 md:h-5" />
          </div>
          <div className="lumi-chat-agent-identity min-w-0 text-right sm:text-left">
            <div className="flex max-w-[52vw] flex-wrap items-center justify-end gap-1.5 sm:max-w-none sm:justify-start">
              <h2 className="min-w-0 truncate text-base font-bold tracking-tight md:text-xl">
                {agentName}
              </h2>
              <span
                className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${operationModeMeta.badgeClass}`}
                title={operationModeMeta.detail}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${operationModeMeta.dotClass}`} />
                <OperationModeIcon size={11} />
                {operationModeMeta.label}
              </span>
              <span
                className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                  isWorkChat
                    ? 'border-blue-500/30 bg-blue-500/15 text-blue-300'
                    : 'border-white/10 bg-white/5 text-white/45'
                }`}
                title={activeDomainDetail}
              >
                {isWorkChat ? <Briefcase size={11} /> : <User size={11} />}
                {activeDomainLabel}
              </span>
            </div>
            <p className="text-xs md:text-xs uppercase tracking-widest text-white/40 font-bold">{agentCategory}</p>
          </div>
        </div>
      </div>
  );
}
