import { motion } from 'motion/react';
import { Zap } from 'lucide-react';
import { GlassCard } from './SharedUI';

export function MeshSyncSelector({ t, syncRate, onSyncRateChange }: {
  t?: any;
  syncRate: number;
  onSyncRateChange: (rate: number) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -40 }}
      transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
className=""
    >
      <GlassCard className="p-3 rounded-[1.5rem] border-white/5 bg-black/30 backdrop-blur-3xl">
        <div className="flex items-center gap-2">
          <span className="text-xs font-black text-white/45 uppercase tracking-wider">
            {t?.meshSyncRate || 'Mesh Sync'}
          </span>
          <div className="flex gap-1">
            {[0.5, 1, 1.5, 2].map((rate) => (
              <button
                key={rate}
                onClick={() => onSyncRateChange(rate)}
                className={`w-9 h-9 rounded-full border flex flex-col items-center justify-center transition-all ${
                  syncRate === rate
                    ? 'bg-celestial-saturn/20 border-celestial-saturn text-celestial-saturn shadow-[0_0_12px_rgba(255,200,80,0.25)]'
                    : 'bg-white/5 border-white/10 text-white/55 hover:bg-white/10 hover:text-white/50'
                }`}
              >
                <div className="text-xs font-black">{rate}x</div>
                <Zap size={8} className={syncRate === rate ? 'animate-pulse' : 'opacity-20'} />
              </button>
            ))}
          </div>
        </div>
      </GlassCard>
    </motion.div>
  );
}
