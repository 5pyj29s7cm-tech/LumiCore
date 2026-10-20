import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { RingDef } from './types';

interface OrbitalRingsProps {
  syncRate: number;
}

const DEFAULT_RINGS: RingDef[] = [
  { y: -1.0, radius: 1.6, tube: 0.015, tiltX: 1.05, tiltZ: 0.3, hue: 85, speed: 0.22, particleCount: 65 },
  { y: -0.4, radius: 1.4, tube: 0.013, tiltX: -0.85, tiltZ: -0.5, hue: 100, speed: -0.28, particleCount: 60 },
  { y: 0.1, radius: 1.2, tube: 0.012, tiltX: 0.95, tiltZ: -0.35, hue: 115, speed: 0.33, particleCount: 55 },
  { y: 0.5, radius: 1.0, tube: 0.010, tiltX: -0.75, tiltZ: 0.55, hue: 130, speed: -0.37, particleCount: 50 },
  { y: 0.9, radius: 0.7, tube: 0.009, tiltX: 0.85, tiltZ: -0.45, hue: 140, speed: 0.30, particleCount: 45 },
  { y: 1.3, radius: 0.45, tube: 0.008, tiltX: -0.65, tiltZ: 0.4, hue: 150, speed: -0.25, particleCount: 40 },
];

export function OrbitalRings({ syncRate }: OrbitalRingsProps) {
  const groupRef = useRef<THREE.Group>(null);

  const rings = useMemo(() => DEFAULT_RINGS, []);

  // Torus geometries
  const torusGeos = useMemo(() => {
    return rings.map(r =>
      new THREE.TorusGeometry(r.radius, r.tube, 16, 100)
    );
  }, [rings]);

  // Ring materials
  const ringMaterials = useMemo(() => {
    return rings.map(r => {
      const c = new THREE.Color().setHSL(r.hue / 360, 0.6, 0.5);
      return new THREE.MeshBasicMaterial({
        color: c,
        transparent: true,
        opacity: 0.3,
        depthWrite: true,
      });
    });
  }, [rings]);

  // Particle data per ring
  const particleData = useMemo(() => {
    return rings.map(r => {
      const data: { angle: number; speed: number }[] = [];
      for (let i = 0; i < r.particleCount; i++) {
        data.push({
          angle: (i / r.particleCount) * Math.PI * 2,
          speed: r.speed * (0.5 + Math.random() * 1.0),
        });
      }
      return data;
    });
  }, [rings]);

  const particleGeo = useMemo(() => new THREE.SphereGeometry(0.015, 6, 6), []);
  const particleMats = useMemo(() => {
    return rings.map(r => {
      const c = new THREE.Color().setHSL(r.hue / 360, 0.8, 0.7);
      return new THREE.MeshBasicMaterial({ color: c, depthWrite: true });
    });
  }, [rings]);

  // Store particle mesh refs for animation
  const particleMeshRefs = useRef<THREE.Mesh[][]>(rings.map(() => []));

  useFrame((_, delta) => {
    const dt = delta * syncRate;
    for (let ri = 0; ri < rings.length; ri++) {
      const r = rings[ri];
      const meshes = particleMeshRefs.current[ri];
      if (!meshes) continue;
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i];
        if (!mesh) continue;
        const pd = particleData[ri][i];
        pd.angle += pd.speed * dt;
        // Position on the tilted ring
        const localX = Math.cos(pd.angle) * r.radius;
        const localZ = Math.sin(pd.angle) * r.radius;
        const localY = 0;

        // Apply tilts
        const cosX = Math.cos(r.tiltX), sinX = Math.sin(r.tiltX);
        const cosZ = Math.cos(r.tiltZ), sinZ = Math.sin(r.tiltZ);

        // Rotate around X
        const y1 = localY * cosX - localZ * sinX;
        const z1 = localY * sinX + localZ * cosX;

        // Rotate around Z
        const x2 = localX * cosZ - y1 * sinZ;
        const y2 = localX * sinZ + y1 * cosZ;

        mesh.position.set(x2, y2 + r.y, z1);
      }
    }
  });

  return (
    <group ref={groupRef} renderOrder={1}>
      {/* Torus rings */}
      {torusGeos.map((geo, i) => (
        <mesh
          key={`ring-${i}`}
          geometry={geo}
          material={ringMaterials[i]}
          rotation={[rings[i].tiltX, 0, rings[i].tiltZ]}
          position={[0, rings[i].y, 0]}
        />
      ))}

      {/* Orbiting particles on each ring */}
      {rings.map((_, ri) => (
        <group key={`particles-${ri}`}>
          {particleData[ri].map((_, pi) => (
            <mesh
              key={`p-${ri}-${pi}`}
              ref={(el) => {
                if (el) {
                  if (!particleMeshRefs.current[ri]) particleMeshRefs.current[ri] = [];
                  particleMeshRefs.current[ri][pi] = el;
                }
              }}
              geometry={particleGeo}
              material={particleMats[ri]}
            />
          ))}
        </group>
      ))}
    </group>
  );
}
