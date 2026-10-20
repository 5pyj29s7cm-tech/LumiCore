import * as THREE from 'three';
import { TreeNode3D, MemoryNode, FileEntry, BranchCurve3D } from './types';

const TIER_RADII: Record<string, number> = {
  core_identity: 0.15,
  growth: 0.5,
  internalized: 0.85,
  episodic: 1.2,
};

const TIER_HUES: Record<string, number> = {
  core_identity: 140,
  growth: 120,
  internalized: 105,
  episodic: 90,
};
const FILE_HUE = 130;

const COLUMN_BASE_Y = -1.8;
const COLUMN_TOP_Y = 1.8;
const COLUMN_HEIGHT = COLUMN_TOP_Y - COLUMN_BASE_Y;

function hashAngle(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h) + id.charCodeAt(i);
  return (Math.abs(h) % 1000) / 1000 * Math.PI * 2;
}

export function layoutTree3D(
  memories: MemoryNode[],
  files: FileEntry[],
): { nodes: TreeNode3D[]; curves: BranchCurve3D[] } {
  const memNodes = new Map<string, TreeNode3D>();
  const childrenMap = new Map<string, string[]>();

  for (const m of memories) {
    const hue = TIER_HUES[m.tier] || 90;
    const node: TreeNode3D = {
      id: m.id, type: m.nodeType === 'branch' ? 'branch' : 'leaf',
      title: m.content.length > 40 ? m.content.slice(0, 38) + '…' : m.content,
      hue, tier: m.tier, depth: 0,
      position: new THREE.Vector3(),
      children: [], memoryData: m,
      radius: m.nodeType === 'branch' ? 0.06 : 0.05,
    };
    memNodes.set(m.id, node);
    if (m.parentId) {
      if (!childrenMap.has(m.parentId)) childrenMap.set(m.parentId, []);
      childrenMap.get(m.parentId)!.push(m.id);
    }
  }

  for (const [pid, cids] of childrenMap) {
    const parent = memNodes.get(pid);
    if (!parent) continue;
    for (const cid of cids) parent.children.push(memNodes.get(cid)!);
  }

  const fileNodes: TreeNode3D[] = files.map(f => ({
    id: f.id, type: 'file' as const, title: f.sourceTitle || f.displayName || f.name,
    hue: FILE_HUE, depth: 0, position: new THREE.Vector3(),
    children: [], fileData: f, radius: 0.04,
  }));

  // ── Position nodes by time (y-axis) and tier (radius) ──
  const memsWithDates = [...memNodes.values()].filter(m => m.memoryData?.createdAt);
  const dates = memsWithDates.map(m => new Date(m.memoryData!.createdAt!).getTime());
  const minT = dates.length > 0 ? Math.min(...dates) : Date.now() - 86400000 * 365;
  const maxT = dates.length > 0 ? Math.max(...dates) : Date.now();
  const timeRange = maxT - minT || 1;

  for (const node of memNodes.values()) {
    const created = node.memoryData?.createdAt;
    const t = created ? new Date(created).getTime() : minT + Math.random() * timeRange;
    const yFrac = (t - minT) / timeRange;
    const y = COLUMN_BASE_Y + yFrac * COLUMN_HEIGHT;

    const radius = TIER_RADII[node.tier || 'episodic'] || 1.0;
    const angle = hashAngle(node.id);

    node.position.set(
      Math.cos(angle) * radius * (0.7 + Math.random() * 0.3),
      y,
      Math.sin(angle) * radius * 0.6 * (0.7 + Math.random() * 0.3),
    );
  }

  // File nodes scattered in a ring
  for (let i = 0; i < fileNodes.length; i++) {
    const angle = hashAngle(fileNodes[i].id);
    const r = 1.3 + Math.random() * 0.5;
    const y = COLUMN_BASE_Y + (i / Math.max(fileNodes.length, 1)) * COLUMN_HEIGHT;
    fileNodes[i].position.set(Math.cos(angle) * r, y, Math.sin(angle) * r * 0.6);
  }

  // Build connector curves (thin arcs between nodes of same tier, for visual connection)
  const curves: BranchCurve3D[] = [];
  const byTier = new Map<string, TreeNode3D[]>();
  for (const n of memNodes.values()) {
    const t = n.tier || 'episodic';
    if (!byTier.has(t)) byTier.set(t, []);
    byTier.get(t)!.push(n);
  }
  for (const group of byTier.values()) {
    if (group.length < 2) continue;
    // Sort by y (time)
    group.sort((a, b) => a.position.y - b.position.y);
    for (let i = 0; i < group.length - 1; i++) {
      const a = group[i].position;
      const b = group[i + 1].position;
      const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
      mid.y += 0.1;
      curves.push({
        curve: new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone()),
        radiusStart: 0.006, radiusEnd: 0.006,
        hueStart: group[i].hue, hueEnd: group[i + 1].hue, depth: 0,
      });
    }
  }

  const allNodes: TreeNode3D[] = [...buildSeedNodes(), ...memNodes.values(), ...fileNodes];
  return { nodes: allNodes, curves };
}

// ── Seed (no data) ──

function buildSeedNodes(): TreeNode3D[] {
  const nodes: TreeNode3D[] = [];
  const tierDefs = [
    { tier: 'core_identity', count: 8, label: 'Core' },
    { tier: 'growth', count: 15, label: 'Growth' },
    { tier: 'internalized', count: 20, label: 'Knowledge' },
    { tier: 'episodic', count: 30, label: 'Memory' },
  ];

  for (const def of tierDefs) {
    const radius = TIER_RADII[def.tier] || 1.0;
    const hue = TIER_HUES[def.tier] || 90;
    for (let i = 0; i < def.count; i++) {
      const angle = (i / def.count) * Math.PI * 2 + Math.random() * 0.2;
      const r = radius * (0.7 + Math.random() * 0.3);
      const y = COLUMN_BASE_Y + (i / def.count) * COLUMN_HEIGHT;
      nodes.push({
        id: `seed-${def.tier}-${i}`,
        type: 'leaf',
        title: `${def.label} Node #${i + 1}`,
        hue, tier: def.tier, depth: 0,
        position: new THREE.Vector3(
          Math.cos(angle) * r,
          y,
          Math.sin(angle) * r * 0.6,
        ),
        children: [], radius: 0.05,
      });
    }
  }

  return nodes;
}
