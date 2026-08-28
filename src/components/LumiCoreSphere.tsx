import { motion } from 'motion/react';
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
  const activeTasks = tasks.filter(task => task.active).slice(0, 8);
  const stateLabel = state === 'working' ? labels.working : state === 'attention' ? labels.attention : labels.ready;
  const coreColor = state === 'attention' ? '#fb7185' : state === 'working' ? '#67e8f9' : '#a78bfa';

  return (
    <section
      aria-label={labels.aria}
      className="relative h-full min-h-[420px] overflow-hidden bg-[radial-gradient(circle_at_50%_42%,rgba(56,189,248,0.10),transparent_27%),radial-gradient(circle_at_50%_50%,#0b1022_0%,#050713_46%,#010208_100%)]"
    >
      <div className="absolute inset-0 opacity-70 [background-image:radial-gradient(rgba(255,255,255,0.85)_0.7px,transparent_0.7px)] [background-size:37px_37px]" />
      <motion.div
        className="absolute left-[8%] top-[14%] h-24 w-24 rounded-full bg-violet-400/10 blur-3xl"
        animate={{ x: [0, 42, 0], y: [0, -18, 0], opacity: [0.25, 0.48, 0.25] }}
        transition={{ duration: 11, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute bottom-[10%] right-[7%] h-28 w-28 rounded-full bg-cyan-300/10 blur-3xl"
        animate={{ x: [0, -38, 0], y: [0, 20, 0], opacity: [0.2, 0.42, 0.2] }}
        transition={{ duration: 13, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="absolute left-1/2 top-1/2 h-[min(72vw,520px)] w-[min(72vw,520px)] -translate-x-1/2 -translate-y-1/2">
        {[0, 1, 2].map(index => (
          <motion.div
            key={index}
            className="absolute rounded-full border"
            style={{
              inset: `${index * 12 + 4}%`,
              borderColor: `${coreColor}${index === 0 ? '24' : '16'}`,
              boxShadow: index === 1 ? `0 0 36px ${coreColor}12 inset` : undefined,
            }}
            animate={{ rotate: index % 2 === 0 ? 360 : -360 }}
            transition={{ duration: 34 + index * 13, repeat: Infinity, ease: 'linear' }}
          >
            <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ backgroundColor: coreColor, boxShadow: `0 0 12px ${coreColor}` }} />
          </motion.div>
        ))}

        <motion.div
          className="absolute left-1/2 top-1/2 z-10 h-[58%] w-[58%] -translate-x-1/2 -translate-y-1/2"
          animate={{ x: [-8, 8, -8], y: [5, -7, 5] }}
          transition={{ duration: 7.5, repeat: Infinity, ease: 'easeInOut' }}
        >
          <LumiCoreOrb
            sentiment={state === 'attention' ? 'excited' : state === 'working' ? 'focused' : 'default'}
            callState={state === 'working' ? 'thinking' : 'idle'}
            className="h-full w-full"
          />
        </motion.div>
        <div className="absolute left-1/2 top-[70%] z-20 -translate-x-1/2 rounded-2xl border border-white/[0.07] bg-[#050915]/60 px-4 py-2 text-center shadow-xl backdrop-blur-xl">
          <div className="text-[9px] font-black uppercase tracking-[0.28em] text-white/48">{labels.lumiCore}</div>
          <div className="mt-1 text-[10px] font-bold text-white/72">{stateLabel}</div>
          <div className="mt-0.5 font-mono text-[8px] text-white/30">{activeTasks.length} active</div>
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
              className="absolute z-20 flex max-w-[132px] items-center gap-1.5 rounded-xl border bg-[#060a16]/82 px-2.5 py-2 text-[9px] font-bold text-white/72 shadow-xl backdrop-blur-xl"
              style={{ left: `${x}%`, top: `${y}%`, translateX: '-50%', translateY: '-50%', borderColor: `${color}40` }}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1, y: [0, index % 2 ? 5 : -5, 0] }}
              transition={{ opacity: { duration: 0.25 }, scale: { duration: 0.25 }, y: { duration: 4 + index * 0.25, repeat: Infinity, ease: 'easeInOut' } }}
              title={task.title}
            >
              <span className="shrink-0" style={{ color }}><TaskIcon state={task.state} /></span>
              <span className="truncate">{task.title}</span>
            </motion.div>
          );
        })}
      </div>

      {!loading && activeTasks.length === 0 && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 rounded-full border border-white/[0.08] bg-black/25 px-3 py-1.5 text-[9px] text-white/30 backdrop-blur-xl">
          {labels.noTasks}
        </div>
      )}
    </section>
  );
}
