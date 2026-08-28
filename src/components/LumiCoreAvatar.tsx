import { AnimatePresence, motion } from 'motion/react';
import { Clock, Mic, MicOff, Pause, Wifi, WifiOff } from 'lucide-react';
import { Button } from './ui/button';
import { LumiCoreOrb, type LumiCoreVoiceState } from './LumiCoreOrb';
import { getMessages } from '../i18n/runtime';

export function LumiCoreAvatar({
  t,
  lang,
  sentiment = 'default',
  callState = 'idle',
  audioLevel = 0,
  isMuted = false,
  elapsedSeconds = 0,
  connectionQuality = 'good',
  highPerformance = false,
  isWallpaperMode = false,
  reaction,
  facePresent = false,
  onStartCall,
  onEndCall,
  onInterrupt,
  onToggleMute,
  isLightMode = false,
}: {
  t: any;
  lang?: 'en' | 'zh';
  sentiment?: 'default' | 'excited' | 'focused' | 'zen';
  callState?: LumiCoreVoiceState;
  audioLevel?: number;
  isMuted?: boolean;
  elapsedSeconds?: number;
  connectionQuality?: 'good' | 'fair' | 'poor';
  highPerformance?: boolean;
  isWallpaperMode?: boolean;
  reaction?: string | null;
  facePresent?: boolean;
  onStartCall?: () => void;
  onEndCall?: () => void;
  onInterrupt?: () => void;
  onToggleMute?: () => void;
  isLightMode?: boolean;
}) {
  const isZh = (lang || t?.langCode || 'zh') !== 'en';
  const locale = isZh ? 'zh' : 'en';
  // The desktop shell passes `lang` as the source of truth.  A lazy-loaded
  // avatar can otherwise render one frame with the parent's old `t` object,
  // which made the Chinese voice controls fall back to English.  Resolve the
  // selected locale directly before consulting the legacy prop.
  const messages = getMessages(locale);
  const label = (translationKey: string, en: string) =>
    messages[translationKey] || t?.[translationKey] || en;
  const stateText = callState === 'listening'
    ? label('listening', 'Listening...')
    : callState === 'thinking'
      ? label('processing', 'Processing...')
      : callState === 'speaking'
        ? label('speaking', 'Speaking...')
        : callState === 'idle'
          ? label('voiceInteract', 'Voice interaction')
          : callState === 'passive'
            ? label('passive', 'Passive')
            : label(callState, callState.toUpperCase());

  return (
    <div
      data-lumicore-avatar
      className={`relative flex w-full flex-col items-center justify-center py-20 transition-all duration-1000 ${isWallpaperMode ? 'scale-[0.8] opacity-40 blur-[1px]' : 'scale-100 opacity-100'}`}
    >
      <LumiCoreOrb
        sentiment={sentiment}
        callState={callState}
        audioLevel={audioLevel}
        highPerformance={highPerformance}
        reaction={reaction}
        facePresent={facePresent}
        isLightMode={isLightMode}
        className="h-80 w-80 md:h-[500px] md:w-[500px]"
      />

      <div className="z-10 mt-12 flex flex-col items-center gap-6">
        <div className="flex items-center gap-3">
          {callState !== 'idle' && onToggleMute && (
            <Button
              onClick={onToggleMute}
              className={`flex h-10 w-10 items-center justify-center rounded-full transition-all duration-300 ${isMuted ? 'bg-amber-500 text-black' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
              title={isMuted ? label('voiceUnmuted', 'Unmute') : label('voiceMuted', 'Mute')}
            >
              {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
            </Button>
          )}

          <Button
            onClick={callState === 'idle' ? onStartCall : onEndCall}
            className={`flex h-16 w-16 items-center justify-center rounded-full transition-all duration-500 ${callState !== 'idle' ? 'scale-110 bg-red-500 text-white shadow-[0_0_30px_rgba(239,68,68,0.5)]' : 'bg-white/5 text-white/60 hover:bg-white/10'}`}
          >
            {callState !== 'idle' ? <Mic size={24} className="animate-pulse" /> : <MicOff size={24} />}
          </Button>

          {(callState === 'speaking' || callState === 'thinking') && onInterrupt && (
            <Button
              onClick={onInterrupt}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/60 transition-all duration-300 hover:bg-white/20"
              title={label('voiceInterrupt', 'Interrupt')}
            >
              <Pause size={18} />
            </Button>
          )}

          <div className="flex flex-col">
            <span className="text-xs font-bold uppercase tracking-widest text-white/40">{stateText}</span>
            <span className="text-sm font-medium text-white/80">
              {callState === 'idle' ? label('clickToStartSession', 'Click to start voice session') : label('sessionActiveClickToEnd', 'Session active - Click to end')}
            </span>
            {callState !== 'idle' && (
              <div className="mt-1 flex items-center gap-2">
                <Clock size={10} className="text-white/40" />
                <span className="text-xs tabular-nums text-white/40">
                  {String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:{String(elapsedSeconds % 60).padStart(2, '0')}
                </span>
                {connectionQuality === 'good' && <Wifi size={10} className="text-emerald-400" />}
                {connectionQuality === 'fair' && <Wifi size={10} className="text-amber-400" />}
                {connectionQuality === 'poor' && <WifiOff size={10} className="text-red-400" />}
              </div>
            )}
          </div>
        </div>

        <AnimatePresence>
          {callState !== 'idle' && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} className="flex gap-1">
              {Array.from({ length: 5 }, (_, index) => (
                <motion.div
                  key={index}
                  className="h-[30px] w-1 rounded-full bg-red-500"
                  animate={{ scaleY: callState === 'listening' ? [0.33, 1, 0.33] : [0.33, 0.5, 0.33] }}
                  transition={{ duration: 0.5, repeat: Infinity, delay: index * 0.1 }}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
