export interface MemoryAvatarAppearance {
  style: 'human3d';
  preset: 'neutral' | 'feminine' | 'masculine';
  skinColor: string;
  hairColor: string;
  outfitColor: string;
  backgroundColor: string;
}

export interface MemoryAvatarVoice { voiceId?: string }

export const DEFAULT_MEMORY_AVATAR_APPEARANCE: MemoryAvatarAppearance = {
  style: 'human3d', preset: 'neutral', skinColor: '#c89b7b',
  hairColor: '#302a28', outfitColor: '#64748b', backgroundColor: '#121827',
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
  appearance: MemoryAvatarAppearance;
  voice: MemoryAvatarVoice;
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
  appearance?: MemoryAvatarAppearance;
  voice?: MemoryAvatarVoice;
  personalityConfig?: Record<string, any>;
  evidenceMap?: any[];
  seedMemories?: any[];
}

export interface PatchMemoryAvatarInput {
  revision: number;
  name?: string;
  relationshipType?: string;
  narrative?: string;
  appearance?: MemoryAvatarAppearance;
  voice?: MemoryAvatarVoice;
}

export interface AddMemoryAvatarMaterialInput {
  revision: number;
  clientRequestId: string;
  title: string;
  kind: MemoryAvatarMaterial['kind'];
  text: string;
}
