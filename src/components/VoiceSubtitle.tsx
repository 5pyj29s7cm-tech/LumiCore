import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, Volume2 } from 'lucide-react';

interface VoiceSubtitleProps {
  transcript: string;
  responseText: string;
  callState: string;
  audioLevel: number;
  t?: any;
}

export function VoiceSubtitle({ transcript, responseText, callState, audioLevel, t }: VoiceSubtitleProps) {
  const audioBarsRef = useRef<Array<HTMLDivElement | null>>([]);
  const [visible, setVisible] = useState(false);
  const [displayText, setDisplayText] = useState('');
  const [displayResponse, setDisplayResponse] = useState('');

  useEffect(() => {
    if (transcript) {
      setDisplayText(transcript);
      setVisible(true);
    } else if (responseText) {
      setDisplayResponse(responseText);
      setVisible(true);
    }
  }, [transcript, responseText]);

  // Auto-hide after idle
  useEffect(() => {
    if (callState === 'idle') {
      const timer = setTimeout(() => setVisible(false), 2000);
      return () => clearTimeout(timer);
    } else {
      setVisible(true);
    }
  }, [callState]);

  useEffect(() => {
    const updateBars = (level: number) => {
      if (!Number.isFinite(level)) return;
      audioBarsRef.current.forEach((bar, index) => {
        if (bar) bar.style.height = `${level > index * 0.1 ? 4 + index * 2 : 2}px`;
      });
    };
    updateBars(audioLevel);
    const onLevel = (event: Event) => {
      updateBars(Number((event as CustomEvent<{ level?: number }>).detail?.level));
    };
    window.addEventListener('lumi:voice-audio-level', onLevel);
    return () => window.removeEventListener('lumi:voice-audio-level', onLevel);
  }, [audioLevel, callState]);

  const isSpeaking = callState === 'speaking';
  const isListening = callState === 'listening';
  const isThinking = callState === 'thinking';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.95 }}
          className="fixed inset-x-0 bottom-24 z-[200] flex justify-center px-4 pointer-events-none"
        >
          <div className="flex w-full max-w-[min(92vw,36rem)] flex-col items-center gap-3">
            {/* State indicator */}
            <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-black/40 backdrop-blur-xl border border-white/10">
              {isListening && (
                <>
                  <motion.div
                    animate={{ scale: [1, 1.3, 1] }}
                    transition={{ duration: 1.5, repeat: Infinity }}
                  >
                    <Mic size={12} className="text-celestial-saturn" />
                  </motion.div>
                  <span className="text-xs font-medium text-white/60 uppercase tracking-widest">{t?.listening || 'Listening'}</span>
                  {/* Audio level bar */}
                  <div className="flex items-center gap-0.5">
                    {[...Array(5)].map((_, i) => (
                      <motion.div
                        key={i}
                        ref={(node) => { audioBarsRef.current[i] = node; }}
                        className="w-0.5 bg-celestial-saturn/60 rounded-full"
                        style={{ minHeight: 2, height: 2 }}
                      />
                    ))}
                  </div>
                </>
              )}
              {isThinking && (
                <>
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                  >
                    <Volume2 size={12} className="text-purple-400" />
                  </motion.div>
                  <span className="text-xs font-medium text-purple-400/60 uppercase tracking-widest">{t?.thinking || 'Thinking'}</span>
                </>
              )}
              {isSpeaking && (
                <>
                  <motion.div
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ duration: 0.6, repeat: Infinity }}
                  >
                    <Volume2 size={12} className="text-emerald-400" />
                  </motion.div>
                  <span className="text-xs font-medium text-emerald-400/60 uppercase tracking-widest">{t?.speaking || 'Speaking'}</span>
                </>
              )}
            </div>

            {/* User transcript */}
            {displayText && callState !== 'speaking' && (
              <motion.div
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-fit max-w-full px-5 py-2.5 rounded-2xl bg-white/5 backdrop-blur-xl border border-white/10 text-center"
              >
                <p className="max-w-full whitespace-normal break-words text-sm text-white/70 leading-relaxed">{displayText}</p>
              </motion.div>
            )}

            {/* AI response */}
            {displayResponse && isSpeaking && (
              <motion.div
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-fit max-w-full px-5 py-2.5 rounded-2xl bg-celestial-saturn/5 backdrop-blur-xl border border-celestial-saturn/20 text-center"
              >
                <p className="max-w-full whitespace-normal break-words text-sm text-celestial-saturn/90 leading-relaxed">{displayResponse}</p>
              </motion.div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
