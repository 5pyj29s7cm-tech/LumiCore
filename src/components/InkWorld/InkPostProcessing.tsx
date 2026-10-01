import { EffectComposer, Bloom, BrightnessContrast, HueSaturation } from '@react-three/postprocessing';

export function InkPostProcessing() {
  return (
    <EffectComposer>
      {/* Desaturate to near-monochrome for ink wash look */}
      <HueSaturation saturation={-0.7} />
      {/* Boost contrast for stronger ink lines */}
      <BrightnessContrast brightness={-0.03} contrast={0.15} />
      {/* Subtle bloom for ink bleeding effect on bright areas */}
      <Bloom
        intensity={0.2}
        luminanceThreshold={0.7}
        mipmapBlur
      />
    </EffectComposer>
  );
}
