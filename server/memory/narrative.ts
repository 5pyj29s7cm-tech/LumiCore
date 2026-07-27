import { makeLLMCall, NormalizedMessage } from '../llm/providers';
import { queryMemories, addMemory, getAssociatedMemories } from './store';
import { Memory } from './types';
import { getScopedPreferredLLM } from '../llm/user_preferences';

export interface NarrativeChainResult {
  narrative: string;
  sourceMemoryIds: string[];
  memoryChain: Memory[];
  storedAsMemoryId?: string;
}

const NARRATIVE_PROMPT = `你是一个叙事编织者。请根据以下按时序排列的记忆片段，编织成一段连贯的第一人称中文叙事。

主题：{topic}

记忆片段（按时间顺序）：
{memories}

请以 Lumi 的身份（第一人称"我"）写一段叙事，语气应当温暖、有连接感，展现记忆之间的因果和发展关系。模式参考：
"记得上次我们...后来你...现在终于..."

输出仅包含 JSON 对象，不要有其他内容：
{
  "narrative": "你编织的第一人称中文叙事，3-6句话，语气温暖自然",
  "sourceMemoryIds": ["mem_xxx", "mem_yyy"]
}`;

/**
 * Build a narrative chain from related memories.
 * Uses seed retrieval + Hebbian association traversal to find connected memories,
 * then asks the LLM to weave them into a chronological first-person Chinese narrative.
 */
export async function buildNarrativeChain(params: {
  userId: string;
  topic: string;
  limit?: number;
  domain?: string;
  orgId?: string;
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
}): Promise<NarrativeChainResult> {
  const { userId, topic, limit = 10 } = params;
  const domain = params.domain === 'work' ? 'work' : 'personal';
  const orgId = domain === 'work' ? (params.orgId || '') : '';

  // 1. Seed retrieval — find memories matching the topic
  const seedMemories = queryMemories({
    userId,
    query: topic,
    limit,
    minConfidence: 0.3,
    domain,
    orgId,
  });

  if (seedMemories.length === 0) {
    return { narrative: '', sourceMemoryIds: [], memoryChain: [] };
  }

  // 2. Hebbian traversal — collect associated memories
  const allIds = new Set<string>(seedMemories.map(m => m.id));
  const allMemories: Memory[] = [...seedMemories];

  for (const seed of seedMemories) {
    const associated = getAssociatedMemories(seed.id, userId, 0.2, domain, orgId);
    for (const am of associated) {
      if (!allIds.has(am.id)) {
        allIds.add(am.id);
        allMemories.push(am);
      }
    }
  }

  // 3. Sort chronologically
  allMemories.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Cap at a reasonable number for the LLM
  const chain = allMemories.slice(0, Math.min(20, allMemories.length));

  // 4. Format memory list for LLM
  const memoryList = chain
    .map((m, i) => `[${i + 1}] ${m.createdAt.slice(0, 10)} | [${m.type}] ${m.content}`)
    .join('\n');

  const prompt = NARRATIVE_PROMPT
    .replace('{topic}', topic)
    .replace('{memories}', memoryList);

  const messages: NormalizedMessage[] = [
    { role: 'user', content: prompt },
  ];

  // 5. Call LLM
  try {
    const preferred = getScopedPreferredLLM(userId, { domain, orgId });
    const response = await makeLLMCall(
      messages,
      [],
      { provider: preferred.provider, model: preferred.model, maxTokens: 512, userId, domain, orgId },
      params.getDeepSeek,
      params.getGemini,
      params.getOpenAI,
      params.getAnthropic,
      params.getQwen,
      params.getOllama,
      params.getLmStudio,
      params.getArk,
      params.getXiaomi,
      params.getKimi,
      params.getGlm,
      params.getRelay,
    );

    const text = response.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { narrative: '', sourceMemoryIds: [], memoryChain: chain };
    }

    const parsed: { narrative: string; sourceMemoryIds: string[] } = JSON.parse(jsonMatch[0]);

    if (!parsed.narrative || typeof parsed.narrative !== 'string') {
      return { narrative: '', sourceMemoryIds: [], memoryChain: chain };
    }

    const sourceIds: string[] = Array.isArray(parsed.sourceMemoryIds)
      ? parsed.sourceMemoryIds
      : chain.map(m => m.id);

    // 6. Store narrative as a growth memory
    const stored = addMemory(
      {
        userId,
        type: 'knowledge',
        content: `[Narrative re: ${topic}] ${parsed.narrative.trim().slice(0, 500)}`,
        keywords: [topic.toLowerCase(), 'narrative', 'growth', 'story'],
        confidence: 0.85,
        sourceInteractionId: '',
      },
      {
        tier: 'growth',
        perspective: 'lumi_self',
        importance: 0.6,
        domain,
        orgId,
        source: 'consolidation',
        privacyClass: domain === 'work' ? 'organization' : 'private',
      },
    );

    return {
      narrative: parsed.narrative.trim(),
      sourceMemoryIds: sourceIds,
      memoryChain: chain,
      storedAsMemoryId: stored.id,
    };
  } catch (err: any) {
    console.error('[Memory] Narrative chain generation failed:', err.message);
    return {
      narrative: '',
      sourceMemoryIds: [],
      memoryChain: chain,
    };
  }
}
