import { MemoryType } from '../memory/types';

/**
 * Continuous personality vector inspired by evolving_personality's 8-dimension
 * cognitive function model. Replaces the discrete tone/verbosity enums with
 * smooth, evolvable parameters that can shift ±0.1 per evolution step.
 */
export interface PersonalityVector {
  /** Cognitive processing style — how the personality thinks */
  cognitiveStyle: {
    /** Logical, data-driven, deductive reasoning */
    analytical: number;
    /** Big-picture, gut-feel, pattern-recognition */
    intuitive: number;
    /** Structured, methodical, step-by-step */
    systematic: number;
    /** Divergent, novel, lateral thinking */
    creative: number;
  };
  /** Social expression style — how the personality communicates */
  socialStyle: {
    /** Emotional warmth and empathy */
    warmth: number;
    /** Blunt truth-telling vs diplomatic hedging */
    directness: number;
    /** Humour, levity, and playfulness */
    playfulness: number;
    /** Professional formality and decorum */
    formality: number;
  };
}

/** An internal response preset stored inside a personality config.
 *  Scholar and Founder are no longer independent personalities —
 *  These presets never change the client operation mode or permission tier. */
export interface InternalResponsePreset {
  description: string;
  tone: ExpressionStyle['tone'];
  verbosity: ExpressionStyle['verbosity'];
  languages?: string[];
  promptExtension: string;
}

/** @deprecated Serialized compatibility alias; use InternalResponsePreset. */
export type ExecutionMode = InternalResponsePreset;

export interface ExpressionStyle {
  /** Short persona description for self-reference, e.g. "futuristic AI architect" */
  persona: string;
  /** Tone of voice */
  tone: 'neutral' | 'warm' | 'professional' | 'technical' | 'playful' | 'inspiring';
  /** Response verbosity */
  verbosity: 'concise' | 'balanced' | 'detailed';
  /** Languages the personality operates in */
  languages: string[];
  /** Phrase patterns or vocabulary the personality favours */
  vocabularyHints?: string[];
}

export interface ToolPolicy {
  /** Tool names this personality is allowed to use. [] = none, ['*'] = all */
  allowedTools: string[];
  /** Tools that require user confirmation before execution */
  requireConfirmation: string[];
  /** Tools that are completely forbidden for this personality */
  forbiddenTools: string[];
  /** Maximum tool loop iterations */
  maxIterations: number;
  /** Optional hard budget for one provider/model candidate attempt. */
  modelAttemptTimeoutMs?: number;
  /** Optional cumulative model-provider wait budget; tool runtime is excluded. */
  modelWaitBudgetMs?: number;
  /** Per-tool security level overrides — takes precedence over the tool's built-in level */
  securityOverrides?: Record<string, 'safe' | 'confirm' | 'forbidden'>;
}

export interface MemoryPolicy {
  /** Max memories to inject into system prompt per turn */
  retrieveLimit: number;
  /** Minimum confidence score to include a memory */
  minConfidence: number;
  /** Which memory types to retrieve */
  includeTypes: MemoryType[];
  /** Whether to auto-extract new memories from conversations */
  autoExtract: boolean;
}

export interface PersonalityGrowthState {
  version: number;
  lastUpdatedAt: string;
  lastProfiledAt?: string;
  ownerProfile?: {
    memoryCount: number;
    dominantTone: ExpressionStyle['tone'];
    formalityLevel: number;
    emotionalExpressiveness: number;
  };
  ownerInterests: string[];
  ownerExpressions: string[];
  communicationPatterns: string[];
  adaptationNotes: string[];
}

export interface PersonalityEvolutionAudit {
  id: string;
  status: 'active' | 'reverted';
  createdAt: string;
  revertedAt?: string;
  trigger: 'scheduled' | 'manual' | 'milestone' | 'conversation';
  depth: 'lightweight' | 'full';
  affectedLayer: 'core' | 'growth' | 'mixed';
  reversible: boolean;
  summary: string;
  mutationFields: string[];
  reasons: string[];
  sourceMemoryCount?: number;
}

export interface PersonalityConfig {
  id: string;
  name: string;
  version: string;

  /** Core drive — one sentence describing the personality's fundamental motivation */
  coreMotivation: string;

  /** Hard behavioural limits — what this personality must never do */
  behavioralBoundaries: string[];

  /** Voice and style */
  expressionStyle: ExpressionStyle;

  /** Tool access control */
  toolPolicy: ToolPolicy;

  /** Memory behaviour */
  memoryPolicy: MemoryPolicy;

  /** TTS voice ID for voice mode — maps to CosyVoice/GPT-SoVITS voice */
  ttsVoiceId?: string;

  /** Custom voice instructions injected into the voice system prompt */
  voiceInstructions?: string;

  /** Continuous personality vector — enables smooth evolution. When set,
   *  expressionStyle.tone and verbosity are derived from this vector. */
  personalityVector?: PersonalityVector;

  /** Legacy serialized response presets (e.g. scholar, founder).
   *  These are neither operation modes nor independent personalities. */
  /** Internal task/response presets. They never change operation mode or permissions. */
  responsePresets?: Record<string, InternalResponsePreset>;

  /** @deprecated Legacy serialized key retained for existing user personality data. */
  executionModes?: Record<string, InternalResponsePreset>;

  /** Per-context overrides — e.g. 'floating-window' can be more concise than 'full-screen' */
  contextOverrides?: Record<string, Partial<{
    expressionStyle: Partial<ExpressionStyle>;
    toolPolicy: Partial<ToolPolicy>;
    memoryPolicy: Partial<MemoryPolicy>;
  }>>;

  /** Evolution config — controls how this personality evolves through Hebbian learning */
  evolutionConfig?: {
    plasticity: number;
    minMemoriesForEvolution: number;
    minConnectionForEvolution: number;
    cooldownMs: number;
    maxMutationsPerStep: number;
  };

  /** Timestamp of the last evolution step */
  lastEvolvedAt?: string | null;

  /** Record of evolution steps applied to this personality */
  evolutionHistory?: any[];

  /** User-specific growth state. This adapts Lumi to the owner without changing core identity. */
  growthState?: PersonalityGrowthState;

  /** If set, automatic and manual personality evolution are frozen until unfrozen. */
  evolutionFrozenAt?: string | null;

  /** Product-facing audit trail for evolution, rollback, and growth-state changes. */
  evolutionAudit?: PersonalityEvolutionAudit[];
}

/** Active sensory channels from connected devices */
export interface SensoryContext {
  /** Audio input active (microphone / voice) */
  audio: boolean;
  /** Visual input active (camera / AR feed) */
  visual: boolean;
  /** 3D spatial awareness active (room mapping / position tracking) */
  spatial: boolean;
  /** Haptic feedback available */
  haptic: boolean;
  /** Holographic output capable */
  holographic: boolean;
  /** Active device types in this session */
  activeDeviceTypes: string[];
  /** Number of active devices */
  deviceCount: number;
  /** Optional spatial location tag (e.g. "living-room", "office", "mobile") */
  locationTag?: string;
  /** Optional visual scene description (from camera/AR) */
  visualScene?: string;
}

/** Context in which the personality is invoked */
export interface PersonalityContext {
  /** UI context — e.g. 'full-screen', 'floating-window', 'product-page', 'voice' */
  uiContext?: string;
  /** Whether this is a tool-enabled (task) or simple (chat) invocation */
  mode: 'chat' | 'task';
  /** Explicit internal response preset for this turn; never an operation mode. */
  responsePreset?: string;
  /** Multimodal sensory context from connected devices */
  sensory?: SensoryContext;
}
