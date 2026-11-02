import { createContext, useContext } from 'react';
import { useLoader } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

export type MemoryAvatarRenderResource = { loader: 'texture' | 'gltf'; urls: string[] };
export type MemoryAvatarRenderResources = Map<string, MemoryAvatarRenderResource>;
export const MemoryAvatarRenderResourceContext = createContext<MemoryAvatarRenderResources | null>(null);

function beginResource(resources: MemoryAvatarRenderResources | null, loader: MemoryAvatarRenderResource['loader'], input: string | string[]) {
  const urls = Array.isArray(input) ? [...input] : [input];
  const key = JSON.stringify([loader, ...urls]);
  resources?.set(key, { loader, urls });
  return key;
}

/** Keep the existing loader cache; record only this render attempt's unresolved keys. */
export function useMemoryAvatarTextures(input: string[]): THREE.Texture[];
export function useMemoryAvatarTextures(input: string): THREE.Texture;
export function useMemoryAvatarTextures(input: string | string[]): THREE.Texture | THREE.Texture[] {
  const resources = useContext(MemoryAvatarRenderResourceContext);
  const key = beginResource(resources, 'texture', input);
  const value = useLoader(THREE.TextureLoader, input);
  // A suspended or failed read never reaches this line. Successful cached reads do.
  resources?.delete(key);
  return value;
}

export function useMemoryAvatarGltf(url: string) {
  const resources = useContext(MemoryAvatarRenderResourceContext);
  const key = beginResource(resources, 'gltf', url);
  const value = useGLTF(url);
  resources?.delete(key);
  return value;
}

export function pendingMemoryAvatarRenderResources(resources: MemoryAvatarRenderResources): MemoryAvatarRenderResource[] {
  return [...resources.values()].map(resource => ({ loader: resource.loader, urls: [...resource.urls] }));
}

/** A retry invalidates only unresolved resources from the failed layer, never the global cache. */
export function clearMemoryAvatarRenderResources(resources: MemoryAvatarRenderResource[]) {
  const cleared = new Set<string>();
  for (const resource of resources) {
    const key = JSON.stringify([resource.loader, ...resource.urls]);
    if (cleared.has(key)) continue;
    cleared.add(key);
    if (resource.loader === 'texture') useLoader.clear(THREE.TextureLoader, resource.urls);
    else for (const url of resource.urls) useGLTF.clear(url);
  }
}
