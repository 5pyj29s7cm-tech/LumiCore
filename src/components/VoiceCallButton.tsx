import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, Phone, Loader2, Volume2 } from 'lucide-react';
import { CallState } from '../hooks/useVoiceCall';
import { useT } from '../lib/useT';

interface VoiceCallButtonProps {
  callState: CallState;
  audioLevel: number;
  onStart: () => void;
  onEnd: () => void;
  hasVoice?: boolean;
  className?: string;
}

export function VoiceCallButton({ callState, audioLevel, onStart, onEnd, hasVoice = false, className = '' }: VoiceCallButtonProps) {
  const audioRingRef = React.useRef<HTMLDivElement | null>(null);
  const isActive = callState !== 'idle' && callState !== 'passive';
  const isOn = callState !== 'idle';
  const t = useT();

  const stateConfig: Record<CallState, { icon: React.ReactNode; color: string; label: string }> = {
    idle: { icon: <Mic size={20} />, color: 'bg-white/5 text-white/40 border-white/10', label: t.callStart || 'Start' },
    connecting: { icon: <Loader2 size={20} className="animate-spin" />, color: 'bg-celestial-saturn/10 text-celestial-saturn border-celestial-saturn/30', label: t.callConnecting || 'Connecting...' },
    listening: { icon: <Mic size={20} />, color: 'bg-celestial-saturn text-black border-celestial-saturn shadow-[0_0_20px_rgba(255,204,0,0.4)]', label: t.callListening || 'Listening' },
    thinking: { icon: <Loader2 size={20} className="animate-spin" />, color: 'bg-celestial-mars/10 text-celestial-mars border-celestial-mars/30', label: t.callThinking || 'Thinking' },
    speaking: { icon: <Volume2 size={20} />, color: 'bg-celestial-glow/10 text-celestial-glow border-celestial-glow/30', label: t.callSpeaking || 'Speaking' },
    queued: { icon: <Loader2 size={20} className="animate-spin" />, color: 'bg-purple-500/10 text-purple-400 border-purple-500/30', label: t.callQueued || 'Queued' },
    passive: { icon: <motion.div animate={{ opacity: [0.15, 0.35, 0.15] }} transition={{ duration: 3, repeat: Infinity }}><Mic size={20} /></motion.div>, color: 'bg-white/5 text-white/45 border-white/5', label: t.callPassive || 'Passive' },
  };

  const config = stateConfig[callState];

  React.useEffect(() => {
    const updateRing = (level: number) => {
      const ring = audioRingRef.current;
      if (!ring || !Number.isFinite(level)) return;
      ring.style.transform = `scale(${1 + level * 0.3})`;
      ring.style.opacity = String(0.15 + level * 0.2);
    };
    updateRing(audioLevel);
    const onLevel = (event: Event) => {
      updateRing(Number((event as CustomEvent<{ level?: number }>).detail?.level));
    };
    window.addEventListener('lumi:voice-audio-level', onLevel);
    return () => window.removeEventListener('lumi:voice-audio-level', onLevel);
  }, [audioLevel, isActive]);

  return (
    <div className={`relative ${className}`}>
      {/* Audio level ring */}
      <AnimatePresence>
        {isActive && (
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.8, opacity: 0 }}
            className="absolute inset-0"
          >
            <div
              ref={audioRingRef}
              className={`absolute inset-0 rounded-full ${
                callState === 'speaking' ? 'bg-celestial-glow' :
                callState === 'listening' ? 'bg-celestial-saturn' :
                'bg-celestial-mars'
              }`}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={isOn ? onEnd : onStart}
        className={`relative w-12 h-12 rounded-2xl border flex items-center justify-center transition-all ${config.color} ${
          isOn ? '' : (!hasVoice ? 'opacity-40 hover:opacity-100' : '')
        }`}
        disabled={isOn && callState === 'connecting'}
        title={isOn ? (t.endCall || 'End call') : (t.startVoiceCall || 'Start voice call')}
      >
        {config.icon}
      </motion.button>

      {/* State label */}
      <AnimatePresence>
        {isOn && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap"
          >
            <span className="text-[12px] font-bold uppercase tracking-widest text-white/40">
              {config.label}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
