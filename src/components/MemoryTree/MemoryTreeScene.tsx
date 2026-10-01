import React, { useMemo, useRef, useCallback } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { EffectComposer, Bloom, DepthOfField } from '@react-three/postprocessing';
import * as THREE from 'three';
import { StarfieldBackground } from './StarfieldBackground';
import { ParticleField } from './ParticleField';
import { OrbitalRings } from './OrbitalRings';
import { MemoryNodes } from './MemoryNodes';
import { TreeNode3D, BranchCurve3D } from './types';

interface MemoryTreeSceneProps {
  nodes: TreeNode3D[];
  curves: BranchCurve3D[];
  searchQuery: string;
  highlightedNodeId?: string | null;
  onNodeClick?: (id: string, screenX: number, screenY: number) => void;
  onNodeDoubleClick?: (id: string) => void;
}

function SceneContent({
  nodes,
  curves,
  searchQuery,
  highlightedNodeId,
  onNodeClick,
  onNodeDoubleClick,
}: MemoryTreeSceneProps) {
  const { camera, scene, gl } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const mouse = useMemo(() => new THREE.Vector2(), []);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const lastClick = useRef(0);

  const dimmedIds = useMemo(() => {
    if (!searchQuery.trim()) return undefined;
    const q = searchQuery.toLowerCase();
    const set = new Set<string>();
    for (const n of nodes) {
      const titleMatch = n.title.toLowerCase().includes(q);
      const contentMatch = n.memoryData?.content?.toLowerCase().includes(q);
      if (!titleMatch && !contentMatch) set.add(n.id);
    }
    return set;
  }, [nodes, searchQuery]);

  // ── Click handling via raycaster ──
  const handlePointerDown = useCallback((e: PointerEvent) => {
    dragStart.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handlePointerUp = useCallback((e: PointerEvent) => {
    if (!dragStart.current || !onNodeClick) return;

    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    const dragged = Math.sqrt(dx * dx + dy * dy) > 3; // 3px threshold for drag vs click
    dragStart.current = null;

    if (dragged) return; // was orbiting, not clicking

    // Double-click detection
    const now = Date.now();
    const isDouble = now - lastClick.current < 350;
    lastClick.current = now;

    // Normalize device coords
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    // Find all meshes with userData.nodeId
    const targets: THREE.Object3D[] = [];
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.userData.nodeId) {
        targets.push(obj);
      }
    });

    const intersects = raycaster.intersectObjects(targets, false);
    if (intersects.length > 0) {
      const obj = intersects[0].object;
      const nodeId = obj.userData.nodeId as string;
      if (!nodeId) return;

      const worldPos = new THREE.Vector3();
      obj.getWorldPosition(worldPos);
      const screenPos = worldPos.clone().project(camera);
      const sx = (screenPos.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-screenPos.y * 0.5 + 0.5) * window.innerHeight;

      if (isDouble && onNodeDoubleClick) {
        onNodeDoubleClick(nodeId);
      } else {
        onNodeClick(nodeId, sx, sy);
      }
    }
  }, [camera, scene, mouse, raycaster, onNodeClick, onNodeDoubleClick]);

  // Attach native listeners to the canvas for reliable click detection
  React.useEffect(() => {
    const canvas = gl.domElement;
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointerup', handlePointerUp);
    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointerup', handlePointerUp);
    };
  }, [gl, handlePointerDown, handlePointerUp]);

  // Nebula fog
  const fogPlane = useMemo(() => {
    const size = 50;
    const geo = new THREE.PlaneGeometry(size, size);
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(128, 100, 0, 128, 128, 200);
    grad.addColorStop(0, 'rgba(15, 20, 40, 0.3)');
    grad.addColorStop(0.35, 'rgba(8, 12, 25, 0.15)');
    grad.addColorStop(0.7, 'rgba(3, 5, 12, 0.05)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    return { geo, mat };
  }, []);

  return (
    <>
      {/* Deep void glow */}
      <mesh geometry={fogPlane.geo} material={fogPlane.mat} position={[0, 0, -18]} renderOrder={-1} />

      {/* Starfield */}
      <StarfieldBackground hue={35} />

      {/* Orbital rings — main visual structure */}
      <OrbitalRings hue={100} syncRate={1} />

      {/* Floating memory nodes — time on Y, tier on radius */}
      <MemoryNodes
        nodes={nodes}
        dimmedIds={dimmedIds}
        highlightedId={highlightedNodeId}
      />

      {/* Ambient particles */}
      <ParticleField nodes={nodes} curves={curves} hue={100} />

      {/* Post-processing */}
      <EffectComposer>
        <Bloom intensity={0.8} luminanceThreshold={0.4} mipmapBlur />
        <DepthOfField focusDistance={3.5} focalLength={0.03} bokehScale={3} />
      </EffectComposer>

      {/* Controls */}
      <OrbitControls
        enablePan={false}
        enableZoom={true}
        minDistance={2.0}
        maxDistance={10}
        autoRotate={true}
        autoRotateSpeed={0.35}
        maxPolarAngle={Math.PI * 0.75}
        minPolarAngle={Math.PI * 0.15}
        target={[0, 0, 0]}
      />
    </>
  );
}

export function MemoryTreeScene(props: MemoryTreeSceneProps) {
  return (
    <div className="absolute inset-0">
      <Canvas
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        camera={{ position: [0, 0.2, 5], fov: 48, near: 0.1, far: 50 }}
        style={{ background: 'transparent' }}
      >
        <React.Suspense fallback={null}>
          <SceneContent {...props} />
        </React.Suspense>
      </Canvas>
    </div>
  );
}
