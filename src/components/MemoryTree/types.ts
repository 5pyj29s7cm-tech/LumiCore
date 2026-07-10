import * as THREE from 'three';

// ── Data types (mirrors backend & existing interfaces) ──

export interface MemoryNode {
  id: string;
  userId?: string;
  type: 'preference' | 'fact' | 'habit' | 'knowledge';
  content: string;
  keywords?: string[];
  confidence: number;
  tier: 'episodic' | 'internalized' | 'growth' | 'core_identity';
  perspective?: string;
  importance: number;
  nodeType: 'branch' | 'leaf';
  createdAt?: string;
  updatedAt?: string;
  parentId: string | null;
}

export interface FileEntry {
  id: string;
  name: string;
  displayName?: string;
  path?: string;
  domain?: 'personal' | 'work';
  orgId?: string;
  size?: string;
  rawSize?: number;
  source?: 'upload' | 'generated' | 'ingested' | 'obsidian';
  agentIds?: string[];
  status?: 'ready' | 'indexing' | 'indexed' | 'partial' | 'unsupported' | 'failed';
  extractionStatus?: 'indexed' | 'partial' | 'unsupported' | 'failed';
  extractionMethod?: string;
  extractionWarning?: string;
  extractionError?: string;
  extractionProvider?: string;
  extractionModel?: string;
  contentChars?: number;
  sourceTitle?: string;
  sourceAliases?: string[];
  sourceTags?: string[];
  sourceLinks?: string[];
  sourceBacklinks?: string[];
  sourceProperties?: Record<string, unknown>;
  obsidianVaultId?: string;
  obsidianVaultName?: string;
  obsidianVaultPath?: string;
  obsidianRelativePath?: string;
  obsidianSourcePath?: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface ConversationEntry {
  id: string;
  userId?: string;
  agentId?: string;
  title: string;
  status: 'active' | 'paused' | 'closed';
  summary: string;
  messageCount: number;
  lastActiveAt: string;
  createdAt: string;
}

// ── 3D tree layout ──

export interface TreeNode3D {
  id: string;
  type: 'trunk' | 'branch' | 'leaf' | 'file' | 'conversation';
  title: string;
  hue: number;
  tier?: string;
  depth: number;
  /** World-space position from layout algorithm */
  position: THREE.Vector3;
  children: TreeNode3D[];
  memoryData?: MemoryNode;
  fileData?: FileEntry;
  conversationData?: ConversationEntry;
  /** Radius hint for rendering */
  radius: number;
}

export interface BranchCurve3D {
  /** Bezier curve in 3D */
  curve: THREE.QuadraticBezierCurve3;
  /** Radius at start of branch */
  radiusStart: number;
  /** Radius at end of branch */
  radiusEnd: number;
  hueStart: number;
  hueEnd: number;
  depth: number;
}

// ── Orbital rings ──

export interface RingDef {
  /** Y height of the ring center */
  y: number;
  /** Major radius of the torus */
  radius: number;
  /** Minor radius (tube thickness) */
  tube: number;
  /** Tilt angles in radians */
  tiltX: number;
  tiltZ: number;
  /** Hue for ring color */
  hue: number;
  /** Rotation speed in rad/s */
  speed: number;
  /** Number of orbiting particles */
  particleCount: number;
}

// ── Timeline ──

export interface TimelineState {
  /** ISO 8601 cutoff — show only memories created on or before this */
  before: string | null;
  /** Is the timeline auto-playing (growing) */
  playing: boolean;
  /** Playback speed multiplier */
  speed: number;
  /** Earliest memory date found */
  earliest: string | null;
  /** Latest memory date found */
  latest: string | null;
}
