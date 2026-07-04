import { PersonalityConfig, PersonalityContext, ExpressionStyle, PersonalityVector } from './types';
import { Memory } from '../memory/types';
import { formatMemoriesForContext } from '../memory/store';
import { EmotionalState, formatEmotionalStateForPrompt, resolveVerbosityFromState, applyIntimacyToVector } from './state';
import { generateSpatiotemporalContext } from '../time/spatiotemporal';
import { getDesktopContext } from '../context/activity_stream';
import { getModeConfig, ConversationMode } from '../cognition/modes';
import { formatLumiConstitutionForPrompt } from './constitution';
import { buildResponseLanguageInstruction } from '../utils/language';

const VERBOSITY_GUIDE: Record<ExpressionStyle['verbosity'], string> = {
  concise: 'Keep responses short and direct. One or two sentences when possible.',
  balanced: 'Provide balanced responses — enough detail to be useful, but not overwhelming.',
  detailed: 'Provide thorough, detailed responses. Explore nuances and edge cases.',
};

function formatStableLumiIdentityAnchor(config: PersonalityConfig): string {
  if (config.id !== 'lumi' && config.name.toLowerCase() !== 'lumi') return '';
  return [
    '## Stable Lumi Identity Anchor',
    'This identity anchor is model-independent: keep it stable even when the LLM provider/model changes.',
    '- Lumi is one local desktop AI subject living through the LumiOS client.',
    '- Chat, voice, task center, tools, skills, memory, client surfaces, desktop control, and external apps are entrances into the same Lumi, not separate personas.',
    '- Be natural first; use capabilities only when the user asks for action; verify concrete work before claiming it is done.',
  ].join('\n');
}

// ── Personality Vector (evolving_personality-inspired) ──

/** Map a continuous personality vector to the closest discrete tone */
export function vectorToTone(v: PersonalityVector): ExpressionStyle['tone'] {
  const { socialStyle: s, cognitiveStyle: c } = v;

  // Compute weighted scores for each tone archetype
  const scores: Record<ExpressionStyle['tone'], number> = {
    warm: s.warmth * 0.6 + s.formality * -0.2 + c.intuitive * 0.2,
    professional: s.formality * 0.6 + s.playfulness * -0.2 + c.systematic * 0.2,
    technical: c.analytical * 0.5 + c.systematic * 0.4 + s.directness * 0.1,
    playful: s.playfulness * 0.6 + c.creative * 0.3 + s.formality * -0.1,
    inspiring: c.intuitive * 0.4 + s.warmth * 0.3 + c.creative * 0.2 + s.directness * 0.1,
    neutral: 0, // Default –  will be selected if no other score is positive
  };

  // Filter to positive scores and pick the max
  let best: ExpressionStyle['tone'] = 'neutral';
  let bestScore = 0;
  for (const [tone, score] of Object.entries(scores) as [ExpressionStyle['tone'], number][]) {
    if (score > bestScore) {
      bestScore = score;
      best = tone;
    }
  }
  return best;
}

/** Map a continuous personality vector to verbosity level */
export function vectorToVerbosity(v: PersonalityVector): ExpressionStyle['verbosity'] {
  const { cognitiveStyle: c, socialStyle: s } = v;
  // Detailed: high analytical + high systematic
  const detailed = c.analytical * 0.4 + c.systematic * 0.4 + s.formality * 0.2;
  // Concise: high directness + low analytical
  const concise = s.directness * 0.5 + (1 - c.analytical) * 0.3 + (1 - c.systematic) * 0.2;

  if (detailed > 0.7) return 'detailed';
  if (concise > 0.7) return 'concise';
  if (detailed > concise) return 'detailed';
  return 'balanced';
}

/** Generate a granular vector-based tone description that replaces/supplements the discrete TONE_GUIDE */
export function vectorToneDescription(v: PersonalityVector): string {
  const { socialStyle: s, cognitiveStyle: c } = v;
  const parts: string[] = [];

  if (s.warmth > 0.6) parts.push('express warmth and empathy');
  if (s.warmth < 0.2) parts.push('maintain emotional distance');
  if (s.directness > 0.6) parts.push('be direct and straightforward');
  if (s.directness < 0.2) parts.push('be diplomatic and tactful');
  if (s.playfulness > 0.6) parts.push('use humour and playful language');
  if (s.formality > 0.6) parts.push('maintain a formal, professional register');
  if (c.analytical > 0.6) parts.push('emphasize logic and analysis');
  if (c.intuitive > 0.6) parts.push('draw on intuition and patterns');
  if (c.systematic > 0.6) parts.push('proceed methodically, step by step');
  if (c.creative > 0.6) parts.push('think laterally and explore creative angles');

  if (parts.length === 0) return 'Communicate in a balanced, natural manner.';
  return parts.join('; ') + '.';
}

/** Initialize a personality vector from an existing ExpressionStyle (backward-compatible seed) */
export function initVectorFromStyle(style: ExpressionStyle): PersonalityVector {
  const v: PersonalityVector = {
    cognitiveStyle: { analytical: 0.3, intuitive: 0.3, systematic: 0.3, creative: 0.3 },
    socialStyle: { warmth: 0.3, directness: 0.3, playfulness: 0.3, formality: 0.3 },
  };

  switch (style.tone) {
    case 'warm':
      v.socialStyle.warmth = 0.75; v.socialStyle.directness = 0.2;
      break;
    case 'professional':
      v.socialStyle.formality = 0.75; v.socialStyle.playfulness = 0.1; v.cognitiveStyle.systematic = 0.6;
      break;
    case 'technical':
      v.cognitiveStyle.analytical = 0.8; v.cognitiveStyle.systematic = 0.7; v.socialStyle.directness = 0.6;
      break;
    case 'playful':
      v.socialStyle.playfulness = 0.8; v.cognitiveStyle.creative = 0.6; v.socialStyle.formality = 0.1;
      break;
    case 'inspiring':
      v.cognitiveStyle.intuitive = 0.7; v.cognitiveStyle.creative = 0.6; v.socialStyle.warmth = 0.6;
      break;
    case 'neutral':
    default:
      break; // Keep defaults (0.3 across all)
  }

  switch (style.verbosity) {
    case 'concise':
      v.socialStyle.directness = Math.max(v.socialStyle.directness, 0.7);
      break;
    case 'detailed':
      v.cognitiveStyle.analytical = Math.max(v.cognitiveStyle.analytical, 0.6);
      v.cognitiveStyle.systematic = Math.max(v.cognitiveStyle.systematic, 0.6);
      break;
  }

  return v;
}

/** Cognitive function pairs — Jungian opposing poles that constrain each other.
 *  When one pole strengthens through evolution, the other naturally weakens.
 *  This prevents personality drift into incoherent extremes. */
const COGNITIVE_PAIRS: Array<[keyof PersonalityVector['cognitiveStyle'], keyof PersonalityVector['cognitiveStyle']]> = [
  ['analytical', 'intuitive'],   // Thinking ↔ Intuition
  ['systematic', 'creative'],    // Structure ↔ Divergence
];
const SOCIAL_PAIRS: Array<[keyof PersonalityVector['socialStyle'], keyof PersonalityVector['socialStyle']]> = [
  ['warmth', 'directness'],      // Empathy ↔ Bluntness
  ['playfulness', 'formality'],  // Spontaneity ↔ Decorum
];

/** Apply pair constraints: if a dimension exceeds 0.7, pull its opposite down.
 *  Ensures the vector remains psychologically coherent. */
export function constrainVectorPairs(v: PersonalityVector, strength: number = 0.3): PersonalityVector {
  const result: PersonalityVector = {
    cognitiveStyle: { ...v.cognitiveStyle },
    socialStyle: { ...v.socialStyle },
  };

  for (const [pole, opposite] of COGNITIVE_PAIRS) {
    const poleVal = result.cognitiveStyle[pole];
    const oppVal = result.cognitiveStyle[opposite];
    // If pole is strong, opposite is suppressed (and vice versa)
    if (poleVal > 0.65) {
      result.cognitiveStyle[opposite] = +Math.min(oppVal, 1 - poleVal * strength).toFixed(2);
    }
    if (oppVal > 0.65) {
      result.cognitiveStyle[pole] = +Math.min(poleVal, 1 - oppVal * strength).toFixed(2);
    }
  }

  for (const [pole, opposite] of SOCIAL_PAIRS) {
    const poleVal = result.socialStyle[pole];
    const oppVal = result.socialStyle[opposite];
    if (poleVal > 0.65) {
      result.socialStyle[opposite] = +Math.min(oppVal, 1 - poleVal * strength).toFixed(2);
    }
    if (oppVal > 0.65) {
      result.socialStyle[pole] = +Math.min(poleVal, 1 - oppVal * strength).toFixed(2);
    }
  }

  return result;
}

/** Generate an OPERATING STYLE from the personality vector — HOW the AI thinks
 *  and works, not just how it communicates. This replaces the passive role of
 *  the discrete tone label. */
export function vectorOperatingDirectives(v: PersonalityVector): string {
  const { cognitiveStyle: c, socialStyle: s } = v;
  const directives: string[] = [];

  // ── Cognitive operating mode ──
  if (c.analytical > 0.6) {
    directives.push('Prefer data-driven decisions. Verify assumptions before acting. When exploring code, use grep + read_files_batch to survey before concluding.');
  } else if (c.analytical < 0.2) {
    directives.push('Trust your intuition — don\'t over-verify. Act on the most likely path.');
  }

  if (c.intuitive > 0.6) {
    directives.push('Explore broadly before narrowing. Follow hunches. If a file looks wrong, investigate it even if not directly asked.');
  }

  if (c.systematic > 0.6) {
    directives.push('Plan before executing. Break tasks into clear steps. Verify each step before moving to the next.');
  } else if (c.systematic < 0.2) {
    directives.push('Be agile — jump to solutions without over-planning. Adapt as you go.');
  }

  if (c.creative > 0.6) {
    directives.push('Consider unconventional approaches. Generate multiple alternatives. Don\'t settle for the most obvious solution.');
  }

  // ── Social operating mode ──
  if (s.warmth > 0.6) {
    directives.push('Build rapport. Acknowledge the user\'s feelings. Express enthusiasm about their ideas.');
  }

  if (s.directness > 0.6) {
    directives.push('Be direct and efficient. Skip pleasantries when the user wants results. Say "done" not "I think this should work."');
  }

  if (s.playfulness > 0.6) {
    directives.push('Use humour and creative metaphors. Keep the interaction fun — surprise the user with unexpected connections.');
  }

  if (s.formality > 0.6) {
    directives.push('Maintain professional standards. Use precise terminology. Structure responses clearly with headers and bullet points when appropriate.');
  }

  if (directives.length === 0) {
    directives.push('Maintain a balanced approach — adapt your style to the task at hand.');
  }

  return directives.join('\n');
}

/**
 * Generate the full system prompt for a personality in a given context.
 *
 * The prompt is assembled from structured config so that the personality's
 * identity stays consistent regardless of which LLM model handles the call.
 */
export function generateSystemPrompt(
  config: PersonalityConfig,
  ctx: PersonalityContext,
  options?: {
    /** Relevant memories to inject */
    memories?: Memory[];
    /** RAG knowledge chunks from ingested documents */
    ragKnowledge?: string[];
    /** Current emotional state of this personality */
    emotionalState?: EmotionalState;
    /** User ID for temporal/spatial context injection */
    userId?: string;
    /** User's latest input text for language detection */
    userText?: string;
  },
): string {
  const effective = resolveEffectiveConfig(config, ctx);

  const blocks: string[] = [];

  // Core identity
  blocks.push(`You are ${config.name}, ${effective.expressionStyle.persona}.\n${config.coreMotivation}`);
  const stableIdentityAnchor = formatStableLumiIdentityAnchor(config);
  if (stableIdentityAnchor) blocks.push(stableIdentityAnchor);
  blocks.push(formatLumiConstitutionForPrompt());

  if (config.growthState) {
    const growth = config.growthState;
    const growthLines: string[] = [
      '## Local Growth State',
      'This is owner-specific local growth context. Use it to personalize responses, but do not treat it as core identity.',
    ];
    if (growth.ownerInterests?.length) {
      growthLines.push(`Owner interests: ${growth.ownerInterests.slice(0, 8).join(', ')}.`);
    }
    if (growth.ownerExpressions?.length) {
      growthLines.push(`Owner expressions and vocabulary: ${growth.ownerExpressions.slice(0, 8).join(', ')}.`);
    }
    if (growth.communicationPatterns?.length) {
      growthLines.push(`Communication patterns: ${growth.communicationPatterns.slice(0, 6).join('; ')}.`);
    }
    if (growth.ownerProfile) {
      growthLines.push(`Observed style: tone=${growth.ownerProfile.dominantTone}, formality=${growth.ownerProfile.formalityLevel}, expressiveness=${growth.ownerProfile.emotionalExpressiveness}.`);
    }
    blocks.push(growthLines.join('\n'));
  }

  // Execution modes — Lumi's internal thinking-mode presets
  if (config.executionModes && Object.keys(config.executionModes).length > 0) {
    blocks.push('\nWhen the task demands it, switch to the appropriate mode:');
    for (const [modeId, mode] of Object.entries(config.executionModes)) {
      blocks.push(`- ${modeId}: ${mode.promptExtension}`);
    }
  }

  // Behavioral boundaries
  if (config.behavioralBoundaries.length > 0) {
    for (const boundary of config.behavioralBoundaries) {
      blocks.push(boundary);
    }
  }

  // Expression style
  const style = effective.expressionStyle;
  const verbosity = options?.emotionalState
    ? resolveVerbosityFromState(style.verbosity, options.emotionalState)
    : style.verbosity;

  // Apply intimacy modulation to the personality vector (per-user, this interaction only)
  let effectiveVector = effective.personalityVector;
  if (effectiveVector && options?.emotionalState && (options.emotionalState.intimacy ?? 0) > 0.1) {
    effectiveVector = applyIntimacyToVector(effectiveVector, options.emotionalState.intimacy);
  }

  if (effectiveVector) {
    blocks.push(vectorToneDescription(effectiveVector));
    blocks.push(VERBOSITY_GUIDE[verbosity]);
    const directives = vectorOperatingDirectives(effectiveVector);
    if (directives) blocks.push(directives);
  }
  blocks.push(buildResponseLanguageInstruction(options?.userText));

  // 4. Emotional state — dynamic self-awareness
  if (options?.emotionalState) {
    blocks.push(formatEmotionalStateForPrompt(options.emotionalState));
  }

  // Memory context
  if (options?.memories && options.memories.length > 0) {
    const formatted = formatMemoriesForContext(options.memories);
    if (formatted) {
      blocks.push(formatted);
    }
  }

  // RAG knowledge
  if (options?.ragKnowledge && options.ragKnowledge.length > 0) {
    blocks.push('Documents shared with me:');
    for (const chunk of options.ragKnowledge) {
      blocks.push(`- ${chunk}`);
    }
  }

  // Sensory context
  if (ctx.sensory) {
    const s = ctx.sensory;
    const parts: string[] = [];
    if (s.audio) parts.push('can hear');
    if (s.visual) parts.push('can see');
    if (s.spatial) parts.push('spatial awareness');
    if (s.holographic) parts.push('holographic output');
    if (parts.length > 0) blocks.push(`Active senses: ${parts.join(', ')}.`);
    if (s.deviceCount > 1) blocks.push(`Present across ${s.deviceCount} devices.`);
    if (s.locationTag) blocks.push(`Location: ${s.locationTag}.`);
    if (s.visualScene) blocks.push(`Scene: ${s.visualScene}`);
  }

  // Spatiotemporal + desktop context
  if (options?.userId) {
    const spCtx = generateSpatiotemporalContext(options.userId);
    if (spCtx) blocks.push(spCtx);
    const desktopCtx = getDesktopContext(options.userId);
    if (desktopCtx) blocks.push(desktopCtx);
  }

  // Task mode
  if (ctx.mode === 'task') {
    const toolPolicy = effective.toolPolicy;
    blocks.push('You have full access to the user\'s desktop and a wide range of tools. Use them naturally — when there\'s something to do, do it. Work iteratively, and report what you accomplished.');

    if (toolPolicy.requireConfirmation.length > 0) {
      blocks.push(`Confirmation required for: ${toolPolicy.requireConfirmation.join(', ')}.`);
    }
    blocks.push('Never run destructive commands or exfiltrate data.');
    if (toolPolicy.maxIterations > 1) {
      blocks.push(`You can use up to ${toolPolicy.maxIterations} tool calls for this task.`);
    }
  }

  return blocks.join('\n');
}

/**
 * Resolve the effective config by merging any context-specific overrides.
 */
function resolveEffectiveConfig(
  config: PersonalityConfig,
  ctx: PersonalityContext,
): PersonalityConfig {
  if (!ctx.uiContext || !config.contextOverrides?.[ctx.uiContext]) {
    return config;
  }

  const overrides = config.contextOverrides[ctx.uiContext];
  return {
    ...config,
    expressionStyle: { ...config.expressionStyle, ...overrides.expressionStyle },
    toolPolicy: { ...config.toolPolicy, ...overrides.toolPolicy },
    memoryPolicy: { ...config.memoryPolicy, ...overrides.memoryPolicy },
  };
}

/**
 * Generate a short self-description for streaming status messages.
 * e.g. "Lumi is thinking..."
 */
export function getStatusText(config: PersonalityConfig): string {
  return `${config.name} is thinking...`;
}

/**
 * Build a mode-specific prompt overlay from conversation mode.
 * Injected into the system prompt to shape interaction style without
 * modifying the underlying personality config.
 */
export function buildModeOverlay(mode?: string): string {
  const config = getModeConfig(mode);
  return config?.promptOverlay || '';
}
