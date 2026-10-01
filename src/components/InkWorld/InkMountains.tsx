import { useMemo } from 'react';
import * as THREE from 'three';

export function InkMountains() {
  const layers = useMemo(() => {
    const result: { geometry: THREE.BufferGeometry; position: [number, number, number]; color: string }[] = [];

    const zPositions = [-30, -20, -12];
    const colors = ['#0a0a0a', '#1a1a1a', '#2a2a2a']; // farthest = lightest (atm. perspective)
    const heights = [14, 10, 7];

    for (let l = 0; l < 3; l++) {
      const numPeaks = 14 + l * 3;
      const z = zPositions[l];
      const maxH = heights[l];
      const col = colors[l];

      // Generate a 2D profile
      const width = 70 + l * 5;
      const step = width / (numPeaks - 1);
      const points: THREE.Vector2[] = [];

      // Ground line
      points.push(new THREE.Vector2(-width / 2, -3));

      for (let i = 0; i < numPeaks; i++) {
        const px = -width / 2 + i * step;
        const n = mountainNoise(px * 0.03 + l * 17, l * 31) * 0.5 + 0.5;
        const py = n * maxH;
        points.push(new THREE.Vector2(px, py));
      }

      points.push(new THREE.Vector2(width / 2, -3));

      const shape = new THREE.Shape(points);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 2, bevelEnabled: false });
      result.push({ geometry: geo, position: [0, -2, z], color: col });
    }

    return result;
  }, []);

  return (
    <group renderOrder={0}>
      {layers.map((layer, i) => (
        <mesh key={i} geometry={layer.geometry} position={layer.position} frustumCulled={false}>
          <meshBasicMaterial color={layer.color} side={THREE.DoubleSide} transparent opacity={0.85 - i * 0.15} />
        </mesh>
      ))}
    </group>
  );
}

function mountainNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3.0 - 2.0 * fx);
  const sy = fy * fy * (3.0 - 2.0 * fy);
  const h = (ix * 374761393 + iy * 668265263 + 1274126177) >>> 0;
  const h00 = ((h & 0x7fffffff) / 0x7fffffff);
  const h10 = (((ix + 1) * 374761393 + iy * 668265263 + 1274126177) >>> 0 & 0x7fffffff) / 0x7fffffff;
  const h01 = ((ix * 374761393 + (iy + 1) * 668265263 + 1274126177) >>> 0 & 0x7fffffff) / 0x7fffffff;
  const h11 = (((ix + 1) * 374761393 + (iy + 1) * 668265263 + 1274126177) >>> 0 & 0x7fffffff) / 0x7fffffff;
  const nx0 = h00 * (1 - sx) + h10 * sx;
  const nx1 = h01 * (1 - sx) + h11 * sx;
  return (nx0 * (1 - sy) + nx1 * sy) * 2 - 1;
}
