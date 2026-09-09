import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface InkParticlesProps {
  syncRate: number;
}

function createDotTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,0.8)');
  gradient.addColorStop(0.3, 'rgba(0,0,0,0.3)');
  gradient.addColorStop(0.7, 'rgba(0,0,0,0.03)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

export function InkParticles({ syncRate }: InkParticlesProps) {
  const dotCount = 1200;
  const mistCount = 300;
  const dotTex = useMemo(() => createDotTexture(), []);

  // Ink dot particles
  const dotData = useMemo(() => {
    const positions = new Float32Array(dotCount * 3);
    const sizes = new Float32Array(dotCount);
    const phases = new Float32Array(dotCount);
    for (let i = 0; i < dotCount; i++) {
      const r = 5 + Math.random() * 28;
      const angle = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(angle) * r;
      positions[i * 3 + 1] = 1 + Math.random() * 10;
      positions[i * 3 + 2] = Math.sin(angle) * r;
      sizes[i] = 0.1 + Math.random() * 0.5;
      phases[i] = Math.random() * Math.PI * 2;
    }
    return { positions, sizes, phases };
  }, []);

  const dotRef = useRef<THREE.Points>(null);
  const timeRef = useRef(0);

  useFrame((_, delta) => {
    timeRef.current += delta * syncRate;
    if (dotRef.current) {
      const pos = dotRef.current.geometry.attributes.position;
      for (let i = 0; i < dotCount; i++) {
        const y = dotData.positions[i * 3 + 1] + Math.sin(timeRef.current * 0.3 + dotData.phases[i]) * 1.5;
        pos.setY(i, y);
      }
      pos.needsUpdate = true;
    }
  });

  const dotGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(dotData.positions, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(dotData.sizes, 1));
    return geo;
  }, [dotData]);

  const dotMat = useMemo(() => new THREE.PointsMaterial({
    map: dotTex,
    color: 0x050505,
    size: 0.6,
    blending: THREE.NormalBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0.5,
  }), [dotTex]);

  // Mist particles — larger, semi-transparent grey blobs
  const mistData = useMemo(() => {
    const positions = new Float32Array(mistCount * 3);
    const sizes = new Float32Array(mistCount);
    for (let i = 0; i < mistCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 50;
      positions[i * 3 + 1] = 2 + Math.random() * 12;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 50;
      sizes[i] = 2 + Math.random() * 5;
    }
    return { positions, sizes };
  }, []);

  const mistGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mistData.positions, 3));
    return geo;
  }, [mistData]);

  const mistMat = useMemo(() => new THREE.PointsMaterial({
    map: dotTex,
    color: 0x888888,
    size: 4.0,
    blending: THREE.NormalBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0.15,
  }), [dotTex]);

  return (
    <group renderOrder={2}>
      <points ref={dotRef} geometry={dotGeo} material={dotMat} frustumCulled={false} />
      <points geometry={mistGeo} material={mistMat} frustumCulled={false} />
    </group>
  );
}
