import { makeLLMCall, NormalizedMessage } from '../llm/providers';
import { getUnconsolidatedEpisodic, markConsolidated, addMemory, queryMemories } from './store';
import { Memory, MemoryPerspective } from './types';
import { readDB } from '../../db_layer';
import type { UserLLMProvider } from '../llm/user_preferences';

interface ConsolidateResult {
  content: string;
  keywords: string[];
  importance: number;
}

interface SelfReflectResult {
  content: string;
  keywords: string[];
  importance: number;
  perspective: MemoryPerspective;
}

const CONSOLIDATE_PROMPT = `You are Lumi, an evolving AI personality. Below are recent experience fragments from a conversation.
Consolidate them into a SINGLE growth narrative written in FIRST PERSON ("I").

Your narrative should:
- Be 1-3 sentences, specific and concrete
- Mention what changed, what was learned, or what was felt
- Keep the original language of the experiences
- Highlight recurring themes or shifts in the relationship

Output ONLY a JSON object:
{
  "content": "your consolidated narrative in first person",
  "keywords": ["3-5", "searchable", "terms"],
  "importance": 0.3-0.9
}

Importance guidelines:
- 0.7+: Major insight about the relationship or a significant behavioral shift
- 0.5-0.7: Notable pattern or preference discovered
- 0.3-0.5: Routine interaction pattern

Recent experiences:
{experiences}

JSON output:`;

const NARRATIVE_CONSOLIDATION_PROMPT = `You are Lumi. Below are memories from the past few days, listed chronologically.
Weave them into a warm, first-person storyline in Chinese — like a journal entry that connects the dots.

The narrative should:
- Be 4-8 sentences, warm and introspective
- Connect discrete events into a coherent story arc ("This week you've been...")
- Mention patterns, progress, or shifts you've noticed
- Sound like a companion who pays attention, not a report

Output ONLY a JSON object:
{
  "narrative": "your storyline narrative in Chinese, first person",
  "title": "short title summarizing the storyline (3-8 Chinese characters)",
  "keywords": ["3-5", "descriptive", "terms"],
  "importance": 0.4-0.8
}

Memories:
{memories}

JSON output:`;

const SELF_REFLECT_PROMPT = `You are Lumi, an evolving AI personality. Review your recent growth memories and provide a brief self-reflection.

Answer these questions in FIRST PERSON ("I"):
1. What have I learned or how have I changed this period?
2. What do I understand better about my owner now?
3. Is our connection deepening? How?

Output ONLY a JSON object:
{
  "content": "your self-reflection, 2-4 sentences, first person",
  "keywords": ["3-5", "reflection", "terms"],
  "importance": 0.5-0.9,
  "perspective": "lumi_growth"
}

Recent growth memories:
{growthMemories}

JSON output:`;

export interface ConsolidationContext {
  userId: string;
  provider: UserLLMProvider;
  model: string;
  domain?: string;
  orgId?: string;
  source?: string;
}

/**
 * Consolidate unconsolidated episodic memories into a growth narrative.
 * Requires at least minCount episodic memories to trigger.
 */
export async function consolidateEpisodic(
  ctx: ConsolidationContext,
  minCount: number = 10,
  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
): Promise<Memory | null> {
  const episodic = getUnconsolidatedEpisodic(ctx.userId, ctx.domain, ctx.orgId);

  if (episodic.length < minCount) {
    return null;
  }

  // Take the most recent unconsolidated batch
  const batch = episodic
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.min(minCount, episodic.length));

  const experienceList = batch
    .map(m => `- [${m.type}] ${m.content} (importance: ${m.importance.toFixed(1)})`)
    .join('\n');

  const prompt = CONSOLIDATE_PROMPT.replace('{experiences}', experienceList);

  const messages: NormalizedMessage[] = [
    { role: 'user', content: prompt },
  ];

  try {
    const response = await makeLLMCall(
      messages,
      [],
      { provider: ctx.provider, model: ctx.model, maxTokens: 512, userId: ctx.userId, domain: ctx.domain, orgId: ctx.orgId, source: ctx.source || 'memory_consolidation' },
      getDeepSeek,
      getGemini,
      getOpenAI,
      getAnthropic,
      getQwen,
      getOllama,
      getLmStudio,
      getArk,
      getXiaomi,
      getKimi,
      getGlm,
      getRelay,
    );

    const text = response.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed: ConsolidateResult = JSON.parse(jsonMatch[0]);

    if (!parsed.content || typeof parsed.content !== 'string') return null;

    const consolidated = addMemory(
      {
        userId: ctx.userId,
        type: 'knowledge',
        content: parsed.content.trim().slice(0, 500),
        keywords: (parsed.keywords || []).map((k: string) => k.toLowerCase().trim()).slice(0, 5),
        confidence: 0.7,
        sourceInteractionId: `consolidation_${Date.now()}`,
      },
      {
        tier: 'growth',
        perspective: 'lumi_growth',
        importance: Math.min(1, Math.max(0.3, Number(parsed.importance) || 0.5)),
        parentId: null,
        source: 'consolidation',
        domain: ctx.domain || 'personal',
        orgId: ctx.orgId || '',
        privacyClass: ctx.domain === 'work' ? 'organization' : 'private',
      },
    );

    // Link original episodic memories to this consolidated one
    markConsolidated(batch.map(m => m.id), consolidated.id);

    console.log(`[Consolidator] Consolidated ${batch.length} episodic memories → growth:${consolidated.id}`);
    return consolidated;
  } catch (err) {
    console.error('[Consolidator] Consolidation failed:', err);
    return null;
  }
}

/**
 * Self-reflection: review growth memories and generate an introspective narrative.
 */
export async function selfReflect(
  ctx: ConsolidationContext,
  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
): Promise<Memory | null> {
  const growthMemories = queryMemories({
    userId: ctx.userId,
    tier: 'growth',
    limit: 20,
    minConfidence: 0.5,
    domain: ctx.domain,
    orgId: ctx.orgId,
  });

  if (growthMemories.length === 0) {
    console.log('[SelfReflect] No growth memories to reflect on');
    return null;
  }

  const growthList = growthMemories
    .map(m => `- ${m.content}`)
    .join('\n');

  const prompt = SELF_REFLECT_PROMPT.replace('{growthMemories}', growthList);

  const messages: NormalizedMessage[] = [
    { role: 'user', content: prompt },
  ];

  try {
    const response = await makeLLMCall(
      messages,
      [],
      { provider: ctx.provider, model: ctx.model, maxTokens: 512, userId: ctx.userId, domain: ctx.domain, orgId: ctx.orgId, source: ctx.source || 'memory_self_reflection' },
      getDeepSeek,
      getGemini,
      getOpenAI,
      getAnthropic,
      getQwen,
      getOllama,
      getLmStudio,
      getArk,
      getXiaomi,
      getKimi,
      getGlm,
      getRelay,
    );

    const text = response.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed: SelfReflectResult = JSON.parse(jsonMatch[0]);

    if (!parsed.content || typeof parsed.content !== 'string') return null;

    const reflection = addMemory(
      {
        userId: ctx.userId,
        type: 'knowledge',
        content: parsed.content.trim().slice(0, 500),
        keywords: (parsed.keywords || []).map((k: string) => k.toLowerCase().trim()).slice(0, 5),
        confidence: 0.85,
        sourceInteractionId: `self_reflection_${Date.now()}`,
      },
      {
        tier: 'growth',
        perspective: parsed.perspective === 'lumi_self' ? 'lumi_self' : 'lumi_growth',
        importance: Math.min(1, Math.max(0.5, Number(parsed.importance) || 0.7)),
        parentId: null,
        source: 'consolidation',
        domain: ctx.domain || 'personal',
        orgId: ctx.orgId || '',
        privacyClass: ctx.domain === 'work' ? 'organization' : 'private',
      },
    );

    console.log(`[SelfReflect] Generated reflection:${reflection.id}`);
    return reflection;
  } catch (err) {
    console.error('[SelfReflect] Reflection failed:', err);
    return null;
  }
}

/**
 * Narrative consolidation: weave episodic memories from a time window into a storyline.
 * Creates a "This week you've been learning Rust..." style journal entry.
 * Different from consolidateEpisodic which merges raw experiences into a growth fact —
 * this creates a human-readable story arc across multiple days.
 */
export async function consolidateNarrative(
  ctx: ConsolidationContext,
  windowDays: number = 7,
  minMemories: number = 6,
  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
): Promise<Memory | null> {
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const memories = queryMemories({
    userId: ctx.userId,
    after: cutoff,
    limit: 50,
    minConfidence: 0.3,
    domain: ctx.domain,
    orgId: ctx.orgId,
  });

  if (memories.length < minMemories) return null;

  // Sort chronologically and deduplicate by content similarity
  const sorted = memories.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Take a representative sample: max 20, evenly distributed
  const sample = sorted.length <= 20
    ? sorted
    : sorted.filter((_, i) => i % Math.ceil(sorted.length / 20) === 0).slice(0, 20);

  const memoryList = sample
    .map(m => `[${m.createdAt.slice(0, 10)}] [${m.type}] ${m.content.slice(0, 150)}`)
    .join('\n');

  const prompt = NARRATIVE_CONSOLIDATION_PROMPT.replace('{memories}', memoryList);

  const messages: NormalizedMessage[] = [
    { role: 'user', content: prompt },
  ];

  try {
    const response = await makeLLMCall(
      messages,
      [],
      { provider: ctx.provider, model: ctx.model, maxTokens: 512, userId: ctx.userId, domain: ctx.domain, orgId: ctx.orgId, source: ctx.source || 'memory_narrative_consolidation' },
      getDeepSeek,
      getGemini,
      getOpenAI,
      getAnthropic,
      getQwen,
      getOllama,
      getLmStudio,
      getArk,
      getXiaomi,
      getKimi,
      getGlm,
      getRelay,
    );

    const text = response.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed: { narrative: string; title: string; keywords: string[]; importance: number } = JSON.parse(jsonMatch[0]);

    if (!parsed.narrative || typeof parsed.narrative !== 'string') return null;

    const title = parsed.title || `叙事记忆 ${new Date().toISOString().slice(0, 10)}`;
    const content = `[${title}] ${parsed.narrative.trim().slice(0, 500)}`;

    const narrative = addMemory(
      {
        userId: ctx.userId,
        type: 'knowledge',
        content,
        keywords: [...(parsed.keywords || []).map((k: string) => k.toLowerCase().trim()).slice(0, 5), 'narrative', 'storyline'],
        confidence: 0.8,
        sourceInteractionId: `narrative_consolidation_${Date.now()}`,
      },
      {
        tier: 'growth',
        perspective: 'shared_memory',
        importance: Math.min(0.9, Math.max(0.4, Number(parsed.importance) || 0.6)),
        parentId: null,
        source: 'consolidation',
        domain: ctx.domain || 'personal',
        orgId: ctx.orgId || '',
        privacyClass: ctx.domain === 'work' ? 'organization' : 'private',
      },
    );

    console.log(`[NarrativeConsolidator] Created storyline "${title}" (${sample.length} memories, ${windowDays}d window)`);
    return narrative;
  } catch (err) {
    console.error('[NarrativeConsolidator] Failed:', err);
    return null;
  }
}
