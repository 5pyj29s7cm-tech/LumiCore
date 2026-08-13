import React, { useId, useMemo, useState } from 'react';

export type OfficeWorkerState = 'ready' | 'working' | 'paused' | 'attention';

export type OfficeWorker = {
  id: string;
  name: string;
  category: string;
  runtime: 'internal' | 'external';
  state: OfficeWorkerState;
  taskTitle?: string;
};

type Point = [number, number];

type OfficeLabels = {
  lumi: string;
  dispatching: string;
  ready: string;
  working: string;
  paused: string;
  attention: string;
};

const workstationPositions: Point[] = [
  [74, 27],
  [49, 51], [74, 51],
  [49, 76], [74, 76],
];

const attentionPositions: Point[] = [
  [54, 30],
  [48, 37], [59, 39],
  [51, 47], [62, 49],
];

const activityRoutes: Array<{ start: Point; travel: Point }> = [
  { start: [40, 47], travel: [0, 15] },
  { start: [49, 51], travel: [0, 0] },
  { start: [74, 51], travel: [0, 0] },
  { start: [16, 75], travel: [9, -4] },
  { start: [74, 76], travel: [0, 0] },
];

const NODE_ACCENTS = ['#64e6eb', '#8ad7ff', '#7edfc1', '#d3b5ff', '#f0cd7d', '#8bb4ff'];

function clampText(value: string, max = 18): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function stateColor(state: OfficeWorkerState, runtime: OfficeWorker['runtime'], index: number): string {
  if (state === 'attention') return '#f0cc83';
  if (state === 'paused') return '#8294a6';
  if (runtime === 'external') return '#b5a3ed';
  return NODE_ACCENTS[index % NODE_ACCENTS.length];
}

function statusLabel(worker: OfficeWorker, labels: OfficeLabels): string {
  if (worker.state === 'working') return worker.taskTitle || labels.working;
  if (worker.state === 'attention') return labels.attention;
  if (worker.state === 'paused') return labels.paused;
  return labels.ready;
}

function Workstation({ worker, index }: { worker?: OfficeWorker; index: number }) {
  const position = workstationPositions[index];
  const color = worker ? stateColor(worker.state, worker.runtime, index) : '#9ba5a6';
  return <div
    className={`lumi-2d-workstation ${worker?.state === 'working' ? 'is-active' : ''} ${worker ? 'is-occupied' : 'is-vacant'}`}
    style={{ left: `${position[0]}%`, top: `${position[1]}%`, '--node-accent': color } as React.CSSProperties}
    aria-hidden="true"
  >
    <span className="lumi-2d-workstation__desk"><i /><i /></span>
    <span className="lumi-2d-workstation__screen"><i /><i /><i /><b /></span>
    <span className="lumi-2d-workstation__keyboard" />
    <span className="lumi-2d-workstation__mug" />
    {!worker && <span className="lumi-2d-workstation__vacancy"><i /></span>}
  </div>;
}

function OfficeChair({ worker, index }: { worker?: OfficeWorker; index: number }) {
  const position = workstationPositions[index];
  const color = worker ? stateColor(worker.state, worker.runtime, index) : '#9ba5a6';
  return <div
    className={`lumi-2d-chair ${worker?.state === 'working' ? 'is-active' : ''} ${worker ? 'is-occupied' : 'is-vacant'}`}
    style={{ left: `${position[0]}%`, top: `${position[1]}%`, '--node-accent': color } as React.CSSProperties}
    aria-hidden="true"
  ><span><i /></span></div>;
}

function LumiWisp({ state, leader = false }: { state: OfficeWorkerState; leader?: boolean }) {
  const id = useId().replace(/:/g, '');
  const bodyGradient = `lumi-wisp-body-${id}`;
  const glowGradient = `lumi-wisp-glow-${id}`;
  return <div className={`lumi-wisp lumi-wisp--${state} ${leader ? 'lumi-wisp--leader' : ''}`} aria-hidden="true">
    <svg className="lumi-wisp__art" viewBox="0 0 160 190" role="presentation">
      <defs>
        <linearGradient id={bodyGradient} x1="35" y1="30" x2="126" y2="158" gradientUnits="userSpaceOnUse">
          <stop stopColor="#294751" />
          <stop offset="0.52" stopColor="#132c36" />
          <stop offset="1" stopColor="#071923" />
        </linearGradient>
        <radialGradient id={glowGradient} cx="0" cy="0" r="1" gradientTransform="translate(80 91) rotate(90) scale(74 68)" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--node-accent)" stopOpacity="0.18" />
          <stop offset="1" stopColor="var(--node-accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse className="lumi-wisp__ground" cx="80" cy="169" rx="45" ry="10" />
      <ellipse className="lumi-wisp__aura" cx="80" cy="94" rx="68" ry="74" fill={`url(#${glowGradient})`} />
      <path className="lumi-wisp__tail-shape" d="M109 132c27 1 39 18 28 32-9 12-31 11-42-1 18 4 27-7 14-31Z" />
      <g className="lumi-wisp__tendril lumi-wisp__tendril--left">
        <path d="M49 105c-19 7-26 20-20 35" />
        <circle cx="29" cy="141" r="6" />
      </g>
      <g className="lumi-wisp__tendril lumi-wisp__tendril--right">
        <path d="M111 105c19 7 26 20 20 35" />
        <circle cx="131" cy="141" r="6" />
      </g>
      <g className="lumi-wisp__step lumi-wisp__step--left">
        <path d="M63 139c-6 13-7 23-3 30" />
        <path d="M58 169c-10 2-13 8-2 9h14" />
      </g>
      <g className="lumi-wisp__step lumi-wisp__step--right">
        <path d="M97 139c6 13 7 23 3 30" />
        <path d="M102 169c10 2 13 8 2 9H90" />
      </g>
      <g className="lumi-wisp__form">
        <path className="lumi-wisp__shell" d="M43 57C50 35 72 25 97 34c16 6 28 0 34-17 3 16-5 31-18 40 15 14 21 34 18 57-5 31-24 47-53 47-31 0-51-21-51-55 0-21 5-37 16-49Z" fill={`url(#${bodyGradient})`} />
        <path className="lumi-wisp__highlight" d="M47 64c11-18 33-24 54-15" />
        <g className="lumi-wisp__eyes">
          <ellipse cx="59" cy="84" rx="8" ry="12" />
          <ellipse cx="96" cy="84" rx="8" ry="12" />
          <circle cx="62" cy="80" r="2.5" />
          <circle cx="99" cy="80" r="2.5" />
        </g>
        <path className="lumi-wisp__expression" d="M70 104c5 4 11 4 16 0" />
        <g className="lumi-wisp__stars">
          <circle cx="56" cy="128" r="3.5" />
          <circle cx="78" cy="119" r="4.5" />
          <circle cx="103" cy="132" r="3" />
          <path d="m59 127 15-7m8 1 18 9" />
        </g>
      </g>
    </svg>
    {leader && <span className="lumi-wisp__crown"><i /><i /><i /></span>}
    {state === 'paused' && <span className="lumi-wisp__rest-mark">z</span>}
  </div>;
}

function Employee({ worker, index, labels }: { worker: OfficeWorker; index: number; labels: OfficeLabels }) {
  const [hovered, setHovered] = useState(false);
  const station = workstationPositions[index];
  const attention = attentionPositions[index];
  const route = activityRoutes[index];
  const isExploring = worker.state === 'ready' && (index === 0 || index === 3);
  const position = worker.state === 'attention' ? attention : isExploring ? route.start : station;
  const color = stateColor(worker.state, worker.runtime, index);
  const roaming = isExploring;
  const seated = !roaming && worker.state !== 'attention';
  const style = {
    left: `${position[0]}%`,
    top: `${position[1]}%`,
    '--node-accent': color,
    '--roam-x': `${route.travel[0]}vw`,
    '--roam-y': `${route.travel[1]}vh`,
    '--roam-delay': `${-(index * 2.7)}s`,
    '--roam-duration': `${20 + index * 1.7}s`,
    '--node-index': index,
  } as React.CSSProperties;

  return <div
    className={`lumi-2d-node ${roaming ? 'lumi-2d-node--roaming' : ''} ${seated ? 'lumi-2d-node--seated' : ''} lumi-2d-node--${worker.state}`}
    style={style}
    onPointerEnter={() => setHovered(true)}
    onPointerLeave={() => setHovered(false)}
  >
    <div className="lumi-2d-node__body">
      <LumiWisp state={worker.state} />
      <span className="lumi-2d-node__name">{clampText(worker.name, 15)}</span>
      {(hovered || worker.state !== 'ready') && <span className="lumi-2d-node__status">{clampText(statusLabel(worker, labels), 22)}</span>}
    </div>
  </div>;
}

function LumiCommander({ state, labels }: { state: 'ready' | 'working' | 'attention'; labels: OfficeLabels }) {
  const status = state === 'attention' ? labels.attention : state === 'working' ? labels.dispatching : labels.ready;
  return <div className={`lumi-private-office lumi-2d-commander--${state}`}>
    <span className="lumi-private-office__glass lumi-private-office__glass--front"><i /></span>
    <span className="lumi-private-office__glass lumi-private-office__glass--side" />
    <span className="lumi-private-office__door"><i /></span>
    <span className="lumi-private-office__title"><strong>{labels.lumi}</strong><small>{status}</small></span>
    <span className="lumi-private-office__command-wall"><i /><i /><i /></span>
    <span className="lumi-private-office__desk"><i /><i /><b /></span>
    <span className="lumi-private-office__guest-seat lumi-private-office__guest-seat--left" />
    <span className="lumi-private-office__guest-seat lumi-private-office__guest-seat--right" />
    <div className="lumi-private-office__commander"><LumiWisp state={state} leader /></div>
  </div>;
}

function TaskDispatchLayer({ workers }: { workers: OfficeWorker[] }) {
  const paths = useMemo(() => workers.map((worker, index) => {
    const [x, y] = workstationPositions[index];
    return { worker, index, endX: x * 10, endY: y * 7 };
  }), [workers]);

  return <svg className="lumi-2d-dispatch" viewBox="0 0 1000 700" preserveAspectRatio="none" aria-hidden="true">
    {paths.map(({ worker, index, endX, endY }) => worker.state === 'working' && <g key={worker.id}>
      <path className="lumi-2d-dispatch__trail" d={`M 345 210 Q ${345 + (endX - 345) * 0.45} ${235 + index * 13} ${endX} ${endY}`} />
      <circle className="lumi-2d-dispatch__packet" r="4.5">
        <animateMotion dur={`${2.8 + index * 0.18}s`} repeatCount="indefinite" path={`M 345 210 Q ${345 + (endX - 345) * 0.45} ${235 + index * 13} ${endX} ${endY}`} />
      </circle>
    </g>)}
  </svg>;
}

function OfficeLife() {
  return <div className="lumi-office-life" aria-hidden="true">
    <div className="lumi-office-life__social-rug" />
    <div className="lumi-office-life__work-rug" />
    <div className="lumi-office-life__cafe"><span /><i /><b /></div>
    <div className="lumi-office-life__library"><i /><i /><i /><span /></div>
    <div className="lumi-office-life__treadmill"><span /><i /><b /></div>
    <div className="lumi-office-life__lounge"><span /><i /></div>
    <div className="lumi-office-life__meeting"><span /><i /><b /></div>
    <div className="lumi-office-life__floor-lamp"><span /><i /></div>
    <div className="lumi-office-life__plant"><span /><i /><b /></div>
    <div className="lumi-office-life__team-sign"><strong>LUMI</strong><span>STUDIO</span></div>
    <div className="lumi-office-life__walkway"><i /><i /><i /></div>
  </div>;
}

function OfficeMap() {
  return <>
    <svg className="lumi-2d-map" viewBox="0 0 1000 700" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="office-floor" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#111f25" /><stop offset="0.48" stopColor="#0b171d" /><stop offset="1" stopColor="#071116" /></linearGradient>
        <radialGradient id="office-warm-pool"><stop stopColor="#ff7a2f" stopOpacity="0.15" /><stop offset="1" stopColor="#ff7a2f" stopOpacity="0" /></radialGradient>
        <radialGradient id="office-cool-pool"><stop stopColor="#20d9d2" stopOpacity="0.105" /><stop offset="1" stopColor="#20d9d2" stopOpacity="0" /></radialGradient>
        <radialGradient id="office-focus-pool"><stop stopColor="#74ebe5" stopOpacity="0.055" /><stop offset="1" stopColor="#74ebe5" stopOpacity="0" /></radialGradient>
      </defs>
      <rect width="1000" height="700" fill="url(#office-floor)" opacity="0.72" />
      <ellipse cx="218" cy="218" rx="226" ry="188" fill="url(#office-warm-pool)" />
      <ellipse cx="684" cy="345" rx="340" ry="300" fill="url(#office-cool-pool)" />
      <ellipse cx="720" cy="360" rx="250" ry="260" fill="url(#office-focus-pool)" />
    </svg>
    <OfficeLife />
  </>;
}

export function AgentOfficeWorld({ workers, lumiState, labels }: { workers: OfficeWorker[]; lumiState: 'ready' | 'working' | 'attention'; labels: OfficeLabels }) {
  const officeSlots = workstationPositions.map((_, index) => workers[index]);
  return <div className="lumi-2d-world">
    <OfficeMap />
    <TaskDispatchLayer workers={workers} />
    <LumiCommander state={lumiState} labels={labels} />
    {officeSlots.map((worker, index) => <React.Fragment key={worker?.id || `vacant-${index}`}>
      <Workstation worker={worker} index={index} />
      {worker && <Employee worker={worker} index={index} labels={labels} />}
      <OfficeChair worker={worker} index={index} />
    </React.Fragment>)}
    <div className="lumi-2d-world__vignette" aria-hidden="true" />
  </div>;
}
