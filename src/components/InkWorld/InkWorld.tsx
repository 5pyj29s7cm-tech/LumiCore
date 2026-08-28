import React, { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { InkTerrain } from './InkTerrain';
import { InkMountains } from './InkMountains';
import { InkFog } from './InkFog';
import { InkParticles } from './InkParticles';
import { InkTrees } from './InkTrees';
import { InkRiver } from './InkRiver';
import { InkCamera } from './InkCamera';
import { InkPostProcessing } from './InkPostProcessing';

export interface InkWorldProps {
  theme: 'celestial' | 'nebula' | 'cyber';
  syncRate: number;
}

function LoadingFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="animate-pulse font-mono text-xs text-white/45">INITIALIZING LUMICORE...</div>
    </div>
  );
}

export function InkWorld({ theme, syncRate }: InkWorldProps) {
  return (
    <div className="h-full w-full">
      <Suspense fallback={<LoadingFallback />}>
        <Canvas
          dpr={[1, 1.5]}
          gl={{ antialias: true, alpha: true }}
          camera={{ position: [0, 18, 28], fov: 50, near: 0.5, far: 120 }}
          style={{ background: 'transparent' }}
        >
          <InkCamera syncRate={syncRate} />
          <InkMountains />
          <InkFog />
          <InkTerrain syncRate={syncRate} />
          <InkRiver />
          <InkTrees />
          <InkParticles syncRate={syncRate} theme={theme} />
          <InkPostProcessing />
        </Canvas>
      </Suspense>
    </div>
  );
}
