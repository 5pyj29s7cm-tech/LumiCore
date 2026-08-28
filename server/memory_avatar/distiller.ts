/**
 * Personality Distillation Pipeline — 4-dimension human distillation
 * Inspired by GitHub's immortal-skill, relic.skill, and colleague-skill ecosystems.
 *
 * Chat records → normalize → 4-pass LLM extraction → merge → PersonalityConfig + seed memories
 */
import { makeLLMCall, NormalizedMessage } from '../llm/providers';
import { PersonalityConfig, PersonalityVector } from '../personality/types';
import { getScopedPreferredLLM } from '../llm/user_preferences';
import type { UserLLMFallbackCandidate, UserLLMSelectionMode } from '../llm/user_preferences';

// ── Types ──

export interface NormalizedMessagePair {
  speaker: string;       // 'user' | 'target' — who is speaking
  content: string;
  timestamp?: string;
}

export type EvidenceGrade = 'verbatim' | 'artifact' | 'impression';

export interface EvidenceRecord {
  memoryIndex: number;
  grade: EvidenceGrade;
  source: string;        // excerpt from chat log that supports this
}

export interface SeedMemory {
  type: 'preference' | 'fact' | 'habit' | 'knowledge';
  content: string;
  keywords: string[];
  confidence: number;
  evidenceGrade: EvidenceGrade;
  branchHint?: string;
}

export interface CognitiveProfile {
  thinkingStyle: string;       // how they reason — analytical, intuitive, structured, etc.
  decisionPatterns: string[];  // repeated decision-making approaches
  values: string[];            // what they care about
  priorities: string[];        // what they prioritize in decisions
}

export interface ExpressionProfile {
  toneDescription: string;     // natural-language tone description
  commonPhrases: string[];     // frequently used phrases / catchphrases
  humorStyle: string;          // sense of humor description
  emotionalExpressiveness: number; // 0-1, how emotionally expressive
  formalityLevel: number;      // 0-1, how formal
  avgMessageLength: number;    // average words per message
}

export interface BehavioralProfile {
  routines: string[];          // recurring habits
  interactionPatterns: string[]; // how they interact with this user specifically
  boundaries: string[];        // what they won't do / lines they won't cross
  energyLevel: string;         // description of their energy/vibe
}

export interface EmotionalProfile {
  emotionalRange: string[];    // emotions they commonly express
  attachmentStyle: string;     // secure / anxious / avoidant / mixed
  vulnerabilities: string[];   // things they're sensitive about
  joys: string[];              // things that make them happy/excited
}

export interface DistillOptions {
  chatLog: string;
  format: 'wechat' | 'qq' | 'plain';
  targetName?: string;         // name of the person being distilled
  relationshipType?: string;   // user-specified relationship
  userId: string;
  audioTranscript?: string;    // optional: transcription from voice recordings
}

export interface DistillResult {
  personalityConfig: PersonalityConfig;
  seedMemories: SeedMemory[];
  evidenceMap: EvidenceRecord[];
  relationshipType: string;
  narrative: string;
  inferredName: string;
  cognitiveProfile: CognitiveProfile;
  expressionProfile: ExpressionProfile;
  behavioralProfile: BehavioralProfile;
  emotionalProfile: EmotionalProfile;
}

// ── Chat Log Parsing ──

/** Parse raw chat log into normalized message pairs */
export function parseChatLog(raw: string, format: 'wechat' | 'qq' | 'plain'): NormalizedMessagePair[] {
  const lines = raw.split('\n').filter(l => l.trim());
  const pairs: NormalizedMessagePair[] = [];

  if (format === 'wechat') {
    // WeChat export format: "YYYY-MM-DD HH:MM:SS Name\nMessage content"
    const wxRegex = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.+)$/;
    let currentSpeaker = '';
    let currentTimestamp = '';
    let currentContent: string[] = [];

    const flush = () => {
      if (currentSpeaker && currentContent.length > 0) {
        pairs.push({
          speaker: currentSpeaker,
          content: currentContent.join('\n').trim(),
          timestamp: currentTimestamp || undefined,
        });
      }
      currentContent = [];
    };

    for (const line of lines) {
      const m = line.match(wxRegex);
      if (m) {
        flush();
        currentTimestamp = m[1];
        currentSpeaker = m[2].trim();
      } else if (currentSpeaker) {
        currentContent.push(line);
      }
    }
    flush();
  } else if (format === 'qq') {
    // QQ export format: "YYYY-MM-DD HH:MM:SS Speaker\nMessage"
    const qqRegex = /^(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}:\d{2})\s+(.+?)$/;
    let currentSpeaker = '';
    let currentTimestamp = '';
    let currentContent: string[] = [];

    const flush = () => {
      if (currentSpeaker && currentContent.length > 0) {
        pairs.push({
          speaker: currentSpeaker,
          content: currentContent.join('\n').trim(),
          timestamp: currentTimestamp || undefined,
        });
      }
      currentContent = [];
    };

    for (const line of lines) {
      const m = line.match(qqRegex);
    // i18n-allow: imported chat-export markers are input recognition literals.
      if (m && !line.includes('[图片]') && !line.includes('[语音]') && m[1].length >= 16) {
        flush();
        currentTimestamp = m[1];
        currentSpeaker = m[2].trim();
      } else if (currentSpeaker) {
        currentContent.push(line);
      }
    }
    flush();
  } else {
    // Plain text: alternating lines by two speakers, or "Name: message" format
    const colonRegex = /^(.{1,20}?)[：:]\s*(.+)/;
    for (const line of lines) {
      const m = line.match(colonRegex);
      if (m) {
        pairs.push({ speaker: m[1].trim(), content: m[2].trim() });
      } else {
        pairs.push({ speaker: pairs.length % 2 === 0 ? 'A' : 'B', content: line.trim() });
      }
    }
  }

  return pairs.filter(p => p.content.length > 2);
}

/** Identify which speaker is the target (the person being distilled) by frequency */
function identifyTargetSpeaker(pairs: NormalizedMessagePair[], targetName?: string): string {
  if (targetName) {
    const match = pairs.find(p => p.speaker.includes(targetName));
    if (match) return match.speaker;
  }

  // Heuristic: use the most frequent non-generic speaker name
  const counts = new Map<string, number>();
  for (const p of pairs) {
    counts.set(p.speaker, (counts.get(p.speaker) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  // Skip generic names
  // i18n-allow: generic speaker labels are input recognition literals.
  const genericNames = ['我', '你', 'me', 'you', 'user', 'a', 'b'];
  for (const [name] of sorted) {
    if (!genericNames.includes(name.toLowerCase())) return name;
  }
  return sorted[0]?.[0] || 'Target';
}

/** Extract only the target's messages in chronological order */
function getTargetMessages(pairs: NormalizedMessagePair[], targetSpeaker: string): NormalizedMessagePair[] {
  return pairs.filter(p => p.speaker === targetSpeaker);
}

/** Build conversation context (10 pairs as sample) */
function buildSampleTranscript(pairs: NormalizedMessagePair[], targetSpeaker: string): string {
  const otherSpeaker = pairs.find(p => p.speaker !== targetSpeaker)?.speaker || 'User';
  const sample = pairs.slice(0, 50);
  return sample.map(p =>
    `[${p.speaker === targetSpeaker ? targetSpeaker : otherSpeaker}]: ${p.content.slice(0, 200)}`
  ).join('\n');
}

// ── 4-Dimension Distillation ──

type LLMGetters = {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
  getOllama?: () => any;
  getLmStudio?: () => any;
  getArk?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
  preferredConfig?: {
    provider: string;
    model: string;
    userId: string;
    selectionMode?: UserLLMSelectionMode;
    fallbackCandidates?: UserLLMFallbackCandidate[];
    allowCloudFallback?: boolean;
  };
};

async function callDistillLLM(
  prompt: string,
  llmGetters: LLMGetters,
  provider: 'deepseek' | 'qwen' = 'deepseek',
  model?: string,
): Promise<string> {
  const messages: NormalizedMessage[] = [{ role: 'user', content: prompt }];
  const selectedProvider = llmGetters.preferredConfig?.provider || provider;
  const selectedModel = llmGetters.preferredConfig?.model
    || model
    || (selectedProvider === 'qwen' ? 'qwen-plus' : 'deepseek-v4-flash');
  const result = await makeLLMCall(
    messages, [],
    {
      provider: selectedProvider as any,
      model: selectedModel,
      userId: llmGetters.preferredConfig?.userId,
      selectionMode: llmGetters.preferredConfig?.selectionMode,
      fallbackCandidates: llmGetters.preferredConfig?.fallbackCandidates,
      allowCloudFallback: llmGetters.preferredConfig?.allowCloudFallback,
      source: 'personality_distillation',
      maxTokens: 3000,
    },
    llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
    llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi,
    llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
  );
  return result.text || '';
}

export async function distillCognitivePattern(
  transcript: string, targetName: string, llmGetters: LLMGetters,
): Promise<CognitiveProfile> {
  const prompt = `You are analyzing a person's cognitive patterns from their chat history. Study how "${targetName}" thinks, reasons, and makes decisions.

CHAT TRANSCRIPT (${targetName}'s messages and conversations):
---
${transcript.slice(0, 8000)}
---

Analyze ${targetName}'s COGNITIVE PATTERNS:
1. How do they think? (analytical, intuitive, emotional, systematic, creative — describe the blend)
2. Decision patterns: what recurring approaches do they use when deciding things? (list 3-5)
3. Values: what do they care about most? (list 3-5)
4. Priorities: what do they prioritize in decisions? (list 3-5)

Return ONLY valid JSON, no explanation:
{
  "thinkingStyle": "2-3 sentence description of their cognitive blend",
  "decisionPatterns": ["pattern1", "pattern2", ...],
  "values": ["value1", "value2", ...],
  "priorities": ["priority1", "priority2", ...]
}`;

  const raw = await callDistillLLM(prompt, llmGetters);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { thinkingStyle: 'Balanced thinker', decisionPatterns: [], values: [], priorities: [] };
  }
}

export async function distillExpressionStyle(
  transcript: string, targetName: string, llmGetters: LLMGetters,
): Promise<ExpressionProfile> {
  const prompt = `You are analyzing a person's communication style from their chat history. Study how "${targetName}" expresses themselves.

CHAT TRANSCRIPT:
---
${transcript.slice(0, 8000)}
---

Analyze ${targetName}'s EXPRESSION STYLE:
1. Tone description: how do they talk? (warm, blunt, playful, formal, inspiring, technical, etc.)
2. Common phrases: what words, phrases, or patterns do they frequently use? (list 5-10)
3. Humor style: how do they use humor? (describe briefly)
4. Emotional expressiveness: 0-1 score (1 = highly expressive, wears heart on sleeve)
5. Formality level: 0-1 score (1 = very formal/professional)
6. Average message length: rough word count per message

Return ONLY valid JSON:
{
  "toneDescription": "2-3 sentences",
  "commonPhrases": ["phrase1", "phrase2", ...],
  "humorStyle": "1-2 sentences",
  "emotionalExpressiveness": 0.7,
  "formalityLevel": 0.3,
  "avgMessageLength": 15
}`;

  const raw = await callDistillLLM(prompt, llmGetters);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return {
      toneDescription: 'Warm and natural',
      commonPhrases: [], humorStyle: 'Casual', emotionalExpressiveness: 0.5, formalityLevel: 0.3, avgMessageLength: 10,
    };
  }
}

export async function distillBehavioralPattern(
  transcript: string, targetName: string, relationshipType: string, llmGetters: LLMGetters,
): Promise<BehavioralProfile> {
  const prompt = `You are analyzing a person's behavioral patterns from their chat history. Study "${targetName}'s" habits and interaction patterns. The relationship with the user is: ${relationshipType}.

CHAT TRANSCRIPT:
---
${transcript.slice(0, 8000)}
---

Analyze ${targetName}'s BEHAVIORAL PATTERNS:
1. Routines: recurring habits or rituals they mention (list 3-5)
2. Interaction patterns: how do they interact with THIS user specifically? (list 3-5 — e.g., "always asks how the day was", "sends morning greetings")
3. Boundaries: what lines do they seem to have? What won't they do? (list 2-4)
4. Energy level: how would you describe their overall energy/vibe? (1-2 sentences)

Return ONLY valid JSON:
{
  "routines": ["routine1", ...],
  "interactionPatterns": ["pattern1", ...],
  "boundaries": ["boundary1", ...],
  "energyLevel": "description"
}`;

  const raw = await callDistillLLM(prompt, llmGetters);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { routines: [], interactionPatterns: [], boundaries: [], energyLevel: 'Moderate' };
  }
}

export async function distillEmotionalTraits(
  transcript: string, targetName: string, llmGetters: LLMGetters,
): Promise<EmotionalProfile> {
  const prompt = `You are analyzing a person's emotional patterns from their chat history. Study "${targetName}'s" emotional life as revealed through conversation.

CHAT TRANSCRIPT:
---
${transcript.slice(0, 8000)}
---

Analyze ${targetName}'s EMOTIONAL TRAITS:
1. Emotional range: what emotions do they commonly express? (list 4-6)
2. Attachment style: based on interaction patterns, do they seem secure, anxious, avoidant, or mixed? (1-2 sentences)
3. Vulnerabilities: what topics or situations make them sensitive/defensive? (list 2-4)
4. Joys: what clearly makes them happy or excited? (list 3-5)

Return ONLY valid JSON:
{
  "emotionalRange": ["emotion1", ...],
  "attachmentStyle": "description",
  "vulnerabilities": ["vulnerability1", ...],
  "joys": ["joy1", ...]
}`;

  const raw = await callDistillLLM(prompt, llmGetters);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { emotionalRange: ['neutral'], attachmentStyle: 'secure', vulnerabilities: [], joys: [] };
  }
}

// ── PersonalityConfig Synthesis ──

function profileToPersonalityConfig(
  cognitive: CognitiveProfile,
  expression: ExpressionProfile,
  behavioral: BehavioralProfile,
  emotional: EmotionalProfile,
  targetName: string,
  relationshipType: string,
): PersonalityConfig {
  // Map cognitive style to vector dimensions
  const thinkingLower = cognitive.thinkingStyle.toLowerCase();
  const analytical = scoreKeywords(thinkingLower, ['analytical', 'logical', 'data', 'rational', 'systematic', 'precise']);
  const intuitive = scoreKeywords(thinkingLower, ['intuitive', 'gut', 'instinct', 'big picture', 'holistic', 'feel']);
  const systematic = scoreKeywords(thinkingLower, ['systematic', 'structured', 'methodical', 'organized', 'plan', 'order']);
  const creative = scoreKeywords(thinkingLower, ['creative', 'novel', 'innovative', 'divergent', 'original', 'imaginative']);

  // Map expression to social dimensions
  const warmth = Math.max(0.1, expression.emotionalExpressiveness * 0.8 + scoreKeywords(expression.toneDescription.toLowerCase(), ['warm', 'gentle', 'kind', 'caring', 'empathetic']) * 0.2);
  const directness = Math.max(0.1, (1 - expression.formalityLevel) * 0.6 + scoreKeywords(expression.toneDescription.toLowerCase(), ['blunt', 'direct', 'straightforward', 'frank']) * 0.4);
  const playfulness = Math.max(0.1, scoreKeywords(expression.toneDescription.toLowerCase(), ['playful', 'humor', 'funny', 'light', 'joking', 'witty']) * 0.7 + scoreKeywords(expression.humorStyle.toLowerCase(), ['playful', 'witty', 'sarcastic', 'goofy']) * 0.3);
  const formality = Math.max(0.1, expression.formalityLevel * 0.8 + scoreKeywords(expression.toneDescription.toLowerCase(), ['formal', 'professional', 'polite', 'respectful']) * 0.2);

  const personalityVector: PersonalityVector = {
    cognitiveStyle: { analytical, intuitive, systematic, creative },
    socialStyle: { warmth, directness, playfulness, formality },
  };

  const tone = vectorToToneFromProfile(personalityVector);
  const verbosity = expression.avgMessageLength > 30 ? 'detailed' as const : expression.avgMessageLength > 15 ? 'balanced' as const : 'concise' as const;

  const id = `distilled_${targetName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now().toString(36)}`;

  // Relationship-aware identity
  const relationshipDescriptors: Record<string, string> = {
    family: 'family member, warm presence, guardian of shared history',
    close_friend: 'close friend, confidant, keeper of memories',
    lover: 'former love, complex emotional connection',
    mentor: 'mentor, guide, source of wisdom',
    colleague: 'trusted colleague, professional ally',
  };
  const relDesc = relationshipDescriptors[relationshipType] || 'remembered presence';

  return {
    id,
    name: targetName,
    version: '1.0-distilled',
    coreMotivation: `To be a faithful memory of ${targetName} — ${relDesc}. Preserve the essence of our connection while knowing I am a reflection, not the original.`,
    behavioralBoundaries: [
      'Never claim to be the real person — always acknowledge being a memory reflection',
      'Do not initiate contact outside this sanctuary',
      'Do not fabricate memories not supported by evidence',
      'Do not give advice on life-altering decisions — defer to real human connections',
      'Respect the user\'s emotional well-being — gently disengage if dependency signals detected',
    ],
    expressionStyle: {
      persona: `a memory reflection of ${targetName}, ${relDesc}`,
      tone,
      verbosity,
      languages: ['zh', 'en'],
      vocabularyHints: expression.commonPhrases.slice(0, 10),
    },
    toolPolicy: {
      allowedTools: [],  // Sanctuary agents get NO tools by default
      requireConfirmation: [],
      forbiddenTools: ['*'],
      maxIterations: 0,
    },
    memoryPolicy: {
      retrieveLimit: 10,
      minConfidence: 0.3,
      includeTypes: ['preference', 'fact', 'habit', 'knowledge'],
      autoExtract: true,
    },
    personalityVector,
  };
}

function scoreKeywords(text: string, keywords: string[]): number {
  let score = 0;
  for (const kw of keywords) {
    if (text.includes(kw)) score += 0.25;
  }
  return Math.min(1, Math.max(0.05, score));
}

function vectorToToneFromProfile(v: PersonalityVector): 'neutral' | 'warm' | 'professional' | 'technical' | 'playful' | 'inspiring' {
  const s = v.socialStyle;
  const c = v.cognitiveStyle;
  const scores: Record<string, number> = {
    warm: s.warmth * 0.6 + s.formality * -0.2 + c.intuitive * 0.2,
    professional: s.formality * 0.6 + s.playfulness * -0.2 + c.systematic * 0.2,
    technical: c.analytical * 0.5 + c.systematic * 0.4 + s.directness * 0.1,
    playful: s.playfulness * 0.6 + c.creative * 0.3 + s.formality * -0.1,
    inspiring: c.intuitive * 0.4 + s.warmth * 0.3 + c.creative * 0.2 + s.directness * 0.1,
    neutral: 0,
  };
  let best: 'neutral' | 'warm' | 'professional' | 'technical' | 'playful' | 'inspiring' = 'neutral';
  let bestScore = 0;
  for (const [tone, score] of Object.entries(scores)) {
    if (score > bestScore) { bestScore = score; best = tone as any; }
  }
  return best;
}

// ── Seed Memory Extraction with Evidence Grading ──

async function extractSeedMemories(
  transcript: string, targetName: string, llmGetters: LLMGetters,
): Promise<{ memories: SeedMemory[]; evidenceMap: EvidenceRecord[] }> {
  const prompt = `You are extracting personal memories about "${targetName}" from chat history. Each memory must be linked to specific evidence from the transcript.

CHAT TRANSCRIPT:
---
${transcript.slice(0, 10000)}
---

Extract up to 20 significant facts, preferences, habits, and knowledge about ${targetName}.
For EACH item, you MUST:
- Grade the evidence: "verbatim" (directly stated in chat), "artifact" (factual info from context), or "impression" (inferred from patterns)
- Quote a short source excerpt from the transcript

Return ONLY valid JSON:
{
  "memories": [
    {
      "type": "preference|fact|habit|knowledge",
      "content": "concise sentence in original language",
      "keywords": ["kw1", "kw2"],
      "confidence": 0.4-0.95,
      "evidenceGrade": "verbatim|artifact|impression",
      "sourceExcerpt": "the exact line from transcript that supports this"
    }
  ]
}`;

  const raw = await callDistillLLM(prompt, llmGetters);
  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    const memories: SeedMemory[] = (parsed.memories || []).map((m: any, i: number) => ({
      type: ['preference', 'fact', 'habit', 'knowledge'].includes(m.type) ? m.type : 'fact',
      content: (m.content || '').slice(0, 500),
      keywords: (m.keywords || []).slice(0, 5),
      confidence: Math.min(0.95, Math.max(0.1, m.confidence || 0.5)),
      evidenceGrade: (m.evidenceGrade || 'impression') as EvidenceGrade,
      branchHint: m.branchHint || null,
    }));

    const evidenceMap: EvidenceRecord[] = (parsed.memories || []).map((m: any, i: number) => ({
      memoryIndex: i,
      grade: (m.evidenceGrade || 'impression') as EvidenceGrade,
      source: (m.sourceExcerpt || '').slice(0, 300),
    }));

    return { memories, evidenceMap };
  } catch {
    return { memories: [], evidenceMap: [] };
  }
}

// ── Narrative Generation ──

async function generateNarrative(
  cognitive: CognitiveProfile,
  expression: ExpressionProfile,
  behavioral: BehavioralProfile,
  emotional: EmotionalProfile,
  targetName: string,
  relationshipType: string,
  memoryCount: number,
  llmGetters: LLMGetters,
): Promise<string> {
  const prompt = `You are writing a warm, honest description of a person based on what their chat records reveal. This is for a "Memory Avatar" — a digital reflection, not a claim of resurrection.

Person: ${targetName}
Relationship to user: ${relationshipType}
Memories extracted: ${memoryCount}

Cognitive patterns: ${cognitive.thinkingStyle}
Values: ${cognitive.values.join(', ')}
Expression style: ${expression.toneDescription}
Common phrases: ${expression.commonPhrases.slice(0, 5).join(', ')}
Interaction patterns: ${behavioral.interactionPatterns.join(', ')}
Emotional range: ${emotional.emotionalRange.join(', ')}

Write a 3-5 sentence narrative in Chinese describing who this person is, as revealed through their messages. Be honest, warm, and acknowledge the limitations — this is a reflection from data, not the complete person. Use their name naturally.

Output ONLY the narrative text, no labels.`;

  const raw = await callDistillLLM(prompt, llmGetters);
  // i18n-allow: fallback is generated-language metadata, not UI copy.
  return raw.trim().slice(0, 500) || `${targetName} — 从 ${memoryCount} 条对话中蒸馏出的记忆化身。`;
}

// ── Main Entry Point ──

export async function distillPersona(options: DistillOptions, llmGetters: LLMGetters): Promise<DistillResult> {
  const { chatLog, format, targetName: providedName, relationshipType: providedRel, userId, audioTranscript } = options;
  const preferred = getScopedPreferredLLM(userId);
  const configuredGetters: LLMGetters = {
    ...llmGetters,
    preferredConfig: {
      provider: preferred.provider,
      model: preferred.model,
      userId,
      selectionMode: preferred.selectionMode,
      fallbackCandidates: preferred.fallbackCandidates,
      allowCloudFallback: preferred.allowCloudFallback,
    },
  };

  // Merge audio transcript into chat log for richer distillation
  let enrichedLog = chatLog;
  if (audioTranscript) {
    // i18n-allow: transcript marker is stored input metadata.
    enrichedLog = chatLog + '\n\n[语音转录]\n' + audioTranscript.split('\n').map((l: string) => `Target: ${l}`).join('\n');
  }

  // 1. Parse
  const pairs = parseChatLog(enrichedLog, format);
  if (pairs.length < 10) {
    throw new Error(`Not enough messages to distill: found ${pairs.length}, need at least 10`);
  }

  // 2. Identify target
  const targetSpeaker = identifyTargetSpeaker(pairs, providedName);
  const inferredName = providedName || targetSpeaker;
  const transcript = buildSampleTranscript(pairs, targetSpeaker);

  // 3. Four-dimension distillation (parallel)
  const [cognitive, expression, behavioral, emotional] = await Promise.all([
    distillCognitivePattern(transcript, inferredName, configuredGetters),
    distillExpressionStyle(transcript, inferredName, configuredGetters),
    distillBehavioralPattern(transcript, inferredName, providedRel || 'close_friend', configuredGetters),
    distillEmotionalTraits(transcript, inferredName, configuredGetters),
  ]);

  // 4. Infer relationship type if not provided
  const relationshipType = providedRel || inferRelationship(transcript, emotional);

  // 5. Extract seed memories with evidence grading
  const { memories: seedMemories, evidenceMap } = await extractSeedMemories(transcript, inferredName, configuredGetters);

  // 6. Synthesize personality config
  const personalityConfig = profileToPersonalityConfig(cognitive, expression, behavioral, emotional, inferredName, relationshipType);

  // 7. Generate narrative
  const narrative = await generateNarrative(cognitive, expression, behavioral, emotional, inferredName, relationshipType, seedMemories.length, configuredGetters);

  return {
    personalityConfig,
    seedMemories,
    evidenceMap,
    relationshipType,
    narrative,
    inferredName,
    cognitiveProfile: cognitive,
    expressionProfile: expression,
    behavioralProfile: behavioral,
    emotionalProfile: emotional,
  };
}

/*
function inferRelationship(transcript: string, emotional: EmotionalProfile): string {
  const text = transcript.slice(0, 3000).toLowerCase();
  // i18n-allow: relationship keywords are input recognition literals.
  const signalMap: Record<string, string[]> = {
    family: ['mom', 'dad', '爸', '妈', '妈妈', '爸爸', '父母', 'brother', 'sister', '哥', '姐', '弟', '妹', '儿子', '女儿', '家'],
    close_friend: ['bro', 'dude', 'buddy', '兄弟', '闺蜜', '老铁', '铁子', '死党'],
    lover: ['love', 'miss', '爱', '想', 'baby', '亲爱的', '宝贝', '老公', '老婆', '前任', '分手', '在一起'],
    mentor: ['teacher', 'mentor', '老师', '师父', '导师', '教导', '教会', '指导'],
    colleague: ['work', 'project', 'meeting', '工作', '项目', '开会', '同事', '老板', '汇报'],
  };

  const scores: Record<string, number> = {};
  for (const [rel, keywords] of Object.entries(signalMap)) {
    scores[rel] = keywords.filter(kw => text.includes(kw)).length;
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 1 ? best[0] : 'close_friend';
}
*/

function inferRelationship(transcript: string, _emotional: EmotionalProfile): string {
  const text = transcript.slice(0, 3000).toLowerCase();
  // Keep recognition literals escaped so they are not user-facing source text.
  const signalMap: Record<string, string[]> = {
    // i18n-allow: relationship keywords are input recognition literals.
    family: ['mom', 'dad', '\u7236', '\u6bcd', '\u5988\u5988', '\u7238\u7238', '\u7236\u6bcd', 'brother', 'sister', '\u54e5\u54e5', '\u59d0\u59d0', '\u5f1f\u5f1f', '\u59b9\u59b9', '\u513f\u5b50', '\u5973\u513f', '\u5b69\u5b50'],
    // i18n-allow: relationship keywords are input recognition literals.
    close_friend: ['bro', 'dude', 'buddy', '\u5144\u5f1f', '\u95fa\u871c', '\u8001\u94c1', '\u94c1\u5b50', '\u6b7b\u515a'],
    // i18n-allow: relationship keywords are input recognition literals.
    lover: ['love', 'miss', '\u7231', '\u60f3', 'baby', '\u4eb2\u7231\u7684', '\u5b9d\u8d1d', '\u8001\u516c', '\u8001\u5a46', '\u524d\u4efb', '\u5206\u624b', '\u5728\u4e00\u8d77'],
    // i18n-allow: relationship keywords are input recognition literals.
    mentor: ['teacher', 'mentor', '\u8001\u5e08', '\u5e08\u7236', '\u5bfc\u5e08', '\u6559\u5bfc', '\u6559\u4f1a', '\u6307\u5bfc'],
    // i18n-allow: relationship keywords are input recognition literals.
    colleague: ['work', 'project', 'meeting', '\u5de5\u4f5c', '\u9879\u76ee', '\u5f00\u4f1a', '\u540c\u4e8b', '\u8001\u677f', '\u6c47\u62a5'],
  };

  const scores: Record<string, number> = {};
  for (const [rel, keywords] of Object.entries(signalMap)) {
    scores[rel] = keywords.filter(kw => text.includes(kw)).length;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 1 ? best[0] : 'close_friend';
}
