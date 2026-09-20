export interface MemoryAvatarAppearance {
  style: 'human3d' | 'lumi3d' | 'lumi2d' | 'lumivrm';
  preset: 'neutral' | 'feminine' | 'masculine';
  skinColor: string;
  hairColor: string;
  outfitColor: string;
  backgroundColor: string;
}

export interface MemoryAvatarVoice { voiceId?: string }

/** Aligned expression frames owned by this person; no cloud-avatar account required. */
export interface MemoryAvatarAnimation {
  idleMediaId: string;
  blinkMediaId?: string;
  speakMediaId?: string;
  blinkInterval: number;
  breathing: number;
  backgroundMotion: boolean;
}

export function validMemoryAvatarAnimation(value: any): value is MemoryAvatarAnimation {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.idleMediaId === 'string' && value.idleMediaId
    && ['blinkMediaId', 'speakMediaId'].every(key => value[key] === undefined || (typeof value[key] === 'string' && value[key]))
    && Number.isFinite(value.blinkInterval) && value.blinkInterval >= 2 && value.blinkInterval <= 12
    && Number.isFinite(value.breathing) && value.breathing >= 0 && value.breathing <= 1
    && typeof value.backgroundMotion === 'boolean');
}

/** The selected private media remains owned by this memory person. */
export interface MemoryAvatarPresentation {
  mode: 'human3d' | 'portrait' | 'localportrait';
  mediaId?: string;
  animation?: MemoryAvatarAnimation;
}

export type MemoryAvatarMediaKind = 'image' | 'video' | 'audio';
export type MemoryAvatarMediaVariant = 'original' | 'thumbnail' | 'poster' | 'audio';
export interface MemoryAvatarMedia {
  id: string;
  kind: MemoryAvatarMediaKind;
  title: string;
  caption?: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  status: 'stored' | 'processing' | 'ready' | 'failed' | 'cancelled';
  error?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  hasThumbnail: boolean;
  hasPoster: boolean;
  hasAudio: boolean;
  materialId?: string;
}

export const DEFAULT_MEMORY_AVATAR_APPEARANCE: MemoryAvatarAppearance = {
  style: 'human3d', preset: 'neutral', skinColor: '#c89b7b',
  hairColor: '#302a28', outfitColor: '#64748b', backgroundColor: '#121827',
};

export const LUMI_COMPANION_APPEARANCE: MemoryAvatarAppearance = {
  style: 'lumi3d', preset: 'neutral', skinColor: '#f1eee2',
  hairColor: '#183534', outfitColor: '#6bbaa8', backgroundColor: '#d5d6c5',
};

export const LUMI_OTOME_APPEARANCE: MemoryAvatarAppearance = {
  style: 'lumi2d', preset: 'masculine', skinColor: '#e5c8b2',
  hairColor: '#70625b', outfitColor: '#314345', backgroundColor: '#c0d4ce',
};

export interface MemoryAvatarMaterial {
  id: string;
  title: string;
  kind: 'text' | 'transcript' | 'document';
  text: string;
  createdAt: string;
  memoryCount: number;
}

export interface MemoryAvatar {
  id: string;
  name: string;
  relationshipType: string;
  status: 'active' | 'archived';
  revision: number;
  narrative: string;
  /** Owner-approved public identity and facts; safe to use in livestream replies. */
  publicBrief?: string;
  appearance: MemoryAvatarAppearance;
  voice: MemoryAvatarVoice;
  presentation?: MemoryAvatarPresentation;
  memoryCount: number;
  isFrozen: boolean;
  personalityConfig: Record<string, any>;
  evidenceMap: Array<{ memoryIndex: number; grade: string; source: string }>;
  seedMemoryIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateMemoryAvatarInput {
  clientRequestId: string;
  name: string;
  relationshipType?: string;
  narrative?: string;
  publicBrief?: string;
  appearance?: MemoryAvatarAppearance;
  voice?: MemoryAvatarVoice;
  presentation?: MemoryAvatarPresentation;
  personalityConfig?: Record<string, any>;
  evidenceMap?: any[];
  seedMemories?: any[];
}

export interface PatchMemoryAvatarInput {
  revision: number;
  name?: string;
  relationshipType?: string;
  narrative?: string;
  publicBrief?: string;
  appearance?: MemoryAvatarAppearance;
  voice?: MemoryAvatarVoice;
  presentation?: MemoryAvatarPresentation;
}

export interface AddMemoryAvatarMaterialInput {
  revision: number;
  clientRequestId: string;
  title: string;
  kind: MemoryAvatarMaterial['kind'];
  text: string;
}
