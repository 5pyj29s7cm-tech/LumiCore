import { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { TreeNode3D } from './types';

interface MemoryNodesProps {
  nodes: TreeNode3D[];
  dimmedIds?: Set<string>;
  highlightedId?: string | null;
}

export function MemoryNodes({ nodes, dimmedIds, highlightedId }: MemoryNodesProps) {
  const meshGroupRef = useRef<THREE.Group>(null);
  const glowGroupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    const mGroup = meshGroupRef.current;
    const gGroup = glowGroupRef.current;
    if (!mGroup || !gGroup) return;
    mGroup.clear();
    gGroup.clear();

    const coreGeo = new THREE.IcosahedronGeometry(0.06, 1);
    const glowGeo = new THREE.SphereGeometry(0.14, 8, 8);

    for (const node of nodes) {
      const dimmed = dimmedIds?.has(node.id) ?? false;
      const hl = highlightedId === node.id;
      const hue = node.hue;

      const color = new THREE.Color();
      if (dimmed) color.setHSL(hue / 360, 0.05, 0.05);
      else if (hl) color.setHSL(hue / 360, 1.0, 0.9);
      else color.setHSL(hue / 360, 0.7, 0.55);

      const coreMat = new THREE.MeshBasicMaterial({
        color, transparent: true,
        opacity: dimmed ? 0.12 : hl ? 1 : 0.85,
        depthWrite: true,
      });
      const mesh = new THREE.Mesh(coreGeo, coreMat);
      mesh.position.copy(node.position);
      mesh.userData = { nodeId: node.id };
      mGroup.add(mesh);

      // Glow halo
      if (!dimmed || hl) {
        const glowColor = new THREE.Color().setHSL(hue / 360, 0.6, 0.45);
        const glowMat = new THREE.MeshBasicMaterial({
          color: glowColor,
          transparent: true,
          opacity: hl ? 0.35 : 0.12,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const glowMesh = new THREE.Mesh(glowGeo, glowMat);
        glowMesh.position.copy(node.position);
        gGroup.add(glowMesh);
      }
    }

    return () => { mGroup.clear(); gGroup.clear(); };
  }, [nodes, dimmedIds, highlightedId]);

  return (
    <group renderOrder={4}>
      <group ref={glowGroupRef} />
      <group ref={meshGroupRef} />
    </group>
  );
}
