import { motion, AnimatePresence } from 'motion/react';
import { useT } from '../../lib/useT';
import { uiMessage } from '../../i18n/uiMessages';

interface PresenceIndicatorProps {
  status: 'present' | 'uncertain' | 'away';
  faceConfidence: number;
  voiceConfidence: number;
}

export function PresenceIndicator({ status, faceConfidence, voiceConfidence }: PresenceIndicatorProps) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const colors = {
    present: { bg: 'rgba(76,175,80,0.8)', ring: 'rgba(76,175,80,0.3)', label: uiMessage('presence-indicator.present.680c4a192a', (isZh) ? 'zh' : 'en') },
    uncertain: { bg: 'rgba(255,193,7,0.8)', ring: 'rgba(255,193,7,0.3)', label: uiMessage('presence-indicator.uncertain.b045da699d', (isZh) ? 'zh' : 'en') },
    away: { bg: 'rgba(244,67,54,0.8)', ring: 'rgba(244,67,54,0.3)', label: uiMessage('presence-indicator.away.a1b127ce19', (isZh) ? 'zh' : 'en') },
  };

  const c = colors[status] || colors.away;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-2 px-3 py-1.5 rounded-full"
      style={{ background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(8px)' }}
    >
      {/* Status dot */}
      <motion.div
        className="w-2.5 h-2.5 rounded-full"
        style={{ background: c.bg, boxShadow: `0 0 8px ${c.ring}` }}
        animate={{ scale: status === 'present' ? [1, 1.15, 1] : 1 }}
        transition={{ repeat: status === 'present' ? Infinity : 0, duration: 2 }}
      />
      <span className="text-[11px] font-medium text-white/70">{c.label}</span>

      {/* Confidence mini-bars */}
      <AnimatePresence>
        {faceConfidence > 0 && (
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: 16 }}
            className="flex gap-[1px] items-end h-2.5"
          >
            <div className="w-[3px] rounded-sm" style={{ height: `${Math.min(faceConfidence * 100, 100)}%`, background: 'rgba(255,255,255,0.5)' }} />
            <div className="w-[3px] rounded-sm" style={{ height: `${Math.min(voiceConfidence * 100, 100)}%`, background: 'rgba(255,255,255,0.35)' }} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
