import { Memory, MemoryTree } from './types';
import { readDB, writeDB } from '../../db_layer';

/** Build a nested tree from a flat list of memories */
export function buildTree(memories: Memory[]): MemoryTree[] {
  const map = new Map<string, MemoryTree>();
  const roots: MemoryTree[] = [];

  // First pass: create all nodes
  for (const m of memories) {
    map.set(m.id, { node: m, children: [] });
  }

  // Second pass: link children to parents
  for (const m of memories) {
    const treeNode = map.get(m.id)!;
    if (m.parentId && map.has(m.parentId)) {
      map.get(m.parentId)!.children.push(treeNode);
    } else {
      roots.push(treeNode);
    }
  }

  // Sort children: branches first, then by importance desc
  const sortChildren = (tree: MemoryTree[]) => {
    for (const t of tree) {
      t.children.sort((a, b) => {
        if (a.node.nodeType !== b.node.nodeType) {
          return a.node.nodeType === 'branch' ? -1 : 1;
        }
        return (b.node.importance || 0) - (a.node.importance || 0);
      });
      sortChildren(t.children);
    }
  };
  sortChildren(roots);

  return roots;
}

/** Flatten tree back to a list */
export function flattenTree(tree: MemoryTree[]): Memory[] {
  const result: Memory[] = [];
  const walk = (nodes: MemoryTree[]) => {
    for (const t of nodes) {
      result.push(t.node);
      walk(t.children);
    }
  };
  walk(tree);
  return result;
}

/** Move a node to a new parent. Validates no circular references. */
export function moveNode(
  id: string,
  newParentId: string | null,
  scope?: { userId?: string; domain?: string; orgId?: string },
): boolean {
  const db = readDB();
  if (!db.memories) return false;

  const memory = db.memories.find((m: Memory) => m.id === id);
  if (!memory) return false;
  if (scope?.userId && memory.userId !== scope.userId) return false;
  if (scope?.domain && (memory.domain || 'personal') !== scope.domain) return false;
  if (scope?.orgId !== undefined && (memory.orgId || '') !== scope.orgId) return false;

  // Prevent circular: if newParentId is set, ensure it's not a descendant of id
  if (newParentId) {
    const descendants = getAllDescendantIds(id, db.memories);
    if (descendants.has(newParentId)) return false;
    // Parent must exist
    const parent = db.memories.find((m: Memory) => m.id === newParentId);
    if (!parent) return false;
    if (parent.userId !== memory.userId) return false;
    if ((parent.domain || 'personal') !== (memory.domain || 'personal')) return false;
    if ((parent.orgId || '') !== (memory.orgId || '')) return false;
  }

  memory.parentId = newParentId;
  memory.updatedAt = new Date().toISOString();
  writeDB(db);
  return true;
}

/** Get all descendant IDs (children, grandchildren, etc.) */
export function getAllDescendantIds(id: string, memories?: Memory[]): Set<string> {
  const store = memories || readDB().memories || [];
  const result = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const m of store) {
      if (m.parentId === current && !result.has(m.id)) {
        result.add(m.id);
        queue.push(m.id);
      }
    }
  }
  return result;
}

/** Get the ancestor chain (breadcrumb) for a node */
export function getAncestors(id: string, memories?: Memory[]): Memory[] {
  const store = memories || readDB().memories || [];
  const ancestors: Memory[] = [];
  let current = store.find(m => m.id === id);
  while (current?.parentId) {
    const parent = store.find(m => m.id === current!.parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    current = parent;
  }
  return ancestors;
}

/** Find or create a branch node with the given title */
export function ensureBranch(
  userId: string,
  title: string,
  agentId: string = '',
  parentId: string | null = null,
  scope: { domain?: string; orgId?: string } = {},
): Memory {
  const db = readDB();
  if (!db.memories) db.memories = [];
  const domain = scope.domain || 'personal';
  const orgId = scope.orgId || '';

  // Check if branch already exists
  const existing = db.memories.find(
    (m: Memory) =>
      m.userId === userId &&
      m.nodeType === 'branch' &&
      m.content === title &&
      m.parentId === parentId &&
      (m.domain || 'personal') === domain &&
      (m.orgId || '') === orgId,
  );
  if (existing) return existing;

  const id = 'mem_' + crypto.randomUUID();
  const now = new Date().toISOString();
  const branch: Memory = {
    id,
    userId,
    type: 'knowledge',
    content: title,
    keywords: [title.toLowerCase()],
    confidence: 1,
    sourceInteractionId: 'auto_branch',
    createdAt: now,
    updatedAt: now,
    lastRetrievedAt: null,
    retrieveCount: 0,
    tier: 'internalized',
    perspective: 'owner_trait',
    importance: 0.5,
    parentId,
    agentId,
    nodeType: 'branch',
    domain,
    orgId,
  };
  db.memories.push(branch);
  writeDB(db);
  return branch;
}
