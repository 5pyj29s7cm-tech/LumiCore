import { motion, useReducedMotion } from 'motion/react';
import { useT } from '../lib/useT';

export function StartupSequence({ ready = false }: { ready?: boolean }) {
  const reduceMotion = useReducedMotion();
  const t = useT();

  return (
    <div
      className="fixed inset-0 z-[100000] flex min-h-screen items-center justify-center overflow-hidden bg-[#080a0d] text-white"
      data-theme-scope="dark"
      aria-label={ready ? 'Lumi is ready' : 'Lumi is starting'}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-20"
        style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-emerald-300/45" />
      <div className="relative flex w-full max-w-md flex-col items-center px-8 text-center">
        <div className="relative flex h-24 w-24 items-center justify-center" aria-hidden="true">
          <motion.div
            className="absolute inset-0 rounded-full border border-white/15"
            animate={reduceMotion ? undefined : { rotate: 360 }}
            transition={{ duration: 9, ease: 'linear', repeat: Infinity }}
          >
            <span className="absolute left-1/2 top-[-3px] h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-amber-300" />
          </motion.div>
          <motion.div
            className="absolute inset-3 rounded-full border border-emerald-300/45"
            animate={reduceMotion ? undefined : { rotate: -360 }}
            transition={{ duration: 6, ease: 'linear', repeat: Infinity }}
          >
            <span className="absolute bottom-[-3px] left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-emerald-300" />
          </motion.div>
          <motion.div
            className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-[#10151a] text-lg font-semibold text-white"
            animate={reduceMotion ? undefined : { opacity: [0.72, 1, 0.72] }}
            transition={{ duration: 1.8, repeat: Infinity }}
          >
            L
          </motion.div>
        </div>

        <h1 className="mt-7 text-[44px] font-semibold leading-none tracking-normal text-white">LUMI</h1>
        <p className="mt-4 text-sm font-medium text-white/55">
          {ready ? t.startupCoreReady : t.startupCoreConnecting}
        </p>

        <div className="mt-7 flex h-1 w-40 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
          <motion.div
            className="h-full w-1/3 rounded-full bg-emerald-300"
            animate={reduceMotion || ready ? { x: ready ? 107 : 0 } : { x: [0, 107, 0] }}
            transition={ready ? { duration: 0.25 } : { duration: 1.5, ease: 'easeInOut', repeat: Infinity }}
          />
        </div>
        <div className="mt-5 flex items-center gap-2 text-[11px] font-medium uppercase text-white/35">
          <span className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-emerald-300' : 'bg-amber-300'}`} />
          <span>{ready ? 'READY' : 'LOCAL RUNTIME'}</span>
        </div>
      </div>
    </div>
  );
}
