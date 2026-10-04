import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { terrainHeight } from './InkTerrain';

/** Fixed per-tree data baked once — never regenerated per frame */
interface TreePlacement {
  x: number; y: number; z: number;
  scale: number;
  phase: number;
}

export function InkTrees() {
  const treeCount = 150;
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const timeRef = useRef(0);

  const { treeGeo, treeMat } = useMemo(() => {
    // Single tree geometry: trunk + 3 cones
    const trunk = new THREE.CylinderGeometry(0.1, 0.14, 1.6, 6);
    const cones: THREE.BufferGeometry[] = [];
    cones.push(new THREE.ConeGeometry(0.5, 0.7, 6));
    cones.push(new THREE.ConeGeometry(0.35, 0.6, 6));
    cones.push(new THREE.ConeGeometry(0.2, 0.5, 6));

    // Merge into one geometry
    const trunkPos = trunk.attributes.position;
    const trunkIdx = trunk.index;

    // Simple merge: combine trunk + 3 cones using BufferGeometryUtils equivalent
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];

    let vertexOffset = 0;
    // Trunk
    for (let v = 0; v < trunkPos.count; v++) {
      positions.push(trunkPos.getX(v), trunkPos.getY(v), trunkPos.getZ(v));
      const nx = trunk.attributes.normal?.getX(v) || 0;
      const ny = trunk.attributes.normal?.getY(v) || 1;
      const nz = trunk.attributes.normal?.getZ(v) || 0;
      normals.push(nx, ny, nz);
    }
    if (trunkIdx) {
      for (let i = 0; i < trunkIdx.count; i++) {
        indices.push(trunkIdx.getX(i) + vertexOffset);
      }
    } else {
      for (let i = 0; i < trunkPos.count; i++) indices.push(i + vertexOffset);
    }
    vertexOffset = positions.length / 3;

    // Cones (stacked upward)
    const coneOffsets = [1.3, 1.8, 2.25];
    for (let c = 0; c < cones.length; c++) {
      const cone = cones[c];
      const cp = cone.attributes.position;
      for (let v = 0; v < cp.count; v++) {
        positions.push(cp.getX(v), cp.getY(v) + coneOffsets[c], cp.getZ(v));
        normals.push(
          cone.attributes.normal?.getX(v) || 0,
          cone.attributes.normal?.getY(v) || 1,
          cone.attributes.normal?.getZ(v) || 0,
        );
      }
      const ci = cone.index;
      if (ci) {
        for (let i = 0; i < ci.count; i++) {
          indices.push(ci.getX(i) + vertexOffset);
        }
      } else {
        for (let i = 0; i < cp.count; i++) indices.push(i + vertexOffset);
      }
      vertexOffset = positions.length / 3;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();

    const mat = new THREE.MeshBasicMaterial({ color: 0x0a0a0a });
    return { treeGeo: geo, treeMat: mat };
  }, []);

  // Place trees on terrain — baked once
  const instancedData = useMemo(() => {
    const arr: TreePlacement[] = [];
    const terrainSpan = 25;
    for (let i = 0; i < treeCount; i++) {
      const x = (Math.random() - 0.5) * terrainSpan * 2;
      const z = (Math.random() - 0.5) * terrainSpan * 2;
      const y = terrainHeight(x, z);
      arr.push({ x, y, z, scale: 0.7 + Math.random() * 0.6, phase: Math.random() * Math.PI * 2 });
    }
    return arr;
  }, [treeCount]);

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    timeRef.current += delta;
    const t = timeRef.current;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < instancedData.length; i++) {
      const p = instancedData[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.scale.setScalar(p.scale);
      dummy.rotation.z = Math.sin(t * 0.4 + p.phase) * 0.04;
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[treeGeo, treeMat, instancedData.length]}
      renderOrder={2}
    />
  );
}
