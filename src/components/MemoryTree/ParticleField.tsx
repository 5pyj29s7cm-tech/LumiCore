import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BranchCurve3D } from './types';

interface ParticleFieldProps {
  curves: BranchCurve3D[];
  hue: number;
}

interface FlowParticle {
  curveIndex: number;
  t: number;
  speed: number;
}

const STATIC_COUNT = 3000;
const FLOW_COUNT = 200;
const AMBIENT_COUNT = 500;

const particleVertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  varying float vAlpha;
  varying float vSize;
  uniform float uTime;
  void main() {
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (120.0 / -mvPos.z);
    gl_Position = projectionMatrix * mvPos;
    vAlpha = aAlpha;
    vSize = aSize;
  }
`;

const particleFragmentShader = /* glsl */ `
  varying float vAlpha;
  varying float vSize;
  uniform vec3 uColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float alpha = 1.0 - smoothstep(0.0, 1.0, d);
    alpha = pow(alpha, 1.5);
    alpha *= vAlpha * 0.6;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

export function ParticleField({ curves, hue }: ParticleFieldProps) {
  const staticRef = useRef<THREE.Points>(null);
  const flowRef = useRef<THREE.Points>(null);
  const ambientRef = useRef<THREE.Points>(null);
  const flowDataRef = useRef<FlowParticle[]>([]);
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  const color = useMemo(() => new THREE.Color().setHSL(hue / 360, 0.4, 0.6), [hue]);

  // Static particles — scattered along branch curves
  const staticGeo = useMemo(() => {
    const pos = new Float32Array(STATIC_COUNT * 3);
    const sizes = new Float32Array(STATIC_COUNT);
    const alphas = new Float32Array(STATIC_COUNT);

    for (let i = 0; i < STATIC_COUNT; i++) {
      const ci = i % Math.max(curves.length, 1);
      const curve = curves[ci]?.curve;
      if (curve) {
        const t = Math.random();
        const pt = curve.getPoint(t);
        // Scatter around the curve
        const scatterR = 0.015 + Math.random() * 0.06;
        pos[i * 3] = pt.x + (Math.random() - 0.5) * scatterR * 2;
        pos[i * 3 + 1] = pt.y + (Math.random() - 0.5) * scatterR * 2;
        pos[i * 3 + 2] = pt.z + (Math.random() - 0.5) * scatterR * 2;
      } else {
        // Random within tree bounds
        pos[i * 3] = (Math.random() - 0.5) * 1.5;
        pos[i * 3 + 1] = -2 + Math.random() * 4;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 1.0;
      }
      sizes[i] = 0.4 + Math.random() * 0.8;
      alphas[i] = 0.15 + Math.random() * 0.3;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    return geo;
  }, [curves]);

  // Flow particles — traveling along curves
  const { flowGeo, flowData } = useMemo(() => {
    const pos = new Float32Array(FLOW_COUNT * 3);
    const sizes = new Float32Array(FLOW_COUNT);
    const alphas = new Float32Array(FLOW_COUNT);
    const flowData: FlowParticle[] = [];

    for (let i = 0; i < FLOW_COUNT; i++) {
      const ci = i % Math.max(curves.length, 1);
      flowData.push({
        curveIndex: ci,
        t: Math.random(),
        speed: 0.04 + Math.random() * 0.12,
      });
      pos[i * 3] = 0;
      pos[i * 3 + 1] = 0;
      pos[i * 3 + 2] = 0;
      sizes[i] = 1.2 + Math.random() * 2;
      alphas[i] = 0.5 + Math.random() * 0.5;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    return { flowGeo: geo, flowData };
  }, [curves]);

  flowDataRef.current = flowData;

  // Ambient particles — floating in a sphere around the tree
  const ambientGeo = useMemo(() => {
    const pos = new Float32Array(AMBIENT_COUNT * 3);
    const sizes = new Float32Array(AMBIENT_COUNT);
    const alphas = new Float32Array(AMBIENT_COUNT);
    const R = 2.5;

    for (let i = 0; i < AMBIENT_COUNT; i++) {
      const phi = Math.acos(2 * Math.random() - 1);
      const theta = Math.random() * Math.PI * 2;
      const r = R * (0.4 + Math.random() * 0.6);
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi);
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      sizes[i] = 0.2 + Math.random() * 0.5;
      alphas[i] = 0.05 + Math.random() * 0.12;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    return geo;
  }, []);

  const uniformsRef = useRef({ uTime: { value: 0 }, uColor: { value: color } });
  const shaderMaterial = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: particleVertexShader,
      fragmentShader: particleFragmentShader,
      uniforms: uniformsRef.current,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    materialRef.current = mat;
    return mat;
  }, []);

  React.useEffect(() => {
    uniformsRef.current.uColor.value.copy(color);
  }, [color]);

  useFrame((_, delta) => {
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value += delta;
    }

    // Update flow particle positions
    const flowPos = flowGeo.attributes.position.array as Float32Array;
    for (let i = 0; i < FLOW_COUNT; i++) {
      const fd = flowDataRef.current[i];
      if (!fd) continue;
      fd.t += fd.speed * delta;
      if (fd.t > 1) fd.t -= 1;
      if (fd.t < 0) fd.t += 1;
      const curve = curves[fd.curveIndex]?.curve;
      if (curve) {
        const pt = curve.getPoint(fd.t);
        flowPos[i * 3] = pt.x;
        flowPos[i * 3 + 1] = pt.y;
        flowPos[i * 3 + 2] = pt.z;
      }
    }
    flowGeo.attributes.position.needsUpdate = true;

    // Gentle ambient rotation
    if (ambientRef.current) {
      ambientRef.current.rotation.y += delta * 0.03;
      ambientRef.current.rotation.x += delta * 0.015;
    }
  });

  return (
    <group renderOrder={3}>
      <points ref={staticRef} geometry={staticGeo} material={shaderMaterial} />
      <points ref={flowRef} geometry={flowGeo} material={shaderMaterial} />
      <points ref={ambientRef} geometry={ambientGeo} material={shaderMaterial} />
    </group>
  );
}
