import type { MemoryAvatarAnimation } from '../../shared/memory_avatar';

export function portraitAnimationFrame(seconds: number, outputLevel: number, animation: MemoryAvatarAnimation, reducedMotion: boolean) {
  const time = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const level = Number.isFinite(outputLevel) ? Math.max(0, outputLevel) : 0;
  const blink = !reducedMotion && animation.blinkMediaId ? Math.exp(-(((time % animation.blinkInterval - animation.blinkInterval + .4) / .065) ** 2)) : 0;
  return { blink, speech: animation.speakMediaId ? Math.min(1, Math.sqrt(level) * 2.2) : 0,
    breath: reducedMotion ? 0 : Math.sin(time * 1.25) * animation.breathing,
    ambience: animation.backgroundMotion && !reducedMotion };
}
