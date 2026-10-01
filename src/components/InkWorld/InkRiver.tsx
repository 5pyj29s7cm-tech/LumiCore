import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { terrainHeight } from './InkTerrain';

export function InkRiver() {
  const meshRef = useRef<THREE.Mesh>(null);

  const geometry = useMemo(() => {
    // A winding path through the valley
    const controlPoints: THREE.Vector3[] = [];
    const valleyX = [-18, -12, -5, 2, 8, 14, 20, 25];
    const valleyZ = [-10, -3, 4, 10, 4, -2, -8, -14];
    for (let i = 0; i < valleyX.length; i++) {
      const y = terrainHeight(valleyX[i], valleyZ[i]) + 0.05;
      controlPoints.push(new THREE.Vector3(valleyX[i], y, valleyZ[i]));
    }
    const curve = new THREE.CatmullRomCurve3(controlPoints, false, 'catmullrom', 0.5);
    return new THREE.TubeGeometry(curve, 80, 0.35, 6, false);
  }, []);

  const material = useMemo(() => new THREE.MeshBasicMaterial({
    color: 0x0a0a0a,
    transparent: true,
    opacity: 0.55,
    depthWrite: true,
  }), []);

  useFrame((_, _delta) => {
    // Subtle shimmer — could animate UV offset in a custom material
  });

  return (
    <mesh ref={meshRef} geometry={geometry} material={material} renderOrder={1} />
  );
}
