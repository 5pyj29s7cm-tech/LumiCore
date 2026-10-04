import { type PetConfig } from "../../pets/types";
import { getDefaultPets } from "../../pets/defaults";

export interface ClientKnowledgeRuntimeState {
  domain: 'personal' | 'work';
  orgId: string;
  totalFiles: number;
  indexedFiles: number;
  partialFiles: number;
  pendingFiles: number;
  failedFiles: number;
  unsupportedFiles: number;
  orgArticles?: {
    total: number;
    published: number;
    indexed: number;
    missingIndex: number;
    stale: number;
  };
  refreshedAt: number;
  lastError: string;
}


export function emptyKnowledgeRuntimeState(domain: 'personal' | 'work', orgId = ''): ClientKnowledgeRuntimeState {
  return {
    domain,
    orgId,
    totalFiles: 0,
    indexedFiles: 0,
    partialFiles: 0,
    pendingFiles: 0,
    failedFiles: 0,
    unsupportedFiles: 0,
    refreshedAt: 0,
    lastError: '',
  };
}


export function resolvePetPreference(pet: any): PetConfig | null {
  if (!pet) return null;
  if (pet.atlas && pet.spritesheet) return pet as PetConfig;
  const defaults = getDefaultPets();
  return defaults.find(d => d.id === pet.id) || null;
}


export function serializePetPreference(pet: PetConfig | null) {
  if (!pet) return null;
  return {
    id: pet.id,
    name: pet.name,
    author: pet.author,
    atlas: pet.atlas,
    spritesheet: pet.spritesheet,
    thumbnail: pet.thumbnail,
    palette: pet.palette,
    tags: pet.tags,
  };
}


export type ClientPermissionSnapshot = Record<string, string | boolean | number | null | undefined>;

export type ClientRuntimeSnapshot = {
  autostartSupported?: boolean;
  autostartEnabled?: boolean;
  closeToBackground?: boolean;
  startedInBackground?: boolean;
  backendNodeRunning?: boolean;
  backendPythonRunning?: boolean;
  nodeRestarts?: number;
  pythonRestarts?: number;
  globalShortcut?: string;
  lastError?: string;
};


export interface MeetingNote {
  id: string;
  text: string;
  time: number;
  speakerLabel?: string | null;
  speakerConfidence?: number;
  speakerSource?: string;
  speakerMatched?: boolean;
}


export interface RefinedMeetingSegment {
  text?: string;
  beginMs?: number;
  endMs?: number;
  speakerId?: number | null;
  speakerLabel?: string | null;
}
