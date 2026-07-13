import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface InkTerrainProps {
  syncRate: number;
}

// Simplex 3D noise in GLSL — compact implementation
const simplexNoiseGLSL = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x*34.0)+10.0)*x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

const vertexShader = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vHeight;
varying vec3 vViewDir;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vec4 mvNormal = modelViewMatrix * vec4(normal, 0.0);
  vec3 viewDir = -normalize(mvPos.xyz);
  vViewDir = viewDir;
  vHeight = position.y;
  gl_Position = projectionMatrix * mvPos;
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vHeight;
varying vec3 vViewDir;

uniform float uTime;
uniform float uSyncRate;

void main() {
  // Compute slope steepness for ink line intensity
  float slope = 1.0 - abs(vNormal.y);
  float lineIntensity = smoothstep(0.15, 0.55, slope) * 0.6;

  // Height-based ink wash — map to 5 traditional ink levels
  float hNorm = (vHeight + 1.5) / 12.0; // remap height to 0-1 (terrain spans ~ -1.5 to 10.5)
  hNorm = clamp(hNorm, 0.0, 1.0);

  // Five traditional ink levels, from near-black valley wash to paper-white peaks.
  float inkLevel;
  if (hNorm < 0.12) inkLevel = 0.04;       // Near black, valley floor
  else if (hNorm < 0.32) inkLevel = 0.15;  // Very dark ink
  else if (hNorm < 0.55) inkLevel = 0.35;  // Medium ink
  else if (hNorm < 0.78) inkLevel = 0.62;  // Light wash
  else inkLevel = 0.90;                    // Clear wash and negative space

  // Smooth transitions between levels
  float wash = inkLevel;

  // Ridges get darker ink (edge lines)
  wash = mix(wash, wash * 0.5, lineIntensity);

  // Slopes facing upward get slightly lighter, downward darker
  float facing = dot(vNormal, normalize(vec3(0.0, 1.0, 0.5)));
  wash = mix(wash, wash * 0.85, smoothstep(0.0, 1.0, facing) * 0.3);

  // Add brush grain noise
  float grain = fract(sin(dot(vWorldPos.xz * 40.0, vec2(12.9898, 78.233))) * 43758.5453);
  wash += (grain - 0.5) * 0.025;

  // Atmospheric fog
  float dist = length(vWorldPos.xz) * 0.02;
  float fog = smoothstep(8.0, 25.0, dist) * 0.4;
  wash = mix(wash, 0.92, fog);

  gl_FragColor = vec4(vec3(wash), 1.0);
}
`;

export function InkTerrain({ syncRate }: InkTerrainProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const uniformsRef = useRef({
    uTime: { value: 0 },
    uSyncRate: { value: syncRate },
  });

  const geometry = useMemo(() => {
    const size = 60;
    const segments = 256;
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, []);

  // Bake simplex noise into vertex heights
  const displacedGeo = useMemo(() => {
    const geo2 = geometry.clone();
    const pos = geo2.attributes.position;
    // Simple hash-based height generation for baking
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      // Layered noise approximation
      const h = terrainHeight(x, z);
      pos.setY(i, h);
    }
    geo2.computeVertexNormals();
    return geo2;
  }, [geometry]);

  useFrame((_, delta) => {
    uniformsRef.current.uTime.value += delta * syncRate;
  });

  return (
    <mesh ref={meshRef} geometry={displacedGeo} renderOrder={1}>
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={simplexNoiseGLSL + fragmentShader}
        uniforms={uniformsRef.current}
        side={THREE.DoubleSide}
        transparent
        depthWrite
      />
    </mesh>
  );
}

/** Approximate terrain height at world-space (x, z) — mirrors what the shader does.
 *  Used by InkAgents to place nodes at the correct Y. */
export function terrainHeight(x: number, z: number): number {
  const scale = 0.06;
  const h1 = simpleNoise(x * scale, z * scale);
  const h2 = simpleNoise(x * scale * 2.5 + 100, z * scale * 2.5 + 100) * 0.5;
  const h3 = simpleNoise(x * scale * 6 + 200, z * scale * 6 + 200) * 0.25;
  return (h1 + h2 + h3) * 7.0 + 0.5;
}

/** Simple 2D value noise (no dependencies) */
function simpleNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3.0 - 2.0 * fx);
  const sy = fy * fy * (3.0 - 2.0 * fy);
  const n00 = hash2d(ix, iy);
  const n10 = hash2d(ix + 1, iy);
  const n01 = hash2d(ix, iy + 1);
  const n11 = hash2d(ix + 1, iy + 1);
  const nx0 = n00 * (1 - sx) + n10 * sx;
  const nx1 = n01 * (1 - sx) + n11 * sx;
  return (nx0 * (1 - sy) + nx1 * sy) * 2 - 1;
}

function hash2d(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263 + 1274126177;
  h = ((h >> 16) ^ h) * 0x45d9f3b;
  h = ((h >> 16) ^ h) * 0x45d9f3b;
  h = (h >> 16) ^ h;
  return (h & 0x7fffffff) / 0x7fffffff;
}
