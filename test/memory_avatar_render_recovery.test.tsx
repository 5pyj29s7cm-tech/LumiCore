// @vitest-environment jsdom
import React, { Suspense } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { useLoader } from '@react-three/fiber';
import { useMemoryAvatarTextures } from '../src/lib/memoryAvatarRenderResources';
import Stage from '../src/components/MemoryAvatarStage';
import { DEFAULT_MEMORY_AVATAR_APPEARANCE } from '../shared/memory_avatar';

// Real React boundaries and the installed useLoader cache; only the GPU host
// and texture transport are synthetic. This test does not claim pixel/WebGL verification.
const runtime = vi.hoisted(() => ({ renderer: null as { domElement: HTMLCanvasElement } | null, creates: 0, releases: 0 }));
vi.mock('@react-three/fiber', async importOriginal => {
  const actual = await importOriginal<typeof import('@react-three/fiber')>();
  const React = await import('react');
  return { ...actual,
    Canvas: ({ children }: React.PropsWithChildren) => {
      React.useEffect(() => { runtime.creates++; return () => { runtime.releases++; }; }, []);
      return <div data-testid="render-canvas">{children}</div>;
    },
    useThree: (selector: (state: { gl: typeof runtime.renderer }) => unknown) => selector({ gl: runtime.renderer }),
    useFrame: vi.fn(),
  };
});
const CHARACTER = ['/avatars/lumi-reclining/idle-v1.png', '/avatars/lumi-reclining/blink-v1.png', '/avatars/lumi-reclining/speech-v1.png'];
const ROOM = ['wood_table_001', 'rough_linen', 'wooden_floor_02'].flatMap(id => ['diffuse', 'nor_gl', 'rough'].map(kind => `/avatars/lumi-home/${id}-${kind}.jpg`));
function Character() { useMemoryAvatarTextures(CHARACTER); return <span data-testid="character-ready">Synthetic visible person</span>; }
function Room() { useMemoryAvatarTextures(ROOM); return <span data-testid="room-ready">Synthetic room</span>; }
vi.mock('../src/components/LumiLayeredCharacter', () => ({ LumiLayeredCharacter: () => <Character /> }));
vi.mock('../src/components/LumiHomeScene', () => ({ LumiHomeScene: () => <Room />, LumiHomeCamera: () => null }));

type Pending = { url: string; resolve: () => void; reject: () => void };
const pending: Pending[] = [];
let held = new Set<string>();
let requested: string[] = [];
let clearCache: ReturnType<typeof vi.spyOn>;
const props = { appearance: { ...DEFAULT_MEMORY_AVATAR_APPEARANCE, style: 'lumi2d' as const }, outputLevelRef: { current: 0 },
  avatarId: 'synthetic-avatar-a', name: 'Synthetic Lumi A', locale: 'en' as const };
function surface(extra: Partial<React.ComponentProps<typeof Stage>> = {}) {
  return <Suspense fallback={<p data-testid="outer-loading">Whole-page fallback</p>}><Stage {...props} {...extra} /></Suspense>;
}
const retry = () => screen.getByRole('button', { name: /retry|重试|重新/i });
const settleReady = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
beforeEach(() => {
  held = new Set(); requested = []; pending.length = 0; runtime.creates = 0; runtime.releases = 0;
  runtime.renderer = { domElement: document.createElement('canvas') };
  useLoader.clear(THREE.TextureLoader, CHARACTER); useLoader.clear(THREE.TextureLoader, ROOM);
  clearCache = vi.spyOn(useLoader, 'clear');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ getExtension: () => ({ loseContext: vi.fn() }) } as unknown as WebGL2RenderingContext);
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(function(url: string, onLoad?: (texture: THREE.Texture<HTMLImageElement>) => void, _progress?: (event: ProgressEvent) => void, onError?: (error: unknown) => void) {
    requested.push(url);
    const texture = new THREE.Texture<HTMLImageElement>();
    const task = { url, resolve: () => onLoad?.(texture), reject: () => onError?.(new Error('Synthetic image request rejected')) };
    if (held.has(url)) pending.push(task); else queueMicrotask(task.resolve);
    return texture;
  });
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(Error('No business network in render recovery tests'))));
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks();
  useLoader.clear(THREE.TextureLoader, CHARACTER); useLoader.clear(THREE.TextureLoader, ROOM);
  vi.unstubAllGlobals();
});

it('keeps the person and the surrounding surface available while an unrelated room texture is pending', async () => {
  held.add(ROOM[0]); render(surface()); await settleReady();
  expect(pending.some(item => item.url === ROOM[0])).toBe(true);
  expect(screen.queryByTestId('outer-loading')).toBeNull();
  expect(screen.getByTestId('character-ready')).toBeTruthy();
  expect(screen.queryByTestId('room-ready')).toBeNull();
  await act(async () => { pending.find(item => item.url === ROOM[0])!.resolve(); });
  expect(screen.getByTestId('room-ready')).toBeTruthy(); expect(fetch).not.toHaveBeenCalled();
});

it('retries a failed room cache entry without refetching the healthy person or replaying business operations', async () => {
  held.add(ROOM[0]); render(surface()); await settleReady();
  await act(async () => { pending.find(item => item.url === ROOM[0])!.reject(); });
  expect(screen.getByTestId('character-ready')).toBeTruthy();
  expect(screen.getByRole('alert')).toBeTruthy();
  held.clear(); fireEvent.click(retry()); await settleReady();
  expect(screen.getByTestId('room-ready')).toBeTruthy();
  expect(requested.filter(url => url === ROOM[0])).toHaveLength(2);
  for (const url of CHARACTER) expect(requested.filter(item => item === url)).toHaveLength(1);
  expect(clearCache).not.toHaveBeenCalledWith(THREE.TextureLoader, CHARACTER);
  expect(fetch).not.toHaveBeenCalled();
});

it('can explicitly retry a lost context without clearing healthy texture caches', async () => {
  render(surface()); await settleReady();
  expect(screen.getByTestId('character-ready')).toBeTruthy(); const creates = runtime.creates;
  act(() => runtime.renderer!.domElement.dispatchEvent(new Event('webglcontextlost', { cancelable: true })));
  expect(screen.queryByTestId('render-canvas')).toBeNull();
  fireEvent.click(retry()); await settleReady();
  expect(screen.getByTestId('character-ready')).toBeTruthy(); expect(runtime.creates).toBeGreaterThan(creates);
  expect(clearCache).not.toHaveBeenCalled();
});

it('does not allocate or retain a renderer while inactive, including after context loss', async () => {
  const view = render(surface({ active: false })); await settleReady();
  expect(runtime.creates).toBe(0); expect(requested).toHaveLength(0);
  view.rerender(surface()); await settleReady();
  act(() => runtime.renderer!.domElement.dispatchEvent(new Event('webglcontextlost', { cancelable: true })));
  view.rerender(surface({ active: false })); await settleReady();
  expect(screen.queryByTestId('render-canvas')).toBeNull(); expect(screen.queryByRole('button')).toBeNull();
  const creates = runtime.creates;
  act(() => runtime.renderer!.domElement.dispatchEvent(new Event('webglcontextrestored')));
  expect(runtime.creates).toBe(creates);
});

it('bounds room loading locally and a timed-out old response cannot replace the successful retry', async () => {
  vi.useFakeTimers(); held.add(ROOM[0]); render(surface()); await settleReady();
  const old = pending.find(item => item.url === ROOM[0])!;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.getByRole('alert')).toBeTruthy(); expect(screen.getByTestId('character-ready')).toBeTruthy();
  held.clear(); fireEvent.click(retry()); await settleReady();
  expect(screen.getByTestId('room-ready')).toBeTruthy();
  await act(async () => { old.reject(); });
  expect(screen.getByTestId('room-ready')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
});

it('does not carry an old person failure into a newly selected avatar', async () => {
  held.add(CHARACTER[0]); const view = render(surface()); await settleReady();
  const old = pending.find(item => item.url === CHARACTER[0])!;
  view.rerender(surface({ avatarId: 'synthetic-avatar-b', name: 'Synthetic Lumi B', active: false }));
  await act(async () => { old.reject(); });
  expect(screen.queryByText('Synthetic Lumi A')).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
  held.clear(); view.rerender(surface({ avatarId: 'synthetic-avatar-b', name: 'Synthetic Lumi B' })); await settleReady();
  // The new avatar may still need to retry a shared static asset, but any notice
  // must belong to its current identity and have an actionable recovery path.
  if (!screen.queryByTestId('character-ready')) { fireEvent.click(retry()); await settleReady(); }
  expect(screen.getByTestId('character-ready')).toBeTruthy(); expect(screen.queryByText('Synthetic Lumi A')).toBeNull();
});
