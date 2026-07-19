import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { terrainHeight } from './InkTerrain';

interface AgentNode {
  id: string;
  x: number;
  z: number;
  y: number;
  label: string;
  active: boolean;
  category: string;
  personalityId: string;
}

interface InkAgentsProps {
  nodes?: AgentNode[];
  connections?: { from: string; to: string }[];
  syncRate: number;
  theme: string;
}

// Simple pagoda/hut geometry — few stacked boxes
function createAgentMarker(active: boolean): THREE.Group {
  const group = new THREE.Group();
  if (active) {
    // Small tower: base + body + roof
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.2, 0.15, 6),
      new THREE.MeshBasicMaterial({ color: 0x111111 }),
    );
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.15, 0.5, 6),
      new THREE.MeshBasicMaterial({ color: 0x1a1a1a }),
    );
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(0.2, 0.3, 6),
      new THREE.MeshBasicMaterial({ color: 0x080808 }),
    );
    base.position.y = 0.075;
    body.position.y = 0.4;
    roof.position.y = 0.75;
    group.add(base, body, roof);
  } else {
    // Ruin marker: flat stone
    const stone = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.15, 0.1, 5),
      new THREE.MeshBasicMaterial({ color: 0x444444, transparent: true, opacity: 0.5 }),
    );
    stone.position.y = 0.05;
    group.add(stone);
  }
  return group;
}

export function InkAgents({ nodes, connections, syncRate, theme }: InkAgentsProps) {
  const pulseRefs = useRef<THREE.Mesh[]>([]);
  const pulseGroupRef = useRef<THREE.Group>(null);

  const nodeMap = useMemo(() => new Map((nodes || []).map(n => [n.id, n])), [nodes]);

  // Agent positions on terrain
  const nodePositions = useMemo(() => {
    if (!nodes) return [];
    return nodes.map(n => {
      const y = terrainHeight(n.x, n.z) + 0.5;
      return { ...n, position: new THREE.Vector3(n.x, y, n.z) };
    });
  }, [nodes]);

  // Connection arcs
  const arcCurves = useMemo(() => {
    if (!nodes || !connections) return [];
    const curves: { curve: THREE.QuadraticBezierCurve3; bandwidth: number }[] = [];
    for (const conn of connections) {
      const fromNode = nodeMap.get(conn.from);
      const toNode = nodeMap.get(conn.to);
      if (!fromNode || !toNode) continue;
      const fromY = terrainHeight(fromNode.x, fromNode.z) + 0.6;
      const toY = terrainHeight(toNode.x, toNode.z) + 0.6;
      const start = new THREE.Vector3(fromNode.x, fromY, fromNode.z);
      const end = new THREE.Vector3(toNode.x, toY, toNode.z);
      const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
      mid.y += 2.5;
      const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
      curves.push({ curve, bandwidth: 0.3 });
    }
    return curves;
  }, [nodes, connections, nodeMap]);

  // Arc line geometries
  const lineGeos = useMemo(() =>
    arcCurves.map(({ curve }) => {
      const pts = curve.getPoints(40);
      return new THREE.BufferGeometry().setFromPoints(pts);
    }),
    [arcCurves],
  );

  const lineMat = useMemo(() => new THREE.LineBasicMaterial({
    color: 0x333333,
    transparent: true,
    opacity: 0.3,
    depthWrite: true,
  }), []);

  // Pulse dots along arcs
  const pulseCount = Math.min(40, arcCurves.length * 3);
  const pulseData = useMemo(() => {
    const data: { arcIndex: number; t: number; speed: number }[] = [];
    for (let i = 0; i < pulseCount; i++) {
      if (arcCurves.length === 0) break;
      data.push({
        arcIndex: i % arcCurves.length,
        t: Math.random(),
        speed: 0.05 + Math.random() * 0.15,
      });
    }
    return data;
  }, [arcCurves.length, pulseCount]);

  const pulseGeo = useMemo(() => new THREE.SphereGeometry(0.08, 4, 4), []);
  const pulseMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: 0x222222,
    transparent: true,
    opacity: 0.5,
  }), []);

  // Pre-build agent marker meshes
  const markerGroupRef = useRef<THREE.Group>(null);
  const showDemoMarkers = (!nodes || nodes.length === 0) && (!connections || connections.length === 0);

  useFrame((_, delta) => {
    const dt = delta * syncRate;
    for (let i = 0; i < pulseRefs.current.length; i++) {
      const pulse = pulseRefs.current[i];
      if (!pulse) continue;
      const pd = pulseData[i];
      if (!pd) continue;
      pd.t += pd.speed * dt;
      if (pd.t > 1) pd.t -= 1;
      if (pd.t < 0) pd.t += 1;
      const curve = arcCurves[pd.arcIndex]?.curve;
      if (curve) {
        pulse.position.copy(curve.getPoint(pd.t));
      }
    }
  });

  // Build marker meshes imperatively
  React.useEffect(() => {
    const group = markerGroupRef.current;
    if (!group) return;
    group.clear();
    if (showDemoMarkers) {
      for (const [x, z] of [[-8, -5], [5, 3], [-3, 8], [10, -2], [-10, 2], [2, -8]]) {
        const marker = createAgentMarker(true);
        marker.position.set(x, terrainHeight(x, z) + 0.5, z);
        group.add(marker);
      }
      return () => { group.clear(); };
    }
    for (const np of nodePositions) {
      const marker = createAgentMarker(np.active);
      marker.position.copy(np.position);
      group.add(marker);
    }
    return () => { group.clear(); };
  }, [nodePositions, showDemoMarkers]);

  return (
    <group renderOrder={3}>
      {/* Agent markers */}
      <group ref={markerGroupRef} />

      {/* Connection arcs */}
      {lineGeos.map((geo, i) => (
        <lineSegments key={`arc-${i}`} geometry={geo}>
          <primitive object={lineMat} attach="material" />
        </lineSegments>
      ))}

      {/* Pulse dots */}
      <group ref={pulseGroupRef}>
        {pulseData.map((_pd, i) => (
          <mesh
            key={`pulse-${i}`}
            ref={(el) => { pulseRefs.current[i] = el!; }}
            geometry={pulseGeo}
            material={pulseMat}
          />
        ))}
      </group>
    </group>
  );
}
