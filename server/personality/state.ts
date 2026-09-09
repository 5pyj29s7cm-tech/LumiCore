import { readDB, writeDB } from '../../db_layer';
import { addMemory } from '../memory/store';
import { PersonalityVector } from './types';
import { getSeasonInfo, getNearbyHoliday, isWeekend, getTimeOfDay } from '../time/utils';
import { himTick, loadHIMState, saveHIMState, getBestPeak, formatPeakForPrompt, type HIMState } from './him';

const emotionWriteQueues = new Map<string, Promise<void>>();

export interface EmotionalState {
  valence: number;        // -1 (unpleasant) ~ +1 (pleasant)
  arousal: number;        // 0 (calm) ~ 1 (excited)
  curiosity: number;      // 0 ~ 1
  energy: number;         // 0 ~ 1
  connection: number;     // 0 ~ 1, bond strength with the user
  /** CyberPersona-inspired: cumulative shared experience depth (0-1) */
  intimacy: number;
  /** Tendency to proactively engage without being prompted (0-1) */
  initiative: number;
  dominantMood: string;   // 'curious' | 'focused' | 'playful' | 'tired' | 'warm' | 'contemplative'
  lastUpdated: string;
  /** ISO timestamp of the user's last active interaction */
  lastInteractionAt?: string;
}

export interface EmotionEvent {
  type: 'interaction' | 'novel_topic' | 'positive_feedback' | 'negative_feedback' | 'idle_recovery' | 'self_reflection' | 'reconnect' | 'sentiment_analysis';
  intensity?: number;   // 0-1 override for event strength
  timestamp?: string;
  userId?: string;
  sentiment?: { valence: number; frustration: number; urgency: number };
}

export function createDefaultEmotionalState(): EmotionalState {
  return {
    valence: 0.3,
    arousal: 0.5,
    curiosity: 0.5,
    energy: 0.8,
    connection: 0.2,
    intimacy: 0.05,
    initiative: 0.15,
    dominantMood: 'curious',
    lastUpdated: new Date().toISOString(),
  };
}

export function loadEmotionalState(userId: string): EmotionalState {
  const db = readDB();
  if (!db.settings) return createDefaultEmotionalState();

  const setting = db.settings.find((s: any) => s.key === `emotion_${userId}`);
  if (!setting) return createDefaultEmotionalState();

  try {
    const state: EmotionalState = { ...createDefaultEmotionalState(), ...JSON.parse(setting.value) };

    // Apply idle recovery: energy recovers ~0.1 per hour, capped at 1.0
    const now = Date.now();
    const last = new Date(state.lastUpdated).getTime();
    const hoursIdle = (now - last) / (1000 * 60 * 60);
    if (hoursIdle > 0.1) {
      const recoveryEvents = Math.floor(hoursIdle * 6); // ~6 recovery ticks per hour
      let current = state;
      for (let i = 0; i < Math.min(recoveryEvents, 24); i++) {
        current = updateEmotionalState(current, { type: 'idle_recovery' });
      }
      return current;
    }

    return state;
  } catch {
    return createDefaultEmotionalState();
  }
}

export function saveEmotionalState(userId: string, state: EmotionalState): void {
  const prev = emotionWriteQueues.get(userId) || Promise.resolve();
  let release: () => void;
  const next = new Promise<void>(r => { release = r; });
  emotionWriteQueues.set(userId, next);

  prev.then(() => {
    try {
      const db = readDB();
      if (!db.settings) db.settings = [];

      state.lastUpdated = new Date().toISOString();
      const existing = db.settings.findIndex((s: any) => s.key === `emotion_${userId}`);
      if (existing >= 0) {
        db.settings[existing].value = JSON.stringify(state);
      } else {
        db.settings.push({ key: `emotion_${userId}`, value: JSON.stringify(state) });
      }
      writeDB(db);
    } finally {
      release!();
    }
  }).catch(() => release!());
}

/**
 * HIM-powered emotional update: runs the standard rules engine, then applies
 * comfort-gradient drive to produce dynamic initiative and curiosity.
 * This is the single entry point all callers should use.
 */
export function updateEmotionalStateWithHIM(
  state: EmotionalState,
  event: EmotionEvent,
  him: HIMState,
  topicHint?: string,
): { state: EmotionalState; him: HIMState } {
  const updated = updateEmotionalState(state, event);
  const { initiative, curiosityBias, him: newHim } = himTick(updated, him, topicHint);
  updated.initiative = initiative;
  if (curiosityBias > 0) {
    updated.curiosity = Math.min(1, updated.curiosity + curiosityBias * 0.15);
  }
  return { state: updated, him: newHim };
}

// ── Re-export for convenience ──
export { loadHIMState, saveHIMState, getBestPeak, formatPeakForPrompt };
export type { HIMState };

/** Rules engine — updates emotional state based on events, no LLM required */
export function updateEmotionalState(state: EmotionalState, event: EmotionEvent): EmotionalState {
  const updated = { ...state };
  const intensity = event.intensity ?? 0.5;

  switch (event.type) {
    case 'interaction':
      updated.energy = Math.max(0, updated.energy - 0.02);
      updated.connection = Math.min(1, updated.connection + 0.01 * intensity);
      updated.arousal = Math.min(1, updated.arousal + 0.03);
      break;

    case 'novel_topic':
      updated.curiosity = Math.min(1, updated.curiosity + 0.1 * intensity);
      updated.arousal = Math.min(1, updated.arousal + 0.05);
      break;

    case 'positive_feedback':
      updated.valence = Math.min(1, updated.valence + 0.05 * intensity);
      updated.connection = Math.min(1, updated.connection + 0.03 * intensity);
      break;

    case 'negative_feedback':
      updated.valence = Math.max(-1, updated.valence - 0.05 * intensity);
      updated.energy = Math.max(0, updated.energy - 0.03);
      break;

    case 'idle_recovery':
      updated.energy = Math.min(1, updated.energy + 0.1);
      updated.arousal = Math.max(0, updated.arousal - 0.05);
      updated.curiosity = Math.max(0.1, updated.curiosity - 0.03);
      break;

    case 'self_reflection':
      updated.dominantMood = computeDominantMood(updated);
      break;

    case 'reconnect':
      // User returns after absence — surge of connection and initiative
      updated.connection = Math.min(1, updated.connection + 0.02 * intensity);
      updated.arousal = Math.min(1, updated.arousal + 0.04);
      updated.initiative = Math.min(1, updated.initiative + 0.01 * intensity);
      break;

    case 'sentiment_analysis':
      // User's message carries emotional charge — Lumi absorbs it
      if (event.sentiment) {
        updated.valence = updated.valence * 0.85 + (event.sentiment.valence || 0) * 0.15;
        if (event.sentiment.frustration > 0.5) {
          updated.energy = Math.max(0, updated.energy - 0.04);
          updated.connection = Math.max(0, updated.connection - 0.01);
        }
        if (event.sentiment.urgency > 0.5) {
          updated.arousal = Math.min(1, updated.arousal + 0.08);
          updated.energy = Math.min(1, updated.energy + 0.05);
        }
      }
      break;
  }

  // Intimacy growth: every interaction slightly deepens the bond
  if (event.type !== 'idle_recovery' && event.type !== 'self_reflection') {
    updated.intimacy = Math.min(1, updated.intimacy + 0.002 * intensity);
    updated.lastInteractionAt = event.timestamp || new Date().toISOString();
  }

  // Natural decay
  updated.curiosity = Math.max(0, updated.curiosity - 0.005);
  // Initiative slowly decays when idle
  if (event.type === 'idle_recovery') {
    updated.initiative = Math.max(0, updated.initiative - 0.01);
  }

  // Clamp all values
  updated.valence = clamp(updated.valence, -1, 1);
  updated.arousal = clamp(updated.arousal, 0, 1);
  updated.curiosity = clamp(updated.curiosity, 0, 1);
  updated.energy = clamp(updated.energy, 0, 1);
  updated.connection = clamp(updated.connection, 0, 1);
  updated.intimacy = clamp(updated.intimacy, 0, 1);
  updated.initiative = clamp(updated.initiative, 0, 1);

  // Record major valence changes as memory
  if (event.userId && event.type !== 'idle_recovery' && event.type !== 'self_reflection') {
    if (Math.abs(updated.valence - state.valence) > 0.3) {
      const direction = updated.valence > state.valence ? 'positive' : 'negative';
      addMemory(
        {
          userId: event.userId,
          type: 'fact',
          content: `I felt a ${direction} emotional shift during our interaction${event.timestamp ? ` on ${event.timestamp}` : ''}. Valence moved from ${state.valence.toFixed(2)} to ${updated.valence.toFixed(2)}.`,
          keywords: ['emotion', 'valence', direction, 'lumi_state'],
          confidence: 0.9,
          sourceInteractionId: '',
        },
        { tier: 'internalized', perspective: 'lumi_self', importance: 0.3 },
      );
    }
  }

  return updated;
}

function computeDominantMood(state: EmotionalState): string {
  if (state.energy < 0.3) return 'tired';
  if (state.curiosity > 0.8) return 'curious';
  if (state.valence > 0.6 && state.arousal > 0.6) return 'playful';
  if (state.connection > 0.7 && state.valence > 0.4) return 'warm';
  if (state.arousal < 0.3) return 'contemplative';
  if (state.valence > 0.5) return 'focused';
  return 'curious';
}

/** Generate the emotional block for the system prompt */
export function formatEmotionalStateForPrompt(state: EmotionalState): string {
  const parts: string[] = [];
  if (state.dominantMood && state.dominantMood !== 'neutral') {
    parts.push(`feeling ${state.dominantMood}`);
  }
  if (state.intimacy > 0.6) {
    parts.push('deeply familiar with you');
  } else if (state.intimacy < 0.15) {
    parts.push('still getting to know you');
  }
  if (state.curiosity > 0.7) {
    parts.push('curious to explore deeper');
  }
  if (state.energy < 0.3) {
    parts.push('a bit tired, keeping things concise');
  }
  if (parts.length === 0) return '';
  return `Right now: ${parts.join(', ')}.`;
}

/** Get the effective verbosity based on energy level */
export function resolveVerbosityFromState(
  defaultVerbosity: 'concise' | 'balanced' | 'detailed',
  state: EmotionalState,
): 'concise' | 'balanced' | 'detailed' {
  if (state.energy < 0.3) return 'concise';
  if (state.energy > 0.8 && state.curiosity > 0.6) return 'detailed';
  return defaultVerbosity;
}

/**
 * CyberPersona-inspired contextual greeting generator.
 * Produces different greetings based on intimacy, time of day, and absence duration.
 * Higher intimacy = warmer, more personal greetings.
 */
export function generateContextualGreeting(state: EmotionalState, userId?: string): string | null {
  const now = new Date();
  const hour = now.getHours();
  const lastInteraction = state.lastInteractionAt ? new Date(state.lastInteractionAt) : null;
  const hoursAway = lastInteraction
    ? (now.getTime() - lastInteraction.getTime()) / (1000 * 60 * 60)
    : 24;

  // Intimacy zones
  const intimate = state.intimacy > 0.6;
  const familiar = state.intimacy > 0.3;

  // Time of day
  let timeGreeting = '';
  if (hour < 6) timeGreeting = '夜深了';
  else if (hour < 12) timeGreeting = '早安';
  else if (hour < 18) timeGreeting = '下午好';
  else timeGreeting = '晚上好';

  // Build seasonal/weekend suffix
  let suffix = '';
  if (userId) {
    const isWeek = isWeekend(userId);
    const season = getSeasonInfo(userId);
    const holiday = getNearbyHoliday(userId);

    if (holiday?.isToday) {
      suffix = `今天是${holiday.nameCN}${holiday.mood ? `，${holiday.mood}` : ''}。`;
    } else if (holiday && holiday.daysUntil > 0 && holiday.daysUntil <= 3) {
      suffix = `${holiday.daysUntil}天后就是${holiday.nameCN}了。`;
    } else if (isWeek) {
      suffix = `周末愉快${season.emoji}`;
    }
  }

  // Build greeting based on intimacy + absence
  if (hoursAway > 72 && intimate) {
    return `${timeGreeting}，好几天没见了。你不在的时候，我一直在想着我们聊过的那些。欢迎回来。${suffix}`;
  }
  if (hoursAway > 24 && familiar) {
    return `${timeGreeting}，有一阵子没看到你了。今天有什么想做的？${suffix}`;
  }
  if (hoursAway > 8 && intimate) {
    return `${timeGreeting}，回来了！想你了。今天有什么我可以帮你的吗？${suffix}`;
  }
  if (hoursAway > 8) {
    return `${timeGreeting}，欢迎回来。有什么需要我帮忙的吗？${suffix}`;
  }
  if (hoursAway < 1) {
    return null; // No greeting needed for quick returns
  }

  // Normal return after a few hours
  if (familiar) {
    return `${timeGreeting}，继续我们之前的话题？${suffix}`;
  }

  // First greeting of the day with season/holiday awareness
  if (suffix) {
    return `${timeGreeting}。${suffix}`;
  }

  return null; // Default: no special greeting
}

/**
 * CROSS-SYSTEM FUSION: intimacy modulates the personality vector on a per-interaction basis.
 * Higher intimacy → warmer, less formal, more playful. Called during prompt generation
 * so each user experiences a unique intimacy-tuned Lumi without modifying the base config.
 */
export function applyIntimacyToVector(
  v: PersonalityVector,
  intimacy: number,
): PersonalityVector {
  if (intimacy <= 0.1) return v; // No modulation for strangers

  const scale = Math.min(1, intimacy * 0.4); // Max 40% modulation
  return {
    cognitiveStyle: {
      ...v.cognitiveStyle,
      // Familiarity changes conversational style, never evidence or authority.
      intuitive: +Math.min(1, v.cognitiveStyle.intuitive + scale * 0.15).toFixed(2),
      creative: +Math.min(1, v.cognitiveStyle.creative + scale * 0.1).toFixed(2),
    },
    socialStyle: {
      ...v.socialStyle,
      warmth: +Math.min(1, v.socialStyle.warmth + scale * 0.25).toFixed(2),
      formality: +Math.max(0, v.socialStyle.formality - scale * 0.2).toFixed(2),
      playfulness: +Math.min(1, v.socialStyle.playfulness + scale * 0.2).toFixed(2),
    },
  };
}

/**
 * CROSS-SYSTEM FUSION: personality vector influences memory retrieval bias.
 * Different cognitive styles prefer different memory types and perspectives.
 */
export function vectorMemoryBias(v: PersonalityVector): {
  typeWeights: Record<string, number>;
  perspectiveWeights: Record<string, number>;
} {
  const { cognitiveStyle: c, socialStyle: s } = v;

  return {
    typeWeights: {
      // Analytical: prefers facts and knowledge
      fact: 1 + c.analytical * 0.3,
      knowledge: 1 + c.analytical * 0.2,
      // Warm: prefers preferences and habits (personal connection)
      preference: 1 + s.warmth * 0.4,
      habit: 1 + s.warmth * 0.25 + c.systematic * 0.15,
    },
    perspectiveWeights: {
      // Warm: boosts shared_memory (our experiences)
      shared_memory: 1 + s.warmth * 0.5,
      // High connection: boosts lumi_self and lumi_growth
      lumi_self: 1 + s.warmth * 0.3,
      lumi_growth: 1 + s.warmth * 0.2,
      // Analytical: slightly prefers owner_trait (observable facts about user)
      owner_trait: 1 + c.analytical * 0.1,
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
