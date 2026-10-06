import { LumiCoreAvatar } from "./widget";
import { Suspense } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Mic } from 'lucide-react';
import { toast } from 'sonner';
import { VoicePicker } from "../VoicePicker";
import { MeetingModeButton } from "../DesktopShellAuxiliary";
import { PetAvatar } from "../SpriteAnimator";
import { PresenceIndicator } from "../biometrics/PresenceIndicator";
import { uiMessage } from "../../i18n/uiMessages";
import type { DesktopShellViewInput } from './DesktopShellView';

export function renderDesktopCoreStage({ selectedPet, setPersonalizationSection, toggleWindow, callState, t, petReaction, equippedAccessories, audioLevel, startStandardVoiceCall, endVoiceCallFromUI, lang, operationMode, openMeetingModeWithConfirm, canCustomizeLumiAppearance, setSelectedPet, savePetPrefsToServer, facePresenceRequested, faceRecognition, presence, voiceprint, sphereSentiment, isMuted, isTauri, isWallpaperMode, interrupt, toggleMute, resolvedAppearanceMode, wakeEnabled, wakeWord, transcript }: Pick<DesktopShellViewInput, "selectedPet" | "setPersonalizationSection" | "toggleWindow" | "callState" | "t" | "petReaction" | "equippedAccessories" | "audioLevel" | "startStandardVoiceCall" | "endVoiceCallFromUI" | "lang" | "operationMode" | "openMeetingModeWithConfirm" | "canCustomizeLumiAppearance" | "setSelectedPet" | "savePetPrefsToServer" | "facePresenceRequested" | "faceRecognition" | "presence" | "voiceprint" | "sphereSentiment" | "isMuted" | "isTauri" | "isWallpaperMode" | "interrupt" | "toggleMute" | "resolvedAppearanceMode" | "wakeEnabled" | "wakeWord" | "transcript">) {
  return (
<div data-wallpaper-tool="personal-core" className="lumi-core-stage absolute inset-0 flex items-center justify-center z-[15] pointer-events-none">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 2, ease: "easeOut" }}
          className="lumi-core-entity relative pointer-events-auto scale-[0.82] opacity-95 transition-all"
        >
          <div className="lumi-core-shell relative flex flex-col items-center">
            {selectedPet ? (
              <div className="relative group flex flex-col items-center gap-3">
                <button
                  onClick={() => {
                    setPersonalizationSection('appearance');
                    toggleWindow('personalization');
                  }}
                  className={`cursor-pointer transition-all ${callState !== 'idle' ? 'animate-pulse' : ''}`}
                  title={`${selectedPet.name} · ${t.personalization || 'Personalization'}`}
                >
                  <PetAvatar
                    pet={selectedPet}
                    animation={
                      petReaction ? petReaction.animation as any :
                      callState === 'speaking' ? 'wave' :
                      callState === 'listening' ? 'idle' :
                      callState !== 'idle' ? 'jump' : 'idle'
                    }
                    accessoryIds={equippedAccessories}
                    scale={1.2}
                    audioLevel={audioLevel}
                    callState={callState}
                    behavior={
                      'playful'
                    }
                  />
                </button>
                {/* Voice call button below pet */}
                <button
                  onClick={callState === 'idle' ? () => startStandardVoiceCall() : endVoiceCallFromUI}
                  className={`w-12 h-12 rounded-full border transition-all flex items-center justify-center ${
                    callState !== 'idle'
                      ? 'bg-red-500/20 border-red-500/40 text-red-400'
                      : 'bg-white/5 border-white/10 text-white/40 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  {callState !== 'idle' ? <Mic size={20} className="animate-pulse" /> : <Mic size={20} />}
                </button>
                <MeetingModeButton
                  t={t}
                  lang={lang}
                  active={operationMode === 'meeting'}
                  live={operationMode === 'meeting' && callState !== 'idle'}
                  onClick={openMeetingModeWithConfirm}
                />
                {/* Reset to sphere button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!canCustomizeLumiAppearance) {
                      toast.error(uiMessage('desktop-ui.only-an-organization-owner-or.cbb301d68a', (lang === 'zh') ? 'zh' : 'en'));
                      return;
                    }
                    setSelectedPet(null);
                    savePetPrefsToServer(null, equippedAccessories);
                    toast.info(uiMessage('desktop-ui.switched-back-to-particle-face.d909fcb03c', (lang === 'zh') ? 'zh' : 'en'));
                  }}
                  className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-white/10 border border-white/10 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/30 hover:border-red-500/40"
                  title={uiMessage('desktop-ui.switch-back-to-particle-face.711fb73491', (lang === 'zh') ? 'zh' : 'en')}
                >
                  <X size={10} className="text-white/60" />
                </button>
              </div>
            ) : (
              <>
              {/* Biometrics presence indicator — above particle sphere */}
            {facePresenceRequested && faceRecognition.hasTemplates && (
              <div className="absolute -top-10 left-1/2 -translate-x-1/2 z-30">
                <PresenceIndicator
                  status={presence.status}
                  faceConfidence={faceRecognition.result.confidence}
                  voiceConfidence={voiceprint.result.confidence}
                />
              </div>
            )}
            <Suspense fallback={<div className="h-[210px] w-[210px] rounded-full border border-white/10 bg-white/[0.02] animate-pulse" />}>
              <LumiCoreAvatar
                t={t}
                lang={lang}
                sentiment={sphereSentiment}
                callState={callState}
                audioLevel={audioLevel}
                isMuted={isMuted}
                highPerformance={isTauri}
                isWallpaperMode={isWallpaperMode}
                reaction={petReaction?.animation || null}
                facePresent={faceRecognition.result.facePresent}
                onStartCall={startStandardVoiceCall}
                onEndCall={endVoiceCallFromUI}
                onInterrupt={interrupt}
                onToggleMute={toggleMute}
                isLightMode={resolvedAppearanceMode === 'light'}
              />
            </Suspense>
              <div className="mt-2">
                <MeetingModeButton
                  t={t}
                  lang={lang}
                  active={operationMode === 'meeting'}
                  live={operationMode === 'meeting' && callState !== 'idle'}
                  onClick={openMeetingModeWithConfirm}
                />
              </div>
              {wakeEnabled && wakeWord.isListening && callState === 'idle' && (
                <div className="mt-2 text-xs text-white/45 uppercase tracking-[0.25em] font-mono">
                  {uiMessage('desktop-ui.listening-for-lumi.9b7354ccfe', (lang === 'zh') ? 'zh' : 'en')}
                </div>
              )}
              {wakeEnabled && wakeWord.error && (
                <div className="mt-2 text-xs text-red-400/60 font-mono max-w-[200px] text-center leading-relaxed">
                  Wake: {wakeWord.error}
                </div>
              )}
              {wakeEnabled && !wakeWord.isListening && !wakeWord.error && callState === 'idle' && (
                <div className="mt-2 text-xs text-yellow-400/40 font-mono">
                  {uiMessage('desktop-ui.wake-word-initializing.a269c0c408', (lang === 'zh') ? 'zh' : 'en')}
                </div>
              )}
              {!wakeEnabled && callState === 'idle' && (
                <div className="mt-2 text-xs text-white/30 font-mono">
                  {uiMessage('desktop-ui.wake-word-off.d249204cdf', (lang === 'zh') ? 'zh' : 'en')}
                </div>
              )}
              </>
            )}

            <div className={`lumi-core-secondary flex flex-col items-center gap-4 mt-8 transition-all duration-1000 ${isWallpaperMode ? 'opacity-0 blur-sm pointer-events-none' : 'opacity-100'}`}>
              <VoicePicker t={t} />

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full"
              >
                 <div className="flex flex-col items-center gap-1 group">
                   <span className="text-xs font-black tracking-[0.4em] text-white/40 uppercase group-hover:text-celestial-saturn transition-colors">
                     {callState === 'idle' ? (t.lumiNeuralCore || 'Lumi Neural Core') : `${callState.toUpperCase()} ${t.sessionActive || 'SESSION'}`}
                   </span>
                   <div className="flex gap-1">
                     {callState !== 'idle' ? (
                       [1,2,3,4,5].map(i => (
                         <motion.div
                           key={i}
                           className="w-1 bg-celestial-saturn rounded-full"
                           animate={{ height: [8, 16 + audioLevel * 20, 8] }}
                           transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.1 }}
                         />
                       ))
                     ) : (
                       [1,2,3].map(i => <div key={i} className="w-1 h-1 rounded-full bg-celestial-saturn/40 animate-pulse" style={{ animationDelay: `${i*0.2}s` }} />)
                     )}
                   </div>

                   <AnimatePresence>
                      {operationMode !== 'meeting' && callState !== 'idle' && transcript && (
                       <motion.div
                         initial={{ opacity: 0, y: 20 }}
                         animate={{ opacity: 1, y: 0 }}
                         exit={{ opacity: 0, scale: 0.9 }}
                         className="mt-6 w-fit max-w-[min(92vw,32rem)] px-6 py-4 bg-white/5 backdrop-blur-3xl border border-white/10 rounded-2xl text-center shadow-2xl"
                       >
                         <p className="max-w-full whitespace-normal break-words text-white/80 text-sm font-medium leading-relaxed italic">
                           "{transcript}"
                         </p>
                         <div className="mt-2 flex justify-center gap-1">
                            <div className="w-1 h-1 rounded-full bg-celestial-saturn animate-pulse" />
                            <div className="w-1 h-1 rounded-full bg-celestial-saturn animate-pulse delay-75" />
                            <div className="w-1 h-1 rounded-full bg-celestial-saturn animate-pulse delay-150" />
                         </div>
                       </motion.div>
                     )}
                   </AnimatePresence>
                </div>
              </motion.div>
            </div>
          </div>
        </motion.div>
      </div>
  );
}
