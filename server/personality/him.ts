import { readSettingRecord, writeSetting } from "../persistence/settings_repository";
/**
 * HIM (Homeostatic Intrinsic Motivation / 猫智能论) — comfort-driven intrinsic drive engine.
 *
 * Core thesis: the agent's sole intrinsic reward signal is ΔL (comfort gradient).
 * No external rewards, no hand-crafted curiosity modules. Everything — attention,
 * curiosity, initiative — emerges naturally from comfort-seeking behavior.
 *
 * L_t  = (1-β) × W_t + β × X_t          (comfort: senses + expectation)
 * ΔL   = L_t - L_{t-1}                   (intrinsic reward signal)
 * W_buffer = top-k historical peak states  ("hope" — the memory of better days)
 *
 * When ΔL ≈ 0 for too long, drive rises → initiative climbs → agent explores.
 * When L_t << max(W_buffer), hope activates → agent seeks to recover peak state.
 */

import type { EmotionalState } from './state';


// ── Types ──

export interface HIMState {
  /** Current comfort level (0-1) */
  L: number;
  /** Previous comfort level */
  L_prev: number;
  /** Comfort gradient (intrinsic reward) */
  deltaL: number;
  /** Exponential moving average of L (the "expectation" X_t in HIM terms) */
  L_ema: number;
  /** Sensory weight β_t — adaptive: higher when recent history is volatile */
  beta: number;
  /** Number of consecutive turns with near-zero ΔL */
  flatTurns: number;
  /** Peak comfort memory buffer */
  peakBuffer: HIMPeak[];
  lastUpdated: string;
}

export interface HIMPeak {
  L: number;
  valence: number;
  connection: number;
  intimacy: number;
  dominantMood: string;
  /** Optional topic keyword from the interaction that produced this peak */
  topicHint?: string;
  timestamp: string;
}

// ── Constants ──

const PEAK_BUFFER_SIZE = 10;
const PEAK_MIN_GAP = 0.12; // minimum L difference from last stored peak
const FLAT_THRESHOLD = 0.01; // |ΔL| below this = "flat"
const FLAT_TURNS_TO_DRIVE = 4; // consecutive flat turns before drive rises
const HOPE_THRESHOLD = 0.18; // L below peak by this much = hope activates

// Comfort fusion weights (sum = 1.0)
const W = {
  connection: 0.30, // bond strength is the core of comfort
  intimacy:   0.25, // shared history depth
  valence:    0.25, // how good it feels right now
  energy:     0.10, // being tired drags comfort down
  arousal:    0.10, // excitement contributes mildly
};

// ── HIM Core ──

export function createDefaultHIMState(): HIMState {
  return {
    L: 0.35,
    L_prev: 0.35,
    deltaL: 0,
    L_ema: 0.35,
    beta: 0.5,
    flatTurns: 0,
    peakBuffer: [],
    lastUpdated: new Date().toISOString(),
  };
}

/** Compute comfort level L_t from emotional state */
export function computeComfort(state: EmotionalState): number {
  // Normalize valence from [-1,1] to [0,1]
  const vNorm = (state.valence + 1) / 2;
  return (
    vNorm * W.valence +
    state.connection * W.connection +
    state.intimacy * W.intimacy +
    state.arousal * W.arousal +
    state.energy * W.energy
  );
}

/** Stable sort — preserves insertion order for equal elements */
function stableTopK<T>(arr: T[], k: number, key: (x: T) => number): T[] {
  const indexed = arr.map((x, i) => ({ x, k: key(x), i }));
  indexed.sort((a, b) => b.k - a.k || a.i - b.i);
  return indexed.slice(0, k).map(e => e.x);
}

/**
 * Main HIM tick — called after every emotional state update.
 * Returns the new initiative and curiosity bias.
 */
export function himTick(
  state: EmotionalState,
  him: HIMState,
  topicHint?: string,
): { initiative: number; curiosityBias: number; him: HIMState } {
  // 1. Compute current comfort
  const L = computeComfort(state);
  him.L_prev = him.L;
  him.L = L;
  him.deltaL = L - him.L_prev;
  him.lastUpdated = new Date().toISOString();

  // 2. Update expectation (EMA) — β adapts to volatility
  const volatility = Math.abs(him.deltaL);
  him.beta = 0.3 + volatility * 0.5; // more volatile → lean more on expectation
  him.L_ema = him.L_ema * him.beta + L * (1 - him.beta);

  // 3. Track flat turns
  if (Math.abs(him.deltaL) < FLAT_THRESHOLD) {
    him.flatTurns++;
  } else {
    him.flatTurns = Math.max(0, him.flatTurns - 1);
  }

  // 4. Update peak buffer
  const lastPeak = him.peakBuffer[0];
  if (!lastPeak || L - lastPeak.L > PEAK_MIN_GAP) {
    him.peakBuffer.push({
      L,
      valence: state.valence,
      connection: state.connection,
      intimacy: state.intimacy,
      dominantMood: state.dominantMood,
      topicHint,
      timestamp: new Date().toISOString(),
    });
    him.peakBuffer = stableTopK(him.peakBuffer, PEAK_BUFFER_SIZE, p => p.L);
  }

  // 5. Compute drive outputs
  const peakMax = him.peakBuffer.length > 0
    ? Math.max(...him.peakBuffer.map(p => p.L))
    : L;

  // 5a. Flat-drive: ΔL ≈ 0 for too long → initiative rises
  const flatDrive = Math.min(1, him.flatTurns / FLAT_TURNS_TO_DRIVE) * 0.4;

  // 5b. Hope-drive: current L significantly below historical peak
  const hopeGap = peakMax - L;
  const hopeDrive = hopeGap > HOPE_THRESHOLD
    ? Math.min(0.5, (hopeGap - HOPE_THRESHOLD) * 2.5)
    : 0;

  // Combined drive
  const drive = flatDrive + hopeDrive;

  // Initiative = base + drive, capped
  const initiative = Math.min(1, 0.08 + drive);

  // Curiosity bias: when hope is active, bias toward the missing dimension
  const curiosityBias = hopeGap > HOPE_THRESHOLD ? Math.min(1, hopeDrive * 1.5) : 0;

  return { initiative, curiosityBias, him };
}

// ── Persistence ──

export function loadHIMState(userId: string): HIMState {
  try {
    const setting = readSettingRecord(`him_${userId}`);
    if (!setting) return createDefaultHIMState();
    return { ...createDefaultHIMState(), ...JSON.parse(setting.value) };
  } catch {
    return createDefaultHIMState();
  }
}

export function saveHIMState(userId: string, him: HIMState): void {
  try { writeSetting(`him_${userId}`, JSON.stringify(him)); } catch {}
}
