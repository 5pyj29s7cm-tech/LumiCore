const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const follow = (from: number, to: number, speed: number, dt: number) => from + (to - from) * (1 - Math.exp(-speed * dt));

/** Audio amplitude drives the mouth. This is not a phoneme recognizer. */
export class LumiCharacterMotion {
  private time = 0;
  private mouth = 0;
  private activity = 0;
  private gestureTime = 0;
  private lastVoice = false;
  private gazeX = 0;
  private gazeY = 0;

  step(delta: number, rms: number, reducedMotion: boolean, state = '', pointerX = 0, pointerY = 0) {
    const dt = Number.isFinite(delta) ? clamp(delta, 0, 0.05) : 0;
    const level = Number.isFinite(rms) ? clamp(rms, 0, 1) : 0;
    const voiced = level > 0.008;
    const target = voiced ? Math.min(0.85, Math.sqrt(level - 0.008) * 1.65) : 0;
    this.mouth = follow(this.mouth, target, voiced ? 24 : 22, dt);
    this.activity = follow(this.activity, voiced ? 1 : 0, voiced ? 6 : 4, dt);
    if (voiced && !this.lastVoice && this.activity < 0.2) this.gestureTime = 0;
    this.lastVoice = voiced;
    this.gestureTime += dt;
    this.time += reducedMotion ? 0 : dt;
    this.gazeX = follow(this.gazeX, reducedMotion || !Number.isFinite(pointerX) ? 0 : clamp(pointerX, -1, 1), 3, dt);
    this.gazeY = follow(this.gazeY, reducedMotion || !Number.isFinite(pointerY) ? 0 : clamp(pointerY, -1, 1), 3, dt);
    const t = this.time;
    const gesture = reducedMotion ? 0 : Math.sin(Math.min(Math.PI, (this.gestureTime % 6.4) / 3.4 * Math.PI)) ** 2 * this.activity;
    const listening = state === 'listening';
    const thinking = state === 'thinking';
    const blinkAt = (t % 7.7);
    const blink = reducedMotion ? 0 : Math.max(Math.exp(-(((blinkAt - 3.2) / 0.075) ** 2)), 0.85 * Math.exp(-(((blinkAt - 6.8) / 0.08) ** 2)));
    return {
      mouth: this.mouth < 0.0001 ? 0 : this.mouth,
      blink, gesture,
      breath: reducedMotion ? 0 : Math.sin(t * 1.35) * 0.007,
      sway: reducedMotion ? 0 : Math.sin(t * 0.45) * 0.015,
      headX: reducedMotion ? 0 : (listening ? 0.055 : 0) + Math.sin(t * 2.1) * 0.035 * this.activity - this.gazeY * 0.045,
      headY: reducedMotion ? 0 : this.gazeX * 0.09 + Math.sin(t * 0.55) * 0.03 + (thinking ? 0.1 : 0),
      headZ: reducedMotion ? 0 : Math.sin(t * 0.4) * 0.018 + (listening ? 0.035 : 0),
      gazeX: this.gazeX, gazeY: this.gazeY,
      smile: 0.08 + this.activity * 0.06,
    };
  }
}
