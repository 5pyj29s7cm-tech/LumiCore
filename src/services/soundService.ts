
/**
 * Procedural Audio Synthesis for LumiCore
 * Generates technical sound effects using Web Audio API
 */
class SoundService {
  private ctx: AudioContext | null = null;

  private init() {
    if (!this.ctx) {
      try {
        const Ctor = window.AudioContext || (window as any).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
      } catch {
        // Audio not available in this environment
      }
    }
  }

  private playTone(freq: number, type: OscillatorType, duration: number, volume: number) {
    this.init();
    if (!this.ctx) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
    
    gain.gain.setValueAtTime(volume, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  }

  playClick() {}
  playPulse() {}

  // Success chime
  playSuccess() {
    this.playTone(600, 'sine', 0.1, 0.05);
    setTimeout(() => this.playTone(900, 'sine', 0.2, 0.05), 100);
  }

  playNeural() {}

  // Wake word detection chime — ascending two-tone with sparkle
  playWakeChime() {
    this.playTone(880, 'sine', 0.15, 0.08);
    setTimeout(() => this.playTone(1320, 'sine', 0.2, 0.06), 100);
  }

  // Error alert — low buzz
  playError() {
    this.playTone(200, 'sawtooth', 0.3, 0.06);
    setTimeout(() => this.playTone(160, 'sawtooth', 0.2, 0.05), 150);
  }
}

export const sounds = new SoundService();
