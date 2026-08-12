import React, { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Html, Line, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';

export type OfficeWorkerState = 'ready' | 'working' | 'paused' | 'attention';

export type OfficeWorker = {
  id: string;
  name: string;
  category: string;
  runtime: 'internal' | 'external';
  state: OfficeWorkerState;
  taskTitle?: string;
};

const deskPositions: Array<[number, number, number]> = [
  [-2.45, 0, -0.75], [2.45, 0, -0.75],
  [-2.45, 0, 1.75], [2.45, 0, 1.75],
  [-2.45, 0, 4.25], [2.45, 0, 4.25],
];

const leisurePositions: Array<[number, number, number]> = [
  [-5.25, 0, -2.35], [5.15, 0, -2.25],
  [-5.15, 0, 1.25], [5.15, 0, 1.35],
  [-4.25, 0, 4.5], [4.25, 0, 4.5],
];

const palettes = [
  ['#22d3ee', '#172554', '#efb891'],
  ['#a78bfa', '#3b1d4a', '#d99b74'],
  ['#34d399', '#173a34', '#8f5e42'],
  ['#fb7185', '#431d28', '#efc19b'],
  ['#fbbf24', '#3b2c16', '#b87954'],
  ['#60a5fa', '#172d4d', '#e7ae86'],
];

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) result = ((result << 5) - result + value.charCodeAt(index)) | 0;
  return Math.abs(result);
}

function short(value: string, max = 18): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function stateColor(state: OfficeWorkerState): string {
  if (state === 'working') return '#22d3ee';
  if (state === 'attention') return '#fbbf24';
  if (state === 'paused') return '#64748b';
  return '#34d399';
}

function Desk({ position, active, external }: { position: [number, number, number]; active: boolean; external: boolean }) {
  const screen = external ? '#8b5cf6' : '#22d3ee';
  return (
    <group position={position}>
      <RoundedBox args={[2.35, 0.16, 0.9]} radius={0.08} position={[0, 0.95, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#243348" roughness={0.58} />
      </RoundedBox>
      <mesh position={[-0.92, 0.48, 0]} castShadow><boxGeometry args={[0.12, 0.95, 0.68]} /><meshStandardMaterial color="#31435b" /></mesh>
      <mesh position={[0.92, 0.48, 0]} castShadow><boxGeometry args={[0.12, 0.95, 0.68]} /><meshStandardMaterial color="#31435b" /></mesh>
      <RoundedBox args={[1.15, 0.72, 0.1]} radius={0.04} position={[0, 1.42, -0.17]} castShadow>
        <meshStandardMaterial color="#030711" emissive={screen} emissiveIntensity={active ? 0.6 : 0.04} />
      </RoundedBox>
      <mesh position={[0, 1.03, -0.17]}><boxGeometry args={[0.1, 0.22, 0.1]} /><meshStandardMaterial color="#64748b" /></mesh>
      <mesh position={[0, 0.96, 0.05]}><boxGeometry args={[0.82, 0.035, 0.28]} /><meshStandardMaterial color="#94a3b8" /></mesh>
      <mesh position={[0.78, 1.08, 0.08]} castShadow><cylinderGeometry args={[0.13, 0.11, 0.2, 18]} /><meshStandardMaterial color={screen} opacity={0.75} transparent /></mesh>
      <RoundedBox args={[0.82, 0.15, 0.78]} radius={0.09} position={[0, 0.5, 0.85]} castShadow>
        <meshStandardMaterial color="#1c2a3e" />
      </RoundedBox>
      <mesh position={[0, 0.2, 0.85]}><cylinderGeometry args={[0.08, 0.08, 0.6, 12]} /><meshStandardMaterial color="#475569" /></mesh>
    </group>
  );
}

function Avatar({ worker, index }: { worker: OfficeWorker; index: number }) {
  const group = useRef<THREE.Group>(null);
  const walkOrigin = useRef(new THREE.Vector3());
  const leftArm = useRef<THREE.Mesh>(null);
  const rightArm = useRef<THREE.Mesh>(null);
  const leftLeg = useRef<THREE.Mesh>(null);
  const rightLeg = useRef<THREE.Mesh>(null);
  const palette = palettes[hash(worker.id) % palettes.length];
  const working = worker.state === 'working';
  const attention = worker.state === 'attention';
  const desk = deskPositions[index];
  const leisure = leisurePositions[index];
  const target = useMemo(() => new THREE.Vector3(
    working ? desk[0] : attention ? desk[0] + (desk[0] < 0 ? 1.45 : -1.45) : leisure[0],
    0,
    working ? desk[2] + 0.82 : attention ? desk[2] + 0.45 : leisure[2],
  ), [attention, desk, leisure, working]);

  useFrame(({ clock }, delta) => {
    const node = group.current;
    if (!node) return;
    const time = clock.elapsedTime + index * 0.73;
    walkOrigin.current.copy(target);
    const roaming = !working && !attention && index >= 4;
    if (roaming) {
      walkOrigin.current.x += Math.sin(time * 0.42) * 1.05;
      walkOrigin.current.z += Math.cos(time * 0.34) * 0.52;
    }
    node.position.lerp(walkOrigin.current, Math.min(1, delta * 2.4));
    const movement = working ? Math.sin(time * 8) * 0.14 : Math.sin(time * 2.1) * 0.08;
    node.position.y = worker.state === 'paused' ? -0.05 : Math.max(0, movement * 0.16);
    node.rotation.y = working ? Math.PI : roaming ? Math.sin(time * 0.42) > 0 ? -Math.PI / 2 : Math.PI / 2 : Math.sin(time * 0.42) * 0.1;
    if (leftArm.current && rightArm.current) {
      leftArm.current.rotation.x = working ? -0.82 + movement : movement;
      rightArm.current.rotation.x = working ? -0.82 - movement : -movement;
    }
    if (leftLeg.current && rightLeg.current) {
      const walking = !working && (index === 1 || index >= 4);
      leftLeg.current.rotation.x = walking ? Math.sin(time * 4) * 0.35 : 0;
      rightLeg.current.rotation.x = walking ? -Math.sin(time * 4) * 0.35 : 0;
    }
  });

  return (
    <group ref={group} scale={worker.state === 'paused' ? 0.94 : 1}>
      <mesh position={[0, 1.55, 0]} castShadow><sphereGeometry args={[0.28, 24, 18]} /><meshStandardMaterial color={palette[2]} /></mesh>
      <mesh position={[0, 1.69, -0.02]} castShadow><sphereGeometry args={[0.29, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.55]} /><meshStandardMaterial color={palette[1]} /></mesh>
      <mesh position={[-0.1, 1.57, 0.25]}><sphereGeometry args={[0.026, 10, 8]} /><meshStandardMaterial color="#111827" /></mesh>
      <mesh position={[0.1, 1.57, 0.25]}><sphereGeometry args={[0.026, 10, 8]} /><meshStandardMaterial color="#111827" /></mesh>
      <RoundedBox args={[0.58, 0.75, 0.38]} radius={0.16} position={[0, 1.03, 0]} castShadow>
        <meshStandardMaterial color={palette[0]} roughness={0.62} />
      </RoundedBox>
      <mesh ref={leftArm} position={[-0.38, 1.09, 0]} rotation={[0, 0, -0.12]} castShadow><capsuleGeometry args={[0.08, 0.46, 8, 12]} /><meshStandardMaterial color={palette[2]} /></mesh>
      <mesh ref={rightArm} position={[0.38, 1.09, 0]} rotation={[0, 0, 0.12]} castShadow><capsuleGeometry args={[0.08, 0.46, 8, 12]} /><meshStandardMaterial color={palette[2]} /></mesh>
      <mesh ref={leftLeg} position={[-0.16, 0.46, 0]} castShadow><capsuleGeometry args={[0.1, 0.48, 8, 12]} /><meshStandardMaterial color="#334155" /></mesh>
      <mesh ref={rightLeg} position={[0.16, 0.46, 0]} castShadow><capsuleGeometry args={[0.1, 0.48, 8, 12]} /><meshStandardMaterial color="#334155" /></mesh>
      <mesh position={[0.35, 1.83, 0]}><sphereGeometry args={[0.09, 16, 12]} /><meshStandardMaterial color={stateColor(worker.state)} emissive={stateColor(worker.state)} emissiveIntensity={0.42} /></mesh>
      <Html center position={[0, 2.25, 0]} distanceFactor={9} style={{ pointerEvents: 'none' }}>
        <div className="whitespace-nowrap rounded-xl border border-white/10 bg-[#06101b]/88 px-2.5 py-1.5 text-center shadow-xl backdrop-blur-md">
          <div className="text-[11px] font-black text-white/90">{short(worker.name)}</div>
          <div className="mt-0.5 max-w-[150px] truncate text-[9px] font-bold" style={{ color: stateColor(worker.state) }}>{short(working && worker.taskTitle ? worker.taskTitle : worker.category, 25)}</div>
        </div>
      </Html>
    </group>
  );
}

function LumiCommander({ state, label, status }: { state: 'ready' | 'working' | 'attention'; label: string; status: string }) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!group.current) return;
    const intensity = state === 'working' ? 5 : 1.8;
    group.current.position.y = Math.sin(clock.elapsedTime * intensity) * (state === 'working' ? 0.025 : 0.012);
  });
  const color = state === 'attention' ? '#fbbf24' : '#22d3ee';
  return (
    <group position={[0, 0, -3.1]}>
      <Desk position={[0, 0, 0]} active={state === 'working'} external={false} />
      <group ref={group} position={[0, 0, 0.82]}>
        <mesh position={[0, 1.65, 0]} castShadow><sphereGeometry args={[0.32, 28, 20]} /><meshStandardMaterial color="#f0bd96" /></mesh>
        <mesh position={[0, 1.81, -0.02]} castShadow><sphereGeometry args={[0.33, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.52]} /><meshStandardMaterial color="#e2e8f0" /></mesh>
        <RoundedBox args={[0.68, 0.84, 0.42]} radius={0.18} position={[0, 1.07, 0]} castShadow><meshStandardMaterial color="#0891b2" emissive={color} emissiveIntensity={0.1} /></RoundedBox>
        <mesh position={[-0.42, 1.1, 0]} rotation={[state === 'working' ? -0.8 : 0, 0, -0.15]}><capsuleGeometry args={[0.09, 0.5, 8, 12]} /><meshStandardMaterial color="#f0bd96" /></mesh>
        <mesh position={[0.42, 1.1, 0]} rotation={[state === 'working' ? -0.8 : 0, 0, 0.15]}><capsuleGeometry args={[0.09, 0.5, 8, 12]} /><meshStandardMaterial color="#f0bd96" /></mesh>
        <mesh position={[0, 0.47, 0]}><capsuleGeometry args={[0.13, 0.52, 8, 12]} /><meshStandardMaterial color="#334155" /></mesh>
      </group>
      <Html center position={[0, 2.55, 0]} distanceFactor={8} style={{ pointerEvents: 'none' }}>
        <div className="whitespace-nowrap rounded-2xl border border-cyan-300/20 bg-[#07131e]/92 px-4 py-2 text-center shadow-[0_0_28px_rgba(34,211,238,.18)] backdrop-blur-md">
          <div className="text-[13px] font-black text-white">{label}</div>
          <div className="mt-0.5 text-[10px] font-bold" style={{ color }}>{status}</div>
        </div>
      </Html>
    </group>
  );
}

function CoffeeCorner() {
  return <group position={[-5.2, 0, -2.45]}>
    <RoundedBox args={[1.7, 1.25, 0.75]} radius={0.12} position={[0, 0.64, 0]} castShadow><meshStandardMaterial color="#182638" /></RoundedBox>
    <RoundedBox args={[0.62, 0.68, 0.52]} radius={0.08} position={[-0.28, 1.52, 0]} castShadow><meshStandardMaterial color="#334155" /></RoundedBox>
    <mesh position={[0.38, 1.35, 0.08]}><cylinderGeometry args={[0.14, 0.12, 0.28, 18]} /><meshStandardMaterial color="#a1623a" /></mesh>
    <pointLight position={[0, 2, 0]} color="#fbbf24" intensity={0.5} distance={3} />
  </group>;
}

function LeisureFurniture() {
  return <>
    <group position={[5.15, 0, -2.45]}>
      <RoundedBox args={[2.0, 0.55, 0.85]} radius={0.2} position={[0, 0.42, 0]} castShadow><meshStandardMaterial color="#283750" /></RoundedBox>
      <RoundedBox args={[2.0, 0.7, 0.24]} radius={0.12} position={[0, 0.8, -0.35]} castShadow><meshStandardMaterial color="#33445f" /></RoundedBox>
    </group>
    <group position={[-5.15, 0, 1.2]}>
      <mesh position={[0, 0.16, 0]} castShadow><boxGeometry args={[1.8, 0.18, 0.72]} /><meshStandardMaterial color="#334155" /></mesh>
      <mesh position={[0, 0.55, -0.3]} rotation={[-0.25, 0, 0]}><boxGeometry args={[0.85, 0.08, 0.42]} /><meshStandardMaterial color="#475569" /></mesh>
      <mesh position={[0, 0.7, -0.45]}><boxGeometry args={[0.95, 0.45, 0.12]} /><meshStandardMaterial color="#1e293b" /></mesh>
    </group>
    <group position={[5.15, 0, 1.25]}>
      <mesh position={[0, 0.35, 0]} castShadow><sphereGeometry args={[0.72, 28, 18]} /><meshStandardMaterial color="#29245a" roughness={0.78} /></mesh>
    </group>
  </>;
}

function DispatchBeam({ worker, index }: { worker: OfficeWorker; index: number }) {
  const orb = useRef<THREE.Mesh>(null);
  const target = deskPositions[index];
  const start = new THREE.Vector3(0, 1.35, -2.75);
  const end = new THREE.Vector3(target[0], 1.3, target[2]);
  useFrame(({ clock }) => {
    if (!orb.current || worker.state !== 'working') return;
    const progress = (clock.elapsedTime * 0.42 + index * 0.13) % 1;
    orb.current.position.lerpVectors(start, end, progress);
    orb.current.position.y += Math.sin(progress * Math.PI) * 1.15;
  });
  if (worker.state !== 'working') return null;
  return <>
    <Line points={[start, [0, 2.45, -0.6], end]} color="#22d3ee" lineWidth={1} transparent opacity={0.38} dashed dashSize={0.13} gapSize={0.1} />
    <mesh ref={orb}><sphereGeometry args={[0.09, 14, 10]} /><meshStandardMaterial color="#cffafe" emissive="#22d3ee" emissiveIntensity={1.6} /></mesh>
  </>;
}

function OfficeWorld({ workers, lumiState, labels }: { workers: OfficeWorker[]; lumiState: 'ready' | 'working' | 'attention'; labels: { lumi: string; dispatching: string; ready: string; attention: string } }) {
  return <>
    <fog attach="fog" args={['#050b13', 12, 24]} />
    <ambientLight intensity={1.15} />
    <hemisphereLight args={['#b7e9ff', '#06111c', 1.35]} />
    <directionalLight position={[4, 10, 5]} intensity={3.1} color="#edfbff" />
    <pointLight position={[0, 5, -1]} color="#22d3ee" intensity={1.7} distance={14} />
    <pointLight position={[-5, 3, 2]} color="#a78bfa" intensity={0.75} distance={7} />
    <mesh rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[15, 13]} /><meshStandardMaterial color="#0a1a29" roughness={0.88} /></mesh>
    <mesh position={[0, 2.4, -4.5]}><boxGeometry args={[15, 4.8, 0.12]} /><meshStandardMaterial color="#091624" /></mesh>
    <CoffeeCorner />
    <LeisureFurniture />
    <LumiCommander state={lumiState} label={labels.lumi} status={lumiState === 'attention' ? labels.attention : lumiState === 'working' ? labels.dispatching : labels.ready} />
    {workers.map((worker, index) => <React.Fragment key={worker.id}>
      <Desk position={deskPositions[index]} active={worker.state === 'working'} external={worker.runtime === 'external'} />
      <Avatar worker={worker} index={index} />
      <DispatchBeam worker={worker} index={index} />
    </React.Fragment>)}
  </>;
}

export function AgentOfficeWorld({ workers, lumiState, labels }: { workers: OfficeWorker[]; lumiState: 'ready' | 'working' | 'attention'; labels: { lumi: string; dispatching: string; ready: string; attention: string } }) {
  return (
    <Canvas camera={{ position: [8.6, 8.3, 13.5], fov: 37, near: 0.1, far: 100 }} dpr={1} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance', toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.28 }} style={{ background: 'transparent' }}>
      <OfficeWorld workers={workers} lumiState={lumiState} labels={labels} />
    </Canvas>
  );
}
