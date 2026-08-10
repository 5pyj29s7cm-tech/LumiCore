export const LUMI_SCENE_PROTOCOL = 'lumi-scene/1' as const;
export const LUMI_SCENE_SCHEMA_VERSION = 1 as const;

export type LumiSceneNodeKind = 'group' | 'status' | 'metric' | 'task' | 'evidence' | 'text';
export type LumiSceneTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface LumiSceneNode {
  id: string;
  kind: LumiSceneNodeKind;
  title: string;
  value?: string | number | boolean;
  detail?: string;
  tone?: LumiSceneTone;
  children?: LumiSceneNode[];
}

export interface LumiSceneSnapshot {
  protocol: typeof LUMI_SCENE_PROTOCOL;
  schemaVersion: typeof LUMI_SCENE_SCHEMA_VERSION;
  sceneId: string;
  revision: number;
  digest: string;
  generatedAt: string;
  nodes: LumiSceneNode[];
}

export type LumiScenePatchOperation =
  | { op: 'upsert_node'; node: LumiSceneNode }
  | { op: 'remove_node'; nodeId: string }
  | { op: 'replace_nodes'; nodes: LumiSceneNode[] };

export interface LumiScenePatch {
  protocol: typeof LUMI_SCENE_PROTOCOL;
  schemaVersion: typeof LUMI_SCENE_SCHEMA_VERSION;
  sceneId: string;
  baseRevision: number;
  revision: number;
  digest: string;
  generatedAt: string;
  operations: LumiScenePatchOperation[];
}

export type LumiSceneApplyResult =
  | { status: 'applied'; snapshot: LumiSceneSnapshot }
  | { status: 'resync_required'; reason: string }
  | { status: 'rejected'; reason: string };

const KINDS = new Set<LumiSceneNodeKind>(['group', 'status', 'metric', 'task', 'evidence', 'text']);
const TONES = new Set<LumiSceneTone>(['neutral', 'info', 'success', 'warning', 'danger']);
const MAX_ROOT_NODES = 24;
const MAX_TOTAL_NODES = 100;
const MAX_DEPTH = 4;

function compact(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [
    key,
    stable((value as Record<string, unknown>)[key]),
  ]));
}

export function lumiSceneDigest(nodes: LumiSceneNode[]): string {
  // Synchronous and runtime-neutral (browser + Node). This digest detects
  // revision gaps/corruption; transport authentication remains responsible
  // for adversarial integrity.
  const input = JSON.stringify(stable(nodes));
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds.map(seed => {
    let hash = seed >>> 0;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }).join('');
}

function normalizeValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return compact(value, 600);
  return undefined;
}

function normalizeNode(value: unknown, depth: number, counter: { value: number }): LumiSceneNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('scene_node_must_be_object');
  if (depth > MAX_DEPTH) throw new Error('scene_depth_exceeded');
  counter.value += 1;
  if (counter.value > MAX_TOTAL_NODES) throw new Error('scene_node_limit_exceeded');
  const raw = value as Record<string, unknown>;
  const allowedKeys = new Set(['id', 'kind', 'title', 'value', 'detail', 'tone', 'children']);
  if (Object.keys(raw).some(key => !allowedKeys.has(key))) throw new Error('scene_node_contains_unsupported_field');
  const id = compact(raw.id, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(id)) throw new Error('scene_node_id_invalid');
  const kind = compact(raw.kind, 30) as LumiSceneNodeKind;
  if (!KINDS.has(kind)) throw new Error('scene_node_kind_invalid');
  const title = compact(raw.title, 300);
  if (!title) throw new Error('scene_node_title_required');
  const tone = raw.tone === undefined ? undefined : compact(raw.tone, 20) as LumiSceneTone;
  if (tone && !TONES.has(tone)) throw new Error('scene_node_tone_invalid');
  const children = raw.children === undefined
    ? undefined
    : Array.isArray(raw.children)
      ? raw.children.map(child => normalizeNode(child, depth + 1, counter))
      : (() => { throw new Error('scene_node_children_invalid'); })();
  return {
    id,
    kind,
    title,
    ...(normalizeValue(raw.value) !== undefined ? { value: normalizeValue(raw.value) } : {}),
    ...(raw.detail !== undefined ? { detail: compact(raw.detail, 1200) } : {}),
    ...(tone ? { tone } : {}),
    ...(children && children.length > 0 ? { children } : {}),
  };
}

export function normalizeLumiSceneNodes(nodes: unknown): LumiSceneNode[] {
  if (!Array.isArray(nodes)) throw new Error('scene_nodes_must_be_array');
  if (nodes.length > MAX_ROOT_NODES) throw new Error('scene_root_limit_exceeded');
  const counter = { value: 0 };
  const normalized = nodes.map(node => normalizeNode(node, 0, counter));
  const ids = new Set<string>();
  const visit = (node: LumiSceneNode) => {
    if (ids.has(node.id)) throw new Error('scene_node_id_duplicate');
    ids.add(node.id);
    node.children?.forEach(visit);
  };
  normalized.forEach(visit);
  return normalized;
}

export function createLumiSceneSnapshot(input: {
  sceneId: string;
  revision: number;
  nodes: unknown;
  generatedAt?: string;
}): LumiSceneSnapshot {
  const sceneId = compact(input.sceneId, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(sceneId)) throw new Error('scene_id_invalid');
  const revision = Math.max(1, Math.floor(Number(input.revision) || 1));
  const nodes = normalizeLumiSceneNodes(input.nodes);
  return {
    protocol: LUMI_SCENE_PROTOCOL,
    schemaVersion: LUMI_SCENE_SCHEMA_VERSION,
    sceneId,
    revision,
    digest: lumiSceneDigest(nodes),
    generatedAt: input.generatedAt || new Date().toISOString(),
    nodes,
  };
}

export function validateLumiSceneSnapshot(value: unknown): LumiSceneSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('scene_snapshot_invalid');
  const snapshot = value as Record<string, any>;
  if (snapshot.protocol !== LUMI_SCENE_PROTOCOL || snapshot.schemaVersion !== LUMI_SCENE_SCHEMA_VERSION) {
    throw new Error('scene_protocol_unsupported');
  }
  const normalized = createLumiSceneSnapshot({
    sceneId: snapshot.sceneId,
    revision: snapshot.revision,
    nodes: snapshot.nodes,
    generatedAt: compact(snapshot.generatedAt, 80),
  });
  if (snapshot.digest !== normalized.digest) throw new Error('scene_snapshot_digest_mismatch');
  return normalized;
}

export function diffLumiSceneSnapshots(previous: LumiSceneSnapshot, next: LumiSceneSnapshot): LumiScenePatch {
  if (previous.sceneId !== next.sceneId) throw new Error('scene_id_mismatch');
  if (next.revision !== previous.revision + 1) throw new Error('scene_revision_not_sequential');
  const previousById = new Map(previous.nodes.map(node => [node.id, node]));
  const nextById = new Map(next.nodes.map(node => [node.id, node]));
  const operations: LumiScenePatchOperation[] = [];
  for (const node of next.nodes) {
    const prior = previousById.get(node.id);
    if (!prior || JSON.stringify(stable(prior)) !== JSON.stringify(stable(node))) operations.push({ op: 'upsert_node', node });
  }
  for (const node of previous.nodes) if (!nextById.has(node.id)) operations.push({ op: 'remove_node', nodeId: node.id });
  if (operations.length > Math.max(8, next.nodes.length)) {
    operations.splice(0, operations.length, { op: 'replace_nodes', nodes: next.nodes });
  }
  return {
    protocol: LUMI_SCENE_PROTOCOL,
    schemaVersion: LUMI_SCENE_SCHEMA_VERSION,
    sceneId: next.sceneId,
    baseRevision: previous.revision,
    revision: next.revision,
    digest: next.digest,
    generatedAt: next.generatedAt,
    operations,
  };
}

export function applyLumiScenePatch(current: LumiSceneSnapshot, value: unknown): LumiSceneApplyResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'rejected', reason: 'scene_patch_invalid' };
  const patch = value as Record<string, any>;
  if (patch.protocol !== LUMI_SCENE_PROTOCOL || patch.schemaVersion !== LUMI_SCENE_SCHEMA_VERSION) {
    return { status: 'rejected', reason: 'scene_protocol_unsupported' };
  }
  if (patch.sceneId !== current.sceneId) return { status: 'resync_required', reason: 'scene_id_mismatch' };
  if (Number(patch.baseRevision) !== current.revision || Number(patch.revision) !== current.revision + 1) {
    return { status: 'resync_required', reason: 'scene_revision_gap' };
  }
  if (!Array.isArray(patch.operations) || patch.operations.length > 100) return { status: 'rejected', reason: 'scene_operations_invalid' };

  try {
    let nodes = [...current.nodes];
    for (const rawOperation of patch.operations) {
      if (!rawOperation || typeof rawOperation !== 'object' || Array.isArray(rawOperation)) throw new Error('scene_operation_invalid');
      const operation = rawOperation as Record<string, any>;
      const allowedOperationKeys = operation.op === 'upsert_node'
        ? new Set(['op', 'node'])
        : operation.op === 'remove_node'
          ? new Set(['op', 'nodeId'])
          : operation.op === 'replace_nodes'
            ? new Set(['op', 'nodes'])
            : null;
      if (!allowedOperationKeys || Object.keys(operation).some(key => !allowedOperationKeys.has(key))) throw new Error('scene_operation_unsupported');
      if (operation.op === 'replace_nodes') {
        nodes = normalizeLumiSceneNodes(operation.nodes);
      } else if (operation.op === 'remove_node') {
        const nodeId = compact(operation.nodeId, 100);
        nodes = nodes.filter(node => node.id !== nodeId);
      } else {
        const node = normalizeLumiSceneNodes([operation.node])[0];
        const index = nodes.findIndex(candidate => candidate.id === node.id);
        nodes = index >= 0 ? nodes.map(candidate => candidate.id === node.id ? node : candidate) : [...nodes, node];
      }
    }
    nodes = normalizeLumiSceneNodes(nodes);
    if (lumiSceneDigest(nodes) !== patch.digest) return { status: 'resync_required', reason: 'scene_patch_digest_mismatch' };
    return {
      status: 'applied',
      snapshot: createLumiSceneSnapshot({
        sceneId: current.sceneId,
        revision: patch.revision,
        nodes,
        generatedAt: compact(patch.generatedAt, 80),
      }),
    };
  } catch (error: any) {
    return { status: 'rejected', reason: compact(error?.message || error, 180) || 'scene_patch_rejected' };
  }
}
