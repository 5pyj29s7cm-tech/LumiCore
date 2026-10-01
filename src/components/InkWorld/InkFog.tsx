import { useMemo } from 'react';
import * as THREE from 'three';

function createFogTexture(opacity: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, `rgba(255,255,255,${opacity.toFixed(2)})`);
  gradient.addColorStop(0.3, `rgba(255,255,255,${(opacity * 0.8).toFixed(2)})`);
  gradient.addColorStop(0.6, `rgba(255,255,255,${(opacity * 0.3).toFixed(2)})`);
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

const fogPlaneSize = 80;

const fogLayers = [
  { y: 1.5, opacity: 0.18, speed: 0.002 },
  { y: 5, opacity: 0.12, speed: 0.004 },
  { y: 9, opacity: 0.07, speed: 0.006 },
];

export function InkFog() {
  const textures = useMemo(() => fogLayers.map(l => createFogTexture(l.opacity)), []);
  const geos = useMemo(() => fogLayers.map(() => new THREE.PlaneGeometry(fogPlaneSize, fogPlaneSize)), []);

  return (
    <group renderOrder={0}>
      {fogLayers.map((layer, i) => (
        <mesh
          key={i}
          geometry={geos[i]}
          position={[0, layer.y, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          frustumCulled={false}
        >
          <meshBasicMaterial
            map={textures[i]}
            transparent
            depthWrite={false}
            blending={THREE.NormalBlending}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}
