import { Component, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { MemoryAvatarAppearance, MemoryAvatarPresentation } from '../../shared/memory_avatar';
import { MemoryAvatarAnimatedPortrait } from './MemoryAvatarAnimatedPortrait';
import { memoryTerritoryCopy } from '../i18n/locales/memoryTerritory';
import { LumiCompanionModel } from './LumiCompanionModel';
import { LumiLayeredCharacter } from './LumiLayeredCharacter';
import { LumiHomeScene, LumiHomeCamera } from './LumiHomeScene';

export interface MemoryAvatarStageProps {
  avatarId?: string;
  presentation?: MemoryAvatarPresentation;
  appearance: MemoryAvatarAppearance;
  outputLevelRef: MutableRefObject<number>;
  state?: string;
  name: string;
  locale: 'zh' | 'en';
  active?: boolean;
}

function safeColor(value: string, fallback: string): string {
  return /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value || '') ? value : fallback;
}

function shade(value: string, toward: string, amount: number): string {
  return new THREE.Color(value).lerp(new THREE.Color(toward), amount).getStyle();
}

function gaussian(value: number, center: number, width: number): number {
  return Math.exp(-(((value - center) / width) ** 2));
}

/** One continuous sculpted surface: jaw, cheeks, brow and nose are not separate head primitives. */
function makeHead(preset: MemoryAvatarAppearance['preset']): THREE.BufferGeometry {
  const columns = 80;
  const rows = 56;
  const positions: number[] = [];
  const indices: number[] = [];
  const width = preset === 'masculine' ? 0.55 : preset === 'feminine' ? 0.525 : 0.535;
  for (let row = 0; row <= rows; row++) {
    const theta = row / rows * Math.PI;
    const y = Math.cos(theta) * (Math.cos(theta) < 0 ? 0.565 : 0.60);
    const jaw = y < 0 ? THREE.MathUtils.lerp(preset === 'masculine' ? 0.98 : 0.94, 1, THREE.MathUtils.smoothstep(y, -0.55, 0.04)) : 1;
    for (let column = 0; column <= columns; column++) {
      const phi = column / columns * Math.PI * 2;
      const x = Math.sin(phi) * Math.pow(Math.sin(theta), 0.86) * width * jaw;
      let z = Math.cos(phi) * Math.sin(theta) * 0.425;
      const front = Math.max(0, Math.cos(phi)) ** 4;
      z += front * (
        0.046 * gaussian(Math.abs(x), 0.26, 0.17) * gaussian(y, 0.0, 0.23)
        - 0.018 * gaussian(Math.abs(x), 0.215, 0.10) * gaussian(y, 0.11, 0.085)
        + 0.042 * gaussian(x, 0, 0.087) * gaussian(y, 0.015, 0.16)
        + 0.041 * gaussian(x, 0, 0.10) * gaussian(y, -0.06, 0.075)
        + 0.027 * gaussian(x, 0, 0.23) * gaussian(y, -0.23, 0.16)
      );
      positions.push(x, y, z);
      if (row < rows && column < columns) {
        const index = row * (columns + 1) + column;
        indices.push(index, index + columns + 1, index + 1, index + 1, index + columns + 1, index + columns + 2);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

function makeHairCap(preset: MemoryAvatarAppearance['preset']): THREE.BufferGeometry {
  const rows = 30;
  const columns = 80;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const phi = column / columns * Math.PI * 2;
      const front = (Math.cos(phi) + 1) / 2;
      // A single closed-looking cap gives the bob/crop a continuous silhouette.
      // The lower rim wraps behind the jaw; there are no floating tube strands.
      const rearLength = preset === 'feminine' ? 2.48 : preset === 'neutral' ? 1.92 : 1.79;
      const hairline = THREE.MathUtils.lerp(rearLength, 1.09, front ** 2.5)
        + 0.085 * Math.sin(phi + 0.6) * front ** 3;
      const theta = row / rows * hairline;
      const wave = 1 + 0.016 * Math.sin(phi * 3 + 0.7) * Math.sin(theta);
      const skirt = preset === 'feminine' ? Math.max(0, theta - 1.6) * 0.14 : 0;
      positions.push(Math.sin(phi) * Math.sin(theta) * 0.568 * wave,
        Math.cos(theta) * 0.648 + 0.010 - skirt,
        Math.cos(phi) * Math.sin(theta) * 0.467 * wave - 0.010);
      if (row < rows && column < columns) {
        const index = row * (columns + 1) + column;
        indices.push(index, index + columns + 1, index + 1, index + 1, index + columns + 1, index + columns + 2);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

function useDisposedGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  // Geometry is local to this mounted portrait; no global GPU resources survive closing it.
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

type Point = [number, number, number];

function SoftCurve({ points, radius, color, roughness = 0.75 }: {
  points: Point[]; radius: number; color: string; roughness?: number;
}) {
  const serialized = JSON.stringify(points);
  const geometry = useDisposedGeometry(useMemo(() => new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3((JSON.parse(serialized) as Point[]).map(point => new THREE.Vector3(...point))),
    28, radius, 7, false,
  ), [serialized, radius]));
  return <mesh geometry={geometry}><meshStandardMaterial color={color} roughness={roughness} /></mesh>;
}

function Ellipsoid({ position, scale, color, roughness = 0.65 }: {
  position: Point; scale: Point; color: string; roughness?: number;
}) {
  return <mesh position={position} scale={scale}>
    <sphereGeometry args={[1, 32, 24]} />
    <meshStandardMaterial color={color} roughness={roughness} />
  </mesh>;
}

function Eye({ side, skin, hair, eyeRef, masculine }: {
  side: -1 | 1; skin: string; hair: string; eyeRef: MutableRefObject<THREE.Group | null>; masculine: boolean;
}) {
  const shape = useMemo(() => {
    const outline = new THREE.Shape();
    outline.moveTo(-0.120, 0);
    outline.bezierCurveTo(-0.087, 0.084, 0.076, 0.089, 0.120, 0.005);
    outline.bezierCurveTo(0.071, -0.063, -0.075, -0.064, -0.120, 0);
    return outline;
  }, []);
  return <group position={[side * 0.215, 0.095, 0.407]} rotation={[0, side * 0.29, side * 0.012]}>
    <group ref={eyeRef}>
      <mesh position={[0, 0, 0.012]}><shapeGeometry args={[shape, 20]} /><meshStandardMaterial color="#fff6e8" roughness={0.45} /></mesh>
      <mesh position={[-side * 0.006, 0.004, 0.018]}><circleGeometry args={[0.050, 40]} /><meshStandardMaterial color="#302923" roughness={0.55} /></mesh>
      <mesh position={[-side * 0.006, 0.004, 0.020]}><circleGeometry args={[0.042, 40]} /><meshStandardMaterial color="#705342" roughness={0.55} /></mesh>
      <mesh position={[-side * 0.006, 0.006, 0.022]}><circleGeometry args={[0.027, 32]} /><meshStandardMaterial color="#191b1c" roughness={0.3} /></mesh>
      <Ellipsoid position={[-side * 0.006 - 0.016, 0.024, 0.027]} scale={[0.011, 0.013, 0.003]} color="#fffaf1" roughness={0.12} />
      <SoftCurve points={[[-0.120, 0, 0.024], [-0.068, 0.057, 0.027], [0.032, 0.058, 0.027], [0.120, 0.005, 0.024]]} radius={0.008} color={shade(skin, '#775344', 0.36)} />
      <SoftCurve points={[[-0.119, 0, 0.020], [-0.056, -0.044, 0.022], [0.05, -0.043, 0.022], [0.120, 0.005, 0.020]]} radius={0.007} color={skin} />
    </group>
    <SoftCurve points={[[-0.114, 0.129, -0.028], [-0.048, 0.145, -0.014], [0.024, 0.143, -0.012], [0.102, 0.126, -0.022]]} radius={masculine ? 0.014 : 0.011} color={shade(hair, skin, 0.08)} />
  </group>;
}

function Portrait({ appearance, outputLevelRef, reducedMotion }: {
  appearance: MemoryAvatarAppearance; outputLevelRef: MutableRefObject<number>; reducedMotion: boolean;
}) {
  const skin = safeColor(appearance.skinColor, '#c89b7b');
  const hair = safeColor(appearance.hairColor, '#302a28');
  const outfit = safeColor(appearance.outfitColor, '#64748b');
  const feminine = appearance.preset === 'feminine';
  const masculine = appearance.preset === 'masculine';
  const head = useDisposedGeometry(useMemo(() => makeHead(appearance.preset), [appearance.preset]));
  const hairCap = useDisposedGeometry(useMemo(() => makeHairCap(appearance.preset), [appearance.preset]));
  const torso = useDisposedGeometry(useMemo(() => {
    const profile = [[0.58, -1.48], [0.72, -1.30], [0.76, -0.95], [0.78, -0.59], [0.75, -0.28], [0.61, -0.09], [0.36, 0.07], [0.18, 0.12]];
    const curve = new THREE.SplineCurve(profile.map(([radius, height]) => new THREE.Vector2(radius, height)));
    return new THREE.LatheGeometry(curve.getPoints(36), 64);
  }, []));
  const headRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const leftEye = useRef<THREE.Group>(null);
  const rightEye = useRef<THREE.Group>(null);
  const mouthRef = useRef<THREE.Mesh>(null);
  const lowerLip = useRef<THREE.Group>(null);
  const mouthLevel = useRef(0);
  const elapsed = useRef(0);
  const lips = shade(skin, feminine ? '#a65b59' : '#905b52', feminine ? 0.43 : 0.30);

  useFrame((_frame, delta) => {
    const boundedDelta = Math.min(delta, 0.1);
    elapsed.current += boundedDelta;
    const raw = Number(outputLevelRef.current);
    // The playback analyser supplies RMS (normal speech is well below 1), so a
    // bounded perceptual gain keeps articulation visible while exact silence stays shut.
    const target = Number.isFinite(raw) ? Math.min(1, Math.sqrt(THREE.MathUtils.clamp(raw, 0, 1)) * 1.8) : 0;
    // Audio output is the sole source of mouth motion. No synthetic talking timer or state inference.
    mouthLevel.current = THREE.MathUtils.damp(mouthLevel.current, target, target > mouthLevel.current ? 19 : 12, boundedDelta);
    const opening = 0.060 * mouthLevel.current;
    if (mouthRef.current) {
      mouthRef.current.scale.y = 0.003 + opening;
      mouthRef.current.position.y = -0.215 - opening * 0.38;
    }
    if (lowerLip.current) lowerLip.current.position.y = -opening * 0.9;
    const time = elapsed.current;
    const blinkTime = time % 5.3;
    const blink = reducedMotion ? 1 : 1 - 0.96 * Math.exp(-(((blinkTime - 4.75) / 0.082) ** 2));
    if (leftEye.current) leftEye.current.scale.y = blink;
    if (rightEye.current) rightEye.current.scale.y = blink;
    if (headRef.current) {
      headRef.current.rotation.x = reducedMotion ? 0 : Math.sin(time * 0.48) * 0.010;
      headRef.current.rotation.y = reducedMotion ? -0.035 : -0.035 + Math.sin(time * 0.29) * 0.025;
      headRef.current.rotation.z = reducedMotion ? 0 : Math.sin(time * 0.34 + 0.5) * 0.008;
    }
    if (bodyRef.current) bodyRef.current.scale.y = reducedMotion ? 1 : 1 + Math.sin(time * 1.35) * 0.004;
  });

  return <group position={[0, -0.05, 0]}>
    <group ref={bodyRef}>
      <mesh geometry={torso} scale={[masculine ? 1.06 : feminine ? 0.96 : 1, 1, 0.44]}>
        <meshStandardMaterial color={outfit} roughness={0.95} />
      </mesh>
      <mesh position={[0, 0.22, -0.028]}><cylinderGeometry args={[0.155, 0.175, 0.39, 40]} /><meshStandardMaterial color={skin} roughness={0.67} /></mesh>
      <SoftCurve points={[[-0.18, 0.092, 0.11], [-0.18, 0.022, 0.235], [0, -0.020, 0.283], [0.18, 0.022, 0.235], [0.18, 0.092, 0.11]]} radius={0.020} color={shade(outfit, '#e8dfd0', 0.17)} />
      <SoftCurve points={[[-0.43, -0.06, 0.22], [-0.67, -0.20, 0.235], [-0.73, -0.44, 0.232]]} radius={0.003} color={shade(outfit, '#1c2534', 0.16)} />
      <SoftCurve points={[[0.43, -0.06, 0.22], [0.67, -0.20, 0.235], [0.73, -0.44, 0.232]]} radius={0.003} color={shade(outfit, '#1c2534', 0.16)} />
    </group>
    <group ref={headRef} position={[0, 0.82, 0]}>
      <mesh geometry={head}><meshPhysicalMaterial color={skin} roughness={0.76} clearcoat={0.04} clearcoatRoughness={0.8} /></mesh>
      {([-1, 1] as const).map(side => <group key={side}>
        <Ellipsoid position={[side * 0.518, -0.035, -0.003]} scale={[0.073, 0.113, 0.066]} color={skin} />
        <Ellipsoid position={[side * 0.541, -0.029, 0.046]} scale={[0.029, 0.060, 0.012]} color={shade(skin, '#995b49', 0.22)} />
        {feminine && <mesh position={[side * 0.532, -0.160, 0.030]} rotation={[0.25, 0, 0]}><torusGeometry args={[0.025, 0.004, 8, 24]} /><meshStandardMaterial color="#c5a97b" metalness={0.6} roughness={0.32} /></mesh>}
      </group>)}
      <Eye side={-1} skin={skin} hair={hair} eyeRef={leftEye} masculine={masculine} />
      <Eye side={1} skin={skin} hair={hair} eyeRef={rightEye} masculine={masculine} />
      <mesh ref={mouthRef} position={[0, -0.215, 0.425]} scale={[0.103, 0.003, 1]}><circleGeometry args={[1, 40]} /><meshStandardMaterial color="#67433e" roughness={1} /></mesh>
      <SoftCurve points={[[-0.111, -0.207, 0.420], [-0.055, -0.212, 0.434], [0, -0.212, 0.438], [0.055, -0.212, 0.434], [0.111, -0.207, 0.420]]} radius={0.007} color={lips} roughness={0.78} />
      <group ref={lowerLip}><SoftCurve points={[[-0.109, -0.211, 0.420], [-0.061, -0.225, 0.432], [0, -0.228, 0.438], [0.061, -0.225, 0.432], [0.109, -0.211, 0.420]]} radius={0.009} color={shade(lips, '#f2d4bd', 0.20)} roughness={0.78} /></group>
      <mesh geometry={hairCap}><meshStandardMaterial color={hair} roughness={0.83} /></mesh>
    </group>
  </group>;
}

class PortraitBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function ContextLossGuard({ onLost }: { onLost: () => void }) {
  const renderer = useThree(state => state.gl);
  useEffect(() => {
    const canvas = renderer.domElement;
    const lost = (event: Event) => { event.preventDefault(); onLost(); };
    canvas.addEventListener('webglcontextlost', lost);
    return () => canvas.removeEventListener('webglcontextlost', lost);
  }, [renderer, onLost]);
  return null;
}

export default function MemoryAvatarStage({ appearance, outputLevelRef, state, name, locale, active = true, avatarId, presentation }: MemoryAvatarStageProps) {
  // Legacy records use the supported 2D character; the retired VRM is not loaded.
  const portrait = appearance.style === 'lumi2d' || appearance.style === 'lumivrm';
  const lumi = appearance.style === 'lumi3d' || portrait;
  const [available, setAvailable] = useState<boolean | null>(null);
  const [lost, setLost] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [framing, setFraming] = useState<'conversation' | 'full'>('conversation');
  useEffect(() => {
    if (!active) return;
    setLost(false);
    try {
      const probe = document.createElement('canvas');
      const context = probe.getContext('webgl2', { alpha: true, antialias: false, powerPreference: 'low-power' });
      setAvailable(Boolean(context));
      context?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { setAvailable(false); }
  }, [active]);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;
    const update = () => setReducedMotion(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const fallback = <div role="status" style={{ minHeight: 260, height: '100%', display: 'grid', placeContent: 'center', padding: 32, textAlign: 'center', color: '#c5bdb3', lineHeight: 1.8 }}>
    <span style={{ color: '#eee4d6', fontSize: 22, marginBottom: 10 }}>{name}</span>
    <span style={{ maxWidth: 320, fontSize: 13 }}>{memoryTerritoryCopy(locale).renderFallback}</span>
  </div>;
  if (!active) return null;
  if (avatarId && presentation?.mode === 'localportrait' && presentation.animation) return <MemoryAvatarAnimatedPortrait avatarId={avatarId} animation={presentation.animation} outputLevelRef={outputLevelRef} name={name} locale={locale} />;
  if (available === false || lost) return fallback;
  return <div role="figure" aria-label={name} data-state={state} style={{ width: '100%', height: '100%', minHeight: 320, position: 'relative' }}>
    {available && <PortraitBoundary fallback={fallback}>
      <Canvas dpr={[1, 1.5]} shadows={lumi ? {type:THREE.PCFShadowMap} : false} camera={{ position: [0, lumi ? 0.35 : 0.21, lumi ? 7.7 : 6.0], fov: 34, near: 0.1, far: lumi ? 260 : 30 }}
        gl={{ alpha: true, antialias: true, powerPreference: 'low-power', toneMapping: THREE.ACESFilmicToneMapping }}
        style={{ background: 'transparent' }} fallback={fallback} onCreated={({ gl }) => { gl.setClearColor(0x000000, 0); gl.toneMappingExposure = 1.04; }}>
        <ContextLossGuard onLost={() => setLost(true)} />
        {lumi ? <>
          <LumiHomeScene tint={safeColor(appearance.backgroundColor, '#d5d6c5')} reducedMotion={reducedMotion} seated={portrait} />
          <LumiHomeCamera reducedMotion={reducedMotion || portrait} fullBody={portrait && framing === 'full'} portraitCloseUp={portrait && framing === 'conversation'} />
          {portrait ? <LumiLayeredCharacter outputLevelRef={outputLevelRef} reducedMotion={reducedMotion} state={state} /> : <LumiCompanionModel outputLevelRef={outputLevelRef} reducedMotion={reducedMotion} accent={safeColor(appearance.outfitColor, '#6bbaa8')} shellColor={safeColor(appearance.skinColor, '#f1eee2')} visorColor={safeColor(appearance.hairColor, '#183534')} />}
        </> : <>
        <ambientLight intensity={0.65} color="#eee4d8" />
        <hemisphereLight args={['#fff0dc', '#7b7589', 1.15]} />
        <directionalLight position={[-3.5, 4, 5]} intensity={2.15} color="#ffe2c5" />
        <directionalLight position={[3, 1, 3]} intensity={0.85} color="#dbe6fb" />
        <directionalLight position={[1, 3, -3]} intensity={1.8} color="#efd0a5" />
        <Portrait appearance={appearance} outputLevelRef={outputLevelRef} reducedMotion={reducedMotion} />
        </>}
      </Canvas>
    </PortraitBoundary>}
    {portrait && available && !lost && <div className="absolute bottom-4 right-4 flex gap-1 rounded-full border border-white/15 bg-black/45 p-1 text-xs text-white backdrop-blur-md">
      {(['conversation', 'full'] as const).map(mode => <button key={mode} type="button" aria-pressed={framing === mode} onClick={() => setFraming(mode)} className={`rounded-full px-3 py-2 ${framing === mode ? 'bg-white/20' : 'hover:bg-white/10'}`}>{mode === 'conversation' ? memoryTerritoryCopy(locale).framingConversation : memoryTerritoryCopy(locale).framingFullBody}</button>)}
    </div>}
  </div>;
}

export { MemoryAvatarStage };
