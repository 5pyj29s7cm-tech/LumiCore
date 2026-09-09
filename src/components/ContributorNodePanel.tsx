import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Cpu, Gavel, Database, Megaphone, Activity, ChevronRight } from 'lucide-react';
import { GlassCard } from './SharedUI';
import { contributorNodeCopy } from '../i18n/locales/contributorNode';

export function ContributorNodePanel({ t }: { t?: any }) {
  const isZh = t?.langCode !== 'en';
  const [isExpanded, setIsExpanded] = useState(false);
  const copy = contributorNodeCopy[isZh ? 'zh' : 'en'];

  const contributionTypes = [
    { key: 'compute', icon: Cpu, label: t?.contributeCompute || 'Compute', desc: t?.contributeComputeDesc || 'Idle GPU power.', color: 'text-cyan-400' },
    { key: 'ethics', icon: Gavel, label: t?.contributeEthics || 'Ethics', desc: t?.contributeEthicsDesc || 'Governance.', color: 'text-violet-400' },
    { key: 'curator', icon: Database, label: t?.contributeCurator || 'Curator', desc: t?.contributeCuratorDesc || 'Data verification.', color: 'text-emerald-400' },
    { key: 'advocate', icon: Megaphone, label: t?.contributeAdvocate || 'Advocate', desc: t?.contributeAdvocateDesc || 'Growth.', color: 'text-amber-400' },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, x: -40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -40 }}
      transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
className="w-72"
    >
      <GlassCard className="p-4 rounded-[1.5rem] space-y-3 border-white/5 bg-black/30 backdrop-blur-3xl">
        {/* Header — always visible */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center justify-between group"
        >
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-celestial-saturn" />
            <span className="text-xs font-black text-white/70">{copy.title}</span>
          </div>
          <motion.div animate={{ rotate: isExpanded ? 90 : 0 }} transition={{ duration: 0.2 }}>
            <ChevronRight size={14} className="text-white/55 group-hover:text-white/60" />
          </motion.div>
        </button>

        <p className="text-xs text-white/60"><span className="mr-2 text-amber-300">{copy.status}</span>{copy.unavailable}</p>

        {/* Expandable detail */}
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
              className="overflow-hidden space-y-3"
            >
              <p className="text-[12px] text-white/50 leading-relaxed border-t border-white/5 pt-3">
                {copy.details}
              </p>

              <div className="space-y-1.5">
                <h4 className="text-xs font-black uppercase tracking-widest text-white/45">
                  {t?.contributionTypes || 'Contribution Types'}
                </h4>
                <div className="grid grid-cols-2 gap-1.5">
                  {contributionTypes.map((ct) => (
                    <div
                      key={ct.key}
                      className="p-2 rounded-lg bg-white/[0.03] border border-white/5 flex items-center gap-2"
                    >
                      <ct.icon size={14} className={ct.color} />
                      <div>
                        <div className="text-xs font-bold text-white/40">{ct.label}</div>
                        <div className="text-xs text-white/40">{ct.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

            </motion.div>
          )}
        </AnimatePresence>
      </GlassCard>
    </motion.div>
  );
}
