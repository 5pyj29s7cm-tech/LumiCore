export type MemoryType = 'preference' | 'fact' | 'habit' | 'knowledge';

/** Memory hierarchy tier — determines decay rate and retrieval priority */
export type MemoryTier = 'episodic'       // Raw conversation memories, fast decay
                       | 'internalized'  // Internalized preferences (Lumi's own)
                       | 'growth'        // Growth narratives, LLM-consolidated
                       | 'core_identity';// Core identity, never decays, protected

/** Whose perspective does this memory belong to */
export type MemoryPerspective = 'owner_trait'   // About the owner's traits
                              | 'lumi_self'     // Lumi's self-knowledge
                              | 'shared_memory' // "Our" shared experiences
                              | 'lumi_growth';  // Lumi's growth milestones

export type MemorySource = 'chat' | 'voice' | 'runtime_log' | 'meeting' | 'manual' | 'organization' | 'lap' | 'community' | 'external_app' | 'system' | 'import' | 'consolidation';
export type MemoryPrivacyClass = 'private' | 'organization' | 'shared' | 'public' | 'secret';
export type MemoryRetention = 'ephemeral' | 'session' | 'long_term' | 'permanent';

/** Evidence role derived from durable metadata, never guessed from prose. */
export type MemoryEvidenceClass = 'owner_statement'
                                | 'owner_observation'
                                | 'shared_context'
                                | 'lumi_narrative'
                                | 'operational_trace';

/** Evidence classes safe to use as context about the owner in ordinary turns. */
export const CONVERSATIONAL_MEMORY_EVIDENCE: readonly MemoryEvidenceClass[] = [
  'owner_statement',
  'owner_observation',
  'shared_context',
];

export interface MemoryConflictEvidence {
  status: 'unresolved' | 'resolved';
  relatedMemoryIds: string[];
  detectedAt: string;
  resolvedAt?: string;
  resolution?: 'keep_both' | 'prefer_one' | 'related_removed';
  chosenMemoryId?: string;
}

/** Tree node type — branch nodes are topic containers, leaves are actual memories */
export type MemoryNodeType = 'branch' | 'leaf';

export interface Memory {
  id: string;
  userId: string;
  type: MemoryType;
  /** The memory text, e.g. "User prefers concise answers" */
  content: string;
  /** Normalized keywords for retrieval matching */
  keywords: string[];
  /** 0–1 confidence. Repeated confirmations raise it, contradictions lower it. */
  confidence: number;
  /** Interaction ID that produced this memory */
  sourceInteractionId: string;
  /** Immutable source/chunk evidence for imported knowledge memories. */
  knowledgeProvenance?: {
    sourceId: string;
    sourceLabel: string;
    sourcePath?: string;
    sourceRevision: string;
    /** SHA-256 of the original file bytes, when the source is file-backed. */
    sourceFileHash?: string;
    sourceModifiedAtMs?: number;
    sourceSizeBytes?: number;
    chunkIndex: number;
    chunkCount: number;
    chunkContentHash: string;
    citationKey: string;
    ingestedAt: string;
  };
  /** Explicit, reviewable contradiction links; both memories remain stored. */
  conflict?: MemoryConflictEvidence;
  createdAt: string;
  updatedAt: string;
  lastRetrievedAt: string | null;
  retrieveCount: number;
  /** Memory hierarchy tier */
  tier: MemoryTier;
  /** Whose perspective */
  perspective: MemoryPerspective;
  /** 0–1 importance — separate from confidence. Core identity has 0.9+ */
  importance: number;
  /** Points to parent node in the memory tree, null if root */
  parentId: string | null;
  /** Stable Lumi scope ID for private memories. Empty string = shared. */
  agentId: string;
  /** Tree node type: 'branch' = topic container, 'leaf' = content memory. Default 'leaf' */
  nodeType: MemoryNodeType;
  /** Location where this memory was formed (e.g. 'home', 'office', 'cafe', 'mobile') */
  location?: string;
  /** 1536-dimension embedding vector from text-embedding-3-small for semantic search */
  embedding?: number[];
  /** Domain: personal or work */
  domain?: string;
  /** Organization ID (work domain only) */
  orgId?: string;
  /** Source surface that created this memory. Used by the global Memory Firewall. */
  source?: MemorySource;
  /** Privacy class assigned by Memory Firewall. */
  privacyClass?: MemoryPrivacyClass;
  /** Retention policy assigned by Memory Firewall. */
  retention?: MemoryRetention;
  /** Whether the user explicitly approved this memory for protected/permanent storage. */
  userApproved?: boolean;
  /** Firewall decision that admitted the memory. */
  firewall?: {
    accepted: boolean;
    reason: string;
    appliedAt: string;
  };
}

export interface MemoryTree {
  node: Memory;
  children: MemoryTree[];
}

export interface MemoryQuery {
  userId?: string;
  /** Free-text search — matched against keywords and content */
  query?: string;
  /**
   * Include raw operational workflow traces in retrieval results.
   * Defaults to false so execution receipts do not leak into conversational memory.
   */
  includeOperationalTraces?: boolean;
  /** Restrict recall by evidence role (for example, exclude Lumi narratives from owner context). */
  evidenceClasses?: readonly MemoryEvidenceClass[];
  type?: MemoryType;
  limit?: number;
  minConfidence?: number;
  tier?: MemoryTier;
  perspective?: MemoryPerspective;
  minImportance?: number;
  /** Only return memories without parentId (unconsolidated originals) */
  unconsolidatedOnly?: boolean;
  /** Filter by stable Lumi scope ID (empty string matches shared memories). */
  agentId?: string;
  /** Filter by parent node — null = root only, string = children of that node */
  parentId?: string | null;
  /** Filter by node type */
  nodeType?: MemoryNodeType;
  /** ISO 8601 cutoff — only return memories created on or before this date */
  before?: string;
  /** ISO 8601 cutoff — only return memories created on or after this date */
  after?: string;
  /** Filter by location tag (e.g. 'home', 'office', 'cafe') */
  location?: string;
  /** Personality vector for retrieval biasing — higher warmth prefers shared/personal memories */
  personalityVector?: { cognitiveStyle: Record<string,number>; socialStyle: Record<string,number> };
  /** Pre-computed type weights from vectorMemoryBias() */
  retrievalTypeWeights?: Record<string, number>;
  /** Pre-computed perspective weights from vectorMemoryBias() */
  retrievalPerspectiveWeights?: Record<string, number>;
  /** Enable vector semantic search via embedding cosine similarity */
  useVector?: boolean;
  /** Filter by domain */
  domain?: string;
  /** Filter by organization ID */
  orgId?: string;
}

export interface ExtractedMemory {
  type: MemoryType;
  content: string;
  keywords: string[];
  confidence: number;
}
