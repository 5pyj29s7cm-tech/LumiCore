import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Radio } from 'lucide-react';
import { AgentOfficeWorld, type OfficeWorker } from './AgentOfficeWorld';

export type { OfficeWorker } from './AgentOfficeWorld';

type OfficeLabels = {
  aria: string;
  liveState: string;
  currentFloor: string;
  previousFloor: string;
  nextFloor: string;
  noWorkers: string;
  lumi: string;
  active: string;
  dispatching: string;
  ready: string;
  working: string;
  paused: string;
  attention: string;
};

const FLOOR_SIZE = 5;

export function AgentOfficeScene({
  workers,
  lumiState,
  activeTasks,
  labels,
}: {
  workers: OfficeWorker[];
  lumiState: 'ready' | 'working' | 'attention';
  activeTasks: number;
  labels: OfficeLabels;
}) {
  const [floor, setFloor] = useState(0);
  const floorCount = Math.max(1, Math.ceil(workers.length / FLOOR_SIZE));
  useEffect(() => setFloor(current => Math.min(current, floorCount - 1)), [floorCount]);
  const visibleWorkers = useMemo(() => workers.slice(floor * FLOOR_SIZE, (floor + 1) * FLOOR_SIZE), [floor, workers]);
  const workingCount = workers.filter(worker => worker.state === 'working').length;

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden" aria-label={labels.aria}>
      <div className="pointer-events-none absolute left-5 top-5 z-20 flex items-center gap-2">
        <div className="lumi-office-live-chip flex min-w-0 items-center gap-2 rounded-2xl px-3 py-2">
          <span className="relative flex h-8 w-8 items-center justify-center rounded-xl border border-cyan-300/15 bg-cyan-400/[0.08] text-cyan-200">
            <Radio size={14} className={lumiState === 'working' ? 'animate-pulse' : ''} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[11px] font-black tracking-[0.05em] text-white/72">{labels.liveState}</div>
            <div className="mt-0.5 text-[9px] text-white/30">{activeTasks} {labels.active} · {workingCount} {labels.working}</div>
          </div>
        </div>
        {floorCount > 1 && (
        <div className="lumi-office-floor-switch pointer-events-auto flex items-center gap-1 rounded-xl p-0.5">
          <button type="button" aria-label={labels.previousFloor} disabled={floor === 0} onClick={() => setFloor(value => Math.max(0, value - 1))} className="flex h-7 w-7 items-center justify-center rounded-lg disabled:opacity-20"><ChevronLeft size={13} /></button>
          <span className="min-w-[64px] text-center text-[9px] font-bold">{labels.currentFloor} {floor + 1}/{floorCount}</span>
          <button type="button" aria-label={labels.nextFloor} disabled={floor >= floorCount - 1} onClick={() => setFloor(value => Math.min(floorCount - 1, value + 1))} className="flex h-7 w-7 items-center justify-center rounded-lg disabled:opacity-20"><ChevronRight size={13} /></button>
        </div>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AgentOfficeWorld workers={visibleWorkers} lumiState={lumiState} labels={labels} />
        {workers.length === 0 && <div className="lumi-office-empty-note">{labels.noWorkers}</div>}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[#0b161c]/45 to-transparent" />
      </div>
    </section>
  );
}
