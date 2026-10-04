import { Memory, MemoryTree } from './types';
import { listMemoryRows, updateMemoryRow, insertMemoryRow, type MemoryOwnerScope } from './repository';

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

/** Moves share the same parent/owner/cycle validation as ordinary memory edits. */
export function moveNode(id: string, newParentId: string | null, scope: MemoryOwnerScope): boolean {
  try {
    return Boolean(updateMemoryRow(scope, id, memory => {
      memory.parentId = newParentId;
      memory.updatedAt = new Date().toISOString();
    }));
  } catch (error) { if (error instanceof RangeError) return false; throw error; }
}

/** Find or create a branch node with the given title */
export function ensureBranch(
  userId: string,
  title: string,
  agentId: string = '',
  parentId: string | null = null,
  scope: { domain?: 'personal' | 'work'; orgId?: string } = {},
): Memory {
  const domain = scope.domain || 'personal';
  const orgId = scope.orgId || '';
  const owner = { userId, domain, orgId, agentId };

  // Check if branch already exists
  const existing = listMemoryRows(owner).find(memory => memory.nodeType === 'branch'
    && memory.content === title && memory.parentId === parentId);
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
  return insertMemoryRow(owner, branch);
}
