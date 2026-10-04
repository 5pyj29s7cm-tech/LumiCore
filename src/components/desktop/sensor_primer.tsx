import { Camera, Mic, Shield, ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

export function SensorPrimer({ isOpen, onContinue, t }: { isOpen: boolean; onContinue: () => void; t: any }) {
  if (!isOpen) return null;

  const items = [
    {
      icon: <Camera size={18} />,
      title: t.visualAwareness || 'Visual awareness',
      desc: t.visualAwarenessDesc || 'Camera access powers presence, face recognition, and gesture-aware desktop behavior.',
    },
    {
      icon: <Mic size={18} />,
      title: t.voiceAwareness || 'Voice awareness',
      desc: t.voiceAwarenessDesc || 'Microphone access powers voice calls, wake word detection, and optional voiceprint enrollment.',
    },
    {
      icon: <Shield size={18} />,
      title: t.localSensorProcessing || 'Local-first processing',
      desc: t.localSensorProcessingDesc || 'Sensor streams are used for the desktop client experience and biometric checks. You can review permissions in Settings.',
    },
  ];

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[210] flex items-center justify-center p-4 pointer-events-auto">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/82 backdrop-blur-2xl"
        />
        <motion.div
          initial={{ opacity: 0, y: 18, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 18, scale: 0.96 }}
          className="relative w-full max-w-xl rounded-3xl border border-white/10 bg-[#080a10]/95 p-7 shadow-2xl"
        >
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-celestial-saturn/25 bg-celestial-saturn/12 text-celestial-saturn">
              <Shield size={22} />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-black uppercase tracking-[0.24em] text-white/35">
                {t.sensorPermissionIntro || 'Sensor permissions'}
              </div>
              <h2 className="mt-2 text-2xl font-black tracking-normal text-white">
                {t.sensorPrimerTitle || 'Enable Lumi desktop awareness'}
              </h2>
              <p className="mt-3 text-sm leading-7 text-white/56">
                {t.sensorPrimerDesc || 'Lumi uses local camera and microphone signals for presence, voice, and biometric features. The feature stays part of the desktop experience; this notice explains what will request permission first.'}
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-3">
            {items.map(item => (
              <div key={item.title} className="flex gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-white/70">
                  {item.icon}
                </div>
                <div>
                  <div className="text-sm font-black text-white/85">{item.title}</div>
                  <p className="mt-1 text-xs leading-5 text-white/45">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-7 flex justify-end">
            <button
              onClick={onContinue}
              className="flex h-11 items-center gap-2 rounded-2xl bg-white px-5 text-sm font-black text-black transition-transform hover:scale-[1.02] active:scale-95"
            >
              {t.continueToDesktop || 'Continue'}
              <ChevronRight size={17} />
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
