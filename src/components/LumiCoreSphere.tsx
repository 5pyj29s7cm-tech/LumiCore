import type { CSSProperties } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { CheckCircle2, CircleAlert, Loader2, Pause } from 'lucide-react';
import { LumiCoreOrb } from './LumiCoreOrb';

export type LumiCoreTaskState = 'queued' | 'working' | 'paused' | 'attention' | 'completed';

export interface LumiCoreOrbitTask {
  id: string;
  title: string;
  state: LumiCoreTaskState;
  active: boolean;
}

const TASK_COLORS: Record<LumiCoreTaskState, string> = {
  queued: '#94a3b8',
  working: '#67e8f9',
  paused: '#fbbf24',
  attention: '#fb7185',
  completed: '#6ee7b7',
};

/**
 * The command field deliberately uses a deterministic star map.  A stable
 * field keeps screenshots, replays and reduced-motion mode reproducible while
 * still giving the core a sense of depth.
 */
const COSMOS_STARS = [
  { x: 7, y: 14, size: 1, opacity: 0.38, delay: -1.2, depth: 'far' },
  { x: 14, y: 72, size: 2, opacity: 0.52, delay: -4.8, depth: 'near' },
  { x: 22, y: 31, size: 1, opacity: 0.3, delay: -7.5, depth: 'far' },
  { x: 28, y: 83, size: 1, opacity: 0.42, delay: -2.7, depth: 'near' },
  { x: 36, y: 16, size: 1, opacity: 0.34, delay: -5.4, depth: 'far' },
  { x: 41, y: 68, size: 2, opacity: 0.6, delay: -8.1, depth: 'near' },
  { x: 48, y: 9, size: 1, opacity: 0.4, delay: -3.3, depth: 'far' },
  { x: 54, y: 87, size: 1, opacity: 0.35, delay: -6.2, depth: 'far' },
  { x: 61, y: 23, size: 2, opacity: 0.56, delay: -1.9, depth: 'near' },
  { x: 68, y: 77, size: 1, opacity: 0.36, delay: -9.6, depth: 'far' },
  { x: 74, y: 11, size: 1, opacity: 0.48, delay: -4.1, depth: 'near' },
  { x: 81, y: 58, size: 2, opacity: 0.62, delay: -7.1, depth: 'near' },
  { x: 89, y: 28, size: 1, opacity: 0.32, delay: -2.1, depth: 'far' },
  { x: 93, y: 84, size: 1, opacity: 0.38, delay: -5.9, depth: 'far' },
  { x: 4, y: 47, size: 1, opacity: 0.3, delay: -8.7, depth: 'far' },
  { x: 18, y: 9, size: 1, opacity: 0.34, delay: -3.8, depth: 'far' },
  { x: 32, y: 48, size: 1, opacity: 0.44, delay: -6.8, depth: 'near' },
  { x: 47, y: 39, size: 1, opacity: 0.3, delay: -1.5, depth: 'far' },
  { x: 70, y: 46, size: 1, opacity: 0.4, delay: -9.1, depth: 'near' },
  { x: 84, y: 91, size: 1, opacity: 0.34, delay: -4.4, depth: 'far' },
] as const;

function TaskIcon({ state }: { state: LumiCoreTaskState }) {
  if (state === 'working') return <Loader2 size={11} className="animate-spin" />;
  if (state === 'paused') return <Pause size={11} />;
  if (state === 'attention') return <CircleAlert size={11} />;
  if (state === 'completed') return <CheckCircle2 size={11} />;
  return <span className="h-1.5 w-1.5 rounded-full bg-current" />;
}

export function LumiCoreSphere({
  tasks,
  state,
  loading,
  labels,
}: {
  tasks: LumiCoreOrbitTask[];
  state: 'ready' | 'working' | 'attention';
  loading?: boolean;
  labels: {
    aria: string;
    lumiCore: string;
    ready: string;
    working: string;
    attention: string;
    noTasks: string;
  };
}) {
  const reducedMotion = useReducedMotion();
  const activeTasks = tasks.filter(task => task.active).slice(0, 8);
  const stateLabel = state === 'working' ? labels.working : state === 'attention' ? labels.attention : labels.ready;
  const coreColor = state === 'attention' ? '#fb7185' : state === 'working' ? '#67e8f9' : '#a78bfa';
  const motionEnabled = reducedMotion !== true;

  return (
    <section
      aria-label={labels.aria}
      aria-busy={loading}
      data-lumi-core-command-field
      data-lumi-core-field-state={state}
      data-lumi-core-loading={loading ? 'true' : 'false'}
      data-lumi-core-active-tasks={activeTasks.length}
      className="lumi-core-command-field relative h-full min-h-[420px] overflow-hidden"
    >
      <div className="lumi-core-command-field__backdrop" aria-hidden="true">
        <div className="lumi-core-command-field__nebula lumi-core-command-field__nebula--violet" />
        <div className="lumi-core-command-field__nebula lumi-core-command-field__nebula--cyan" />
        <div className="lumi-core-command-field__nebula lumi-core-command-field__nebula--rose" />
        <div className="lumi-core-command-field__horizon" />
        <div className="lumi-core-command-field__stars lumi-core-command-field__stars--far">
          {COSMOS_STARS.filter(star => star.depth === 'far').map((star, index) => (
            <span
              key={`far-${index}`}
              className="lumi-core-command-field__star"
              style={{
                left: `${star.x}%`,
                top: `${star.y}%`,
                width: `${star.size}px`,
                height: `${star.size}px`,
                opacity: star.opacity,
                animationDelay: `${star.delay}s`,
              }}
            />
          ))}
        </div>
        <div className="lumi-core-command-field__stars lumi-core-command-field__stars--near">
          {COSMOS_STARS.filter(star => star.depth === 'near').map((star, index) => (
            <span
              key={`near-${index}`}
              className="lumi-core-command-field__star lumi-core-command-field__star--near"
              style={{
                left: `${star.x}%`,
                top: `${star.y}%`,
                width: `${star.size}px`,
                height: `${star.size}px`,
                opacity: star.opacity,
                animationDelay: `${star.delay}s`,
              }}
            />
          ))}
        </div>
      </div>

      <div className="lumi-core-command-field__hud" aria-hidden="true">
        <span className="lumi-core-command-field__hud-title">{labels.lumiCore}</span>
        <span className="lumi-core-command-field__hud-divider" />
        <span className="lumi-core-command-field__hud-state">
          <span className="lumi-core-command-field__hud-dot" style={{ backgroundColor: coreColor, boxShadow: `0 0 12px ${coreColor}` }} />
          {stateLabel}
        </span>
      </div>
      <div className="lumi-core-command-field__hud-count" aria-live="polite" title={labels.aria}>
        <span>{String(activeTasks.length).padStart(2, '0')}</span>
        <span className="lumi-core-command-field__hud-count-mark" aria-hidden="true" />
      </div>

      <div className="absolute left-1/2 top-[53%] h-[min(76vw,600px)] w-[min(76vw,600px)] -translate-x-1/2 -translate-y-1/2">
        <div className="lumi-core-command-field__grid" aria-hidden="true" />
        <svg className="lumi-core-command-field__routes" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
          <ellipse cx="50" cy="50" rx="46" ry="26" />
          <ellipse cx="50" cy="50" rx="43" ry="34" transform="rotate(-28 50 50)" />
          <path d="M6 58C25 18 66 8 94 43" />
          <path d="M13 35C37 78 67 86 92 62" />
        </svg>
        {[0, 1, 2].map(index => (
          <motion.div
            key={index}
            className={`lumi-core-command-field__orbit lumi-core-command-field__orbit--${index} absolute rounded-full border`}
            style={{
              inset: `${index * 12 + 4}%`,
              borderColor: `${coreColor}${index === 0 ? '24' : '16'}`,
              boxShadow: index === 1 ? `0 0 36px ${coreColor}12 inset` : undefined,
            }}
            animate={motionEnabled ? { rotate: index % 2 === 0 ? 360 : -360 } : { rotate: 0 }}
            transition={motionEnabled ? { duration: 34 + index * 13, repeat: Infinity, ease: 'linear' } : { duration: 0 }}
          >
            <span className="lumi-core-command-field__orbit-marker absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ backgroundColor: coreColor, boxShadow: `0 0 12px ${coreColor}` }} />
          </motion.div>
        ))}

        <motion.div
          className="lumi-core-command-field__core absolute left-1/2 top-1/2 z-10 h-[58%] w-[58%] -translate-x-1/2 -translate-y-1/2"
          animate={motionEnabled ? { x: [-8, 8, -8], y: [5, -7, 5] } : { x: 0, y: 0 }}
          transition={motionEnabled ? { duration: 7.5, repeat: Infinity, ease: 'easeInOut' } : { duration: 0 }}
        >
          <div className="lumi-core-command-field__core-aura" style={{ background: `radial-gradient(circle, ${coreColor}2e 0%, ${coreColor}08 42%, transparent 72%)` }} />
          <LumiCoreOrb
            sentiment={state === 'attention' ? 'excited' : state === 'working' ? 'focused' : 'default'}
            callState={state === 'working' ? 'thinking' : 'idle'}
            className="h-full w-full"
          />
        </motion.div>
        <div className="lumi-core-command-field__core-label absolute left-1/2 top-[70%] z-20 -translate-x-1/2 rounded-2xl border px-4 py-2 text-center shadow-xl backdrop-blur-xl">
          <div className="text-[9px] font-black uppercase tracking-[0.28em] text-white/48">{labels.lumiCore}</div>
          <div className="mt-1 flex items-center justify-center gap-1.5 text-[10px] font-bold text-white/72">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: coreColor, boxShadow: `0 0 10px ${coreColor}` }} />
            {stateLabel}
          </div>
          <div className="mt-1 font-mono text-[8px] tracking-[0.18em] text-white/30">{String(activeTasks.length).padStart(2, '0')}</div>
        </div>

        {activeTasks.map((task, index) => {
          const angle = (Math.PI * 2 * index) / Math.max(activeTasks.length, 1) - Math.PI / 2;
          const radius = 43 + (index % 2) * 7;
          const x = 50 + Math.cos(angle) * radius;
          const y = 50 + Math.sin(angle) * radius;
          const color = TASK_COLORS[task.state];
          return (
            <motion.div
              key={task.id}
              className="lumi-core-command-field__beacon absolute z-20 flex max-w-[150px] items-center gap-1.5 rounded-xl border px-2.5 py-2 text-[9px] font-bold text-white/72 shadow-xl backdrop-blur-xl"
              data-task-state={task.state}
              style={{
                left: `${x}%`,
                top: `${y}%`,
                translateX: '-50%',
                translateY: '-50%',
                borderColor: `${color}55`,
                '--beacon-color': color,
              } as CSSProperties}
              initial={reducedMotion ? false : { opacity: 0, scale: 0.8 }}
              animate={motionEnabled ? { opacity: 1, scale: 1, y: [0, index % 2 ? 5 : -5, 0] } : { opacity: 1, scale: 1, y: 0 }}
              transition={motionEnabled
                ? { opacity: { duration: 0.25 }, scale: { duration: 0.25 }, y: { duration: 4 + index * 0.25, repeat: Infinity, ease: 'easeInOut' } }
                : { duration: 0 }}
              title={task.title}
            >
              <span className="lumi-core-command-field__beacon-dot shrink-0" style={{ color }}><TaskIcon state={task.state} /></span>
              <span className="truncate">{task.title}</span>
            </motion.div>
          );
        })}
      </div>

      {!loading && activeTasks.length === 0 && (
        <div className="lumi-core-command-field__empty absolute bottom-20 left-1/2 -translate-x-1/2 rounded-full border px-3 py-1.5 text-[9px] backdrop-blur-xl">
          {labels.noTasks}
        </div>
      )}
    </section>
  );
}
