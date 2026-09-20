import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

type Point = [number, number, number];
/** A continuous rounded shell, with no texture downloads or external model files. */
function Shell({ position = [0, 0, 0], scale, color, roundness = 0.7, metalness = 0.08, roughness = 0.27, emissive, rotation }: {
  position?: Point; scale: Point; color: string; roundness?: number; metalness?: number; roughness?: number; emissive?: string; rotation?: Point;
}) {
  const geometry = useMemo(() => {
    const shape = new THREE.SphereGeometry(1, 56, 36), vertices = shape.attributes.position;
    const soften = (value: number) => Math.sign(value) * Math.abs(value) ** roundness;
    for (let i = 0; i < vertices.count; i++) vertices.setXYZ(i, soften(vertices.getX(i)), soften(vertices.getY(i)), soften(vertices.getZ(i)));
    shape.computeVertexNormals(); return shape;
  }, [roundness]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh position={position} scale={scale} rotation={rotation} geometry={geometry} castShadow receiveShadow>
    <meshPhysicalMaterial color={color} roughness={roughness} metalness={metalness} clearcoat={0.7} clearcoatRoughness={0.22} emissive={emissive || '#000000'} emissiveIntensity={emissive ? 1.4 : 0} />
  </mesh>;
}

function Seam({ points, color, radius = 0.012, light = false }: { points: Point[]; color: string; radius?: number; light?: boolean }) {
  const key = JSON.stringify(points);
  const geometry = useMemo(() => new THREE.TubeGeometry(new THREE.CatmullRomCurve3((JSON.parse(key) as Point[]).map(p => new THREE.Vector3(...p))), 40, radius, 8, false), [key, radius]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry}><meshStandardMaterial color={color} metalness={light ? 0 : 0.6} roughness={0.3} emissive={light ? color : '#000000'} emissiveIntensity={light ? 1.1 : 0} /></mesh>;
}

export function LumiCompanionModel({ outputLevelRef, reducedMotion, accent = '#6bbaa8', shellColor = '#f1eee2', visorColor = '#183534' }: {
  outputLevelRef: MutableRefObject<number>; reducedMotion: boolean; accent?: string; shellColor?: string; visorColor?: string;
}) {
  const body = useRef<THREE.Group>(null), head = useRef<THREE.Group>(null);
  const leftEye = useRef<THREE.Group>(null), rightEye = useRef<THREE.Group>(null), mouth = useRef<THREE.Mesh>(null);
  const leftArm = useRef<THREE.Group>(null), rightArm = useRef<THREE.Group>(null);
  const chestLight = useRef<THREE.MeshStandardMaterial>(null);
  const time = useRef(0), level = useRef(0);
  useFrame((_frame, delta) => {
    const dt = Math.min(delta, 0.08); time.current += dt;
    const raw = Number(outputLevelRef.current);
    const target = Number.isFinite(raw) ? Math.min(1, Math.sqrt(THREE.MathUtils.clamp(raw, 0, 1)) * 1.7) : 0;
    level.current = THREE.MathUtils.damp(level.current, target, 15, dt);
    const t = time.current, speech = level.current;
    if (body.current) { body.current.position.y = reducedMotion ? 0 : Math.sin(t * 1.15) * 0.035; body.current.rotation.y = reducedMotion ? 0 : Math.sin(t * 0.28) * 0.055; }
    if (head.current) { head.current.rotation.z = reducedMotion ? 0 : Math.sin(t * 0.63) * 0.022; head.current.rotation.x = reducedMotion ? 0 : Math.sin(t * 0.85) * 0.014 + speech * 0.018; }
    const blink = reducedMotion ? 1 : 1 - 0.94 * Math.exp(-(((t % 5.7 - 4.9) / 0.085) ** 2));
    if (leftEye.current) leftEye.current.scale.y = blink;
    if (rightEye.current) rightEye.current.scale.y = blink;
    // A real analyser level drives the mouth; idle never pretends to speak.
    if (mouth.current) { mouth.current.scale.y = 0.008 + speech * 0.067; mouth.current.scale.x = 0.048 + speech * 0.020; }
    if (leftArm.current) leftArm.current.rotation.z = -0.22 - (reducedMotion ? 0 : Math.sin(t * 1.1) * 0.025) - speech * 0.06;
    if (rightArm.current) rightArm.current.rotation.z = 0.22 + (reducedMotion ? 0 : Math.sin(t * 1.1 + 1) * 0.025) + speech * 0.06;
    if (chestLight.current) chestLight.current.emissiveIntensity = 0.6 + speech * 1.2;
  });
  return <group ref={body}>
    <group position={[0, -0.48, 0]}>
      <Shell scale={[0.51, 0.55, 0.34]} color={shellColor} roundness={0.82} />
      <Shell position={[0, 0.17, 0.285]} scale={[0.27, 0.22, 0.075]} color="#d6e3d9" roughness={0.4} />
      <mesh position={[0, 0.14, 0.365]} rotation={[0, 0, Math.PI / 4]}><boxGeometry args={[0.12, 0.12, 0.02]} /><meshStandardMaterial ref={chestLight} color={accent} emissive={accent} emissiveIntensity={0.6} roughness={0.35} /></mesh>
      <mesh position={[-0.015, 0.151, 0.38]}><boxGeometry args={[0.018, 0.065, 0.005]} /><meshBasicMaterial color="#e9fff2" /></mesh>
      <mesh position={[0.003, 0.125, 0.38]}><boxGeometry args={[0.051, 0.014, 0.005]} /><meshBasicMaterial color="#e9fff2" /></mesh>
      <Seam points={[[-0.37, -0.18, 0.27], [-0.21, -0.22, 0.33], [0, -0.23, 0.35], [0.21, -0.22, 0.33], [0.37, -0.18, 0.27]]} color="#bda67d" radius={0.007} />
      <Shell position={[0, -0.50, 0]} scale={[0.29, 0.07, 0.21]} color="#244a48" metalness={0.5} />
      <mesh position={[0, -0.55, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.17, 0.012, 8, 48]} /><meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={1.5} /></mesh>
      {([-1, 1] as const).map(side => <group key={side} ref={side === -1 ? leftArm : rightArm} position={[side * 0.57, 0.15, 0]} rotation={[0, 0, side * 0.22]}>
        <Shell scale={[0.11, 0.13, 0.14]} color="#b5bdaf" metalness={0.55} />
        <Shell position={[side * 0.065, -0.23, 0.025]} scale={[0.135, 0.30, 0.16]} color={shellColor} roundness={0.86} />
        <Shell position={[side * 0.06, -0.47, 0.026]} scale={[0.105, 0.055, 0.13]} color={accent} roughness={0.42} />
      </group>)}
    </group>
    <mesh position={[0, 0.12, 0]}><cylinderGeometry args={[0.20, 0.20, 0.18, 40]} /><meshStandardMaterial color="#697f75" metalness={0.7} roughness={0.28} /></mesh>
    <group ref={head} position={[0, 0.68, 0]}>
      <Shell scale={[0.76, 0.59, 0.48]} color={shellColor} roundness={0.70} />
      <Shell position={[0, -0.008, 0.32]} scale={[0.66, 0.425, 0.225]} color={visorColor} roundness={0.64} roughness={0.18} metalness={0.23} />
      <Seam points={[[-0.53, 0.32, 0.423], [-0.3, 0.38, 0.49], [0, 0.395, 0.509], [0.3, 0.38, 0.49], [0.53, 0.32, 0.423]]} color="#9fccc3" radius={0.005} />
      {([-1, 1] as const).map(side => <group key={side}>
        <group ref={side === -1 ? leftEye : rightEye} position={[side * 0.235, 0.045, 0.548]} rotation={[0, side * 0.12, -side * 0.025]}>
          <Shell scale={[0.081, 0.116, 0.012]} color="#a5f2d3" emissive="#71cdb5" roundness={0.62} />
          <mesh position={[-0.022, 0.04, 0.017]}><circleGeometry args={[0.014, 24]} /><meshBasicMaterial color="#ffffff" /></mesh>
        </group>
        <Seam points={[[side * 0.355, -0.129, 0.53], [side * 0.418, -0.113, 0.516]]} color="#e8b874" radius={0.013} light />
        <group position={[side * 0.77, 0.015, -0.035]} rotation={[0, 0, Math.PI / 2]}>
          <mesh castShadow><cylinderGeometry args={[0.155, 0.155, 0.10, 40]} /><meshStandardMaterial color="#b6b9a7" metalness={0.7} roughness={0.22} /></mesh>
          <mesh position={[0, side * 0.06, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.107, 0.012, 8, 36]} /><meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.7} /></mesh>
        </group>
        <group position={[side * 0.58, 0.49, -0.06]} rotation={[0.10, 0, -side * 0.33]}>
          <Shell position={[0, 0.19, 0]} scale={[0.09, 0.265, 0.07]} color={shellColor} roundness={0.82} />
          <Shell position={[0, 0.365, 0.014]} scale={[0.061, 0.066, 0.062]} color={side === -1 ? '#d6b57b' : accent} emissive={side === -1 ? '#a77e43' : '#508674'} />
        </group>
      </group>)}
      <Seam points={[[-0.067, -0.148, 0.554], [0, -0.167, 0.558], [0.067, -0.148, 0.554]]} color="#84d4bb" radius={0.009} light />
      <mesh ref={mouth} position={[0, -0.17, 0.56]} scale={[0.048, 0.008, 1]}><circleGeometry args={[1, 36]} /><meshStandardMaterial color="#85d8bb" emissive="#64bb9f" emissiveIntensity={0.8} /></mesh>
    </group>
  </group>;
}
