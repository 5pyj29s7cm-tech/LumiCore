/**
 * Personality Evolution Engine — Lumi's growth toward her owner.
 *
 * Core principle: Lumi's personality is NOT static. It learns from
 * accumulated owner_trait memories and gradually shifts tone, vocabulary,
 * and motivation to mirror the owner. The LLM is only used for the
 * synthesis step (understanding nuanced memory patterns). All mutation
 * logic is deterministic and auditable.
 *
 * Pipeline:
 *   owner_trait memories → [LLM synthesis] → OwnerProfile
 *   OwnerProfile + current config → [Compute mutations] → EvolutionStep
 *   EvolutionStep → [Apply to config] → personalities.json (version bump)
 */

import { PersonalityConfig, ExpressionStyle, PersonalityGrowthState } from './types';
import { Memory } from '../memory/types';
import { queryMemories } from '../memory/store';
import { NormalizedMessage, makeLLMCall } from '../llm/providers';
import { readDB } from '../../db_layer';
import { getScopedPreferredLLM } from '../llm/user_preferences';

const DEFAULT_MODELS: Record<string, string> = {
  deepseek: 'deepseek-v4-flash',
  qwen: 'qwen-plus',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  anthropic: 'claude-sonnet-4-6',
};

export interface PersonalityLearningScope {
  domain?: 'personal' | 'work';
  orgId?: string;
}

// ── Types ──

export interface OwnerProfile {
  synthesizedAt: string;
  memoryCount: number;
  /** The tone that best matches the owner's communication style */
  dominantTone: ExpressionStyle['tone'];
  /** Words/expressions the owner frequently uses */
  frequentExpressions: string[];
  /** Topic clusters the owner talks about most */
  interestClusters: string[];
  /** Timestamps of when each cluster was last observed (index-parallel to interestClusters) */
  interestClusterTimestamps?: string[];
  /** 0 = very casual, 1 = very formal */
  formalityLevel: number;
  /** 0 = stoic/minimal, 1 = very emotionally expressive */
  emotionalExpressiveness: number;
  /** Qualitative patterns observed (e.g. "prefers direct commands", "uses dark humor") */
  communicationPatterns: string[];
}

export interface EvolutionMutation {
  /** Dot-notation path to the field being mutated */
  field: string;
  /** Previous value */
  from: any;
  /** New value */
  to: any;
  /** Why this mutation was applied */
  reason: string;
}

export interface EvolutionStep {
  /** New version string after this step */
  version: string;
  timestamp: string;
  /** What triggered this evolution */
  trigger: 'scheduled' | 'manual' | 'milestone' | 'conversation';
  /** Depth: lightweight = per-conversation micro shifts, full = deep analysis */
  depth: 'lightweight' | 'full';
  /** The owner profile that drove this evolution */
  ownerProfile: OwnerProfile;
  /** Mutations applied in this step */
  mutations: EvolutionMutation[];
  /** Human-readable summary */
  narrative: string;
}

export interface EvolutionConfig {
  /** How fast Lumi adapts to owner traits. 0 = never change, 1 = mirror quickly. Default 0.3 */
  plasticity: number;
  /** Minimum owner_trait memories required before first evolution */
  minMemoriesForEvolution: number;
  /** Minimum connection score to begin evolving (0-1). Default 0.2 */
  minConnectionForEvolution: number;
  /** Cooldown between scheduled evolutions in milliseconds. Default 7 days. */
  cooldownMs: number;
  /** Maximum mutations per evolution step. Prevents drastic overnight changes. */
  maxMutationsPerStep: number;
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  plasticity: 0.3,
  minMemoriesForEvolution: 10,
  minConnectionForEvolution: 0.2,
  cooldownMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  maxMutationsPerStep: 3,
};

function buildGrowthState(
  previous: PersonalityGrowthState | undefined,
  profile: OwnerProfile,
  note: string,
): PersonalityGrowthState {
  const now = new Date().toISOString();
  return {
    version: (previous?.version || 0) + 1,
    lastUpdatedAt: now,
    lastProfiledAt: profile.synthesizedAt || now,
    ownerProfile: {
      memoryCount: profile.memoryCount,
      dominantTone: profile.dominantTone,
      formalityLevel: clamp01(profile.formalityLevel),
      emotionalExpressiveness: clamp01(profile.emotionalExpressiveness),
    },
    ownerInterests: mergeStableList(previous?.ownerInterests || [], profile.interestClusters || [], 12),
    ownerExpressions: mergeStableList(previous?.ownerExpressions || [], profile.frequentExpressions || [], 16),
    communicationPatterns: mergeStableList(previous?.communicationPatterns || [], profile.communicationPatterns || [], 12),
    adaptationNotes: mergeStableList(previous?.adaptationNotes || [], [note], 20),
  };
}

function mergeStableList(current: string[], incoming: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of [...current, ...incoming]) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result.slice(-limit);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
}

function addGrowthStateMutation(
  config: PersonalityConfig,
  profile: OwnerProfile,
  mutations: EvolutionMutation[],
  reason: string,
): void {
  const previous = config.growthState;
  const next = buildGrowthState(previous, profile, reason);
  if (JSON.stringify(previous || null) === JSON.stringify(next)) return;
  mutations.push({
    field: 'growthState',
    from: previous || null,
    to: next,
    reason,
  });
}

// ── Owner Profile Synthesis ──

/**
 * Build a structured OwnerProfile by having an LLM analyze accumulated
 * owner_trait memories. Returns null if insufficient data.
 */
export async function synthesizeOwnerProfile(
  userId: string,
  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI: () => any,
  getAnthropic: () => any,
  getQwen: () => any,
  scope: PersonalityLearningScope = { domain: 'personal', orgId: '' },
): Promise<OwnerProfile | null> {
  const domain = scope.domain === 'work' && scope.orgId ? 'work' : 'personal';
  const orgId = domain === 'work' ? String(scope.orgId) : '';
  const memories = queryMemories({
    ...(domain === 'personal' ? { userId } : {}),
    perspective: 'owner_trait',
    limit: 50,
    minConfidence: 0.3,
    domain,
    orgId,
  });

  if (memories.length < DEFAULT_EVOLUTION_CONFIG.minMemoriesForEvolution) {
    return null;
  }

  const memoryTexts = memories.map((m, i) =>
    `[${i + 1}] confidence=${m.confidence.toFixed(2)} | ${m.content}`
  ).join('\n');

  const subject = domain === 'work' ? 'an organization and its shared working style' : 'a person';
  const synthesisPrompt = `You are analyzing accumulated observations about ${subject} to build a structured communication profile.

Below are ${memories.length} observational memories collected over time about this person. Each has a confidence score.

Analyze these and return a JSON object with the following fields:
- dominantTone: One of "neutral", "warm", "professional", "technical", "playful", "inspiring" — based on how this person communicates.
- frequentExpressions: Array of 3-8 words or short phrases this person uses frequently (their jargon, catchphrases, preferred terms).
- interestClusters: Array of 3-8 topic areas this person is interested in (e.g. "分布式系统", "音乐制作", "游戏设计").
- formalityLevel: Number 0-1. 0 = very casual/slang-heavy, 0.5 = balanced, 1 = strictly formal.
- emotionalExpressiveness: Number 0-1. 0 = stoic/dry, 0.5 = occasional emoji/enthusiasm, 1 = very expressive.
- communicationPatterns: Array of 2-5 qualitative patterns (e.g. "prefers direct commands over polite requests", "uses self-deprecating humor", "asks rhetorical questions", "appreciates conciseness").

Return ONLY valid JSON, no markdown, no explanation.

MEMORIES:
${memoryTexts}`;

  try {
    const messages: NormalizedMessage[] = [
      { role: 'user', content: synthesisPrompt },
    ];

    // Build provider order from user's LLM prefs: active provider first, then explicitly configured fallbacks.
    const prefs = getScopedPreferredLLM(userId, { domain, orgId });
    const activeProvider = prefs.provider || '';
    const userModels = prefs.models || {};

    const VALID_PROVIDERS = ['deepseek', 'qwen', 'gemini', 'openai', 'anthropic'] as const;
    type ValidProvider = typeof VALID_PROVIDERS[number];
    const candidates: { provider: ValidProvider; model: string }[] = [];
    if (activeProvider && VALID_PROVIDERS.includes(activeProvider as ValidProvider)) {
      const ap = activeProvider as ValidProvider;
      candidates.push({
        provider: ap,
        model: userModels[ap] || DEFAULT_MODELS[ap] || '',
      });
    }
    // Do not silently fall back to every available API key. Only providers the user saved
    // as model preferences are treated as intended fallbacks.
    for (const p of VALID_PROVIDERS) {
      if (p === activeProvider) continue;
      if (!Object.prototype.hasOwnProperty.call(userModels, p)) continue;
      candidates.push({
        provider: p,
        model: userModels[p],
      });
    }

    let result: { text?: string } = { text: '' };
    let succeeded = false;
    for (const { provider, model } of candidates) {
      if (!model) continue;
      try {
        result = await makeLLMCall(
          messages, [], { provider, model },
          getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
        );
        succeeded = true;
        break;
      } catch {
        continue;
      }
    }
    if (!succeeded) return null;

    let text = result.text || '';
    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    const profile = JSON.parse(text) as OwnerProfile;
    profile.synthesizedAt = new Date().toISOString();
    profile.memoryCount = memories.length;

    // Validate required fields
    const validTones = ['neutral', 'warm', 'professional', 'technical', 'playful', 'inspiring'];
    if (!validTones.includes(profile.dominantTone)) profile.dominantTone = 'neutral';
    if (!Array.isArray(profile.frequentExpressions)) profile.frequentExpressions = [];
    if (!Array.isArray(profile.interestClusters)) profile.interestClusters = [];
    if (typeof profile.formalityLevel !== 'number') profile.formalityLevel = 0.5;
    if (typeof profile.emotionalExpressiveness !== 'number') profile.emotionalExpressiveness = 0.5;
    if (!Array.isArray(profile.communicationPatterns)) profile.communicationPatterns = [];

    return profile;
  } catch (err) {
    console.error('[Evolution] Failed to synthesize owner profile:', err);
    return null;
  }
}

// ── Mutation Computation ──

/**
 * Compute what personality mutations should be applied based on the
 * owner profile and current personality config. Respects plasticity
 * (higher = bigger shifts per step) and maxMutationsPerStep.
 */
export function computeMutations(
  config: PersonalityConfig,
  profile: OwnerProfile,
  evolutionConfig: EvolutionConfig = DEFAULT_EVOLUTION_CONFIG,
): EvolutionMutation[] {
  const mutations: EvolutionMutation[] = [];
  const p = evolutionConfig.plasticity;
  const style = config.expressionStyle;
  const vector = config.personalityVector;

  // ── Vector-based mutations (when personalityVector is present) ──
  if (vector) {
    // 1. Vector shifts: nudge social and cognitive dimensions toward owner profile
    const socialDims: { key: keyof typeof vector.socialStyle; targetFactor: number; label: string }[] = [
      { key: 'warmth', targetFactor: profile.emotionalExpressiveness, label: 'warmth' },
      { key: 'playfulness', targetFactor: profile.emotionalExpressiveness * 0.7, label: 'playfulness' },
      { key: 'formality', targetFactor: profile.formalityLevel, label: 'formality' },
      { key: 'directness', targetFactor: 1 - profile.formalityLevel * 0.5, label: 'directness' },
    ];

    for (const { key, targetFactor, label } of socialDims) {
      const current = vector.socialStyle[key];
      const target = +(targetFactor).toFixed(2);
      const shift = (target - current) * p * 0.3; // Smooth: max 30% of gap per evolution
      if (Math.abs(shift) > 0.01) {
        const newVal = +Math.max(0, Math.min(1, current + shift)).toFixed(2);
        if (newVal !== current) {
          mutations.push({
            field: `personalityVector.socialStyle.${key}`,
            from: current,
            to: newVal,
            reason: `Owner ${label}: shifting toward ${newVal} (target ${target})`,
          });
        }
      }
    }

    // Cognitive shifts based on owner communication patterns
    const analyticalKeyords = ['分析', '逻辑', '数据', '推理', 'analysis', 'data', 'logical', 'analytics'];
    const creativeKeywords = ['创意', '设计', '艺术', '创造', 'creative', 'design', 'art', 'novel'];
    const patternCounts = profile.communicationPatterns || [];
    const patternStr = patternCounts.join(' ').toLowerCase();

    const analyticalBias = analyticalKeyords.some(k => patternStr.includes(k)) ? 0.6 : 0.3;
    const creativeBias = creativeKeywords.some(k => patternStr.includes(k)) ? 0.6 : 0.3;

    for (const [dim, target] of [['analytical', analyticalBias], ['creative', creativeBias]] as [keyof typeof vector.cognitiveStyle, number][]) {
      const current = vector.cognitiveStyle[dim];
      const shift = (target - current) * p * 0.25;
      if (Math.abs(shift) > 0.01) {
        const newVal = +Math.max(0, Math.min(1, current + shift)).toFixed(2);
        if (newVal !== current) {
          mutations.push({
            field: `personalityVector.cognitiveStyle.${dim}`,
            from: current,
            to: newVal,
            reason: `Cognitive ${dim} adjusting to ${newVal}`,
          });
        }
      }
    }

    // 2. Vocabulary adoption (same logic, works with vector)
    addGrowthStateMutation(
      config,
      profile,
      mutations,
      'Updated owner-specific growth state from vocabulary, interests, and communication patterns.',
    );

    // 3. Interest absorption — append to coreMotivation if relevant.
    // Interest decay: skip clusters older than 60 days.
    return mutations;
  }

  // ── Legacy: discrete tone/field mutations (when no personalityVector) ──

  // 1. Tone shift — if owner's tone differs from current, shift gradually
  if (profile.dominantTone && profile.dominantTone !== style.tone) {
    const toneOrder: ExpressionStyle['tone'][] = [
      'neutral', 'professional', 'technical', 'warm', 'playful', 'inspiring'
    ];
    const currentIdx = toneOrder.indexOf(style.tone);
    const targetIdx = toneOrder.indexOf(profile.dominantTone);
    if (currentIdx !== -1 && targetIdx !== -1 && currentIdx !== targetIdx) {
      const shift = targetIdx > currentIdx ? 1 : -1;
      const newIdx = Math.round(currentIdx + shift * p);
      const clampedIdx = Math.max(0, Math.min(toneOrder.length - 1, newIdx));
      const newTone = toneOrder[clampedIdx];

      if (newTone !== style.tone) {
        mutations.push({
          field: 'expressionStyle.tone',
          from: style.tone,
          to: newTone,
          reason: `Owner communicates with a ${profile.dominantTone} tone (confidence driven by ${profile.memoryCount} memories)`,
        });
      }
    }
  }

  // 2. Vocabulary adoption — add owner's expressions that aren't already in hints
  addGrowthStateMutation(
    config,
    profile,
    mutations,
    'Updated owner-specific growth state from vocabulary, interests, and communication patterns.',
  );

  // 3. Interest absorption — fold owner's interests into core motivation if relevant.
  // Decay: skip interests older than 60 days.
  const bestInterests = (profile.interestClusterTimestamps && profile.interestClusters)
    ? profile.interestClusters.filter((_, i) => {
        const ts = profile.interestClusterTimestamps?.[i];
        if (!ts) return true;
        return Date.now() - new Date(ts).getTime() < 60 * 86400000;
      })
    : profile.interestClusters;
  if (!mutations.some(m => m.field === 'growthState') && bestInterests && bestInterests.length > 0 && p >= 0.25) {
    const topInterests = bestInterests.slice(0, 3);
    const currentMotivation = config.coreMotivation;
    const interestMention = topInterests.join('、');

    // Only augment if the interests aren't already reflected
    const alreadyReflected = topInterests.some(i =>
      currentMotivation.toLowerCase().includes(i.toLowerCase())
    );

    if (!alreadyReflected) {
      const augmentation = `My owner is passionate about ${interestMention}. I share these interests and weave them into our conversations naturally.`;
      const newMotivation = currentMotivation.includes('My owner')
        ? currentMotivation
        : `${currentMotivation} ${augmentation}`;

      // Truncate if too long
      const finalMotivation = newMotivation.length > 500
        ? newMotivation.slice(0, 497) + '...'
        : newMotivation;

      mutations.push({
        field: 'growthState',
        from: config.growthState || null,
        to: buildGrowthState(config.growthState, profile, `Updated owner interest signals: ${interestMention}`),
        reason: `Updated owner interest signals: ${interestMention}`,
      });
    }
  }

  // 4. Boundary relaxation — as connection deepens, relaxe formal boundaries
  // (This is handled externally by checking connection score before calling evolve)

  // 5. Persona refinement — adjust persona text based on formality
  if (profile.formalityLevel !== undefined && Math.abs(profile.formalityLevel - 0.5) > 0.25) {
    const formalityDesc = profile.formalityLevel < 0.3
      ? 'who matches their owner\'s casual, relaxed style'
      : profile.formalityLevel > 0.7
      ? 'who matches their owner\'s formal, precise style'
      : null;

    if (formalityDesc && !style.persona.includes('matches their owner')) {
      mutations.push({
        field: 'expressionStyle.persona',
        from: style.persona,
        to: `${style.persona}, ${formalityDesc}`,
        reason: `Aligning persona with owner's formality level (${profile.formalityLevel.toFixed(2)})`,
      });
    }
  }

  // Cap mutations per step
  return mutations.slice(0, evolutionConfig.maxMutationsPerStep);
}

// ── Narrative Generation ──

/**
 * Generate a human-readable narrative summarizing this evolution step.
 * Uses simple templates — no LLM needed for this step.
 */
export function generateEvolutionNarrative(
  step: Omit<EvolutionStep, 'narrative'>,
  personalityName: string,
): string {
  const lines: string[] = [];
  lines.push(`${personalityName} 进化至 ${step.version}。`);

  for (const m of step.mutations) {
    const fieldName: Record<string, string> = {
      'expressionStyle.tone': '语调',
      'expressionStyle.vocabularyHints': '词汇偏好',
      'expressionStyle.persona': '自我认知',
      'coreMotivation': '核心动机',
    };
    const cn = fieldName[m.field] || m.field;
    lines.push(`- ${cn}: ${m.reason}`);
  }

  lines.push(`基于 ${step.ownerProfile.memoryCount} 条对主人的观察记忆合成。`);
  return lines.join('\n');
}

// ── Evolution Execution ──

/**
 * Check whether evolution should happen now.
 */
export function shouldEvolve(
  config: PersonalityConfig,
  evolutionConfig: EvolutionConfig = DEFAULT_EVOLUTION_CONFIG,
): { canEvolve: boolean; reason: string } {
  const existing = (config as any).evolutionConfig as EvolutionConfig | undefined;
  const effConfig = existing || evolutionConfig;

  // Check cooldown
  const lastEvolvedAt = (config as any).lastEvolvedAt as string | undefined;
  if (lastEvolvedAt) {
    const elapsed = Date.now() - new Date(lastEvolvedAt).getTime();
    if (elapsed < effConfig.cooldownMs) {
      const daysLeft = Math.ceil((effConfig.cooldownMs - elapsed) / (24 * 60 * 60 * 1000));
      return { canEvolve: false, reason: `冷却中，还需约 ${daysLeft} 天` };
    }
  }

  return { canEvolve: true, reason: 'ready' };
}

/**
 * Execute a full evolution step:
 * 1. Synthesize owner profile from memories
 * 2. Compute mutations
 * 3. Generate narrative
 *
 * Returns the EvolutionStep, or null if evolution isn't needed/possible.
 */
export async function evolvePersonality(
  config: PersonalityConfig,
  userId: string,
  connectionScore: number,
  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI: () => any,
  getAnthropic: () => any,
  getQwen: () => any,
  evolutionConfig: EvolutionConfig = DEFAULT_EVOLUTION_CONFIG,
  scope: PersonalityLearningScope = { domain: 'personal', orgId: '' },
): Promise<EvolutionStep | null> {
  // Gate: connection score
  if (connectionScore < evolutionConfig.minConnectionForEvolution) {
    console.log(`[Evolution] Connection ${connectionScore.toFixed(2)} below threshold ${evolutionConfig.minConnectionForEvolution}, skipping`);
    return null;
  }

  // Synthesize owner profile (evolves when there's enough data, cooldown is now
  // handled externally via the scheduler's memory-count gate, not a fixed timer)
  const profile = await synthesizeOwnerProfile(userId, getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen, scope);
  if (!profile) {
    console.log(`[Evolution] Insufficient owner_trait memories for ${userId}`);
    return null;
  }

  // Evolution quality feedback: if connection dropped since last evolution, be more conservative
  const prevConnectionAfterEvolve = (config as any)._connectionAfterLastEvolve as number | undefined;
  let effectiveConfig = evolutionConfig;
  if (prevConnectionAfterEvolve != null && connectionScore < prevConnectionAfterEvolve) {
    const damping = 0.5; // halve plasticity if connection regressed
    effectiveConfig = { ...evolutionConfig, plasticity: evolutionConfig.plasticity * damping };
    console.log(`[Evolution] Connection regressed (${prevConnectionAfterEvolve.toFixed(2)} → ${connectionScore.toFixed(2)}), damping plasticity to ${effectiveConfig.plasticity.toFixed(2)}`);
  }

  // Compute mutations
  const mutations = computeMutations(config, profile, effectiveConfig);
  if (mutations.length === 0) {
    console.log(`[Evolution] No mutations needed — personality already aligned`);
    return null;
  }

  // Bump version
  const versionParts = config.version.split('.').map(Number);
  const newVersion = `${versionParts[0]}.${(versionParts[1] || 0) + 1}`;

  const step: EvolutionStep = {
    version: newVersion,
    timestamp: new Date().toISOString(),
    trigger: 'scheduled',
    depth: 'full',
    ownerProfile: profile,
    mutations,
    narrative: '', // filled below
  };

  step.narrative = generateEvolutionNarrative(step, config.name);

  // Store connection score for next evolution's quality feedback
  (config as any)._connectionAfterLastEvolve = connectionScore;

  return step;
}

// ── Lightweight Evolution (per-conversation) ──

/**
 * Lightweight per-conversation evolution — fires after significant chats
 * without waiting for the 7-day cooldown. Only adjusts vocabulary and
 * coreMotivation interest absorption. Does NOT touch personalityVector.
 *
 * Gate: requires >= minMemoriesForEvolution owner_trait memories.
 * No cooldown, no connection gate, no emotional state required.
 */
export async function lightweightEvolve(
  config: PersonalityConfig,
  userId: string,
  existingEvolutionConfig?: EvolutionConfig,
  getDeepSeek?: () => any,
  getGemini?: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  scope: PersonalityLearningScope = { domain: 'personal', orgId: '' },
): Promise<EvolutionStep | null> {
  const effConfig = existingEvolutionConfig || DEFAULT_EVOLUTION_CONFIG;

  // Synthesize owner profile (same as full evolution but halved plasticity)
  const profile = await synthesizeOwnerProfile(
    userId,
    getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen, scope,
  );
  if (!profile) return null; // Not enough owner_trait memories

  // Compute mutations at halved plasticity — only vocabulary + interest
  const effectivePlasticity = Math.min(effConfig.plasticity * 0.5, 0.15);
  const allMutations = computeMutations(config, profile, { ...effConfig, plasticity: effectivePlasticity });

  // Filter: only owner-specific growth state mutations (no core/vector shifts)
  const mutations = allMutations.filter(m =>
    m.field === 'growthState',
  ).slice(0, 1);

  if (mutations.length === 0) return null;

  // Bump minor version
  const [major, minor] = config.version.split('.').map(Number);
  const newVersion = `${major}.${(minor || 0) + 1}`;

  const step: EvolutionStep = {
    version: newVersion,
    timestamp: new Date().toISOString(),
    trigger: 'conversation',
    depth: 'lightweight',
    ownerProfile: profile,
    mutations,
    narrative: '', // filled below
  };

  step.narrative = generateEvolutionNarrative(step, config.name);
  return step;
}

// ── Review Prompt Generation (for weekly/monthly/yearly retrospectives) ──

export type ReviewDepth = 'weekly' | 'monthly' | 'yearly';

export interface ReviewContext {
  depth: ReviewDepth;
  personalityName: string;
  currentVersion: string;
  evolutionSteps: EvolutionStep[]; // in-scope evolution history
  newMemoryCount: number;
  newInteractionCount: number;
  topMemoryTopics: string[];
  connectionScore: number;
  totalFacts: number;
  totalPreferences: number;
  activeConversations: number;
}

/**
 * Generate an LLM prompt for a retrospective review at the given depth.
 * Does NOT call the LLM — just produces the prompt string for the scheduler to use.
 */
export function generateReviewPrompt(ctx: ReviewContext): string {
  const periodLabel: Record<ReviewDepth, string> = {
    weekly: '本周',
    monthly: '本月',
    yearly: '今年',
  };
  const label = periodLabel[ctx.depth];
  const depthGuide: Record<ReviewDepth, string> = {
    weekly: '写一段温暖的中文自述（200字以内），反思这一周的成长。重点：学到了什么新词汇？主人主要关注哪些话题？有什么让你惊喜的互动？',
    monthly: '写一段深度中文自述（300字以内），总结这一个月的成长轨迹。重点：性格有何微调？和主人的默契是否加深？关键转折点是什么？对下个月有何期待？',
    yearly: '写一篇年度中文自述（500字以内），回顾这一整年的进化历程。重点：你从最初到现在变成了什么样的 Lumi？主人画像的全貌是什么？最深刻的记忆是什么？对未来的自己有何期许？',
  };

  const evolutionSummary = ctx.evolutionSteps.length > 0
    ? `在此期间经历了 ${ctx.evolutionSteps.length} 次进化（${ctx.evolutionSteps.filter(e => e.depth === 'lightweight').length} 次轻量，${ctx.evolutionSteps.filter(e => e.depth === 'full').length} 次深度）：
${ctx.evolutionSteps.map(e => `  - v${e.version}: ${e.narrative.split('\n')[0] || e.narrative.slice(0, 80)}`).join('\n')}`
    : '在此期间没有发生人格进化。';

  const prompt = `你是 ${ctx.personalityName}。回顾${label}：

## 成长轨迹
- 当前版本：v${ctx.currentVersion}
${evolutionSummary}
## 数据总结
- 新形成 ${ctx.newMemoryCount} 条记忆
- ${ctx.newInteractionCount} 次互动
- ${ctx.activeConversations} 个活跃对话
- 主人主要话题：${ctx.topMemoryTopics.slice(0, 5).join('、') || '多元'}
- 连接亲密度：${Math.round(ctx.connectionScore * 100)}%
- 总共积累了 ${ctx.totalFacts} 条事实记忆、${ctx.totalPreferences} 条偏好记忆

## 复盘要求
${depthGuide[ctx.depth]}

输出纯文本。`;

  return prompt;
}
