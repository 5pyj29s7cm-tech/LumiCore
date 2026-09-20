import { LumiCharacterMotion } from './lumiCharacterMotion';

/** The seated portrait exposes no body, arm, head or gaze animation. */
export class LumiLayeredMotion {
  private readonly face = new LumiCharacterMotion();

  step(delta: number, level: number, reducedMotion: boolean) {
    // Keep articulation headroom instead of holding the mouth fully open.
    const { mouth, blink } = this.face.step(delta, level * .42, reducedMotion);
    return { mouth, blink };
  }
}
