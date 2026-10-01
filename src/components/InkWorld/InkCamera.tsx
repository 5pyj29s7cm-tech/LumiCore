import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';

interface InkCameraProps {
  syncRate: number;
}

export function InkCamera({ syncRate }: InkCameraProps) {
  const controlsRef = useRef<any>(null);

  useFrame(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotateSpeed = 0.15 * syncRate;
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enablePan
      enableZoom
      minDistance={5}
      maxDistance={80}
      autoRotate
      autoRotateSpeed={0.15 * syncRate}
      maxPolarAngle={Math.PI * 0.44}
      minPolarAngle={Math.PI * 0.08}
      target={[0, 3, 0]}
      dampingFactor={0.08}
    />
  );
}
