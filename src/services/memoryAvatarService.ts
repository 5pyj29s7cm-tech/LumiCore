import { apiFetch } from './apiClient';
import type { MemoryAvatar, MemoryAvatarMaterial, CreateMemoryAvatarInput, PatchMemoryAvatarInput, AddMemoryAvatarMaterialInput } from '../../shared/memory_avatar';

export class MemoryAvatarApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const object = (value: any): boolean => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validAvatar = (value: any): boolean => object(value)
  && typeof value.id === 'string' && Boolean(value.id) && typeof value.name === 'string'
  && Number.isSafeInteger(value.revision) && value.revision >= 1
  && ['active', 'archived'].includes(value.status) && typeof value.narrative === 'string'
  && object(value.appearance) && value.appearance.style === 'human3d'
  && ['neutral', 'feminine', 'masculine'].includes(value.appearance.preset)
  && ['skinColor', 'hairColor', 'outfitColor', 'backgroundColor'].every(field => typeof value.appearance[field] === 'string' && /^#[0-9a-f]{6}$/i.test(value.appearance[field]))
  && object(value.voice) && (value.voice.voiceId === undefined || typeof value.voice.voiceId === 'string')
  && Number.isSafeInteger(value.memoryCount) && value.memoryCount >= 0;
const validMaterial = (value: any): boolean => object(value) && typeof value.id === 'string' && Boolean(value.id)
  && typeof value.title === 'string' && typeof value.text === 'string'
  && ['text', 'transcript', 'document'].includes(value.kind) && typeof value.createdAt === 'string';
const validMaterials = (value: any): boolean => object(value) && Number.isSafeInteger(value.revision) && value.revision >= 1
  && Array.isArray(value.materials) && value.materials.every(validMaterial);
const confirmed = (value: any): boolean => object(value) && value.ok === true;

async function request<T>(suffix: string, method = 'GET', body?: unknown, signal?: AbortSignal, validate: (value: any) => boolean = () => true): Promise<T> {
  const response = await apiFetch(`/api/memory-avatars${suffix}`, {
    method, signal,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  let payload: any;
  try { payload = await response.json(); }
  catch { payload = null; }
  if (!response.ok) throw new MemoryAvatarApiError(response.status, String(payload?.code || ''), String(payload?.error || 'Memory request failed'));
  if (payload === null || !validate(payload)) throw new MemoryAvatarApiError(502, 'invalid_memory_avatar_response', 'The server response did not confirm this operation.');
  return payload as T;
}
const idPath = (id: string) => `/${encodeURIComponent(id)}`;
export const memoryAvatarService = {
  list: (signal?: AbortSignal) => request<{ avatars: MemoryAvatar[] }>('', 'GET', undefined, signal, value => object(value) && Array.isArray(value.avatars) && value.avatars.every(validAvatar)),
  get: (id: string, signal?: AbortSignal) => request<MemoryAvatar>(idPath(id), 'GET', undefined, signal, validAvatar),
  create: (input: CreateMemoryAvatarInput) => request<MemoryAvatar>('', 'POST', input, undefined, validAvatar),
  update: (id: string, input: PatchMemoryAvatarInput) => request<MemoryAvatar>(idPath(id), 'PATCH', input, undefined, validAvatar),
  history: (id: string, signal?: AbortSignal) => request<Array<{ id?: string; requestId?: string; role: string; content: string; timestamp: string }>>(`${idPath(id)}/history`, 'GET', undefined, signal, value => Array.isArray(value) && value.every(row => object(row) && typeof row.role === 'string' && typeof row.content === 'string')),
  materials: (id: string, signal?: AbortSignal) => request<{ materials: MemoryAvatarMaterial[]; revision: number }>(`${idPath(id)}/materials`, 'GET', undefined, signal, validMaterials),
  addMaterial: (id: string, input: AddMemoryAvatarMaterialInput) => request<{ material: MemoryAvatarMaterial; avatar: MemoryAvatar }>(`${idPath(id)}/materials`, 'POST', input, undefined, value => object(value) && validMaterial(value.material) && validAvatar(value.avatar)),
  removeMaterial: (id: string, materialId: string, revision: number) => request<{ ok: true; avatar: MemoryAvatar }>(`${idPath(id)}/materials/${encodeURIComponent(materialId)}`, 'DELETE', { revision }, undefined, value => confirmed(value) && validAvatar(value.avatar)),
  archive: (id: string, revision: number) => request<{ ok: true }>(idPath(id), 'DELETE', { revision }, undefined, confirmed),
};
